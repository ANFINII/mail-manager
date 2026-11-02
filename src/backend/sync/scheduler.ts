import type { Logger } from '../logging/logger'

/**
 * 設定した間隔で認証済みアカウントの同期を起動する（バックグラウンド同期）。間隔は秒単位。
 * 起動時は OFF。ユーザーが「自動同期」ボタンで ON にしたときだけタイマーが動く。
 */
export class AutoSyncScheduler {
  private timer: NodeJS.Timeout | null = null
  private intervalSec = 0
  private enabled = false

  constructor(
    private readonly run: () => Promise<void>,
    private readonly isBusy: () => boolean,
    private readonly logger: Logger,
  ) {}

  /** intervalSec: 同期間隔（秒）。0 以下なら定期実行なし（ON でも認証完了時の受信だけ）。 */
  configure(intervalSec: number): void {
    if (intervalSec === this.intervalSec) return
    this.intervalSec = intervalSec
    this.restart()
  }

  /** 自動同期の ON/OFF。OFF の間は定期実行・認証完了時の自動受信とも行わない。 */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.restart()
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get interval(): number {
    return this.intervalSec
  }

  private restart(): void {
    this.stop()
    if (!this.enabled) {
      this.logger.info('Auto sync disabled')
      return
    }
    if (this.intervalSec > 0) {
      this.timer = setInterval(() => void this.tick(), this.intervalSec * 1000)
      this.timer.unref?.()
      this.logger.info('Auto sync enabled', { intervalSec: this.intervalSec })
    } else {
      this.logger.info('Auto sync enabled (no interval; on-auth only)')
    }
  }

  private async tick(): Promise<void> {
    if (this.isBusy()) {
      this.logger.debug('Auto sync skipped: sync already running')
      return
    }
    try {
      await this.run()
    } catch (err) {
      this.logger.warn('Auto sync failed to start', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
