import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { SearchQuery } from '@shared/types'
import { realignFtsRowids, type DbDriver } from './migrations'
import type { AttachmentRow, Database, MessageRow } from './schema'

/** 挿入時は fts_rowid を持たなくてよい（insertMany が FTS 行を作った後に埋める） */
export type NewMessageRow = Omit<MessageRow, 'fts_rowid'> & { fts_rowid?: number | null };
export type NewAttachmentRow = AttachmentRow;
export interface FtsRow {
  message_id: string;
  subject: string;
  from_text: string;
  to_text: string;
  body: string;
  attachments: string;
}

export interface MessageWithContext extends MessageRow {
  account_email: string;
  mailbox_path: string;
  forward_count: number;
}

/** 一括操作用の軽い参照（本文を持たない） */
export interface MessageRef {
  id: string;
  account_id: string;
  mailbox_id: string;
  remote_uid: number;
  mailbox_path: string;
}

export interface FlagPatch {
  seen?: boolean;
  flagged?: boolean;
}

const CHUNK = 50

/** 転送ログの鍵。RFC Message-ID があればそれ、無ければ差出人・日付・件名のハッシュ */
export function forwardMessageKey(row: {
  message_id: string | null;
  from_address: string | null;
  date: string | null;
  subject: string;
}): string {
  const mid = (row.message_id ?? '').trim()
  if (mid) return mid
  return (
    'h:' +
    createHash('sha256')
      .update(`${row.from_address ?? ''}|${row.date ?? ''}|${row.subject}`)
      .digest('hex')
  )
}

/** 送信済みフォルダの控え（転送メール）に含まれる、元メールの識別マーカー */
export interface SentCopy {
  subject: string;
  text_body: string | null;
  html_body: string | null;
  date: string | null;
}

