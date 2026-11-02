import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { generateAccounts, toCsv } from '../helpers/csv-fixtures';
import { buildFtsQuery, type FtsRow, type NewMessageRow } from '@backend/db/message-repository';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.cleanup();
});

const SUBJECTS = [
  'Invoice #{n}',
  '請求書 {n} 月分',
  'Re: meeting notes',
  'Order {n} shipped',
  'Newsletter #{n}',
];
const SENDERS = [
  'billing@vendor.example',
  'taro@example.jp',
  'support@shop.example',
  'news@media.example',
];

/** IMAP を介さず DB に直接メッセージを流し込む（検索性能テスト用） */
async function seedMessages(count: number, accountCount: number): Promise<string[]> {
  const accounts = generateAccounts({ count: accountCount, imapHost: 'h', imapPort: 993 });
  await t.app.call('accounts.importCsv', { path: t.writeCsv('a.csv', toCsv(accounts)) });
  const rows = await t.app.call('accounts.list', {});
  const now = new Date().toISOString();
  const mailboxIds: string[] = [];
  for (const acc of rows) {
    const mbs = await t.app.mailboxRepo.upsertMany(
      acc.id,
      [{ path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: null }],
      now,
    );
    mailboxIds.push(mbs[0].id);
  }
  const base = new Date('2025-01-01T00:00:00Z').getTime();
  const batch: NewMessageRow[] = [];
  const fts: FtsRow[] = [];
  for (let i = 1; i <= count; i++) {
    const accIdx = i % rows.length;
    const id = randomUUID();
    const subject = SUBJECTS[i % SUBJECTS.length].replace('{n}', String(i));
    const from = SENDERS[i % SENDERS.length];
    const body = `Message ${i} body text ${i % 7 === 0 ? 'urgent 至急' : 'ordinary'} 番号${i}`;
    const date = new Date(base + i * 60_000).toISOString();
    batch.push({
      id,
      account_id: rows[accIdx].id,
      mailbox_id: mailboxIds[accIdx],
      remote_uid: i,
      message_id: `<m${i}@x>`,
      in_reply_to: null,
      from_address: from,
      from_name: null,
      to_addresses: JSON.stringify([{ name: null, address: rows[accIdx].email }]),
      cc_addresses: '[]',
      subject,
      text_body: body,
      html_body: null,
      snippet: body.slice(0, 100),
      date,
      internal_date: date,
      size: 1000,
      has_attachments: i % 10 === 0 ? 1 : 0,
      seen: i % 2,
      flagged: 0,
      answered: 0,
      created_at: now,
      updated_at: now,
    });
    fts.push({
      message_id: id,
      subject,
      from_text: from,
      to_text: rows[accIdx].email,
      body,
      attachments: i % 10 === 0 ? `report-${i}.pdf` : '',
    });
    if (batch.length >= 2000) {
      await t.app.messageRepo.insertMany(batch.splice(0), fts.splice(0), []);
    }
  }
  await t.app.messageRepo.insertMany(batch, fts, []);
  return rows.map((r) => r.id);
}

