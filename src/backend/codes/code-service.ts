import { sql, type Kysely } from 'kysely'
import type { CodeListQuery, ReceivedCode } from '@shared/types'
import { extractCode } from './extract-code'
import type { Database } from '../db/schema'
import type { Logger } from '../logging/logger'

const BACKFILL_CHUNK = 300

/**
 * 認証コード・確認リンク。同期時に抽出した結果を一覧にし、抽出前の既存メールはバックグラウンドで埋める。
 */
export class CodeService {
  private readonly log: Logger
  private backfilling: Promise<number> | null = null
  private stopped = false

  constructor(
    private readonly db: Kysely<Database>,
    logger: Logger,
  ) {
    this.log = logger.child('codes')
  }

  /** 受信メール（送信済み・下書きを除く）のうち、コードかリンクが見つかったものを新しい順に返す */
  async list(q: CodeListQuery = {}): Promise<ReceivedCode[]> {
    const sinceHours = q.sinceHours ?? 24
    let query = this.db
      .selectFrom('messages')
      .innerJoin('accounts', 'accounts.id', 'messages.account_id')
      .innerJoin('mailboxes', 'mailboxes.id', 'messages.mailbox_id')
      .select([
        'messages.id as id',
        'messages.account_id as accountId',
        'accounts.email as accountEmail',
        'messages.from_address as fromAddress',
        'messages.from_name as fromName',
        'messages.subject as subject',
        'messages.date as date',
        'messages.internal_date as internalDate',
        'messages.otp_code as code',
        'messages.otp_link as link',
        'messages.seen as seen',
      ])
      .where((eb) => eb.or([eb('messages.otp_code', 'is not', null), eb('messages.otp_link', 'is not', null)]))
      .where((eb) =>
        eb.or([
          eb('mailboxes.special_use', 'is', null),
          eb('mailboxes.special_use', 'not in', ['\\Sent', '\\Drafts']),
        ]),
      )
    if (sinceHours > 0) {
      const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString()
      query = query.where(sql<string>`coalesce(messages.internal_date, messages.date, messages.created_at)`, '>=', since)
    }
    if (q.accountIds?.length) query = query.where('messages.account_id', 'in', q.accountIds)
    if (q.text?.trim()) {
      const like = `%${q.text.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
      query = query.where((eb) =>
        eb.or([
          eb(sql`lower(accounts.email)`, 'like', like),
          eb(sql`lower(coalesce(messages.from_address, ''))`, 'like', like),
          eb(sql`lower(coalesce(messages.from_name, ''))`, 'like', like),
          eb(sql`lower(messages.subject)`, 'like', like),
        ]),
      )
    }
    const rows = await query
      .orderBy(sql`coalesce(messages.internal_date, messages.date, messages.created_at)`, 'desc')
      .limit(Math.min(1000, Math.max(1, q.limit ?? 200)))
      .execute()
    return rows.map((r) => ({
      messageId: r.id,
      accountId: r.accountId,
      accountEmail: r.accountEmail,
      from: r.fromName || r.fromAddress,
      subject: r.subject,
      receivedAt: r.internalDate ?? r.date,
      code: r.code,
      link: r.link,
      seen: r.seen === 1,
    }))
  }

  /** 抽出前（otp_scanned = 0）の既存メールを少しずつ処理する。処理した件数を返す */
  backfill(): Promise<number> {
    if (!this.backfilling)
      this.backfilling = this.runBackfill().finally(() => {
        this.backfilling = null
      })
    return this.backfilling
  }

  stop(): void {
    this.stopped = true
  }

  private async runBackfill(): Promise<number> {
    let total = 0
    while (!this.stopped) {
      const rows = await this.db
        .selectFrom('messages')
        .select(['id', 'subject', 'text_body', 'html_body'])
        .where('otp_scanned', '=', 0)
        .limit(BACKFILL_CHUNK)
        .execute()
      if (rows.length === 0) break
      await this.db.transaction().execute(async (trx) => {
        for (const r of rows) {
          const { code, link } = extractCode({ subject: r.subject, text: r.text_body, html: r.html_body })
          await trx
            .updateTable('messages')
            .set({ otp_code: code, otp_link: link, otp_scanned: 1 })
            .where('id', '=', r.id)
            .execute()
        }
      })
      total += rows.length
      // UI や同期を止めないよう、チャンクごとにイベントループへ返す
      await new Promise((r) => setTimeout(r, 0))
    }
    if (total > 0) this.log.info('Verification codes extracted from existing messages', { messages: total })
    return total
  }
}
