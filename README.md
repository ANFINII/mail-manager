# Mail Manager

300 件規模のメールアカウントを 1 つの GUI から管理する macOS デスクトップアプリ。
CSV 一括登録、一括認証テスト、IMAP 差分同期、全アカウント横断検索、Mail Viewer、一括メール操作、バックアップに対応。
要件は [PROJECT_SPEC.md](./PROJECT_SPEC.md)、技術選定は [docs/ADR-001-architecture.md](./docs/ADR-001-architecture.md)、Phase 1 計画は [docs/PHASE1_PLAN.md](./docs/PHASE1_PLAN.md) を参照。

## 構成

- Electron 44（Node 24 同梱）+ React 19 + TypeScript
- backend は `utilityProcess`（別プロセス）で動作し、UI スレッドを塞がない
- IMAP: [ImapFlow](https://github.com/postalsys/imapflow)（EmailEngine と同じエンジン、MIT）
- DB: Node 組み込みの `node:sqlite` + Kysely。PostgreSQL は `DATABASE_URL` で切替可
- 認証情報: AES-256-GCM で暗号化。鍵は macOS Keychain（Electron safeStorage）で保護し、DB には入れない
- 並行制御: 自作 TaskQueue（AUTH_CONCURRENCY=10 / SYNC_CONCURRENCY=20 既定）。通信エラーのみ 2s / 5s / 15s でリトライ、認証エラーは即確定
- 同期: UID による差分同期。(account, mailbox, UID) で重複を排除し、UIDVALIDITY 変化時は再同期。初回はフォルダごとに最新 N 通（既定 500）
- 検索: SQLite FTS5（trigram トークナイザーで日本語も部分一致）。件名・差出人・宛先・本文・添付ファイル名・日付・アカウント・フォルダで絞り込み
- Mail Viewer: HTML は DOMPurify でサニタイズし、sandbox 付き iframe + CSP で描画。スクリプトは実行せず、外部画像は既定で読み込まない
- 送信メール画面「重複の控えを整理」: 同じアカウント・件名・宛先で重複した転送控え（Fwd:）を件数確認のうえ古い 1 通を残して削除（サーバーはゴミ箱へ移動、表示中のグループ／アカウント絞り込みが対象）
- 送信メール画面: グループ・宛先（To/Cc のアドレス・表示名の部分一致）で絞り込み。保存済み転送先を入力候補に表示
- 転送の高速化（添付キャッシュ）: 同期時に添付本体を保存（既定 ON、上限 10MB）することで、転送は送信のみになり IMAP への取り直しが不要。受信直後の自動転送が速くなる
- 転送ループ防止: 自動転送ルールと全件転送は受信メールだけを対象にし、送信済み・下書きフォルダのメールと自分が差出人のメール（自分の転送控え「Fwd:」）は対象外（SearchQuery.receivedOnly）
- 転送の重複防止: 行 ID の照合に加え、アカウント+Message-ID+宛先の恒久ログ（forward_log、再同期・再取り込みで行が変わっても残る）と、送信済みフォルダの控え（本文の Date / Message-ID マーカー）で転送済みを判定。宛先は大文字小文字を区別しない
- 転送の高速化・安定化: アカウント単位で並列（1 アカウント同時 3 通）、SMTP 接続プール、Graph/SMTP の認証エラーを 15 分記憶して同じ失敗を繰り返さない、失敗メールは指数バックオフ（5 分→最大 24 時間）で自動転送ルールから外す（手動転送は即時再試行）、送信中メールの二重転送防止、手動操作を自動転送より優先。app.log は 200MB を超えると起動時に .1 へ退避
- 再取り込み（更新）モード: 取り込み画面の「既存アカウントの認証情報を更新する」で、同じメールアドレスを重複扱いせず認証情報を上書き更新（受信済みメール・グループ・接続設定は保持、認証状態は未テストに戻す）
- 取り込み情報の保持: OAuth2 でも取り込み時の password 列の値（認証には使わない識別子など）を暗号化保存し、認証情報つきエクスポートで出力（不要な項目も欠落させない）
- アカウント一覧「認証情報つきで出力」: パスワード・OAuth2 トークンを平文で含む再取り込み可能な CSV を書き出す（警告確認つき。取り込み形式と同じ列でそのまま再インポート可）
- アカウント一覧「選択を CSV 出力」: チェックしたアカウントだけを CSV に書き出す（認証情報は含まない。設定画面の全件エクスポートと同じ列）
- アカウント詳細「認証情報を修正」: パスワード / OAuth2（client_id・client_secret・refresh_token）を画面から差し替え（空欄は現在値を維持、認証方式の切替可、保存後に認証テストを自動実行、暗号化保存・ログに残さない）
- アカウントのグループ管理: グループの作成/改名/削除、選択アカウントのグループ移動、アカウント一覧・受信メールのグループ絞り込み、CSV 取り込み時のグループ指定（画面の既定グループ or CSV の group 列）
- 一括操作: 既読/未読、削除（Trash へ移動）。添付ファイルは必要時に IMAP から取得。ローカル削除は全文検索表を rowid で消すため大量削除でも数ミリ秒/件
- Phase 4/5 の一部: 自動同期（起動時は OFF。受信メール／ダッシュボードの「自動同期」ボタンで ON にすると即時受信し、以後は設定間隔と認証完了時に受信）、macOS 通知、Webhook、CSV エクスポート、DB バックアップ/復元

## セットアップ

```bash
npm install
npm start          # 開発モードで起動（Vite HMR）
npm run typecheck  # 型チェック
npm test           # ユニット + 統合テスト（擬似 IMAP / OAuth サーバーを使用。ネットワーク不要）
```

パッケージと GUI の E2E テスト（Playwright がパッケージ済みアプリを起動）:

```bash
MM_E2E_BUILD=1 npm run package   # out/Mail Manager-darwin-arm64/
npm run test:e2e
```

配布用ビルド（Universal）:

```bash
npm run make -- --arch=universal
```

## 300 アカウントの動作確認（ダミーアカウント）

実アカウントは使わず、擬似サーバーとダミー CSV で確認する。

```bash
npm run dev:servers
# 別ターミナル
MM_OAUTH_TOKEN_URL_OUTLOOK=http://127.0.0.1:3180/token MM_RETRY_DELAYS_MS=500,1000,2000 npm start
```

`tests/fixtures/generated/dev-accounts-300.csv` を「CSV 取り込み」画面で取り込み、「全アカウントを認証テスト」を実行すると、
287 成功 / 9 認証エラー / 3 接続エラー / 1 その他エラー がダッシュボードに表示される。
「全アカウントを同期」を実行すると擬似サーバーに用意した約 10,000 通のダミーメールが取り込まれ、「検索」画面で横断検索・閲覧できる。

## CSV フォーマット

```
email,provider,auth_type,password,client_id,client_secret,refresh_token,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,proxy
u001@outlook.com,outlook,oauth2,,<client_id>,,<refresh_token>,,,,,,,
u002@gmail.com,gmail,password,<app_password>,,,,,,,,,,
u003@example.com,custom,password,<password>,,,,imap.example.com,993,tls,smtp.example.com,465,tls,socks5://127.0.0.1:1080
```

- `provider`: `outlook` / `gmail` / `custom`。省略時はメールアドレスのドメインから推定
- **Outlook / Hotmail / Microsoft 365 は OAuth2 必須**（Microsoft はパスワードによる IMAP 認証を廃止済み）。`client_id` と `refresh_token` を指定する
- **Gmail は 2 段階認証のアプリパスワード**を `password` 列に入れる
- `outlook` / `gmail` は `imap_*` / `smtp_*` を省略可（プリセットで補完。指定があれば上書き）
- `imap_secure`: `tls` / `starttls` / `none`（`true` / `false` も可）
- `proxy`: `socks5://host:port` など（任意。同一 IP からの大量接続を避けたい場合）
- 旧形式の 8 列 CSV（`email,password,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure`）と
  `email----password----client_id----refresh_token` 形式も受け付ける

取り込み後、エラー行は行番号と理由付きで表示され、その行だけを修正して再取り込みできる。

## 環境変数（開発・テスト用）

| 変数 | 用途 |
|---|---|
| `MM_USER_DATA` | userData（DB・ログ・鍵）の場所を変更 |
| `MM_DB_FILE` / `DATABASE_URL` / `MM_DB_DRIVER` | SQLite ファイルの場所 / PostgreSQL 接続 |
| `MM_AUTH_CONCURRENCY`, `MM_SYNC_CONCURRENCY`, `MM_MAX_RETRIES`, `MM_CONNECT_TIMEOUT_MS`, `MM_TLS_REJECT_UNAUTHORIZED`, `MM_RETRY_DELAYS_MS`, `MM_SYNC_FOLDERS`, `MM_INITIAL_SYNC_MESSAGES`, `MM_MAX_MESSAGE_BYTES`, `MM_AUTO_SYNC_INTERVAL_MIN`, `MM_NOTIFY_NEW_MAIL`, `MM_WEBHOOK_URL`, `MM_STORE_ATTACHMENTS` | 設定の上書き（GUI の設定より優先） |
| `MM_OAUTH_TOKEN_URL_OUTLOOK`, `MM_OAUTH_TOKEN_URL_GMAIL` | OAuth token endpoint の差し替え（擬似サーバー用） |
| `MM_INSECURE_KEY_FILE=1` | 暗号鍵を Keychain ではなくファイルに置く（**テスト専用**） |
| `MM_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `MM_OPEN_DEVTOOLS=1` | 起動時に DevTools を開く |

## データの場所

- macOS: `~/Library/Application Support/mail-manager/`
  - `mail-manager.sqlite` … アカウント（認証情報は暗号化済み）
  - `master.key` … safeStorage で包んだマスターキー
  - `logs/app.log` … アプリケーションログ（パスワード・トークンは出力されない）
  - `attachments/<message id>/` … ダウンロードした添付ファイル

## ディレクトリ

```
src/main/      Electron main（ウィンドウ、Keychain、backend プロセス管理、IPC）
src/preload/   contextBridge
src/backend/   純 TypeScript のバックエンド（accounts / auth / sync / search / messages / oauth / mail / queue / db / security / logging / export）
src/renderer/  React UI（Dashboard / Accounts / AccountDetail / Search + MessageViewer / Import / Settings）
src/shared/    IPC 契約と共有型
tests/         unit / integration / e2e、擬似サーバー（tests/helpers）
scripts/       ダミー CSV 生成、擬似サーバー起動
```

## セキュリティ方針（Phase 1）

- パスワード・refresh token は取り込み直後に暗号化し、平文を DB・設定ファイル・ログに書かない
- アクセストークンはメモリ内キャッシュのみ
- ログは秘密情報のキーをマスクし、さらに既知の秘密値を本文から除去する
- renderer は `contextIsolation` + `sandbox`、CSP 適用、`window.open` 禁止
- 認証エラーはリトライしない（無限リトライ防止）。同時接続数は必ず上限内

## 実装状況

| Phase | 状態 |
|---|---|
| 1. CSV 取り込み / 一括認証テスト / GUI | 完了 |
| 2. IMAP 同期（INBOX + 他フォルダ、差分同期、リトライ、進捗） | 完了 |
| 3. 横断検索 / Mail Viewer / 添付 / 各種フィルタ | 完了 |
| 4. 自動同期・macOS 通知・Webhook・リアルタイム更新 | 完了（OAuth2 の対話ログイン画面と Gmail API / Microsoft Graph 経由の取得は未実装。refresh token 付き CSV で運用） |
| 5. 一括メール操作（既読/未読/削除）・CSV エクスポート・バックアップ/復元 | 完了（ルール・自動転送・自動処理は未実装） |

未実装: OAuth2 の対話ログイン、IMAP IDLE によるプッシュ受信（自動同期はポーリング）、既存メールのフラグ変更の取り込み、SMTP 送信・自動転送、ルール処理、PostgreSQL での全文検索（LIKE にフォールバック）。
