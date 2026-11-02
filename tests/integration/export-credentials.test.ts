import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { toCsv } from '../helpers/csv-fixtures';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.cleanup();
});

describe('exporting accounts with credentials', () => {
  it('writes a re-importable CSV with the original secrets, and it round-trips', async () => {
    const rows = [
      { email: 'pw@gmail.com', provider: 'gmail', auth_type: 'password', password: 'app pass 1234', imap_host: 'imap.g', imap_port: '993', imap_secure: 'tls' },
      { email: 'tok@outlook.com', provider: 'outlook', auth_type: 'oauth2', client_id: 'CID-9', refresh_token: 'RT-xyz', client_secret: '', imap_host: 'imap.o', imap_port: '993', imap_secure: 'tls' },
    ];
    await t.app.call('accounts.importCsv', { path: t.writeCsv('in.csv', toCsv(rows)) });
    const out = `${t.dir}/with-creds.csv`;
    const r = await t.app.call('accounts.exportCsvWithCredentials', { path: out });
    expect(r.count).toBe(2);

    const csv = fs.readFileSync(out, 'utf8');
    const header = csv.replace(/^﻿/, '').split('\n')[0];
    expect(header).toBe('email,password,provider,auth_type,client_id,client_secret,refresh_token,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,proxy,group');
    expect(csv).toContain('app pass 1234');
    expect(csv).toContain('CID-9');
    expect(csv).toContain('RT-xyz');

    // 別のアプリ(DB)に同じ CSV を取り込める（再取り込み可能な形式）
    const t2 = await createTestApp();
    try {
      const imp = await t2.app.call('accounts.importCsv', { path: t2.writeCsv('roundtrip.csv', csv) });
      expect(imp.imported).toBe(2);
      expect(imp.invalid).toEqual([]);
      const list = await t2.app.call('accounts.list', {});
      expect(list.map((a) => a.email).sort()).toEqual(['pw@gmail.com', 'tok@outlook.com']);
      const detail = await t2.app.call('accounts.get', { id: list.find((a) => a.email === 'tok@outlook.com')!.id });
      expect(detail).toMatchObject({ authType: 'oauth2', oauthClientId: 'CID-9', hasRefreshToken: true });
    } finally {
      await t2.cleanup();
    }
  });

  it('exports only selected accounts and never logs the secrets', async () => {
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv('in.csv', toCsv([
        { email: 'a@gmail.com', provider: 'gmail', auth_type: 'password', password: 'secret-aaa', imap_host: 'h', imap_port: '993', imap_secure: 'tls' },
        { email: 'b@gmail.com', provider: 'gmail', auth_type: 'password', password: 'secret-bbb', imap_host: 'h', imap_port: '993', imap_secure: 'tls' },
      ])),
    });
    const all = await t.app.call('accounts.list', {});
    const one = all.find((a) => a.email === 'a@gmail.com')!;
    const out = `${t.dir}/one.csv`;
    expect((await t.app.call('accounts.exportCsvWithCredentials', { path: out, accountIds: [one.id] })).count).toBe(1);
    const csv = fs.readFileSync(out, 'utf8');
    expect(csv).toContain('secret-aaa');
    expect(csv).not.toContain('secret-bbb');
    // ログに平文が出ていない
    const log = t.logs.lines.join('\n');
    expect(log).not.toContain('secret-aaa');
    expect(log).toContain('Exporting accounts WITH credentials');
  });
});

describe('retaining non-essential imported values (oauth2 password column)', () => {
  it('keeps the password-column value on oauth2 accounts and re-exports it', async () => {
    // 取り込み元は email----password----client_id----refresh_token 形式（password は OAuth2 に不要な識別子）
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv('tokens.txt', 'u@outlook.com----zzz9999----CID-1----RT-abc\n'),
    });
    const out = `${t.dir}/creds.csv`;
    expect((await t.app.call('accounts.exportCsvWithCredentials', { path: out })).count).toBe(1);
    const line = fs.readFileSync(out, 'utf8').replace(/^﻿/, '').split('\n')[1].split(',');
    // email,password,provider,auth_type,client_id,client_secret,refresh_token,...
    expect(line[0]).toBe('u@outlook.com');
    expect(line[1]).toBe('zzz9999'); // 取り込んだ password 列の値が残っている
    expect(line[3]).toBe('oauth2');
    expect(line[4]).toBe('CID-1');
    expect(line[6]).toBe('RT-abc');
    // ちょうど往復する: 認証情報なしエクスポートには password は出さない（従来通り）
    const plain = `${t.dir}/plain.csv`;
    await t.app.call('accounts.exportCsv', { path: plain });
    expect(fs.readFileSync(plain, 'utf8')).not.toContain('zzz9999');
  });
})
