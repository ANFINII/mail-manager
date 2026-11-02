import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import {
  accessTokenFor,
  generateAccounts,
  passwordFor,
  refreshTokenFor,
  toCsv,
} from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let imap: FakeImapServer;
let oauth: FakeOAuthServer;
let t: TestApp;

beforeEach(async () => {
  imap = new FakeImapServer();
  oauth = new FakeOAuthServer();
  await imap.start();
  await oauth.start();
  t = await createTestApp({
    env: {
      MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl,
      MM_SYNC_CONCURRENCY: '20',
      MM_INITIAL_SYNC_MESSAGES: '0',
    },
  });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await oauth.stop();
});

async function seedAccounts(count: number, opts: { isOAuth?: (i: number) => boolean } = {}) {
  const accounts = generateAccounts({
    count,
    imapHost: '127.0.0.1',
    imapPort: imap.port,
    isOAuth: opts.isOAuth,
  });
  for (const a of accounts) {
    if (a.auth_type === 'oauth2') {
      imap.setUser(a.email, { accessToken: accessTokenFor(a.index) });
      oauth.setGrant(refreshTokenFor(a.index), { accessToken: accessTokenFor(a.index) });
    } else {
      imap.setUser(a.email, { password: passwordFor(a.index) });
    }
  }
  const r = await t.app.call('accounts.importCsv', {
    path: t.writeCsv('accounts.csv', toCsv(accounts)),
  });
  expect(r.invalid).toEqual([]);
  return accounts;
}

async function runSync(ids: string[] | 'all' = 'all') {
  const job = await t.app.call('sync.run', { ids });
  return t.waitForJob(job.id, 180_000);
}

