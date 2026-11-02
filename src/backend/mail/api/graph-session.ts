import { ApiSession, type ApiFolder, type ApiMessageMeta } from './api-session'
import { apiRequest, type ApiClientOptions } from './http'
import type { UidMapStore } from './uid-map'

/** Graph の既知フォルダ（別名）と special-use の対応 */
const WELL_KNOWN: Array<[string, string]> = [
  ['inbox', ''],
  ['sentitems', '\\Sent'],
  ['deleteditems', '\\Trash'],
  ['junkemail', '\\Junk'],
  ['drafts', '\\Drafts'],
  ['archive', '\\Archive'],
]

interface GraphFolder {
  id: string;
  displayName: string;
}
interface GraphMessage {
  id: string;
  isRead?: boolean;
  receivedDateTime?: string;
  flag?: { flagStatus?: string };
}

/** Microsoft Graph（/me/mailFolders, /me/messages）で取得するセッション */
export class GraphSession extends ApiSession {
  constructor(
    email: string,
    uidMap: UidMapStore,
    private readonly http: ApiClientOptions,
    signal?: AbortSignal,
  ) {
    super(email, uidMap, signal)
  }

  private req<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    return apiRequest<T>({ ...this.http, signal: this.signal }, method, path, body, { raw })
  }

  protected async listFolders(): Promise<ApiFolder[]> {
    const special = new Map<string, string>()
    for (const [alias, use] of WELL_KNOWN) {
      try {
        const f = await this.req<GraphFolder>('GET', `/me/mailFolders/${alias}`)
        special.set(f.id, use || 'INBOX')
      } catch {
        // そのフォルダが無いアカウント（archive など）は飛ばす
      }
    }
    const out: ApiFolder[] = []
    let url: string | undefined = '/me/mailFolders?$top=100'
    while (url) {
      const page: { value: GraphFolder[]; '@odata.nextLink'?: string } = await this.req('GET', url)
      for (const f of page.value) {
        const use = special.get(f.id)
        // 受信トレイは同期処理が INBOX という名前で扱う
        const path = use === 'INBOX' ? 'INBOX' : f.displayName
        out.push({ path, name: f.displayName, specialUse: use && use !== 'INBOX' ? use : null, ref: f.id })
      }
      url = page['@odata.nextLink']
    }
    return out
  }

  protected async listMessages(folder: ApiFolder): Promise<ApiMessageMeta[]> {
    const out: ApiMessageMeta[] = []
    let url: string | undefined =
      `/me/mailFolders/${folder.ref}/messages?$select=id,isRead,flag,receivedDateTime&$orderby=receivedDateTime asc&$top=500`
    while (url) {
      this.check()
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await this.req('GET', url)
      for (const m of page.value)
        out.push({
          id: m.id,
          seen: !!m.isRead,
          flagged: m.flag?.flagStatus === 'flagged',
          receivedAt: m.receivedDateTime ?? null,
        })
      url = page['@odata.nextLink']
    }
    return out
  }

  protected async getRaw(id: string): Promise<{ raw: Buffer; internalDate: string | null }> {
    return { raw: await this.req<Buffer>('GET', `/me/messages/${id}/$value`, undefined, true), internalDate: null }
  }

  protected async setRemoteFlags(ids: string[], flag: 'seen' | 'flagged' | 'answered', on: boolean): Promise<void> {
    if (flag === 'answered') return // Graph には返信済みの印が無い
    const body = flag === 'seen' ? { isRead: on } : { flag: { flagStatus: on ? 'flagged' : 'notFlagged' } }
    for (const id of ids) await this.req('PATCH', `/me/messages/${id}`, body)
  }

  protected async moveRemote(id: string, _from: ApiFolder, to: ApiFolder): Promise<string> {
    const moved = await this.req<{ id: string }>('POST', `/me/messages/${id}/move`, { destinationId: to.ref })
    return moved.id
  }

  protected async deleteRemote(id: string): Promise<void> {
    await this.req('DELETE', `/me/messages/${id}`)
  }

  /** 認証テスト: 受信トレイが読めるか */
  static async test(http: ApiClientOptions, signal?: AbortSignal): Promise<void> {
    await apiRequest({ ...http, signal }, 'GET', '/me/mailFolders/inbox')
  }
}
