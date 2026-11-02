# ADR-001: 技術選定とアーキテクチャ

日付: 2026-09-05
状態: 承認済み（2026-09-05）。Phase 1 実装済み

## 1. 調査した環境

| 項目 | 結果 |
|---|---|
| OS / CPU | macOS 26.3.1 / Apple Silicon (arm64) |
| Node.js | v24.19.0 (npm 11.17, pnpm 10.33) |
| Rust / cargo | 未インストール |
| PostgreSQL (psql) | 未インストール |
| SQLite | 3.51.0 |
| Docker | 27.4.0（PostgreSQL / テスト用 IMAP サーバーを起動可能） |
| Xcode CLT | インストール済み |
| リポジトリ | `~/Documents/mail-manager/` は新規作成。git 未初期化 |

## 2. EmailEngine vs 自前 IMAP 実装

### 2.1 EmailEngine の一次情報（2026-09-05 時点）

出典: https://emailengine.app/ , https://learn.emailengine.app/docs/licensing , https://postalsys.com/plans

- ライセンス: 「EmailEngine License」。OSS ではなくサブスクリプション型の商用ライセンス。
- 価格: **$1,450 / 年**（EU は €1,200 / 年）。インスタンス数・アカウント数・API 呼び出し数は無制限。永久ライセンスは営業問い合わせ。
- トライアル: 14 日間、全機能、カード登録不要。
- ライセンス切れ時: 「IMAP, sending, SMTP server, webhook, IMAP proxy の各ワーカーが停止」。API と管理画面のみ動作。
- 動作要件: **Node.js サーバー + Redis**。単一バイナリ / Docker / npm で配布。
- 規模: 1 インスタンスで「数千アカウント」。垂直スケール。
- 対応: IMAP / SMTP / Gmail API / Microsoft Graph / OAuth2 / Webhook。POP3 非対応。
- 再配布: 自社 SaaS の一部として再販可。ただし各インスタンスにライセンスキーの有効化が必要。
- 参考: 中核の IMAP エンジン **ImapFlow は MIT ライセンス**で単体公開されている（同じ Postal Systems 社製、v1.7.8）。

### 2.2 比較

| 観点 | Option A: EmailEngine | Option B: 自前 IMAP (ImapFlow) |
|---|---|---|
| コスト | $1,450/年（継続課金。切れると IMAP 停止） | 0 円（MIT） |
| Mac デスクトップへの適合 | 低い。EmailEngine サーバー + Redis の 2 デーモンを同梱・起動・監視する必要がある | 高い。アプリ内プロセスで完結 |
| IMAP 品質 | 実績多数 | EmailEngine と同じ ImapFlow を使うため同等 |
| 300 アカウント並行 | 対応（内部で管理） | p-queue 等で明示的に制御（仕様 §11 に合致） |
| 全アカウント横断検索 | EmailEngine 自身はローカルにメール本文を蓄積しない。横断検索には結局自前 DB への取り込みが必要 | 自前 DB + FTS で設計どおり実現 |
| OAuth2 (Gmail / M365) | 組み込み済み（大きな利点） | Phase 4 で自前実装（ImapFlow は XOAUTH2 対応。OAuth フロー・トークン更新は自作） |
| Webhook / 新着通知 | 組み込み済み | Phase 4 で IDLE + 内部イベントバスで実装 |
| データの所在 | Redis + IMAP サーバー | ローカル SQLite / PostgreSQL |
| ライセンスキー運用 | 各 Mac で有効化が必要 | 不要 |

### 2.3 判断

**Option B（自前 IMAP 実装、ImapFlow 採用）を推奨する。**

理由:
1. 本プロジェクトは「Mac 上で動くデスクトップアプリ」であり、EmailEngine は「サーバーに常駐させる REST ブリッジ」。Redis 同梱とライセンスキー有効化はデスクトップ配布と相性が悪い。
2. 横断検索（最重要機能）は EmailEngine を使っても自前 DB への取り込みが必須で、任せられる範囲が想定より狭い。
3. EmailEngine の IMAP 品質の源泉である ImapFlow が MIT で使えるため、品質面の差が小さい。
4. OAuth2 / Webhook は Phase 4 の要件であり、Phase 1〜3 では利点にならない。

