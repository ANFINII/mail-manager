import type { JobInfo, Settings } from '@shared/types'
import { syncAccount } from './mailbox-sync'
import { toSummary } from '../accounts/account-service'
import { retryDelayMs } from '../auth/retry-policy'
import type { AccountRepository } from '../db/account-repository'
import type { MailboxRepository } from '../db/mailbox-repository'
import type { MessageRepository } from '../db/message-repository'
import { Batcher, type EventBus } from '../events/event-bus'
import type { WebhookNotifier } from '../events/webhook'
import type { Logger } from '../logging/logger'
import { classifyError } from '../mail/classify-error'
import type { EmailProvider } from '../mail/email-provider'
import type { MailSession } from '../mail/mail-session'
import { buildSessionParams, type SessionAuthDeps } from '../mail/session-auth'
import { JobTracker, type Job } from '../queue/job-tracker'
import { AbortError, TaskQueue } from '../queue/task-queue'

export interface SyncServiceDeps {
  repo: AccountRepository;
  mailboxRepo: MailboxRepository;
  messageRepo: MessageRepository;
  provider: EmailProvider;
  auth: SessionAuthDeps;
  events: EventBus;
  webhook: WebhookNotifier;
  logger: Logger;
  settings: () => Settings;
  retryDelaysMs: () => number[];
  attachmentsDir: string;
  now?: () => string;
}

const MAX_ERROR_LENGTH = 500
const PROGRESS_INTERVAL_MS = 300

/**
 * メール同期のオーケストレーション。認証テストと同じく Queue + Worker（SYNC_CONCURRENCY）で動き、
 * 通信エラーはリトライ、認証エラーは即確定。アカウント単位で status / last_sync_at / message_count を更新する。
 */
export class SyncService {
  readonly queue: TaskQueue
  readonly tracker: JobTracker
  private readonly batcher: Batcher<string>
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly lastProgressAt = new Map<string, number>()
  /** 全件取得モードで動いているジョブ ID */
  private readonly fullJobs = new Set<string>()
  /** 現在同期中のアカウント ID。別ジョブでの同一アカウント多重同期（重複取得）を防ぐ */
  private readonly inFlight = new Set<string>()
  private readonly now: () => string
  private readonly log: Logger

  constructor(private readonly deps: SyncServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.log = deps.logger.child('sync')
    this.queue = new TaskQueue(deps.settings().syncConcurrency)
    this.tracker = new JobTracker((job) => deps.events.emit({ type: 'job.updated', job }))
    this.batcher = new Batcher<string>(async (ids) => {
      const rows = await deps.repo.getByIds(ids)
      deps.events.emit({ type: 'accounts.updated', accounts: rows.map(toSummary) })
    }, 100)
  }

  setConcurrency(n: number): void {
    this.queue.concurrency = n
  }

  isRunning(): boolean {
    return this.tracker.activeCount() > 0
  }

  async syncAccounts(
    target: string[] | 'all' | 'authenticated',
    opts: { full?: boolean } = {},
  ): Promise<JobInfo> {
    let ids: string[]
    if (target === 'all') ids = await this.deps.repo.listIds({ enabledOnly: true })
    else if (target === 'authenticated')
      ids = await this.deps.repo.listIds({ enabledOnly: true, authenticatedOnly: true })
    else ids = [...new Set(target)]
    const full = !!opts.full
    const job = this.tracker.create('sync', ids)
    if (full) this.fullJobs.add(job.info.id)
    this.log.info('Sync job started', {
      jobId: job.info.id,
      accounts: ids.length,
      concurrency: this.queue.concurrency,
      full,
      target: typeof target === 'string' ? target : 'selected',
    })
    for (const id of ids) this.enqueue(job, id, 0)
    return { ...job.info }
  }

  cancelAll(): number {
    const n = this.tracker.cancelAll()
    this.queue.clear()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.fullJobs.clear()
    if (n > 0) this.log.info('Sync jobs cancelled', { jobs: n })
    return n
  }

  listJobs(): JobInfo[] {
    return this.tracker.list()
  }

  async flushEvents(): Promise<void> {
    await this.batcher.run()
  }

  dispose(): void {
    this.cancelAll()
    this.batcher.dispose()
  }

  private enqueue(job: Job, accountId: string, attempt: number): void {
    this.queue
      .add(() => this.runOne(job, accountId, attempt), { signal: job.controller.signal })
      .catch((err) => {
        if (err instanceof AbortError) {
          this.tracker.complete(job, accountId, 'cancelled')
          return
        }
        this.log.error('Unexpected sync task failure', {
          accountId,
          error: err instanceof Error ? err.message : String(err),
        })
        this.tracker.complete(job, accountId, 'failed')
      })
  }

