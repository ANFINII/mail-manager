import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeSmtpServer } from '../helpers/fake-smtp-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let t: TestApp;
const EMAIL = 'sender@example.com';
const DEST = 'dest@target.example';

beforeEach(async () => {
  imap = new FakeImapServer();
  smtp = new FakeSmtpServer({ passwords: { [EMAIL]: 'pw' } });
  await imap.start();
  await smtp.start();
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0' } });
  imap.setUser(EMAIL, { password: 'pw' });
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv('a.csv', toCsv([
      {
        email: EMAIL,
        provider: 'custom',
        auth_type: 'password',
        password: 'pw',
        imap_host: '127.0.0.1',
        imap_port: String(imap.port),
        imap_secure: 'none',
        smtp_host: '127.0.0.1',
        smtp_port: String(smtp.port),
        smtp_secure: 'none',
      },
    ])),
  });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await smtp.stop();
});

async function sync() {
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id, 60_000);
}
async function inboxIds() {
  return (await t.app.call('search.query', { mailboxPath: 'INBOX', page: 1, pageSize: 100 })).items.map((m) => m.id);
}
async function forwardAll(to = DEST) {
  const res = await t.app.call('messages.forward', { ids: await inboxIds(), to });
  if (res.queued > 0) await t.waitForJob(res.job.id, 30_000);
  return res;
}
function raw(sqlText: string): unknown {
  const db = new DatabaseSync(t.dbFile);
  try {
    return db.prepare(sqlText).all();
  } finally {
    db.close();
  }
}

describe('forward de-duplication survives re-sync and re-import', () => {
  it('does not forward again after UIDVALIDITY changes and messages get new local ids', async () => {
    for (let i = 1; i <= 3; i++) imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL));
    await sync();
    const first = await forwardAll();
    expect(first).toMatchObject({ queued: 3, skipped: 0 });
    expect(smtp.received).toHaveLength(3);
    expect((raw('select count(*) c from forward_log') as Array<{ c: number }>)[0].c).toBe(3);

    // サーバー側で UID が振り直される → ローカルの行は消えて作り直される（forwards 行も消える）
    const before = await inboxIds();
    imap.bumpUidValidity(EMAIL);
    await sync();
    const after = await inboxIds();
    expect(after).toHaveLength(3);
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect((raw('select count(*) c from forwards') as Array<{ c: number }>)[0].c).toBe(0);

    const second = await forwardAll();
    expect(second).toMatchObject({ queued: 0, skipped: 3 });
    expect(smtp.received).toHaveLength(3);
    // 新しい行にも転送済みが付く（UI の転送済み表示・次回の高速な除外のため）
    expect((raw('select count(*) c from forwards') as Array<{ c: number }>)[0].c).toBe(3);
    const items = (await t.app.call('search.query', { mailboxPath: 'INBOX', page: 1, pageSize: 10 })).items;
    expect(items.every((m) => m.forwarded)).toBe(true);
  }, 60_000);

  it('treats the destination case-insensitively', async () => {
    imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(1, EMAIL));
    await sync();
    expect(await forwardAll('Dest@Target.example')).toMatchObject({ queued: 1 });
    expect(await forwardAll('dest@target.example')).toMatchObject({ queued: 0, skipped: 1 });
    expect(smtp.received).toHaveLength(1);
  }, 60_000);

  it('recognises a forwarded copy in the Sent folder even when the local history is gone', async () => {
    for (let i = 1; i <= 2; i++) imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL));
    await sync();
    const originals = (await t.app.call('search.query', { mailboxPath: 'INBOX', page: 1, pageSize: 10 })).items;
    const first = await forwardAll();
    expect(first.queued).toBe(2);
    // 転送した本文には Date / Message-ID のマーカーが入っている
    expect(smtp.received[0].data).toContain('Message-ID: <');
    expect(smtp.received[0].data).toMatch(/Date: \d{4}-/);

    // 1 通目の控えだけが Sent フォルダにある状態を作る（Graph/SMTP の送信控えが同期された想定）
    const orig = originals.find((m) => m.subject === originals[0].subject)!;
    const text = `body\n\n---------- 転送メッセージ ----------\nFrom: x\nDate: ${orig.date}\nSubject: ${orig.subject}\nTo: ${EMAIL}\nMessage-ID: ${orig.messageId}\n\n`;
    imap.addMessage(EMAIL, 'Sent', {
      ...makeMessageSpec(50, DEST),
      from: { address: EMAIL },
      to: [{ address: DEST }],
      subject: `Fwd: ${orig.subject}`,
      text,
      date: new Date(Date.now() + 1000),
    });
    // ローカルの転送履歴を全て失う（アカウント再取り込み相当）
    const db = new DatabaseSync(t.dbFile);
    db.exec('delete from forwards; delete from forward_log;');
    db.close();
    imap.bumpUidValidity(EMAIL);
    await sync();

    const second = await forwardAll();
    // 控えのある 1 通はスキップ、控えの無い 1 通だけ再送される
    expect(second).toMatchObject({ queued: 1, skipped: 1 });
    expect(smtp.received).toHaveLength(3);
    const resent = smtp.received[2];
    expect(resent.data).not.toContain(`Subject: Fwd: ${orig.subject}\r`);
    expect((raw('select count(*) c from forward_log') as Array<{ c: number }>)[0].c).toBe(2);
  }, 60_000);
});

