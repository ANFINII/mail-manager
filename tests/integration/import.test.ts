import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { generateAccounts, passwordFor, refreshTokenFor, toCsv } from '../helpers/csv-fixtures';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.cleanup();
});

describe('CSV import', () => {
  it('imports 300 accounts within the performance budget and never stores plaintext secrets', async () => {
    const rows = generateAccounts({ count: 300, imapHost: '127.0.0.1', imapPort: 1 });
    const csvPath = t.writeCsv('accounts-300.csv', toCsv(rows));

    const started = Date.now();
    const result = await t.app.call('accounts.importCsv', { path: csvPath });
    const elapsed = Date.now() - started;

    expect(result.imported).toBe(300);
    expect(result.invalid).toEqual([]);
    expect(result.total).toBe(300);
    expect(elapsed).toBeLessThan(5000);

    const list = await t.app.call('accounts.list', {});
    expect(list).toHaveLength(300);
    expect(list.filter((a) => a.authType === 'oauth2')).toHaveLength(150);
    expect(list.filter((a) => a.provider === 'gmail')).toHaveLength(150);
    expect(list.every((a) => a.status === 'untested' && a.enabled)).toBe(true);

    // DB ファイル（WAL 含む）に平文パスワード・トークンが存在しないこと
    await t.app.shutdown();
    const bytes = [t.dbFile, `${t.dbFile}-wal`]
      .filter(fs.existsSync)
      .map((f) => fs.readFileSync(f, 'latin1'))
      .join('');
    expect(bytes.length).toBeGreaterThan(0);
    for (let i = 1; i <= 300; i++) {
      expect(bytes).not.toContain(passwordFor(i));
      expect(bytes).not.toContain(refreshTokenFor(i));
    }
    expect(bytes).not.toContain('-secret');
    // ログにも出ていないこと
    const log = t.logs.lines.join('\n');
    expect(log).not.toContain('-secret');
    expect(log).toContain('CSV import processed');
    // afterEach の shutdown を二重に呼ばないよう差し替える
    t.cleanup = async () => fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it('reports invalid rows with row numbers and allows fixing only those rows', async () => {
    const csv = toCsv([
      { email: 'ok1@gmail.com', password: 'app-pass-1' },
      { email: 'not-an-email', password: 'x', imap_host: 'imap.example.com' },
      { email: 'ok1@gmail.com', password: 'dup' },
      { email: 'nohost@example.com', password: 'x' },
      { email: 'nopass@example.com', imap_host: 'imap.example.com' },
      { email: 'legacy@outlook.com', password: 'basic-auth-not-allowed' },
      { email: 'ok2@outlook.com', client_id: 'cid', refresh_token: 'rt-secret-2' },
    ]);
    const result = await t.app.call('accounts.importCsv', { path: t.writeCsv('mixed.csv', csv) });
    // outlook はパスワード認証を許可するようになったため legacy@outlook.com(行7)も取り込まれる
    expect(result.imported).toBe(3);
    expect(result.invalid.map((r) => [r.row, r.errors])).toEqual([
      [3, ['invalid_email']],
      [4, ['duplicate_in_file']],
      [5, ['missing_imap_host']],
      [6, ['missing_password']],
    ]);
    // 取り込み（再編集）画面で表示・編集できるよう、入力された秘密情報の値は返す。
    // （メモリ上の取り込みセッション限定。DB・ログには平文で残さないことは別テストで担保）
    const dupRow = result.invalid.find((r) => r.row === 4);
    expect(dupRow?.fields.password).toBe('dup');
    expect(dupRow?.fields.has_password).toBe(true);
    expect(result.invalid[3].fields.has_password).toBe(false);
    expect(result.invalid[3].fields.password).toBe('');

    // エラー行だけ修正して再取り込み
    const retry = await t.app.call('accounts.retryImport', {
      sessionId: result.sessionId,
      edits: [
        { row: 3, fields: { email: 'fixed@example.com', imap_host: 'imap.example.com' } },
        {
          row: 5,
          fields: { imap_host: 'imap.example.com', imap_port: '143', imap_secure: 'starttls' },
        },
        { row: 6, fields: { password: 'now-set' } },
      ],
    });
    expect(retry.imported).toBe(3);
    expect(retry.invalid.map((r) => r.row)).toEqual([4]);
    const list = await t.app.call('accounts.list', {});
    expect(list.map((a) => a.email).sort()).toEqual(
      [
        'fixed@example.com',
        'legacy@outlook.com',
        'nohost@example.com',
        'nopass@example.com',
        'ok1@gmail.com',
        'ok2@outlook.com',
      ].sort(),
    );
    expect(list.find((a) => a.email === 'nohost@example.com')).toMatchObject({
      imapPort: 143,
      imapSecure: 'starttls',
    });

    // 重複行の破棄
    await t.app.call('accounts.discardImport', { sessionId: result.sessionId });
    await expect(
      t.app.call('accounts.retryImport', { sessionId: result.sessionId, edits: [] }),
    ).rejects.toThrow(/session/);
  });

  it('rejects emails that already exist in the database', async () => {
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv('a.csv', toCsv([{ email: 'a@gmail.com', password: 'p' }])),
    });
    const r = await t.app.call('accounts.importCsv', {
      path: t.writeCsv('b.csv', toCsv([{ email: 'A@gmail.com', password: 'p' }])),
    });
    expect(r.imported).toBe(0);
    expect(r.invalid[0].errors).toEqual(['duplicate_in_db']);
  });

  it('accepts the dash-separated outlook token format', async () => {
    const r = await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'tokens.txt',
        'a@outlook.com----pw----cid----rt1\nb@hotmail.com----pw----cid----rt2\n',
      ),
    });
    expect(r.imported).toBe(2);
    const detail = await t.app.call('accounts.get', {
      id: (await t.app.call('accounts.list', {}))[0].id,
    });
    expect(detail).toMatchObject({
      authType: 'oauth2',
      oauthClientId: 'cid',
      hasRefreshToken: true,
      hasPassword: false,
    });
  });

  it('deletes, disables and enables accounts', async () => {
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'c.csv',
        toCsv(generateAccounts({ count: 5, imapHost: 'h', imapPort: 993 })),
      ),
    });
    const ids = (await t.app.call('accounts.list', {})).map((a) => a.id);
    expect(
      (await t.app.call('accounts.setEnabled', { ids: ids.slice(0, 2), enabled: false })).updated,
    ).toBe(2);
    expect(await t.app.call('accounts.list', { filter: 'disabled' })).toHaveLength(2);
    expect((await t.app.call('stats.get', {})).disabled).toBe(2);
    expect(
      (await t.app.call('accounts.setEnabled', { ids: ids.slice(0, 1), enabled: true })).updated,
    ).toBe(1);
    expect(await t.app.call('accounts.list', { filter: 'disabled' })).toHaveLength(1);
    expect((await t.app.call('accounts.delete', { ids: ids.slice(0, 3) })).deleted).toBe(3);
    expect(await t.app.call('accounts.list', {})).toHaveLength(2);
    expect(await t.app.call('accounts.list', { search: 'USER005' })).toHaveLength(1);
  });
});
