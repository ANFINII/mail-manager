import type { UidMapStore } from './uid-map'
import { AbortError } from '../../queue/task-queue'
import type { DownloadedPart, FetchedMessage, FlagState, MailSession, MailboxInfo, OpenedMailbox } from '../mail-session'

export interface ApiFolder {
  path: string;
  name: string;
  specialUse: string | null;
  /** API 上のフォルダ ID / ラベル ID */
  ref: string;
}

export interface ApiMessageMeta {
  id: string;
  seen: boolean;
  flagged: boolean;
  receivedAt: string | null;
}

/** 生のメール（MIME）を同時に取りに行く数 */
const RAW_CONCURRENCY = 4

/**
 * HTTP API（Graph / Gmail）を IMAP と同じ MailSession として使う共通部分。
 * フォルダを開くときに中のメッセージ一覧（ID・既読・スター）を取り、連番 UID を割り当てる。
 * 本文は生の MIME を取得して、IMAP と同じ解析処理に渡す。
 */
export abstract class ApiSession implements MailSession {
  private folders: ApiFolder[] | null = null
  private current: {
    folder: ApiFolder;
    uidToMeta: Map<number, ApiMessageMeta>;
  } | null = null

  constructor(
    protected readonly email: string,
    private readonly uidMap: UidMapStore,
    protected readonly signal?: AbortSignal,
  ) {}

  protected abstract listFolders(): Promise<ApiFolder[]>
  /** フォルダ内のメッセージ（古い順） */
  protected abstract listMessages(folder: ApiFolder): Promise<ApiMessageMeta[]>
  protected abstract getRaw(id: string): Promise<{ raw: Buffer; internalDate: string | null }>
  protected abstract setRemoteFlags(ids: string[], flag: 'seen' | 'flagged' | 'answered', on: boolean): Promise<void>
  /** 別フォルダへ移す。移動後の ID を返す（Gmail は同じ ID） */
  protected abstract moveRemote(id: string, from: ApiFolder, to: ApiFolder): Promise<string>
  protected abstract deleteRemote(id: string): Promise<void>

  protected check(): void {
    if (this.signal?.aborted) throw new AbortError()
  }

  private async allFolders(): Promise<ApiFolder[]> {
    if (!this.folders) this.folders = await this.listFolders()
    return this.folders
  }

  private async folder(path: string): Promise<ApiFolder> {
    const f = (await this.allFolders()).find((x) => x.path === path)
    if (!f) throw new Error(`No such mailbox: ${path}`)
    return f
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    this.check()
    return (await this.allFolders()).map((f) => ({
      path: f.path,
      name: f.name,
      delimiter: '/',
      specialUse: f.specialUse,
      noselect: false,
    }))
  }

  async openMailbox(path: string): Promise<OpenedMailbox> {
    this.check()
    const folder = await this.folder(path)
    const metas = await this.listMessages(folder)
    const map = await this.uidMap.assign(this.email, path, metas.map((m) => m.id))
    const uidToMeta = new Map<number, ApiMessageMeta>()
    for (const m of metas) uidToMeta.set(map.get(m.id)!, m)
    this.current = { folder, uidToMeta }
    const maxUid = Math.max(0, ...uidToMeta.keys())
    // UID は対応表で永続化しているので UIDVALIDITY は固定（対応表を失わない限り変わらない）
    return { path, uidValidity: 1, uidNext: maxUid + 1, exists: metas.length, highestModseq: null }
  }

  private requireOpen() {
    if (!this.current) throw new Error('No mailbox selected')
    return this.current
  }

  async searchUidsFrom(uid: number): Promise<number[]> {
    this.check()
    return [...this.requireOpen().uidToMeta.keys()].filter((u) => u >= uid).sort((a, b) => a - b)
  }

  private flagsOf(m: ApiMessageMeta): Set<string> {
    const f = new Set<string>()
    if (m.seen) f.add('\\Seen')
    if (m.flagged) f.add('\\Flagged')
    return f
  }

