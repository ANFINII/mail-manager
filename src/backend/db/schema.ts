import type { Generated, Insertable, Selectable } from 'kysely'

/** DB テーブル定義（Kysely 用）。列名は PROJECT_SPEC.md §8 に合わせて snake_case。 */

export interface AccountsTable {
  id: string;
  email: string;
  provider: string;
  auth_type: string;
  imap_host: string;
  imap_port: number;
  imap_secure: string;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: string | null;
  proxy: string | null;
  /** CredentialCipher で暗号化した JSON。平文は保存しない。 */
  encrypted_credentials: string;
  enabled: number;
  status: string;
  auth_status: string;
  last_error: string | null;
  last_error_at: string | null;
  last_success_at: string | null;
  last_sync_at: string | null;
  retry_count: number;
  message_count: number;
  created_at: string;
  updated_at: string;
  /** 所属グループ（account_groups.id）。未所属は null。グループ削除時は FK で null に戻る。 */
  group_id: string | null;
  /** 認証テスト・同期が最終的に失敗した連続回数（成功で 0 に戻る）。健全性モニタで使う */
  consecutive_failures: Generated<number>;
}

/** アカウントのグループ（一括操作・絞り込みの単位）。名前は一意。 */
export interface AccountGroupsTable {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SettingsTable {
  key: string;
  value: string;
}

export interface MailboxesTable {
  id: string;
  account_id: string;
  path: string;
  name: string;
  delimiter: string | null;
  special_use: string | null;
  uid_validity: number | null;
  last_sync_uid: number;
  total_messages: number;
  last_sync_at: string | null;
  sync_enabled: number;
  created_at: string;
  updated_at: string;
  /** CONDSTORE: 前回同期時の HIGHESTMODSEQ（10 進文字列）。非対応サーバーは null */
  highest_modseq: string | null;
}

export interface MessagesTable {
  id: string;
  account_id: string;
  mailbox_id: string;
  remote_uid: number;
  message_id: string | null;
  in_reply_to: string | null;
  from_address: string | null;
  from_name: string | null;
  /** JSON: AddressInfo[] */
  to_addresses: string;
  /** JSON: AddressInfo[] */
  cc_addresses: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  snippet: string;
  date: string | null;
  internal_date: string | null;
  size: number;
  has_attachments: number;
  seen: number;
  flagged: number;
  answered: number;
  created_at: string;
  updated_at: string;
  /** SQLite のみ: 対応する messages_fts 行の rowid（削除トリガーが全文検索表を走査せずに消すため） */
  fts_rowid: number | null;
  /** 本文から抽出した認証コード（無ければ null） */
  otp_code: string | null;
  /** 本文から抽出した確認・ログインリンク（無ければ null） */
  otp_link: string | null;
  /** 1 = 抽出済み（既存メールのバックフィル用） */
  otp_scanned: number;
}

export interface AttachmentsTable {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size: number;
  part_id: string | null;
  content_id: string | null;
  storage_path: string | null;
  created_at: string;
}

export interface ForwardRulesTable {
  id: string;
  keyword: string;
  /** 照合対象: subject / from / body / any */
  match_field: string;
  /** アクションの引数（転送先アドレス / 移動先フォルダ / Webhook URL） */
  to_address: string;
  enabled: number;
  created_at: string;
  /** forward / mark_read / flag / move / delete / webhook */
  action: Generated<string>;
  /** 適用範囲のグループ。null = 全アカウント */
  group_id: string | null;
  /** 1 = ルール作成前に受信したメールにも適用する */
  apply_existing: Generated<number>;
}

export interface MailTemplatesTable {
  id: string;
  name: string;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface MailOpsTable {
  id: string;
  /** flags / move / delete */
  kind: string;
  /** manual / rule */
  source: string;
  rule_id: string | null;
  /** 表示用の説明（例: ルールのキーワード、移動先） */
  label: string | null;
  created_at: string;
  undone_at: string | null;
}

export interface MailOpItemsTable {
  op_id: string;
  account_id: string;
  message_id: string | null;
  subject: string;
  src_path: string;
  src_uid: number;
  dest_path: string | null;
  dest_uid: number | null;
  prev_seen: number | null;
  prev_flagged: number | null;
}

export interface RuleHitsTable {
  rule_id: string;
  message_id: string;
  applied_at: string;
}

export interface ForwardTargetsTable {
  id: string;
  address: string;
  label: string | null;
  created_at: string;
}

export interface ForwardsTable {
  message_id: string;
  to_address: string;
  forwarded_at: string;
}

/**
 * 転送済みの恒久ログ。メール本体（messages 行）に依存せず、アカウントのメールアドレス + Message-ID + 宛先で持つ。
 * 再同期・再取り込み・アカウント削除で messages/forwards の行が作り直されても、同じメールを二度転送しない。
 */
export interface ForwardLogTable {
  account_email: string;
  /** RFC Message-ID。無いメールは from/date/subject のハッシュ（'h:' 接頭辞） */
  message_key: string;
  /** 宛先（小文字） */
  to_address: string;
  forwarded_at: string;
}

/** 転送失敗の記録。自動転送ルールが同じ失敗を毎回繰り返さないよう、次回再試行時刻を指数バックオフで持つ。 */
export interface ForwardAttemptsTable {
  message_id: string;
  to_address: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string;
  next_retry_at: string;
}

export interface MessagesFtsTable {
  message_id: string;
  subject: string;
  from_text: string;
  to_text: string;
  body: string;
  attachments: string;
}

export interface Database {
  accounts: AccountsTable;
  account_groups: AccountGroupsTable;
  settings: SettingsTable;
  mailboxes: MailboxesTable;
  messages: MessagesTable;
  attachments: AttachmentsTable;
  forwards: ForwardsTable;
  forward_attempts: ForwardAttemptsTable;
  forward_log: ForwardLogTable;
  forward_targets: ForwardTargetsTable;
  forward_rules: ForwardRulesTable;
  rule_hits: RuleHitsTable;
  mail_templates: MailTemplatesTable;
  mail_ops: MailOpsTable;
  mail_op_items: MailOpItemsTable;
  messages_fts: MessagesFtsTable;
}

export type MailboxRow = MailboxesTable;
export type MessageRow = MessagesTable;
export type AttachmentRow = AttachmentsTable;

export type AccountRow = Selectable<AccountsTable>;
export type NewAccountRow = Insertable<AccountsTable>;
