import { describe, expect, it } from 'vitest';
import { createDatabase } from '@backend/db/database';
import { AccountRepository } from '@backend/db/account-repository';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('PostgreSQL backend', () => {
  it('runs migrations and basic repository operations', async () => {
    const db = await createDatabase({ driver: 'postgres', connectionString: url! });
    const repo = new AccountRepository(db);
    try {
      const now = new Date().toISOString();
      const email = `pg-${Date.now()}@example.com`;
      await repo.insertMany([
        {
          id: `pg-${Date.now()}`,
          email,
          provider: 'custom',
          auth_type: 'password',
          imap_host: 'h',
          imap_port: 993,
          imap_secure: 'tls',
          smtp_host: null,
          smtp_port: null,
          smtp_secure: null,
          proxy: null,
        group_id: null,
          encrypted_credentials: '{}',
          enabled: 1,
          status: 'untested',
          auth_status: 'untested',
          last_error: null,
          last_error_at: null,
          last_success_at: null,
          last_sync_at: null,
          retry_count: 0,
          message_count: 0,
          created_at: now,
          updated_at: now,
        },
      ]);
      expect((await repo.allEmailsLower()).has(email)).toBe(true);
      const ids = (await repo.list({ search: email })).map((r) => r.id);
      expect(await repo.deleteByIds(ids)).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});
