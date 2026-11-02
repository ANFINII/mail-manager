import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEvent } from '@shared/api';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { generateAccounts, toCsv } from '../helpers/csv-fixtures';

let t: TestApp;
let events: BackendEvent[];
beforeEach(async () => {
  t = await createTestApp();
  events = [];
  t.app.onEvent((ev) => events.push(ev));
});
afterEach(async () => {
  await t.cleanup();
});

async function importAccounts(count: number, groupId?: string | null, groupOf?: (i: number) => string) {
  const rows = generateAccounts({ count, imapHost: '127.0.0.1', imapPort: 1 });
  if (groupOf) rows.forEach((r, i) => (r.group = groupOf(i + 1)));
  const r = await t.app.call('accounts.importCsv', {
    path: t.writeCsv(`accounts-${Date.now()}-${Math.random()}.csv`, toCsv(rows)),
    groupId,
  });
  expect(r.invalid).toEqual([]);
  return r;
}

describe('account groups', () => {
  it('creates, renames and deletes groups; names are unique (case-insensitive)', async () => {
    let groups = await t.app.call('groups.create', { name: '  店舗A ' });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: '店舗A', accountCount: 0 });
    await expect(t.app.call('groups.create', { name: '店舗a' })).rejects.toThrow(/既にあります/);
    await expect(t.app.call('groups.create', { name: '   ' })).rejects.toThrow(/入力/);

    groups = await t.app.call('groups.create', { name: 'B' });
    expect(groups.map((g) => g.name)).toEqual(['B', '店舗A']);

    const a = groups.find((g) => g.name === '店舗A')!;
    groups = await t.app.call('groups.rename', { id: a.id, name: '店舗A2' });
    expect(groups.find((g) => g.id === a.id)?.name).toBe('店舗A2');
    await expect(t.app.call('groups.rename', { id: a.id, name: 'b' })).rejects.toThrow(/既にあります/);

    groups = await t.app.call('groups.remove', { id: a.id });
    expect(groups.map((g) => g.name)).toEqual(['B']);
    await expect(t.app.call('groups.remove', { id: a.id })).rejects.toThrow(/見つかりません/);
    expect(events.filter((e) => e.type === 'groups.changed').length).toBeGreaterThanOrEqual(4);
  });

  it('import puts every account into the chosen default group', async () => {
    const [g] = await t.app.call('groups.create', { name: 'batch-1' });
    await importAccounts(10, g.id);
    const list = await t.app.call('accounts.list', {});
    expect(list).toHaveLength(10);
    expect(list.every((a) => a.groupId === g.id)).toBe(true);
    expect((await t.app.call('groups.list', {}))[0]).toMatchObject({ name: 'batch-1', accountCount: 10 });
    // 不正なグループ ID は拒否
    await expect(
      t.app.call('accounts.importCsv', {
        path: t.writeCsv('x.csv', toCsv(generateAccounts({ count: 1, imapHost: 'h', imapPort: 1 }))),
        groupId: 'no-such-group',
      }),
    ).rejects.toThrow(/見つかりません/);
  });

  it('a group column in the CSV wins over the default and creates missing groups', async () => {
    const [def] = await t.app.call('groups.create', { name: 'default' });
    // 1〜3 行目は group 列あり（2 種類、うち "default" は既存）、4〜6 行目は空 → 既定グループ
    await importAccounts(6, def.id, (i) => (i <= 2 ? 'shop-A' : i === 3 ? 'Default' : ''));
    const groups = await t.app.call('groups.list', {});
    expect(groups.map((g) => [g.name, g.accountCount])).toEqual([
      ['default', 4],
      ['shop-A', 2],
    ]);
    const shopA = groups.find((g) => g.name === 'shop-A')!;
    expect(await t.app.call('accounts.list', { groupId: shopA.id })).toHaveLength(2);
    expect(await t.app.call('accounts.list', { groupId: def.id })).toHaveLength(4);
    expect(await t.app.call('accounts.list', { groupId: 'none' })).toHaveLength(0);
  });

  it('retrying fixed rows keeps the default group of the import session', async () => {
    const [g] = await t.app.call('groups.create', { name: 'retry' });
    const rows = generateAccounts({ count: 2, imapHost: '127.0.0.1', imapPort: 1 });
    rows[1].email = 'broken';
    const r = await t.app.call('accounts.importCsv', {
      path: t.writeCsv('retry.csv', toCsv(rows)),
      groupId: g.id,
    });
    expect(r.imported).toBe(1);
    expect(r.invalid).toHaveLength(1);
    expect(r.invalid[0].fields.group).toBe('');
    const r2 = await t.app.call('accounts.retryImport', {
      sessionId: r.sessionId,
      edits: [{ row: r.invalid[0].row, fields: { email: 'fixed@gmail.com' } }],
    });
    expect(r2.imported).toBe(1);
    const list = await t.app.call('accounts.list', {});
    expect(list.every((a) => a.groupId === g.id)).toBe(true);
  });

  it('moves accounts between groups, filters by group, and un-groups on delete', async () => {
    await importAccounts(6);
    const list = await t.app.call('accounts.list', {});
    expect(list.every((a) => a.groupId === null)).toBe(true);
    let groups = await t.app.call('groups.create', { name: 'G1' });
    groups = await t.app.call('groups.create', { name: 'G2' });
    const g1 = groups.find((g) => g.name === 'G1')!;
    const g2 = groups.find((g) => g.name === 'G2')!;

    const ids = list.map((a) => a.id);
    expect(await t.app.call('accounts.setGroup', { ids: ids.slice(0, 4), groupId: g1.id })).toEqual({ updated: 4 });
    expect(await t.app.call('accounts.setGroup', { ids: ids.slice(4), groupId: g2.id })).toEqual({ updated: 2 });
    await expect(t.app.call('accounts.setGroup', { ids: ids.slice(0, 1), groupId: 'nope' })).rejects.toThrow(
      /見つかりません/,
    );

    expect(await t.app.call('accounts.list', { groupId: g1.id })).toHaveLength(4);
    expect(await t.app.call('accounts.list', { groupId: g2.id })).toHaveLength(2);
    expect(await t.app.call('accounts.list', { groupId: 'none' })).toHaveLength(0);
    groups = await t.app.call('groups.list', {});
    expect(groups.map((g) => [g.name, g.accountCount])).toEqual([
      ['G1', 4],
      ['G2', 2],
    ]);
    // accounts.updated が groupId 付きで届く
    const updated = events.filter((e) => e.type === 'accounts.updated').at(-1);
    expect(updated && updated.type === 'accounts.updated' && updated.accounts.every((a) => a.groupId === g2.id)).toBe(
      true,
    );

    // 1 件をグループから外す
    expect(await t.app.call('accounts.setGroup', { ids: ids.slice(0, 1), groupId: null })).toEqual({ updated: 1 });
    expect(await t.app.call('accounts.list', { groupId: 'none' })).toHaveLength(1);

    // グループ削除 → 所属アカウントは残り、未所属になる
    groups = await t.app.call('groups.remove', { id: g1.id });
    expect(groups.map((g) => g.name)).toEqual(['G2']);
    const after = await t.app.call('accounts.list', {});
    expect(after).toHaveLength(6);
    expect(after.filter((a) => a.groupId === null)).toHaveLength(4);
    expect(after.filter((a) => a.groupId === g2.id)).toHaveLength(2);
  });

  it('exports the group name in the accounts CSV', async () => {
    const [g] = await t.app.call('groups.create', { name: 'exported' });
    await importAccounts(2, g.id);
    const p = `${t.dir}/accounts.csv`;
    expect(await t.app.call('accounts.exportCsv', { path: p })).toEqual({ count: 2 });
    const fs = await import('node:fs');
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    expect(lines[0]).toContain('email,group,provider');
    expect(lines[1].split(',')[1]).toBe('exported');
  });
});
