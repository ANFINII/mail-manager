import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

const EMAIL = 'u@example.com';
let imap: FakeImapServer;
let t: TestApp;
let hook: http.Server;
let hookUrl: string;
let hookBodies: Array<{ event: string; data: Record<string, unknown> }>;

beforeEach(async () => {
  hookBodies = [];
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hookBodies.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

  imap = new FakeImapServer();
  await imap.start();
  imap.setUser(EMAIL, { password: 'pw' });
  // 1..7 の件名: 請求書 1 / Re: meeting / Your order 3 / Newsletter #4（既読）/ パスワード / Weekly report 6 / Invoice #7
  for (let i = 1; i <= 7; i++) imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL));
  imap.mailbox(EMAIL, 'Archive');
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0' } });
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv(
      'a.csv',
      toCsv([
        {
          email: EMAIL,
          provider: 'custom',
          auth_type: 'password',
          password: 'pw',
          imap_host: '127.0.0.1',
          imap_port: String(imap.port),
          imap_secure: 'none',
        },
      ]),
    ),
  });
  await sync();
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await new Promise<void>((r) => hook.close(() => r()));
});

async function sync() {
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id);
}
async function settle() {
  // ルールが積んだ IMAP 操作ジョブの完了を待つ
  for (let i = 0; i < 100; i++) {
    const jobs = await t.app.call('jobs.list', {});
    if (!jobs.some((j) => j.status === 'running')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const inbox = async () =>
  (await t.app.call('search.query', { page: 1, pageSize: 50, mailboxPath: 'INBOX' })).items;
const serverMsg = (subject: string) =>
  imap.mailbox(EMAIL, 'INBOX').messages.find((m) => m.spec.subject.includes(subject));

describe('rule actions', () => {
  it('previews a rule without changing anything', async () => {
    const p = await t.app.call('forwardRules.preview', {
      keyword: 'Invoice',
      matchField: 'subject',
      to: '',
      enabled: true,
      action: 'mark_read',
    });
    expect(p.matched).toBe(1);
    expect(p.wouldApply).toBe(1);
    expect(p.samples[0].subject).toContain('Invoice');
    expect((await inbox()).find((m) => m.subject.includes('Invoice'))?.seen).toBe(false);

    const none = await t.app.call('forwardRules.preview', {
      keyword: 'Invoice',
      matchField: 'subject',
      to: '',
      enabled: true,
      action: 'mark_read',
      applyExisting: false,
    });
    expect(none).toMatchObject({ matched: 1, wouldApply: 0 });
  });

  it('marks as read and flags on the server, and does not fight a later manual change', async () => {
    await t.app.call('forwardRules.add', { keyword: 'Invoice', matchField: 'subject', to: '', enabled: true, action: 'mark_read' });
    await t.app.call('forwardRules.add', { keyword: 'Your order', matchField: 'subject', to: '', enabled: true, action: 'flag' });
    const r = await t.app.call('forwardRules.apply', {});
    await settle();
    expect(r.actioned).toBe(2);
    expect(serverMsg('Invoice')!.flags.has('\\Seen')).toBe(true);
    expect(serverMsg('Your order')!.flags.has('\\Flagged')).toBe(true);
    const news = (await inbox()).find((m) => m.subject.includes('Invoice'))!;
    expect(news.seen).toBe(true);

    // ユーザーが未読に戻したら、ルールはもう一度既読にしない
    const job = await t.app.call('messages.setFlags', { ids: [news.id], seen: false });
    await t.waitForJob(job.id);
    expect((await t.app.call('forwardRules.apply', {})).actioned).toBe(0);
    await settle();
    expect(serverMsg('Invoice')!.flags.has('\\Seen')).toBe(false);
  });

  it('moves and deletes on the server', async () => {
    await t.app.call('forwardRules.add', { keyword: 'Weekly', matchField: 'subject', to: 'Archive', enabled: true, action: 'move' });
    await t.app.call('forwardRules.add', { keyword: 'meeting', matchField: 'subject', to: '', enabled: true, action: 'delete' });
    await t.app.call('forwardRules.apply', {});
    await settle();
    expect(imap.mailbox(EMAIL, 'Archive').messages.map((m) => m.spec.subject)).toEqual(['Weekly report 6']);
    expect(imap.mailbox(EMAIL, 'Trash').messages.map((m) => m.spec.subject)).toEqual(['Re: meeting notes']);
    const subjects = (await inbox()).map((m) => m.subject);
    expect(subjects).not.toContain('Weekly report 6');
    expect(subjects).not.toContain('Re: meeting notes');
    expect(subjects).toHaveLength(5);
  });

  it('posts matching messages to a per-rule webhook once', async () => {
    await t.app.call('forwardRules.add', { keyword: 'shipped', matchField: 'subject', to: hookUrl, enabled: true, action: 'webhook' });
    expect((await t.app.call('forwardRules.apply', {})).actioned).toBe(1);
    expect((await t.app.call('forwardRules.apply', {})).actioned).toBe(0);
    for (let i = 0; i < 50 && hookBodies.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(hookBodies).toHaveLength(1);
    expect(hookBodies[0]).toMatchObject({ event: 'RULE_MATCHED', data: { accountEmail: EMAIL, subject: 'Your order 3 has shipped' } });
  });

  it('applies only to mail stored after the rule was created when applyExisting is off', async () => {
    await t.app.call('forwardRules.add', { keyword: 'Newsletter', matchField: 'subject', to: '', enabled: true, action: 'mark_read', applyExisting: false });
    expect((await t.app.call('forwardRules.apply', {})).actioned).toBe(0);
    imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(11, EMAIL)); // Newsletter #11
    await sync(); // 同期完了でルールが自動適用される（非同期）
    for (let i = 0; i < 100 && !serverMsg('Newsletter #11')!.flags.has('\\Seen'); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(serverMsg('Newsletter #11')!.flags.has('\\Seen')).toBe(true);
  });

  it('limits a rule to one group', async () => {
    const groups = await t.app.call('groups.create', { name: 'other' });
    await t.app.call('forwardRules.add', { keyword: 'Newsletter', matchField: 'subject', to: '', enabled: true, action: 'mark_read', groupId: groups[0].id });
    expect((await t.app.call('forwardRules.apply', {})).actioned).toBe(0);
  });

  it('rejects invalid rules', async () => {
    await expect(
      t.app.call('forwardRules.add', { keyword: 'x', matchField: 'subject', to: '', enabled: true, action: 'move' }),
    ).rejects.toThrow(/移動先/);
    await expect(
      t.app.call('forwardRules.add', { keyword: 'x', matchField: 'subject', to: 'nope', enabled: true }),
    ).rejects.toThrow(/転送先/);
  });
});
