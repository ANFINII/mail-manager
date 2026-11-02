# PROJECT_SPEC.md

# 300アカウント対応 大量メール管理システム

## 1. プロジェクト概要

300件程度のメールアカウントを一括管理する、Mac対応のデスクトップ型メール管理アプリケーションを開発する。

本システムは、一般的なメールクライアントではなく、以下の用途を主目的とする。

- 大量のメールアカウントをCSVから一括登録
- 複数アカウントの認証状態を一括確認
- 複数アカウントを並行してIMAP接続
- メールをバックグラウンドで同期・取得
- 全アカウント横断でメールを検索
- アカウントごとの接続状態・同期状態をGUIで確認
- 認証エラーや接続エラーを一覧表示
- 将来的に一括操作・自動処理を追加できる設計にする

中国製ソフト「心蓝邮箱助手」に近い用途を実現することが目的だが、UIや実装をコピーする必要はない。

---

# 2. 最重要要件

以下は本プロジェクトの最重要要件である。

## 2.1 アカウント一括登録

CSVファイルから最大300～1,000程度のメールアカウントを一括登録できること。

例:

```
email,password,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure
user001@example.com,password001,imap.example.com,993,true,smtp.example.com,465,true
user002@example.com,password002,imap.example.com,993,true,smtp.example.com,465,true
```

ただし、メールサービスによってはパスワード認証ではなくOAuth2が必要になるため、将来的にOAuth2にも対応可能な設計にする。

---

# 3. 一括認証

CSVから読み込んだアカウントについて、GUIから一括認証テストを実行できること。

例:

```
[ Test All Accounts ]

300 accounts
--------------------------------
Connected       287
Authentication   9
Connection       3
Unknown Error    1
--------------------------------
```

個別アカウントだけの認証テストも可能にする。

認証処理は無制限に同時実行してはいけない。

必ずConcurrency Limitを設ける。

初期値:

```
AUTH_CONCURRENCY=10
```

将来的にGUIから変更可能にする。

---

# 4. メール取得

認証済みアカウントについて、IMAPを利用してメールを同期する。

要件:

- Inbox同期
- 他フォルダの同期
- 新着メール取得
- UIDを利用した差分同期
- 同じメールを重複保存しない
- 接続エラー時の自動Retry
- 認証エラーと通信エラーを区別
- 同期状態をDBに保存
- 最終同期日時を表示

300アカウントを一斉に無制限接続するのではなく、必ずConcurrency Limitを使用する。

初期値:

```
SYNC_CONCURRENCY=20
```

---

# 5. メール検索

最重要機能の一つ。

全アカウント横断検索を可能にする。

検索対象:

- From
- To
- Cc
- Subject
- 本文
- Date
- Account
- Folder
- Message-ID
- 添付ファイル名

GUI例:

```
Search

[ invoice                                  ]

Account:
[ All Accounts ▼ ]

Folder:
[ All Folders ▼ ]

Date:
[ 2026/01/01 ] - [ 2026/09/05 ]

From:
[                                        ]

Subject:
[                                        ]

[ SEARCH ]
```

検索結果:

```
Account             From             Subject             Date
----------------------------------------------------------------
001@example.com     aaa@example.com  Invoice #123        2026-09-05
027@example.com     bbb@example.com  Invoice September   2026-09-05
119@example.com     ccc@example.com  Re: Invoice         2026-09-04
```

検索結果からメール本文を表示できること。

---

# 6. GUI

Macで利用できるデスクトップGUIを作る。

第一候補:

- Tauri
- React
- TypeScript

バックエンド:

- RustまたはNode.js/TypeScript

ただし、技術的により適切な構成があれば変更してよい。

GUIはシンプルで高速であることを優先する。

---

# 7. GUI画面

## 7.1 Dashboard

以下を表示:

```
Accounts:       300
Connected:      287
Authentication:   9
Connecting:      3
Error:           1

Last Sync:
2026-09-05 22:30:12
```

ボタン:

```
[ Import CSV ]
[ Test All ]
[ Sync All ]
[ Stop All ]
```

---

## 7.2 Accounts

アカウント一覧。

