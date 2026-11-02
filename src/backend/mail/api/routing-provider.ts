import { GmailSession } from './gmail-session'
import { GraphSession } from './graph-session'
import type { ApiClientOptions } from './http'
import type { UidMapStore } from './uid-map'
import type { ConnectionTestParams, EmailProvider } from '../email-provider'
import type { MailSession } from '../mail-session'

export interface ApiEndpoints {
  /** 既定 https://graph.microsoft.com/v1.0（MM_GRAPH_API_URL で差し替え） */
  graph: string;
  /** 既定 https://gmail.googleapis.com/gmail/v1（MM_GMAIL_API_URL で差し替え） */
  gmail: string;
}

/**
 * 接続パラメータに api があれば HTTP API のセッション、無ければ IMAP（内側のプロバイダー）を使う。
 * 同期・一括操作・認証テストは取得方法を意識せずに動く。
 */
export class RoutingProvider implements EmailProvider {
  constructor(
    private readonly imap: EmailProvider,
    private readonly uidMap: UidMapStore,
    private readonly endpoints: ApiEndpoints,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  private http(p: ConnectionTestParams): ApiClientOptions {
    const graph = p.api!.kind === 'graph'
    return {
      baseUrl: graph ? this.endpoints.graph : this.endpoints.gmail,
      accessToken: p.api!.accessToken,
      timeoutMs: Math.max(p.timeoutMs, 30_000),
      fetchImpl: this.fetchImpl,
      label: graph ? 'Graph' : 'Gmail API',
    }
  }

  async testConnection(p: ConnectionTestParams, signal?: AbortSignal): Promise<void> {
    if (!p.api) return this.imap.testConnection(p, signal)
    if (p.api.kind === 'graph') return GraphSession.test(this.http(p), signal)
    return GmailSession.test(this.http(p), signal)
  }

  async openSession(p: ConnectionTestParams, signal?: AbortSignal): Promise<MailSession> {
    if (!p.api) return this.imap.openSession(p, signal)
    const session =
      p.api.kind === 'graph'
        ? new GraphSession(p.user, this.uidMap, this.http(p), signal)
        : new GmailSession(p.user, this.uidMap, this.http(p), signal)
    // 認証の確認を兼ねて、フォルダ一覧を先に読む（失敗はここで認証エラー・接続エラーになる）
    await session.listMailboxes()
    return session
  }
}
