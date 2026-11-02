/**
 * デスクトップアプリ ↔ 共有サーバーの RPC。ファイルを扱う操作は、ファイルの中身を base64 で運ぶ。
 *  - UPLOAD: 端末のファイルをサーバーの一時ファイルに書き、params.path を差し替える（CSV 取り込み・復元）
 *  - DOWNLOAD: サーバーの一時ファイルに書かせて中身を返し、端末の params.path に書く（書き出し・バックアップ）
 *  - attachments.download: サーバーに保存した添付の中身を返す
 */
export const UPLOAD_METHODS = new Set(['accounts.importCsv', 'app.restore'])
export const DOWNLOAD_METHODS = new Set([
  'accounts.exportCsv',
  'accounts.exportCsvWithCredentials',
  'search.exportCsv',
  'app.backup',
])

export interface RemoteRequest {
  method: string;
  params: unknown;
  /** UPLOAD_METHODS: 端末側のファイル */
  upload?: { name: string; data: string };
}

export interface RemoteResponse {
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
  /** DOWNLOAD_METHODS / attachments.download: ファイルの中身 */
  file?: { name: string; data: string };
}

/** 1 リクエストの上限（バックアップや大きな添付を運ぶため大きめ） */
export const MAX_BODY_BYTES = 512 * 1024 * 1024
