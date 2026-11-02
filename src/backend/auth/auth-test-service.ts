import type { JobInfo } from '@shared/types'
import { retryDelayMs } from './retry-policy'
import { toSummary } from '../accounts/account-service'
import type { AccountRepository } from '../db/account-repository'
import type { AccountRow } from '../db/schema'
import { Batcher, type EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'
import { classifyError } from '../mail/classify-error'
import type { EmailProvider } from '../mail/email-provider'
import { buildSessionParams } from '../mail/session-auth'
import type { OAuthService } from '../oauth/oauth-service'
import { JobTracker, type Job } from '../queue/job-tracker'
import { AbortError, TaskQueue } from '../queue/task-queue'
import type { CredentialCipher } from '../security/credential-cipher'

export interface AuthTestConfig {
  concurrency: () => number;
  maxRetries: () => number;
  connectTimeoutMs: () => number;
  tlsRejectUnauthorized: () => boolean;
  retryDelaysMs: () => number[];
}

export interface AuthTestServiceDeps {
  repo: AccountRepository;
  cipher: CredentialCipher;
  provider: EmailProvider;
  oauth: OAuthService;
  events: EventBus;
  logger: Logger;
  config: AuthTestConfig;
  now?: () => string;
}

const MAX_ERROR_LENGTH = 500

/**
 * 認証テストのオーケストレーション。
 * - TaskQueue で同時実行数を制限（AUTH_CONCURRENCY）
 * - 通信エラーだけを Exponential Backoff でリトライ。リトライ待ちはワーカーを占有しない（再投入方式）
 * - 認証エラーは即確定
 * - 結果はアカウント単位で DB に記録し、GUI へは 100ms 単位でまとめて通知
 */
export class AuthTestService {
  readonly queue: TaskQueue
  readonly tracker: JobTracker
  private readonly batcher: Batcher<string>
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly now: () => string
  private readonly log: Logger

  constructor(private readonly deps: AuthTestServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.log = deps.logger.child('auth')
    this.queue = new TaskQueue(deps.config.concurrency())
    this.tracker = new JobTracker((job) => deps.events.emit({ type: 'job.updated', job }))
    this.batcher = new Batcher<string>(async (ids) => {
      const rows = await deps.repo.getByIds(ids)
      deps.events.emit({ type: 'accounts.updated', accounts: rows.map(toSummary) })
    }, 100)
  }

  setConcurrency(n: number): void {
    this.queue.concurrency = n
  }

  async testAccounts(target: string[] | 'all'): Promise<JobInfo> {
    const ids =
      target === 'all' ? await this.deps.repo.listIds({ enabledOnly: true }) : [...new Set(target)]
    const job = this.tracker.create('auth_test', ids)
    this.log.info('Auth test job started', {
      jobId: job.info.id,
      accounts: ids.length,
      concurrency: this.queue.concurrency,
    })
    for (const id of ids) this.enqueue(job, id, 0)
    return { ...job.info }
  }

  cancelAll(): number {
    const n = this.tracker.cancelAll()
    this.queue.clear()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.log.info('All auth test jobs cancelled', { jobs: n })
    return n
  }

  listJobs(): JobInfo[] {
    return this.tracker.list()
  }

  activeJobs(): number {
    return this.tracker.activeCount()
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
        // runOne は自分で例外を処理するので、ここに来るのはバグ
        this.log.error('Unexpected auth task failure', {
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
    if (!account) {
      this.tracker.complete(job, accountId, 'failed')
      return
    }
    if (account.enabled !== 1) {
      this.log.debug('Skipping disabled account', { accountId })
      this.tracker.complete(job, accountId, 'cancelled')
      return
    }

    await this.deps.repo.updateStatus(
      accountId,
      { status: 'connecting', retry_count: attempt },
      this.now(),
    )
    this.batcher.push(accountId)
    if (attempt === 0) this.log.info(`Account ${account.email} auth test started`, { accountId })

    try {
      await this.authenticate(account, signal)
      await this.deps.repo.updateStatus(
        accountId,
        {
          status: 'connected',
          auth_status: 'ok',
          last_error: null,
          last_success_at: this.now(),
          retry_count: attempt,
        },
        this.now(),
      )
      this.log.info(`Account ${account.email} auth test succeeded`, { accountId, attempt })
      this.tracker.complete(job, accountId, 'succeeded')
    } catch (err) {
      if (signal.aborted || err instanceof AbortError) {
        await this.deps.repo.updateStatus(accountId, { status: 'untested' }, this.now())
        this.tracker.complete(job, accountId, 'cancelled')
        return
      }
      const classified = classifyError(err)
      const message = this.deps.logger.scrubber
        .scrub(classified.message)
        .slice(0, MAX_ERROR_LENGTH)
      const maxRetries = this.deps.config.maxRetries()

      if (classified.kind === 'connection' && attempt < maxRetries) {
        const delay = retryDelayMs(this.deps.config.retryDelaysMs(), attempt)
        await this.deps.repo.updateStatus(
          accountId,
          {
            status: 'connecting',
            last_error: message,
            last_error_at: this.now(),
            retry_count: attempt + 1,
          },
          this.now(),
        )
        this.log.warn(`Account ${account.email} connection failed, retrying`, {
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
            .updateStatus(accountId, { status: 'untested' }, this.now())
            .finally(() => this.tracker.complete(job, accountId, 'cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.timers.add(timer)
        return
      }

      const status =
        classified.kind === 'auth'
          ? 'auth_error'
          : classified.kind === 'connection'
            ? 'connection_error'
            : 'error'
      await this.deps.repo.updateStatus(
        accountId,
        {
          status,
          auth_status: classified.kind === 'auth' ? 'failed' : account.auth_status,
          last_error: message,
          last_error_at: this.now(),
          retry_count: attempt,
        },
        this.now(),
      )
      const logMeta = {
        accountId,
        kind: classified.kind,
        code: classified.code,
        error: message,
        attempt,
      }
      if (classified.kind === 'auth')
        this.log.error(`Account ${account.email} authentication failed`, logMeta)
      else this.log.error(`Account ${account.email} auth test failed`, logMeta)
      this.tracker.complete(job, accountId, 'failed')
    } finally {
      this.batcher.push(accountId)
    }
  }

  private async authenticate(account: AccountRow, signal: AbortSignal): Promise<void> {
    const params = await buildSessionParams(
      account,
      {
        repo: this.deps.repo,
        cipher: this.deps.cipher,
        oauth: this.deps.oauth,
        logger: this.deps.logger,
        connectTimeoutMs: this.deps.config.connectTimeoutMs,
        tlsRejectUnauthorized: this.deps.config.tlsRejectUnauthorized,
        now: this.now,
      },
      signal,
    )
    try {
      await this.deps.provider.testConnection(params, signal)
    } catch (err) {
      // トークンが拒否された場合はキャッシュを捨て、次回は取り直す
      if (params.auth.type === 'oauth2' && classifyError(err).kind === 'auth')
        this.deps.oauth.cache.delete(account.id)
      throw err
    }
  }
}
