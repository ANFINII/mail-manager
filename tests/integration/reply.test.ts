import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeSmtpServer } from '../helpers/fake-smtp-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';
import { renderTemplate, replySubject } from '@shared/template';

const EMAIL = 'me@example.com';
let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let t: TestApp;

beforeEach(async () => {
  imap = new FakeImapServer();
  smtp = new FakeSmtpServer({ passwords: { [EMAIL]: 'pw' } });
  await imap.start();
  await smtp.start();
  imap.setUser(EMAIL, { password: 'pw' });
  imap.addMessage(EMAIL, 'INBOX', {
    ...makeMessageSpec(1, EMAIL),
    from: { name: '山田 太郎', address: 'taro@example.jp' },
    to: [{ address: EMAIL }, { address: 'colleague@example.com' }],
    subject: '打ち合わせの件',
    text: '来週の打ち合わせは火曜でどうでしょう。\nよろしくお願いします。',
    html: undefined,
    messageId: '<orig-1@example.jp>',
  });
  t = await createTestApp({ env: { MM_INITIAL_SYNC_MESSAGES: '0' } });
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
          smtp_host: '127.0.0.1',
          smtp_port: String(smtp.port),
          smtp_secure: 'none',
        },
      ]),
    ),
  });
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id);
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await smtp.stop();
});

const original = async () => (await t.app.call('search.query', { page: 1, pageSize: 1, mailboxPath: 'INBOX' })).items[0];

describe('reply', () => {
  it('replies to the sender with threading headers, quote, Sent copy and \\Answered', async () => {
    const msg = await original();
    const r = await t.app.call('messages.reply', {
      id: msg.id,
      text: '承知しました。火曜でお願いします。',
      quote: true,
      quoteHeader: '2026/1/1 山田 太郎 のメッセージ:',
    });
    expect(r.savedToSent).toBe(true);
    expect(smtp.received).toHaveLength(1);
    const sent = smtp.received[0];
    expect(sent.to).toEqual(['taro@example.jp']);
    expect(sent.data).toMatch(/In-Reply-To: <orig-1@example\.jp>/);
    expect(sent.data).toMatch(/References: <orig-1@example\.jp>/);
    expect(sent.data).toMatch(/Subject: =\?UTF-8\?|Subject: Re:/);
    const sentCopy = imap.mailbox(EMAIL, 'Sent').messages[0];
    expect(sentCopy.raw.toString()).toContain('In-Reply-To: <orig-1@example.jp>');
    // 元メールに返信済みの印
    for (let i = 0; i < 50 && !imap.mailbox(EMAIL, 'INBOX').messages[0].flags.has('\\Answered'); i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(imap.mailbox(EMAIL, 'INBOX').messages[0].flags.has('\\Answered')).toBe(true);
  });

  it('reply-all puts the other recipients in Cc and never includes myself', async () => {
    const msg = await original();
    await t.app.call('messages.reply', { id: msg.id, text: 'ok', replyAll: true });
    const sent = smtp.received[0];
    expect(sent.to.sort()).toEqual(['colleague@example.com', 'taro@example.jp']);
    expect(sent.data).toMatch(/Cc: colleague@example\.com/);
    expect(sent.data).not.toMatch(/Cc:.*me@example\.com/);
  });
});

describe('templates', () => {
  it('saves, updates, lists and removes templates', async () => {
    let list = await t.app.call('templates.save', { name: 'お礼', subject: 'ありがとうございました', body: '{{from_name}} 様\n\nありがとうございました。' });
    expect(list).toHaveLength(1);
    list = await t.app.call('templates.save', { id: list[0].id, name: 'お礼', body: '{{from_name}} 様、感謝します' });
    expect(list[0].body).toBe('{{from_name}} 様、感謝します');
    await expect(t.app.call('templates.save', { name: ' ' })).rejects.toThrow(/テンプレート名/);
    expect(await t.app.call('templates.remove', { id: list[0].id })).toEqual([]);
  });

  it('renders variables and reply subjects', () => {
    expect(renderTemplate('{{ from_name }} 様 / {{account}} / {{unknown}}', { from_name: '山田', account: 'me@x' })).toBe('山田 様 / me@x / ');
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('返信: こんにちは')).toBe('返信: こんにちは');
  });
});