/** 3 文字未満の語は trigram で検索できないので LIKE にフォールバックする */
export function buildFtsQuery(text: string): { match: string | null; likeTerms: string[] } {
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  const long = terms.filter((t) => [...t].length >= 3)
  const short = terms.filter((t) => [...t].length < 3)
  const match = long.length > 0 ? long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ') : null
  return { match, likeTerms: short }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

export class MessageRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly driver: DbDriver,
  ) {}

  async insertMany(
    rows: NewMessageRow[],
    fts: FtsRow[],
    attachments: NewAttachmentRow[],
  ): Promise<number> {
    if (rows.length === 0) return 0
    await this.db.transaction().execute(async (trx) => {
      const values: MessageRow[] = rows.map((r) => ({ ...r, fts_rowid: r.fts_rowid ?? null }))
      for (let i = 0; i < values.length; i += CHUNK) {
        await trx
          .insertInto('messages')
          .values(values.slice(i, i + CHUNK))
          .onConflict((oc) => oc.columns(['account_id', 'mailbox_id', 'remote_uid']).doNothing())
          .execute()
      }
      // 重複でスキップされた行（onConflict doNothing）には FTS 行や添付を作らない。
      // id は毎回新しい UUID なので、実際に入った行だけが SELECT で返る。
      const inserted = new Set<string>()
      for (let i = 0; i < values.length; i += 500) {
        const got = await trx
          .selectFrom('messages')
          .select('id')
          .where(
            'id',
            'in',
            values.slice(i, i + 500).map((r) => r.id),
          )
          .execute()
        for (const g of got) inserted.add(g.id)
      }
      if (this.driver === 'sqlite') {
        // FTS 行はまとめて入れ、直後に rowid の範囲を読み戻して messages.fts_rowid に控える。
        // 削除トリガーはこの rowid で消すので、全文検索表を走査しない（1 件あたり数秒 → 数ミリ秒）。
        const ftsRows = fts.filter((row) => inserted.has(row.message_id))
        for (let i = 0; i < ftsRows.length; i += CHUNK) {
          const chunk = ftsRows.slice(i, i + CHUNK)
          const r = await trx.insertInto('messages_fts').values(chunk).executeTakeFirst()
          const last = r.insertId === undefined ? null : Number(r.insertId)
          // rowid は max+1 で連番に振られるが、前提にせず実際の rowid を読み戻して対応付ける
          const assigned =
            last === null
              ? []
              : await trx
                  .selectFrom('messages_fts')
                  .select([sql<number>`rowid`.as('rowid'), 'message_id'])
                  .where(sql`rowid`, '>', last - chunk.length)
                  .where(sql`rowid`, '<=', last)
                  .execute()
          const pairs = assigned
            .filter((a) => inserted.has(a.message_id))
            .map((a) => ({ id: a.message_id, rowid: Number(a.rowid) }))
          if (pairs.length === 0) continue
          // 1 チャンク分をまとめて 1 文で更新する（CASE id WHEN ... END）
          await trx
            .updateTable('messages')
            .set({
              fts_rowid: sql<number>`case id ${sql.join(
                pairs.map((p) => sql`when ${p.id} then ${p.rowid}`),
                sql` `,
              )} end`,
            })
            .where(
              'id',
              'in',
              pairs.map((p) => p.id),
            )
            .execute()
        }
      }
      const atts = attachments.filter((a) => inserted.has(a.message_id))
      for (let i = 0; i < atts.length; i += CHUNK) {
        await trx
          .insertInto('attachments')
          .values(atts.slice(i, i + CHUNK))
          .execute()
      }
    })
    return rows.length
  }

  /**
   * messages.fts_rowid を messages_fts から埋め直し、対応するメールが無い FTS 行を消す。
   * 通常は移行 0009 が一度だけ行う。バックアップ復元などで対応がずれた場合の修復用。
   */
  async realignFts(): Promise<void> {
    if (this.driver !== 'sqlite') return
    await realignFtsRowids(this.db as unknown as Kysely<unknown>)
  }

  async existingUids(mailboxId: string, uids: number[]): Promise<Set<number>> {
    const out = new Set<number>()
    for (let i = 0; i < uids.length; i += 500) {
      const rows = await this.db
        .selectFrom('messages')
        .select('remote_uid')
        .where('mailbox_id', '=', mailboxId)
        .where('remote_uid', 'in', uids.slice(i, i + 500))
        .execute()
      for (const r of rows) out.add(r.remote_uid)
    }
    return out
  }

  /** フラグ同期用: フォルダ内のローカル保存済みメッセージ（UID ≤ maxUid）のフラグ状態 */
  async flagStates(
    mailboxId: string,
    maxUid: number,
  ): Promise<Array<{ id: string; remote_uid: number; seen: number; flagged: number; answered: number }>> {
    return this.db
      .selectFrom('messages')
      .select(['id', 'remote_uid', 'seen', 'flagged', 'answered'])
      .where('mailbox_id', '=', mailboxId)
      .where('remote_uid', '<=', maxUid)
      .execute()
  }

  /** ID と既読・スターの状態だけを返す（ルールの重複適用を避けるため） */
  async getRefsWithFlags(ids: string[]): Promise<Array<{ id: string; seen: number; flagged: number }>> {
    const out: Array<{ id: string; seen: number; flagged: number }> = []
    for (let i = 0; i < ids.length; i += 400) {
      out.push(
        ...(await this.db
          .selectFrom('messages')
          .select(['id', 'seen', 'flagged'])
          .where('id', 'in', ids.slice(i, i + 400))
          .execute()),
      )
    }
    return out
  }

  /** サーバー側のフラグ変更をローカルへ反映する */
  async applyFlagStates(
    updates: Array<{ id: string; seen: number; flagged: number; answered: number }>,
    now: string,
  ): Promise<void> {
    if (updates.length === 0) return
    await this.db.transaction().execute(async (trx) => {
      for (const u of updates)
        await trx
          .updateTable('messages')
          .set({ seen: u.seen, flagged: u.flagged, answered: u.answered, updated_at: now })
          .where('id', '=', u.id)
          .execute()
    })
  }

  async countAll(): Promise<number> {
    const r = await this.db
      .selectFrom('messages')
      .select(sql<number>`count(*)`.as('c'))
      .executeTakeFirstOrThrow()
    return Number(r.c)
  }

  async countByAccount(accountId: string): Promise<number> {
    const r = await this.db
      .selectFrom('messages')
      .select(sql<number>`count(*)`.as('c'))
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow()
    return Number(r.c)
  }

  async getById(id: string): Promise<MessageWithContext | undefined> {
    return this.baseQuery().where('messages.id', '=', id).executeTakeFirst()
  }

  async getByIds(ids: string[]): Promise<MessageWithContext[]> {
    const out: MessageWithContext[] = []
    for (let i = 0; i < ids.length; i += 200) {
      out.push(
        ...(await this.baseQuery()
          .where('messages.id', 'in', ids.slice(i, i + 200))
          .execute()),
      )
    }
    return out
  }

  async listAttachments(messageId: string): Promise<AttachmentRow[]> {
    return this.db
      .selectFrom('attachments')
      .selectAll()
      .where('message_id', '=', messageId)
      .orderBy('created_at')
      .execute()
  }

  async listForwardRecords(query: import('@shared/types').ForwardListQuery): Promise<{
    rows: Array<{
      message_id: string;
      account_email: string;
      from_name: string | null;
      from_address: string | null;
      subject: string;
      date: string | null;
      to_address: string;
      forwarded_at: string;
    }>;
    total: number;
  }> {
    const apply = <Q extends { where: (...args: any[]) => Q }>(q: Q): Q => {
      let out = q
      if (query.accountIds && query.accountIds.length > 0)
        out = out.where('messages.account_id', 'in', query.accountIds)
      if (query.to)
        out = out.where(
          'forwards.to_address',
          'like',
          `%${query.to.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`,
        )
      return out
    }
    const countRow = await apply(
      this.db
        .selectFrom('forwards')
        .innerJoin('messages', 'messages.id', 'forwards.message_id')
        .select(sql<number>`count(*)`.as('c')),
    ).executeTakeFirstOrThrow()
    const pageSize = Math.min(500, Math.max(1, query.pageSize || 50))
    const page = Math.max(1, query.page || 1)
    const rows = await apply(
      this.db
        .selectFrom('forwards')
        .innerJoin('messages', 'messages.id', 'forwards.message_id')
        .innerJoin('accounts', 'accounts.id', 'messages.account_id')
        .select([
          'forwards.message_id as message_id',
          'forwards.to_address as to_address',
          'forwards.forwarded_at as forwarded_at',
          'accounts.email as account_email',
          'messages.from_name as from_name',
          'messages.from_address as from_address',
          'messages.subject as subject',
          'messages.date as date',
        ]),
    )
      .orderBy('forwards.forwarded_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute()
    return { rows, total: Number(countRow.c) }
  }

  async listForwards(messageId: string): Promise<Array<{ to: string; at: string }>> {
    const rows = await this.db
      .selectFrom('forwards')
      .select(['to_address', 'forwarded_at'])
      .where('message_id', '=', messageId)
      .orderBy('forwarded_at')
      .execute()
    return rows.map((r) => ({ to: r.to_address, at: r.forwarded_at }))
  }

  async getAttachment(id: string): Promise<AttachmentRow | undefined> {
    return this.db.selectFrom('attachments').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async setAttachmentStorage(id: string, storagePath: string): Promise<void> {
    await this.db
      .updateTable('attachments')
      .set({ storage_path: storagePath })
      .where('id', '=', id)
      .execute()
  }

  async updateFlags(ids: string[], patch: FlagPatch, now: string): Promise<number> {
    const set: Partial<MessageRow> = { updated_at: now }
    if (patch.seen !== undefined) set.seen = patch.seen ? 1 : 0
    if (patch.flagged !== undefined) set.flagged = patch.flagged ? 1 : 0
    let n = 0
    for (let i = 0; i < ids.length; i += 200) {
      const r = await this.db
        .updateTable('messages')
        .set(set)
        .where('id', 'in', ids.slice(i, i + 200))
        .executeTakeFirst()
      n += Number(r.numUpdatedRows ?? 0)
    }
    return n
  }

  async deleteByIds(ids: string[]): Promise<number> {
    let n = 0
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      // SQLite は AFTER DELETE トリガーが fts_rowid で FTS 行を消す。PostgreSQL には FTS テーブルが無い。
      const r = await this.db.deleteFrom('messages').where('id', 'in', chunk).executeTakeFirst()
      n += Number(r.numDeletedRows ?? 0)
    }
    return n
  }

  async deleteByMailbox(mailboxId: string): Promise<number> {
    const r = await this.db
      .deleteFrom('messages')
      .where('mailbox_id', '=', mailboxId)
      .executeTakeFirst()
    return Number(r.numDeletedRows ?? 0)
  }

  /** 指定宛先へまだ転送していない message_id だけを返す（宛先は大文字小文字を区別しない） */
  async filterNotForwarded(ids: string[], to: string): Promise<string[]> {
    if (ids.length === 0) return []
    const already = new Set<string>()
    for (let i = 0; i < ids.length; i += 400) {
      const rows = await this.db
        .selectFrom('forwards')
        .select('message_id')
        .where(sql`lower(to_address)`, '=', to.toLowerCase())
        .where('message_id', 'in', ids.slice(i, i + 400))
        .execute()
      for (const r of rows) already.add(r.message_id)
    }
    return ids.filter((id) => !already.has(id))
  }

  /** 恒久ログ（forward_log）に転送済みとして残っているメールを返す */
  async forwardLogHits(rows: MessageWithContext[], to: string): Promise<MessageWithContext[]> {
    if (rows.length === 0) return []
    const keyOf = (r: MessageWithContext) => `${r.account_email.toLowerCase()}\u0000${forwardMessageKey(r)}`
    const keys = [...new Set(rows.map(forwardMessageKey))]
    const hit = new Set<string>()
    for (let i = 0; i < keys.length; i += 400) {
      const found = await this.db
        .selectFrom('forward_log')
        .select(['account_email', 'message_key'])
        .where('to_address', '=', to.toLowerCase())
        .where('message_key', 'in', keys.slice(i, i + 400))
        .execute()
      for (const f of found) hit.add(`${f.account_email}\u0000${f.message_key}`)
    }
    return rows.filter((r) => hit.has(keyOf(r)))
  }

  /** そのアカウントの送信済みフォルダにある、指定宛先へのメール（転送の控え候補） */
  async findSentCopies(accountId: string, to: string): Promise<SentCopy[]> {
    return this.db
      .selectFrom('messages')
      .innerJoin('mailboxes', 'mailboxes.id', 'messages.mailbox_id')
      .select(['messages.subject', 'messages.text_body', 'messages.html_body', 'messages.date'])
      .where('messages.account_id', '=', accountId)
      .where((eb: any) =>
        eb.or([
          eb('mailboxes.special_use', '=', '\\Sent'),
          eb(sql`lower(mailboxes.path)`, 'like', 'sent%'),
        ]),
      )
      .where(sql`lower(messages.to_addresses)`, 'like', `%${escapeLike(to.toLowerCase())}%`)
      .execute()
  }

  /**
   * 送信済みフォルダにある転送控え（差出人が自分で件名が Fwd:/FW:/転送:）のうち、
   * 同じアカウント・件名・宛先で 2 通以上あるものの「最古の 1 通以外」の ID を返す。
   */
  async findDuplicateSentCopies(
    accountIds?: string[],
  ): Promise<{ ids: string[]; groups: number; accounts: number; sampleSubjects: string[] }> {
    const scope =
      accountIds && accountIds.length > 0
        ? sql`AND m.account_id IN (${sql.join(accountIds.map((id) => sql`${id}`))})`
        : sql``
    const rows = await sql<{ id: string; account_id: string; subject: string; rn: number }>`
      SELECT id, account_id, subject, rn FROM (
        SELECT m.id, m.account_id, m.subject,
               ROW_NUMBER() OVER (
                 PARTITION BY m.account_id, m.subject, lower(m.to_addresses)
                 ORDER BY m.date, m.remote_uid
               ) AS rn
        FROM messages m
        JOIN mailboxes mb ON mb.id = m.mailbox_id
        JOIN accounts a ON a.id = m.account_id
        WHERE (mb.special_use = '\\Sent' OR lower(mb.path) LIKE 'sent%')
          AND lower(coalesce(m.from_address, '')) = lower(a.email)
          AND (lower(trim(m.subject)) LIKE 'fwd:%' OR lower(trim(m.subject)) LIKE 'fw:%' OR trim(m.subject) LIKE '転送:%')
          ${scope}
      ) WHERE rn > 1
      ORDER BY account_id, subject
    `.execute(this.db)
    const ids = rows.rows.map((r) => r.id)
    const groupKeys = new Set<string>()
    const accounts = new Set<string>()
    const subjects: string[] = []
    for (const r of rows.rows) {
      accounts.add(r.account_id)
      const key = `${r.account_id}\u0000${r.subject}`
      if (!groupKeys.has(key)) {
        groupKeys.add(key)
        if (subjects.length < 5) subjects.push(r.subject)
      }
    }
    return { ids, groups: groupKeys.size, accounts: accounts.size, sampleSubjects: subjects }
  }

  /** 一括操作（削除・フラグ）に必要な最小限の列だけを読む（本文は読まない） */
  async getRefsByIds(ids: string[]): Promise<MessageRef[]> {
    const out: MessageRef[] = []
    for (let i = 0; i < ids.length; i += 400) {
      const rows = await this.db
        .selectFrom('messages')
        .innerJoin('mailboxes', 'mailboxes.id', 'messages.mailbox_id')
        .select([
          'messages.id',
          'messages.account_id',
          'messages.mailbox_id',
          'messages.remote_uid',
          'mailboxes.path as mailbox_path',
        ])
        .where('messages.id', 'in', ids.slice(i, i + 400))
        .execute()
      out.push(...rows)
    }
    return out
  }

  async recordForwardLog(accountEmail: string, key: string, to: string, at: string): Promise<void> {
    await this.db
      .insertInto('forward_log')
      .values({
        account_email: accountEmail.toLowerCase(),
        message_key: key,
        to_address: to.toLowerCase(),
        forwarded_at: at,
      })
      .onConflict((oc) => oc.columns(['account_email', 'message_key', 'to_address']).doNothing())
      .execute()
  }

  /** 転送済みとして forwards（行単位）と forward_log（恒久）の両方に記録する */
  async markForwarded(row: MessageWithContext, to: string, at: string): Promise<void> {
    await this.recordForward(row.id, to, at)
    await this.recordForwardLog(row.account_email, forwardMessageKey(row), to, at)
  }

  async recordForward(messageId: string, to: string, now: string): Promise<void> {
    await this.db
      .insertInto('forwards')
      .values({ message_id: messageId, to_address: to, forwarded_at: now })
      .onConflict((oc) => oc.columns(['message_id', 'to_address']).doNothing())
      .execute()
    // 成功したら失敗記録は不要
    await this.db
      .deleteFrom('forward_attempts')
      .where('message_id', '=', messageId)
      .where('to_address', '=', to)
      .execute()
  }

  /**
   * 転送失敗を記録し、次回の自動再試行時刻を指数バックオフで決める（5分 → 10分 → 20分 … 最大 24 時間）。
   * 手動転送はこの記録を無視して即時に再試行できる。
   */
  async recordForwardFailure(
    messageId: string,
    to: string,
    error: string,
    now: string,
  ): Promise<{ attempts: number; nextRetryAt: string }> {
    const prev = await this.db
      .selectFrom('forward_attempts')
      .select('attempts')
      .where('message_id', '=', messageId)
      .where('to_address', '=', to)
      .executeTakeFirst()
    const attempts = (prev?.attempts ?? 0) + 1
    const delayMin = Math.min(5 * 2 ** (attempts - 1), 24 * 60)
    const nextRetryAt = new Date(new Date(now).getTime() + delayMin * 60_000).toISOString()
    const lastError = error.slice(0, 500)
    await this.db
      .insertInto('forward_attempts')
      .values({
        message_id: messageId,
        to_address: to,
        attempts,
        last_error: lastError,
        last_attempt_at: now,
        next_retry_at: nextRetryAt,
      })
      .onConflict((oc) =>
        oc.columns(['message_id', 'to_address']).doUpdateSet({
          attempts,
          last_error: lastError,
          last_attempt_at: now,
          next_retry_at: nextRetryAt,
        }),
      )
      .execute()
    return { attempts, nextRetryAt }
  }

  /** 自動転送の対象から、失敗後のバックオフ待ち（next_retry_at が未来）のメールを除く */
  async filterRetryable(ids: string[], to: string, now: string): Promise<string[]> {
    if (ids.length === 0) return []
    const waiting = new Set<string>()
    for (let i = 0; i < ids.length; i += 400) {
      const rows = await this.db
        .selectFrom('forward_attempts')
        .select('message_id')
        .where('to_address', '=', to)
        .where('next_retry_at', '>', now)
        .where('message_id', 'in', ids.slice(i, i + 400))
        .execute()
      for (const r of rows) waiting.add(r.message_id)
    }
    return ids.filter((id) => !waiting.has(id))
  }

  /** バックオフ待ちの転送失敗件数（宛先別ではなく全体） */
  async countPendingForwardFailures(): Promise<number> {
    const r = await this.db
      .selectFrom('forward_attempts')
      .select(sql<number>`count(*)`.as('c'))
      .executeTakeFirstOrThrow()
    return Number(r.c)
  }

  /** アカウントごとの転送失敗件数（健全性モニタ用） */
  async forwardFailureCountsByAccount(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom('forward_attempts')
      .innerJoin('messages', 'messages.id', 'forward_attempts.message_id')
      .select(['messages.account_id as account_id', sql<number>`count(*)`.as('c')])
      .groupBy('messages.account_id')
      .execute()
    return new Map(rows.map((r) => [r.account_id, Number(r.c)]))
  }

  /** 転送失敗（バックオフ待ちを含む）の一覧。新しい失敗から順に返す */
  async listForwardFailures(query: import('@shared/types').ForwardListQuery): Promise<{
    rows: Array<{
      message_id: string;
      account_email: string;
      from_name: string | null;
      from_address: string | null;
      subject: string;
      date: string | null;
      to_address: string;
      attempts: number;
      last_error: string | null;
      last_attempt_at: string;
      next_retry_at: string;
    }>;
    total: number;
  }> {
    const apply = <Q extends { where: (...args: any[]) => Q }>(q: Q): Q => {
      let out = q
      if (query.accountIds && query.accountIds.length > 0)
        out = out.where('messages.account_id', 'in', query.accountIds)
      if (query.to)
        out = out.where(
          'forward_attempts.to_address',
          'like',
          `%${escapeLike(query.to.toLowerCase())}%`,
        )
      return out
    }
    const countRow = await apply(
      this.db
        .selectFrom('forward_attempts')
        .innerJoin('messages', 'messages.id', 'forward_attempts.message_id')
        .select(sql<number>`count(*)`.as('c')),
    ).executeTakeFirstOrThrow()
    const pageSize = Math.min(500, Math.max(1, query.pageSize || 50))
    const page = Math.max(1, query.page || 1)
    const rows = await apply(
      this.db
        .selectFrom('forward_attempts')
        .innerJoin('messages', 'messages.id', 'forward_attempts.message_id')
        .innerJoin('accounts', 'accounts.id', 'messages.account_id')
        .select([
          'forward_attempts.message_id as message_id',
          'forward_attempts.to_address as to_address',
          'forward_attempts.attempts as attempts',
          'forward_attempts.last_error as last_error',
          'forward_attempts.last_attempt_at as last_attempt_at',
          'forward_attempts.next_retry_at as next_retry_at',
          'accounts.email as account_email',
          'messages.from_name as from_name',
          'messages.from_address as from_address',
          'messages.subject as subject',
          'messages.date as date',
        ]),
    )
      .orderBy('forward_attempts.last_attempt_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute()
    return { rows, total: Number(countRow.c) }
  }

  /** 転送失敗の記録を消す（items 省略時は全件）。消した件数を返す */
  async clearForwardFailures(items?: Array<{ messageId: string; to: string }>): Promise<number> {
    if (!items) {
      const r = await this.db.deleteFrom('forward_attempts').executeTakeFirst()
      return Number(r.numDeletedRows ?? 0)
    }
    let n = 0
    for (const it of items) {
      const r = await this.db
        .deleteFrom('forward_attempts')
        .where('message_id', '=', it.messageId)
        .where('to_address', '=', it.to)
        .executeTakeFirst()
      n += Number(r.numDeletedRows ?? 0)
    }
    return n
  }

  /** 検索条件に一致する全メッセージ ID を返す（転送用、上限あり） */
  async searchAllIds(query: SearchQuery, cap = 100_000): Promise<string[]> {
    const ids: string[] = []
    const pageSize = 1000
    let page = 1
    while (ids.length < cap) {
      const { rows } = await this.search({ ...query, page, pageSize })
      ids.push(...rows.map((r) => r.id))
      if (rows.length < pageSize) break
      page++
    }
    return ids.slice(0, cap)
  }

  private baseQuery() {
    return this.db
      .selectFrom('messages')
      .innerJoin('accounts', 'accounts.id', 'messages.account_id')
      .innerJoin('mailboxes', 'mailboxes.id', 'messages.mailbox_id')
      .selectAll('messages')
      .select([
        'accounts.email as account_email',
        'mailboxes.path as mailbox_path',
        sql<number>`(select count(*) from forwards f where f.message_id = messages.id)`.as(
          'forward_count',
        ),
      ])
  }

  /** search / accountGroups 共通のフィルタ適用（accountIds・folder・日付・差出人・宛先・件名・添付・未読・転送・全文） */
  private applyFilters<Q extends { where: (...args: any[]) => Q }>(q: Q, query: SearchQuery): Q {
    let out = q
    if (query.accountIds && query.accountIds.length > 0)
      out = out.where('messages.account_id', 'in', query.accountIds)
    if (query.mailboxPath) out = out.where('mailboxes.path', '=', query.mailboxPath)
    if (query.mailboxSpecialUse)
      out = out.where('mailboxes.special_use', '=', query.mailboxSpecialUse)
    if (query.receivedOnly) {
      // 自分の送信控え（送信済み・下書き、または差出人が自分）は対象外
      out = out
        .where((eb: any) =>
          eb.or([
            eb('mailboxes.special_use', 'is', null),
            eb('mailboxes.special_use', 'not in', ['\\Sent', '\\Drafts']),
          ]),
        )
        .where(sql`lower(mailboxes.path)`, 'not like', 'sent%')
        .where(sql`lower(mailboxes.path)`, 'not like', 'draft%')
        .where((eb: any) =>
          eb.or([
            eb('messages.from_address', 'is', null),
            eb(sql`lower(messages.from_address)`, '!=', sql`lower(accounts.email)`),
          ]),
        )
    }
    if (query.storedSince) out = out.where('messages.created_at', '>=', query.storedSince)
    if (query.dateFrom) out = out.where('messages.date', '>=', localDayStart(query.dateFrom))
    if (query.dateTo) out = out.where('messages.date', '<', localDayStart(query.dateTo, 1))
    if (query.from) {
      const like = `%${escapeLike(query.from.toLowerCase())}%`
      out = out.where((eb: any) =>
        eb.or([
          eb(sql`lower(messages.from_address)`, 'like', like),
          eb(sql`lower(coalesce(messages.from_name, ''))`, 'like', like),
        ]),
      )
    }
    if (query.to && query.to.trim()) {
      // to_addresses / cc_addresses は JSON 文字列（[{name,address}]）。アドレスと表示名の部分一致
      const like = `%${escapeLike(query.to.trim().toLowerCase())}%`
      out = out.where((eb: any) =>
        eb.or([
          eb(sql`lower(messages.to_addresses)`, 'like', like),
          eb(sql`lower(messages.cc_addresses)`, 'like', like),
        ]),
      )
    }
    if (query.subject)
      out = out.where(
        sql`lower(messages.subject)`,
        'like',
        `%${escapeLike(query.subject.toLowerCase())}%`,
      )
    if (query.hasAttachments) out = out.where('messages.has_attachments', '=', 1)
    if (query.unseenOnly) out = out.where('messages.seen', '=', 0)
    if (query.forwardState === 'forwarded')
      out = out.where(
        sql<boolean>`exists (select 1 from forwards f where f.message_id = messages.id)` as never,
      )
    if (query.forwardState === 'not_forwarded')
      out = out.where(
        sql<boolean>`not exists (select 1 from forwards f where f.message_id = messages.id)` as never,
      )
    if (query.text && query.text.trim()) {
      const { match, likeTerms } = buildFtsQuery(query.text.trim())
      if (this.driver === 'sqlite' && match) {
        out = out.where(
          'messages.id',
          'in',
          this.db
            .selectFrom('messages_fts')
            .select('message_id')
            .where(sql`messages_fts`, 'match', match),
        )
      } else if (match) {
        for (const term of query.text.trim().split(/\s+/).filter(Boolean))
          out = whereAnyColumnLike(out, term)
      }
      for (const term of likeTerms) out = whereAnyColumnLike(out, term)
    }
    return out
  }

  async search(query: SearchQuery): Promise<{ rows: MessageWithContext[]; total: number }> {
    const apply = <Q extends { where: (...args: any[]) => Q }>(q: Q): Q =>
      this.applyFilters(q, query)

    const countRow = await apply(
      this.db
        .selectFrom('messages')
        .innerJoin('accounts', 'accounts.id', 'messages.account_id')
        .innerJoin('mailboxes', 'mailboxes.id', 'messages.mailbox_id')
        .select(sql<number>`count(*)`.as('c')),
    ).executeTakeFirstOrThrow()
    const total = Number(countRow.c)
    const pageSize = Math.min(500, Math.max(1, query.pageSize || 50))
    const page = Math.max(1, query.page || 1)
    // 並び替え対象カラム（件名など自由文は対象外）。未指定/不正な値は date に落とす。
    const dir = query.sortDir === 'asc' ? 'asc' : 'desc'
    const sortColumn =
      query.sortBy === 'account'
        ? 'accounts.email'
        : query.sortBy === 'mailbox'
          ? 'mailboxes.path'
          : query.sortBy === 'from'
            ? sql`lower(coalesce(messages.from_name, messages.from_address, ''))`
            : 'messages.date'
    const rows = await apply(this.baseQuery())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .orderBy(sortColumn as any, dir)
      .orderBy('messages.remote_uid', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute()
    return { rows, total }
  }

  /** 検索条件に一致するメッセージを、アカウントごとに件数集計して返す（受信メールのアカウント別グループ表示用） */
  async accountGroups(
    query: SearchQuery,
  ): Promise<Array<{ accountId: string; email: string; total: number; unseen: number }>> {
    const rows = await this.applyFilters(
      this.db
        .selectFrom('messages')
        .innerJoin('accounts', 'accounts.id', 'messages.account_id')
        .innerJoin('mailboxes', 'mailboxes.id', 'messages.mailbox_id'),
      query,
    )
      .select([
        'messages.account_id as accountId',
        'accounts.email as email',
        sql<number>`count(*)`.as('total'),
        sql<number>`sum(case when messages.seen = 0 then 1 else 0 end)`.as('unseen'),
      ])
      .groupBy(['messages.account_id', 'accounts.email'])
      .orderBy('accounts.email', 'asc')
      .execute()
    return rows.map((r) => ({
      accountId: String(r.accountId),
      email: String(r.email),
      total: Number(r.total),
      unseen: Number(r.unseen),
    }))
  }
}

function whereAnyColumnLike<Q extends { where: (...args: any[]) => Q }>(q: Q, term: string): Q {
  const like = `%${escapeLike(term.toLowerCase())}%`
  return q.where((eb: any) =>
    eb.or([
      eb(sql`lower(messages.subject)`, 'like', like),
      eb(sql`lower(coalesce(messages.from_address, ''))`, 'like', like),
      eb(sql`lower(coalesce(messages.from_name, ''))`, 'like', like),
      eb(sql`lower(messages.to_addresses)`, 'like', like),
      eb(sql`lower(coalesce(messages.text_body, ''))`, 'like', like),
    ]),
  )
}

/** YYYY-MM-DD をローカル日付として ISO 文字列（UTC）に変換する */
export function localDayStart(day: string, addDays = 0): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + addDays, 0, 0, 0, 0)
  return dt.toISOString()
}
