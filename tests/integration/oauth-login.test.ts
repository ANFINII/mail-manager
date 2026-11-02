import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import { emailFromIdToken, pkcePair } from '@backend/oauth/oauth-login';

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
      MM_OAUTH_AUTHORIZE_URL_OUTLOOK: oauth.authorizeUrl,
      MM_OAUTH_TOKEN_URL_GMAIL: oauth.tokenUrl,
      MM_OAUTH_AUTHORIZE_URL_GMAIL: oauth.authorizeUrl,
    },
  });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await oauth.stop();
});

/** ブラウザの代わりに認可 URL を開き、リダイレクトを辿って受け口のページを得る */
async function browse(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, body: await res.text() };
}

async function waitDone(sessionId: string) {
  for (let i = 0; i < 100; i++) {
    const s = await t.app.call('oauth.status', { sessionId });
    if (s.state !== 'pending') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('login did not finish');
}

describe('OAuth2 interactive login', () => {
  it('helpers: PKCE challenge and id_token email', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
    const jwt = `e30.${Buffer.from(JSON.stringify({ preferred_username: 'A@Outlook.com' })).toString('base64url')}.x`;
    expect(emailFromIdToken(jwt)).toBe('a@outlook.com');
    expect(emailFromIdToken('garbage')).toBeNull();
  });

  it('registers a new Outlook account from the browser sign-in and tests it', async () => {
    oauth.loginUser = { email: 'new@outlook.com', refreshToken: 'rt-login', accessToken: 'AT-login' };
    // 認証テストの IMAP 接続は擬似サーバーへ向ける（プリセットのホストは外部なので CSV で上書きできない）
    const { sessionId, authorizeUrl } = await t.app.call('oauth.start', {
      provider: 'outlook',
      clientId: 'cid-123',
    });
    const q = new URL(authorizeUrl).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q.get('scope')).toContain('offline_access');

    const page = await browse(authorizeUrl);
    expect(page.status).toBe(200);
    expect(page.body).toContain('new@outlook.com');
    const s = await waitDone(sessionId);
    expect(s).toMatchObject({ state: 'done', email: 'new@outlook.com' });

    const acc = (await t.app.call('accounts.list', {})).find((a) => a.email === 'new@outlook.com');
    expect(acc).toMatchObject({ id: s.accountId, provider: 'outlook', authType: 'oauth2' });
    const detail = await t.app.call('accounts.get', { id: s.accountId! });
    expect(detail).toMatchObject({ oauthClientId: 'cid-123', hasRefreshToken: true });
    // refresh token は平文でログに残らない
    expect(t.logs.lines.join('\n')).not.toContain('rt-login');
    // 受け口は閉じている
    await expect(fetch(new URL(q.get('redirect_uri')!).origin + '/callback')).rejects.toThrow();
  });

  it('updates the credentials of an existing account and refuses a different mailbox', async () => {
    oauth.loginUser = { email: 'old@outlook.com', refreshToken: 'rt-2', accessToken: 'AT-2' };
    const first = await t.app.call('oauth.start', { provider: 'outlook', clientId: 'cid' });
    await browse(first.authorizeUrl);
    const created = await waitDone(first.sessionId);

    oauth.loginUser = { email: 'old@outlook.com', refreshToken: 'rt-3', accessToken: 'AT-3' };
    const again = await t.app.call('oauth.start', {
      provider: 'outlook',
      clientId: 'cid-new',
      accountId: created.accountId,
    });
    await browse(again.authorizeUrl);
    expect(await waitDone(again.sessionId)).toMatchObject({ state: 'done', accountId: created.accountId });
    expect(await t.app.call('accounts.get', { id: created.accountId! })).toMatchObject({ oauthClientId: 'cid-new' });
    expect((await t.app.call('accounts.list', {})).length).toBe(1);

    oauth.loginUser = { email: 'someone-else@outlook.com', refreshToken: 'rt-4', accessToken: 'AT-4' };
    const wrong = await t.app.call('oauth.start', {
      provider: 'outlook',
      clientId: 'cid',
      accountId: created.accountId,
    });
    const page = await browse(wrong.authorizeUrl);
    expect(page.status).toBe(400);
    expect((await waitDone(wrong.sessionId)).error).toContain('違います');
  });

  it('reports a denied consent and requires the client secret for Gmail', async () => {
    oauth.loginUser = { email: 'x@outlook.com', refreshToken: 'r', accessToken: 'a', deny: true };
    const { sessionId, authorizeUrl } = await t.app.call('oauth.start', { provider: 'outlook', clientId: 'cid' });
    await browse(authorizeUrl);
    expect((await waitDone(sessionId)).error).toContain('access_denied');

    await expect(t.app.call('oauth.start', { provider: 'gmail', clientId: 'cid' })).rejects.toThrow(/client_secret/);
  });

  it('uses the typed email when the provider returns no id_token, and can be cancelled', async () => {
    oauth.loginUser = { email: 'typed@gmail.com', refreshToken: 'rt-g', accessToken: 'AT-g', noIdToken: true };
    const { sessionId, authorizeUrl } = await t.app.call('oauth.start', {
      provider: 'gmail',
      clientId: 'gid',
      clientSecret: 'gsecret',
      email: 'typed@gmail.com',
    });
    expect(new URL(authorizeUrl).searchParams.get('access_type')).toBe('offline');
    expect(new URL(authorizeUrl).searchParams.get('login_hint')).toBe('typed@gmail.com');
    await browse(authorizeUrl);
    expect(await waitDone(sessionId)).toMatchObject({ state: 'done', email: 'typed@gmail.com' });

    const c = await t.app.call('oauth.start', { provider: 'outlook', clientId: 'cid' });
    await t.app.call('oauth.cancel', { sessionId: c.sessionId });
    expect(await t.app.call('oauth.status', { sessionId: c.sessionId })).toMatchObject({ state: 'error' });
  });
});
