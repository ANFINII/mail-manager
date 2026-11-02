import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { FakeImapServer } from '../helpers/fake-imap-server';

let server: FakeImapServer;

beforeEach(async () => {
  server = new FakeImapServer({ users: { 'a@example.com': { password: 'p' } } });
  await server.start();
  server.addMessage('a@example.com', 'INBOX', {
    from: { name: '山田 太郎', address: 'taro@example.jp' },
    to: [{ address: 'a@example.com' }],
    subject: '請求書 Invoice #123',
    date: new Date('2026-09-01T10:00:00Z'),
    text: 'こんにちは。\n請求書を添付します。',
    html: '<p>こんにちは。<b>請求書</b>を添付します。<img src="http://x/y.png"></p><script>alert(1)</script>',
    attachments: [
      {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('%PDF-1.4 fake'),
      },
    ],
  });
  server.addMessage('a@example.com', 'INBOX', {
    from: { address: 'b@example.com' },
    to: [{ address: 'a@example.com' }],
    subject: 'plain',
    date: new Date('2026-09-02T10:00:00Z'),
    text: 'plain text only',
    flags: ['\\Seen'],
  });
});
afterEach(async () => {
  await server.stop();
});

async function connect(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: '127.0.0.1',
    port: server.port,
    secure: false,
    auth: { user: 'a@example.com', pass: 'p' },
    logger: false,
    emitLogs: false,
  });
  await client.connect();
  return client;
}

describe('fake IMAP server works with ImapFlow', () => {
  it('lists mailboxes, opens, searches, fetches and downloads', async () => {
    const client = await connect();
    try {
      const list = await client.list();
      expect(list.map((l) => l.path).sort()).toEqual(['INBOX', 'Junk', 'Sent', 'Trash']);
      expect(list.find((l) => l.path === 'Trash')?.specialUse).toBe('\\Trash');

      const mb = await client.mailboxOpen('INBOX', { readOnly: true });
      expect(mb.exists).toBe(2);
      expect(mb.uidNext).toBe(3);
      const uids = (await client.search({ uid: '1:*' }, { uid: true })) || [];
      expect(uids).toEqual([1, 2]);
      const newer = await client.search({ uid: '2:*' }, { uid: true });
      expect(newer).toEqual([2]);

      const messages = [];
      for await (const msg of client.fetch(
        uids,
        {
          uid: true,
          envelope: true,
          bodyStructure: true,
          flags: true,
          size: true,
          internalDate: true,
          source: true,
        },
        { uid: true },
      )) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(2);
      const first = messages[0];
      expect(first.uid).toBe(1);
      expect(first.envelope?.subject).toBe('請求書 Invoice #123');
      expect(first.envelope?.from?.[0]).toMatchObject({
        name: '山田 太郎',
        address: 'taro@example.jp',
      });
      expect(first.bodyStructure?.type).toBe('multipart/mixed');
      expect(first.bodyStructure?.childNodes?.[1]?.disposition).toBe('attachment');
      expect(first.bodyStructure?.childNodes?.[1]?.dispositionParameters?.filename).toBe(
        'invoice.pdf',
      );
      expect(first.size).toBe(first.source?.length);
      expect(messages[1].flags?.has('\\Seen')).toBe(true);

      const parsed = await simpleParser(first.source!);
      expect(parsed.subject).toBe('請求書 Invoice #123');
      expect(parsed.text?.trim()).toBe('こんにちは。\n請求書を添付します。');
      expect(parsed.html).toContain('<b>請求書</b>');
      expect(parsed.attachments[0]).toMatchObject({
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
      });
      expect(parsed.attachments[0].content.toString()).toBe('%PDF-1.4 fake');

      // 部分取得（download はチャンク分割で BODY.PEEK[part]<start.len> を使う）
      const dl = await client.download('1', '1.2', { uid: true, chunkSize: 16 });
      const chunks: Buffer[] = [];
      for await (const c of dl.content) chunks.push(Buffer.from(c));
      expect(dl.meta.contentType).toBe('text/html');
      expect(Buffer.concat(chunks).toString('utf8')).toContain('<b>請求書</b>');
      const att = await client.download('1', '2', { uid: true });
      const attChunks: Buffer[] = [];
      for await (const c of att.content) attChunks.push(Buffer.from(c));
      expect(Buffer.concat(attChunks).toString()).toBe('%PDF-1.4 fake');
      expect(att.meta.filename).toBe('invoice.pdf');

      // source を先頭だけ取る
      const partial = await client.fetchOne(
        '2',
        { source: { start: 0, maxLength: 20 } },
        { uid: true },
      );
      expect(partial && partial.source?.length).toBe(20);
    } finally {
      await client.logout();
    }
  });

  it('stores flags, moves to Trash and expunges', async () => {
    const client = await connect();
    try {
      await client.mailboxOpen('INBOX');
      await client.messageFlagsAdd('1', ['\\Seen'], { uid: true });
      expect(server.mailbox('a@example.com').messages[0].flags.has('\\Seen')).toBe(true);
      await client.messageFlagsRemove('1', ['\\Seen'], { uid: true });
      expect(server.mailbox('a@example.com').messages[0].flags.has('\\Seen')).toBe(false);

      const moved = await client.messageMove('1', 'Trash', { uid: true });
      expect(moved).toBeTruthy();
      expect(server.mailbox('a@example.com').messages.map((m) => m.uid)).toEqual([2]);
      expect(server.mailbox('a@example.com', 'Trash').messages).toHaveLength(1);

      await client.messageDelete('2', { uid: true });
      expect(server.mailbox('a@example.com').messages).toHaveLength(0);
    } finally {
      await client.logout();
    }
  });
});
