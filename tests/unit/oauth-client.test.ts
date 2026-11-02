import { describe, expect, it } from 'vitest';
import { OAuthError, refreshAccessToken } from '@backend/oauth/oauth-client';
import { TokenCache } from '@backend/oauth/token-cache';

function fakeFetch(status: number, body: unknown, delayMs = 0): typeof fetch {
  return (async (_url, init) => {
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

const base = {
  tokenUrl: 'http://token.test/',
  clientId: 'cid',
  refreshToken: 'rt',
  timeoutMs: 1000,
};

describe('refreshAccessToken', () => {
  it('returns the access token and rotated refresh token', async () => {
    const r = await refreshAccessToken({
      ...base,
      fetchImpl: fakeFetch(200, { access_token: 'AT', expires_in: 3600, refresh_token: 'rt2' }),
    });
    expect(r.accessToken).toBe('AT');
    expect(r.refreshToken).toBe('rt2');
    expect(r.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it('sends form-encoded params including client_secret and scope', async () => {
    let captured: { url: string; body: string } | null = null;
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 });
    }) as typeof fetch;
    await refreshAccessToken({
      ...base,
      clientSecret: 'cs',
      scope: 'https://mail.google.com/',
      fetchImpl: f,
    });
    const params = new URLSearchParams(captured!.body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('client_secret')).toBe('cs');
    expect(params.get('scope')).toBe('https://mail.google.com/');
  });

  it('maps invalid_grant to an auth error', async () => {
    await expect(
      refreshAccessToken({
        ...base,
        fetchImpl: fakeFetch(400, { error: 'invalid_grant', error_description: 'expired' }),
      }),
    ).rejects.toMatchObject({ kind: 'auth', code: 'invalid_grant' });
  });

  it('maps 5xx and network failures to connection errors', async () => {
    await expect(
      refreshAccessToken({
        ...base,
        fetchImpl: fakeFetch(503, { error: 'temporarily_unavailable' }),
      }),
    ).rejects.toMatchObject({ kind: 'connection' });
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(refreshAccessToken({ ...base, fetchImpl: failing })).rejects.toMatchObject({
      kind: 'connection',
    });
  });

  it('times out', async () => {
    const err = await refreshAccessToken({
      ...base,
      timeoutMs: 50,
      fetchImpl: fakeFetch(200, {}, 5000),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.kind).toBe('connection');
    expect(err.code).toBe('ETIMEDOUT');
  });
});

describe('TokenCache', () => {
  it('expires tokens with a safety margin', () => {
    const c = new TokenCache(60_000);
    const now = 1_000_000;
    c.set('a', 'AT', now + 120_000);
    expect(c.get('a', now)).toBe('AT');
    expect(c.get('a', now + 61_000)).toBeNull();
  });
});
