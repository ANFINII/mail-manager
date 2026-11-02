# Mail Manager

[![CI](https://github.com/ANFINII/mail-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ANFINII/mail-manager/actions/workflows/ci.yml)

300 件規模のメールアカウントを 1 つの GUI から管理するデスクトップアプリ（macOS / Windows / Linux）。
CSV 一括登録・ブラウザでの OAuth サインイン、一括認証テスト、IMAP 差分同期（IDLE によるプッシュ受信・フラグ変更の取り込み）、全アカウント横断検索、Mail Viewer、自動ルール（転送・既読・移動・削除・Webhook）、健全性モニタ、保存容量の管理、バックアップに対応。
要件は [PROJECT_SPEC.md](./PROJECT_SPEC.md)、技術選定は [docs/ADR-001-architecture.md](./docs/ADR-001-architecture.md)、Phase 1 計画は [docs/PHASE1_PLAN.md](./docs/PHASE1_PLAN.md) を参照。

## 構成

- Electron 44（Node 24 同梱）+ React 19 + TypeScript
- backend は `utilityProcess`（別プロセス）で動作し、UI スレッドを塞がない
- IMAP: [ImapFlow](https://github.com/postalsys/imapflow)（EmailEngine と同じエンジン、MIT）
- DB: Node 組み込みの `node:sqlite` + Kysely。PostgreSQL は `DATABASE_URL` で切替可
- 認証情報: AES-256-GCM で暗号化。鍵は macOS Keychain（Electron safeStorage）で保護し、DB には入れない
- 並行制御: 自作 TaskQueue（AUTH_CONCURRENCY=10 / SYNC_CONCURRENCY=20 既定）。通信エラーのみ 2s / 5s / 15s でリトライ、認証エラーは即確定
- 同期: UID による差分同期。(account, mailbox, UID) で重複を排除し、UIDVALIDITY 変化時は再同期。初回はフォルダごとに最新 N 通（既定 500）
- サーバー側の変更の取り込み: 取得済みメールの既読・スター・返信済みフラグの変更と、サーバーで削除・移動されたメールを同期のたびに反映。CONDSTORE 対応サーバーは HIGHESTMODSEQ / CHANGEDSINCE で差分だけ取得（変化が無ければフラグ取得自体を省略）
- プッシュ受信（IMAP IDLE）: 設定で選んだ対象（認証済みすべて / 1 グループ、同時接続数の上限あり）の INBOX を IDLE で監視し、新着が来たらそのアカウントだけ即時同期。自動同期 ON のときだけ接続し、25 分ごとに張り直し（OAuth トークン更新）、切断時は指数バックオフで再接続。IDLE 非対応サーバー・対象外は定期同期
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
- 自動ルール（動的ルール画面）: 件名・差出人・本文・全体のキーワードで、転送 / 既読 / スター / フォルダ移動 / 削除（ゴミ箱へ）/ Webhook 通知（ルールごとの URL、`RULE_MATCHED`）を実行。適用範囲をグループで絞り込み可、「既存メールにも適用」を OFF にするとルール作成後に届いたメールだけが対象（移動・削除は既定で OFF）。同じメールへ同じルールは二度適用しない。保存前に「試算（ドライラン）」で一致件数・実際に影響する件数・例を確認できる
- 健全性モニタ（要対応画面）: 認証失敗・エラー状態・連続失敗（3 回以上）・一定時間（既定 24 時間）受信に成功していない・転送失敗ありのアカウントを深刻度つきで一覧。選んでまとめて認証テスト／同期をやり直せる。ダッシュボードとメニューに件数を表示
- 転送ログ画面: 転送の成功履歴と、失敗（自動再試行のバックオフ待ち）を一覧。失敗は「今すぐ再試行」「記録を消去」できる
- OAuth2 の対話ログイン: インポート画面の「ブラウザでサインインして追加」、アカウント詳細の「ブラウザで再サインイン」から、Microsoft / Google のサインイン画面をブラウザで開いて refresh token を取得（RFC 8252: 認可コード + PKCE(S256) + 127.0.0.1 のループバックリダイレクト）。メールアドレスは id_token から取得し、既存アカウントの再サインインで別のメールボックスに入った場合は拒否。アプリ登録ではループバックのリダイレクト URI（http://127.0.0.1、ポート任意）を許可する
- 保存容量の管理（設定画面）: DB・添付ファイルの使用量を表示。メールの保存期間（古いメールはこの PC のコピーだけを削除、サーバーは残す）と添付ファイル本体の保存期間（必要時に再取得）を設定でき、1 日 1 回自動で整理。孤立した添付フォルダの掃除、DB の最適化（VACUUM）も可能
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

### リリース（GitHub Releases + 自動アップデート）

`v*` タグを push すると [Release ワークフロー](./.github/workflows/release.yml) が macOS（Universal の zip / dmg）・Windows（Squirrel インストーラー）・Linux（deb / zip）をビルドし、GitHub Releases に**下書き**としてアップロードする。内容を確認してから公開する。

```bash
npm version patch   # package.json の version を上げてタグを作る
git push --follow-tags
```

- 配布版は 1 時間ごとに [update.electronjs.org](https://github.com/electron/update.electronjs.org) 経由で新しいリリースを確認し、ダウンロード後に再起動を促す（macOS / Windows。Linux は手動更新）
- macOS の署名・公証は、リポジトリの secrets に `MACOS_CERT_P12`（Developer ID Application 証明書の .p12 を base64 化）・`MACOS_CERT_PASSWORD`・`APPLE_SIGN_IDENTITY`・`APPLE_ID`・`APPLE_APP_SPECIFIC_PASSWORD`・`APPLE_TEAM_ID` を設定すると有効になる。未設定なら署名なしでビルドする（Gatekeeper の警告が出る。macOS の自動アップデートは署名済みビルドでのみ動く）
- 自動アップデートを止めるには `MM_DISABLE_AUTO_UPDATE=1`

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
| `MM_SYNC_FLAG_CHANGES`, `MM_IDLE_GROUP_ID`, `MM_IDLE_MAX_CONNECTIONS`, `MM_HEALTH_STALE_HOURS`, `MM_RETENTION_DAYS`, `MM_ATTACHMENT_RETENTION_DAYS` | 設定の上書き（同上） |
| `MM_OAUTH_TOKEN_URL_OUTLOOK`, `MM_OAUTH_TOKEN_URL_GMAIL`, `MM_OAUTH_AUTHORIZE_URL_OUTLOOK`, `MM_OAUTH_AUTHORIZE_URL_GMAIL` | OAuth の token / authorize endpoint の差し替え（擬似サーバー用） |
| `MM_IDLE_RENEW_MS`, `MM_IDLE_BACKOFF_MS` | IDLE の張り直し間隔・再接続待ち（テスト用） |
| `MM_STORAGE_SCHEDULE=0` | 保存容量の自動整理を止める（テスト用） |
| `MM_DISABLE_AUTO_UPDATE=1` | 配布版の自動アップデートを止める |
| `MM_INSECURE_KEY_FILE=1` | 暗号鍵を Keychain ではなくファイルに置く（**テスト専用**） |
| `MM_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `MM_OPEN_DEVTOOLS=1` | 起動時に DevTools を開く |

## データの場所

- macOS: `~/Library/Application Support/mail-manager/`（Windows: `%APPDATA%\mail-manager\`、Linux: `~/.config/mail-manager/`）
  - `mail-manager.sqlite` … アカウント（認証情報は暗号化済み）
  - `master.key` … safeStorage（macOS Keychain / Windows DPAPI / Linux キーリング）で包んだマスターキー。Linux でキーリングが無い場合は保護が弱いため設定画面で警告する
  - `logs/app.log` … アプリケーションログ（パスワード・トークンは出力されない）
  - `attachments/<message id>/` … ダウンロードした添付ファイル

## ディレクトリ

```
src/main/      Electron main（ウィンドウ、Keychain、backend プロセス管理、IPC）
src/preload/   contextBridge
src/backend/   純 TypeScript のバックエンド（accounts / auth / sync / search / messages / rules / stats / storage / oauth / mail / queue / db / security / logging / export）
src/renderer/  React UI（Dashboard / Accounts / AccountDetail / Search + MessageViewer / Sent / Rules / ForwardLog / Health / Import / Settings）
src/shared/    IPC 契約と共有型
tests/         unit / integration / e2e、擬似サーバー（tests/helpers。IMAP は CONDSTORE / IDLE、OAuth は認可コードフローにも対応）
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
| 2. IMAP 同期（INBOX + 他フォルダ、差分同期、リトライ、進捗、フラグ変更・削除の取り込み） | 完了 |
| 3. 横断検索 / Mail Viewer / 添付 / 各種フィルタ | 完了（PostgreSQL は pg_trgm の GIN 索引で部分一致検索） |
| 4. 自動同期・IMAP IDLE・macOS 通知・Webhook・リアルタイム更新・OAuth2 対話ログイン | 完了 |
| 5. 一括メール操作・自動ルール・転送ログ・健全性モニタ・CSV エクスポート・バックアップ/復元・保存容量の管理 | 完了 |
| 配布 | macOS / Windows / Linux のビルド、GitHub Releases、自動アップデート（署名は secrets 設定時） |

未実装: Gmail API / Microsoft Graph 経由のメール取得（取得は IMAP。Graph は送信のみ）、QRESYNC（削除の検出は UID SEARCH で行う）。