ただし仕様 §21 に従い、`EmailProvider` インターフェースで接続層を抽象化し、将来 EmailEngine 版プロバイダー（REST 経由）に差し替えられる構造にする。

## 3. GUI シェル: Tauri vs Electron

| 観点 | Tauri v2 + Rust バックエンド | Tauri v2 + Node サイドカー | Electron + TypeScript |
|---|---|---|---|
| 必要なツールチェーン | Rust（未インストール。要導入） | Rust + Node 単一バイナリ化 (SEA) | Node のみ（導入済み） |
| IMAP ライブラリ | async-imap 0.11（活発。ただし Gmail / Outlook / 各社固有の癖は自前対応） | ImapFlow | ImapFlow |
| ネイティブモジュール (SQLite) | sqlx / rusqlite で問題なし | SEA と native addon の相性が悪く配布が壊れやすい | electron-rebuild で安定 |
| Keychain | keyring crate | keyring crate（サイドカーとの鍵受け渡しが必要） | `safeStorage`（Keychain 由来の鍵で暗号化。標準 API） |
| バンドルサイズ / メモリ | 小（数十 MB / 低メモリ） | 中 | 大（約 150〜200 MB / ベース 200 MB 前後） |
| 言語数 | Rust + TS の 2 言語 | Rust + TS + ビルド配管 | TS のみ |
| Universal build | 対応 | 対応 | `@electron/universal` で対応 |
| 開発速度 | コンパイル時間と 2 言語で遅め | 最も遅い（配管が複雑） | 最速 |

**判断: Electron + React + TypeScript を推奨する。**

- 仕様 §6 は「技術的により適切な構成があれば変更してよい」としている。
- 決め手は IMAP 層。300 アカウントは複数プロバイダーにまたがる可能性が高く、プロバイダー固有の癖を吸収済みの ImapFlow をそのまま使える構成が最も安全。
- IMAP 処理は Electron の `utilityProcess`（別プロセス）で実行し、UI スレッドを塞がない（仕様 §36）。
- 代替案: ユーザーが Tauri を強く希望する場合は「Tauri + Rust + async-imap + sqlx」で進める。この場合 Rust の導入（rustup、数分）が前提になり、IMAP の互換性検証工数が増える。

## 4. データベース

- **既定: SQLite**（better-sqlite3、WAL モード、Phase 3 で FTS5）。デスクトップアプリに埋め込め、300〜1,000 アカウント・数十万〜百万件のメールは十分扱える。
- **PostgreSQL 対応**: クエリビルダー **Kysely** を使い、SQLite / PostgreSQL の両ダイアレクトを同じリポジトリ層で扱う。`DB_DRIVER=sqlite|postgres` で切替。
- Phase 1 では SQLite を既定にし、PostgreSQL は Docker 上で接続テストのみ行う（`DATABASE_URL` 指定時に統合テストが走る）。
- 注意: デスクトップアプリで PostgreSQL を既定にすると、利用者ごとに PostgreSQL サーバーの用意が必要になる。「サーバー共有モード」としてオプション扱いにするのが現実的。

## 5. 全体構成（Phase 1 時点）

```
┌───────────────────────────────────────────────┐
│ Renderer (React 19 / TypeScript / Vite)       │
│  Dashboard / Accounts / AccountDetail / Import│
│  TanStack Virtual (仮想テーブル) / zustand    │
└───────────────┬───────────────────────────────┘
                │ contextBridge + typed IPC
┌───────────────▼───────────────────────────────┐
│ Main process (Electron)                       │
│  ウィンドウ / ファイルダイアログ / safeStorage │
└───────────────┬───────────────────────────────┘
                │ MessagePort
┌───────────────▼───────────────────────────────┐
│ Backend utilityProcess (純 TypeScript)        │
│  AccountService  CsvImporter  AuthTestService │
│  TaskQueue(concurrency)  EventBus  Logger     │
│  CredentialCipher(AES-256-GCM)                │
│  EmailProvider ─► ImapFlowProvider            │
│  Repository(Kysely) ─► SQLite | PostgreSQL     │
└───────────────┬───────────────────────────────┘
                ▼
        Mail servers (IMAP over TLS / STARTTLS)
```

