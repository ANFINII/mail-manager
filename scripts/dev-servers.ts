/**
 * GUI 動作確認用: 擬似 IMAP サーバーと擬似 OAuth token サーバーを起動し、
 * それらに向けた 300 件のダミー CSV を生成する。実アカウントは一切使わない。
 *
 *   npm run dev:servers
 *   （別ターミナルで）
 *   MM_OAUTH_TOKEN_URL_OUTLOOK=http://127.0.0.1:3180/token MM_RETRY_DELAYS_MS=500,1000,2000 npm start
 *
 * 内訳（PROJECT_SPEC.md §3 の例に合わせている）:
 *   287 成功 / 9 認証エラー / 3 接続エラー / 1 その他エラー
 */
import fs from 'node:fs';
import path from 'node:path';
import { FakeImapServer } from '../tests/helpers/fake-imap-server';
import { FakeOAuthServer } from '../tests/helpers/fake-oauth-server';
import {
  accessTokenFor,
  generateAccounts,
  passwordFor,
  refreshTokenFor,
  toCsv,
} from '../tests/helpers/csv-fixtures';
import { makeMessageSpec } from '../tests/helpers/mail-fixtures';

const IMAP_PORT = Number(process.env.MM_DEV_IMAP_PORT ?? 3143);
const OAUTH_PORT = Number(process.env.MM_DEV_OAUTH_PORT ?? 3180);
const CLOSED_PORT = Number(process.env.MM_DEV_CLOSED_PORT ?? 3199);
const OUT = process.env.MM_DEV_CSV ?? 'tests/fixtures/generated/dev-accounts-300.csv';

async function main() {
  const imap = new FakeImapServer();
  const oauth = new FakeOAuthServer();
  await imap.start(IMAP_PORT);
  await oauth.start(OAUTH_PORT);

  const accounts = generateAccounts({
    count: 300,
    imapHost: '127.0.0.1',
    imapPort: IMAP_PORT,
    imapSecure: 'none',
  });
  for (const a of accounts) {
    // 1..287 成功
    let ok = true;
    if (a.index > 287 && a.index <= 296) ok = false; // 9 認証エラー
    if (a.index > 296 && a.index <= 299) a.imap_port = String(CLOSED_PORT); // 3 接続エラー（閉じたポート）
    if (a.auth_type === 'oauth2') {
      imap.setUser(a.email, { accessToken: accessTokenFor(a.index) });
      // 300 番目: token endpoint が access_token を返さない → 「その他のエラー」
      const grant =
        a.index === 300
          ? { accessToken: 'x', behavior: 'malformed' as const }
          : ok
            ? { accessToken: accessTokenFor(a.index) }
            : { accessToken: 'x', behavior: 'invalid_grant' as const };
      oauth.setGrant(refreshTokenFor(a.index), grant);
    } else {
      imap.setUser(a.email, { password: ok ? passwordFor(a.index) : 'wrong' });
    }
  }
  // 各アカウントの INBOX に 5〜60 通、Sent に 3 通のダミーメールを入れる（合計およそ 10,000 通）
  let totalMessages = 0;
  for (const a of accounts) {
    const count = 5 + ((a.index * 7) % 56);
    for (let i = 1; i <= count; i++) {
      imap.addMessage(
        a.email,
        'INBOX',
        makeMessageSpec(i, a.email, new Date('2026-06-01T00:00:00Z')),
      );
      totalMessages++;
    }
    for (let i = 1; i <= 3; i++) {
      imap.addMessage(a.email, 'Sent', {
        ...makeMessageSpec(i, 'someone@example.com'),
        from: { address: a.email },
        subject: `Re: sent ${i}`,
      });
      totalMessages++;
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, toCsv(accounts), 'utf8');

  console.log(`fake IMAP  : 127.0.0.1:${IMAP_PORT} (plain)`);
  console.log(`fake OAuth : http://127.0.0.1:${OAUTH_PORT}/token`);
  console.log(
    `CSV        : ${path.resolve(OUT)} (300 accounts: 287 ok / 9 auth error / 3 connection error / 1 other)`,
  );
  console.log('');
  console.log('別ターミナルでアプリを起動:');
  console.log(
    `  MM_OAUTH_TOKEN_URL_OUTLOOK=http://127.0.0.1:${OAUTH_PORT}/token MM_RETRY_DELAYS_MS=500,1000,2000 npm start`,
  );
  console.log('');
  console.log('Ctrl+C で停止。統計は 10 秒ごとに表示します。');
  setInterval(() => {
    console.log(
      `[stats] connections=${imap.stats.totalConnections} maxConcurrentSessions=${imap.stats.maxConcurrentSessions} logins=${imap.stats.loginAttempts} xoauth2=${imap.stats.xoauth2Attempts} tokenRequests=${oauth.stats.requests} fetched=${imap.stats.fetchedMessages}`,
    );
  }, 10_000).unref?.();
  await new Promise(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
