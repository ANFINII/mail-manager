// フロントエンド・main・backend で共有する型定義。

export type Provider = 'outlook' | 'gmail' | 'custom';
export type AuthType = 'password' | 'oauth2';
export type SecureMode = 'tls' | 'starttls' | 'none';

/**
 * アカウントの接続状態。
 * - untested: まだ認証テストをしていない
 * - connecting: 認証テスト実行中（リトライ待ちを含む）
 * - connected: 認証テスト成功
 * - auth_error: 認証エラー（パスワード・トークン不正）。リトライしない
 * - connection_error: 通信エラー（タイムアウト・接続拒否・TLS など）。リトライ後も失敗
 * - error: 分類できないエラー
 * - disabled: 無効化されたアカウント
 * - syncing: Phase 2 で使用
 */
export type AccountStatus =
  | 'untested'
  | 'connecting'
  | 'connected'
  | 'auth_error'
  | 'connection_error'
  | 'error'
  | 'sync_error'
  | 'disabled'
  | 'syncing';

export type AuthStatus = 'untested' | 'ok' | 'failed';
export type ErrorKind = 'auth' | 'connection' | 'unknown';

export interface AccountSummary {
  id: string;
  email: string;
  provider: Provider;
  authType: AuthType;
  imapHost: string;
  imapPort: number;
  imapSecure: SecureMode;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: SecureMode | null;
  proxy: string | null;
  enabled: boolean;
  status: AccountStatus;
  authStatus: AuthStatus;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
  retryCount: number;
  messageCount: number;
  /** 所属グループ ID（未所属は null）。名前は groups.list / AccountGroupInfo で解決する。 */
  groupId: string | null;
  /** 認証テスト・同期が最終的に失敗した連続回数（成功で 0 に戻る） */
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

/** アカウントグループ（一括操作・絞り込みの単位） */
export interface AccountGroupInfo {
  id: string;
  name: string;
  accountCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * アカウント詳細画面からの認証情報の更新。
 * 空文字や未指定の秘密値（password / client_secret / refresh_token）は「変更しない」。
 * authType を切り替える場合は、その方式に必要な値をすべて指定する。
 */
export interface AccountCredentialsUpdate {
  authType?: AuthType;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** 保存後に認証テストを実行する（既定 true） */
  testAfterSave?: boolean;
}

export interface AccountDetail extends AccountSummary {
  /** OAuth2 の client_id は秘密情報ではないため表示する。secret / refresh token / password は返さない。 */
  oauthClientId: string | null;
  hasPassword: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
}

export type AccountFilter =
  | 'all'
  | 'connected'
  | 'error'
  | 'sync_error'
  | 'auth_error'
  | 'connection_error'
  | 'untested'
  | 'connecting'
  | 'syncing'
  | 'disabled';

export interface AccountListQuery {
  filter?: AccountFilter;
  search?: string;
  /** グループで絞り込む。'none' は未所属のみ。 */
  groupId?: string | 'none';
}

export interface DashboardStats {
  total: number;
  connected: number;
  connecting: number;
  authError: number;
  connectionError: number;
  unknownError: number;
  syncError: number;
  untested: number;
  disabled: number;
  lastTestAt: string | null;
  activeJobs: number;
  syncing: number;
  messages: number;
  lastSyncAt: string | null;
  /** 健全性モニタで「要対応」（critical / warning）と判定されたアカウント数 */
  needsAttention: number;
}

/** CSV 取り込みで秘密情報を除いた行の内容。GUI での再編集に使う。 */
export interface ImportRowFields {
  email: string;
  provider: string;
  auth_type: string;
  imap_host: string;
  imap_port: string;
  imap_secure: string;
  smtp_host: string;
  smtp_port: string;
  smtp_secure: string;
  proxy: string;
  /** CSV の group 列（グループ名） */
  group: string;
  client_id: string;
  has_password: boolean;
  has_client_secret: boolean;
  has_refresh_token: boolean;
  /**
   * 取り込み（再編集）画面でそのまま表示・編集できるよう、入力された秘密情報の値を返す。
   * これは取り込みセッション（backend のメモリ上のみ）に限った値で、DB・ログには平文で残さない。
   */
  password: string;
  client_secret: string;
  refresh_token: string;
}

export type ImportErrorCode =
  | 'missing_email'
  | 'invalid_email'
  | 'duplicate_in_file'
  | 'duplicate_in_db'
  | 'invalid_provider'
  | 'invalid_auth_type'
  | 'password_auth_not_supported'
  | 'missing_password'
  | 'missing_client_id'
  | 'missing_refresh_token'
  | 'missing_imap_host'
  | 'invalid_imap_port'
  | 'invalid_imap_secure'
  | 'invalid_smtp_port'
  | 'invalid_smtp_secure'
  | 'invalid_proxy';

export interface ImportRowError {
  row: number;
  email: string;
  errors: ImportErrorCode[];
  fields: ImportRowFields;
}

export interface ImportResult {
  sessionId: string;
  /** 今回処理した行数 */
  total: number;
  /** 今回 DB に登録した件数 */
  imported: number;
  /** 既存アカウントの認証情報を更新した件数（updateExisting 時） */
  updated: number;
  /** セッション全体で未解決のエラー行 */
  invalid: ImportRowError[];
  durationMs: number;
  /** 取り込み元ファイル名（表示用） */
  source: string;
}

export interface ImportRowEdit {
  row: number;
  /** 編集後の値。password / client_secret / refresh_token を含めてよい（空文字は「変更なし」）。 */
  fields: Partial<Record<string, string>>;
}

/** 送信済みフォルダに溜まった転送控え（Fwd:）の重複の集計 */
export interface DuplicateSentCopies {
  /** 重複している（同じアカウント・件名・宛先の）控えの種類数 */
  groups: number;
  /** 古い 1 通を残して削除できる余分な控えの数 */
  extra: number;
  /** 対象アカウント数 */
  accounts: number;
  /** 例（件名、最大 5 件） */
  sampleSubjects: string[];
}

/** 自動同期ボタンの状態。起動時は常に OFF（永続化しない）。 */
export interface AutoSyncState {
  enabled: boolean;
  /** 定期受信の間隔（秒）。0 なら定期受信なし。 */
  intervalSec: number;
}

export type JobType = 'auth_test' | 'sync' | 'mail_op';
export type JobStatus = 'running' | 'completed' | 'cancelled';

export interface JobInfo {
  id: string;
  type: JobType;
  status: JobStatus;
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface Settings {
  authConcurrency: number;
  syncConcurrency: number;
  maxRetries: number;
  connectTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
  /** 同期するフォルダ: INBOX のみ / 全フォルダ（\\All と \\Noselect は除く） */
  syncFolders: 'inbox' | 'all';
  /** 初回同期で取得する最新メッセージ数（フォルダごと）。0 = 無制限 */
  initialSyncMessages: number;
  /** この大きさを超えるメッセージは本文パートだけ取得する */
  maxMessageBytes: number;
  /** 自動同期の間隔（分）。0 = 無効。autoSyncIntervalSec > 0 のときはそちらが優先される */
  autoSyncIntervalMin: number;
  /** 自動同期の間隔（秒）。0 = 分の設定(autoSyncIntervalMin)を使う */
  autoSyncIntervalSec: number;
  /** 認証（テスト）が完了したアカウントを自動で受信同期する */
  autoSyncOnAuth: boolean;
  /** 新着メールを macOS 通知する */
  notifyNewMail: boolean;
  /** イベントを POST する Webhook URL（空 = 無効） */
  webhookUrl: string;
  /** 添付ファイルの本体も同期時に保存する */
  storeAttachments: boolean;
  /** 最終成功からこの時間（時間）を超えた認証済みアカウントを「要対応」にする。0 = 判定しない */
  healthStaleHours: number;
  /** 同期時に、取得済みメールのサーバー側の既読・スター変更と削除を取り込む */
  syncFlagChanges: boolean;
  /**
   * IMAP IDLE（プッシュ受信）の対象: '' = 使わない / '*' = 認証済みすべて / グループ ID。
   * 自動同期が ON のときだけ接続する。対象外は定期同期で受信する。
   */
  idleGroupId: string;
  /** IDLE で同時に張る接続数の上限（サーバーの同時接続制限に合わせる） */
  idleMaxConnections: number;
  /** この日数より古いメールのローカルコピーを自動で削除する（サーバー上は消さない）。0 = 無期限 */
  retentionDays: number;
  /** この日数より古い添付ファイル本体を削除する（必要時に再取得）。0 = 無期限 */
  attachmentRetentionDays: number;
}

export interface StorageStats {
  /** SQLite ファイル（WAL 含む）の大きさ。PostgreSQL では null */
  dbBytes: number | null;
  attachmentBytes: number;
  attachmentFiles: number;
  messages: number;
  /** 本文（テキスト + HTML）の合計文字数の目安 */
  bodyBytes: number;
  oldestMessageAt: string | null;
}

export interface StorageCleanupResult {
  dryRun: boolean;
  messagesRemoved: number;
  attachmentFilesRemoved: number;
  orphanDirsRemoved: number;
  bytesFreed: number;
}

export interface IdleStatus {
  /** 設定 idleGroupId の値 */
  target: string;
  /** 監視対象のアカウント数 */
  watching: number;
  /** IDLE 接続中のアカウント数 */
  connected: number;
  /** サーバーが IDLE 非対応のため定期同期に任せているアカウント数 */
  unsupported: number;
  /** 再接続待ち（エラー）のアカウント数 */
  errors: number;
}

export interface AppInfo {
  version: string;
  dbPath: string;
  logPath: string;
  keyMode: 'keychain' | 'insecure-file' | 'unknown';
  envOverrides: string[];
}

export interface MailboxSummary {
  id: string;
  accountId: string;
  path: string;
  name: string;
  specialUse: string | null;
  uidValidity: number | null;
  lastSyncUid: number;
  /** サーバー上のメッセージ数（最終同期時） */
  totalMessages: number;
  /** ローカルに保存済みのメッセージ数 */
  storedMessages: number;
  lastSyncAt: string | null;
  syncEnabled: boolean;
}

export interface AddressInfo {
  name: string | null;
  address: string;
}

export interface MessageSummary {
  id: string;
  accountId: string;
  accountEmail: string;
  mailboxId: string;
  mailboxPath: string;
  remoteUid: number;
  messageId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: AddressInfo[];
  subject: string;
  date: string | null;
  size: number;
  hasAttachments: boolean;
  seen: boolean;
  flagged: boolean;
  snippet: string;
  /** 少なくとも1件、いずれかの宛先へ転送済みか */
  forwarded: boolean;
}

export interface AttachmentInfo {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  size: number;
  partId: string | null;
  storagePath: string | null;
}

export interface MessageDetail extends MessageSummary {
  ccAddresses: AddressInfo[];
  inReplyTo: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: AttachmentInfo[];
  /** 転送履歴（宛先と日時） */
  forwards: { to: string; at: string }[];
}

export interface SearchQuery {
  text?: string;
  accountIds?: string[];
  mailboxPath?: string;
  /** メールボックスの special-use で絞り込む（例: '\\Sent' で送信済みだけ） */
  mailboxSpecialUse?: string;
  /** YYYY-MM-DD */
  dateFrom?: string;
  dateTo?: string;
  from?: string;
  /** 宛先（To / Cc のアドレスまたは表示名）の部分一致。送信メールの送信先フィルタに使う */
  to?: string;
  subject?: string;
  hasAttachments?: boolean;
  unseenOnly?: boolean;
  /** 転送状態で絞り込む */
  forwardState?: 'forwarded' | 'not_forwarded';
  /**
   * 受信メールだけを対象にする: 送信済み・下書きフォルダと、自分（そのアカウント）が差出人のメールを除く。
   * 自動転送・全件転送が自分の転送控え（Fwd:）を再転送してループしないために使う。
   */
  receivedOnly?: boolean;
  /** この日時（ISO）以降にローカルへ取り込んだメールだけ（ルールの「既存メールには適用しない」用） */
  storedSince?: string;
  /** 並び替えの対象カラム（件名など自由文は対象外）。既定は date */
  sortBy?: 'date' | 'account' | 'from' | 'mailbox';
  /** 並び順。既定は desc */
  sortDir?: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface SearchResult {
  items: MessageSummary[];
  total: number;
  page: number;
  pageSize: number;
  tookMs: number;
}

/** 受信メールをアカウント別にグループ表示するための、アカウントごとの件数集計 */
export interface AccountGroup {
  accountId: string;
  email: string;
  total: number;
  unseen: number;
}

export interface SyncProgress {
  accountId: string;
  email: string;
  mailboxPath: string;
  fetched: number;
  total: number;
}

export interface NewMailNotice {
  accountId: string;
  email: string;
  count: number;
  latestSubject: string | null;
  latestFrom: string | null;
}

export interface ForwardResult {
  job: JobInfo;
  /** 実際に転送を開始した件数 */
  queued: number;
  /** 転送済みのためスキップした件数 */
  skipped: number;
}

export interface ForwardTarget {
  id: string;
  address: string;
  label: string | null;
}

export interface ForwardRecord {
  messageId: string;
  accountEmail: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  date: string | null;
  /** 転送先アドレス */
  to: string;
  forwardedAt: string;
}

export interface ForwardListQuery {
  accountIds?: string[];
  to?: string;
  page: number;
  pageSize: number;
}

export interface ForwardListResult {
  items: ForwardRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SendResult {
  messageId: string;
  savedToSent: boolean;
}

export type ForwardRuleField = 'any' | 'subject' | 'from' | 'body';

/** ルールのアクション */
export type RuleAction = 'forward' | 'mark_read' | 'flag' | 'move' | 'delete' | 'webhook';

export interface ForwardRule {
  id: string;
  keyword: string;
  matchField: ForwardRuleField;
  /** アクションの引数: 転送先アドレス（forward）/ 移動先フォルダ（move）/ Webhook URL（webhook、空なら設定の URL） */
  to: string;
  enabled: boolean;
  action: RuleAction;
  /** 適用範囲のグループ（null = 全アカウント） */
  groupId: string | null;
  /** ルール作成前に受信したメールにも適用する */
  applyExisting: boolean;
  createdAt: string;
}

export interface ForwardRuleInput {
  keyword: string;
  matchField: ForwardRuleField;
  to: string;
  enabled: boolean;
  /** 省略時は forward */
  action?: RuleAction;
  groupId?: string | null;
  /** 省略時は true（従来どおり既存メールにも適用） */
  applyExisting?: boolean;
}

/** ルールを保存する前の試算（ドライラン） */
export interface RulePreview {
  /** 条件に一致する受信メールの件数（適用範囲のグループ内） */
  matched: number;
  /** 今「今すぐ適用」したら実際にアクションの対象になる件数（転送済み・既存メール除外などを反映） */
  wouldApply: number;
  samples: Array<{ id: string; accountEmail: string; from: string | null; subject: string; date: string | null }>;
}

export interface ApplyRulesResult {
  rules: number;
  forwarded: number;
  /** 転送以外のアクション（既読・スター・移動・削除・Webhook）を適用した件数 */
  actioned?: number;
  /** 直前の失敗からの待機時間（バックオフ）中のため、今回は再試行しなかった件数 */
  deferred: number;
}

/** 健全性モニタの判定理由 */
export type HealthReason =
  | 'auth_failed'
  | 'error_status'
  | 'repeated_failures'
  | 'stale'
  | 'never_synced'
  | 'untested'
  | 'forward_failures';

export type HealthSeverity = 'critical' | 'warning' | 'info';

export interface HealthIssue {
  reason: HealthReason;
  severity: HealthSeverity;
  /** 補足値（連続失敗回数・経過時間(時間)・転送失敗件数など） */
  value?: number;
}

export interface AccountHealth {
  accountId: string;
  email: string;
  groupId: string | null;
  status: AccountStatus;
  /** issues の中で最も重い深刻度 */
  severity: HealthSeverity;
  issues: HealthIssue[];
  lastError: string | null;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
}

/** 転送失敗（自動再試行のバックオフ待ちを含む）の 1 件 */
export interface ForwardFailureRecord {
  messageId: string;
  accountEmail: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  date: string | null;
  to: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string;
  nextRetryAt: string;
}

export interface ForwardFailureListResult {
  items: ForwardFailureRecord[];
  total: number;
  page: number;
  pageSize: number;
}
