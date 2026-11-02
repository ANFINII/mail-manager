import { sql, type Kysely } from 'kysely'
import type { Database } from '../../db/schema'

/**
 * API のメッセージ ID（文字列）と、同期処理が前提とする連番 UID の対応表。
 * フォルダごとに 1 から振り、新しく見つかった ID には最大値 + 1 を順に割り当てる（IMAP の UID と同じく増える一方）。
 */
export class UidMapStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * フォルダ内の ID 一覧（古い順）に UID を割り当てて返す。一覧に無くなった ID の対応は消す。
   */
  async assign(email: string, mailbox: string, remoteIds: string[]): Promise<Map<string, number>> {
    const key = email.toLowerCase()
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('api_uid_map')
        .select(['remote_id', 'uid'])
        .where('account_email', '=', key)
        .where('mailbox', '=', mailbox)
        .execute()
      const map = new Map(rows.map((r) => [r.remote_id, Number(r.uid)]))
      let next = rows.reduce((m, r) => Math.max(m, Number(r.uid)), 0) + 1
      const fresh: Array<{ account_email: string; mailbox: string; remote_id: string; uid: number }> = []
      for (const id of remoteIds) {
        if (map.has(id)) continue
        map.set(id, next)
        fresh.push({ account_email: key, mailbox, remote_id: id, uid: next })
        next++
      }
      for (let i = 0; i < fresh.length; i += 200)
        await trx.insertInto('api_uid_map').values(fresh.slice(i, i + 200)).execute()
      const present = new Set(remoteIds)
      const gone = rows.filter((r) => !present.has(r.remote_id)).map((r) => r.remote_id)
      for (let i = 0; i < gone.length; i += 400)
        await trx
          .deleteFrom('api_uid_map')
          .where('account_email', '=', key)
          .where('mailbox', '=', mailbox)
          .where('remote_id', 'in', gone.slice(i, i + 400))
          .execute()
      for (const id of gone) map.delete(id)
      return map
    })
  }

  /** 移動先で新しい ID（または同じ ID）に UID を 1 つ割り当てる */
  async add(email: string, mailbox: string, remoteId: string): Promise<number> {
    const key = email.toLowerCase()
    const existing = await this.db
      .selectFrom('api_uid_map')
      .select('uid')
      .where('account_email', '=', key)
      .where('mailbox', '=', mailbox)
      .where('remote_id', '=', remoteId)
      .executeTakeFirst()
    if (existing) return Number(existing.uid)
    const max = await this.db
      .selectFrom('api_uid_map')
      .select(sql<number>`coalesce(max(uid), 0)`.as('m'))
      .where('account_email', '=', key)
      .where('mailbox', '=', mailbox)
      .executeTakeFirstOrThrow()
    const uid = Number(max.m) + 1
    await this.db.insertInto('api_uid_map').values({ account_email: key, mailbox, remote_id: remoteId, uid }).execute()
    return uid
  }
}
