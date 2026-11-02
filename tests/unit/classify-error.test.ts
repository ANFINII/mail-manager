import { describe, expect, it } from 'vitest';
import { classifyError } from '@backend/mail/classify-error';
import { OAuthError } from '@backend/oauth/oauth-client';
import { retryDelayMs, parseRetryDelays } from '@backend/auth/retry-policy';

describe('classifyError', () => {
  it('classifies ImapFlow authentication failures', () => {
    const err = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseStatus: 'NO',
    });
    expect(classifyError(err).kind).toBe('auth');
  });
  it('classifies network errors', () => {
    expect(
      classifyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
        .kind,
    ).toBe('connection');
    expect(
      classifyError(Object.assign(new Error('Greeting timeout'), { code: 'ETIMEOUT' })).kind,
    ).toBe('connection');
    expect(classifyError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).kind).toBe(
      'connection',
    );
    expect(
      classifyError(
        Object.assign(new Error('self signed certificate'), {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        }),
      ).kind,
    ).toBe('connection');
  });
  it('classifies OAuth errors by kind', () => {
    expect(classifyError(new OAuthError('invalid_grant', 'auth', 'invalid_grant')).kind).toBe(
      'auth',
    );
    expect(classifyError(new OAuthError('503', 'connection')).kind).toBe('connection');
  });
  it('falls back to message heuristics and unknown', () => {
    expect(classifyError(new Error('Invalid credentials (Failure)')).kind).toBe('auth');
    expect(classifyError(new Error('Socket hang up')).kind).toBe('connection');
    expect(classifyError(new Error('Something odd')).kind).toBe('unknown');
    expect(classifyError('string error').message).toBe('string error');
  });
});

describe('retry policy', () => {
  it('uses exponential-style delays and clamps to the last one', () => {
    expect(retryDelayMs([2000, 5000, 15000], 0)).toBe(2000);
    expect(retryDelayMs([2000, 5000, 15000], 2)).toBe(15000);
    expect(retryDelayMs([2000, 5000, 15000], 9)).toBe(15000);
  });
  it('parses env overrides', () => {
    expect(parseRetryDelays('10, 20,30')).toEqual([10, 20, 30]);
    expect(parseRetryDelays(undefined)).toEqual([2000, 5000, 15000]);
    expect(parseRetryDelays('nope')).toEqual([2000, 5000, 15000]);
  });
});
