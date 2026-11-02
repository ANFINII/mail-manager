import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let imap: FakeImapServer;
let oauth: FakeOAuthServer;
let t: TestApp;
beforeEach(async () => {
  imap = new FakeImapServer();
  oauth = new FakeOAuthServer();
  await imap.start();
  await oauth.start();
  t = await createTestApp({ env: { MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl, MM_INITIAL_SYNC_MESSAGES: '0' } });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await oauth.stop();
});

describe('re-import in update mode', () => {
  it('updates credentials of existing accounts without deleting their mail or group', async () => {
    // token 形式で取り込み（password はまだ保持していない旧データを模す: password 空）
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv('v1.csv', toCsv([
        { email: 'u@outlook.com', provider: 'outlook', auth_type: 'oauth2', client_id: 'CID', refresh_token: 'RT-1', imap_host: '127.0.0.1', imap_port: String(imap.port), imap_secure: 'none' },
      ])),
    });
    const [a] = await t.app.call('accounts.list', {});
    // グループに入れ、メールを1通同期しておく
    const [g] = await t.app.call('groups.create', { name: 'G' });
    await t.app.call('accounts.setGroup', { ids: [a.id], groupId: g.id });
    imap.setUser('u@outlook.com', { accessToken: 'AT-1' });
    oauth.setGrant('RT-1', { accessToken: 'AT-1' });
    imap.addMessage('u@outlook.com', 'INBOX', makeMessageSpec(1, 'u@outlook.com'));
    const sync = await t.app.call('sync.run', { ids: 'all' });
    await t.waitForJob(sync.id, 30_000);
    expect((await t.app.call('stats.get', {})).messages).toBe(1);

    // 更新モード OFF なら重複エラー
    const dup = await t.app.call('accounts.importCsv', {
      path: t.writeCsv('again.csv', 'u@outlook.com----keepme----CID----RT-2\n'),
    });
    expect(dup.imported).toBe(0);
    expect(dup.updated).toBe(0);
    expect(dup.invalid[0].errors).toContain('duplicate_in_db');

    // 更新モード ON: password 保持 + refresh_token 差し替え。件数は imported 0 / updated 1
    const upd = await t.app.call('accounts.importCsv', {
      path: t.writeCsv('upd.csv', 'u@outlook.com----keepme----CID----RT-2\n'),
      updateExisting: true,
    });
    expect(upd).toMatchObject({ imported: 0, updated: 1 });
    expect(upd.invalid).toEqual([]);

    // 同じアカウント（ID 不変）、メールとグループは保持、認証状態は未テストに戻る
    const list = await t.app.call('accounts.list', {});
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(a.id);
    expect(list[0].groupId).toBe(g.id);
    expect(list[0].authStatus).toBe('untested');
    expect((await t.app.call('stats.get', {})).messages).toBe(1);

    // 認証情報つきエクスポートに、保持した password と新しい refresh_token が出る
    const out = `${t.dir}/e.csv`;
    await t.app.call('accounts.exportCsvWithCredentials', { path: out, accountIds: [a.id] });
    const fs = await import('node:fs');
    const line = fs.readFileSync(out, 'utf8').replace(/^﻿/, '').split('\n')[1].split(',');
    expect(line[1]).toBe('keepme'); // password
    expect(line[6]).toBe('RT-2'); // refresh_token 差し替え済み

    // 新しいトークンで認証が通る
    imap.setUser('u@outlook.com', { accessToken: 'AT-2' });
    oauth.setGrant('RT-2', { accessToken: 'AT-2' });
    const auth = await t.app.call('auth.test', { ids: [a.id] });
    await t.waitForJob(auth.id, 30_000);
    expect((await t.app.call('accounts.get', { id: a.id }))!.authStatus).toBe('ok');
  }, 60_000);
});
