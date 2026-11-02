import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { AccountGroupsTable, Database } from './schema'

export type AccountGroupRow = AccountGroupsTable;

/** アカウントグループの CRUD。名前は前後空白を除いて一意（大文字小文字は区別しない）。 */
export class AccountGroupRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<AccountGroupRow[]> {
    return this.db.selectFrom('account_groups').selectAll().orderBy('name').execute()
  }

  async getById(id: string): Promise<AccountGroupRow | undefined> {
    return this.db.selectFrom('account_groups').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async getByName(name: string): Promise<AccountGroupRow | undefined> {
    return this.db
      .selectFrom('account_groups')
      .selectAll()
      .where(sql`lower(name)`, '=', name.trim().toLowerCase())
      .executeTakeFirst()
  }

  async create(name: string, now: string): Promise<AccountGroupRow> {
    const id = randomUUID()
    await this.db
      .insertInto('account_groups')
      .values({ id, name: name.trim(), created_at: now, updated_at: now })
      .execute()
    return (await this.getById(id))!
  }

  /** 名前で探し、無ければ作る。CSV 取り込みの group 列で使う。 */
  async ensureByName(name: string, now: string): Promise<AccountGroupRow> {
    const existing = await this.getByName(name)
    return existing ?? this.create(name, now)
  }

  async rename(id: string, name: string, now: string): Promise<number> {
    const r = await this.db
      .updateTable('account_groups')
      .set({ name: name.trim(), updated_at: now })
      .where('id', '=', id)
      .executeTakeFirst()
    return Number(r.numUpdatedRows ?? 0)
  }

  async remove(id: string): Promise<number> {
    const r = await this.db.deleteFrom('account_groups').where('id', '=', id).executeTakeFirst()
    return Number(r.numDeletedRows ?? 0)
  }

  /** グループ ID → 所属アカウント数 */
  async accountCounts(): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('accounts')
      .select(['group_id', sql<number>`count(*)`.as('c')])
      .where('group_id', 'is not', null)
      .groupBy('group_id')
      .execute()
    const out: Record<string, number> = {}
    for (const r of rows) if (r.group_id) out[r.group_id] = Number(r.c)
    return out
  }
}
