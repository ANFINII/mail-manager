import fs from 'node:fs';
import path from 'node:path';
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
  // 2026-01-01 から 1 時間おき（UID 10, 20 は添付つき）
  for (let i = 1; i <= 20; i++) imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL));
  // 最近のメール 2 通
  for (let i = 21; i <= 22; i++)
    imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL, new Date(Date.now() - 3_600_000 * 30)));
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0', MM_STORE_ATTACHMENTS: '1' } });
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
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id);
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
});

describe('storage management', () => {
  it('reports usage', async () => {
    const s = await t.app.call('storage.stats', {});
    expect(s.messages).toBe(22);
    expect(s.attachmentFiles).toBe(2);
    expect(s.attachmentBytes).toBeGreaterThan(0);
    expect(s.dbBytes).toBeGreaterThan(0);
    expect(s.oldestMessageAt?.startsWith('2026-01-01')).toBe(true);
  });

  it('does nothing when retention is unlimited, removes orphan attachment dirs', async () => {
    const orphan = path.join(t.dir, 'attachments', 'no-such-message');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'x.bin'), Buffer.alloc(100));
    const r = await t.app.call('storage.cleanup', {});
    expect(r).toMatchObject({ messagesRemoved: 0, attachmentFilesRemoved: 0, orphanDirsRemoved: 1 });
    expect(r.bytesFreed).toBe(100);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('removes old local copies (not on the server) and old attachment files', async () => {
    await t.app.call('settings.update', { retentionDays: 7 });
    const dry = await t.app.call('storage.cleanup', { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, messagesRemoved: 20 });
    expect((await t.app.call('storage.stats', {})).messages).toBe(22);

    const r = await t.app.call('storage.cleanup', {});
    expect(r.messagesRemoved).toBe(20);
    expect(r.bytesFreed).toBeGreaterThan(0);
    const s = await t.app.call('storage.stats', {});
    expect(s.messages).toBe(2);
    expect(s.attachmentFiles).toBe(0);
    expect((await t.app.call('search.query', { page: 1, pageSize: 50, text: 'urgent' })).total).toBe(0);
    expect((await t.app.call('accounts.list', {}))[0].messageCount).toBe(2);
    // サーバー上は残っている。次回の差分同期でも古いメールは取り直さない
    expect(imap.mailbox(EMAIL, 'INBOX').messages).toHaveLength(22);
    const job = await t.app.call('sync.run', { ids: 'all' });
    await t.waitForJob(job.id);
    expect((await t.app.call('storage.stats', {})).messages).toBe(2);

    const v = await t.app.call('storage.vacuum', {});
    expect(v.after).toBeLessThanOrEqual(v.before!);
  });

  it('drops attachment files past their retention but keeps the metadata', async () => {
    await t.app.call('settings.update', { attachmentRetentionDays: 1 });
    // 添付の取り込み日時は今なので、時計を進めた扱いにするため created_at を古くする
    await t.app.messageRepo['db'].updateTable('attachments').set({ created_at: '2020-01-01T00:00:00Z' }).execute();
    const r = await t.app.call('storage.cleanup', {});
    expect(r.attachmentFilesRemoved).toBe(2);
    const withAtt = (await t.app.call('search.query', { page: 1, pageSize: 50, hasAttachments: true })).items;
    expect(withAtt).toHaveLength(2);
    const detail = await t.app.call('messages.get', { id: withAtt[0].id });
    expect(detail?.attachments[0].storagePath).toBeNull();
    // 必要になったら IMAP から取り直せる
    const dl = await t.app.call('attachments.download', { id: detail!.attachments[0].id });
    expect(fs.existsSync(dl.storagePath!)).toBe(true);
  });
});
