import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database, ForwardTargetsTable } from './schema'

export type ForwardTargetRow = ForwardTargetsTable;

export class ForwardTargetRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<ForwardTargetRow[]> {
    return this.db.selectFrom('forward_targets').selectAll().orderBy('created_at').execute()
  }

  async add(address: string, label: string | null, now: string): Promise<ForwardTargetRow> {
    const id = randomUUID()
    await this.db
      .insertInto('forward_targets')
      .values({ id, address, label, created_at: now })
      .onConflict((oc) => oc.column('address').doUpdateSet({ label }))
      .execute()
    const row = await this.db
      .selectFrom('forward_targets')
      .selectAll()
      .where('address', '=', address)
      .executeTakeFirst()
    return row!
  }

  async remove(id: string): Promise<number> {
    const r = await this.db.deleteFrom('forward_targets').where('id', '=', id).executeTakeFirst()
    return Number(r.numDeletedRows ?? 0)
  }
}
