import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

const EMAIL = 'u@example.com';
let imap: FakeImapServer;
let t: TestApp;

afterEach(async () => {
  await t?.cleanup();
  await imap?.stop();
});

async function setup(opts: { condstore: boolean; env?: NodeJS.ProcessEnv }) {
  imap = new FakeImapServer({ condstore: opts.condstore });
  await imap.start();
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0', ...(opts.env ?? {}) } });
  imap.setUser(EMAIL, { password: 'pw' });
  for (let i = 1; i <= 5; i++) imap.addMessage(EMAIL, 'INBOX', makeMessageSpec(i, EMAIL));
  await t.app.call('accounts.importCsv', {
    path: t.writeCsv(
      'a.csv',
      toCsv([
        {
          email: EMAIL,
          provider: 'custom',
          auth_type: 'password',
          password: 'pw',
          imap_host: '127.0.0.1',
          imap_port: String(imap.port),
          imap_secure: 'none',
        },
      ]),
    ),
  });
  await sync();
}

async function sync() {
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id);
}

async function bySubjectNo() {
  const r = await t.app.call('search.query', { page: 1, pageSize: 50, mailboxPath: 'INBOX' });
  // makeMessageSpec(i) の日付は 2026-01-01T00:00Z + i 時間（= UID）
  const base = Date.parse('2026-01-01T00:00:00Z');
  return new Map(r.items.map((m) => [Math.round((Date.parse(m.date!) - base) / 3_600_000), m]));
}

describe.each([
  { condstore: false, label: 'without CONDSTORE' },
  { condstore: true, label: 'with CONDSTORE' },
])('server-side changes $label', ({ condstore }) => {
  it('imports read/flag changes and removals made by another client', async () => {
    await setup({ condstore });
    const before = await bySubjectNo();
    expect(before.get(1)?.seen).toBe(false);
    const seenUid = 1;
    const wasSeen = [...before.values()].find((m) => m.seen); // fixture marks some as seen
    expect(wasSeen).toBeDefined();
    const wasSeenNo = [...before.entries()].find(([, m]) => m === wasSeen)![0];

    const events: Array<{ ids: string[]; deleted?: boolean }> = [];
    t.app.onEvent((ev) => {
      if (ev.type === 'messages.changed') events.push({ ids: ev.ids, deleted: ev.deleted });
    });

    imap.setFlags(EMAIL, 'INBOX', seenUid, ['\\Seen', '\\Flagged']);
    imap.setFlags(EMAIL, 'INBOX', wasSeenNo, []);
    imap.removeMessage(EMAIL, 'INBOX', 5);
    const changedSinceBefore = imap.stats.changedSinceFetches;
    await sync();

    const after = await bySubjectNo();
    expect(after.get(1)).toMatchObject({ seen: true, flagged: true });
    expect(after.get(wasSeenNo)?.seen).toBe(false);
    expect(after.has(5)).toBe(false);
    expect(after.size).toBe(4);
    expect(events.some((e) => e.deleted && e.ids.includes(before.get(5)!.id))).toBe(true);
    expect(events.some((e) => !e.deleted && e.ids.includes(before.get(1)!.id))).toBe(true);
    if (condstore) expect(imap.stats.changedSinceFetches).toBeGreaterThan(changedSinceBefore);

    // 変化が無ければ CONDSTORE ではフラグを取りに行かない
    if (condstore) {
      const fetched = imap.stats.fetchedMessages;
      await sync();
      expect(imap.stats.fetchedMessages).toBe(fetched);
    }
  });

  it('can be turned off with syncFlagChanges = false', async () => {
    await setup({ condstore, env: { MM_SYNC_FLAG_CHANGES: '0' } });
    imap.setFlags(EMAIL, 'INBOX', 1, ['\\Seen']);
    imap.removeMessage(EMAIL, 'INBOX', 2);
    await sync();
    const after = await bySubjectNo();
    expect(after.get(1)?.seen).toBe(false);
    expect(after.has(2)).toBe(true);
  });
});
