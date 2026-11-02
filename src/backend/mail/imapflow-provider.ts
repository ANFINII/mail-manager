import net from 'node:net'
import { ImapFlow, type ListResponse, type MessageStructureObject } from 'imapflow'
import type { ConnectionTestParams, EmailProvider } from './email-provider'
import type {
  DownloadedPart,
  FetchedMessage,
  FlagState,
  MailSession,
  MailboxInfo,
  OpenedMailbox,
} from './mail-session'
import { AbortError } from '../queue/task-queue'

function buildOptions(
  p: ConnectionTestParams,
  clientInfo: { name: string; version: string },
  verifyOnly: boolean,
) {
  const options: Record<string, unknown> = {
    host: p.host,
    port: p.port,
    secure: p.secure === 'tls',
    auth:
      p.auth.type === 'password'
        ? { user: p.user, pass: p.auth.password }
        : { user: p.user, accessToken: p.auth.accessToken },
    logger: false,
    emitLogs: false,
    verifyOnly,
    connectionTimeout: p.timeoutMs,
    greetingTimeout: p.timeoutMs,
    socketTimeout: Math.max(p.timeoutMs, 120_000),
    disableAutoIdle: true,
    disableCompression: true,
    clientInfo,
    tls: {
      rejectUnauthorized: p.rejectUnauthorized,
      // IP アドレスには SNI を付けない（RFC 6066）
      ...(net.isIP(p.host) ? {} : { servername: p.host }),
    },
  }
  if (p.proxy) options.proxy = p.proxy
  return options as unknown as ConstructorParameters<typeof ImapFlow>[0]
}

export class ImapFlowProvider implements EmailProvider {
  constructor(private readonly clientInfo = { name: 'Mail Manager', version: '0.2.0' }) {}

  async testConnection(p: ConnectionTestParams, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AbortError()
    const client = new ImapFlow(buildOptions(p, this.clientInfo, true))
    client.on('error', () => undefined)
    const onAbort = () => {
      try {
        client.close()
      } catch {
        // already closed
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // ソケットが完全に閉じるまで待ってから完了にする。そうしないと次のタスクが始まった瞬間に
    // サーバー側では「閉じかけの接続 + 新しい接続」で同時接続数が上限を 1 超える。
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
    try {
      await client.connect()
    } catch (err) {
      if (signal?.aborted) throw new AbortError()
      throw err
    } finally {
      signal?.removeEventListener('abort', onAbort)
      try {
        client.close()
      } catch {
        // already closed
      }
      await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1000))])
    }
  }

  async openSession(p: ConnectionTestParams, signal?: AbortSignal): Promise<MailSession> {
    if (signal?.aborted) throw new AbortError()
    const client = new ImapFlow(buildOptions(p, this.clientInfo, false))
    client.on('error', () => undefined)
    const onAbort = () => {
      try {
        client.close()
      } catch {
        // already closed
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await client.connect()
    } catch (err) {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) throw new AbortError()
      throw err
    }
    return new ImapFlowSession(client, () => signal?.removeEventListener('abort', onAbort), signal)
  }
}

class ImapFlowSession implements MailSession {
  constructor(
    private readonly client: ImapFlow,
    private readonly cleanup: () => void,
    private readonly signal?: AbortSignal,
  ) {}

  private check(): void {
    if (this.signal?.aborted) throw new AbortError()
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    this.check()
    const list: ListResponse[] = await this.client.list()
    return list.map((l) => ({
      path: l.path,
      name: l.name,
      delimiter: l.delimiter ?? null,
      specialUse: l.specialUse ?? null,
      noselect: l.flags.has('\\Noselect') || l.flags.has('\\NonExistent'),
    }))
  }

  async openMailbox(path: string, readOnly: boolean): Promise<OpenedMailbox> {
    this.check()
    const mb = await this.client.mailboxOpen(path, { readOnly })
    return {
      path: mb.path,
      uidValidity: Number(mb.uidValidity),
      uidNext: mb.uidNext,
      exists: mb.exists,
      highestModseq:
        mb.highestModseq !== undefined && !mb.noModseq ? mb.highestModseq.toString() : null,
    }
  }

