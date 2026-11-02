import type { Kysely } from 'kysely'
import type { Database } from './schema'

export class SettingsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async getAll(): Promise<Record<string, string>> {
    const rows = await this.db.selectFrom('settings').selectAll().execute()
    const out: Record<string, string> = {}
    for (const r of rows) out[r.key] = r.value
    return out
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insertInto('settings')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute()
  }
}