`src/backend/` は Electron に依存しない純 TypeScript として書き、Vitest で直接テストできるようにする。

## 6. 認証情報の保護方式

1. 初回起動時に 32 バイトのマスターキーを乱数生成。
2. マスターキーを Electron `safeStorage.encryptString()`（macOS Keychain の鍵で暗号化）で包み、`userData/master.key` に保存。DB には保存しない。
3. アカウントのパスワードは AES-256-GCM（IV 12 バイト乱数、AAD = email）で暗号化し、`encrypted_credentials` に JSON `{v,iv,tag,ct}` として保存。
4. CSV 取り込み時は「パース → 検証 → 即暗号化 → 平文破棄」。平文がディスクに書かれる経路を作らない。
5. ログは pino を使い、`password` / `pass` / `token` / `secret` 系のキーを redact。IMAP エラー文字列も `LOGIN` 以降を除去してから記録。
6. 取り込み後の CSV ファイルはアプリからは削除しない（ユーザー指示により Phase 1 の対象外）。

## 7. 主要ライブラリ（実装時に確定）

| 用途 | 採用 | 備考 |
|---|---|---|
| IMAP | imapflow 1.7.8 (MIT) | `verifyOnly` で認証確認のみ。XOAUTH2 / LOGIN / プロキシ対応 |
| デスクトップ | electron 44.2.0 (Node 24.20 同梱) | backend は `utilityProcess` で別プロセス実行 |
| ビルド | @electron-forge 7.11 + vite 7.3 + @vitejs/plugin-react 5 | `npm run make -- --arch=universal` で Universal Build |
| DB | **node:sqlite**（Node 組み込み）+ kysely 0.29 | ネイティブアドオン不要のため Electron でのリビルドが不要。FTS5 利用可を確認済み。PostgreSQL は kysely の PostgresDialect + pg で切替 |
| 並行制御 | 自作 `TaskQueue`（`src/backend/queue/task-queue.ts`） | p-queue は ESM 専用で CJS バンドルと相性が悪いため自作。同時実行数の動的変更・AbortSignal・clear に対応 |
| ログ | 自作 Logger（`src/backend/logging/logger.ts`） | キー名によるマスク + 登録済み秘密値の置換（パスワード・トークンが本文に混入しても消す） |
| CSV | csv-parse 7 | BOM / 引用符 / 行番号付き |
| UI | react 19 / react-router 7 / zustand 5 / @tanstack/react-virtual 3 / i18next 26 | 仮想テーブルで 300〜1,000 行を描画 |
| テスト | vitest 5 / @playwright/test 1.63 / selfsigned 5 | 擬似 IMAP・OAuth サーバーは `tests/helpers/` に自作 |

不採用にしたもの: better-sqlite3（node:sqlite で代替）、pino（バンドル時の動的 require 回避のため自作）、p-queue（ESM 専用）。

## 8. 未確定事項（ユーザー確認が必要）

1. ~~対象プロバイダー~~ → 回答済み（2026-09-05）: **Outlook と Gmail が多い**。§9 を参照。OAuth2 を Phase 1 に前倒しする。
   - 追加確認: Outlook アカウントは「client_id + refresh_token 付き」で手元にあるか、「メール + パスワードのみ」か。後者は 1 アカウントずつブラウザでの対話ログインが必要になる。