  async *fetchFlags(
    fromUid: number,
    toUid: number,
    changedSince?: string | null,
  ): AsyncIterable<FlagState> {
    this.check()
    if (toUid < fromUid) return
    const opts: { uid: true; changedSince?: bigint } = { uid: true }
    if (changedSince) opts.changedSince = BigInt(changedSince)
    for await (const msg of this.client.fetch(`${fromUid}:${toUid}`, { uid: true, flags: true }, opts)) {
      this.check()
      // "N:M" は範囲外の UID にもマッチしうる（* の扱い）ため範囲で絞る
      if (msg.uid < fromUid || msg.uid > toUid) continue
      yield { uid: msg.uid, flags: msg.flags ?? new Set() }
    }
  }

  async searchUidsFrom(uid: number): Promise<number[]> {
    this.check()
    const result = await this.client.search({ uid: `${Math.max(1, uid)}:*` }, { uid: true })
    const uids = Array.isArray(result) ? result : []
    // "N:*" は N より小さい最大 UID にもマッチするため、必ず絞り込む
    return uids.filter((u) => u >= uid).sort((a, b) => a - b)
  }

  async *fetch(
    uids: number[],
    opts: { source: boolean; structure: boolean },
  ): AsyncIterable<FetchedMessage> {
    this.check()
    if (uids.length === 0) return
    const query = {
      uid: true,
      flags: true,
      size: true,
      internalDate: true,
      envelope: !opts.source || opts.structure,
      bodyStructure: opts.structure,
      source: opts.source,
    }
    for await (const msg of this.client.fetch(uids, query, { uid: true })) {
      this.check()
      yield {
        uid: msg.uid,
        flags: msg.flags ?? new Set(),
        size: msg.size ?? msg.source?.length ?? 0,
        internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
        envelope: msg.envelope,
        bodyStructure: msg.bodyStructure as MessageStructureObject | undefined,
        source: msg.source,
      }
    }
  }

  async downloadPart(uid: number, part: string, maxBytes?: number): Promise<DownloadedPart> {
    this.check()
    const dl = await this.client.download(String(uid), part, { uid: true, maxBytes })
    const chunks: Buffer[] = []
    for await (const c of dl.content) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    return {
      content: Buffer.concat(chunks),
      contentType: dl.meta.contentType,
      charset: dl.meta.charset,
      filename: dl.meta.filename,
    }
  }

  async addFlags(uids: number[], flags: string[]): Promise<void> {
    this.check()
    if (uids.length === 0) return
    await this.client.messageFlagsAdd(uids, flags, { uid: true })
  }

  async removeFlags(uids: number[], flags: string[]): Promise<void> {
    this.check()
    if (uids.length === 0) return
    await this.client.messageFlagsRemove(uids, flags, { uid: true })
  }

  async moveTo(uids: number[], destination: string): Promise<void> {
    this.check()
    if (uids.length === 0) return
    const r = await this.client.messageMove(uids, destination, { uid: true })
    if (!r) throw new Error(`MOVE to ${destination} failed`)
  }

  async deleteMessages(uids: number[]): Promise<void> {
    this.check()
    if (uids.length === 0) return
    await this.client.messageDelete(uids, { uid: true })
  }

  async append(path: string, raw: Buffer, flags: string[]): Promise<number | null> {
    this.check()
    const r = await this.client.append(path, raw, flags)
    return r && typeof r === 'object' && 'uid' in r ? (r.uid ?? null) : null
  }

  async close(): Promise<void> {
    this.cleanup()
    const closed = new Promise<void>((resolve) => this.client.once('close', () => resolve()))
    try {
      await Promise.race([this.client.logout(), new Promise<void>((r) => setTimeout(r, 3000))])
    } catch {
      // ignore
    }
    try {
      this.client.close()
    } catch {
      // already closed
    }
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1000))])
  }
}
