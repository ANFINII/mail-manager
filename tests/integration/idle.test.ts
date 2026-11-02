import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let imap: FakeImapServer;
let t: TestApp;

afterEach(async () => {
  await t?.cleanup();
  await imap?.stop();
});

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`condition not met: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup(idle: boolean, accounts = ['a@example.com', 'b@example.com']) {
  imap = new FakeImapServer({ idle });
  await imap.start();
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0', MM_IDLE_BACKOFF_MS: '100' } });
  for (const email of accounts) {
    imap.setUser(email, { password: 'pw' });
    imap.addMessage(email, 'INBOX', makeMessageSpec(1, email));
  }
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv(
      'a.csv',
      toCsv(
        accounts.map((email) => ({
          email,
          provider: 'custom',
          auth_type: 'password',
          password: 'pw',
          imap_host: '127.0.0.1',
          imap_port: String(imap.port),
          imap_secure: 'none',
        })),
      ),
    ),
  });
  const job = await t.app.call('auth.test', { ids: 'all' });
  await t.waitForJob(job.id);
}

const total = async () => (await t.app.call('search.query', { page: 1, pageSize: 1 })).total;

describe('IMAP IDLE push', () => {
  it('watches only while auto sync is on, and syncs an account as soon as new mail arrives', async () => {
    await setup(true);
    const groups = await t.app.call('groups.create', { name: 'push' });
    const ids = (await t.app.call('accounts.list', {})).filter((a) => a.email === 'a@example.com').map((a) => a.id);
    await t.app.call('accounts.setGroup', { ids, groupId: groups[0].id });
    await t.app.call('settings.update', { idleGroupId: groups[0].id });

    // 自動同期 OFF の間は接続しない
    await t.app.idle.refresh();
    await expect(t.app.call('idle.status', {})).resolves.toMatchObject({ watching: 0 });

    await t.app.call('autoSync.set', { enabled: true });
    await until(total, (n) => n === 2); // ON にした時点の一括受信
    const status = await until(
      () => t.app.call('idle.status', {}),
      (s) => s.connected === 1,
    );
    expect(status).toMatchObject({ watching: 1, connected: 1, unsupported: 0 });
    expect(imap.stats.idles).toBeGreaterThanOrEqual(1);

    // グループ内のアカウントは IDLE で即時受信（定期同期は間隔 0 で無効）
    imap.addMessage('a@example.com', 'INBOX', makeMessageSpec(2, 'a@example.com'));
    await until(total, (n) => n === 3, 5_000);
    // グループ外のアカウントは IDLE の対象外
    imap.addMessage('b@example.com', 'INBOX', makeMessageSpec(2, 'b@example.com'));
    await new Promise((r) => setTimeout(r, 1000));
    expect(await total()).toBe(3);

    // 2 通目以降も検知する（IDLE を張り直す）
    imap.addMessage('a@example.com', 'INBOX', makeMessageSpec(3, 'a@example.com'));
    await until(total, (n) => n === 4, 5_000);

    await t.app.call('autoSync.set', { enabled: false });
    expect(await t.app.call('idle.status', {})).toMatchObject({ watching: 0, connected: 0 });
  });

  it('falls back to polling for servers without IDLE', async () => {
    await setup(false, ['a@example.com']);
    await t.app.call('settings.update', { idleGroupId: '*' });
    await t.app.call('autoSync.set', { enabled: true });
    const s = await until(
      () => t.app.call('idle.status', {}),
      (v) => v.unsupported === 1,
    );
    expect(s).toMatchObject({ watching: 1, connected: 0, unsupported: 1 });
  });

  it('caps the number of IDLE connections', async () => {
    await setup(true, ['a@example.com', 'b@example.com', 'c@example.com']);
    await t.app.call('settings.update', { idleGroupId: '*', idleMaxConnections: 2 });
    await t.app.call('autoSync.set', { enabled: true });
    const s = await until(
      () => t.app.call('idle.status', {}),
      (v) => v.connected === 2,
    );
    expect(s.watching).toBe(2);
  });
});