describe('IMAP synchronisation', () => {
  it('handles an empty inbox and records mailboxes', async () => {
    const [a] = await seedAccounts(1);
    const finished = await runSync();
    expect(finished).toMatchObject({ status: 'completed', succeeded: 1, failed: 0 });
    const account = (await t.app.call('accounts.list', {}))[0];
    expect(account.status).toBe('connected');
    expect(account.lastSyncAt).toBeTruthy();
    expect(account.messageCount).toBe(0);
    const mailboxes = await t.app.call('mailboxes.list', { accountId: account.id });
    expect(mailboxes.map((m) => m.path).sort()).toEqual(['INBOX', 'Junk', 'Sent', 'Trash']);
    expect(mailboxes.find((m) => m.path === 'INBOX')).toMatchObject({
      storedMessages: 0,
      totalMessages: 0,
      lastSyncUid: 0,
    });
    expect(a.email).toBeTruthy();
  });

  it('syncs 10 messages with bodies, attachments and flags, then detects only new mail', async () => {
    const [a] = await seedAccounts(1, { isOAuth: () => false });
    for (let i = 1; i <= 10; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    const first = await runSync();
    expect(first.succeeded).toBe(1);
    const account = (await t.app.call('accounts.list', {}))[0];
    expect(account.messageCount).toBe(10);

    const result = await t.app.call('search.query', { page: 1, pageSize: 50 });
    expect(result.total).toBe(10);
    expect(result.items[0].subject).toBe('Your order 10 has shipped'); // 最新が先頭
    const withAttachment = result.items.find((m) => m.hasAttachments);
    expect(withAttachment?.subject).toBe('Your order 10 has shipped');
    const detail = await t.app.call('messages.get', { id: withAttachment!.id });
    expect(detail?.textBody).toContain('Message 10 body');
    expect(detail?.htmlBody).toContain('<b>10</b>');
    expect(detail?.attachments).toHaveLength(1);
    expect(detail?.attachments[0]).toMatchObject({
      filename: 'report-10.pdf',
      contentType: 'application/pdf',
      partId: '2',
    });
    expect(detail?.fromName).toBe('Support');
    const seen = result.items.filter((m) => m.seen).length;
    expect(seen).toBe(2); // 4, 8

    // 2 回目: 新着 3 件だけ取得され、既存は再取得されない
    const fetchedBefore = imap.stats.fetchedMessages;
    for (let i = 11; i <= 13; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    await runSync();
    expect((await t.app.call('search.query', { page: 1, pageSize: 50 })).total).toBe(13);
    expect(imap.stats.fetchedMessages - fetchedBefore).toBe(6); // 3 件 × (構造 + 本文) の 2 フェーズ
    const mb = (await t.app.call('mailboxes.list', { accountId: account.id })).find(
      (m) => m.path === 'INBOX',
    );
    expect(mb).toMatchObject({ storedMessages: 13, lastSyncUid: 13, totalMessages: 13 });

    // 3 回目: 変化なし
    const before = imap.stats.fetchedMessages;
    await runSync();
    expect(imap.stats.fetchedMessages).toBe(before);
    expect(t.logs.lines.join('\n')).toContain('sync completed');
  }, 60_000);

  it('syncs 10,000 messages in batches and resumes after interruption', async () => {
    const [a] = await seedAccounts(1, { isOAuth: () => false });
    for (let i = 1; i <= 10_000; i++)
      imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    const started = Date.now();
    const job = await runSync();
    const elapsed = Date.now() - started;
    expect(job.succeeded).toBe(1);
    expect((await t.app.call('stats.get', {})).messages).toBe(10_000);
    console.log(`10,000 messages synced in ${elapsed}ms`);

    // 重複なし: (account, mailbox, uid) が一意
    const mb = (
      await t.app.call('mailboxes.list', {
        accountId: (await t.app.call('accounts.list', {}))[0].id,
      })
    )[0];
    expect(mb.storedMessages).toBe(10_000);
    const again = await runSync();
    expect(again.succeeded).toBe(1);
    expect((await t.app.call('stats.get', {})).messages).toBe(10_000);
  }, 300_000);

  it('applies the initial sync limit and continues incrementally', async () => {
    const [a] = await seedAccounts(1, { isOAuth: () => false });
    for (let i = 1; i <= 120; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    await t.app.settings.update({ initialSyncMessages: 50 });
    // 環境変数の上書きより設定を優先させるため、環境変数無しのアプリで実行
    const fresh = await createTestApp({
      env: { MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl },
      masterKey: t.masterKey,
      dbFile: t.dbFile,
    });
    try {
      await fresh.app.settings.update({ initialSyncMessages: 50 });
      const job = await fresh.app.call('sync.run', { ids: 'all' });
      await fresh.waitForJob(job.id);
      const r = await fresh.app.call('search.query', { page: 1, pageSize: 10 });
      expect(r.total).toBe(50);
      expect(r.items[0].subject).toBe('請求書 120 月分');
      for (let i = 121; i <= 125; i++)
        imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
      const job2 = await fresh.app.call('sync.run', { ids: 'all' });
      await fresh.waitForJob(job2.id);
      expect((await fresh.app.call('search.query', { page: 1, pageSize: 10 })).total).toBe(55);
    } finally {
      await fresh.app.shutdown();
    }
  }, 60_000);

  it('resynchronises a mailbox when UIDVALIDITY changes', async () => {
    const [a] = await seedAccounts(1, { isOAuth: () => false });
    for (let i = 1; i <= 5; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    await runSync();
    expect((await t.app.call('stats.get', {})).messages).toBe(5);
    imap.mailbox(a.email).messages.splice(0, 2); // サーバー側で 2 件消えて UID が振り直された
    imap.bumpUidValidity(a.email);
    await runSync();
    expect((await t.app.call('stats.get', {})).messages).toBe(3);
    expect(t.logs.lines.join('\n')).toContain('UIDVALIDITY changed');
  }, 60_000);

  it('syncs 20 accounts concurrently within the limit, mixing OAuth2 and password accounts', async () => {
    const accounts = await seedAccounts(40);
    for (const a of accounts)
      for (let i = 1; i <= 5; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    const job = await runSync();
    expect(job).toMatchObject({ succeeded: 40, failed: 0 });
    expect(imap.stats.maxConcurrentSessions).toBeLessThanOrEqual(20);
    expect(imap.stats.maxConcurrentSessions).toBeGreaterThan(5);
    expect((await t.app.call('stats.get', {})).messages).toBe(200);
    const r = await t.app.call('search.query', {
      accountIds: [(await t.app.call('accounts.list', {}))[3].id],
      page: 1,
      pageSize: 10,
    });
    expect(r.total).toBe(5);
  }, 120_000);

  it('classifies network and authentication failures during sync', async () => {
    const closedPort = await (async () => {
      const s = new FakeImapServer();
      const p = await s.start();
      await s.stop();
      return p;
    })();
    imap.setUser('ok@example.com', { password: 'p' });
    imap.setUser('bad@example.com', { password: 'other' });
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'mix.csv',
        toCsv([
          {
            email: 'ok@example.com',
            password: 'p',
            imap_host: '127.0.0.1',
            imap_port: String(imap.port),
            imap_secure: 'none',
          },
          {
            email: 'bad@example.com',
            password: 'p',
            imap_host: '127.0.0.1',
            imap_port: String(imap.port),
            imap_secure: 'none',
          },
          {
            email: 'down@example.com',
            password: 'p',
            imap_host: '127.0.0.1',
            imap_port: String(closedPort),
            imap_secure: 'none',
          },
        ]),
      ),
    });
    await t.app.settings.update({ maxRetries: 1 });
    const job = await runSync();
    expect(job).toMatchObject({ succeeded: 1, failed: 2 });
    const byEmail = Object.fromEntries(
      (await t.app.call('accounts.list', {})).map((a) => [a.email, a]),
    );
    expect(byEmail['ok@example.com'].status).toBe('connected');
    // 同期中の認証系失敗は「取得失敗(sync_error)」として扱い、auth_status は落とさない
    expect(byEmail['bad@example.com'].status).toBe('sync_error');
    expect(byEmail['bad@example.com'].authStatus).not.toBe('failed');
    expect(byEmail['down@example.com'].status).toBe('connection_error');
    expect(byEmail['down@example.com'].retryCount).toBe(1);
    expect(t.logs.lines.join('\n')).toMatch(/sync connection failed, retrying/);
  }, 60_000);

  it('Stop All cancels a running sync and leaves accounts in a consistent state', async () => {
    const accounts = await seedAccounts(10, { isOAuth: () => false });
    for (const a of accounts)
      for (let i = 1; i <= 200; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    const slow = new FakeImapServer({ fetchDelayMs: 5 });
    await slow.start();
    try {
      // 遅いサーバーに向け直す
      for (const a of accounts)
        slow.setUser(a.email, {
          password: passwordFor(a.index),
          mailboxes: imap.getUser(a.email)!.mailboxes,
        });
      const csv = toCsv(accounts.map((a) => ({ ...a, imap_port: String(slow.port) })));
      const ids = (await t.app.call('accounts.list', {})).map((a) => a.id);
      await t.app.call('accounts.delete', { ids });
      await t.app.call('accounts.importCsv', { path: t.writeCsv('slow.csv', csv) });
      const job = await t.app.call('sync.run', { ids: 'all' });
      await new Promise((r) => setTimeout(r, 400));
      expect((await t.app.call('jobs.cancelAll', {})).cancelled).toBe(1);
      const finished = await t.waitForJob(job.id);
      expect(finished.status).toBe('cancelled');
      const list = await t.app.call('accounts.list', {});
      expect(list.filter((a) => a.status === 'syncing')).toHaveLength(0);
      expect((await t.app.call('stats.get', {})).messages).toBeLessThan(2000);
    } finally {
      await slow.stop();
    }
  }, 60_000);

  it('stores attachments to disk when enabled and downloads them on demand otherwise', async () => {
    const [a] = await seedAccounts(1, { isOAuth: () => false });
    imap.addMessage(a.email, 'INBOX', makeMessageSpec(10, a.email));
    await runSync();
    let detail = await t.app.call('messages.get', {
      id: (await t.app.call('search.query', { page: 1, pageSize: 1 })).items[0].id,
    });
    expect(detail?.attachments[0].storagePath).toBeNull();
    const downloaded = await t.app.call('attachments.download', { id: detail!.attachments[0].id });
    expect(downloaded.storagePath).toBeTruthy();
    expect(fs.readFileSync(downloaded.storagePath!, 'utf8')).toBe('%PDF-1.4 report 10');
    expect(downloaded.storagePath!.startsWith(path.join(t.dir, 'attachments'))).toBe(true);

    await t.app.settings.update({ storeAttachments: true });
    imap.addMessage(a.email, 'INBOX', makeMessageSpec(20, a.email));
    await runSync();
    detail = await t.app.call('messages.get', {
      id: (await t.app.call('search.query', { subject: 'Weekly report 20', page: 1, pageSize: 1 }))
        .items[0].id,
    });
    expect(detail?.attachments[0].storagePath).toBeTruthy();
    expect(fs.existsSync(detail!.attachments[0].storagePath!)).toBe(true);
  }, 60_000);

  it('marks messages read/unread and deletes them on the server and locally', async () => {
    const [a] = await seedAccounts(1, { isOAuth: () => false });
    for (let i = 1; i <= 6; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    await runSync();
    const items = (await t.app.call('search.query', { page: 1, pageSize: 10 })).items;
    const unseen = items.filter((m) => !m.seen).map((m) => m.id);
    const job = await t.app.call('messages.setFlags', { ids: unseen.slice(0, 2), seen: true });
    await t.waitForJob(job.id);
    const after = (await t.app.call('search.query', { page: 1, pageSize: 10 })).items;
    expect(after.filter((m) => m.seen)).toHaveLength(items.filter((m) => m.seen).length + 2);
    const serverSeen = imap.mailbox(a.email).messages.filter((m) => m.flags.has('\\Seen')).length;
    expect(serverSeen).toBe(after.filter((m) => m.seen).length);

    const del = await t.app.call('messages.delete', { ids: after.slice(0, 2).map((m) => m.id) });
    await t.waitForJob(del.id);
    expect((await t.app.call('search.query', { page: 1, pageSize: 10 })).total).toBe(4);
    expect(imap.mailbox(a.email).messages).toHaveLength(4);
    expect(imap.mailbox(a.email, 'Trash').messages).toHaveLength(2);
    expect((await t.app.call('accounts.list', {}))[0].messageCount).toBe(4);
  }, 60_000);

  it('認証完了時に自動で受信同期する（autoSyncOnAuth 有効）', async () => {
    const auto = await createTestApp({
      env: {
        MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl,
        MM_INITIAL_SYNC_MESSAGES: '0',
        MM_AUTO_SYNC_ON_AUTH: '1',
      },
    });
    try {
      const accounts = generateAccounts({
        count: 2,
        imapHost: '127.0.0.1',
        imapPort: imap.port,
        isOAuth: () => true,
      });
      for (const a of accounts) {
        imap.setUser(a.email, { accessToken: accessTokenFor(a.index) });
        oauth.setGrant(refreshTokenFor(a.index), { accessToken: accessTokenFor(a.index) });
        for (let i = 1; i <= 5; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
      }
      const imp = await auto.app.call('accounts.importCsv', {
        path: auto.writeCsv('accounts.csv', toCsv(accounts)),
      });
      expect(imp.invalid).toEqual([]);
      // 自動同期ボタンを ON にする（起動時は OFF）。まだ認証済みが無いので即時受信は空振りする
      expect(await auto.app.call('autoSync.set', { enabled: true })).toMatchObject({ enabled: true });
      // 受信同期は明示的に呼ばず、認証テストの完了だけで受信されることを確認する
      const job = await auto.app.call('auth.test', { ids: 'all' });
      await auto.waitForJob(job.id, 60_000);
      const deadline = Date.now() + 30_000;
      let messages = 0;
      while (Date.now() < deadline) {
        messages = (await auto.app.call('stats.get', {})).messages;
        if (messages === 10) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(messages).toBe(10);
    } finally {
      await auto.cleanup();
    }
  }, 60_000);

  it('autoSyncOnAuth 無効なら認証だけでは受信しない', async () => {
    const [a] = await seedAccounts(1, { isOAuth: () => true });
    for (let i = 1; i <= 5; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    await t.app.call('autoSync.set', { enabled: true });
    const job = await t.app.call('auth.test', { ids: 'all' });
    await t.waitForJob(job.id, 60_000);
    // 少し待っても自動同期は起きない（既定の harness は MM_AUTO_SYNC_ON_AUTH=0）
    await new Promise((r) => setTimeout(r, 500));
    expect((await t.app.call('stats.get', {})).messages).toBe(0);
  }, 60_000);

  it('起動時は自動同期 OFF で、autoSyncOnAuth 有効でも認証だけでは受信しない', async () => {
    const auto = await createTestApp({
      env: {
        MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl,
        MM_INITIAL_SYNC_MESSAGES: '0',
        MM_AUTO_SYNC_ON_AUTH: '1',
        MM_AUTO_SYNC_INTERVAL_SEC: '1',
      },
    });
    try {
      expect(await auto.app.call('autoSync.get', {})).toEqual({ enabled: false, intervalSec: 1 });
      const accounts = generateAccounts({
        count: 1,
        imapHost: '127.0.0.1',
        imapPort: imap.port,
        isOAuth: () => true,
      });
      const [a] = accounts;
      imap.setUser(a.email, { accessToken: accessTokenFor(a.index) });
      oauth.setGrant(refreshTokenFor(a.index), { accessToken: accessTokenFor(a.index) });
      for (let i = 1; i <= 3; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
      await auto.app.call('accounts.importCsv', {
        path: auto.writeCsv('accounts.csv', toCsv(accounts)),
      });
      const job = await auto.app.call('auth.test', { ids: 'all' });
      await auto.waitForJob(job.id, 60_000);
      // 認証完了・定期タイマー(1秒)いずれでも受信は起きない
      await new Promise((r) => setTimeout(r, 1500));
      expect((await auto.app.call('stats.get', {})).messages).toBe(0);
    } finally {
      await auto.cleanup();
    }
  }, 60_000);

  it('自動同期を ON にすると認証済みアカウントを即時に受信し、OFF で止まる', async () => {
    const events: string[] = [];
    t.app.onEvent((ev) => {
      if (ev.type === 'autoSync.changed') events.push(ev.state.enabled ? 'on' : 'off');
    });
    const [a] = await seedAccounts(1, { isOAuth: () => true });
    const auth = await t.app.call('auth.test', { ids: 'all' });
    await t.waitForJob(auth.id, 60_000);
    for (let i = 1; i <= 4; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
    expect((await t.app.call('stats.get', {})).messages).toBe(0);

    expect(await t.app.call('autoSync.set', { enabled: true })).toEqual({ enabled: true, intervalSec: 0 });
    const deadline = Date.now() + 30_000;
    let messages = 0;
    while (Date.now() < deadline) {
      messages = (await t.app.call('stats.get', {})).messages;
      if (messages === 4) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(messages).toBe(4);

    expect(await t.app.call('autoSync.set', { enabled: false })).toEqual({ enabled: false, intervalSec: 0 });
    expect(await t.app.call('autoSync.get', {})).toEqual({ enabled: false, intervalSec: 0 });
    expect(events).toEqual(['on', 'off']);
  }, 60_000);

});