describe('auto-forward never loops on its own Sent copies', () => {
  it('rules and forward-all skip Sent/Drafts copies and self-sent mail, even when the keyword matches', async () => {
    const subject = '認証コードのお知らせ【123456】';
    imap.addMessage(EMAIL, 'INBOX', { ...makeMessageSpec(1, EMAIL), subject });
    // 自分の転送控えが送信済みフォルダにある（前回の転送で作られた想定。件名にキーワードを含む）
    imap.addMessage(EMAIL, 'Sent', {
      ...makeMessageSpec(2, DEST),
      from: { address: EMAIL },
      to: [{ address: DEST }],
      subject: `Fwd: ${subject}`,
      text: 'copy',
    });
    imap.addMessage(EMAIL, 'Drafts', {
      ...makeMessageSpec(3, DEST),
      from: { address: EMAIL },
      to: [{ address: DEST }],
      subject: `Fwd: ${subject}`,
      text: 'draft',
    });
    await sync();
    expect((await t.app.call('search.query', { subject: '認証コード', page: 1, pageSize: 10 })).total).toBe(3);

    await t.app.call('forwardRules.add', { keyword: '認証コードのお知らせ', matchField: 'subject', to: DEST, enabled: true });
    const first = await t.app.call('forwardRules.apply', {});
    expect(first).toMatchObject({ rules: 1, forwarded: 1 });
    const jobs = await t.app.call('jobs.list', {});
    await t.waitForJob(jobs.find((j) => j.type === 'mail_op')!.id, 30_000);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0].to).toContain(DEST); // 件名は MIME エンコードされるので宛先で確認

    // 転送した控えが Sent に同期されても、次のルール適用で再転送されない（ループしない）
    imap.addMessage(EMAIL, 'Sent', {
      ...makeMessageSpec(4, DEST),
      from: { address: EMAIL },
      to: [{ address: DEST }],
      subject: `Fwd: ${subject}`,
      text: smtp.received[0].data,
    });
    await sync();
    const second = await t.app.call('forwardRules.apply', {});
    expect(second).toMatchObject({ forwarded: 0 });
    // 全件転送（フォルダ指定なし）でも Sent/Drafts の控えは送らない
    const all = await t.app.call('messages.forwardAll', { query: { page: 1, pageSize: 50 }, to: DEST });
    expect(all.queued).toBe(0);
    expect(smtp.received).toHaveLength(1);
  }, 60_000);
});

describe('cleaning up duplicated Sent copies', () => {
  it('counts and deletes duplicated forward copies, keeping the oldest per account/subject/recipient', async () => {
    const base = new Date('2026-02-01T00:00:00Z');
    const copy = (i: number, subject: string, to: string, from = EMAIL) => ({
      ...makeMessageSpec(i, to),
      from: { address: from },
      to: [{ address: to }],
      subject,
      text: `copy ${i}`,
      date: new Date(base.getTime() + i * 60_000),
    });
    // 同じ件名・宛先の控えが 3 通（重複 2）、別宛先 1 通、別件名 1 通、Fwd: でない送信 1 通、受信トレイの Fwd: 1 通
    imap.addMessage(EMAIL, 'Sent', copy(1, 'Fwd: 認証コード【1】', DEST));
    imap.addMessage(EMAIL, 'Sent', copy(2, 'Fwd: 認証コード【1】', DEST));
    imap.addMessage(EMAIL, 'Sent', copy(3, 'Fwd: 認証コード【1】', DEST));
    imap.addMessage(EMAIL, 'Sent', copy(4, 'Fwd: 認証コード【1】', 'other@target.example'));
    imap.addMessage(EMAIL, 'Sent', copy(5, 'Fwd: 認証コード【2】', DEST));
    imap.addMessage(EMAIL, 'Sent', copy(6, 'Normal mail', DEST));
    imap.addMessage(EMAIL, 'INBOX', copy(7, 'Fwd: 認証コード【1】', EMAIL, 'someone@example.com'));
    await sync();
    expect((await t.app.call('search.query', { page: 1, pageSize: 50 })).total).toBe(7);

    const stats = await t.app.call('sent.duplicateCopies', {});
    expect(stats).toMatchObject({ groups: 1, extra: 2, accounts: 1 });
    expect(stats.sampleSubjects).toEqual(['Fwd: 認証コード【1】']);
    // 別アカウント指定なら 0
    expect(await t.app.call('sent.duplicateCopies', { accountIds: ['no-such'] })).toMatchObject({ extra: 0 });

    const r = await t.app.call('sent.deleteDuplicateCopies', {});
    expect(r.count).toBe(2);
    await t.waitForJob(r.job!.id, 30_000);
    const sent = imap.mailbox(EMAIL, 'Sent').messages;
    expect(sent).toHaveLength(4);
    // 残った控えは最古の 1 通（copy 1）
    expect(sent.filter((m) => m.spec.subject === 'Fwd: 認証コード【1】' && m.spec.to[0].address === DEST)).toHaveLength(1);
    expect(sent.find((m) => m.spec.subject === 'Fwd: 認証コード【1】' && m.spec.to[0].address === DEST)!.spec.text).toBe('copy 1');
    expect(imap.mailbox(EMAIL, 'Trash').messages).toHaveLength(2);
    expect((await t.app.call('search.query', { mailboxSpecialUse: '\\Sent', page: 1, pageSize: 50 })).total).toBe(4);
    // 2 回目は何も無い
    expect(await t.app.call('sent.deleteDuplicateCopies', {})).toEqual({ job: null, count: 0 });
  }, 60_000);
});
