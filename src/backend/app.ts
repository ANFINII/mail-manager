import fs from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import type { RpcMethod, RpcMethods } from '@shared/api'
import type { AppInfo, AutoSyncState, ImportRowEdit, JobInfo, Settings } from '@shared/types'
import { AccountGroupService } from './accounts/account-group-service'
import { AccountService } from './accounts/account-service'
import { ImportService } from './accounts/import-service'
import { AuditLog } from './audit/audit-log'
import { AuthTestService } from './auth/auth-test-service'
import { CodeService } from './codes/code-service'
import { SettingsService } from './config/settings-service'
import { AccountGroupRepository } from './db/account-group-repository'
import { AccountRepository } from './db/account-repository'
import { createDatabase, dbConfigFromEnv, type Db, type DbConfig } from './db/database'
import { ForwardRuleRepository } from './db/forward-rule-repository'
import { ForwardTargetRepository } from './db/forward-target-repository'
import { HistoryRepository } from './db/history-repository'
import { MailboxRepository } from './db/mailbox-repository'
import { MessageRepository } from './db/message-repository'
import { SettingsRepository } from './db/settings-repository'
import { TemplateRepository } from './db/template-repository'
import { Batcher, EventBus, type EventListener } from './events/event-bus'
import { WebhookNotifier } from './events/webhook'
import { ExportService } from './export/export-service'
import { createLogger, Logger, type LogLevel, type LogSink } from './logging/logger'
import { RoutingProvider } from './mail/api/routing-provider'
import { UidMapStore } from './mail/api/uid-map'
import type { EmailProvider } from './mail/email-provider'
import { GraphSender } from './mail/graph-sender'
import { ImapFlowProvider } from './mail/imapflow-provider'
import type { SessionAuthDeps } from './mail/session-auth'
import { SmtpSender } from './mail/smtp-sender'
import { MessageService } from './messages/message-service'
import { MetricsService } from './metrics/metrics-service'
import { OAuthLoginService } from './oauth/oauth-login'
import { OAuthService } from './oauth/oauth-service'
import { ProviderRegistry } from './providers/presets'
import { ReportService } from './report/report-service'
import { RuleEngine } from './rules/rule-engine'
import { SearchService } from './search/search-service'
import { CredentialCipher } from './security/credential-cipher'
import { HealthService } from './stats/health-service'
import { StatsService } from './stats/stats-service'
import { StorageService } from './storage/storage-service'
import { IdleManager } from './sync/idle-manager'
import { toMailboxSummary } from './sync/mailbox-summary'
import { AutoSyncScheduler } from './sync/scheduler'
import { SyncService } from './sync/sync-service'

export interface BackendAppOptions {
  userDataPath: string;
  masterKey: Buffer;
  env?: NodeJS.ProcessEnv;
  dbConfig?: DbConfig;
  logger?: Logger;
  logSinks?: LogSink[];
  logLevel?: LogLevel;
  logToConsole?: boolean;
  provider?: EmailProvider;
  fetchImpl?: typeof fetch;
  keyMode?: AppInfo['keyMode'];
  version?: string;
}

