import { sql, type Kysely } from 'kysely'
import type { DailyReport, Settings } from '@shared/types'
import type { Database } from '../db/schema'
import type { SettingsRepository } from '../db/settings-repository'
import type { WebhookNotifier } from '../events/webhook'
import type { Logger } from '../logging/logger'
import type { HealthService } from '../stats/health-service'
import type { StatsService } from '../stats/stats-service'

/** 最後にレポートを送った日（ローカル日付 YYYY-MM-DD）を settings に控えるキー */
const LAST_SENT_KEY = 'reportLastSentDate'

export interface ReportServiceDeps {
  db: Kysely<Database>;
  settings: () => Settings;
  settingsRepo: SettingsRepository;
  stats: StatsService;
  health: HealthService;
  webhook: WebhookNotifier;
  /** メールで送る（送信元アカウント・宛先・件名・本文） */
  sendMail: (accountId: string, to: string, subject: string, text: string) => Promise<unknown>;
  logger: Logger;
  now?: () => Date;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 日次レポート。直近 24 時間の新着・認証コード・転送の成否と、要対応アカウント・アカウントの状態をまとめ、
 * 設定した時刻にメール（指定アカウントから）と Webhook（DAILY_REPORT）へ送る。
 */
export class ReportService {
  private readonly log: Logger
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: ReportServiceDeps) {
    this.log = deps.logger.child('report')
    this.now = deps.now ?? (() => new Date())
  }

  async build(): Promise<DailyReport> {
    const now = this.now()
    const since = new Date(now.getTime() - 24 * 3_600_000).toISOString()
    const db = this.deps.db
    const received = db
      .selectFrom('messages')
      .innerJoin('mailboxes', 'mailboxes.id', 'messages.mailbox_id')
      .innerJoin('accounts', 'accounts.id', 'messages.account_id')
      .where('messages.created_at', '>=', since)
      .where((eb) =>
        eb.or([
          eb('mailboxes.special_use', 'is', null),
          eb('mailboxes.special_use', 'not in', ['\\Sent', '\\Drafts']),
        ]),
      )
    const [stats, health, newTotal, byAccount, codes, forwarded, forwardFailed] = await Promise.all([
      this.deps.stats.get(),
      this.deps.health.list(),
      received.select(sql<number>`count(*)`.as('c')).executeTakeFirstOrThrow(),
      received
        .select(['accounts.email as email', sql<number>`count(*)`.as('c')])
        .groupBy('accounts.email')
        .orderBy(sql`count(*)`, 'desc')
        .limit(10)
        .execute(),
      received
        .where((eb) => eb.or([eb('messages.otp_code', 'is not', null), eb('messages.otp_link', 'is not', null)]))
        .select(sql<number>`count(*)`.as('c'))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('forward_log')
        .where('forwarded_at', '>=', since)
        .select(sql<number>`count(*)`.as('c'))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('forward_attempts')
        .where('last_attempt_at', '>=', since)
        .select(sql<number>`count(*)`.as('c'))
        .executeTakeFirstOrThrow(),
    ])
    return {
      generatedAt: now.toISOString(),
      since,
      newMessages: Number(newTotal.c),
      topAccounts: byAccount.map((r) => ({ email: r.email, count: Number(r.c) })),
      codes: Number(codes.c),
      forwarded: Number(forwarded.c),
      forwardFailed: Number(forwardFailed.c),
      accounts: {
        total: stats.total,
        connected: stats.connected,
        authError: stats.authError,
        connectionError: stats.connectionError,
        syncError: stats.syncError,
        untested: stats.untested,
      },
      needsAttention: health.slice(0, 30).map((h) => ({
        email: h.email,
        severity: h.severity,
        reasons: h.issues.map((i) => i.reason),
      })),
      needsAttentionTotal: health.length,
    }
  }

  /** メール本文用のテキスト（日本語） */
  format(r: DailyReport): { subject: string; text: string } {
    const lines: string[] = []
    const day = localDate(new Date(r.generatedAt))
    lines.push(`Mail Manager 日次レポート（${day}）`, '')
    lines.push('■ 直近 24 時間')
    lines.push(`  新着メール: ${r.newMessages} 件`)
    for (const a of r.topAccounts) lines.push(`    - ${a.email}: ${a.count} 件`)
    lines.push(`  認証コード・確認リンク: ${r.codes} 件`)
    lines.push(`  転送: 成功 ${r.forwarded} 件 / 失敗 ${r.forwardFailed} 件`, '')
    lines.push('■ アカウント')
    const a = r.accounts
    lines.push(
      `  全 ${a.total} 件: 認証成功 ${a.connected} / 認証エラー ${a.authError} / 接続エラー ${a.connectionError} / 取得失敗 ${a.syncError} / 未テスト ${a.untested}`,
      '',
    )
    lines.push(`■ 要対応: ${r.needsAttentionTotal} 件`)
    const label: Record<string, string> = {
      auth_failed: '認証失敗',
      error_status: 'エラー状態',
      repeated_failures: '連続失敗',
      stale: '長期間受信なし',
      never_synced: '未同期',
      untested: '未テスト',
      forward_failures: '転送失敗',
    }
    for (const h of r.needsAttention)
      lines.push(`  - [${h.severity === 'critical' ? '重大' : '注意'}] ${h.email}: ${h.reasons.map((x) => label[x] ?? x).join('、')}`)
    if (r.needsAttentionTotal > r.needsAttention.length)
      lines.push(`  …ほか ${r.needsAttentionTotal - r.needsAttention.length} 件`)
    const subject = `[Mail Manager] 日次レポート ${day}: 新着 ${r.newMessages} 件 / 要対応 ${r.needsAttentionTotal} 件`
    return { subject, text: lines.join('\n') }
  }

  /** 今すぐ送る。送った経路を返す */
  async send(): Promise<{ email: boolean; webhook: boolean }> {
    const s = this.deps.settings()
    const report = await this.build()
    const { subject, text } = this.format(report)
    let email = false
    let webhook = false
    if (s.reportTo && s.reportFromAccountId) {
      await this.deps.sendMail(s.reportFromAccountId, s.reportTo, subject, text)
      email = true
    }
    if (s.reportWebhook && s.webhookUrl) {
      this.deps.webhook.send('DAILY_REPORT', { ...report, text })
      webhook = true
    }
    if (!email && !webhook) throw new Error('レポートの送り先（メールの宛先と送信元、または Webhook）が設定されていません')
    this.log.info('Daily report sent', { email, webhook, newMessages: report.newMessages, needsAttention: report.needsAttentionTotal })
    return { email, webhook }
  }

  /** 設定時刻を過ぎていて、今日まだ送っていなければ送る */
  async tick(): Promise<boolean> {
    const s = this.deps.settings()
    if (!s.reportTime) return false
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.reportTime)
    if (!m) return false
    const now = this.now()
    const today = localDate(now)
    const due = now.getHours() * 60 + now.getMinutes() >= Number(m[1]) * 60 + Number(m[2])
    if (!due) return false
    const last = (await this.deps.settingsRepo.getAll())[LAST_SENT_KEY]
    if (last === today) return false
    // 先に記録して、送信失敗で毎分再送し続けないようにする
    await this.deps.settingsRepo.set(LAST_SENT_KEY, today)
    try {
      await this.send()
      return true
    } catch (err) {
      this.log.warn('Daily report failed', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  start(intervalMs = 60_000): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
