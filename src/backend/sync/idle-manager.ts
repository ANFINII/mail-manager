import type { IdleStatus, Settings } from '@shared/types'
import type { AccountRepository } from '../db/account-repository'
import type { Logger } from '../logging/logger'
import type { EmailProvider } from '../mail/email-provider'
import type { MailSession } from '../mail/mail-session'
import { buildSessionParams, type SessionAuthDeps } from '../mail/session-auth'
import { AbortError } from '../queue/task-queue'

export interface IdleManagerDeps {
  repo: AccountRepository;
  provider: EmailProvider;
  auth: SessionAuthDeps;
  logger: Logger;
  settings: () => Settings;
  /** 自動同期が ON のときだけ IDLE 接続を張る */
  isEnabled: () => boolean;
  /** 新着を検知したアカウントを受信同期する */
  onNewMail: (accountId: string) => void;
  /** IDLE を張り直す間隔（ms）。RFC 2177 の推奨（29 分未満）と OAuth トークンの期限に合わせる */
  renewMs?: number;
  /** 接続失敗時の再接続待ち（ms）。失敗が続くたびに倍にし、maxBackoffMs で頭打ち */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

interface Watcher {
  accountId: string;
  email: string;
  controller: AbortController;
  connected: boolean;
  unsupported: boolean;
  lastError: string | null;
  done: Promise<void>;
}

const DEFAULT_RENEW_MS = 25 * 60_000

/**
 * IMAP IDLE によるプッシュ受信。
 * 対象（設定 idleGroupId: 空 = 無効 / '*' = 認証済みすべて / グループ ID）のアカウントごとに
 * INBOX を IDLE で監視し、新着が来たらそのアカウントだけを即時に同期する。
 * 300 アカウントすべてに常時接続を張るとサーバーの同時接続上限に当たるため、idleMaxConnections で上限を設ける。
 * 対象外のアカウントは従来どおり定期同期（ポーリング）で受信する。
 */
export class IdleManager {
  private readonly watchers = new Map<string, Watcher>()
  private readonly log: Logger
  private refreshing: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: IdleManagerDeps) {
    this.log = deps.logger.child('idle')
  }

  /** 設定・アカウント・自動同期の状態に合わせて監視対象を張り直す */
  refresh(): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.doRefresh()).catch((err) => {
      this.log.warn('IDLE refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return this.refreshing
  }

  status(): IdleStatus {
    const ws = [...this.watchers.values()]
    return {
      target: this.deps.settings().idleGroupId,
      watching: ws.length,
      connected: ws.filter((w) => w.connected).length,
      unsupported: ws.filter((w) => w.unsupported).length,
      errors: ws.filter((w) => !w.connected && w.lastError).length,
    }
  }

  isWatching(accountId: string): boolean {
    return this.watchers.get(accountId)?.connected ?? false
  }

  async stop(): Promise<void> {
    this.disposed = true
    await this.stopWatchers([...this.watchers.keys()])
  }

  private async targetAccounts(): Promise<Array<{ id: string; email: string }>> {
    const s = this.deps.settings()
    if (this.disposed || !this.deps.isEnabled() || !s.idleGroupId) return []
    const rows =
      s.idleGroupId === '*'
        ? await this.deps.repo.list({})
        : await this.deps.repo.list({ groupId: s.idleGroupId })
    return rows
      .filter((a) => a.enabled === 1 && a.auth_status === 'ok')
      .slice(0, Math.max(0, s.idleMaxConnections))
      .map((a) => ({ id: a.id, email: a.email }))
  }

  private async doRefresh(): Promise<void> {
    const targets = await this.targetAccounts()
    const wanted = new Set(targets.map((t) => t.id))
    const stale = [...this.watchers.keys()].filter((id) => !wanted.has(id))
    await this.stopWatchers(stale)
    let started = 0
    for (const t of targets) {
      if (this.watchers.has(t.id)) continue
      this.start(t.id, t.email)
      started++
    }
    if (started > 0 || stale.length > 0)
      this.log.info('IDLE watchers updated', {
        watching: this.watchers.size,
        started,
        stopped: stale.length,
      })
  }

  private async stopWatchers(ids: string[]): Promise<void> {
    const ws = ids.map((id) => this.watchers.get(id)).filter((w): w is Watcher => !!w)
    for (const w of ws) w.controller.abort()
    await Promise.all(ws.map((w) => w.done))
    for (const w of ws) this.watchers.delete(w.accountId)
  }

  private start(accountId: string, email: string): void {
    const controller = new AbortController()
    const watcher: Watcher = {
      accountId,
      email,
      controller,
      connected: false,
      unsupported: false,
      lastError: null,
      done: Promise.resolve(),
    }
    watcher.done = this.loop(watcher).catch(() => undefined)
    this.watchers.set(accountId, watcher)
  }

  private async loop(w: Watcher): Promise<void> {
    const signal = w.controller.signal
    const minBackoff = this.deps.minBackoffMs ?? 5_000
    const maxBackoff = this.deps.maxBackoffMs ?? 5 * 60_000
    let backoff = minBackoff
    let lastExists: number | null = null
    while (!signal.aborted) {
      let session: MailSession | null = null
      try {
        const account = await this.deps.repo.getById(w.accountId)
        if (!account) return
        const params = await buildSessionParams(account, this.deps.auth, signal)
        session = await this.deps.provider.openSession(params, signal)
        const opened = await session.openMailbox('INBOX', true)
        w.connected = true
        w.lastError = null
        // 張り直しの合間に届いたメールも取りこぼさない
        if (lastExists !== null && opened.exists > lastExists) this.deps.onNewMail(w.accountId)
        lastExists = opened.exists
        const result = await session.waitForNewMail(
          this.deps.renewMs ?? DEFAULT_RENEW_MS,
          signal,
        )
        if (result === 'unsupported') {
          // IDLE 非対応サーバーは定期同期に任せる（監視は続けず、状態だけ残す）
          w.unsupported = true
          w.connected = false
          this.log.info(`Account ${w.email} does not support IDLE; using polling`, {
            accountId: w.accountId,
          })
          return
        }
        if (result === 'new') {
          lastExists = null // 次の接続では件数を取り直す（同期で既読化・削除されることがある）
          this.log.debug(`Account ${w.email} new mail via IDLE`, { accountId: w.accountId })
          this.deps.onNewMail(w.accountId)
        }
        backoff = minBackoff
      } catch (err) {
        if (signal.aborted || err instanceof AbortError) return
        w.connected = false
        w.lastError = this.deps.logger.scrubber.scrub(
          err instanceof Error ? err.message : String(err),
        )
        this.log.warn(`Account ${w.email} IDLE connection failed, reconnecting`, {
          accountId: w.accountId,
          delayMs: backoff,
          error: w.lastError,
        })
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, maxBackoff)
      } finally {
        if (session) await session.close().catch(() => undefined)
      }
    }
    w.connected = false
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
