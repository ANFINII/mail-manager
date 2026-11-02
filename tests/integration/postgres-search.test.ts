import { sql, type Kysely } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { toCsv } from '../helpers/csv-fixtures'
import { FakeImapServer } from '../helpers/fake-imap-server'
import { makeMessageSpec } from '../helpers/mail-fixtures'
import { createTestApp, type TestApp } from '../helpers/test-app'

const url = process.env.DATABASE_URL
let imap: FakeImapServer | undefined
let t: TestApp | undefined

afterEach(async () => {
  if (t) {
    const ids = (await t.app.call('accounts.list', {})).filter((a) => a.email.startsWith('pgsearch-')).map((a) => a.id)
    if (ids.length) await t.app.call('accounts.delete', { ids })
    await t.cleanup()
  }
  await imap?.stop()
})

describe.skipIf(!url)('PostgreSQL search', () => {
  it('finds messages by subject, Japanese body text, short terms and attachment names, using trigram indexes', async () => {
    imap = new FakeImapServer()
    await imap.start()
    t = await createTestApp({
      dbConfig: { driver: 'postgres', connectionString: url! },
      env: { MM_INITIAL_SYNC_MESSAGES: '0' },
    })
    const email = `pgsearch-${Date.now()}@example.com`
    imap.setUser(email, { password: 'pw' })
    for (let i = 1; i <= 20; i++) imap.addMessage(email, 'INBOX', makeMessageSpec(i, email))
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email,
            provider: 'custom',
            auth_type: 'password',
            password: 'pw',
            imap_host: '127.0.0.1',
            imap_port: String(imap.port),
            imap_secure: 'none',
          },
        ]),
      ),
    })
    const job = await t.app.call('sync.run', { ids: 'all' })
    await t.waitForJob(job.id)
    const accountIds = (await t.app.call('accounts.list', { search: email })).map((a) => a.id)
    const q = (text: string) => t!.app.call('search.query', { page: 1, pageSize: 50, accountIds, text })

    expect((await q('Invoice')).total).toBe(2) // 7, 14
    expect((await q('番号12')).total).toBe(1) // 日本語本文の部分一致
    expect((await q('urgent keyword')).total).toBe(4) // 5, 10, 15, 20
    expect((await q('report-10.pdf')).total).toBe(1) // 添付ファイル名
    expect((await q('請求')).total).toBeGreaterThan(0) // 2 文字（trigram 未満）

    const db = (t.app as unknown as { db: Kysely<unknown> }).db
    const idx = await sql<{ indexname: string }>`select indexname from pg_indexes where indexname like '%trgm%'`.execute(db)
    expect(idx.rows.map((r) => r.indexname)).toContain('idx_messages_body_trgm')
  })
})
