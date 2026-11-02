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
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
});

const recent = (i: number) => new Date(Date.now() - (10 - i) * 60_000);

async function sync() {
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id);
}

describe('verification codes', () => {
  it('extracts codes and links while syncing and lists the recent ones', async () => {
    imap.addMessage(EMAIL, 'INBOX', {
      ...makeMessageSpec(1, EMAIL, recent(1)),
      subject: 'ログイン認証',
      text: 'あなたの認証コードは 482913 です。',
      html: undefined,
    });
    imap.addMessage(EMAIL, 'INBOX', {
      ...makeMessageSpec(2, EMAIL, recent(2)),
      subject: 'Confirm your email',
      text: 'Click https://app.example/verify?token=abc to confirm.',
      html: undefined,
    });
    imap.addMessage(EMAIL, 'INBOX', { ...makeMessageSpec(3, EMAIL, recent(3)), subject: 'Your order 3 has shipped' });
    // 古いコードメールは既定（24 時間）では出さない
    imap.addMessage(EMAIL, 'INBOX', {
      ...makeMessageSpec(4, EMAIL, new Date(Date.now() - 3 * 86_400_000)),
      subject: 'Old code',
      text: 'Your verification code is 111222',
      html: undefined,
    });
    await sync();

    const list = await t.app.call('codes.list', {});
    expect(list.map((c) => [c.subject, c.code, c.link])).toEqual([
      ['Confirm your email', null, 'https://app.example/verify?token=abc'],
      ['ログイン認証', '482913', null],
    ]);
    expect(list[0]).toMatchObject({ accountEmail: EMAIL });
    expect((await t.app.call('codes.list', { sinceHours: 0 })).map((c) => c.code)).toContain('111222');
    expect(await t.app.call('codes.list', { text: 'confirm' })).toHaveLength(1);

    const msg = (await t.app.call('search.query', { page: 1, pageSize: 50, subject: 'ログイン' })).items[0];
    expect(msg.otpCode).toBe('482913');
  });

  it('backfills messages stored before extraction existed', async () => {
    imap.addMessage(EMAIL, 'INBOX', {
      ...makeMessageSpec(1, EMAIL, recent(1)),
      subject: 'Sign-in code',
      text: 'Use code 905112 to sign in',
      html: undefined,
    });
    await sync();
    // 抽出前の状態に戻す（旧バージョンで取り込んだメールの再現）
    const db = (t.app as unknown as { db: import('kysely').Kysely<import('@backend/db/schema').Database> }).db;
    await db.updateTable('messages').set({ otp_code: null, otp_link: null, otp_scanned: 0 }).execute();
    expect(await t.app.call('codes.list', {})).toHaveLength(0);
    expect(await t.app.codes.backfill()).toBe(1);
    expect((await t.app.call('codes.list', {}))[0].code).toBe('905112');
    expect(await t.app.codes.backfill()).toBe(0);
  });
});