2. **GUI シェル**: Electron 推奨案で進めてよいか。Tauri 固定なら Rust 構成に切り替える。
3. **DB の既定**: SQLite 既定 + PostgreSQL 任意、でよいか。
4. **プロキシ**: アカウントごとの SOCKS5 / HTTP プロキシ指定は必要か（同一 IP から 300 接続すると遮断するプロバイダーがある。ImapFlow はプロキシ対応済みなので CSV 列追加で対応可能）。
5. **配布形態**: 自分の Mac だけで使うか、他者にも配布するか（コード署名 / notarization の要否）。
6. **テスト環境**: Phase 1 の検証は「ローカルの擬似 IMAP サーバー（自作 + Docker の GreenMail/Dovecot）に 300 ダミーアカウント」で行う。実アカウントは使わない。

## 9. プロバイダー別の認証方式（2026-09-05 追記: Outlook / Gmail 主体）

一次情報:
- Microsoft: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
- Microsoft: https://support.microsoft.com/en-us/office/outlook-and-other-apps-are-unable-to-connect-to-outlook-com-when-using-basic-authentication-f4202ebf-89c6-4a8a-bec3-3d60cf7deaef
- Google: https://support.google.com/a/answer/14114704

### 9.1 Outlook.com / Hotmail / Microsoft 365

- **パスワードによる IMAP 認証は使えない。** Basic 認証は Exchange Online と個人向け Microsoft アカウントの双方で廃止済み。個人アカウントにはアプリパスワードの代替もない。
- 使える方式: **OAuth2 + SASL XOAUTH2**。IMAP ホスト `outlook.office365.com:993`。
- スコープ: `https://outlook.office.com/IMAP.AccessAsUser.All` と `offline_access`（refresh token を得るため）。
- トークン取得フロー: authorization code（ブラウザ）または device code。いずれも **Microsoft Entra のアプリ登録（client_id）が必要**。個人アカウントを扱うには「個人 Microsoft アカウントを含む」種別で登録する。
- 300 アカウントの現実解:
  - (a) 各アカウントに **client_id + refresh_token** が既にある → CSV から取り込み、refresh token でアクセストークンを取得して XOAUTH2 で認証。対話操作なし。
  - (b) メール + パスワードしかない → アプリ内ブラウザで 1 アカウントずつログインして refresh token を取得し保存する。300 回の手動ログインが必要。
- refresh token の失効（`invalid_grant`）は Authentication Error として即確定し、リトライしない。
- 将来: Microsoft Graph API 経由の取得も `EmailProvider` の実装として追加可能（Phase 4）。

### 9.2 Gmail

- 「安全性の低いアプリ」のパスワード認証は廃止済み。使える方式は次の 2 つ。
  - **アプリパスワード**（2 段階認証を有効にした上で 16 文字のパスワードを発行）。IMAP の通常 LOGIN で動く。CSV の `password` 列にそのまま入れられる。
  - **OAuth2 (XOAUTH2)**。スコープ `https://mail.google.com/` は制限付きスコープで、外部ユーザー向けに公開するには Google の審査（セキュリティ評価を含む）が必要。審査前の「テスト」状態ではテストユーザー上限があり、300 アカウントには足りない。
- **推奨: Gmail はアプリパスワード方式を既定**にし、OAuth2 は任意対応にする。

### 9.3 設計への反映

- `auth_type = 'password' | 'oauth2'` を Phase 1 から両方サポートする。
- `provider = 'outlook' | 'gmail' | 'custom'` を追加し、IMAP/SMTP ホスト・ポートを自動補完する（CSV での指定は任意）。
- `encrypted_credentials` の JSON は `{ password }` または `{ client_id, client_secret?, refresh_token }` を暗号化して保持。access token はメモリ内キャッシュのみ（有効期限付き）。DB には保存しない。
- `backend/oauth/` に `MicrosoftOAuth` / `GoogleOAuth`（token endpoint への refresh）を実装。ネットワークエラーはリトライ、`invalid_grant` / `invalid_client` は認証エラー。
- ImapFlow は `auth: { user, accessToken }` で XOAUTH2 に対応済み。
- 対話ログイン画面（Electron の BrowserWindow で authorization code + PKCE）は、Outlook アカウントに refresh token が無い場合のみ Phase 1 に含める。