  private async runOne(job: Job, accountId: string, attempt: number): Promise<void> {
    const signal = job.controller.signal
    if (signal.aborted) {
      this.tracker.complete(job, accountId, 'cancelled')
      return
    }
    const account = await this.deps.repo.getById(accountId)
    if (!account || account.enabled !== 1) {
      this.tracker.complete(job, accountId, 'cancelled')
      return
    }
    // 別ジョブが同じアカウントを同期中なら、二重取得（FTS などの重複）を避けてスキップする。
    // has→add は同期的（await を挟まない）なので、この区間はアトミックに働く。
    if (this.inFlight.has(accountId)) {
      this.log.debug(`Account ${account.email} sync skipped: already in progress`, { accountId })
      this.tracker.complete(job, accountId, 'succeeded')
      return
    }
    this.inFlight.add(accountId)
    const previousStatus = account.status === 'syncing' ? 'connected' : account.status
    let session: MailSession | null = null
    try {
      await this.deps.repo.updateStatus(
        accountId,
        { status: 'syncing', retry_count: attempt },
        this.now(),
      )
      this.batcher.push(accountId)
      if (attempt === 0) {
        this.log.info(`Account ${account.email} sync started`, { accountId })
        this.deps.webhook.send('SYNC_STARTED', { accountId, email: account.email })
      }
      const params = await buildSessionParams(account, this.deps.auth, signal)
      session = await this.deps.provider.openSession(params, signal)
      const outcome = await syncAccount({
        account,
        session,
        mailboxRepo: this.deps.mailboxRepo,
        messageRepo: this.deps.messageRepo,
        settings: this.deps.settings(),
        attachmentsDir: this.deps.attachmentsDir,
        logger: this.log,
        signal,
        now: this.now,
        fullResync: this.fullJobs.has(job.info.id),
        onProgress: (mailboxPath, fetched, total) =>
          this.progress(accountId, account.email, mailboxPath, fetched, total),
        onMailboxes: () => this.deps.events.emit({ type: 'mailboxes.updated', accountId }),
      })
      const messageCount = await this.deps.messageRepo.countByAccount(accountId)
      await this.deps.repo.updateStatus(
        accountId,
        {
          status: 'connected',
          auth_status: 'ok',
          last_error: null,
          last_success_at: this.now(),
          last_sync_at: this.now(),
          message_count: messageCount,
          retry_count: attempt,
        },
        this.now(),
      )
      this.log.info(`Account ${account.email} sync completed`, {
        accountId,
        newMessages: outcome.newMessages,
        mailboxes: outcome.mailboxesSynced,
        total: messageCount,
      })
      this.deps.webhook.send('SYNC_COMPLETED', {
        accountId,
        email: account.email,
        newMessages: outcome.newMessages,
        total: messageCount,
      })
      if (outcome.newMessages > 0) {
        const notice = {
          accountId,
          email: account.email,
          count: outcome.newMessages,
          latestSubject: outcome.latest?.subject ?? null,
          latestFrom: outcome.latest?.from ?? null,
        }
        this.deps.events.emit({ type: 'messages.new', notice })
        this.deps.webhook.send('NEW_MESSAGE', notice)
      }
      this.tracker.complete(job, accountId, 'succeeded')
    } catch (err) {
      if (signal.aborted || err instanceof AbortError) {
        await this.deps.repo.updateStatus(accountId, { status: previousStatus }, this.now())
        this.tracker.complete(job, accountId, 'cancelled')
        return
      }
      const classified = classifyError(err)
      const message = this.deps.logger.scrubber
        .scrub(classified.message)
        .slice(0, MAX_ERROR_LENGTH)
      const maxRetries = this.deps.settings().maxRetries
      if (classified.kind === 'connection' && attempt < maxRetries) {
        const delay = retryDelayMs(this.deps.retryDelaysMs(), attempt)
        await this.deps.repo.updateStatus(
          accountId,
          {
            status: 'syncing',
            last_error: message,
            last_error_at: this.now(),
            retry_count: attempt + 1,
          },
          this.now(),
        )
        this.log.warn(`Account ${account.email} sync connection failed, retrying`, {
          accountId,
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          code: classified.code,
          error: message,
        })
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          signal.removeEventListener('abort', onAbort)
          this.enqueue(job, accountId, attempt + 1)
        }, delay)
        const onAbort = () => {
          clearTimeout(timer)
          this.timers.delete(timer)
          void this.deps.repo
            .updateStatus(accountId, { status: 'connection_error' }, this.now())
            .finally(() => this.tracker.complete(job, accountId, 'cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.timers.add(timer)
        return
      }
      // 同期(受信)時の失敗は「取得失敗」として扱う。すでに認証済みのアカウントなので、
      // 認証系エラー(スロットリング等の一過性を含む)でも auth_status は落とさない。
      // 認証情報が本当に失効しているかは明示的な認証テストで判定する。
      const status =
        classified.kind === 'connection' ? 'connection_error' : ('sync_error' as const)
      await this.deps.repo.updateStatus(
        accountId,
        {
          status,
          auth_status: account.auth_status,
          last_error: message,
          last_error_at: this.now(),
          retry_count: attempt,
        },
        this.now(),
      )
      await this.deps.repo.incrementFailures(accountId)
      this.log.error(`Account ${account.email} sync failed`, {
        accountId,
        kind: classified.kind,
        code: classified.code,
        error: message,
      })
      this.deps.webhook.send('SYNC_FAILED', {
        accountId,
        email: account.email,
        error: message,
        kind: classified.kind,
      })
      this.tracker.complete(job, accountId, 'failed')
    } finally {
      this.inFlight.delete(accountId)
      if (session) await session.close().catch(() => undefined)
      this.batcher.push(accountId)
    }
  }

  private progress(
    accountId: string,
    email: string,
    mailboxPath: string,
    fetched: number,
    total: number,
  ): void {
    const last = this.lastProgressAt.get(accountId) ?? 0
    const now = Date.now()
    if (fetched !== total && now - last < PROGRESS_INTERVAL_MS) return
    this.lastProgressAt.set(accountId, now)
    this.deps.events.emit({
      type: 'sync.progress',
      progress: { accountId, email, mailboxPath, fetched, total },
    })
  }
}
