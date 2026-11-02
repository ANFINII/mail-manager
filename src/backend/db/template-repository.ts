import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { MailTemplate, MailTemplateInput } from '@shared/types'
import type { Database } from './schema'

/** 返信・新規送信の定型文 */
export class TemplateRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<MailTemplate[]> {
    const rows = await this.db.selectFrom('mail_templates').selectAll().orderBy('name').execute()
    return rows.map((r) => ({ id: r.id, name: r.name, subject: r.subject, body: r.body, updatedAt: r.updated_at }))
  }

  async save(input: MailTemplateInput, now: string): Promise<MailTemplate[]> {
    const name = input.name.trim()
    if (!name) throw new Error('テンプレート名を入力してください')
    const values = { name, subject: input.subject ?? '', body: input.body ?? '', updated_at: now }
    if (input.id) {
      const r = await this.db.updateTable('mail_templates').set(values).where('id', '=', input.id).executeTakeFirst()
      if (Number(r.numUpdatedRows ?? 0) === 0) throw new Error('テンプレートが見つかりません')
    } else {
      await this.db
        .insertInto('mail_templates')
        .values({ id: randomUUID(), created_at: now, ...values })
        .execute()
    }
    return this.list()
  }

  async remove(id: string): Promise<MailTemplate[]> {
    await this.db.deleteFrom('mail_templates').where('id', '=', id).execute()
    return this.list()
  }
}
