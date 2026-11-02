import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let imap: FakeImapServer;
let t: TestApp;

beforeEach(async () => {
  imap = new FakeImapServer();
  await imap.start();
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0' } });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
});

function row(email: string, password: string) {
  return {
    email,
    provider: 'custom',
    auth_type: 'password',
    password,
    imap_host: '127.0.0.1',
    imap_port: String(imap.port),
    imap_secure: 'none',
  };
}

describe('account health monitor', () => {
  it('lists accounts with failed auth and counts consecutive failures until a success resets them', async () => {
    imap.setUser('good@example.com', { password: 'pw' });
    imap.setUser('bad@example.com', { password: 'right' });
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv('a.csv', toCsv([row('good@example.com', 'pw'), row('bad@example.com', 'wrong')])),
    });

    for (let i = 0; i < 3; i++) {
      const job = await t.app.call('auth.test', { ids: 'all' });
      await t.waitForJob(job.id);
    }
    const health = await t.app.call('health.list', {});
    expect(health.map((h) => h.email)).toEqual(['bad@example.com']);
    expect(health[0].severity).toBe('critical');
    expect(health[0].issues.map((i) => i.reason)).toEqual(['auth_failed', 'repeated_failures']);
    expect(health[0].issues[1].value).toBe(3);
    expect((await t.app.call('stats.get', {})).needsAttention).toBe(1);

    // 認証情報を直すと成功で連続失敗がリセットされ、一覧から消える
    imap.setUser('bad@example.com', { password: 'wrong' });
    const job = await t.app.call('auth.test', { ids: 'all' });
    await t.waitForJob(job.id);
    const bad = (await t.app.call('accounts.list', {})).find((a) => a.email === 'bad@example.com');
    expect(bad?.consecutiveFailures).toBe(0);
    // 認証済みだがまだ同期していないので info のみ（既定では表示しない）
    expect(await t.app.call('health.list', {})).toEqual([]);
    const withInfo = await t.app.call('health.list', { includeInfo: true });
    expect(withInfo.every((h) => h.severity === 'info')).toBe(true);
  });

  it('lists, and clears, failed forwards', async () => {
    imap.setUser('u@example.com', { password: 'pw' });
    imap.addMessage('u@example.com', 'INBOX', makeMessageSpec(1, 'u@example.com'));
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv('a.csv', toCsv([row('u@example.com', 'pw')])),
    });
    const job = await t.app.call('sync.run', { ids: 'all' });
    await t.waitForJob(job.id);
    const msg = (await t.app.call('search.query', { page: 1, pageSize: 1 })).items[0];
    await t.app.messageRepo.recordForwardFailure(msg.id, 'dest@target.example', 'SMTP 550', new Date().toISOString());

    const list = await t.app.call('forwardFailures.list', { page: 1, pageSize: 50 });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      messageId: msg.id,
      accountEmail: 'u@example.com',
      to: 'dest@target.example',
      attempts: 1,
      lastError: 'SMTP 550',
    });
    const health = await t.app.call('health.list', {});
    expect(health[0].issues).toContainEqual({ reason: 'forward_failures', severity: 'warning', value: 1 });

    expect(
      (await t.app.call('forwardFailures.list', { page: 1, pageSize: 50, to: 'other' })).total,
    ).toBe(0);
    const cleared = await t.app.call('forwardFailures.clear', {
      items: [{ messageId: msg.id, to: 'dest@target.example' }],
    });
    expect(cleared.cleared).toBe(1);
    expect((await t.app.call('forwardFailures.list', { page: 1, pageSize: 50 })).total).toBe(0);
  });
});
