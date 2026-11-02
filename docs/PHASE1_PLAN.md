# Phase 1 実装計画

前提: ADR-001 の推奨構成（Electron + React + TypeScript + ImapFlow + SQLite/Kysely）。
対象プロバイダーは Outlook と Gmail が主体（ADR-001 §9）。Outlook は OAuth2 必須のため、OAuth2 を Phase 1 に含める。

## 完成条件（仕様 §35）と検証状況（2026-09-05）

| 条件 | 状態 | 検証方法 |
|---|---|---|
| Mac で起動できる | ✅ | `MM_E2E_BUILD=1 npm run package` で生成した `out/Mail Manager-darwin-arm64/Mail Manager.app` を Playwright が起動（tests/e2e/gui.spec.ts） |
| CSV を読み込める（行番号付きエラー、エラー行のみ再編集） | ✅ | tests/integration/import.test.ts |
| 300 アカウントを DB に登録できる（< 10 秒） | ✅ | 統合テスト・E2E とも 1 秒未満 |
| アカウント一覧を仮想テーブルで表示・フィルタできる | ✅ | E2E（フィルタ・検索・詳細画面） |
| 一括認証テスト / 選択認証テスト / 個別テスト | ✅ | tests/integration/auth-test.test.ts、E2E |
| Outlook（OAuth2 refresh token → XOAUTH2）と Gmail（アプリパスワード）の両方で認証テスト | ✅ | 150 件ずつ混在させた擬似サーバーテスト |
| 認証結果（成功 / 認証エラー / 接続エラー / その他）を一覧・集計表示 | ✅ | E2E: 287 / 9 / 3 / 1 |
| Concurrency が AUTH_CONCURRENCY=10 で制御されている | ✅ | 擬似 IMAP サーバー側で同時セッション数を計測し 10 以下を assert |
| アカウント単位で status / last_error / last_error_at / retry_count / last_success_at を記録 | ✅ | 統合テスト |
| パスワードが平文保存されていない | ✅ | SQLite ファイル（WAL 含む）のバイト列を検査 |
| ログにパスワードが出ない | ✅ | ログ出力を検査（パスワード・refresh token・access token） |
| 300 アカウントで動作確認 | ✅ | E2E（GUI 経由）と統合テスト |
| アカウントの削除・無効化・有効化 | ✅ | 統合テスト・E2E |
| Stop All で実行中ジョブを中断できる | ✅ | 統合テスト |
| 通信エラーのみリトライ（2s/5s/15s、認証エラーは即確定） | ✅ | 統合テスト（hang / 接続拒否 / 名前解決失敗 / 誤パスワード / invalid_grant） |
| refresh token のローテーションを保存し直す | ✅ | 統合テスト |
| TLS（証明書検証 ON/OFF） | ✅ | 自己署名証明書の擬似サーバー |
| PostgreSQL | ⚠️ 未検証 | `DATABASE_URL` を設定すると tests/integration/postgres.test.ts が走る。ローカルに PostgreSQL が無いためスキップ |
| Universal macOS Build | ⚠️ 未実行 | `npm run make -- --arch=universal` の設定は済み。arm64 のパッケージのみ確認 |
| コード署名 / notarization | 対象外 | 配布は自分の Mac のみのため |

## ディレクトリ構成

```
mail-manager/
├── PROJECT_SPEC.md
├── README.md
├── package.json
├── forge.config.ts               # Electron Forge (Vite plugin, universal build)
├── docs/
├── src/
│   ├── main/                     # Electron main: window, dialogs, safeStorage, backend 起動
│   ├── preload/                  # contextBridge (typed API)
│   ├── backend/                  # 純 TS。Electron 非依存。utilityProcess で実行
│   │   ├── accounts/             # AccountService, CsvImporter, validators
│   │   ├── auth/                 # AuthTestService, ErrorClassifier, RetryPolicy
│   │   ├── mail/                 # EmailProvider interface, ImapFlowProvider
│   │   ├── oauth/                # MicrosoftOAuth, GoogleOAuth, AccessTokenCache
│   │   ├── providers/            # outlook / gmail / custom のプリセット（host, port, scope）
│   │   ├── queue/                # TaskQueue (p-queue), JobTracker, cancel
│   │   ├── security/             # CredentialCipher (AES-256-GCM), KeyProvider
│   │   ├── db/                   # Kysely, dialects, migrations, repositories
│   │   ├── events/               # typed EventBus (ACCOUNT_* / AUTH_* / JOB_*)
│   │   ├── logging/              # pino + redaction + file rotation
│   │   └── config/               # AUTH_CONCURRENCY 等の設定
│   ├── renderer/                 # React
│   │   ├── pages/                # Dashboard, Accounts, AccountDetail, ImportCsv, Settings
│   │   ├── components/           # VirtualTable, StatusBadge, ImportErrorList
│   │   ├── stores/               # zustand (accounts, jobs, dashboard)
│   │   └── i18n/                 # ja (既定), en
│   └── shared/                   # IPC 契約, DTO, enum (AccountStatus 等)
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/                      # 300 アカウント検証
│   ├── helpers/fake-imap-server.ts  # 自作の最小 IMAP サーバー (TLS/plain, LOGIN + AUTHENTICATE PLAIN/XOAUTH2)
│   ├── helpers/fake-oauth-server.ts # token endpoint の擬似サーバー (refresh_token → access_token, invalid_grant, malformed)
│   └── fixtures/                 # 生成した CSV
└── scripts/
    ├── gen-accounts-csv.ts       # 300 / 1000 件のダミー CSV 生成
    └── dev-imap-server.ts        # GUI 動作確認用の擬似 IMAP サーバー起動
```