列:

- Email
- Status
- Auth Status
- Last Sync
- Message Count
- Error
- Last Error Time

ステータス例:

- Connected
- Connecting
- Disconnected
- Authentication Error
- Connection Error
- Syncing
- Disabled

フィルタ:

```
All
Connected
Error
Authentication Error
Syncing
Disabled
```

---

## 7.3 Account Detail

個別アカウント画面。

表示:

- Email
- IMAP Server
- SMTP Server
- Authentication Type
- Connection Status
- Last Sync
- Total Messages
- Last Error

操作:

```
[ Test Connection ]
[ Sync Now ]
[ Disable ]
[ Delete ]
```

パスワードは通常画面に表示しない。

---

## 7.4 Search

全アカウント横断検索。

検索結果はページネーションする。

大量結果をGUIに一度に描画しない。

---

## 7.5 Mail Viewer

メールをクリックすると本文を表示する。

表示:

- From
- To
- Cc
- Subject
- Date
- Body
- Attachments

HTMLメールを表示する場合はXSS対策を必ず行う。

メール本文内のJavaScriptは実行しない。

外部画像の自動ロードもデフォルトでは無効にする。

---

# 8. データベース

PostgreSQLを第一候補とする。

開発初期はSQLiteでもよいが、最終的にはPostgreSQLを利用できる設計にする。

## accounts

```
id
email
imap_host
imap_port
imap_secure
smtp_host
smtp_port
smtp_secure
auth_type
encrypted_credentials
status
last_sync_at
last_error
last_error_at
created_at
updated_at
```

## mailboxes

```
id
account_id
remote_id
name
path
total_messages
last_sync_uid
last_sync_at
created_at
updated_at
```

## messages

```
id
account_id
mailbox_id
remote_uid
message_id
thread_id
from_address
from_name
to_addresses
cc_addresses
subject
text_body
html_body
date
size
has_attachments
created_at
updated_at
```

## attachments

```
id
message_id
filename
content_type
size
storage_path
created_at
```

---

# 9. 認証情報の安全管理

メールパスワードを平文でDBに保存してはいけない。

以下を必須とする。

- AES-256-GCM等による暗号化
- 暗号鍵をDBに保存しない
- macOS Keychainの利用を検討
- アプリケーション設定ファイルへの平文パスワード保存禁止
- ログにパスワードを出力しない
- エラーメッセージに認証情報を含めない

CSVインポート直後の平文パスワードは可能な限り速やかに暗号化する。

CSV自体も処理後に削除できるようにする。

---

# 10. メールサーバーへの接続

IMAPを基本とする。

対応:

- IMAP over TLS
- STARTTLS
- POP3は将来的に対応
- SMTPは将来的に対応
- OAuth2は将来的に対応

メールサービスごとに挙動が異なるため、接続層を抽象化する。

例:

```
EmailProvider
 ├── GenericIMAPProvider
 ├── GmailProvider
 ├── MicrosoftProvider
 └── CustomProvider
```

---

# 11. Concurrency / Queue

300アカウントを扱うため、Queueシステムを必須とする。

悪い例:

```
for account in accounts:
    connect(account)
```

さらに悪い例:

```
Promise.all(accounts.map(connect))
```

300アカウントすべてを無制限に同時接続してはいけない。

必ず以下のようにする。

```
300 Accounts
     |
     v
Task Queue
     |
     +---- Worker 1
     +---- Worker 2
     +---- Worker 3
     ...
     +---- Worker 20
```

初期設定:

```
AUTH_CONCURRENCY=10
SYNC_CONCURRENCY=20
SEARCH_CONCURRENCY=10
```

メールサーバーごとのRate Limitも将来的に設定できるようにする。

---

# 12. Retry

通信エラーの場合はRetryする。

初期設定:

```
MAX_RETRIES=3
```

Exponential Backoffを利用する。

例:

```
1st retry: 2 sec
2nd retry: 5 sec
3rd retry: 15 sec
```

ただし、Authentication Errorは無意味にRetryしない。

例えば、

```
Invalid password
Authentication failed
OAuth token invalid
```

