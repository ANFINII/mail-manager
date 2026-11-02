import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { generateAccounts, toCsv } from '../helpers/csv-fixtures';
import type { FtsRow, NewMessageRow } from '@backend/db/message-repository';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.cleanup();
});

/** アプリとは別の接続で DB を直接読む（FTS 行数・fts_rowid の検証用） */
function raw<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(t.dbFile);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const ftsCount = () => Number(raw((db) => db.prepare('select count(*) c from messages_fts').get()!.c));
const ftsRowids = () =>
  raw((db) => db.prepare('select id, fts_rowid from messages order by remote_uid').all()) as Array<{
    id: string;
    fts_rowid: number | null;
  }>;

/** IMAP を介さず DB に直接メッセージを流し込む */
async function seed(perAccount: number, accountCount: number) {
  const accounts = generateAccounts({ count: accountCount, imapHost: 'h', imapPort: 993 });
  await t.app.call('accounts.importCsv', { path: t.writeCsv('a.csv', toCsv(accounts)) });
  const rows = await t.app.call('accounts.list', {});
  const now = new Date().toISOString();
  const batch: NewMessageRow[] = [];
  const fts: FtsRow[] = [];
  let uid = 0;
  for (const acc of rows) {
    const [mb] = await t.app.mailboxRepo.upsertMany(
      acc.id,
      [{ path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: null }],
      now,
    );
    for (let i = 1; i <= perAccount; i++) {
      const id = randomUUID();
      const body = `body ${i} of ${acc.email} keyword${i}`;
      batch.push({
        id,
        account_id: acc.id,
        mailbox_id: mb.id,
        remote_uid: ++uid,
        message_id: `<m${uid}@x>`,
        in_reply_to: null,
        from_address: 'a@example.com',
        from_name: null,
        to_addresses: '[]',
        cc_addresses: '[]',
        subject: `subject ${i}`,
        text_body: body,
        html_body: null,
        snippet: body,
        date: now,
        internal_date: now,
        size: 100,
        has_attachments: 0,
        seen: 0,
        flagged: 0,
        answered: 0,
        created_at: now,
        updated_at: now,
      });
      fts.push({
        message_id: id,
        subject: `subject ${i}`,
        from_text: 'a@example.com',
        to_text: '',
        body,
        attachments: '',
      });
    }
  }
  await t.app.messageRepo.insertMany(batch, fts, []);
  return { accounts: rows, ids: batch.map((b) => b.id) };
}

describe('message deletion keeps the FTS index in sync without scanning it', () => {
  it('records the FTS rowid on every inserted message', async () => {
    await seed(5, 2);
    const rows = ftsRowids();
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => typeof r.fts_rowid === 'number')).toBe(true);
    expect(new Set(rows.map((r) => r.fts_rowid)).size).toBe(10);
    expect(ftsCount()).toBe(10);
    // fts_rowid が実際に FTS 行を指している
    const hit = raw((db) =>
      db
        .prepare('select message_id from messages_fts where rowid = ?')
        .get(rows[0].fts_rowid as number),
    ) as { message_id: string };
    expect(hit.message_id).toBe(rows[0].id);
  });

  it('skips FTS/attachment rows for messages dropped as duplicates', async () => {
    const { accounts } = await seed(1, 1);
    const now = new Date().toISOString();
    const [mb] = await t.app.mailboxRepo.listByAccount(accounts[0].id);
    const dupId = randomUUID();
    const dup: NewMessageRow = {
      id: dupId,
      account_id: accounts[0].id,
      mailbox_id: mb.id,
      remote_uid: 1, // 既存と同じ (account, mailbox, uid) → onConflict doNothing
      message_id: '<dup@x>',
      in_reply_to: null,
      from_address: null,
      from_name: null,
      to_addresses: '[]',
      cc_addresses: '[]',
      subject: 'dup',
      text_body: 'dup',
      html_body: null,
      snippet: 'dup',
      date: now,
      internal_date: now,
      size: 1,
      has_attachments: 1,
      seen: 0,
      flagged: 0,
      answered: 0,
      created_at: now,
      updated_at: now,
    };
    await t.app.messageRepo.insertMany(
      [dup],
      [{ message_id: dupId, subject: 'dup', from_text: '', to_text: '', body: 'dup', attachments: '' }],
      [
        {
          id: randomUUID(),
          message_id: dupId,
          filename: 'x.pdf',
          content_type: 'application/pdf',
          size: 1,
          part_id: '2',
          content_id: null,
          storage_path: null,
          created_at: now,
        },
      ],
    );
    expect(ftsCount()).toBe(1);
    expect(Number(raw((db) => db.prepare('select count(*) c from attachments').get()!.c))).toBe(0);
  });

  it('deleteByIds removes the matching FTS rows and nothing else', async () => {
    const { ids } = await seed(10, 1);
    expect(ftsCount()).toBe(10);
    const gone = ids.slice(0, 4);
    expect(await t.app.messageRepo.deleteByIds(gone)).toBe(4);
    expect(ftsCount()).toBe(6);
    const remaining = new Set(ftsRowids().map((r) => r.id));
    for (const id of gone) expect(remaining.has(id)).toBe(false);
    // 残ったメールは引き続き全文検索で見つかる
    const hit = await t.app.call('search.query', { text: 'keyword10', page: 1, pageSize: 10 });
    expect(hit.total).toBe(1);
  });

  it('deleting an account cascades to its messages and FTS rows', async () => {
    const { accounts } = await seed(20, 2);
    expect(ftsCount()).toBe(40);
    const r = await t.app.call('accounts.delete', { ids: [accounts[0].id] });
    expect(r.deleted).toBe(1);
    expect(ftsCount()).toBe(20);
    expect(await t.app.messageRepo.countAll()).toBe(20);
    expect((await t.app.call('search.query', { page: 1, pageSize: 100 })).total).toBe(20);
  });

  it('realignFts repairs missing fts_rowid values and drops orphan FTS rows', async () => {
    const { ids } = await seed(6, 1);
    // 旧バージョン相当の状態を作る: fts_rowid が無く、対応するメールの無い FTS 行がある
    raw((db) => {
      db.exec('update messages set fts_rowid = null');
      db.prepare(
        "insert into messages_fts(message_id, subject, from_text, to_text, body, attachments) values (?, 'orphan', '', '', 'orphan body', '')",
      ).run(randomUUID());
    });
    expect(ftsCount()).toBe(7);
    expect(ftsRowids().every((r) => r.fts_rowid === null)).toBe(true);

    await t.app.messageRepo.realignFts();

    expect(ftsCount()).toBe(6);
    const rows = ftsRowids();
    expect(rows.every((r) => typeof r.fts_rowid === 'number')).toBe(true);
    for (const r of rows) {
      const hit = raw((db) =>
        db.prepare('select message_id from messages_fts where rowid = ?').get(r.fts_rowid as number),
      ) as { message_id: string };
      expect(hit.message_id).toBe(r.id);
    }
    // 修復後はトリガーで消える
    await t.app.messageRepo.deleteByIds(ids.slice(0, 2));
    expect(ftsCount()).toBe(4);
  });

  it('uses a rowid lookup, not a full scan, in the delete trigger', () => {
    const trigger = raw(
      (db) =>
        db.prepare("select sql from sqlite_master where type='trigger' and name='messages_fts_ad'").get() as {
          sql: string;
        },
    );
    expect(trigger.sql).toContain('rowid = old.fts_rowid');
    expect(trigger.sql).not.toContain('message_id = old.id');
  });
});
