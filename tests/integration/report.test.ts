import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeSmtpServer } from '../helpers/fake-smtp-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';
import { ReportService } from '@backend/report/report-service';

const EMAIL = 'me@example.com';
let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let t: TestApp;
let hook: http.Server;
let hookUrl = '';
let hookBodies: Array<{ event: string; data: Record<string, unknown> }> = [];

beforeEach(async () => {
  hookBodies = [];
  hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      hookBodies.push(JSON.parse(b));
      res.end();
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`;
  imap = new FakeImapServer();
  smtp = new FakeSmtpServer({ passwords: { [EMAIL]: 'pw' } });
  await imap.start();
  await smtp.start();
  imap.setUser(EMAIL, { password: 'pw' });
  imap.setUser('bad@example.com', { password: 'right' });
  for (let i = 1; i <= 3; i++) imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL));
  imap.addMessage(EMAIL, 'INBOX', { ...makeMessageSpec(4, EMAIL), subject: 'Code', text: 'Your verification code is 123456', html: undefined });
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0' } });
  const row = (email: string, password: string) => ({
    email,
    provider: 'custom',
    auth_type: 'password',
    password,
    imap_host: '127.0.0.1',
    imap_port: String(imap.port),
    imap_secure: 'none',
    smtp_host: '127.0.0.1',
    smtp_port: String(smtp.port),
    smtp_secure: 'none',
  });
  await t.app.call('accounts.importCsv', { path: t.writeCsv('a.csv', toCsv([row(EMAIL, 'pw'), row('bad@example.com', 'wrong')])) });
  await t.waitForJob((await t.app.call('auth.test', { ids: 'all' })).id);
  await t.waitForJob((await t.app.call('sync.run', { ids: 'authenticated' })).id);
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await smtp.stop();
  await new Promise<void>((r) => hook.close(() => r()));
});

describe('daily report', () => {
  it('summarises the last 24 hours', async () => {
    const { report, subject, text } = await t.app.call('report.preview', {});
    expect(report).toMatchObject({ newMessages: 4, codes: 1, needsAttentionTotal: 1 });
    expect(report.topAccounts).toEqual([{ email: EMAIL, count: 4 }]);
    expect(report.needsAttention[0]).toMatchObject({ email: 'bad@example.com', severity: 'critical' });
    expect(subject).toContain('新着 4 件 / 要対応 1 件');
    expect(text).toContain('bad@example.com: 認証失敗');
  });

  it('sends by email and webhook, and refuses without a destination', async () => {
    await expect(t.app.call('report.send', {})).rejects.toThrow(/送り先/);
    const me = (await t.app.call('accounts.list', {})).find((a) => a.email === EMAIL)!;
    await t.app.call('settings.update', {
      reportTo: 'boss@example.com',
      reportFromAccountId: me.id,
      reportWebhook: true,
      webhookUrl: hookUrl,
    });
    expect(await t.app.call('report.send', {})).toEqual({ email: true, webhook: true });
    expect(smtp.received.at(-1)?.to).toEqual(['boss@example.com']);
    for (let i = 0; i < 50 && !hookBodies.some((b) => b.event === 'DAILY_REPORT'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(hookBodies.find((b) => b.event === 'DAILY_REPORT')?.data).toMatchObject({ newMessages: 4 });
  });

  it('sends once a day after the configured time', async () => {
    const sent: string[] = [];
    let now = new Date(2026, 10, 2, 8, 59);
    const app = t.app as unknown as Record<string, never>;
    const svc = new ReportService({
      db: app.db,
      settings: () => ({ ...t.app.settings.get(), reportTime: '09:00', reportTo: 'x@example.com', reportFromAccountId: 'a' }),
      settingsRepo: { getAll: async () => store, set: async (k: string, v: string) => void (store[k] = v) } as never,
      stats: t.app.stats,
      health: t.app.health,
      webhook: { send: () => undefined } as never,
      sendMail: async (_a, to) => void sent.push(to),
      logger: t.app.logger,
      now: () => now,
    });
    const store: Record<string, string> = {};
    expect(await svc.tick()).toBe(false); // まだ 9 時前
    now = new Date(2026, 10, 2, 9, 0);
    expect(await svc.tick()).toBe(true);
    now = new Date(2026, 10, 2, 18, 0);
    expect(await svc.tick()).toBe(false); // 同じ日は 1 回だけ
    now = new Date(2026, 10, 3, 9, 30);
    expect(await svc.tick()).toBe(true);
    expect(sent).toEqual(['x@example.com', 'x@example.com']);
  });
});
