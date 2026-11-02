/**
 * パッケージ済みアプリ（out/）を Playwright で起動し、GUI 経由で
 *   CSV 取り込み → 300 アカウント → 一括認証テスト → ダッシュボード集計
 * までを検証する。擬似 IMAP / OAuth サーバーとダミーアカウントだけを使う。
 *
 *   MM_E2E_BUILD=1 npm run package && npm run test:e2e
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { FakeImapServer } from '../helpers/fake-imap-server';
import { FakeOAuthServer } from '../helpers/fake-oauth-server';
import {
  accessTokenFor,
  generateAccounts,
  passwordFor,
  refreshTokenFor,
  toCsv,
  type FixtureAccount,
} from '../helpers/csv-fixtures';
import { makeMessageSpec } from '../helpers/mail-fixtures';

const APP_BIN = path.resolve(
  `out/Mail Manager-darwin-${process.arch}/Mail Manager.app/Contents/MacOS/Mail Manager`,
);
const SHOTS = path.resolve('docs/screenshots');

// 期待メッセージ数: INBOX は 287 アカウントに 1〜12 通、Sent は先頭 3 アカウントに 2 通ずつ
const EXPECTED_INBOX = Array.from({ length: 287 }, (_, i) => 1 + ((i + 1) % 12)).reduce(
  (a, b) => a + b,
  0,
);
// 送信済み: 先頭 3 アカウントに「転送(Fwd:)」1 通 +「通常」1 通 = 計 6
const SENT_ACCOUNTS = 3;
const EXPECTED_SENT = SENT_ACCOUNTS * 2;
const EXPECTED_TOTAL = EXPECTED_INBOX + EXPECTED_SENT;

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let imap: FakeImapServer;
let oauth: FakeOAuthServer;
let userData: string;
let csvPath: string;
let accounts: FixtureAccount[];

test.beforeAll(async () => {
  expect(
    fs.existsSync(APP_BIN),
    `packaged app not found at ${APP_BIN}; run MM_E2E_BUILD=1 npm run package`,
  ).toBe(true);
  imap = new FakeImapServer();
  oauth = new FakeOAuthServer();
  await imap.start();
  await oauth.start();
  const closedPort = await (async () => {
    const s = new FakeImapServer();
    const p = await s.start();
    await s.stop();
    return p;
  })();

  // 300 件: 287 成功 / 9 認証エラー / 3 接続エラー / 1 その他（PROJECT_SPEC.md §3 の例）
  accounts = generateAccounts({
    count: 300,
    imapHost: '127.0.0.1',
    imapPort: imap.port,
    imapSecure: 'none',
  });
  for (const a of accounts) {
    const authFail = a.index > 287 && a.index <= 296;
    if (a.index > 296 && a.index <= 299) a.imap_port = String(closedPort);
    if (a.auth_type === 'oauth2') {
      imap.setUser(a.email, { accessToken: accessTokenFor(a.index) });
      // 300 番目: token endpoint が access_token を返さない → 「その他のエラー」
      const grant =
        a.index === 300
          ? { accessToken: 'x', behavior: 'malformed' as const }
          : authFail
            ? { accessToken: 'x', behavior: 'invalid_grant' as const }
            : { accessToken: accessTokenFor(a.index) };
      oauth.setGrant(refreshTokenFor(a.index), grant);
    } else {
      imap.setUser(a.email, { password: authFail ? 'wrong' : passwordFor(a.index) });
    }
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  // 成功する 287 アカウントに 1〜12 通ずつダミーメールを入れる
  for (const a of accounts) {
    if (a.index > 287) continue;
    const n = 1 + (a.index % 12);
    for (let i = 1; i <= n; i++) imap.addMessage(a.email, 'INBOX', makeMessageSpec(i, a.email));
  }
  // 先頭 3 アカウントの Sent に転送(Fwd:)と通常送信を 1 通ずつ入れる
  for (const a of accounts) {
    if (a.index > SENT_ACCOUNTS) continue;
    imap.addMessage(a.email, 'Sent', {
      ...makeMessageSpec(1, 'r1@example.com'),
      from: { address: a.email },
      subject: `Fwd: forwarded ${a.index}`,
    });
    imap.addMessage(a.email, 'Sent', {
      ...makeMessageSpec(2, 'r2@example.com'),
      from: { address: a.email },
      subject: `Normal mail ${a.index}`,
    });
  }
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-manager-e2e-'));
  csvPath = path.join(userData, 'accounts-300.csv');
  fs.writeFileSync(csvPath, toCsv(accounts), 'utf8');

  app = await electron.launch({
    executablePath: APP_BIN,
    args: [],
    env: {
      ...process.env,
      MM_USER_DATA: userData,
      MM_INSECURE_KEY_FILE: '1',
      // 認証完了時の自動同期は E2E では無効化し、受信はテスト内の「受信同期」で明示的に行う
      MM_AUTO_SYNC_ON_AUTH: '0',
      MM_STORE_ATTACHMENTS: '0',
      MM_AUTO_SYNC_INTERVAL_MIN: '0',
      MM_AUTO_SYNC_INTERVAL_SEC: '0',
      MM_OAUTH_TOKEN_URL_OUTLOOK: oauth.tokenUrl,
      MM_RETRY_DELAYS_MS: '100,200,300',
      MM_CONNECT_TIMEOUT_MS: '3000',
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="app-root"][data-backend="ready"]', {
    timeout: 60_000,
  });
});

test.afterAll(async () => {
  await app?.close();
  await imap?.stop();
  await oauth?.stop();
  if (userData) fs.rmSync(userData, { recursive: true, force: true });
});

test('starts on the dashboard with zero accounts', async () => {
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('tile-accounts')).toHaveAttribute('data-value', '0');
  // ナビは翻訳済みラベルを表示する（生キー "nav." が出ていないこと）
  const nav = page.locator('.nav');
  await expect(nav).toContainText('受信メール');
  await expect(nav).toContainText('送信メール');
  await expect(nav).toContainText('動的ルール');
  await expect(nav).not.toContainText('受信ボックス');
  await expect(nav).not.toContainText('nav.');
});

test('imports 300 accounts from CSV through the GUI', async () => {
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await page.getByTestId('csv-path').fill(csvPath);
  const started = Date.now();
  await page.getByTestId('btn-run-import').click();
  await expect(page.getByTestId('import-imported')).toHaveText('300', { timeout: 30_000 });
  const elapsed = Date.now() - started;
  await expect(page.getByTestId('import-invalid')).toHaveText('0');
  await page.screenshot({ path: path.join(SHOTS, 'import.png') });
  console.log(`GUI import of 300 accounts took ${elapsed}ms`);
  expect(elapsed).toBeLessThan(10_000);
});

test('runs Test All and the dashboard shows per-category results', async () => {
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect(page.getByTestId('tile-accounts')).toHaveAttribute('data-value', '300');
  await expect(page.getByTestId('tile-untested')).toHaveAttribute('data-value', '300');

  // 認証はアカウント画面から: 全選択して「選択を認証」（メールは取得しない）
  const started = Date.now();
  await page.evaluate(() => {
    window.location.hash = '#/accounts';
  });
  await page.getByTestId('select-all').check();
  await page.getByTestId('btn-auth-selected').click();
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect(page.getByTestId('tile-connected')).toHaveAttribute('data-value', '287', {
    timeout: 180_000,
  });
  await expect(page.getByTestId('tile-authError')).toHaveAttribute('data-value', '9');
  await expect(page.getByTestId('tile-connectionError')).toHaveAttribute('data-value', '3', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('tile-unknownError')).toHaveAttribute('data-value', '1');
  await expect(page.getByTestId('tile-connecting')).toHaveAttribute('data-value', '0');
  await expect(page.getByTestId('tile-untested')).toHaveAttribute('data-value', '0');
  await expect(page.getByTestId('last-test')).not.toContainText(/(最終テスト|Last test): —/);
  await expect(page.locator('.job .job-completed').first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(SHOTS, 'dashboard.png') });
  console.log(
    `GUI auth of 300 accounts took ${Date.now() - started}ms; max concurrent sessions ${imap.stats.maxConcurrentSessions}`,
  );
  expect(imap.stats.maxConcurrentSessions).toBeLessThanOrEqual(10);
  expect(imap.stats.maxConcurrentSessions).toBeGreaterThan(1);
});

test('accounts page filters by error category and opens account detail', async () => {
  await page.evaluate(() => {
    window.location.hash = '#/accounts?filter=auth_error';
  });
  await expect(page.getByTestId('accounts-count')).toContainText('9 / 300');
  await expect(page.getByTestId('account-row')).toHaveCount(9);
  const firstEmail = await page.getByTestId('account-row').first().getAttribute('data-email');
  await page.getByTestId('account-row').first().locator('a').click();
  await expect(page.getByTestId('account-detail')).toBeVisible();
  await expect(page.getByTestId('account-detail')).toContainText(firstEmail!);
  await expect(page.getByTestId('account-detail').locator('.badge-auth_error')).toBeVisible();

  // 認証情報を修正: 認証エラー(288〜296)のうちパスワード系は 'wrong' が設定されている → 正しい値に直すと認証成功になる
  const failing = accounts.find((a) => a.email === firstEmail)!;
  await page.getByTestId('btn-edit-credentials').click();
  await expect(page.getByTestId('credentials-dialog')).toBeVisible();
  if (failing.auth_type === 'oauth2') {
    // OAuth: 正しいトークンを fake OAuth に登録してから refresh_token を差し替える
    oauth.setGrant(`fixed-${failing.index}`, { accessToken: accessTokenFor(failing.index) });
    await page.getByTestId('cred-refresh-token').fill(`fixed-${failing.index}`);
  } else {
    imap.setUser(failing.email, { password: passwordFor(failing.index) });
    await page.getByTestId('cred-password').fill(passwordFor(failing.index));
  }
  await page.getByTestId('cred-save').click();
  await expect(page.getByTestId('credentials-dialog')).toHaveCount(0);
  await expect(page.getByTestId('toasts')).toContainText(/認証情報を保存|Credentials saved/);
  await expect(page.getByTestId('account-detail').locator('.badge-connected')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('account-detail').locator('[data-status="ok"]')).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/accounts?filter=connection_error';
  });
  await expect(page.getByTestId('account-row')).toHaveCount(3);
  await page.evaluate(() => {
    window.location.hash = '#/accounts?filter=all';
  });
  await expect(page.getByTestId('account-row').first()).toBeVisible();
  // 未認証を選択: 認証成功(287 + 修正した 1 件)以外の 12 件が選ばれる
  await page.getByTestId('btn-select-untested').click();
  await expect(page.locator('.toolbar')).toContainText('12');
  // 選択したアカウントを CSV 出力（保存ダイアログはテスト用に固定パスを返す）
  const exportPath = path.join(userData, 'selected-accounts.csv');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, exportPath);
  await page.getByTestId('btn-export-selected').click();
  await expect(page.getByTestId('toasts')).toContainText(/書き出しました|Exported/);
  await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
  const exported = fs.readFileSync(exportPath, 'utf8').trim().split('\n');
  expect(exported).toHaveLength(13); // ヘッダー + 12 件
  expect(exported[0]).not.toMatch(/password|refresh_token|client_secret/);
  await page.screenshot({ path: path.join(SHOTS, 'accounts.png') });
  await page.getByTestId('search').fill('user001@');
  await expect(page.getByTestId('account-row')).toHaveCount(1);
  await page.getByTestId('search').fill('');
});

test('received mail search, viewer, forward and receive-sync', async () => {
  // 受信メール画面で「受信同期」を押し、認証済みアカウントのメールを取得する
  await page.evaluate(() => {
    window.location.hash = '#/search';
  });
  await page.getByTestId('btn-receive-sync').click();
  await expect(page.getByTestId('toasts')).toContainText('受信同期');
  // 取得完了を待つ（検索結果は新着到着で自動更新される）
  await expect(page.getByTestId('search-total')).toContainText(String(EXPECTED_TOTAL), {
    timeout: 180_000,
  });

  await page.getByTestId('search-text').fill('請求書');
  await page.getByTestId('btn-search').click();
  await expect(page.getByTestId('search-total')).not.toContainText(String(EXPECTED_TOTAL));
  const rows = page.getByTestId('result-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText('請求書');
  await rows.first().click();
  await expect(page.getByTestId('message-viewer')).toBeVisible();
  await expect(page.getByTestId('message-viewer')).toContainText('請求書');
  // HTML メールは sandbox 付き iframe で描画され、script は含まれない
  const frame = page.getByTestId('mail-frame');
  await expect(frame).toBeVisible();
  const srcdoc = await frame.getAttribute('srcdoc');
  expect(srcdoc).toContain("script-src 'none'");
  expect(srcdoc).not.toContain('<script');
  expect(await frame.getAttribute('sandbox')).toBe('');
  await page.screenshot({ path: path.join(SHOTS, 'search.png') });

  // 選択転送: 検索結果を選んで転送ダイアログを開く（送信はしない）
  await page.getByTestId('result-row').first().locator('input[type=checkbox]').check();
  await page.getByTestId('btn-forward-selected').click();
  await expect(page.getByTestId('forward-dialog')).toBeVisible();
  await page
    .getByTestId('forward-dialog')
    .getByRole('button', { name: /キャンセル|Cancel/ })
    .click();
  await expect(page.getByTestId('forward-dialog')).toHaveCount(0);

  // 差出人フィルタ + 添付ありで絞り込み、添付をダウンロードできる
  await page.getByTestId('search-text').fill('');
  await page.getByTestId('search-from').fill('support@shop.example');
  await page.getByTestId('btn-search').click();
  await expect(page.getByTestId('search-total')).not.toContainText('0 件');
  await page.getByTestId('search-from').fill('');
  // 10 通目（添付付き）は 1 + (index % 12) >= 10 のアカウントに存在する → 72 件
  await page.getByTestId('search-subject').fill('Your order 10 has shipped');
  await page.getByTestId('btn-search').click();
  await expect(page.getByTestId('search-total')).toContainText('72');
  await expect(page.getByTestId('result-row')).toHaveCount(50);
  await page.getByTestId('result-row').first().click();
  await expect(page.getByTestId('message-viewer')).toContainText('report-10.pdf');
  await page.getByTestId('btn-download-attachment').first().click();
  await expect(page.getByTestId('message-viewer')).toContainText(/Finder|Show in Finder/, {
    timeout: 30_000,
  });
  await page.screenshot({ path: path.join(SHOTS, 'viewer.png') });

  // 転送先アカウントを設定画面で登録する
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await page.getByTestId('forward-target-address').fill('archive@example.com');
  await page.getByTestId('forward-target-add').click();
  await expect(page.getByTestId('forward-target-list')).toContainText('archive@example.com');

  // 受信メール画面でメールを開き、転送ダイアログに保存済みの転送先が出ることを確認（送信はしない）
  await page.evaluate(() => {
    window.location.hash = '#/search';
  });
  await expect(page.getByTestId('result-row').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('result-row').first().click();
  await expect(page.getByTestId('message-viewer')).toBeVisible();
  await page.getByTestId('btn-forward').click();
  await expect(page.getByTestId('forward-dialog')).toBeVisible();
  await expect(page.getByTestId('forward-target-select')).toContainText('archive@example.com');
  await page
    .getByTestId('forward-dialog')
    .getByRole('button', { name: /キャンセル|Cancel/ })
    .click();
  await expect(page.getByTestId('forward-dialog')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'received-mail.png') });

  // 送信メール画面: 送信済みフォルダのメールが並び、転送/通常送信を種別で判別できる
  await page.evaluate(() => {
    window.location.hash = '#/sent';
  });
  await expect(page.getByTestId('sent')).toBeVisible();
  await expect(page.getByTestId('sent-row')).toHaveCount(EXPECTED_SENT, { timeout: 30_000 });
  await expect(page.locator('[data-testid="sent-row"][data-kind="forward"]')).toHaveCount(
    SENT_ACCOUNTS,
  );
  await expect(page.locator('[data-testid="sent-row"][data-kind="normal"]')).toHaveCount(
    SENT_ACCOUNTS,
  );
  await page.screenshot({ path: path.join(SHOTS, 'sent-mail.png') });
  // 種別で絞り込み: 転送のみ
  await page.getByTestId('sent-kind').selectOption('forward');
  await expect(page.getByTestId('sent-row')).toHaveCount(SENT_ACCOUNTS);
  await page.getByTestId('sent-kind').selectOption('normal');
  await expect(page.getByTestId('sent-row')).toHaveCount(SENT_ACCOUNTS);
  await page.getByTestId('sent-kind').selectOption('');

  // グループを作って送信メールのある先頭 3 アカウントを入れ、送信メールをグループで絞り込む
  await page.evaluate(() => {
    window.location.hash = '#/accounts';
  });
  await expect(page.getByTestId('account-row').first()).toBeVisible();
  await page.getByTestId('btn-manage-groups').click();
  await page.getByTestId('group-new-name').fill('送信組');
  await page.getByTestId('group-create').click();
  await expect(page.locator('[data-testid="group-item"][data-name="送信組"]')).toHaveCount(1);
  await page
    .getByTestId('group-manager-dialog')
    .getByRole('button', { name: /閉じる|Close/ })
    .click();
  await expect(page.getByTestId('group-manager-dialog')).toHaveCount(0);
  for (let i = 0; i < SENT_ACCOUNTS; i++)
    await page.getByTestId('account-row').nth(i).locator('input[type=checkbox]').check();
  await page.getByTestId('btn-assign-group').click();
  await page.getByTestId('group-assign-select').selectOption({ label: '送信組 (0)' });
  await page.getByTestId('group-assign-apply').click();
  await expect(page.getByTestId('group-assign-dialog')).toHaveCount(0);
  await expect(
    page.locator('[data-testid="account-row"]').filter({ hasText: '送信組' }),
  ).toHaveCount(SENT_ACCOUNTS);
  await page.evaluate(() => {
    window.location.hash = '#/sent';
  });
  await expect(page.getByTestId('sent-row')).toHaveCount(SENT_ACCOUNTS * 2);
  await page.getByTestId('sent-group').selectOption({ label: `送信組 (${SENT_ACCOUNTS})` });
  await expect(page.getByTestId('sent-row')).toHaveCount(SENT_ACCOUNTS * 2, { timeout: 10_000 });
  // グループ内のアカウントだけが選択肢に出る（「すべてのアカウント」+ 3 件）
  await expect(page.getByTestId('sent-account').locator('option')).toHaveCount(SENT_ACCOUNTS + 1);
  await page.getByTestId('sent-group').selectOption('');
  await expect(page.getByTestId('sent-account').locator('option')).toHaveCount(301);

  // 重複控えの整理: E2E のデータには重複が無いので「ありません」のトーストになる
  await page.getByTestId('btn-dedupe-sent').click();
  await expect(page.getByTestId('toasts')).toContainText(/重複した転送の控えはありません|No duplicated/);

  // 送信先で絞り込み: r1@example.com 宛（転送 Fwd:）だけ → 解除で全件に戻る
  await page.getByTestId('sent-to').fill('r1@example');
  await expect(page.getByTestId('sent-row')).toHaveCount(SENT_ACCOUNTS, { timeout: 10_000 });
  await expect(page.getByTestId('sent-total')).toContainText(String(SENT_ACCOUNTS));
  await page.getByTestId('sent-to-clear').click();
  await expect(page.getByTestId('sent-row')).toHaveCount(SENT_ACCOUNTS * 2, { timeout: 10_000 });

  // 新規送信ダイアログを開いて入力できる（E2E では SMTP 未提供のため送信はせずキャンセル）
  await page.getByTestId('btn-compose').click();
  await expect(page.getByTestId('compose-dialog')).toBeVisible();
  await page.getByTestId('compose-to').fill('dest@example.com');
  await page.getByTestId('compose-subject').fill('hello');
  await page
    .getByTestId('compose-dialog')
    .getByRole('button', { name: /キャンセル|Cancel/ })
    .click();
  await expect(page.getByTestId('compose-dialog')).toHaveCount(0);

  // 送信済みメールを削除する（1 件チェックして削除 → Trash へ移動）
  page.once('dialog', (d) => d.accept());
  const before = await page.getByTestId('sent-row').count();
  await page.getByTestId('sent-row').first().locator('input[type=checkbox]').check();
  await page.getByTestId('btn-delete-sent').click();
  await expect(page.getByTestId('sent-row')).toHaveCount(before - 1, { timeout: 30_000 });
  await page.screenshot({ path: path.join(SHOTS, 'sent-mail.png') });
});

test('settings page shows key mode and env overrides; changes concurrency', async () => {
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await expect(page.getByTestId('settings')).toContainText('MM_OAUTH_TOKEN_URL_OUTLOOK');
  await page.getByTestId('auth-concurrency').fill('5');
  await page.getByTestId('btn-save-settings').click();
  await expect(page.getByTestId('toasts')).toContainText(/保存|saved/);
});

test('dynamic rules page: add, apply and remove an auto-forward rule', async () => {
  await page.evaluate(() => {
    window.location.hash = '#/rules';
  });
  await expect(page.getByTestId('rules')).toBeVisible();
  await page.getByTestId('rule-field').selectOption('subject');
  await page.getByTestId('rule-keyword').fill('invoice');
  await page.getByTestId('rule-action').selectOption('forward');
  await page.getByTestId('rule-to').fill('rules@example.com');
  await page.getByTestId('rule-add').click();
  await expect(page.getByTestId('rule-list')).toContainText('rules@example.com');
  await expect(page.getByTestId('rule-list')).toContainText('invoice');
  // 今すぐ適用（送信は E2E 環境では失敗しうるが、処理自体は走る）
  await page.getByTestId('rule-apply').click();
  await expect(page.getByTestId('toasts')).toBeVisible();
  // 削除
  await page.getByTestId('rule-list').getByRole('button').first().click();
  await expect(page.getByTestId('rules')).not.toContainText('rules@example.com');
});

test('never writes plaintext secrets to the database or log', async () => {
  const files = fs.readdirSync(userData).map((f) => path.join(userData, f));
  const dbFiles = files.filter((f) => f.includes('mail-manager.sqlite'));
  expect(dbFiles.length).toBeGreaterThan(0);
  const dbBytes = dbFiles.map((f) => fs.readFileSync(f, 'latin1')).join('');
  const log = fs.readFileSync(path.join(userData, 'logs', 'app.log'), 'utf8');
  expect(log).toContain('sync completed');
  for (const i of [1, 2, 150, 288, 300]) {
    expect(dbBytes).not.toContain(passwordFor(i));
    expect(dbBytes).not.toContain(refreshTokenFor(i));
    expect(log).not.toContain(passwordFor(i));
    expect(log).not.toContain(refreshTokenFor(i));
    expect(log).not.toContain(accessTokenFor(i));
  }
  expect(dbBytes).not.toContain('-secret');
  expect(log).not.toContain('-secret');
});