## DB スキーマ（Phase 1 分）

`accounts`
```
id                    TEXT PK (uuid)
email                 TEXT UNIQUE NOT NULL
provider              'outlook' | 'gmail' | 'custom'
imap_host, imap_port, imap_secure ('tls' | 'starttls' | 'none')
smtp_host, smtp_port, smtp_secure     (Phase 1 は保存のみ)
auth_type             'password' | 'oauth2'
encrypted_credentials TEXT (JSON: v, iv, tag, ct)
                      復号後: { password } または { client_id, client_secret?, refresh_token }
                      access token は DB に保存しない（メモリ内キャッシュのみ）
enabled               INTEGER (bool)
status                'unknown'|'connected'|'connecting'|'disconnected'|
                      'auth_error'|'connection_error'|'syncing'|'disabled'
auth_status           'untested'|'ok'|'failed'
last_error            TEXT
last_error_at         TEXT (ISO8601 UTC)
last_success_at       TEXT
retry_count           INTEGER
last_sync_at          TEXT   (Phase 2 で使用)
message_count         INTEGER DEFAULT 0 (Phase 2 で使用)
created_at, updated_at
```

`settings` (key, value) — AUTH_CONCURRENCY=10, SYNC_CONCURRENCY=20, MAX_RETRIES=3, CONNECT_TIMEOUT_MS=20000

`mailboxes` / `messages` / `attachments` は Phase 2 のマイグレーションで追加。

## CSV フォーマット（Phase 1）

```
email,provider,auth_type,password,client_id,client_secret,refresh_token,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure
u001@outlook.com,outlook,oauth2,,<client_id>,,<refresh_token>,,,,,,
u002@gmail.com,gmail,password,<app_password>,,,,,,,,,
u003@example.com,custom,password,<password>,,,,imap.example.com,993,tls,smtp.example.com,465,tls
```

- `provider` が `outlook` / `gmail` のときは `imap_*` / `smtp_*` を省略可（プリセットで補完。指定があれば上書き）。
- `auth_type=password` は `password` 必須。`auth_type=oauth2` は `client_id` と `refresh_token` 必須（`client_secret` は任意）。
- `provider=outlook` で `auth_type=password` は検証エラー（Microsoft はパスワード認証を廃止済み）。
- 旧形式（仕様 §2.1 の 8 列）もヘッダーで判定して受け付ける（`provider=custom`, `auth_type=password` とみなす）。

## 実装ステップ

1. **足場**: Electron Forge + Vite + React + TS の雛形。`npm run dev` で起動確認。ESLint / Prettier / Vitest。
2. **backend 基盤**: Logger（redaction 付き）、Config、EventBus、Kysely + SQLite マイグレーション、PostgreSQL ダイアレクト設定。
3. **セキュリティ**: `KeyProvider`（main 側で safeStorage を使いマスターキーを保護、backend へは起動時に一度だけ渡す）、`CredentialCipher`（AES-256-GCM）。
4. **CSV Import**: ストリーミングパース、行ごとの検証（email 形式 / 重複（ファイル内・DB 内）/ host / port / secure / password / auth_type）、有効行を暗号化してトランザクションで一括 INSERT。結果 DTO（valid / invalid / 行番号付きエラー）。
5. **Queue**: p-queue ラッパー。ジョブ ID、進捗イベント、キャンセル（AbortSignal）、concurrency の実行時変更。
6. **EmailProvider / ImapFlowProvider**: `testConnection(account, signal)`。TLS / STARTTLS / 接続タイムアウト。password は LOGIN、oauth2 は `auth: { user, accessToken }` で XOAUTH2。エラー分類（auth / connection / unknown）。
6b. **OAuth2 モジュール**: `MicrosoftOAuth` / `GoogleOAuth` が refresh token から access token を取得（token endpoint は設定で差し替え可能にしテストで擬似サーバーへ向ける）。`AccessTokenCache` で有効期限内は再利用。`invalid_grant` / `invalid_client` は認証エラー、ネットワークエラーは通信エラーとして分類。
6c. **対話ログイン（条件付き）**: Outlook アカウントに refresh token が無い場合のみ、Electron の BrowserWindow で authorization code + PKCE フローを実装し、取得した refresh token を暗号化保存する。ユーザー回答後に要否を決定。
7. **AuthTestService**: 対象アカウントをキューへ投入。connection error のみ 2s / 5s / 15s で最大 3 回リトライ。auth error は即確定。結果を `accounts` に反映しイベント発火。
8. **IPC**: `shared/ipc.ts` で型付き契約を定義。renderer からは `window.api.accounts.*`, `window.api.jobs.*`, `window.api.events.on(...)`。イベントは 100ms 単位でまとめて送信し描画負荷を抑える。
9. **GUI**:
   - Dashboard: 集計（Accounts / Connected / Auth Error / Connection Error / Unknown / Disabled）、Last Test、ボタン（Import CSV / Test All / Stop All）
   - Accounts: 仮想テーブル、フィルタ、複数選択、Test Selected / Enable / Disable / Delete Selected
   - Account Detail: 情報表示（パスワード非表示）、Test Connection / Disable / Delete
   - Import: ファイル選択 → 結果表示 → エラー行のインライン編集 → 再取り込み（取り込み後の CSV 削除は行わない）
   - Settings: AUTH_CONCURRENCY / MAX_RETRIES / タイムアウト
   - i18n: 日本語既定、英語切替