などは即座にAuthentication Errorとして記録する。

---

# 13. ログ

アプリケーションログを保存する。

ログレベル:

- DEBUG
- INFO
- WARN
- ERROR

ログ例:

```
[INFO] Account 001 sync started
[INFO] Account 001 sync completed
[WARN] Account 027 connection timeout
[ERROR] Account 119 authentication failed
```

絶対にログへ出してはいけない:

- Password
- OAuth token
- Client secret
- Encryption key

---

# 14. CSV Import

CSVインポート時に以下をチェックする。

- Email形式
- 重複
- IMAP host
- Port
- Secure設定
- Passwordの存在
- Authentication Type

エラーがある行はGUIで表示する。

例:

```
Import Result

Valid:  287
Invalid: 13

Row 23:
Invalid email

Row 51:
Duplicate email

Row 82:
Missing IMAP host
```

エラー行だけ再編集できるようにする。

---

# 15. アカウントの一括操作

GUIから以下を実行できること。

```
[ Test Selected ]
[ Test All ]

[ Sync Selected ]
[ Sync All ]

[ Enable Selected ]
[ Disable Selected ]

[ Delete Selected ]
```

大量操作では必ずQueueを使用する。

---

# 16. メール同期

同期方式は差分同期を基本とする。

基本:

```
Last UID
    ↓
IMAP UID SEARCH
    ↓
New messages
    ↓
Fetch
    ↓
DB
```

既に取得済みのメールを何度も取得しない。

Message-IDだけを重複判定に使わない。

アカウントID + mailbox ID + remote UIDを基本的な識別子とする。

---

# 17. 検索インデックス

300アカウント規模を考慮し、検索速度を重視する。

初期段階:

PostgreSQL Full Text Search

またはSQLite FTS5。

将来的にメール数が非常に多くなった場合:

- Elasticsearch
- OpenSearch
- Meilisearch

などへの移行を可能にする。

検索APIとDBを疎結合にする。

---

# 18. Webhook / Event Architecture

将来的にリアルタイム新着メール通知を実装できる構造にする。

イベント例:

```
ACCOUNT_CONNECTED
ACCOUNT_DISCONNECTED
AUTH_FAILED
SYNC_STARTED
SYNC_COMPLETED
SYNC_FAILED
NEW_MESSAGE
```

GUIはイベントを受信してリアルタイム更新できる構造にする。

---

# 19. セキュリティ

必須:

- パスワード暗号化
- Keychain利用
- HTTPS/TLS
- HTMLメールのサニタイズ
- JavaScript実行禁止
- 外部画像デフォルトOFF
- SQL Injection対策
- CSRF対策
- API認証
- ログへの秘密情報出力禁止

特にメール本文は外部から取得した「信頼できないデータ」として扱う。

---

# 20. アーキテクチャ

推奨:

```
┌─────────────────────────────┐
│         Tauri GUI           │
│       React / TypeScript    │
└──────────────┬──────────────┘
               │
               │ IPC / API
               ▼
┌─────────────────────────────┐
│      Application Layer      │
│                             │
│ Account Manager             │
│ Authentication Manager      │
│ Sync Manager                │
│ Search Manager              │
│ Queue Manager               │
└──────────────┬──────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌──────────────┐
│ Mail Engine │  │ PostgreSQL   │
│ IMAP        │  │              │
│ SMTP        │  │ Accounts     │
│ OAuth       │  │ Messages     │
└──────┬──────┘  │ Mailboxes    │
       │         │ Attachments  │
       ▼         └──────────────┘
┌─────────────────────────────┐
│       Mail Servers          │
│ Account 001 ... Account 300 │
└─────────────────────────────┘
```

---

# 21. EmailEngineについて

EmailEngineの採用を検討する。

公式:

https://emailengine.app/

EmailEngineを採用する場合は、既存の機能を無理に自作しない。

以下をEmailEngineに任せられる場合は利用する。

- IMAP connection
- Mail synchronization
- Authentication
- Mail fetching
- Mailbox handling
- OAuth
- Webhook

自作する部分:

- CSV Import
- Account Management GUI
- Search UI
- Dashboard
- Bulk Operations
- Application-specific business logic

