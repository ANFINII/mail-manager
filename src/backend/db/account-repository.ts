import { sql, type Kysely } from 'kysely'
import type { AccountFilter, AccountListQuery } from '@shared/types'
import type { AccountRow, Database, NewAccountRow } from './schema'

export interface AccountStatusPatch {
  status?: string;
  auth_status?: string;
  last_error?: string | null;
  last_error_at?: string | null;
  last_success_at?: string | null;
  retry_count?: number;
  enabled?: number;
  last_sync_at?: string | null;
  message_count?: number;
}

const ERROR_STATUSES = ['auth_error', 'connection_error', 'error']

export class AccountRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async insertMany(rows: NewAccountRow[]): Promise<number> {
    if (rows.length === 0) return 0
    await this.db.transaction().execute(async (trx) => {
      const chunk = 100
      for (let i = 0; i < rows.length; i += chunk) {
        await trx
          .insertInto('accounts')
          .values(rows.slice(i, i + chunk))
          .execute()
      }
    })
    return rows.length
  }

  async allEmailsLower(): Promise<Set<string>> {
    const rows = await this.db.selectFrom('accounts').select('email').execute()
    return new Set(rows.map((r) => r.email.toLowerCase()))
  }

  /** email（小文字）→ アカウント ID の対応表 */
  async emailIdMap(): Promise<Map<string, string>> {
    const rows = await this.db.selectFrom('accounts').select(['id', 'email']).execute()
    return new Map(rows.map((r) => [r.email.toLowerCase(), r.id]))
  }

  /**
   * 再取り込み（更新）: 認証情報と認証方式（と任意でグループ）を更新し、認証状態を未テストに戻す。
   * 接続設定（imap/smtp/proxy）や受信済みメール・件数は保持する（CSV の空欄補完で上書きしないため）。
   */
  async updateForReimport(
    id: string,
    patch: {
      auth_type: string;
      encrypted_credentials: string;
      /** undefined のときは既存のグループを維持する（null は「グループなし」に更新） */
      group_id?: string | null;
    },
    now: string,
  ): Promise<void> {
    await this.db
      .updateTable('accounts')
      .set({
        ...patch,
        status: 'untested',
        auth_status: 'untested',
        retry_count: 0,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute()
  }

  async list(query: AccountListQuery = {}): Promise<AccountRow[]> {
    let q = this.db.selectFrom('accounts').selectAll()
    q = applyFilter(q, query.filter ?? 'all')
    if (query.groupId === 'none') q = q.where('group_id', 'is', null)
    else if (query.groupId) q = q.where('group_id', '=', query.groupId)
    if (query.search && query.search.trim()) {
      q = q.where('email', 'like', `%${query.search.trim().toLowerCase()}%`)
    }
    return q.orderBy('email').execute()
  }

  async listIdsByGroup(groupId: string): Promise<string[]> {
    const rows = await this.db.selectFrom('accounts').select('id').where('group_id', '=', groupId).execute()
    return rows.map((r) => r.id)
  }

  /** 所属グループを変更する（null で未所属に戻す） */
  async setGroup(ids: string[], groupId: string | null, now: string): Promise<number> {
    if (ids.length === 0) return 0
    let updated = 0
    for (let i = 0; i < ids.length; i += 200) {
      const r = await this.db
        .updateTable('accounts')
        .set({ group_id: groupId, updated_at: now })
        .where('id', 'in', ids.slice(i, i + 200))
        .executeTakeFirst()
      updated += Number(r.numUpdatedRows ?? 0)
    }
    return updated
  }

  async listIds(
    opts: { enabledOnly?: boolean; authenticatedOnly?: boolean } = {},
  ): Promise<string[]> {
    let q = this.db.selectFrom('accounts').select('id')
    if (opts.enabledOnly) q = q.where('enabled', '=', 1)
    // 認証済み = 認証テストまたは同期に成功したアカウント（auth_status = 'ok'）
    if (opts.authenticatedOnly) q = q.where('auth_status', '=', 'ok')
    const rows = await q.orderBy('email').execute()
    return rows.map((r) => r.id)
  }

  async getById(id: string): Promise<AccountRow | undefined> {
    return this.db.selectFrom('accounts').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async getByIds(ids: string[]): Promise<AccountRow[]> {
    if (ids.length === 0) return []
    const out: AccountRow[] = []
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await this.db
        .selectFrom('accounts')
        .selectAll()
        .where('id', 'in', ids.slice(i, i + 200))
        .execute()
      out.push(...rows)
    }
    return out
  }

  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    let deleted = 0
    for (let i = 0; i < ids.length; i += 200) {
      const r = await this.db
        .deleteFrom('accounts')
        .where('id', 'in', ids.slice(i, i + 200))
        .executeTakeFirst()
      deleted += Number(r.numDeletedRows ?? 0)
    }
    return deleted
  }

  async setEnabled(ids: string[], enabled: boolean, now: string): Promise<number> {
    if (ids.length === 0) return 0
    let updated = 0
    for (let i = 0; i < ids.length; i += 200) {
      const r = await this.db
        .updateTable('accounts')
        .set({
          enabled: enabled ? 1 : 0,
          status: enabled ? 'untested' : 'disabled',
          updated_at: now,
        })
        .where('id', 'in', ids.slice(i, i + 200))
        .executeTakeFirst()
      updated += Number(r.numUpdatedRows ?? 0)
    }
    return updated
  }

  async updateStatus(id: string, patch: AccountStatusPatch, now: string): Promise<void> {
    await this.db
      .updateTable('accounts')
      .set({ ...patch, updated_at: now })
      .where('id', '=', id)
      .execute()
  }

  async updateCredentials(
    id: string,
    encryptedCredentials: string,
    now: string,
    authType?: string,
  ): Promise<void> {
    await this.db
      .updateTable('accounts')
      .set({
        encrypted_credentials: encryptedCredentials,
        updated_at: now,
        ...(authType ? { auth_type: authType } : {}),
      })
      .where('id', '=', id)
      .execute()
  }

  async countAll(): Promise<number> {
    const r = await this.db
      .selectFrom('accounts')
      .select(sql<number>`count(*)`.as('c'))
      .executeTakeFirstOrThrow()
    return Number(r.c)
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('accounts')
      .select(['status', sql<number>`count(*)`.as('c')])
      .groupBy('status')
      .execute()
    const out: Record<string, number> = {}
    for (const r of rows) out[r.status] = Number(r.c)
    return out
  }

  async lastSyncAt(): Promise<string | null> {
    const r = await this.db
      .selectFrom('accounts')
      .select(sql<string | null>`max(last_sync_at)`.as('s'))
      .executeTakeFirst()
    return r?.s ?? null
  }

  async lastTestAt(): Promise<string | null> {
    const r = await this.db
      .selectFrom('accounts')
      .select([
        sql<string | null>`max(last_success_at)`.as('s'),
        sql<string | null>`max(last_error_at)`.as('e'),
      ])
      .executeTakeFirst()
    const candidates = [r?.s, r?.e].filter((v): v is string => !!v)
    if (candidates.length === 0) return null
    return candidates.sort().at(-1) ?? null
  }
}

function applyFilter<Q extends { where: (...args: any[]) => Q }>(q: Q, filter: AccountFilter): Q {
  switch (filter) {
    case 'connected':
      return q.where('status', '=', 'connected')
    case 'error':
      return q.where('status', 'in', ERROR_STATUSES)
    case 'auth_error':
      return q.where('status', '=', 'auth_error')
    case 'connection_error':
      return q.where('status', '=', 'connection_error')
    case 'connecting':
      return q.where('status', '=', 'connecting')
    case 'syncing':
      return q.where('status', '=', 'syncing')
    case 'untested':
      return q.where('status', '=', 'untested')
    case 'disabled':
      return q.where('enabled', '=', 0)
    default:
      return q
  }
}
