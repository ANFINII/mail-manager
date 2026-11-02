import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Selectable } from 'kysely'
import type { Database, MailOpItemsTable } from './schema'

export type MailOpItemRow = Selectable<MailOpItemsTable>

/** 履歴は 30 日で消す */
const KEEP_DAYS = 30

export interface OpOrigin {
  source: 'manual' | 'rule';
  ruleId?: string | null;
  label?: string | null;
}

/** 一括操作の履歴（取り消し用） */
export class HistoryRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(kind: string, origin: OpOrigin, now: string): Promise<string> {
    const id = randomUUID()
    await this.db
      .insertInto('mail_ops')
      .values({
        id,
        kind,
        source: origin.source,
        rule_id: origin.ruleId ?? null,
        label: origin.label ?? null,
        created_at: now,
        undone_at: null,
      })
      .execute()
    // 古い履歴を片付ける（明細は外部キーで消える）
    const cutoff = new Date(Date.parse(now) - KEEP_DAYS * 86_400_000).toISOString()
    await this.db.deleteFrom('mail_ops').where('created_at', '<', cutoff).execute()
    return id
  }

  async addItems(items: MailOpItemRow[]): Promise<void> {
    for (let i = 0; i < items.length; i += 200)
      await this.db.insertInto('mail_op_items').values(items.slice(i, i + 200)).execute()
  }

  async list(limit = 100): Promise<
    Array<{
      id: string;
      kind: string;
      source: string;
      rule_id: string | null;
      label: string | null;
      created_at: string;
      undone_at: string | null;
      items: number;
      undoable: number;
    }>
  > {
    const rows = await this.db
      .selectFrom('mail_ops')
      .leftJoin('mail_op_items', 'mail_op_items.op_id', 'mail_ops.id')
      .select([
        'mail_ops.id as id',
        'mail_ops.kind as kind',
        'mail_ops.source as source',
        'mail_ops.rule_id as rule_id',
        'mail_ops.label as label',
        'mail_ops.created_at as created_at',
        'mail_ops.undone_at as undone_at',
        sql<number>`count(mail_op_items.op_id)`.as('items'),
        sql<number>`sum(case when mail_op_items.dest_uid is not null or mail_op_items.prev_seen is not null or mail_op_items.prev_flagged is not null then 1 else 0 end)`.as(
          'undoable',
        ),
      ])
      .groupBy([
        'mail_ops.id',
        'mail_ops.kind',
        'mail_ops.source',
        'mail_ops.rule_id',
        'mail_ops.label',
        'mail_ops.created_at',
        'mail_ops.undone_at',
      ])
      .orderBy('mail_ops.created_at', 'desc')
      .limit(limit)
      .execute()
    return rows.map((r) => ({ ...r, items: Number(r.items), undoable: Number(r.undoable ?? 0) }))
  }

  async get(id: string) {
    return this.db.selectFrom('mail_ops').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async items(opId: string): Promise<MailOpItemRow[]> {
    return this.db.selectFrom('mail_op_items').selectAll().where('op_id', '=', opId).execute()
  }

  async markUndone(id: string, now: string): Promise<void> {
    await this.db.updateTable('mail_ops').set({ undone_at: now }).where('id', '=', id).execute()
  }
}