ただし、EmailEngineのライセンス、料金、商用利用条件を必ず確認してから採用する。

EmailEngineを採用しない場合でも、後から置き換え可能な抽象化レイヤーを作る。

---

# 22. Mac対応

第一ターゲット:

```
macOS Apple Silicon
```

可能であればIntel Macもサポートする。

最終的には:

```
Universal macOS Build
```

を目標とする。

Tauriを利用する場合は、macOSのKeychainアクセスを適切に実装する。

---

# 23. 初期MVP

最初から全機能を作らない。

Phase 1では以下だけを実装する。

### Phase 1

- Mac GUI
- CSV Import
- Account List
- Account validation
- IMAP Authentication Test
- Authentication Status
- Account Delete
- SQLite/PostgreSQL
- Concurrency Control
- Logging

この段階で300アカウントのCSVを読み込み、

```
300 accounts
```

を処理できることを確認する。

---

# 24. Phase 2

- IMAP synchronization
- Inbox synchronization
- Mailbox list
- Message storage
- New mail detection
- Sync progress
- Retry
- Error handling

---

# 25. Phase 3

- Global Search
- Advanced Search
- Mail Viewer
- HTML mail
- Attachment list
- Account filter
- Date filter
- Sender filter
- Subject filter

---

# 26. Phase 4

- OAuth2
- Gmail
- Microsoft 365
- Webhook
- Real-time updates
- Background sync
- macOS notifications

---

# 27. Phase 5

- Bulk mail operations
- Export
- CSV export
- Backup
- Restore
- Rules
- Automatic forwarding
- Automatic processing

ただし、これらはPhase 1～3が安定してから実装する。

---

# 28. Claude Codeへの実装方針

Claude Codeは以下の原則に従う。

## 原則1

いきなり大量のコードを書かない。

最初に:

1. Repository構造を確認
2. PROJECT_SPEC.mdを読む
3. 技術選定
4. アーキテクチャを提案
5. 不明点を列挙
6. Phase 1を実装

する。

---

## 原則2

実際に動くコードを優先する。

モックだけで終わらせない。

最低限、

```
CSV
 ↓
300 accounts
 ↓
DB
 ↓
Authentication Test
 ↓
GUI status
```

まで実際に動かす。

---

## 原則3

300アカウントを想定する。

10アカウントで動けばOKという設計は禁止。

最低300アカウントを前提にする。

可能なら1,000アカウントでも破綻しない設計にする。

---

## 原則4

Concurrencyを必ず実装する。

無制限のPromise.allは禁止。

Queue + Worker方式を使用する。

---

## 原則5

エラーを握りつぶさない。

各アカウントごとに:

```
status
last_error
last_error_at
retry_count
last_success_at
```

を記録する。

---

# 29. テスト

最低限以下のテストを作る。

## CSV

- 300 accounts
- Duplicate accounts
- Invalid email
- Missing password
- Missing IMAP host

## Authentication

- 300 success
- 100 success / 200 failure
- Timeout
- Wrong password
- Server unavailable

## Synchronization

- Empty inbox
- 10 messages
- 10,000 messages
- Duplicate messages
- Network failure
- Authentication failure

## Search

- 100,000 messages
- 1,000,000 messages
- Search by subject
- Search by sender
- Search by body
- Search by date
- Search across all accounts

---

# 30. パフォーマンス目標

300アカウントを処理できること。

目標:

```
CSV Import:
< 5 sec

300 account DB insertion:
< 10 sec

Authentication:
Concurrency 10

Synchronization:
Concurrency 20

GUI:
60 FPSを目標

Search:
通常検索 < 1 sec
```

ただし、メールサーバー側の速度は制御できないため、ネットワーク依存部分については別途計測する。

---

# 31. UI/UX

UIは日本語を第一言語とする。

将来的に:

- 日本語
- 英語

を切り替えられる構造にする。

デザインはシンプルな業務アプリケーションを目指す。

不要なアニメーションは禁止。

大量データを扱うため、Virtualized List/Tableを使用する。

---

# 32. プロジェクト構造

