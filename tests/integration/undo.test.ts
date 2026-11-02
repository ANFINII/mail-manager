import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

const EMAIL = 'u@example.com';
let imap: FakeImapServer;
let t: TestApp;

beforeEach(async () => {
  imap = new FakeImapServer();
  await imap.start();
  imap.setUser(EMAIL, { password: 'pw' });
  for (let i = 1; i <= 6; i++) imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL));
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
});

async function sync() {
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id);
}
const inbox = async () => (await t.app.call('search.query', { page: 1, pageSize: 50, mailboxPath: 'INBOX' })).items;
const serverInbox = () => imap.mailbox(EMAIL, 'INBOX').messages.map((m) => m.spec.subject).sort();
async function until(cond: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timeout');
}

describe('undo', () => {
  it('restores messages deleted to Trash, and they reappear after the automatic sync', async () => {
    const before = serverInbox();
    const ids = (await inbox()).slice(0, 2).map((m) => m.id);
    const job = await t.app.call('messages.delete', { ids });
    await t.waitForJob(job.id);
    expect(imap.mailbox(EMAIL, 'Trash').messages).toHaveLength(2);

    const [op] = await t.app.call('history.list', {});
    expect(op).toMatchObject({ kind: 'delete', source: 'manual', items: 2, undoable: 2, undoneAt: null });
    const r = await t.app.call('history.undo', { id: op.id });
    expect(r).toEqual({ restored: 2, skipped: 0, failed: 0 });
    expect(imap.mailbox(EMAIL, 'Trash').messages).toHaveLength(0);
    expect(serverInbox()).toEqual(before);
    await until(async () => (await inbox()).length === 6);
    expect((await t.app.call('history.list', {}))[0].undoneAt).not.toBeNull();
    await expect(t.app.call('history.undo', { id: op.id })).rejects.toThrow(/すでに/);
  });

  it('undoes a move made by a rule, and read-flag changes back to their previous state', async () => {
    await t.app.call('forwardRules.add', { keyword: 'Weekly', matchField: 'subject', to: 'Archive', enabled: true, action: 'move' });
    await t.app.call('forwardRules.add', { keyword: 'Newsletter', matchField: 'subject', to: '', enabled: true, action: 'flag' });
    await t.app.call('forwardRules.apply', {});
    await until(() => imap.mailbox(EMAIL, 'Archive').messages.length === 1);
    const news = () => imap.mailbox(EMAIL, 'INBOX').messages.find((m) => m.spec.subject.startsWith('Newsletter'))!;
    await until(() => news().flags.has('\\Flagged'));

    const ops = await t.app.call('history.list', {});
    expect(ops.map((o) => [o.kind, o.source])).toEqual(expect.arrayContaining([['move', 'rule'], ['flags', 'rule']]));
    for (const op of ops) await t.app.call('history.undo', { id: op.id });
    expect(imap.mailbox(EMAIL, 'Archive').messages).toHaveLength(0);
    expect(news().flags.has('\\Flagged')).toBe(false);
    // 既読だった Newsletter #4 の既読は残る（スターだけ戻す）
    expect(news().flags.has('\\Seen')).toBe(true);
    const local = (await inbox()).find((m) => m.subject.startsWith('Newsletter'));
    expect(local?.flagged).toBe(false);
  });

  it('marks permanent deletes as not undoable', async () => {
    // ゴミ箱の中のメールを削除すると完全削除
    const id = (await inbox())[0].id;
    await t.waitForJob((await t.app.call('messages.delete', { ids: [id] })).id);
    await sync();
    const trashed = (await t.app.call('search.query', { page: 1, pageSize: 5, mailboxPath: 'Trash' })).items;
    await t.waitForJob((await t.app.call('messages.delete', { ids: [trashed[0].id] })).id);
    const [op] = await t.app.call('history.list', {});
    expect(op).toMatchObject({ kind: 'delete', items: 1, undoable: 0 });
    expect(await t.app.call('history.undo', { id: op.id })).toEqual({ restored: 0, skipped: 1, failed: 0 });
  });
});