  async *fetch(uids: number[], opts: { source: boolean; structure: boolean }): AsyncIterable<FetchedMessage> {
    const cur = this.requireOpen()
    const wanted = uids.filter((u) => cur.uidToMeta.has(u))
    if (!opts.source) {
      // 構造だけの段階: 大きさは分からないので 0（本文は次の段階で必ず生の MIME を取る）
      for (const uid of wanted) {
        this.check()
        const m = cur.uidToMeta.get(uid)!
        yield { uid, flags: this.flagsOf(m), size: 0, internalDate: m.receivedAt }
      }
      return
    }
    for (let i = 0; i < wanted.length; i += RAW_CONCURRENCY) {
      this.check()
      const chunk = wanted.slice(i, i + RAW_CONCURRENCY)
      const got = await Promise.all(chunk.map((uid) => this.getRaw(cur.uidToMeta.get(uid)!.id)))
      for (let j = 0; j < chunk.length; j++) {
        const m = cur.uidToMeta.get(chunk[j])!
        yield {
          uid: chunk[j],
          flags: this.flagsOf(m),
          size: got[j].raw.length,
          internalDate: got[j].internalDate ?? m.receivedAt,
          source: got[j].raw,
        }
      }
    }
  }

  async *fetchFlags(fromUid: number, toUid: number): AsyncIterable<FlagState> {
    for (const [uid, m] of this.requireOpen().uidToMeta) if (uid >= fromUid && uid <= toUid) yield { uid, flags: this.flagsOf(m) }
  }

  async downloadPart(): Promise<DownloadedPart> {
    throw new Error('downloadPart is not supported over the API (the full message is fetched instead)')
  }

  private remoteIds(uids: number[]): string[] {
    const cur = this.requireOpen()
    return uids.map((u) => cur.uidToMeta.get(u)?.id).filter((x): x is string => !!x)
  }

  private async changeFlags(uids: number[], flags: string[], on: boolean): Promise<void> {
    this.check()
    const ids = this.remoteIds(uids)
    if (ids.length === 0) return
    for (const f of flags) {
      const key = f === '\\Seen' ? 'seen' : f === '\\Flagged' ? 'flagged' : f === '\\Answered' ? 'answered' : null
      if (!key) continue
      await this.setRemoteFlags(ids, key, on)
      for (const u of uids) {
        const m = this.requireOpen().uidToMeta.get(u)
        if (m && key === 'seen') m.seen = on
        if (m && key === 'flagged') m.flagged = on
      }
    }
  }

  addFlags(uids: number[], flags: string[]): Promise<void> {
    return this.changeFlags(uids, flags, true)
  }

  removeFlags(uids: number[], flags: string[]): Promise<void> {
    return this.changeFlags(uids, flags, false)
  }

  async moveTo(uids: number[], destination: string): Promise<Map<number, number> | null> {
    this.check()
    const cur = this.requireOpen()
    const dest = await this.folder(destination)
    const out = new Map<number, number>()
    for (const uid of uids) {
      const m = cur.uidToMeta.get(uid)
      if (!m) continue
      const newId = await this.moveRemote(m.id, cur.folder, dest)
      out.set(uid, await this.uidMap.add(this.email, destination, newId))
      cur.uidToMeta.delete(uid)
    }
    return out
  }

  async deleteMessages(uids: number[]): Promise<void> {
    this.check()
    const cur = this.requireOpen()
    for (const uid of uids) {
      const m = cur.uidToMeta.get(uid)
      if (!m) continue
      await this.deleteRemote(m.id)
      cur.uidToMeta.delete(uid)
    }
  }

  /** 送信控えは Graph / Gmail が送信時に自動で保存するので何もしない */
  async append(): Promise<number | null> {
    return null
  }

  /** API ではプッシュ受信（IDLE）を使わず、定期同期に任せる */
  async waitForNewMail(): Promise<'unsupported'> {
    return 'unsupported'
  }

  async close(): Promise<void> {
    this.current = null
  }
}