10. **テスト**:
    - unit: CSV 検証（300 件 / 重複 / 不正 email / password 欠落 / host 欠落）、Cipher、ErrorClassifier、RetryPolicy、Queue の上限
    - integration: 自作 fake IMAP サーバーに対し 300 成功 / 100 成功 + 200 失敗 / timeout / wrong password / server unavailable。サーバー側で同時接続数を計測し 10 を超えないことを assert
    - oauth: 擬似 token endpoint に対し refresh 成功 / invalid_grant / タイムアウト / 有効期限内キャッシュ再利用。fake IMAP サーバーで AUTHENTICATE XOAUTH2 の成功・失敗
    - security: SQLite ファイルのバイト列に平文パスワードが含まれない、ログにパスワードが含まれない
    - PostgreSQL: `DATABASE_URL` があれば同じリポジトリテストを PG でも実行
11. **300 アカウント E2E 検証**: `scripts/gen-accounts-csv.ts` で 300 件生成（outlook/oauth2 150 件 + gmail/password 150 件を想定） → `scripts/dev-imap-server.ts` を起動（一部アカウントは意図的に誤パスワード・接続不可ホスト）→ GUI から Import → Test All → Dashboard の集計がサーバー側の設定値と一致することを確認。所要時間と最大同時接続数を README に記録。
12. **README**: セットアップ、起動、テスト、CSV フォーマット、セキュリティ方針。

## Phase 1 で意図的にやらないこと

- メール同期・保存（Phase 2）
- 検索・Mail Viewer（Phase 3）
- Gmail API / Microsoft Graph API 経由のメール取得（Phase 4）
- Google OAuth2（Gmail はアプリパスワード方式を既定とする。OAuth2 は任意対応）
- SMTP 送信
- コード署名 / notarization（配布方針の確認後）


---

# Phase 2〜5 実装状況（2026-09-06）

ユーザーの指示「未完了の実装をすすめてください」により、Phase 2 以降を実装した。

| 項目 | 状態 | 検証 |
|---|---|---|
| IMAP 同期（INBOX + 他フォルダ、UID 差分、重複排除、UIDVALIDITY 再同期） | ✅ | tests/integration/sync.test.ts（空 / 10 通 / 10,000 通 / 再同期 / 初回上限 / 40 アカウント同時 / 通信・認証エラー / Stop All） |
| 同期の Concurrency（SYNC_CONCURRENCY=20）とリトライ | ✅ | 擬似 IMAP で同時セッション ≤ 20 を assert |
| 同期進捗・最終同期日時・メール数の表示 | ✅ | E2E |
| 横断検索（件名 / 差出人 / 宛先 / 本文 / 添付名 / 日付 / アカウント / フォルダ / 添付あり / 未読） | ✅ | tests/integration/search.test.ts（100,000 通で各検索 < 1 秒。1,000,000 通は `MM_BIG_TESTS=1` で実行） |
| Mail Viewer（HTML サニタイズ、sandbox iframe、外部画像 OFF、添付一覧・ダウンロード） | ✅ | E2E（iframe の sandbox と CSP を検証） |
| 一括操作（既読/未読、削除→Trash） | ✅ | 統合テスト |
| 自動同期スケジューラ / macOS 通知 / Webhook | ✅ | 実装済み（通知は main プロセスで Electron Notification、Webhook は SYNC_*/NEW_MESSAGE/AUTH_FAILED を POST） |
| CSV エクスポート（アカウント・検索結果）/ バックアップ（VACUUM INTO）/ 復元（次回起動時に差し替え） | ✅ | 統合テスト |
| OAuth2 の対話ログイン画面 | 未実装 | ユーザーは client_id + refresh_token を保有しているため不要と判断 |
| IMAP IDLE / Gmail API / Microsoft Graph | 未実装 | 自動同期はポーリング方式 |
| ルール / 自動転送 / 自動処理（SMTP） | 未実装 | Phase 5 の残り |
