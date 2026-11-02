import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database, MailboxRow } from './schema'

export interface MailboxUpsert {
  path: string;
  name: string;
  delimiter: string | null;
  specialUse: string | null;
}

export interface MailboxSyncPatch {
  uid_validity?: number | null;
  last_sync_uid?: number;
  total_messages?: number;
  last_sync_at?: string | null;
  highest_modseq?: string | null;
}

export class MailboxRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async upsertMany(accountId: string, list: MailboxUpsert[], now: string): Promise<MailboxRow[]> {
    const existing = await this.listByAccount(accountId)
    const byPath = new Map(existing.map((m) => [m.path, m]))
    await this.db.transaction().execute(async (trx) => {
      for (const mb of list) {
        const cur = byPath.get(mb.path)
        if (!cur) {
          await trx
            .insertInto('mailboxes')
            .values({
              id: randomUUID(),
              account_id: accountId,
              path: mb.path,
              name: mb.name,
              delimiter: mb.delimiter,
              special_use: mb.specialUse,
              uid_validity: null,
              last_sync_uid: 0,
              total_messages: 0,
              last_sync_at: null,
              sync_enabled: 1,
              created_at: now,
              updated_at: now,
            })
            .execute()
        } else if (
          cur.name !== mb.name ||
          cur.special_use !== mb.specialUse ||
          cur.delimiter !== mb.delimiter
        ) {
          await trx
            .updateTable('mailboxes')
            .set({
              name: mb.name,
              special_use: mb.specialUse,
              delimiter: mb.delimiter,
              updated_at: now,
            })
            .where('id', '=', cur.id)
            .execute()
        }
      }
    })
    return this.listByAccount(accountId)
  }

  async listByAccount(accountId: string): Promise<MailboxRow[]> {
    return this.db
      .selectFrom('mailboxes')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('path')
      .execute()
  }

  async getById(id: string): Promise<MailboxRow | undefined> {
    return this.db.selectFrom('mailboxes').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async findSent(accountId: string): Promise<MailboxRow | undefined> {
    return this.db
      .selectFrom('mailboxes')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('special_use', '=', '\\Sent')
      .executeTakeFirst()
  }

  async findTrash(accountId: string): Promise<MailboxRow | undefined> {
    return this.db
      .selectFrom('mailboxes')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('special_use', '=', '\\Trash')
      .executeTakeFirst()
  }

  async updateSyncState(id: string, patch: MailboxSyncPatch, now: string): Promise<void> {
    await this.db
      .updateTable('mailboxes')
      .set({ ...patch, updated_at: now })
      .where('id', '=', id)
      .execute()
  }

  async storedCounts(accountId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('messages')
      .select(['mailbox_id', sql<number>`count(*)`.as('c')])
      .where('account_id', '=', accountId)
      .groupBy('mailbox_id')
      .execute()
    const out: Record<string, number> = {}
    for (const r of rows) out[r.mailbox_id] = Number(r.c)
    return out
  }

  async distinctPaths(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('mailboxes')
      .select('path')
      .distinct()
      .orderBy('path')
      .execute()
    return rows.map((r) => r.path)
  }
}
