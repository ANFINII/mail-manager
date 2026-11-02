import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { toCsv } from '../helpers/csv-fixtures';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp({ env: { MM_AUDIT_ACTOR: 'tester' } });
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv(
      'accounts.csv',
      toCsv([
        { email: 'a@example.com', provider: 'custom', auth_type: 'password', password: 'TopSecret-pw-1', imap_host: 'h', imap_port: '993', imap_secure: 'tls' },
        { email: 'b@example.com', provider: 'custom', auth_type: 'password', password: 'TopSecret-pw-2', imap_host: 'h', imap_port: '993', imap_secure: 'tls' },
      ]),
    ),
  });
});
afterEach(async () => t.cleanup());

describe('audit log', () => {
  it('records important operations with who / what, never secrets, and skips reads', async () => {
    const ids = (await t.app.call('accounts.list', {})).map((a) => a.id);
    await t.app.call('accounts.exportCsvWithCredentials', { path: `${t.dir}/creds.csv`, accountIds: ids });
    await t.app.call('accounts.updateCredentials', { id: ids[0], update: { password: 'TopSecret-new', testAfterSave: false } });
    await t.app.call('accounts.delete', { ids: [ids[1]] });
    await expect(t.app.call('forwardRules.add', { keyword: 'x', matchField: 'subject', to: 'bad', enabled: true })).rejects.toThrow();
    await t.app.call('accounts.list', {});
    await t.app.call('storage.cleanup', { dryRun: true });

    const log = await t.app.call('audit.list', {});
    expect(log.map((e) => e.action)).toEqual([
      'forwardRules.add',
      'accounts.delete',
      'accounts.updateCredentials',
      'accounts.exportCsvWithCredentials',
      'accounts.importCsv',
    ]);
    expect(log[0]).toMatchObject({ ok: false, actor: 'tester', target: 'x' });
    expect(log[0].error).toMatch(/転送先/);
    expect(log[3]).toMatchObject({ ok: true, target: 'creds.csv', detail: { count: 2, selected: 2 } });
    expect(log[4]).toMatchObject({ target: 'accounts.csv', detail: { imported: 2 } });

    const all = JSON.stringify(await t.app.call('audit.list', {}));
    expect(all).not.toContain('TopSecret');
    const dbBytes = fs.readFileSync(t.dbFile, 'latin1');
    expect(dbBytes.includes('TopSecret-new')).toBe(false);

    expect(await t.app.call('audit.list', { failedOnly: true })).toHaveLength(1);
    expect(await t.app.call('audit.list', { text: 'creds.csv' })).toHaveLength(1);
    expect(await t.app.call('audit.list', { action: 'accounts.delete' })).toHaveLength(1);
  });

  it('accepts records from the main process (lock events)', async () => {
    await t.app.call('audit.record', { action: 'lock.unlock', ok: false, error: 'パスコードが違います' });
    expect((await t.app.call('audit.list', {}))[0]).toMatchObject({ action: 'lock.unlock', ok: false });
  });
});
