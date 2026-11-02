import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeSmtpServer } from '../helpers/fake-smtp-server';
import { FakeGraphServer } from '../helpers/fake-graph-server';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import { toCsv } from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

let imap: FakeImapServer;
let smtp: FakeSmtpServer;
let oauth: FakeOAuthServer;
let graph!: FakeGraphServer;
let t: TestApp;

beforeEach(async () => {
  imap = new FakeImapServer();
  smtp = new FakeSmtpServer({
    passwords: { 'sender@example.com': 'pw' },
    tokens: { 'out@example.com': 'AT-smtp' },
  });
  oauth = new FakeOAuthServer();
  graph = new FakeGraphServer();
  graph.mode = 'reject'; // 既定では Graph 不可 → SMTP にフォールバックする
  await imap.start();
  await smtp.start();
  await oauth.start();
  await graph.start();
  t = await createTestApp({
    env: {
      MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl,
      MM_GRAPH_SEND_URL_OUTLOOK: graph.sendUrl,
      MM_INITIAL_SYNC_MESSAGES: '0',
    },
  });
});
afterEach(async () => {
  await t.cleanup();
  await imap.stop();
  await smtp.stop();
  await oauth.stop();
  await graph.stop();
});

async function syncFirst(email: string): Promise<void> {
  const job = await t.app.call('sync.run', { ids: 'all' });
  await t.waitForJob(job.id, 60_000);
  expect((await t.app.call('accounts.list', {})).find((a) => a.email === email)?.status).toBe(
    'connected',
  );
}

