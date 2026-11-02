import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { toCsv } from '../helpers/csv-fixtures';
import { normalizeTags } from '@backend/accounts/account-service';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv(
      'a.csv',
      toCsv(
        ['a@example.com', 'b@example.com', 'c@example.com'].map((email) => ({
          email,
          provider: 'custom',
          auth_type: 'password',
          password: 'pw',
          imap_host: '127.0.0.1',
          imap_port: '1',
          imap_secure: 'none',
        })),
      ),
    ),
  });
});
afterEach(async () => t.cleanup());

const byEmail = async () => new Map((await t.app.call('accounts.list', {})).map((a) => [a.email, a]));

describe('account tags and notes', () => {
  it('normalizes tags', () => {
    expect(normalizeTags([' 営業 ', 'VIP', 'vip', '', 'a  b'])).toEqual(['a b', 'VIP', '営業']);
  });

  it('adds and removes tags in bulk and counts them', async () => {
    const m = await byEmail();
    const ids = [m.get('a@example.com')!.id, m.get('b@example.com')!.id];
    const events: string[][] = [];
    t.app.onEvent((ev) => {
      if (ev.type === 'accounts.updated') events.push(ev.accounts.map((a) => a.tags.join(',')));
    });
    expect(await t.app.call('accounts.updateTags', { ids, add: ['VIP', '期限 2026-12'] })).toEqual({ updated: 2 });
    expect(await t.app.call('accounts.updateTags', { ids, add: ['vip'] })).toEqual({ updated: 0 }); // 既にある
    await t.app.call('accounts.updateTags', { ids: [ids[1]], remove: ['VIP'] });
    const after = await byEmail();
    expect(after.get('a@example.com')!.tags).toEqual(['VIP', '期限 2026-12']);
    expect(after.get('b@example.com')!.tags).toEqual(['期限 2026-12']);
    expect(after.get('c@example.com')!.tags).toEqual([]);
    expect(await t.app.call('accounts.tags', {})).toEqual([
      { tag: 'VIP', count: 1 },
      { tag: '期限 2026-12', count: 2 },
    ]);
    expect(events[0]).toEqual(['VIP,期限 2026-12', 'VIP,期限 2026-12']);
  });

  it('saves a note and keeps tags when the account is updated elsewhere', async () => {
    const a = (await byEmail()).get('a@example.com')!;
    await t.app.call('accounts.updateTags', { ids: [a.id], add: ['営業'] });
    expect((await t.app.call('accounts.setNote', { id: a.id, note: '担当: 佐藤\n2026/12 解約予定' })).note).toBe('担当: 佐藤\n2026/12 解約予定');
    await t.app.call('accounts.setEnabled', { ids: [a.id], enabled: false });
    const after = (await byEmail()).get('a@example.com')!;
    expect(after).toMatchObject({ tags: ['営業'], note: '担当: 佐藤\n2026/12 解約予定', enabled: false });
    expect((await t.app.call('accounts.setNote', { id: a.id, note: '  ' })).note).toBeNull();
  });
});
