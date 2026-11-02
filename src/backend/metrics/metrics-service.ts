import type { ConnectionMetrics, MetricsEventKind } from '@shared/types'
import type { ConnectionTestParams, EmailProvider } from '../mail/email-provider'
import type { MailSession } from '../mail/mail-session'

const MINUTES = 60
const MAX_EVENTS = 100

/** サーバーの「混雑・制限」を示すエラー（スロットリング・同時接続数超過・レート制限） */
export const THROTTLE_RE =
  /throttl|too many|rate.?limit|limit exceeded|try again later|temporarily unavailable|server busy|(?<!\d)429(?!\d)|(?<!\d)421(?!\d)|ETOOMANY|maximum number of connections|connection limit|UNAVAILABLE|4\.7\.0|4\.4\.5|MailboxConcurrency|ApplicationThrottled/i

interface Bucket {
  minute: number;
  connects: number;
  failures: number;
  throttled: number;
  sends: number;
  sendFailures: number;
}

interface HostStats {
  host: string;
  open: number;
  peak: number;
  connects: number;
  failures: number;
  throttled: number;
  sends: number;
  sendFailures: number;
}

/**
 * 接続数とレート制限の計測（メモリ内、直近 60 分）。
 * IMAP（同期・IDLE・一括操作・認証テスト）の接続数と失敗、送信（SMTP / Graph）の成否、
 * サーバーのスロットリング・同時接続数超過を数え、接続状況画面に出す。
 */
export class MetricsService {
  private readonly buckets: Bucket[] = []
  private readonly hosts = new Map<string, HostStats>()
  private readonly events: ConnectionMetrics['events'] = []
  private open = 0
  private peak = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  private bucket(): Bucket {
    const minute = Math.floor(this.now() / 60_000)
    let b = this.buckets.at(-1)
    if (!b || b.minute !== minute) {
      b = { minute, connects: 0, failures: 0, throttled: 0, sends: 0, sendFailures: 0 }
      this.buckets.push(b)
      while (this.buckets.length > 0 && this.buckets[0].minute <= minute - MINUTES) this.buckets.shift()
    }
    return b
  }

  private host(name: string): HostStats {
    let h = this.hosts.get(name)
    if (!h) {
      h = { host: name, open: 0, peak: 0, connects: 0, failures: 0, throttled: 0, sends: 0, sendFailures: 0 }
      this.hosts.set(name, h)
    }
    return h
  }

  private event(kind: MetricsEventKind, host: string, account: string, message: string): void {
    this.events.unshift({ at: new Date(this.now()).toISOString(), kind, host, account, message: message.slice(0, 300) })
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS
  }

  /** IMAP 接続の結果を記録する。成功したら接続中として数える（close で減らす） */
  connectResult(host: string, account: string, err: unknown | null): void {
    const b = this.bucket()
    const h = this.host(host)
    b.connects++
    h.connects++
    if (err === null) {
      this.open++
      h.open++
      this.peak = Math.max(this.peak, this.open)
      h.peak = Math.max(h.peak, h.open)
      return
    }
    this.failure(host, account, err, 'imap')
  }

  /** 接続後の処理（同期など）で起きたエラーも、制限系なら数える */
  failure(host: string, account: string, err: unknown, via: 'imap' | 'smtp'): void {
    const message = err instanceof Error ? err.message : String(err)
    const b = this.bucket()
    const h = this.host(host)
    if (via === 'imap') {
      b.failures++
      h.failures++
    }
    if (THROTTLE_RE.test(message)) {
      b.throttled++
      h.throttled++
      this.event('throttled', host, account, message)
    } else if (via === 'imap') this.event('imap_error', host, account, message)
  }

  closed(host: string): void {
    this.open = Math.max(0, this.open - 1)
    const h = this.host(host)
    h.open = Math.max(0, h.open - 1)
  }

  sendResult(host: string, account: string, err: unknown | null): void {
    const b = this.bucket()
    const h = this.host(host)
    b.sends++
    h.sends++
    if (err === null) return
    b.sendFailures++
    h.sendFailures++
    const message = err instanceof Error ? err.message : String(err)
    if (THROTTLE_RE.test(message)) {
      b.throttled++
      h.throttled++
      this.event('throttled', host, account, message)
    } else this.event('send_error', host, account, message)
  }

  snapshot(): ConnectionMetrics {
    this.bucket() // 古いバケットを捨てる
    const nowMin = Math.floor(this.now() / 60_000)
    const byMinute = new Map(this.buckets.map((b) => [b.minute, b]))
    const series = Array.from({ length: MINUTES }, (_, i) => {
      const minute = nowMin - (MINUTES - 1 - i)
      const b = byMinute.get(minute)
      return {
        at: new Date(minute * 60_000).toISOString(),
        connects: b?.connects ?? 0,
        failures: b?.failures ?? 0,
        throttled: b?.throttled ?? 0,
        sends: b?.sends ?? 0,
        sendFailures: b?.sendFailures ?? 0,
      }
    })
    return {
      open: this.open,
      peak: this.peak,
      series,
      hosts: [...this.hosts.values()].sort((a, b) => b.connects - a.connects).map((h) => ({ ...h })),
      events: [...this.events],
    }
  }

  /** EmailProvider を包み、接続・切断・失敗を計測する */
  wrap(provider: EmailProvider): EmailProvider {
    const record = {
      connect: (host: string, user: string, err: unknown | null) => this.connectResult(host, user, err),
      closed: (host: string) => this.closed(host),
    }
    return {
      async testConnection(p: ConnectionTestParams, signal?: AbortSignal) {
        try {
          await provider.testConnection(p, signal)
          record.connect(p.host, p.user, null)
          record.closed(p.host)
        } catch (err) {
          if (!signal?.aborted) record.connect(p.host, p.user, err)
          throw err
        }
      },
      async openSession(p: ConnectionTestParams, signal?: AbortSignal): Promise<MailSession> {
        let session: MailSession
        try {
          session = await provider.openSession(p, signal)
        } catch (err) {
          if (!signal?.aborted) record.connect(p.host, p.user, err)
          throw err
        }
        record.connect(p.host, p.user, null)
        let closed = false
        const close = session.close.bind(session)
        session.close = async () => {
          if (!closed) {
            closed = true
            record.closed(p.host)
          }
          await close()
        }
        return session
      },
    }
  }
}
