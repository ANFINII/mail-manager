import fs from 'node:fs'
import path from 'node:path'
import type { BackendEvent } from '@shared/api'
import type { AppInfo } from '@shared/types'
import { DOWNLOAD_METHODS, UPLOAD_METHODS, type RemoteRequest, type RemoteResponse } from '../server/protocol'

export interface RemoteHostOptions {
  url: string;
  token: string;
  /** サーバーから受け取った添付ファイルを置く場所（端末側） */
  cacheDir: string;
  fetchImpl?: typeof fetch;
}

/**
 * 共有サーバーにつなぐバックエンド（BackendHost と同じ使い方）。
 * ファイルを扱う操作は、端末のファイルを読んで送る / 返ってきた中身を端末のパスに書く。
 * イベントは Server-Sent Events で受け、切れたら再接続する。
 */
export class RemoteHost {
  private listeners = new Set<(e: BackendEvent) => void>()
  private controller: AbortController | null = null
  info: AppInfo | null = null

  constructor(private readonly opts: RemoteHostOptions) {}

  private get base(): string {
    return this.opts.url.replace(/\/+$/, '')
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  start(): void {
    this.controller = new AbortController()
    void this.listen(this.controller.signal)
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
  }

  onEvent(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(e: BackendEvent): void {
    for (const l of this.listeners) l(e)
  }

  private async listen(signal: AbortSignal): Promise<void> {
    let delay = 1000
    while (!signal.aborted) {
      try {
        const res = await this.fetch(`${this.base}/events`, {
          headers: { Authorization: `Bearer ${this.opts.token}` },
          signal,
        })
        if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`)
        delay = 1000
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n')
            if (data) this.emit(JSON.parse(data) as BackendEvent)
          }
        }
      } catch (err) {
        if (signal.aborted) return
        this.emit({ type: 'backend.error', message: `サーバーとの接続が切れました（再接続します）: ${err instanceof Error ? err.message : String(err)}` })
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 30_000)
    }
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const req: RemoteRequest = { method, params }
    const p = (params ?? {}) as { path?: string }
    if (UPLOAD_METHODS.has(method)) {
      if (!p.path) throw new Error('ファイルを指定してください')
      req.upload = { name: path.basename(p.path), data: fs.readFileSync(p.path).toString('base64') }
    }
    const res = await this.fetch(`${this.base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (res.status === 401) throw new Error('サーバーの認証に失敗しました（トークンを確認してください）')
    const body = (await res.json()) as RemoteResponse
    if (!body.ok) throw Object.assign(new Error(body.error?.message ?? 'Server error'), { code: body.error?.code })
    if (DOWNLOAD_METHODS.has(method) && body.file && p.path) {
      fs.mkdirSync(path.dirname(p.path), { recursive: true })
      fs.writeFileSync(p.path, Buffer.from(body.file.data, 'base64'), { mode: 0o600 })
      // 結果に含まれるパス（バックアップなど）は端末のパスに置き換える
      const r = body.result as { path?: string } | undefined
      return r && typeof r === 'object' && 'path' in r ? { ...r, path: p.path } : body.result
    }
    if (method === 'attachments.download' && body.file) {
      const info = body.result as { id: string; storagePath: string | null }
      const dir = path.join(this.opts.cacheDir, info.id)
      fs.mkdirSync(dir, { recursive: true })
      const local = path.join(dir, path.basename(body.file.name))
      fs.writeFileSync(local, Buffer.from(body.file.data, 'base64'), { mode: 0o600 })
      return { ...info, storagePath: local }
    }
    if (method === 'app.info') this.info = body.result as AppInfo
    return body.result
  }
}
