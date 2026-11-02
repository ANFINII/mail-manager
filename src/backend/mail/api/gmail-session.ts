import { ApiSession, type ApiFolder, type ApiMessageMeta } from './api-session'
import { apiRequest, type ApiClientOptions } from './http'
import type { UidMapStore } from './uid-map'

const SYSTEM: Record<string, string | null> = {
  INBOX: null,
  SENT: '\\Sent',
  TRASH: '\\Trash',
  SPAM: '\\Junk',
  DRAFT: '\\Drafts',
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

/** Gmail API（ラベル = フォルダ）で取得するセッション */
export class GmailSession extends ApiSession {
  constructor(
    email: string,
    uidMap: UidMapStore,
    private readonly http: ApiClientOptions,
    signal?: AbortSignal,
  ) {
    super(email, uidMap, signal)
  }

  private req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return apiRequest<T>({ ...this.http, signal: this.signal }, method, path, body)
  }

  protected async listFolders(): Promise<ApiFolder[]> {
    const r = await this.req<{ labels: GmailLabel[] }>('GET', '/users/me/labels')
    const out: ApiFolder[] = []
    for (const l of r.labels) {
      if (l.type === 'system') {
        if (!(l.id in SYSTEM)) continue // UNREAD / STARRED / CATEGORY_* などはフォルダとして扱わない
        out.push({ path: l.id, name: l.name, specialUse: SYSTEM[l.id], ref: l.id })
      } else out.push({ path: l.name, name: l.name, specialUse: null, ref: l.id })
    }
    return out
  }

  private async listIds(labelIds: string[], includeSpamTrash: boolean): Promise<string[]> {
    const out: string[] = []
    let pageToken: string | undefined
    do {
      this.check()
      const q = new URLSearchParams({ maxResults: '500' })
      for (const l of labelIds) q.append('labelIds', l)
      if (includeSpamTrash) q.set('includeSpamTrash', 'true')
      if (pageToken) q.set('pageToken', pageToken)
      const r = await this.req<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
        'GET',
        `/users/me/messages?${q.toString()}`,
      )
      for (const m of r.messages ?? []) out.push(m.id)
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  }

  protected async listMessages(folder: ApiFolder): Promise<ApiMessageMeta[]> {
    const spamTrash = folder.ref === 'TRASH' || folder.ref === 'SPAM'
    // 一覧は新しい順なので逆順にして古い順にする。既読・スターはラベルの組み合わせで一括に調べる
    const [all, unread, starred] = await Promise.all([
      this.listIds([folder.ref], spamTrash),
      this.listIds([folder.ref, 'UNREAD'], spamTrash),
      this.listIds([folder.ref, 'STARRED'], spamTrash),
    ])
    const unreadSet = new Set(unread)
    const starredSet = new Set(starred)
    return all.reverse().map((id) => ({ id, seen: !unreadSet.has(id), flagged: starredSet.has(id), receivedAt: null }))
  }

  protected async getRaw(id: string): Promise<{ raw: Buffer; internalDate: string | null }> {
    const r = await this.req<{ raw: string; internalDate?: string }>('GET', `/users/me/messages/${id}?format=raw`)
    return {
      raw: Buffer.from(r.raw, 'base64url'),
      internalDate: r.internalDate ? new Date(Number(r.internalDate)).toISOString() : null,
    }
  }

  protected async setRemoteFlags(ids: string[], flag: 'seen' | 'flagged' | 'answered', on: boolean): Promise<void> {
    if (flag === 'answered') return
    // 既読 = UNREAD ラベルを外す
    const label = flag === 'seen' ? 'UNREAD' : 'STARRED'
    const add = flag === 'seen' ? !on : on
    await this.req('POST', '/users/me/messages/batchModify', {
      ids,
      ...(add ? { addLabelIds: [label] } : { removeLabelIds: [label] }),
    })
  }

  protected async moveRemote(id: string, from: ApiFolder, to: ApiFolder): Promise<string> {
    await this.req('POST', `/users/me/messages/${id}/modify`, { addLabelIds: [to.ref], removeLabelIds: [from.ref] })
    return id
  }

  protected async deleteRemote(id: string): Promise<void> {
    await this.req('DELETE', `/users/me/messages/${id}`)
  }

  static async test(http: ApiClientOptions, signal?: AbortSignal): Promise<void> {
    await apiRequest({ ...http, signal }, 'GET', '/users/me/profile')
  }
}
