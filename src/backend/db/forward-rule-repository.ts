import { randomUUID } from 'node:crypto'
import type { Kysely, Selectable } from 'kysely'
import type { Database, ForwardRulesTable } from './schema'

export type ForwardRuleRow = Selectable<ForwardRulesTable>;

export interface RuleRowInput {
  keyword: string;
  matchField: string;
  /** アクションの引数（転送先・移動先フォルダ・Webhook URL） */
  to: string;
  enabled: boolean;
  action?: string;
  groupId?: string | null;
  applyExisting?: boolean;
}

export class ForwardRuleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<ForwardRuleRow[]> {
    return this.db.selectFrom('forward_rules').selectAll().orderBy('created_at').execute()
  }

  async listEnabled(): Promise<ForwardRuleRow[]> {
    return this.db
      .selectFrom('forward_rules')
      .selectAll()
      .where('enabled', '=', 1)
      .orderBy('created_at')
      .execute()
  }

  async add(input: RuleRowInput, now: string): Promise<ForwardRuleRow> {
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
        action: input.action ?? 'forward',
        group_id: input.groupId ?? null,
        apply_existing: input.applyExisting === false ? 0 : 1,
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

  /** まだこのルールを適用していないメッセージ ID だけを返す */
  async filterNotHit(ruleId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const hit = new Set<string>()
    for (let i = 0; i < ids.length; i += 400) {
      const rows = await this.db
        .selectFrom('rule_hits')
        .select('message_id')
        .where('rule_id', '=', ruleId)
        .where('message_id', 'in', ids.slice(i, i + 400))
        .execute()
      for (const r of rows) hit.add(r.message_id)
    }
    return ids.filter((id) => !hit.has(id))
  }

  async recordHits(ruleId: string, ids: string[], now: string): Promise<void> {
    for (let i = 0; i < ids.length; i += 200) {
      await this.db
        .insertInto('rule_hits')
        .values(ids.slice(i, i + 200).map((message_id) => ({ rule_id: ruleId, message_id, applied_at: now })))
        .onConflict((oc) => oc.columns(['rule_id', 'message_id']).doNothing())
        .execute()
    }
  }
}
