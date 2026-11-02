import type { Logger } from '../logging/logger'

export type WebhookEventName =
  | 'ACCOUNT_CONNECTED'
  | 'AUTH_FAILED'
  | 'SYNC_STARTED'
  | 'SYNC_COMPLETED'
  | 'SYNC_FAILED'
  | 'NEW_MESSAGE'
  | 'RULE_MATCHED';

/** 設定された URL にイベントを POST する（失敗してもアプリの処理は止めない） */
export class WebhookNotifier {
  constructor(
    private readonly url: () => string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** urlOverride を渡すと設定の URL の代わりにそこへ送る（ルールごとの Webhook） */
  send(event: WebhookEventName, data: Record<string, unknown>, urlOverride?: string): void {
    const url = (urlOverride?.trim() || this.url()).trim()
    if (!url) return
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data })
    void this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        if (!res.ok)
          this.logger.warn('Webhook responded with error', { event, status: res.status })
      })
      .catch((err) => {
        this.logger.warn('Webhook delivery failed', {
          event,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }
}
