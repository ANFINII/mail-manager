import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@backend/providers/presets';
import { parseSecure, validateRow, type ValidationContext } from '@backend/accounts/validate';

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    registry: new ProviderRegistry(),
    existingEmails: new Set(),
    seenEmails: new Set(),
    ...overrides,
  };
}

describe('validateRow', () => {
  it('accepts a gmail app-password row and fills the preset', () => {
    const r = validateRow({ email: 'a@gmail.com', password: 'abcd efgh ijkl mnop' }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.account).toMatchObject({
      provider: 'gmail',
      authType: 'password',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecure: 'tls',
      smtpHost: 'smtp.gmail.com',
    });
    expect(r.account.credentials).toEqual({ type: 'password', password: 'abcd efgh ijkl mnop' });
  });

  it('accepts an outlook oauth2 row with client_id and refresh_token', () => {
    const r = validateRow({ email: 'a@outlook.com', client_id: 'cid', refresh_token: 'rt' }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.account).toMatchObject({
      provider: 'outlook',
      authType: 'oauth2',
      imapHost: 'outlook.office365.com',
      imapPort: 993,
    });
    expect(r.account.credentials).toEqual({ type: 'oauth2', clientId: 'cid', refreshToken: 'rt' });
  });

  it('allows password auth for outlook (server decides at auth time)', () => {
    const r = validateRow({ email: 'a@hotmail.com', password: 'x' }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.account.provider).toBe('outlook');
      expect(r.account.authType).toBe('password');
      expect(r.account.credentials).toEqual({ type: 'password', password: 'x' });
    }
  });

  it('reports missing fields', () => {
    expect(validateRow({ email: 'bad-email', password: 'x' }, ctx())).toEqual({
      ok: false,
      errors: ['invalid_email', 'missing_imap_host'],
    });
    expect(validateRow({ email: 'a@example.com' }, ctx())).toEqual({
      ok: false,
      errors: ['missing_password', 'missing_imap_host'],
    });
    expect(validateRow({ email: 'a@outlook.com', auth_type: 'oauth2' }, ctx())).toEqual({
      ok: false,
      errors: ['missing_client_id', 'missing_refresh_token'],
    });
    expect(validateRow({ email: '', password: 'x', imap_host: 'h' }, ctx())).toEqual({
      ok: false,
      errors: ['missing_email'],
    });
  });

  it('detects duplicates in file and in db (case-insensitive)', () => {
    expect(
      validateRow(
        { email: 'A@gmail.com', password: 'x' },
        ctx({ seenEmails: new Set(['a@gmail.com']) }),
      ),
    ).toEqual({ ok: false, errors: ['duplicate_in_file'] });
    expect(
      validateRow(
        { email: 'A@gmail.com', password: 'x' },
        ctx({ existingEmails: new Set(['a@gmail.com']) }),
      ),
    ).toEqual({ ok: false, errors: ['duplicate_in_db'] });
  });

  it('validates ports, secure flags, providers and proxies', () => {
    expect(
      validateRow(
        { email: 'a@example.com', password: 'x', imap_host: 'h', imap_port: '70000' },
        ctx(),
      ),
    ).toEqual({ ok: false, errors: ['invalid_imap_port'] });
    expect(
      validateRow(
        { email: 'a@example.com', password: 'x', imap_host: 'h', imap_secure: 'maybe' },
        ctx(),
      ),
    ).toEqual({ ok: false, errors: ['invalid_imap_secure'] });
    expect(
      validateRow(
        { email: 'a@example.com', password: 'x', imap_host: 'h', provider: 'yahoo' },
        ctx(),
      ),
    ).toEqual({ ok: false, errors: ['invalid_provider'] });
    expect(
      validateRow(
        { email: 'a@example.com', password: 'x', imap_host: 'h', auth_type: 'basic' },
        ctx(),
      ),
    ).toEqual({ ok: false, errors: ['invalid_auth_type'] });
    expect(
      validateRow(
        { email: 'a@example.com', password: 'x', imap_host: 'h', proxy: '127.0.0.1:1080' },
        ctx(),
      ),
    ).toEqual({ ok: false, errors: ['invalid_proxy'] });
    const ok = validateRow(
      {
        email: 'a@example.com',
        password: 'x',
        imap_host: 'h',
        proxy: 'socks5://127.0.0.1:1080',
        imap_port: '143',
      },
      ctx(),
    );
    expect(ok.ok && ok.account.proxy).toBe('socks5://127.0.0.1:1080');
    expect(ok.ok && ok.account.imapSecure).toBe('starttls');
  });

  it('maps legacy true/false secure values', () => {
    expect(parseSecure('true', undefined)).toBe('tls');
    expect(parseSecure('false', undefined)).toBe('none');
    expect(parseSecure('STARTTLS', undefined)).toBe('starttls');
    expect(parseSecure('', 'tls')).toBe('tls');
  });
});
