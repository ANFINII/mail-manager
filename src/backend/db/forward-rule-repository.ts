import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database, ForwardRulesTable } from './schema'

export type ForwardRuleRow = ForwardRulesTable;

export class ForwardRuleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<ForwardRuleRow[]> {
    return this.db.selectFrom('forward_rules').selectAll().orderBy('created_at').execute()
  }

  async listEnabled(): Promise<ForwardRuleRow[]> {
    return this.db.selectFrom('forward_rules').selectAll().where('enabled', '=', 1).execute()
  }

  async add(
    input: { keyword: string; matchField: string; to: string; enabled: boolean },
    now: string,
  ): Promise<ForwardRuleRow> {
    const id = randomUUID()
    await this.db
      .insertInto('forward_rules')
      .values({
        id,
        keyword: input.keyword,
        match_field: input.matchField,
        to_address: input.to,
        enabled: input.enabled ? 1 : 0,
        created_at: now,
      })
      .execute()
    return await this.db
      .selectFrom('forward_rules')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db
      .updateTable('forward_rules')
      .set({ enabled: enabled ? 1 : 0 })
      .where('id', '=', id)
      .execute()
  }

  async remove(id: string): Promise<number> {
    const r = await this.db.deleteFrom('forward_rules').where('id', '=', id).executeTakeFirst()
    return Number(r.numDeletedRows ?? 0)
  }
}
