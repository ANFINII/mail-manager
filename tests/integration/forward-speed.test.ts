import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeSmtpServer } from '../helpers/fake-smtp-server';
import { FakeGraphServer } from '../helpers/fake-graph-server';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let oauth: FakeOAuthServer;
let graph: FakeGraphServer;
let t: TestApp;
const smtpPasswords: Record<string, string> = { 'sender@example.com': 'pw' };

beforeEach(async () => {
  imap = new FakeImapServer();
  smtp = new FakeSmtpServer({ passwords: smtpPasswords, tokens: { 'out@hotmail.com': 'AT-token' } });
  oauth = new FakeOAuthServer();
  graph = new FakeGraphServer();
  await imap.start();
  await smtp.start();
  await oauth.start();
  await graph.start();
  t = await createTestApp({
    env: {
      MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl,
      MM_GRAPH_SEND_URL_OUTLOOK: graph.sendUrl,
      MM_INITIAL_SYNC_MESSAGES: '0',
    },
  });
});
afterEach(async () => {
  smtpPasswords['sender@example.com'] = 'pw';
  await t.cleanup();
  await imap.stop();
  await smtp.stop();
  await oauth.stop();
  await graph.stop();
});

async function importPasswordAccount(email: string, password: string, count: number) {
  imap.setUser(email, { password });
  for (let i = 1; i <= count; i++) imap.addMessage(email, 'INBOX', makeMessageSpec(i, email));
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv(`${email}.csv`, toCsv([
      {
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
      },
    ])),
  });
}

async function importOutlookAccount(email: string, count: number) {
  imap.setUser(email, { accessToken: 'AT-token' });
  oauth.setGrant('rt-out', { accessToken: 'AT-token' });
  for (let i = 1; i <= count; i++) imap.addMessage(email, 'INBOX', makeMessageSpec(i, email));
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv('o.csv', toCsv([
      {
        email,
        provider: 'outlook',
        auth_type: 'oauth2',
        client_id: 'cid',
        refresh_token: 'rt-out',
        imap_host: '127.0.0.1',
        imap_port: String(imap.port),
        imap_secure: 'none',
        smtp_host: '127.0.0.1',
        smtp_port: String(smtp.port),
        smtp_secure: 'none',
      },
    ])),
  });
}

async function syncAll() {
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id, 60_000);
}

async function allIds() {
  return (await t.app.call('search.query', { page: 1, pageSize: 100 })).items.map((m) => m.id);
}