describe('cross-account search', () => {
  it('builds FTS queries with trigram-safe terms', () => {
    expect(buildFtsQuery('invoice 請求書 ab')).toEqual({
      match: '"invoice" "請求書"',
      likeTerms: ['ab'],
    });
    expect(buildFtsQuery('he said hello')).toEqual({ match: '"said" "hello"', likeTerms: ['he'] });
    expect(buildFtsQuery('a"b"c')).toEqual({ match: '"a""b""c"', likeTerms: [] });
  });

  it('アカウント別グループで件数・未読数を集計する', async () => {
    const ids = await seedMessages(30, 3)
    const groups = await t.app.call('search.accountGroups', { page: 1, pageSize: 50 })
    // 3 アカウントすべてに件数が付く
    expect(groups.length).toBe(3)
    const totalSum = groups.reduce((a, g) => a + g.total, 0)
    expect(totalSum).toBe(30)
    for (const g of groups) {
      expect(ids).toContain(g.accountId)
      expect(g.total).toBeGreaterThan(0)
      expect(g.unseen).toBeLessThanOrEqual(g.total)
      expect(g.email).toMatch(/@/)
    }
    // フィルタ（未読のみ）を渡すと未読だけが集計される
    const unseenGroups = await t.app.call('search.accountGroups', {
      unseenOnly: true,
      page: 1,
      pageSize: 50,
    })
    const unseenSum = unseenGroups.reduce((a, g) => a + g.total, 0)
    const allUnseen = groups.reduce((a, g) => a + g.unseen, 0)
    expect(unseenSum).toBe(allUnseen)
  })

  it('宛先（To/Cc）のアドレス・表示名で部分一致フィルタできる', async () => {
    await seedMessages(40, 4);
    const accounts = await t.app.call('accounts.list', {});
    const target = accounts[1].email;
    // seedMessages は i % 4 === accIdx のアカウント宛に to_addresses を入れる → 10 件
    const byTo = await t.app.call('search.query', { to: target, page: 1, pageSize: 100 });
    expect(byTo.total).toBe(10);
    expect(byTo.items.every((m) => m.toAddresses.some((a) => a.address === target))).toBe(true);
    // 大文字小文字を区別せず、部分一致
    const partial = await t.app.call('search.query', {
      to: target.slice(0, 7).toUpperCase(),
      page: 1,
      pageSize: 100,
    });
    expect(partial.total).toBe(10);
    // 一致なし
    expect((await t.app.call('search.query', { to: 'nobody@nowhere.invalid', page: 1, pageSize: 10 })).total).toBe(0);
    // アカウント条件との併用
    const combined = await t.app.call('search.query', {
      to: target,
      accountIds: [accounts[0].id],
      page: 1,
      pageSize: 100,
    });
    expect(combined.total).toBe(0);
  });

  it('日付・アカウントで昇順/降順にソートできる', async () => {
    await seedMessages(20, 3);
    const desc = await t.app.call('search.query', {
      sortBy: 'date',
      sortDir: 'desc',
      page: 1,
      pageSize: 20,
    });
    const asc = await t.app.call('search.query', {
      sortBy: 'date',
      sortDir: 'asc',
      page: 1,
      pageSize: 20,
    });
    const descDates = desc.items.map((m) => m.date ?? '');
    const ascDates = asc.items.map((m) => m.date ?? '');
    expect(descDates).toEqual([...descDates].sort().reverse());
    expect(ascDates).toEqual([...ascDates].sort());
    expect(ascDates[0]).toBe(descDates[descDates.length - 1]);

    const byAcc = await t.app.call('search.query', {
      sortBy: 'account',
      sortDir: 'asc',
      page: 1,
      pageSize: 20,
    });
    const emails = byAcc.items.map((m) => m.accountEmail);
    expect(emails).toEqual([...emails].sort());
  });

  it('searches 100,000 messages across 50 accounts by subject, sender, body, date and account in under a second', async () => {
    const accountIds = await seedMessages(100_000, 50);
    expect((await t.app.call('stats.get', {})).messages).toBe(100_000);

    const timed = async (q: Parameters<typeof t.app.search.query>[0]) => {
      const r = await t.app.search.query(q);
      return r;
    };

    const subject = await timed({ text: 'Invoice', page: 1, pageSize: 50 });
    expect(subject.total).toBe(20_000);
    expect(subject.items).toHaveLength(50);
    expect(subject.items.every((m) => m.subject.includes('Invoice'))).toBe(true);
    expect(subject.tookMs).toBeLessThan(1000);

    const japanese = await timed({ text: '請求書', page: 1, pageSize: 50 });
    expect(japanese.total).toBe(20_000);
    expect(japanese.tookMs).toBeLessThan(1000);

    const sender = await timed({ from: 'taro@example.jp', page: 1, pageSize: 50 });
    expect(sender.total).toBe(25_000);
    expect(sender.tookMs).toBeLessThan(1000);

    const body = await timed({ text: 'urgent', page: 1, pageSize: 50 });
    expect(body.total).toBe(Math.floor(100_000 / 7));
    expect(body.tookMs).toBeLessThan(1000);

    const combined = await timed({ text: 'Invoice', from: 'billing', page: 2, pageSize: 100 });
    expect(
      combined.items.every(
        (m) => m.fromAddress === 'billing@vendor.example' && m.subject.startsWith('Invoice'),
      ),
    ).toBe(true);
    expect(combined.page).toBe(2);

    const byAccount = await timed({ accountIds: accountIds.slice(0, 2), page: 1, pageSize: 50 });
    expect(byAccount.total).toBe(4000);
    expect(byAccount.tookMs).toBeLessThan(1000);

    const byDate = await timed({
      dateFrom: '2025-01-02',
      dateTo: '2025-01-02',
      page: 1,
      pageSize: 50,
    });
    expect(byDate.total).toBeGreaterThan(1000);
    expect(byDate.total).toBeLessThanOrEqual(1440);
    expect(byDate.items.every((m) => m.date!.startsWith('2025-01-0'))).toBe(true);

    const attachments = await timed({
      text: 'report-100',
      hasAttachments: true,
      page: 1,
      pageSize: 50,
    });
    expect(attachments.items.every((m) => m.hasAttachments)).toBe(true);
    expect(attachments.total).toBeGreaterThan(0);

    const exact = await timed({ subject: 'Invoice #12345', page: 1, pageSize: 50 });
    expect(exact.total).toBe(1);
    console.log(
      `search timings ms: subject=${subject.tookMs} ja=${japanese.tookMs} sender=${sender.tookMs} body=${body.tookMs} account=${byAccount.tookMs}`,
    );
  }, 300_000);

  it.skipIf(process.env.MM_BIG_TESTS !== '1')(
    'searches 1,000,000 messages (MM_BIG_TESTS=1)',
    async () => {
      await seedMessages(1_000_000, 300);
      const r = await t.app.search.query({
        text: 'Invoice',
        from: 'billing',
        page: 1,
        pageSize: 50,
      });
      expect(r.total).toBeGreaterThan(0);
      console.log(`1M search took ${r.tookMs}ms`);
      expect(r.tookMs).toBeLessThan(3000);
    },
    1_800_000,
  );

  it('exports search results and accounts to CSV without secrets, and backs up the database', async () => {
    await seedMessages(30, 2);
    const out = path.join(t.dir, 'export.csv');
    const r = await t.app.call('search.exportCsv', {
      query: { text: 'Invoice', page: 1, pageSize: 50 },
      path: out,
    });
    expect(r.count).toBe(6);
    const csv = fs.readFileSync(out, 'utf8');
    expect(csv.split('\n')[0]).toContain('account,folder,date');
    expect(csv).toContain('Invoice #');

    const accountsOut = path.join(t.dir, 'accounts.csv');
    expect((await t.app.call('accounts.exportCsv', { path: accountsOut })).count).toBe(2);
    const accountsCsv = fs.readFileSync(accountsOut, 'utf8');
    expect(accountsCsv).not.toContain('-secret');
    expect(accountsCsv.split('\n')[0]).not.toMatch(
      /password|refresh_token|client_secret|credentials/,
    );

    // 選択したアカウントだけを出力する（accountIds 指定）
    const all = await t.app.call('accounts.list', {});
    const oneOut = path.join(t.dir, 'one.csv');
    const one = await t.app.call('accounts.exportCsv', { path: oneOut, accountIds: [all[0].id] });
    expect(one.count).toBe(1);
    const oneCsv = fs.readFileSync(oneOut, 'utf8').trim().split('\n');
    expect(oneCsv).toHaveLength(2); // ヘッダー + 1 行
    expect(oneCsv[1]).toContain(all[0].email);
    expect(oneCsv[1]).not.toContain(all[1].email);
    // 空配列は「指定なし」と同じで全件（ボタンは選択が無いと押せないので実害なし）
    expect((await t.app.call('accounts.exportCsv', { path: path.join(t.dir, 'none.csv'), accountIds: [] })).count).toBe(2);
    expect((await t.app.call('accounts.exportCsv', { path: path.join(t.dir, 'bad.csv'), accountIds: ['no-such'] })).count).toBe(0);

    const backup = path.join(t.dir, 'backup.sqlite');
    const b = await t.app.call('app.backup', { path: backup });
    expect(b.bytes).toBeGreaterThan(0);
    expect(fs.readFileSync(backup).subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(fs.readFileSync(backup, 'latin1')).not.toContain('-secret');
    expect((await t.app.call('app.restore', { path: backup })).pendingRestart).toBe(true);
    expect(fs.existsSync(`${t.dbFile}.restore-pending`)).toBe(true);
  });
});
