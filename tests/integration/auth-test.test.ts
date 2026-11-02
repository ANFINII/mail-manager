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
  type FixtureAccount,
} from '../helpers/csv-fixtures';

let imap: FakeImapServer;
let oauth: FakeOAuthServer;
let t: TestApp;

function registerFixtures(accounts: FixtureAccount[]): void {
  for (const a of accounts) {
    if (a.auth_type === 'oauth2') {
      imap.setUser(a.email, { accessToken: accessTokenFor(a.index) });
      oauth.setGrant(refreshTokenFor(a.index), { accessToken: accessTokenFor(a.index) });
    } else {
      imap.setUser(a.email, { password: passwordFor(a.index) });
    }
  }
}

beforeEach(async () => {
  imap = new FakeImapServer();
  oauth = new FakeOAuthServer();
  await imap.start();
  await oauth.start();
  t = await createTestApp({
    env: { MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl, MM_AUTH_CONCURRENCY: '10' },
  });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await oauth.stop();
});

async function importFixtures(accounts: FixtureAccount[]) {
  const r = await t.app.call('accounts.importCsv', {
    path: t.writeCsv('accounts.csv', toCsv(accounts)),
  });
  expect(r.invalid).toEqual([]);
  return r;
}

describe('bulk authentication test', () => {
  it('authenticates 300 accounts (150 XOAUTH2 + 150 password) with at most 10 concurrent connections', async () => {
    const accounts = generateAccounts({ count: 300, imapHost: '127.0.0.1', imapPort: imap.port });
    registerFixtures(accounts);
    await importFixtures(accounts);

    const started = Date.now();
    const job = await t.app.call('auth.test', { ids: 'all' });
    const finished = await t.waitForJob(job.id);
    const elapsed = Date.now() - started;

    expect(finished).toMatchObject({
      status: 'completed',
      total: 300,
      done: 300,
      succeeded: 300,
      failed: 0,
    });
    // IMAP セッション数（greeting〜LOGOUT）は上限ちょうど。TCP ソケット数は FIN 処理中の 1 本ぶんだけ超えうる
    expect(imap.stats.maxConcurrentSessions).toBeLessThanOrEqual(10);
    expect(imap.stats.maxConcurrentSessions).toBeGreaterThan(1);
    expect(imap.stats.maxConcurrent).toBeLessThanOrEqual(11);
    expect(imap.stats.xoauth2Attempts).toBe(150);
    expect(imap.stats.loginAttempts).toBe(150);
    expect(oauth.stats.requests).toBe(150);

    const stats = await t.app.call('stats.get', {});
    expect(stats).toMatchObject({
      total: 300,
      connected: 300,
      authError: 0,
      connectionError: 0,
      untested: 0,
    });
    expect(stats.lastTestAt).not.toBeNull();
    const list = await t.app.call('accounts.list', { filter: 'connected' });
    expect(list).toHaveLength(300);
    expect(
      list.every((a) => a.authStatus === 'ok' && a.lastSuccessAt && a.lastError === null),
    ).toBe(true);

    const log = t.logs.lines.join('\n');
    expect(log).toContain('auth test succeeded');
    expect(log).not.toContain('-secret');
    expect(log).not.toMatch(/AT-secret|RT-secret|Pa\$\$w0rd/);
    console.log(
      `300 accounts authenticated in ${elapsed}ms, max concurrent sessions ${imap.stats.maxConcurrentSessions}, max sockets ${imap.stats.maxConcurrent}`,
    );
  }, 120_000);

  it('records per-account failures: 100 success / 200 failure, auth errors are not retried', async () => {
    const accounts = generateAccounts({ count: 300, imapHost: '127.0.0.1', imapPort: imap.port });
    registerFixtures(accounts);
    // 1..100 成功、101..200 認証失敗（誤パスワード / invalid_grant）、201..300 認証失敗（サーバー側で拒否）
    for (const a of accounts) {
      if (a.index > 100 && a.index <= 200) {
        if (a.auth_type === 'oauth2')
          oauth.setGrant(refreshTokenFor(a.index), { accessToken: 'x', behavior: 'invalid_grant' });
        else imap.setUser(a.email, { password: 'different-password' });
      } else if (a.index > 200) {
        imap.setUser(a.email, { password: 'x', accessToken: 'x', behavior: 'auth_fail' });
      }
    }
    await importFixtures(accounts);
    const job = await t.app.call('auth.test', { ids: 'all' });
    const finished = await t.waitForJob(job.id);
    expect(finished).toMatchObject({ status: 'completed', succeeded: 100, failed: 200 });

    const stats = await t.app.call('stats.get', {});
    expect(stats).toMatchObject({ connected: 100, authError: 200, connectionError: 0 });
    const failed = await t.app.call('accounts.list', { filter: 'auth_error' });
    expect(failed).toHaveLength(200);
    for (const a of failed) {
      expect(a.authStatus).toBe('failed');
      expect(a.retryCount).toBe(0);
      expect(a.lastError).toBeTruthy();
      expect(a.lastErrorAt).toBeTruthy();
      expect(a.lastError).not.toContain('different-password');
    }
    // 認証エラーはリトライされない: 各ユーザーへの試行は 1 回だけ
    for (const a of accounts) {
      if (a.index > 200) expect(imap.stats.attemptsByUser[a.email]).toBe(1);
      if (a.index > 100 && a.index <= 200 && a.auth_type === 'oauth2') {
        expect(oauth.stats.byRefreshToken[refreshTokenFor(a.index)]).toBe(1);
      }
    }
  }, 120_000);

  it('retries connection errors with backoff and classifies timeouts and unavailable servers', async () => {
    const hangServer = new FakeImapServer({ hang: true });
    await hangServer.start();
    const closedPort = await (async () => {
      const s = new FakeImapServer();
      const p = await s.start();
      await s.stop();
      return p;
    })();
    try {
      const rows = [
        {
          email: 'timeout@example.com',
          password: 'p',
          imap_host: '127.0.0.1',
          imap_port: String(hangServer.port),
          imap_secure: 'none',
        },
        {
          email: 'refused@example.com',
          password: 'p',
          imap_host: '127.0.0.1',
          imap_port: String(closedPort),
          imap_secure: 'none',
        },
        {
          email: 'nxdomain@example.com',
          password: 'p',
          imap_host: 'no-such-host.invalid',
          imap_port: '993',
          imap_secure: 'tls',
        },
        {
          email: 'ok@example.com',
          password: 'p',
          imap_host: '127.0.0.1',
          imap_port: String(imap.port),
          imap_secure: 'none',
        },
      ];
      imap.setUser('ok@example.com', { password: 'p' });
      await t.app.settings.update({ connectTimeoutMs: 1000, maxRetries: 2 });
      const r = await t.app.call('accounts.importCsv', {
        path: t.writeCsv('conn.csv', toCsv(rows)),
      });
      expect(r.imported).toBe(4);

      const job = await t.app.call('auth.test', { ids: 'all' });
      const finished = await t.waitForJob(job.id);
      expect(finished).toMatchObject({ succeeded: 1, failed: 3 });
      const list = await t.app.call('accounts.list', {});
      const byEmail = Object.fromEntries(list.map((a) => [a.email, a]));
      expect(byEmail['ok@example.com'].status).toBe('connected');
      for (const e of ['timeout@example.com', 'refused@example.com', 'nxdomain@example.com']) {
        expect(byEmail[e].status).toBe('connection_error');
        expect(byEmail[e].authStatus).toBe('untested');
        expect(byEmail[e].retryCount).toBe(2);
        expect(byEmail[e].lastError).toBeTruthy();
      }
      // hang サーバーには 1 + 2 リトライ = 3 回接続している
      expect(hangServer.stats.totalConnections).toBe(3);
      const log = t.logs.lines.join('\n');
      expect(log).toMatch(/connection failed, retrying/);
    } finally {
      await hangServer.stop();
    }
  }, 120_000);

  it('Stop All cancels queued and in-flight work and leaves accounts untested', async () => {
    const accounts = generateAccounts({
      count: 100,
      imapHost: '127.0.0.1',
      imapPort: imap.port,
      isOAuth: () => false,
    });
    registerFixtures(accounts);
    for (const a of accounts)
      imap.setUser(a.email, { password: passwordFor(a.index), delayMs: 300 });
    await importFixtures(accounts);
    const job = await t.app.call('auth.test', { ids: 'all' });
    await new Promise((r) => setTimeout(r, 150));
    const { cancelled } = await t.app.call('jobs.cancelAll', {});
    expect(cancelled).toBe(1);
    const finished = await t.waitForJob(job.id);
    expect(finished.status).toBe('cancelled');
    expect(finished.done).toBe(100);
    expect(finished.cancelled).toBeGreaterThan(50);
    expect(imap.stats.totalConnections).toBeLessThanOrEqual(20);
    const list = await t.app.call('accounts.list', {});
    expect(list.filter((a) => a.status === 'connecting')).toHaveLength(0);
    expect(list.filter((a) => a.status === 'untested').length).toBeGreaterThan(50);
  }, 60_000);

  it('tests selected accounts only, skips disabled ones and rotates refresh tokens', async () => {
    const accounts = generateAccounts({
      count: 4,
      imapHost: '127.0.0.1',
      imapPort: imap.port,
      isOAuth: () => true,
    });
    registerFixtures(accounts);
    oauth.setGrant(refreshTokenFor(1), {
      accessToken: accessTokenFor(1),
      rotateTo: 'ROTATED-secret-1',
    });
    await importFixtures(accounts);
    const list = await t.app.call('accounts.list', {});
    const ids = list.map((a) => a.id);
    await t.app.call('accounts.setEnabled', { ids: [ids[1]], enabled: false });

    const job = await t.app.call('auth.test', { ids: [ids[0], ids[1]] });
    const finished = await t.waitForJob(job.id);
    expect(finished).toMatchObject({ total: 2, succeeded: 1, cancelled: 1 });
    const after = await t.app.call('accounts.list', {});
    expect(after.find((a) => a.id === ids[0])?.status).toBe('connected');
    expect(after.find((a) => a.id === ids[1])?.status).toBe('disabled');
    expect(after.find((a) => a.id === ids[2])?.status).toBe('untested');

    // ローテーションされた refresh token で保存し直されている（次回はそれを使う）
    oauth.grants.delete(refreshTokenFor(1));
    oauth.setGrant('ROTATED-secret-1', { accessToken: accessTokenFor(1) });
    t.app.authTest['deps'].oauth.cache.clear();
    const job2 = await t.app.call('auth.test', { ids: [ids[0]] });
    expect((await t.waitForJob(job2.id)).succeeded).toBe(1);
    expect(oauth.stats.byRefreshToken['ROTATED-secret-1']).toBe(1);
    expect(t.logs.lines.join('\n')).not.toContain('ROTATED-secret-1');
  }, 60_000);

  it('connects over TLS (self-signed, verification disabled in settings)', async () => {
    const tlsServer = new FakeImapServer({
      tls: true,
      users: { 'tls@example.com': { password: 'p' } },
    });
    await tlsServer.start();
    try {
      await t.app.settings.update({ tlsRejectUnauthorized: false });
      await t.app.call('accounts.importCsv', {
        path: t.writeCsv(
          'tls.csv',
          toCsv([
            {
              email: 'tls@example.com',
              password: 'p',
              imap_host: '127.0.0.1',
              imap_port: String(tlsServer.port),
              imap_secure: 'tls',
            },
          ]),
        ),
      });
      const job = await t.app.call('auth.test', { ids: 'all' });
      expect((await t.waitForJob(job.id)).succeeded).toBe(1);

      // 検証を有効に戻すと自己署名証明書は connection_error になる
      await t.app.settings.update({ tlsRejectUnauthorized: true, maxRetries: 0 });
      const job2 = await t.app.call('auth.test', { ids: 'all' });
      expect((await t.waitForJob(job2.id)).failed).toBe(1);
      expect((await t.app.call('accounts.list', {}))[0].status).toBe('connection_error');
    } finally {
      await tlsServer.stop();
    }
  }, 60_000);

  it('applies concurrency changes from settings at runtime', async () => {
    const accounts = generateAccounts({
      count: 40,
      imapHost: '127.0.0.1',
      imapPort: imap.port,
      isOAuth: () => false,
    });
    registerFixtures(accounts);
    for (const a of accounts)
      imap.setUser(a.email, { password: passwordFor(a.index), delayMs: 50 });
    await importFixtures(accounts);
    const fresh = await createTestApp({
      env: { MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl },
      masterKey: t.masterKey,
      dbFile: t.dbFile,
    });
    try {
      await fresh.app.settings.update({ authConcurrency: 3 });
      const job = await fresh.app.call('auth.test', { ids: 'all' });
      await fresh.waitForJob(job.id);
      expect(imap.stats.maxConcurrentSessions).toBeLessThanOrEqual(3);
      expect(imap.stats.maxConcurrent).toBeLessThanOrEqual(4);
    } finally {
      await fresh.app.shutdown();
    }
  }, 60_000);
});
