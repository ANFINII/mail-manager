import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeMailApiServer } from '../helpers/fake-mail-api';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let api: FakeMailApiServer;
let oauth: FakeOAuthServer;
let t: TestApp;

beforeEach(async () => {
  api = new FakeMailApiServer();
  oauth = new FakeOAuthServer();
  await api.start();
  await oauth.start();
  oauth.setGrant('rt-1', { accessToken: api.token });
  t = await createTestApp({
    env: {
      MM_INITIAL_SYNC_MESSAGES: '0',
      MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl,
      MM_OAUTH_TOKEN_URL_GMAIL: oauth.tokenUrl,
      MM_GRAPH_API_URL: api.graphUrl,
      MM_GMAIL_API_URL: api.gmailUrl,
    },
  });
});
afterEach(async () => {
  await t.cleanup();
  await api.stop();
  await oauth.stop();
});

async function account(email: string, provider: 'outlook' | 'gmail', via: 'graph' | 'gmail_api') {
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv(
      `${email}.csv`,
      toCsv([{ email, provider, auth_type: 'oauth2', client_id: 'cid', client_secret: 'sec', refresh_token: 'rt-1' }]),
    ),
  });
  const a = (await t.app.call('accounts.list', {})).find((x) => x.email === email)!;
  expect(await t.app.call('accounts.setFetchVia', { ids: [a.id], via })).toEqual({ updated: 1, skipped: 0 });
  return a;
}
async function sync() {
  await t.waitForJob((await t.app.call('sync.run', { ids: 'all' })).id);
}
const inbox = async () => (await t.app.call('search.query', { page: 1, pageSize: 50, mailboxPath: 'INBOX' })).items;

describe('fetching over Microsoft Graph', () => {
  it('authenticates, syncs with paging, imports flag changes and removals, and moves / deletes / undoes', async () => {
    const a = await account('u@outlook.com', 'outlook', 'graph');
    for (let i = 1; i <= 5; i++) api.add('f-inbox', makeMessageSpec(i, 'u@outlook.com'), { read: i === 2 });
    api.add('f-sent', makeMessageSpec(6, 'x@example.com'));

    await t.waitForJob((await t.app.call('auth.test', { ids: [a.id] })).id);
    expect((await t.app.call('accounts.get', { id: a.id }))?.authStatus).toBe('ok');
    expect(oauth.stats.lastBody).toContain('Mail.ReadWrite');

    await sync();
    let items = await inbox();
    expect(items).toHaveLength(5);
    expect(items.filter((m) => m.seen)).toHaveLength(1);
    const mailboxes = await t.app.call('mailboxes.list', { accountId: a.id });
    expect(mailboxes.map((m) => m.path).sort()).toEqual(['Archive', 'Deleted Items', 'INBOX', 'Sent Items']);
    expect(mailboxes.find((m) => m.path === 'Sent Items')?.specialUse).toBe('\\Sent');
    const detail = await t.app.call('messages.get', { id: items[0].id });
    expect(detail?.textBody).toContain('body');

    // 差分: 新着だけ取得
    const rawsBefore = api.stats.raws;
    api.add('f-inbox', makeMessageSpec(7, 'u@outlook.com'));
    api.in('f-inbox')[0].read = true;
    api.messages.splice(api.messages.indexOf(api.in('f-inbox')[2]), 1);
    await sync();
    expect(api.stats.raws - rawsBefore).toBe(1);
    items = await inbox();
    expect(items).toHaveLength(5);
    expect(items.filter((m) => m.seen)).toHaveLength(2);

    // 一括操作は API で行う
    const target = items[0];
    await t.waitForJob((await t.app.call('messages.setFlags', { ids: [target.id], flagged: true })).id);
    expect(api.messages.some((m) => m.flagged)).toBe(true);
    await t.waitForJob((await t.app.call('messages.delete', { ids: [target.id] })).id);
    expect(api.in('f-trash')).toHaveLength(1);
    const [op] = await t.app.call('history.list', {});
    expect(await t.app.call('history.undo', { id: op.id })).toEqual({ restored: 1, skipped: 0, failed: 0 });
    expect(api.in('f-trash')).toHaveLength(0);
    expect(api.in('f-inbox')).toHaveLength(5);
  });
});

describe('fetching over the Gmail API', () => {
  it('syncs labels, reads raw messages, and stars / archives via labels', async () => {
    const a = await account('u@gmail.com', 'gmail', 'gmail_api');
    for (let i = 1; i <= 3; i++) api.add('INBOX', makeMessageSpec(i, 'u@gmail.com'), { flagged: i === 3 });
    api.add('Label_1', makeMessageSpec(4, 'u@gmail.com'));
    await sync();
    const items = await inbox();
    expect(items).toHaveLength(3);
    expect(items.filter((m) => m.flagged)).toHaveLength(1);
    expect(items.every((m) => !m.seen)).toBe(true);
    const paths = (await t.app.call('mailboxes.list', { accountId: a.id })).map((m) => m.path).sort();
    expect(paths).toEqual(['INBOX', 'SENT', 'TRASH', 'Work']);

    await t.waitForJob((await t.app.call('messages.setFlags', { ids: [items[0].id], seen: true })).id);
    expect(api.in('INBOX').filter((m) => m.read)).toHaveLength(1);
    await t.waitForJob((await t.app.call('messages.move', { ids: [items[1].id], destination: 'Work' })).id);
    expect(api.in('Label_1')).toHaveLength(2); // ラベル「Work」の ID
    expect(api.in('INBOX')).toHaveLength(2);
  });

  it('refuses API fetching for password accounts and the wrong provider', async () => {
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv('p.csv', toCsv([{ email: 'p@gmail.com', provider: 'gmail', auth_type: 'password', password: 'x' }])),
    });
    const id = (await t.app.call('accounts.list', {}))[0].id;
    expect(await t.app.call('accounts.setFetchVia', { ids: [id], via: 'gmail_api' })).toEqual({ updated: 0, skipped: 1 });
    expect(await t.app.call('accounts.setFetchVia', { ids: [id], via: 'graph' })).toEqual({ updated: 0, skipped: 1 });
  });
});