describe('forward throughput', () => {
  it('reuses pooled SMTP connections instead of connecting once per message', async () => {
    await importPasswordAccount('sender@example.com', 'pw', 8);
    await syncAll();
    const before = smtp.stats.connections;
    const res = await t.app.call('messages.forwardAll', { query: { page: 1, pageSize: 50 }, to: 'dest@target.example' });
    expect(res.queued).toBe(8);
    const job = await t.waitForJob(res.job.id, 30_000);
    expect(job).toMatchObject({ succeeded: 8, failed: 0 });
    expect(smtp.received).toHaveLength(8);
    // 8 通で 8 接続ではなく、アカウントあたり最大 3 接続のプールで送る
    expect(smtp.stats.connections - before).toBeLessThanOrEqual(3);
    expect(t.app.messages['deps'].smtp.openPools).toBe(1);
  }, 60_000);

  it('stops calling Graph for an account after a permission error and sends the rest via SMTP directly', async () => {
    graph.mode = 'reject'; // Mail.Send 未同意を模す
    await importOutlookAccount('out@hotmail.com', 6);
    await syncAll();
    const res = await t.app.call('messages.forwardAll', { query: { page: 1, pageSize: 50 }, to: 'dest@target.example' });
    expect(res.queued).toBe(6);
    const job = await t.waitForJob(res.job.id, 30_000);
    expect(job).toMatchObject({ succeeded: 6, failed: 0 });
    expect(smtp.received).toHaveLength(6);
    expect(smtp.received.every((m) => m.authMethod === 'XOAUTH2')).toBe(true);
    // Graph は最初の 1 通で 403 を受けた後は呼ばない（同時 3 通のうち先行分を含めても 3 回以下）
    expect(graph.stats.requests).toBeLessThanOrEqual(3);
    expect(graph.stats.requests).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('backs off failed messages for auto rules, while a manual forward retries immediately', async () => {
    await importPasswordAccount('sender@example.com', 'pw', 8);
    await syncAll();
    // SMTP 側のパスワードを変えて送信を失敗させる
    smtpPasswords['sender@example.com'] = 'changed';
    const ids = await allIds();
    const first = await t.app.call('messages.forward', { ids, to: 'dest@target.example' });
    expect(first.queued).toBe(8);
    expect(await t.waitForJob(first.job.id, 30_000)).toMatchObject({ succeeded: 0, failed: 8 });
    expect(await t.app.messageRepo.countPendingForwardFailures()).toBe(8);
    // 同時送信 3 通の最初の波だけが SMTP に届き、残りは認証エラーの記憶でネットワークに出ずに失敗する
    const afterFirst = smtp.stats.authFailures;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect(afterFirst).toBeLessThanOrEqual(3);

    // 自動転送ルール: バックオフ中なので再試行しない（SMTP にも触らない）
    await t.app.call('forwardRules.add', { keyword: 'Message', matchField: 'body', to: 'dest@target.example', enabled: true });
    const applied = await t.app.call('forwardRules.apply', {});
    expect(applied).toMatchObject({ rules: 1, forwarded: 0, deferred: 8 });
    expect(smtp.stats.authFailures).toBe(afterFirst);

    // 手動転送は記憶を消して即時に再試行する（今回はまだ失敗）
    const second = await t.app.call('messages.forward', { ids, to: 'dest@target.example' });
    expect(second.queued).toBe(8);
    expect(await t.waitForJob(second.job.id, 30_000)).toMatchObject({ failed: 8 });
    expect(smtp.stats.authFailures).toBeGreaterThan(afterFirst);

    // 直したら送れて、失敗記録は消える
    smtpPasswords['sender@example.com'] = 'pw';
    const third = await t.app.call('messages.forward', { ids, to: 'dest@target.example' });
    expect(await t.waitForJob(third.job.id, 30_000)).toMatchObject({ succeeded: 8, failed: 0 });
    expect(smtp.received).toHaveLength(8);
    expect(await t.app.messageRepo.countPendingForwardFailures()).toBe(0);
  }, 60_000);

  it('does not queue the same message twice while it is still being sent', async () => {
    await importPasswordAccount('sender@example.com', 'pw', 5);
    await syncAll();
    const ids = await allIds();
    const [a, b] = await Promise.all([
      t.app.call('messages.forward', { ids, to: 'dest@target.example' }),
      t.app.call('messages.forward', { ids, to: 'dest@target.example' }),
    ]);
    expect(a.queued + b.queued).toBe(5);
    expect(a.skipped + b.skipped).toBe(5);
    await t.waitForJob(a.job.id, 30_000);
    if (b.queued > 0) await t.waitForJob(b.job.id, 30_000);
    expect(smtp.received).toHaveLength(5);
  }, 60_000);
});

describe('forwarding with attachments stored at sync time is send-only', () => {
  it('does not reopen IMAP to fetch attachments that were stored during sync', async () => {
    await importPasswordAccount('sender@example.com', 'pw', 0);
    // 添付つきメール（makeMessageSpec の i%10===0 が添付あり → i=10,20）を 2 通
    imap.addMessage('sender@example.com', 'INBOX', makeMessageSpec(10, 'sender@example.com'));
    imap.addMessage('sender@example.com', 'INBOX', makeMessageSpec(20, 'sender@example.com'));
    // 同期時に添付本体を保存する
    await t.app.settings.update({ storeAttachments: true });
    await syncAll();
    const items = (await t.app.call('search.query', { page: 1, pageSize: 10 })).items;
    expect(items.every((m) => m.hasAttachments)).toBe(true);

    const sessionsBefore = imap.stats.totalConnections;
    const res = await t.app.call('messages.forward', {
      ids: items.map((m) => m.id),
      to: 'dest@target.example',
    });
    expect(res.queued).toBe(2);
    const job = await t.waitForJob(res.job.id, 30_000);
    expect(job).toMatchObject({ succeeded: 2, failed: 0 });
    expect(smtp.received).toHaveLength(2);
    // 添付は本文に含まれて送られている（SMTP DATA に filename が出る）
    expect(smtp.received[0].data).toMatch(/report-\d+\.pdf/);
    // 転送のために IMAP セッションを新しく開いていない
    const sessionsAfter = imap.stats.totalConnections;
    expect(sessionsAfter).toBe(sessionsBefore);
  }, 60_000);
});
