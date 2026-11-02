import { describe, expect, it } from 'vitest';
import { CredentialCipher } from '@backend/security/credential-cipher';

describe('CredentialCipher', () => {
  it('round-trips plaintext', () => {
    const c = new CredentialCipher(CredentialCipher.generateKey());
    const blob = c.encrypt('{"type":"password","password":"hunter2-secret"}', 'a@example.com');
    expect(blob).not.toContain('hunter2');
    expect(JSON.parse(blob)).toMatchObject({ v: 1 });
    expect(c.decrypt(blob, 'a@example.com')).toContain('hunter2-secret');
  });

  it('fails with a different AAD (email) or key', () => {
    const key = CredentialCipher.generateKey();
    const c = new CredentialCipher(key);
    const blob = c.encrypt('secret', 'a@example.com');
    expect(() => c.decrypt(blob, 'b@example.com')).toThrow();
    expect(() =>
      new CredentialCipher(CredentialCipher.generateKey()).decrypt(blob, 'a@example.com'),
    ).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new CredentialCipher(Buffer.alloc(16))).toThrow();
  });

  it('uses a fresh IV per encryption', () => {
    const c = new CredentialCipher(CredentialCipher.generateKey());
    expect(c.encrypt('x', 'a')).not.toEqual(c.encrypt('x', 'a'));
  });
});