例:

```
mail-manager/
│
├── PROJECT_SPEC.md
├── README.md
├── package.json
│
├── apps/
│   └── desktop/
│
├── frontend/
│   ├── components/
│   ├── pages/
│   ├── hooks/
│   ├── stores/
│   └── services/
│
├── backend/
│   ├── accounts/
│   ├── authentication/
│   ├── sync/
│   ├── search/
│   ├── queue/
│   ├── mail/
│   └── security/
│
├── database/
│   ├── migrations/
│   └── schema/
│
├── tests/
│
└── docs/
```

実際の構成は技術選定後に最適化してよい。

---

# 33. 開発開始時のClaude Codeへの指示

Claude Codeは、このファイルを読み込んだら最初に以下を実行する。

```
1. PROJECT_SPEC.mdを完全に読む
2. 現在のRepositoryを調査
3. 必要な技術スタックを決定
4. EmailEngineを採用する場合と自前IMAP実装の場合を比較
5. 最適な構成を提案
6. Phase 1の実装計画を作成
7. その後、Phase 1を実装
8. テストを実行
9. 実際に300アカウントを処理できるか検証
```

勝手にPhase 2以降まで実装しない。

---

# 34. 重要な設計判断

以下については、実装前に必ず確認する。

### A. EmailEngineを使用するか

候補:

```
Option A:
Tauri + React + EmailEngine + PostgreSQL

Option B:
Tauri + React + 自前IMAP + PostgreSQL
```

基本的にはOption Aを第一候補とする。

ただし、EmailEngineのライセンス・コスト・性能・必要機能を確認する。

---

### B. DB

300アカウント程度ならSQLiteでも動作可能。

ただし、将来的に1,000アカウント以上を想定するため、

```
PostgreSQL
```

を第一候補とする。

---

### C. Mail Search

Phase 1ではDBの基本検索。

Phase 3でFull Text Searchを導入。

---

# 35. 完成条件

以下を満たしたらMVP完成とする。

```
[✓] Macで起動できる
[✓] CSVを読み込める
[✓] 300アカウントをDBに登録できる
[✓] アカウント一覧を表示できる
[✓] 一括認証テストできる
[✓] 認証結果を一覧表示できる
[✓] Concurrencyが制御されている
[✓] エラーがアカウント単位で確認できる
[✓] パスワードが平文保存されていない
[✓] ログにパスワードが出ない
[✓] 300アカウントで動作確認できる
```

---

# 36. 絶対に避けること

以下は禁止。

- パスワードの平文DB保存
- パスワードのログ出力
- 無制限の並列接続
- Promise.allによる300アカウント同時接続
- HTMLメール内JavaScriptの実行
- SQL文字列連結による検索
- 認証エラーの無限Retry
- UIスレッドで大量メールを処理
- 300アカウントを前提としない設計
- テストなしで大量アカウントに接続すること

---

# 37. 最終目標

最終的には以下のようなアプリケーションにする。

```
┌─────────────────────────────────────────────┐
│ Mail Manager                                │
├─────────────────────────────────────────────┤
│                                             │
│ Accounts        300                         │
│ ● Connected     287                         │
│ ● Syncing         4                         │
│ ⚠ Auth Error      8                         │
│ ✕ Error           1                         │
│                                             │
│ [Import CSV] [Test All] [Sync All]          │
│                                             │
├─────────────────────────────────────────────┤
│ Search                                      │
│                                             │
│ [ invoice                         ] [Search]│
│                                             │
├─────────────────────────────────────────────┤
│ Account       From          Subject    Date │
│                                             │
│ 001@...       aaa@...       Invoice    9/5  │
│ 027@...       bbb@...       Invoice    9/5  │
│ 119@...       ccc@...       Invoice    9/4  │
│                                             │
└─────────────────────────────────────────────┘
```

最終的には、

**「300個のメールアカウントを一つのGUIから管理し、認証・同期・検索・状態監視を一括で行えるMacアプリ」**

を完成させる。

心蓝邮箱助手そのものをコピーするのではなく、必要な機能をより安全かつ保守しやすい構成で再実装する。