describe('forwarding via SMTP', () => {
  it('forwards a password account message to a specific address, with subject, body and attachment', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    imap.addMessage('sender@example.com', 'INBOX', makeMessageSpec(10, 'sender@example.com')); // 10 has attachment
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email: 'sender@example.com',
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
    await syncFirst('sender@example.com');
    const msg = (await t.app.call('search.query', { page: 1, pageSize: 1 })).items[0];

    const res = await t.app.call('messages.forward', { ids: [msg.id], to: 'dest@target.example' });
    expect(res.queued).toBe(1);
    expect(res.skipped).toBe(0);
    const finished = await t.waitForJob(res.job.id, 30_000);
    expect(finished).toMatchObject({ succeeded: 1, failed: 0 });

    expect(smtp.received).toHaveLength(1);
    const sent = smtp.received[0];
    expect(sent.from).toBe('sender@example.com');
    expect(sent.to).toContain('dest@target.example');
    expect(sent.authMethod).toBe('LOGIN');
    expect(sent.data).toMatch(/Subject:.*Fwd/i);
    expect(sent.data).toContain('dest@target.example');
    // 添付が転送に含まれる
    expect(sent.data.toLowerCase()).toContain('report-10.pdf');
    // 秘密情報がログに出ない
    expect(t.logs.lines.join('\n')).not.toContain('AT-smtp');
    expect(t.logs.lines.join('\n')).toContain('Forwarded message');
  }, 60_000);

  it('forwards an OAuth2 (Outlook) account message using an SMTP-scoped XOAUTH2 token', async () => {
    imap.setUser('out@hotmail.com', { accessToken: 'AT-token' });
    imap.addMessage('out@hotmail.com', 'INBOX', makeMessageSpec(3, 'out@hotmail.com'));
    // fake OAuth はスコープに関わらず同じ accessToken を返す。IMAP も SMTP もこのトークンを受け付ける
    oauth.setGrant('rt-out', { accessToken: 'AT-token' });
    smtp = new FakeSmtpServer({ tokens: { 'out@hotmail.com': 'AT-token' } });
    const smtpPort = await smtp.start();
    // provider=outlook で imap/smtp を fake に向ける（OAuth プリセットの smtpScope とトークン URL を使う）
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'o.csv',
        toCsv([
          {
            email: 'out@hotmail.com',
            provider: 'outlook',
            auth_type: 'oauth2',
            client_id: 'cid',
            refresh_token: 'rt-out',
            imap_host: '127.0.0.1',
            imap_port: String(imap.port),
            imap_secure: 'none',
            smtp_host: '127.0.0.1',
            smtp_port: String(smtpPort),
            smtp_secure: 'none',
          },
        ]),
      ),
    });
    await syncFirst('out@hotmail.com');
    const msg = (await t.app.call('search.query', { page: 1, pageSize: 1 })).items[0];
    const res = await t.app.call('messages.forward', { ids: [msg.id], to: 'dest@target.example' });
    expect(res.queued).toBe(1);
    expect(res.skipped).toBe(0);
    const finished = await t.waitForJob(res.job.id, 30_000);
    expect(finished).toMatchObject({ succeeded: 1, failed: 0 });
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0].authMethod).toBe('XOAUTH2');
    expect(smtp.received[0].to).toContain('dest@target.example');
    // SMTP スコープでトークンを取り直している（IMAP と合わせて 2 回）
    expect(oauth.stats.byRefreshToken['rt-out']).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('rejects an invalid destination address', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    imap.addMessage('sender@example.com', 'INBOX', makeMessageSpec(1, 'sender@example.com'));
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email: 'sender@example.com',
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
    await syncFirst('sender@example.com');
    const msg = (await t.app.call('search.query', { page: 1, pageSize: 1 })).items[0];
    await expect(
      t.app.call('messages.forward', { ids: [msg.id], to: 'not-an-email' }),
    ).rejects.toThrow();
    expect(smtp.received).toHaveLength(0);
  }, 60_000);

  it('reports a failure when SMTP auth is rejected', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    imap.addMessage('sender@example.com', 'INBOX', makeMessageSpec(1, 'sender@example.com'));
    const badSmtp = new FakeSmtpServer({ passwords: { 'sender@example.com': 'different' } });
    await badSmtp.start();
    try {
      await t.app.call('accounts.importCsv', {
        path: t.writeCsv(
          'a.csv',
          toCsv([
            {
              email: 'sender@example.com',
              provider: 'custom',
              auth_type: 'password',
              password: 'pw',
              imap_host: '127.0.0.1',
              imap_port: String(imap.port),
              imap_secure: 'none',
              smtp_host: '127.0.0.1',
              smtp_port: String(badSmtp.port),
              smtp_secure: 'none',
            },
          ]),
        ),
      });
      await syncFirst('sender@example.com');
      const msg = (await t.app.call('search.query', { page: 1, pageSize: 1 })).items[0];
      const res = await t.app.call('messages.forward', {
        ids: [msg.id],
        to: 'dest@target.example',
      });
      const finished = await t.waitForJob(res.job.id, 30_000);
      expect(finished).toMatchObject({ succeeded: 0, failed: 1 });
      expect(badSmtp.stats.authFailures).toBeGreaterThan(0);
    } finally {
      await badSmtp.stop();
    }
  }, 60_000);

  it('does not forward the same message to the same address twice, and supports forward-all', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    for (let i = 1; i <= 5; i++)
      imap.addMessage('sender@example.com', 'INBOX', makeMessageSpec(i, 'sender@example.com'));
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email: 'sender@example.com',
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
    await syncFirst('sender@example.com');

    // 全件転送
    const first = await t.app.call('messages.forwardAll', {
      query: { page: 1, pageSize: 50 },
      to: 'dest@target.example',
    });
    expect(first.queued).toBe(5);
    expect(first.skipped).toBe(0);
    await t.waitForJob(first.job.id, 30_000);
    expect(smtp.received).toHaveLength(5);

    // 同じ宛先へ再度全件転送 → 全てスキップ、送信は増えない
    const second = await t.app.call('messages.forwardAll', {
      query: { page: 1, pageSize: 50 },
      to: 'dest@target.example',
    });
    expect(second.queued).toBe(0);
    expect(second.skipped).toBe(5);
    expect(smtp.received).toHaveLength(5);

    // 別の宛先には送れる
    const other = await t.app.call('messages.forwardAll', {
      query: { page: 1, pageSize: 50 },
      to: 'other@target.example',
    });
    expect(other.queued).toBe(5);
    await t.waitForJob(other.job.id, 30_000);
    expect(smtp.received).toHaveLength(10);

    // 選択転送も転送済みはスキップ
    const ids = (await t.app.call('search.query', { page: 1, pageSize: 50 })).items.map(
      (m) => m.id,
    );
    const sel = await t.app.call('messages.forward', { ids, to: 'dest@target.example' });
    expect(sel.skipped).toBe(5);
    expect(sel.queued).toBe(0);
  }, 60_000);

  it('exposes forwarded status via search filter and message detail', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    for (let i = 1; i <= 3; i++)
      imap.addMessage('sender@example.com', 'INBOX', makeMessageSpec(i, 'sender@example.com'));
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email: 'sender@example.com',
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
    await syncFirst('sender@example.com');
    const all = (await t.app.call('search.query', { page: 1, pageSize: 50 })).items;
    expect(all.every((m) => m.forwarded === false)).toBe(true);

    // 1 通だけ転送する
    const target = all[0];
    const res = await t.app.call('messages.forward', {
      ids: [target.id],
      to: 'dest@target.example',
    });
    await t.waitForJob(res.job.id, 30_000);

    // 転送状態フィルタで絞り込める
    const forwarded = await t.app.call('search.query', {
      forwardState: 'forwarded',
      page: 1,
      pageSize: 50,
    });
    expect(forwarded.items.map((m) => m.id)).toEqual([target.id]);
    expect(forwarded.items[0].forwarded).toBe(true);
    const pending = await t.app.call('search.query', {
      forwardState: 'not_forwarded',
      page: 1,
      pageSize: 50,
    });
    expect(pending.total).toBe(2);
    expect(pending.items.every((m) => !m.forwarded)).toBe(true);

    // メール詳細に転送履歴（宛先と日時）が入る
    const detail = await t.app.call('messages.get', { id: target.id });
    expect(detail?.forwards).toHaveLength(1);
    expect(detail?.forwards[0].to).toBe('dest@target.example');
    expect(detail?.forwards[0].at).toBeTruthy();

    // 送信メール（転送レコード）一覧に転送先付きで出る
    const sent = await t.app.call('forwards.list', { page: 1, pageSize: 50 });
    expect(sent.total).toBe(1);
    expect(sent.items[0]).toMatchObject({
      messageId: target.id,
      to: 'dest@target.example',
      accountEmail: 'sender@example.com',
    });
    expect(sent.items[0].subject).toBe(target.subject);
    // 転送先での絞り込み
    expect((await t.app.call('forwards.list', { to: 'dest@', page: 1, pageSize: 50 })).total).toBe(
      1,
    );
    expect(
      (await t.app.call('forwards.list', { to: 'nobody@', page: 1, pageSize: 50 })).total,
    ).toBe(0);
  }, 60_000);

  it('sends a new mail via SMTP and saves a copy to the Sent folder', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email: 'sender@example.com',
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
    await syncFirst('sender@example.com');
    const accountId = (await t.app.call('accounts.list', {})).find(
      (a) => a.email === 'sender@example.com',
    )!.id;

    const res = await t.app.call('messages.send', {
      accountId,
      to: 'dest@target.example',
      subject: 'Hello from test',
      text: 'This is a test message.',
    });
    expect(res.messageId).toBeTruthy();
    expect(res.savedToSent).toBe(true);
    // SMTP に届いている
    const sent = smtp.received.find((m) => m.to.includes('dest@target.example'));
    expect(sent).toBeTruthy();
    expect(sent!.from).toBe('sender@example.com');
    expect(sent!.data).toMatch(/Subject:.*Hello from test/);
    // Sent フォルダに控えが APPEND されている
    expect(imap.stats.appends).toBeGreaterThan(0);
    expect(imap.mailbox('sender@example.com', 'Sent').messages.length).toBeGreaterThan(0);
    // 不正な宛先は拒否
    await expect(
      t.app.call('messages.send', { accountId, to: 'bad', subject: 's', text: 't' }),
    ).rejects.toThrow();
  }, 60_000);

  it('deletes a sent message (moves it to Trash)', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    imap.addMessage('sender@example.com', 'Sent', {
      from: { address: 'sender@example.com' },
      to: [{ address: 'x@y.com' }],
      subject: 'my sent',
      date: new Date(),
      text: 'body',
    });
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email: 'sender@example.com',
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
    await syncFirst('sender@example.com');
    const sentMsg = (
      await t.app.call('search.query', { mailboxSpecialUse: '\\Sent', page: 1, pageSize: 10 })
    ).items;
    expect(sentMsg).toHaveLength(1);
    const del = await t.app.call('messages.delete', { ids: [sentMsg[0].id] });
    await t.waitForJob(del.id, 30_000);
    expect(
      (await t.app.call('search.query', { mailboxSpecialUse: '\\Sent', page: 1, pageSize: 10 }))
        .total,
    ).toBe(0);
    expect(imap.mailbox('sender@example.com', 'Sent').messages).toHaveLength(0);
    expect(imap.mailbox('sender@example.com', 'Trash').messages.length).toBeGreaterThan(0);
  }, 60_000);

  it('sends via Microsoft Graph for an Outlook OAuth2 account (SMTP AUTH disabled)', async () => {
    // Graph 受理モード。SMTP は用意しない（= SMTP が使えない状況を模す）
    graph.mode = 'accept';
    graph.validTokens.add('AT-graph');
    oauth.setGrant('rt-graph', { accessToken: 'AT-graph' });
    imap.setUser('guser@outlook.com', { accessToken: 'AT-graph' });
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'g.csv',
        toCsv([
          {
            email: 'guser@outlook.com',
            provider: 'outlook',
            auth_type: 'oauth2',
            client_id: 'cid',
            refresh_token: 'rt-graph',
            imap_host: '127.0.0.1',
            imap_port: String(imap.port),
            imap_secure: 'none',
          },
        ]),
      ),
    });
    const accountId = (await t.app.call('accounts.list', {})).find(
      (a) => a.email === 'guser@outlook.com',
    )!.id;
    const res = await t.app.call('messages.send', {
      accountId,
      to: 'dest@target.example',
      subject: 'Graph hi',
      text: 'via graph',
    });
    expect(res.savedToSent).toBe(true);
    expect(graph.sent).toHaveLength(1);
    expect(graph.sent[0].to).toContain('dest@target.example');
    expect(graph.sent[0].subject).toBe('Graph hi');
    expect(graph.sent[0].saveToSentItems).toBe(true);
    expect(graph.sent[0].token).toBe('AT-graph');
    // SMTP は使われていない
    expect(smtp.received).toHaveLength(0);
    // ログに Graph 送信が記録される
    expect(t.logs.lines.join('\n')).toContain('Graph message sent');
  }, 60_000);

  it('forwards an Outlook OAuth2 message via Graph', async () => {
    graph.mode = 'accept';
    oauth.setGrant('rt-fwd-g', { accessToken: 'AT-fwd-g' });
    imap.setUser('fwduser@outlook.com', { accessToken: 'AT-fwd-g' });
    imap.addMessage('fwduser@outlook.com', 'INBOX', makeMessageSpec(1, 'fwduser@outlook.com'));
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'fg.csv',
        toCsv([
          {
            email: 'fwduser@outlook.com',
            provider: 'outlook',
            auth_type: 'oauth2',
            client_id: 'cid',
            refresh_token: 'rt-fwd-g',
            imap_host: '127.0.0.1',
            imap_port: String(imap.port),
            imap_secure: 'none',
          },
        ]),
      ),
    });
    await syncFirst('fwduser@outlook.com');
    const msg = (await t.app.call('search.query', { page: 1, pageSize: 1 })).items[0];
    const res = await t.app.call('messages.forward', { ids: [msg.id], to: 'dest@target.example' });
    await t.waitForJob(res.job.id, 30_000);
    expect(graph.sent.some((m) => m.to.includes('dest@target.example'))).toBe(true);
    expect(smtp.received).toHaveLength(0);
  }, 60_000);

  it('auto-forwards messages matching a rule and dedups on re-apply', async () => {
    imap.setUser('sender@example.com', { password: 'pw' });
    // 件名に「請求書」を含むメールと含まないメールを用意
    imap.addMessage('sender@example.com', 'INBOX', {
      from: { address: 'a@x.com' },
      to: [{ address: 'sender@example.com' }],
      subject: '請求書 9月',
      date: new Date(),
      text: 'invoice',
    });
    imap.addMessage('sender@example.com', 'INBOX', {
      from: { address: 'b@x.com' },
      to: [{ address: 'sender@example.com' }],
      subject: 'ただの連絡',
      date: new Date(),
      text: 'hello',
    });
    await t.app.call('accounts.importCsv', {
      path: t.writeCsv(
        'a.csv',
        toCsv([
          {
            email: 'sender@example.com',
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
    // ルール登録: 件名に「請求書」→ akira@example.com へ転送
    await t.app.call('forwardRules.add', {
      keyword: '請求書',
      matchField: 'subject',
      to: 'akira@example.com',
      enabled: true,
    });

    // 同期すると自動転送ルールが適用される（sync 完了イベントで発火）
    const job = await t.app.call('sync.run', { ids: 'all' });
    await t.waitForJob(job.id, 60_000);
    // ルール適用の転送ジョブ完了を待つ（少し待機）
    await new Promise((r) => setTimeout(r, 1500));
    // 請求書メールだけが転送されている
    const forwardedToAkira = smtp.received.filter((m) => m.to.includes('akira@example.com'));
    expect(forwardedToAkira).toHaveLength(1);
    // 件名は MIME エンコードされるため、転送プレフィックス（=?...?= か Fwd）を確認
    expect(forwardedToAkira[0].data).toMatch(/Subject:.*(Fwd|=\?)/i);

    // 手動で再適用しても重複送信しない
    const r = await t.app.call('forwardRules.apply', {});
    await new Promise((res) => setTimeout(res, 500));
    expect(r.forwarded).toBe(0);
    expect(smtp.received.filter((m) => m.to.includes('akira@example.com'))).toHaveLength(1);

    // 送信メール（転送レコード）で確認できる
    const fwds = await t.app.call('forwards.list', { page: 1, pageSize: 50 });
    expect(fwds.total).toBe(1);
    expect(fwds.items[0].to).toBe('akira@example.com');
  }, 60_000);
});
