import type {
  AccountCredentialsUpdate,
  AccountDetail,
  AccountGroupInfo,
  AccountHealth,
  ForwardFailureListResult,
  IdleStatus,
  LockStatus,
  CodeListQuery,
  MailTemplate,
  MailOpSummary,
  DailyReport,
  ConnectionMetrics,
  AuditEntry,
  FetchVia,
  AuditQuery,
  UndoResult,
  MailTemplateInput,
  ReceivedCode,
  OAuthLoginStart,
  OAuthLoginStatus,
  StorageCleanupResult,
  StorageStats,
  AccountListQuery,
  AccountSummary,
  AppInfo,
  AttachmentInfo,
  AutoSyncState,
  DuplicateSentCopies,
  DashboardStats,
  ImportResult,
  ImportRowEdit,
  JobInfo,
  MailboxSummary,
  ForwardListQuery,
  ForwardListResult,
  ApplyRulesResult,
  ForwardResult,
  ForwardRule,
  ForwardRuleInput,
  RulePreview,
  SendResult,
  ForwardTarget,
  MessageDetail,
  NewMailNotice,
  AccountGroup,
  SearchQuery,
  SearchResult,
  Settings,
  SyncProgress,
} from './types'

/** backend が提供する RPC メソッドの契約。renderer → main → backend の順に転送される。 */
export interface RpcMethods {
  'accounts.list': { params: AccountListQuery; result: AccountSummary[] };
  'accounts.get': { params: { id: string }; result: AccountDetail | null };
  'accounts.delete': { params: { ids: string[] }; result: { deleted: number } };
  'accounts.setEnabled': {
    params: { ids: string[]; enabled: boolean };
    result: { updated: number };
  };
  'accounts.importCsv': {
    /**
     * groupId: 取り込んだアカウントを入れる既定グループ（CSV の group 列があればそちらを優先）
     * updateExisting: 既に同じメールアドレスのアカウントがある場合、重複エラーにせず認証情報・接続設定を更新する（メール・グループは保持）
     */
    params: { path: string; groupId?: string | null; updateExisting?: boolean };
    result: ImportResult;
  };
  'accounts.updateCredentials': {
    params: { id: string; update: AccountCredentialsUpdate };
    result: AccountDetail;
  };
  'accounts.exportCsvWithCredentials': {
    /** 認証情報（平文のパスワード・トークン）を含めて再取り込み可能な形式で出力する */
    params: { path: string; accountIds?: string[] };
    result: { count: number };
  };
  'accounts.setGroup': {
    params: { ids: string[]; groupId: string | null };
    result: { updated: number };
  };
  /** タグの追加・削除（複数アカウントまとめて）。変更した件数を返す */
  'accounts.updateTags': {
    params: { ids: string[]; add?: string[]; remove?: string[] };
    result: { updated: number };
  };
  /** 取得方法（IMAP / Graph / Gmail API）を切り替える。切り替えたアカウントは次回の同期で取り込み直す */
  'accounts.setFetchVia': { params: { ids: string[]; via: FetchVia }; result: { updated: number; skipped: number } };
  'accounts.setNote': { params: { id: string; note: string }; result: AccountSummary };
  'accounts.tags': { params: Record<string, never>; result: Array<{ tag: string; count: number }> };
  'groups.list': { params: Record<string, never>; result: AccountGroupInfo[] };
  'groups.create': { params: { name: string }; result: AccountGroupInfo[] };
  'groups.rename': { params: { id: string; name: string }; result: AccountGroupInfo[] };
  'groups.remove': { params: { id: string }; result: AccountGroupInfo[] };
  'accounts.retryImport': {
    params: { sessionId: string; edits: ImportRowEdit[] };
    result: ImportResult;
  };
  'accounts.discardImport': { params: { sessionId: string }; result: void };
  'auth.test': { params: { ids: string[] | 'all' }; result: JobInfo };
  'jobs.list': { params: Record<string, never>; result: JobInfo[] };
  'jobs.cancelAll': { params: Record<string, never>; result: { cancelled: number } };
  'stats.get': { params: Record<string, never>; result: DashboardStats };
  'settings.get': { params: Record<string, never>; result: Settings };
  'settings.update': { params: Partial<Settings>; result: Settings };
  'app.info': { params: Record<string, never>; result: AppInfo };
  'sync.run': {
    params: { ids: string[] | 'all' | 'authenticated'; full?: boolean };
    result: JobInfo;
  };
  'autoSync.get': { params: Record<string, never>; result: AutoSyncState };
  'autoSync.set': { params: { enabled: boolean }; result: AutoSyncState };
  /** IMAP IDLE（プッシュ受信）の接続状況 */
  'idle.status': { params: Record<string, never>; result: IdleStatus };
  'mailboxes.list': { params: { accountId: string }; result: MailboxSummary[] };
  'mailboxes.paths': { params: Record<string, never>; result: string[] };
  'search.query': { params: SearchQuery; result: SearchResult };
  'search.accountGroups': { params: SearchQuery; result: AccountGroup[] };
  'search.exportCsv': { params: { query: SearchQuery; path: string }; result: { count: number } };
  'messages.get': { params: { id: string }; result: MessageDetail | null };
  'messages.setFlags': {
    params: { ids: string[]; seen?: boolean; flagged?: boolean };
    result: JobInfo;
  };
  'messages.delete': { params: { ids: string[] }; result: JobInfo };
  /** 送信済みフォルダの重複した転送控えを数える（削除はしない） */
  'sent.duplicateCopies': { params: { accountIds?: string[] }; result: DuplicateSentCopies };
  /** 重複した転送控えを、各グループの最古の 1 通を残して削除する（サーバーではゴミ箱へ移動） */
  'sent.deleteDuplicateCopies': {
    params: { accountIds?: string[] };
    result: { job: JobInfo | null; count: number };
  };
  'attachments.download': { params: { id: string }; result: AttachmentInfo };
  'messages.send': {
    params: { accountId: string; to: string; subject: string; text: string };
    result: SendResult;
  };
  /**
   * 受信メールに返信する（送信元はそのメールを受信したアカウント）。
   * quote で元の本文を引用し、quoteHeader で引用の見出し（例: 「2026/1/1 山田 太郎 のメッセージ:」）を指定できる。
   */
  'messages.reply': {
    params: { id: string; text: string; replyAll?: boolean; quote?: boolean; quoteHeader?: string };
    result: SendResult;
  };
  /** 一括操作（削除・移動・既読・スター）の履歴（新しい順、30 日分） */
  'history.list': { params: { limit?: number }; result: MailOpSummary[] };
  /** 履歴の操作を取り消す */
  'history.undo': { params: { id: string }; result: UndoResult };
  /** 日次レポートの内容を作る（送らない） */
  'report.preview': { params: Record<string, never>; result: { report: DailyReport; subject: string; text: string } };
  /** 日次レポートを今すぐ送る */
  'report.send': { params: Record<string, never>; result: { email: boolean; webhook: boolean } };
  /** 接続数・失敗・スロットリングの計測（直近 60 分） */
  'metrics.get': { params: Record<string, never>; result: ConnectionMetrics };
  /** 監査ログ（新しい順） */
  'audit.list': { params: AuditQuery; result: AuditEntry[] };
  /** メインプロセスからだけ呼ぶ（ロックの解除など）。画面からの呼び出しはメインプロセスが拒否する */
  'audit.record': {
    params: { action: string; target?: string | null; ok?: boolean; error?: string | null };
    result: void;
  };
  'templates.list': { params: Record<string, never>; result: MailTemplate[] };
  'templates.save': { params: MailTemplateInput; result: MailTemplate[] };
  'templates.remove': { params: { id: string }; result: MailTemplate[] };
  'messages.forward': { params: { ids: string[]; to: string }; result: ForwardResult };
  'messages.forwardAll': { params: { query: SearchQuery; to: string }; result: ForwardResult };
  'forwards.list': { params: ForwardListQuery; result: ForwardListResult };
  /** 健全性モニタ: 要対応アカウント（includeInfo で未テスト・未同期も含める） */
  'health.list': { params: { includeInfo?: boolean }; result: AccountHealth[] };
  /** 転送失敗（自動再試行のバックオフ待ちを含む）の一覧 */
  'forwardFailures.list': { params: ForwardListQuery; result: ForwardFailureListResult };
  /** 転送失敗をすぐに再試行する（手動転送と同じくバックオフを無視） */
  'forwardFailures.retry': {
    params: { items: Array<{ messageId: string; to: string }> };
    result: { queued: number; skipped: number };
  };
  /** 転送失敗の記録を消す（items 省略で全件）。自動転送ルールは次回から再び対象にする */
  'forwardFailures.clear': {
    params: { items?: Array<{ messageId: string; to: string }> };
    result: { cleared: number };
  };
  'forwardTargets.list': { params: Record<string, never>; result: ForwardTarget[] };
  'forwardTargets.add': { params: { address: string; label?: string }; result: ForwardTarget[] };
  'forwardTargets.remove': { params: { id: string }; result: ForwardTarget[] };
  'forwardRules.list': { params: Record<string, never>; result: ForwardRule[] };
  'forwardRules.add': { params: ForwardRuleInput; result: ForwardRule[] };
  'forwardRules.setEnabled': { params: { id: string; enabled: boolean }; result: ForwardRule[] };
  'forwardRules.remove': { params: { id: string }; result: ForwardRule[] };
  'forwardRules.apply': { params: Record<string, never>; result: ApplyRulesResult };
  /** ルール保存前のドライラン（一致件数・今適用した場合の対象件数・サンプル） */
  'forwardRules.preview': { params: ForwardRuleInput; result: RulePreview };
  /** サーバー上で別フォルダへ移動する */
  'messages.move': { params: { ids: string[]; destination: string }; result: JobInfo };
  'accounts.exportCsv': {
    /** accountIds を指定するとその ID のアカウントだけを出力する（省略時は全件） */
    params: { path: string; accountIds?: string[] };
    result: { count: number };
  };
  /** OAuth2 対話ログインを開始する（authorizeUrl をブラウザで開く） */
  'oauth.start': {
    params: OAuthLoginStart;
    result: { sessionId: string; authorizeUrl: string };
  };
  'oauth.status': { params: { sessionId: string }; result: OAuthLoginStatus };
  'oauth.cancel': { params: { sessionId: string }; result: void };
  /** 受信メールから抽出した認証コード・確認リンク（新しい順） */
  'codes.list': { params: CodeListQuery; result: ReceivedCode[] };
  'storage.stats': { params: Record<string, never>; result: StorageStats };
  /** 保存期間の設定に従ってローカルのメール・添付を整理する（dryRun で件数だけ） */
  'storage.cleanup': { params: { dryRun?: boolean }; result: StorageCleanupResult };
  /** SQLite ファイルを詰める */
  'storage.vacuum': {
    params: Record<string, never>;
    result: { before: number | null; after: number | null };
  };
  'app.backup': { params: { path: string }; result: { path: string; bytes: number } };
  'app.restore': { params: { path: string }; result: { pendingRestart: boolean } };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result'];

export type BackendEvent =
  | { type: 'accounts.updated'; accounts: AccountSummary[] }
  | { type: 'accounts.removed'; ids: string[] }
  | { type: 'accounts.imported'; count: number }
  | { type: 'job.updated'; job: JobInfo }
  | { type: 'stats.updated'; stats: DashboardStats }
  | { type: 'sync.progress'; progress: SyncProgress }
  | { type: 'messages.new'; notice: NewMailNotice }
  | { type: 'mailboxes.updated'; accountId: string }
  | { type: 'messages.changed'; ids: string[]; deleted?: boolean }
  | { type: 'autoSync.changed'; state: AutoSyncState }
  | { type: 'groups.changed'; groups: AccountGroupInfo[] }
  | { type: 'backend.error'; message: string };

export interface RendererApi {
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  onEvent(listener: (event: BackendEvent) => void): () => void;
  openCsvDialog(): Promise<string | null>;
  openFileDialog(opts: { title: string; extensions: string[] }): Promise<string | null>;
  saveFileDialog(opts: {
    title: string;
    defaultName: string;
    extensions: string[];
  }): Promise<string | null>;
  showItemInFolder(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  /** https の URL を既定のブラウザで開く（OAuth ログイン用） */
  openExternal(url: string): Promise<void>;
  /** アプリのロック（メインプロセスが管理。ロック中は call が LOCKED で失敗する） */
  lock: {
    status(): Promise<LockStatus>;
    lockNow(): Promise<LockStatus>;
    unlock(passcode: string): Promise<LockStatus>;
    touchId(): Promise<LockStatus>;
    setPasscode(current: string | undefined, next: string): Promise<LockStatus>;
    configure(opts: { enabled: boolean; idleMinutes: number; passcode?: string }): Promise<LockStatus>;
    onChange(listener: (status: LockStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