type Handlers = {
  [M in RpcMethod]: (params: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']>;
};

export class BackendApp {
  private constructor(
    private readonly db: Db,
    private readonly dbConfig: DbConfig,
    readonly logger: Logger,
    readonly events: EventBus,
    readonly settings: SettingsService,
    readonly accounts: AccountService,
    readonly importer: ImportService,
    readonly authTest: AuthTestService,
    readonly sync: SyncService,
    readonly messages: MessageService,
    readonly search: SearchService,
    readonly exporter: ExportService,
    readonly stats: StatsService,
    readonly mailboxRepo: MailboxRepository,
    readonly messageRepo: MessageRepository,
    readonly forwardTargetRepo: ForwardTargetRepository,
    readonly groups: AccountGroupService,
    readonly forwardRuleRepo: ForwardRuleRepository,
    readonly health: HealthService,
    readonly idle: IdleManager,
    readonly rules: RuleEngine,
    readonly storage: StorageService,
    readonly oauthLogin: OAuthLoginService,
    readonly codes: CodeService,
    readonly templates: TemplateRepository,
    readonly report: ReportService,
    readonly metrics: MetricsService,
    readonly audit: AuditLog,
    private readonly idleSyncBatch: Batcher<string>,
    private readonly scheduler: AutoSyncScheduler,
    private readonly appInfo: AppInfo,
  ) {}

  static async create(opts: BackendAppOptions): Promise<BackendApp> {
    const env = opts.env ?? {}
    const logPath = path.join(opts.userDataPath, 'logs', 'app.log')
    const logger =
      opts.logger ??
      createLogger({
        level: opts.logLevel ?? ((env.MM_LOG_LEVEL as LogLevel) || 'info'),
        filePath: logPath,
        console: opts.logToConsole ?? true,
        sinks: opts.logSinks,
      })
    const dbConfig =
      opts.dbConfig ?? dbConfigFromEnv(env, path.join(opts.userDataPath, 'mail-manager.sqlite'))
    if (dbConfig.driver === 'sqlite') applyPendingRestore(dbConfig.file, logger)
    const db = await createDatabase(dbConfig)
    logger.info('Database ready', {
      driver: dbConfig.driver,
      file: dbConfig.driver === 'sqlite' ? dbConfig.file : '(postgres)',
    })

    const events = new EventBus()
    const cipher = new CredentialCipher(opts.masterKey)
    const registry = new ProviderRegistry(env)
    const accountRepo = new AccountRepository(db)
    const mailboxRepo = new MailboxRepository(db)
    const forwardTargetRepo = new ForwardTargetRepository(db)
    const groupRepo = new AccountGroupRepository(db)
    const forwardRuleRepo = new ForwardRuleRepository(db)
    const messageRepo = new MessageRepository(db, dbConfig.driver)
    const settingsRepo = new SettingsRepository(db)
    const settings = new SettingsService(settingsRepo, env)
    await settings.load()
    const attachmentsDir = path.join(opts.userDataPath, 'attachments')
    const now = () => new Date().toISOString()

    const oauth = new OAuthService({
      registry,
      logger,
      timeoutMs: () => settings.get().connectTimeoutMs,
      fetchImpl: opts.fetchImpl,
    })
    const accounts = new AccountService({ repo: accountRepo, cipher, events, logger, registry, oauth })
    const importer = new ImportService({
      repo: accountRepo,
      groups: groupRepo,
      oauth,
      cipher,
      registry,
      logger,
      events,
    })
    const groups = new AccountGroupService({ groups: groupRepo, accounts: accountRepo, events, logger })
    // すべての IMAP 接続（同期・IDLE・一括操作・認証テスト）を計測する
    const metrics = new MetricsService()
    const provider = metrics.wrap(
      // 取得方法が Graph / Gmail API のアカウントは HTTP API、それ以外は IMAP で接続する
      new RoutingProvider(
        opts.provider ?? new ImapFlowProvider(),
        new UidMapStore(db),
        {
          graph: env.MM_GRAPH_API_URL || 'https://graph.microsoft.com/v1.0',
          gmail: env.MM_GMAIL_API_URL || 'https://gmail.googleapis.com/gmail/v1',
        },
        opts.fetchImpl,
      ),
    )
    const auth: SessionAuthDeps = {
      repo: accountRepo,
      cipher,
      oauth,
      logger,
      connectTimeoutMs: () => settings.get().connectTimeoutMs,
      tlsRejectUnauthorized: () => settings.get().tlsRejectUnauthorized,
      now,
    }
    const webhook = new WebhookNotifier(() => settings.get().webhookUrl, logger, opts.fetchImpl)
    const authTest = new AuthTestService({
      repo: accountRepo,
      cipher,
      provider,
      oauth,
      events,
      logger,
      config: {
        concurrency: () => settings.get().authConcurrency,
        maxRetries: () => settings.get().maxRetries,
        connectTimeoutMs: () => settings.get().connectTimeoutMs,
        tlsRejectUnauthorized: () => settings.get().tlsRejectUnauthorized,
        retryDelaysMs: () => settings.retryDelaysMs,
      },
    })
    const sync = new SyncService({
      metrics,
      repo: accountRepo,
      mailboxRepo,
      messageRepo,
      provider,
      auth,
      events,
      webhook,
      logger,
      settings: () => settings.get(),
      retryDelaysMs: () => settings.retryDelaysMs,
      attachmentsDir,
    })
    const smtp = new SmtpSender({
      cipher,
      oauth,
      registry,
      logger,
      connectTimeoutMs: () => settings.get().connectTimeoutMs,
      tlsRejectUnauthorized: () => settings.get().tlsRejectUnauthorized,
    })
    const graph = new GraphSender({
      cipher,
      oauth,
      registry,
      logger,
      timeoutMs: () => settings.get().connectTimeoutMs,
      fetchImpl: opts.fetchImpl,
    })
    // 送信（SMTP / Graph）の成否とスロットリングを計測する
    const smtpSend = smtp.send.bind(smtp)
    smtp.send = async (account, message, signal) => {
      const host = account.smtp_host || registry.get(account.provider as never).smtpHost || 'smtp'
      try {
        const r = await smtpSend(account, message, signal)
        metrics.sendResult(host, account.email, null)
        return r
      } catch (err) {
        metrics.sendResult(host, account.email, err)
        throw err
      }
    }
    const graphSend = graph.send.bind(graph)
    graph.send = async (account, message, signal) => {
      try {
        const r = await graphSend(account, message, signal)
        metrics.sendResult('graph.microsoft.com', account.email, null)
        return r
      } catch (err) {
        metrics.sendResult('graph.microsoft.com', account.email, err)
        throw err
      }
    }
    let syncRef: SyncService | null = null
    const messages = new MessageService({
      accountRepo,
      mailboxRepo,
      messageRepo,
      provider,
      auth,
      events,
      logger,
      attachmentsDir,
      smtp,
      graph,
      ruleRepo: forwardRuleRepo,
      history: new HistoryRepository(db),
      onSent: (accountId) => {
        // 送信控えを取り込むため、そのアカウントを同期する
        void syncRef?.syncAccounts([accountId])
      },
    })
    syncRef = sync
    // 削除・フラグ変更も同期と同じ同時接続数で走らせる（既定 5 → 設定値 20）
    messages.setConcurrency(settings.get().syncConcurrency)
    const rules = new RuleEngine({
      rules: forwardRuleRepo,
      messages,
      messageRepo,
      accounts: accountRepo,
      webhook,
      logger,
    })
    const storage = new StorageService({
      db,
      driver: dbConfig.driver,
      dbFile: dbConfig.driver === 'sqlite' ? dbConfig.file : null,
      attachmentsDir,
      settings: () => settings.get(),
      events,
      logger,
    })
    // テストでは自動整理を走らせない（MM_STORAGE_SCHEDULE=0）
    if (env.MM_STORAGE_SCHEDULE !== '0') storage.startSchedule()
    const oauthLogin = new OAuthLoginService({
      registry,
      logger,
      timeoutMs: () => settings.get().connectTimeoutMs,
      fetchImpl: opts.fetchImpl,
      onAuthorized: async (r, req) => {
        const emailToId = await accountRepo.emailIdMap()
        let id = req.accountId ?? emailToId.get(r.email) ?? null
        if (req.accountId) {
          const row = await accountRepo.getById(req.accountId)
          if (!row) throw new Error('アカウントが見つかりません')
          if (row.email.toLowerCase() !== r.email)
            throw new Error(`このアカウント（${row.email}）とサインインしたアカウント（${r.email}）が違います`)
        }
        if (id) {
          await accounts.updateCredentials(id, {
            authType: 'oauth2',
            clientId: r.clientId,
            clientSecret: r.clientSecret,
            refreshToken: r.refreshToken,
          })
        } else {
          const res = await importer.importRows(
            [
              {
                email: r.email,
                provider: r.provider,
                auth_type: 'oauth2',
                client_id: r.clientId,
                client_secret: r.clientSecret ?? '',
                refresh_token: r.refreshToken,
              },
            ],
            { groupId: req.groupId ?? null, source: 'oauth-login' },
          )
          importer.discard(res.sessionId)
          if (res.imported !== 1)
            throw new Error(res.invalid[0]?.errors.join(', ') || '登録できませんでした')
          id = (await accountRepo.emailIdMap()).get(r.email) ?? null
          if (!id) throw new Error('登録したアカウントが見つかりません')
        }
        if (req.graph && r.provider === 'outlook') await accounts.setFetchVia([id], 'graph')
        void authTest.testAccounts([id])
        return id
      },
    })
    const codes = new CodeService(db, logger)
    // 抽出前の既存メール（このバージョンより前に取り込んだもの）を起動後に少しずつ処理する
    if (env.MM_CODE_BACKFILL !== '0') {
      const t = setTimeout(() => void codes.backfill().catch(() => undefined), 3000)
      t.unref?.()
    }
    const search = new SearchService(messageRepo)
    const exporter = new ExportService(accountRepo, search, groupRepo, cipher, logger)
    const health = new HealthService(accountRepo, messageRepo, () => settings.get().healthStaleHours)
    const stats = new StatsService(
      accountRepo,
      messageRepo,
      () => authTest.activeJobs() + sync.tracker.activeCount() + messages.tracker.activeCount(),
      health,
    )
    const report = new ReportService({
      db,
      settings: () => settings.get(),
      settingsRepo,
      stats,
      health,
      webhook,
      sendMail: (accountId, to, subject, text) => messages.send(accountId, to, subject, text),
      logger,
    })
    if (env.MM_REPORT_SCHEDULE !== '0') report.start()
    const scheduler = new AutoSyncScheduler(
      async () => {
        await sync.syncAccounts('authenticated')
      },
      () => sync.isRunning(),
      logger.child('scheduler'),
    )
    // 秒設定(autoSyncIntervalSec)が指定されていればそれを、なければ分設定を秒換算して使う
    const effectiveIntervalSec = (s: Settings): number =>
      s.autoSyncIntervalSec > 0 ? s.autoSyncIntervalSec : s.autoSyncIntervalMin * 60
    scheduler.configure(effectiveIntervalSec(settings.get()))
    // IDLE で新着を検知したアカウントは、少しまとめてから（同時に届いた複数アカウント分を 1 ジョブに）同期する
    const idleSyncBatch = new Batcher<string>(async (ids) => {
      await sync.syncAccounts(ids)
    }, 500)
    const idle = new IdleManager({
      repo: accountRepo,
      provider,
      auth,
      logger,
      settings: () => settings.get(),
      isEnabled: () => scheduler.isEnabled,
      onNewMail: (accountId) => idleSyncBatch.push(accountId),
      renewMs: Number(env.MM_IDLE_RENEW_MS) || undefined,
      minBackoffMs: Number(env.MM_IDLE_BACKOFF_MS) || undefined,
    })
    settings.onChange((s: Settings) => {
      authTest.setConcurrency(s.authConcurrency)
      sync.setConcurrency(s.syncConcurrency)
      messages.setConcurrency(s.syncConcurrency)
      scheduler.configure(effectiveIntervalSec(s))
      void idle.refresh()
    })

    const info: AppInfo = {
      version: opts.version ?? '0.2.0',
      dbPath: dbConfig.driver === 'sqlite' ? dbConfig.file : 'postgres',
      logPath,
      keyMode: opts.keyMode ?? 'unknown',
      envOverrides: [
        ...settings.envOverrides,
        ...[
          'MM_OAUTH_TOKEN_URL_OUTLOOK',
          'MM_OAUTH_TOKEN_URL_GMAIL',
          'MM_DB_FILE',
          'DATABASE_URL',
        ].filter((k) => env[k]),
      ],
    }
    const app = new BackendApp(
      db,
      dbConfig,
      logger,
      events,
      settings,
      accounts,
      importer,
      authTest,
      sync,
      messages,
      search,
      exporter,
      stats,
      mailboxRepo,
      messageRepo,
      forwardTargetRepo,
      groups,
      forwardRuleRepo,
      health,
      idle,
      rules,
      storage,
      oauthLogin,
      codes,
      new TemplateRepository(db),
      report,
      metrics,
      new AuditLog(db, env.MM_AUDIT_ACTOR || undefined),
      idleSyncBatch,
      scheduler,
      info,
    )

    // 認証状態・グループ・アカウントの増減で IDLE の対象が変わる（頻繁に来るのでまとめる）
    let idleRefreshTimer: NodeJS.Timeout | null = null
    const scheduleIdleRefresh = () => {
      if (idleRefreshTimer) return
      idleRefreshTimer = setTimeout(() => {
        idleRefreshTimer = null
        void idle.refresh()
      }, 2000)
      idleRefreshTimer.unref?.()
    }
    events.on((ev) => {
      if (
        settings.get().idleGroupId &&
        (ev.type === 'accounts.removed' ||
          ev.type === 'accounts.imported' ||
          ev.type === 'groups.changed' ||
          (ev.type === 'job.updated' && ev.job.type === 'auth_test' && ev.job.status !== 'running'))
      )
        scheduleIdleRefresh()
      if (
        ev.type === 'accounts.updated' ||
        ev.type === 'accounts.removed' ||
        ev.type === 'accounts.imported' ||
        ev.type === 'job.updated' ||
        ev.type === 'messages.new' ||
        ev.type === 'messages.changed'
      ) {
        void app.pushStats()
      }
      // 同期ジョブ完了時に自動転送ルールを適用する
      if (ev.type === 'job.updated' && ev.job.type === 'sync' && ev.job.status === 'completed') {
        void app.rules.apply().catch(() => undefined)
      }
      // 認証テスト完了時、自動同期が ON かつ設定が有効なら認証済みアカウントを自動で受信同期する
      if (
        ev.type === 'job.updated' &&
        ev.job.type === 'auth_test' &&
        ev.job.status === 'completed' &&
        scheduler.isEnabled &&
        settings.get().autoSyncOnAuth &&
        !sync.isRunning()
      ) {
        void sync.syncAccounts('authenticated').catch(() => undefined)
      }
    })
    // 起動時は自動受信しない。自動同期はユーザーが「自動同期」ボタンで ON にしたときに始まる
    //（ON にした時点で認証済みアカウントを一度受信し、以後は設定間隔と認証完了時に受信する）。
    void app.audit.prune().catch(() => undefined)
    logger.info('Backend ready', { envOverrides: info.envOverrides, keyMode: info.keyMode })
    return app
  }

  private statsPending = false
  private async pushStats(): Promise<void> {
    if (this.statsPending) return
    this.statsPending = true
    setTimeout(async () => {
      this.statsPending = false
      try {
        this.events.emit({ type: 'stats.updated', stats: await this.stats.get() })
      } catch (err) {
        this.logger.warn('Failed to compute stats', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }, 150)
  }

  onEvent(listener: EventListener): () => void {
    return this.events.on(listener)
  }

  info(): AppInfo {
    return { ...this.appInfo }
  }

  autoSyncState(): AutoSyncState {
    return { enabled: this.scheduler.isEnabled, intervalSec: this.scheduler.interval }
  }

  /**
   * 自動同期の ON/OFF（起動時は OFF、再起動でリセット）。
   * ON にした時点で認証済みアカウントを一度受信し、以後は設定間隔（autoSyncIntervalSec/Min）と
   * 認証完了時（autoSyncOnAuth）に自動で受信する。OFF にすると定期受信・認証完了時の受信とも止まる。
   */
  async setAutoSync(enabled: boolean): Promise<AutoSyncState> {
    if (enabled !== this.scheduler.isEnabled) {
      this.scheduler.setEnabled(enabled)
      this.logger.info(enabled ? 'Auto sync turned on' : 'Auto sync turned off', {
        intervalSec: this.scheduler.interval,
      })
      this.events.emit({ type: 'autoSync.changed', state: this.autoSyncState() })
      // OFF のときは IDLE 接続を閉じ終えてから返す（ON の接続開始は待たない）
      if (enabled) void this.idle.refresh()
      else await this.idle.refresh()
      if (enabled && !this.sync.isRunning())
        void this.sync.syncAccounts('authenticated').catch(() => undefined)
    }
    return this.autoSyncState()
  }

  listJobs(): JobInfo[] {
    return [...this.authTest.listJobs(), ...this.sync.listJobs(), ...this.messages.listJobs()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 30)
  }

  cancelAll(): number {
    return this.authTest.cancelAll() + this.sync.cancelAll() + this.messages.cancelAll()
  }

  async backup(target: string): Promise<{ path: string; bytes: number }> {
    if (this.dbConfig.driver !== 'sqlite') throw new Error('Backup is only supported for SQLite')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.unlinkSync(target)
    await sql`VACUUM INTO ${sql.lit(target)}`.execute(this.db)
    const bytes = fs.statSync(target).size
    this.logger.info('Backup created', { target, bytes })
    return { path: target, bytes }
  }

  async restore(source: string): Promise<{ pendingRestart: boolean }> {
    if (this.dbConfig.driver !== 'sqlite') throw new Error('Restore is only supported for SQLite')
    const head = Buffer.alloc(16)
    const fd = fs.openSync(source, 'r')
    try {
      fs.readSync(fd, head, 0, 16, 0)
    } finally {
      fs.closeSync(fd)
    }
    if (!head.toString('utf8').startsWith('SQLite format 3'))
      throw new Error('Not a SQLite database file')
    fs.copyFileSync(source, `${this.dbConfig.file}.restore-pending`)
    this.logger.info('Restore scheduled for next start', { source })
    return { pendingRestart: true }
  }

  private readonly handlers: Handlers = {
    'accounts.list': (p) => this.accounts.list(p ?? {}),
    'accounts.get': (p) => this.accounts.get(p.id),
    'accounts.delete': async (p) => ({ deleted: await this.accounts.delete(p.ids) }),
    'accounts.setEnabled': async (p) => ({
      updated: await this.accounts.setEnabled(p.ids, p.enabled),
    }),
    'accounts.importCsv': (p) =>
      this.importer.importCsvFile(p.path, {
        groupId: p.groupId,
        updateExisting: p.updateExisting,
      }),
    'accounts.updateCredentials': async (p) => {
      const detail = await this.accounts.updateCredentials(p.id, p.update)
      if (p.update.testAfterSave !== false) void this.authTest.testAccounts([p.id])
      return detail
    },
    'accounts.setGroup': async (p) => ({ updated: await this.groups.assign(p.ids, p.groupId) }),
    'accounts.updateTags': async (p) => ({ updated: await this.accounts.updateTags(p.ids, p.add, p.remove) }),
    'accounts.setFetchVia': (p) => this.accounts.setFetchVia(p.ids, p.via),
    'accounts.setNote': (p) => this.accounts.setNote(p.id, p.note),
    'accounts.tags': () => this.accounts.tagCounts(),
    'groups.list': async () => this.groups.list(),
    'groups.create': (p) => this.groups.create(p.name),
    'groups.rename': (p) => this.groups.rename(p.id, p.name),
    'groups.remove': (p) => this.groups.remove(p.id),
    'accounts.retryImport': (p) => this.importer.retryRows(p.sessionId, p.edits as ImportRowEdit[]),
    'accounts.discardImport': async (p) => this.importer.discard(p.sessionId),
    'accounts.exportCsv': async (p) => ({
      count: await this.exporter.accountsCsv(p.path, p.accountIds),
    }),
    'accounts.exportCsvWithCredentials': async (p) => ({
      count: await this.exporter.accountsCsvWithCredentials(p.path, p.accountIds),
    }),
    'auth.test': (p) => this.authTest.testAccounts(p.ids),
    'sync.run': (p) => this.sync.syncAccounts(p.ids, { full: p.full }),
    'autoSync.get': async () => this.autoSyncState(),
    'autoSync.set': (p) => this.setAutoSync(p.enabled),
    'idle.status': async () => this.idle.status(),
    'mailboxes.list': async (p) => {
      const rows = await this.mailboxRepo.listByAccount(p.accountId)
      const counts = await this.mailboxRepo.storedCounts(p.accountId)
      return rows.map((r) => toMailboxSummary(r, counts[r.id] ?? 0))
    },
    'mailboxes.paths': async () => this.mailboxRepo.distinctPaths(),
    'search.query': (p) => this.search.query(p),
    'search.accountGroups': (p) => this.search.accountGroups(p),
    'search.exportCsv': async (p) => ({ count: await this.exporter.searchCsv(p.query, p.path) }),
    'messages.get': (p) => this.messages.get(p.id),
    'messages.setFlags': (p) => this.messages.setFlags(p.ids, { seen: p.seen, flagged: p.flagged }),
    'messages.delete': (p) => this.messages.delete(p.ids),
    'sent.duplicateCopies': (p) => this.messages.duplicateSentCopies(p.accountIds),
    'sent.deleteDuplicateCopies': (p) => this.messages.deleteDuplicateSentCopies(p.accountIds),
    'messages.send': (p) => this.messages.send(p.accountId, p.to, p.subject, p.text),
    'messages.reply': (p) => this.messages.reply(p),
    'history.list': async (p) => {
      const rows = await new HistoryRepository(this.db).list(p?.limit ?? 100)
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as 'flags' | 'move' | 'delete',
        source: r.source as 'manual' | 'rule',
        ruleId: r.rule_id,
        label: r.label,
        createdAt: r.created_at,
        undoneAt: r.undone_at,
        items: r.items,
        undoable: r.undoable,
      }))
    },
    'history.undo': (p) => this.messages.undo(p.id),
    'report.preview': async () => {
      const r = await this.report.build()
      return { report: r, ...this.report.format(r) }
    },
    'report.send': () => this.report.send(),
    'audit.list': (p) => this.audit.list(p ?? {}),
    'audit.record': (p) => this.audit.record(p),
    'metrics.get': async () => this.metrics.snapshot(),
    'templates.list': () => this.templates.list(),
    'templates.save': (p) => this.templates.save(p, new Date().toISOString()),
    'templates.remove': (p) => this.templates.remove(p.id),
    'messages.forward': (p) => this.messages.forward(p.ids, p.to),
    'messages.forwardAll': (p) => this.messages.forwardAll(p.query, p.to),
    'forwards.list': async (p) => {
      const { rows, total } = await this.messageRepo.listForwardRecords(p)
      return {
        items: rows.map((r) => ({
          messageId: r.message_id,
          accountEmail: r.account_email,
          fromName: r.from_name,
          fromAddress: r.from_address,
          subject: r.subject,
          date: r.date,
          to: r.to_address,
          forwardedAt: r.forwarded_at,
        })),
        total,
        page: Math.max(1, p.page || 1),
        pageSize: Math.min(500, Math.max(1, p.pageSize || 50)),
      }
    },
    'health.list': (p) => this.health.list({ includeInfo: p?.includeInfo }),
    'forwardFailures.list': async (p) => {
      const { rows, total } = await this.messageRepo.listForwardFailures(p)
      return {
        items: rows.map((r) => ({
          messageId: r.message_id,
          accountEmail: r.account_email,
          fromName: r.from_name,
          fromAddress: r.from_address,
          subject: r.subject,
          date: r.date,
          to: r.to_address,
          attempts: Number(r.attempts),
          lastError: r.last_error,
          lastAttemptAt: r.last_attempt_at,
          nextRetryAt: r.next_retry_at,
        })),
        total,
        page: Math.max(1, p.page || 1),
        pageSize: Math.min(500, Math.max(1, p.pageSize || 50)),
      }
    },
    'forwardFailures.retry': async (p) => {
      // 宛先ごとにまとめて手動転送する（手動転送はバックオフを無視して即時に送る）
      const byTo = new Map<string, string[]>()
      for (const it of p.items) byTo.set(it.to, [...(byTo.get(it.to) ?? []), it.messageId])
      let queued = 0
      let skipped = 0
      for (const [to, ids] of byTo) {
        const r = await this.messages.forward(ids, to)
        queued += r.queued
        skipped += r.skipped
      }
      return { queued, skipped }
    },
    'forwardFailures.clear': async (p) => {
      const cleared = await this.messageRepo.clearForwardFailures(p?.items)
      void this.pushStats()
      return { cleared }
    },
    'forwardTargets.list': async () => toForwardTargets(await this.forwardTargetRepo.list()),
    'forwardTargets.add': async (p) => {
      await this.forwardTargetRepo.add(
        p.address.trim(),
        p.label?.trim() || null,
        new Date().toISOString(),
      )
      return toForwardTargets(await this.forwardTargetRepo.list())
    },
    'forwardTargets.remove': async (p) => {
      await this.forwardTargetRepo.remove(p.id)
      return toForwardTargets(await this.forwardTargetRepo.list())
    },
    'forwardRules.list': () => this.rules.list(),
    'forwardRules.add': (p) => this.rules.add(p),
    'forwardRules.preview': (p) => this.rules.preview(p),
    'forwardRules.setEnabled': async (p) => {
      await this.forwardRuleRepo.setEnabled(p.id, p.enabled)
      return this.rules.list()
    },
    'forwardRules.remove': async (p) => {
      await this.forwardRuleRepo.remove(p.id)
      return this.rules.list()
    },
    'forwardRules.apply': () => this.rules.apply(),
    'messages.move': (p) => this.messages.move(p.ids, p.destination),
    'attachments.download': (p) => this.messages.downloadAttachment(p.id),
    'jobs.list': async () => this.listJobs(),
    'jobs.cancelAll': async () => ({ cancelled: this.cancelAll() }),
    'stats.get': () => this.stats.get(),
    'settings.get': async () => this.settings.get(),
    'settings.update': (p) => this.settings.update(p),
    'app.info': async () => this.info(),
    'oauth.start': (p) => this.oauthLogin.start(p),
    'oauth.status': async (p) => this.oauthLogin.status(p.sessionId),
    'oauth.cancel': async (p) => this.oauthLogin.cancel(p.sessionId),
    'codes.list': (p) => this.codes.list(p ?? {}),
    'storage.stats': () => this.storage.stats(),
    'storage.cleanup': (p) => this.storage.cleanup({ dryRun: p?.dryRun }),
    'storage.vacuum': () => this.storage.vacuum(),
    'app.backup': (p) => this.backup(p.path),
    'app.restore': (p) => this.restore(p.path),
  }

  async call<M extends RpcMethod>(
    method: M,
    params: RpcMethods[M]['params'],
    ctx: { actor?: string } = {},
  ): Promise<RpcMethods[M]['result']> {
    const handler = this.handlers[method] as
      ((p: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']>) | undefined
    if (!handler) throw new Error(`Unknown method: ${String(method)}`)
    if (method === 'audit.record')
      return this.audit.record({ ...(params as RpcMethods['audit.record']['params']), actor: ctx.actor }) as never
    if (!this.audit.shouldRecord(method)) return handler(params)
    // 重要な操作は成功・失敗とも監査ログに残す（記録の失敗で操作自体は失敗させない）
    try {
      const result = await handler(params)
      await this.audit.recordCall(method, params, result, null, ctx.actor).catch(() => undefined)
      return result
    } catch (err) {
      await this.audit.recordCall(method, params, undefined, err, ctx.actor).catch(() => undefined)
      throw err
    }
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop()
    this.storage.stopSchedule()
    this.report.stop()
    this.oauthLogin.dispose()
    this.codes.stop()
    await this.idle.stop()
    this.idleSyncBatch.dispose()
    this.authTest.dispose()
    this.sync.dispose()
    this.messages.dispose()
    await this.db.destroy()
    this.logger.info('Backend stopped')
    this.logger.close()
  }
}

function toForwardTargets(rows: Array<{ id: string; address: string; label: string | null }>) {
  return rows.map((r) => ({ id: r.id, address: r.address, label: r.label }))
}

/** 前回「復元」を予約したファイルがあれば、DB を開く前に差し替える */
function applyPendingRestore(dbFile: string, logger: Logger): void {
  const pending = `${dbFile}.restore-pending`
  if (!fs.existsSync(pending)) return
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${dbFile}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  fs.renameSync(pending, dbFile)
  logger.warn('Database restored from backup', { dbFile })
}
