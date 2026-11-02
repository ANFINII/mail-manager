import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import { toCsv } from '../helpers/csv-fixtures';

let imap: FakeImapServer;
let oauth: FakeOAuthServer;
let t: TestApp;

beforeEach(async () => {
  imap = new FakeImapServer();
  oauth = new FakeOAuthServer();
  await imap.start();
  await oauth.start();
  t = await createTestApp({ env: { MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl } });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await oauth.stop();
});

async function importOne(row: Record<string, string>) {
  const r = await t.app.call('accounts.importCsv', {
    path: t.writeCsv('a.csv', toCsv([{ imap_host: '127.0.0.1', imap_port: String(imap.port), imap_secure: 'none', ...row }])),
  });
  expect(r.invalid).toEqual([]);
  return (await t.app.call('accounts.list', {}))[0];
}
async function authAndWait(id: string) {
  const job = await t.app.call('auth.test', { ids: [id] });
  await t.waitForJob(job.id, 30_000);
  return (await t.app.call('accounts.get', { id }))!;
}

describe('editing account credentials', () => {
  it('replaces a wrong password, resets the auth status and the next test succeeds', async () => {
    imap.setUser('p@example.com', { password: 'correct' });
    const a = await importOne({ email: 'p@example.com', provider: 'custom', auth_type: 'password', password: 'wrong' });
    expect((await authAndWait(a.id)).authStatus).toBe('failed');

    const detail = await t.app.call('accounts.updateCredentials', {
      id: a.id,
      update: { password: 'correct', testAfterSave: false },
    });
    expect(detail).toMatchObject({ authStatus: 'untested', status: 'untested', hasPassword: true, authType: 'password' });
    expect((await authAndWait(a.id)).authStatus).toBe('ok');
    // 平文はログにも DB にも残らない
    await t.app.shutdown();
    const bytes = [t.dbFile, `${t.dbFile}-wal`].filter(fs.existsSync).map((f) => fs.readFileSync(f, 'latin1')).join('');
    expect(bytes).not.toContain('correct');
    expect(t.logs.lines.join('\n')).not.toContain('correct');
    t.cleanup = async () => fs.rmSync(t.dir, { recursive: true, force: true });
  }, 60_000);

  it('keeps unchanged secrets when fields are left blank, and validates required values', async () => {
    imap.setUser('o@outlook.com', { accessToken: 'AT-new' });
    oauth.setGrant('rt-old', { accessToken: 'x', behavior: 'invalid_grant' });
    oauth.setGrant('rt-new', { accessToken: 'AT-new' });
    const a = await importOne({ email: 'o@outlook.com', provider: 'outlook', auth_type: 'oauth2', client_id: 'cid', refresh_token: 'rt-old' });
    expect((await authAndWait(a.id)).authStatus).toBe('failed');

    // refresh_token だけ差し替え（client_id は空 → 維持）
    const d1 = await t.app.call('accounts.updateCredentials', { id: a.id, update: { refreshToken: 'rt-new', testAfterSave: false } });
    expect(d1).toMatchObject({ oauthClientId: 'cid', hasRefreshToken: true, authStatus: 'untested' });
    expect((await authAndWait(a.id)).authStatus).toBe('ok');
    expect(oauth.stats.byRefreshToken['rt-new']).toBeGreaterThanOrEqual(1);

    // 必須値の検証
    await expect(
      t.app.call('accounts.updateCredentials', { id: a.id, update: { authType: 'oauth2', clientId: '   ' } }),
    ).resolves.toMatchObject({ oauthClientId: 'cid' }); // 空白は「維持」扱い
    await expect(t.app.call('accounts.updateCredentials', { id: 'nope', update: { password: 'x' } })).rejects.toThrow(/見つかりません/);
    await expect(
      t.app.call('accounts.updateCredentials', { id: a.id, update: { authType: 'password', testAfterSave: false } }),
    ).rejects.toThrow(/パスワード/);
  }, 60_000);

  it('switches auth type from password to oauth2 and back, and runs the test after save by default', async () => {
    imap.setUser('s@outlook.com', { password: 'pw', accessToken: 'AT-s' });
    oauth.setGrant('rt-s', { accessToken: 'AT-s' });
    const a = await importOne({ email: 's@outlook.com', provider: 'outlook', auth_type: 'password', password: 'pw' });
    expect((await authAndWait(a.id)).authStatus).toBe('ok');

    const d = await t.app.call('accounts.updateCredentials', {
      id: a.id,
      update: { authType: 'oauth2', clientId: 'cid', refreshToken: 'rt-s' },
    });
    expect(d).toMatchObject({ authType: 'oauth2', oauthClientId: 'cid', hasRefreshToken: true, hasPassword: false });
    // testAfterSave 既定 true → 認証テストが自動で走り ok になる
    const deadline = Date.now() + 20_000;
    let status = d.authStatus;
    while (Date.now() < deadline && status !== 'ok') {
      await new Promise((r) => setTimeout(r, 100));
      status = (await t.app.call('accounts.get', { id: a.id }))!.authStatus;
    }
    expect(status).toBe('ok');
    expect(imap.getUser('s@outlook.com')).toBeTruthy();

    const back = await t.app.call('accounts.updateCredentials', {
      id: a.id,
      update: { authType: 'password', password: 'pw', testAfterSave: false },
    });
    expect(back).toMatchObject({ authType: 'password', hasPassword: true, hasRefreshToken: false });
    expect((await authAndWait(a.id)).authStatus).toBe('ok');
  }, 60_000);
});
