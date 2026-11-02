import { randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { BackendApp } from '@backend/app'
import type { RpcMethod } from '@shared/api'
import { DOWNLOAD_METHODS, MAX_BODY_BYTES, UPLOAD_METHODS, type RemoteRequest, type RemoteResponse } from './protocol'

export interface ServerToken {
  /** 監査ログに残る名前 */
  name: string;
  token: string;
}

export interface ServerOptions {
  app: BackendApp;
  tokens: ServerToken[];
  host?: string;
  port?: number;
  tls?: { cert: string; key: string };
  /** 一時ファイルの置き場（既定 OS の一時ディレクトリ） */
  tmpDir?: string;
}

/** "alice:token1,bob:token2" を読む。トークンは 16 文字以上 */
export function parseTokens(spec: string | undefined): ServerToken[] {
  const out: ServerToken[] = []
  for (const part of (spec ?? '').split(',')) {
    const i = part.indexOf(':')
    if (i <= 0) continue
    const name = part.slice(0, i).trim()
    const token = part.slice(i + 1).trim()
    if (!name || token.length < 16) throw new Error(`Token for "${name}" must be at least 16 characters`)
    out.push({ name, token })
  }
  return out
}

function findActor(tokens: ServerToken[], header: string | undefined): string | null {
  const m = /^Bearer (.+)$/.exec(header ?? '')
  if (!m) return null
  const given = Buffer.from(m[1])
  for (const t of tokens) {
    const want = Buffer.from(t.token)
    if (want.length === given.length && timingSafeEqual(want, given)) return t.name
  }
  return null
}

/**
 * 共有サーバー: BackendApp を HTTP で公開する。
 *   POST /rpc     … RPC（RemoteRequest → RemoteResponse）
 *   GET  /events  … バックエンドのイベント（Server-Sent Events）
 *   GET  /health  … 死活確認（認証不要）
 * すべて Bearer トークンで認証し、トークンの名前を監査ログの操作者にする。
 */
export function createMailServer(opts: ServerOptions): http.Server {
  if (opts.tokens.length === 0) throw new Error('At least one access token is required (MM_SERVER_TOKENS)')
  const tmpDir = opts.tmpDir ?? path.join(os.tmpdir(), 'mail-manager-server')
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  const clients = new Set<http.ServerResponse>()
  opts.app.onEvent((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const c of clients) c.write(data)
  })

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, version: opts.app.info().version })
    const actor = findActor(opts.tokens, req.headers.authorization)
    if (!actor) return send(401, { ok: false, error: { message: 'Unauthorized' } })

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/rpc') return send(404, { ok: false, error: { message: 'Not found' } })

    let size = 0
    const chunks: Buffer[] = []
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > MAX_BODY_BYTES) return send(413, { ok: false, error: { message: 'Request too large' } })
      chunks.push(c as Buffer)
    }
    let body: RemoteRequest
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RemoteRequest
    } catch {
      return send(400, { ok: false, error: { message: 'Invalid JSON' } })
    }
    if (typeof body.method !== 'string')
      return send(400, { ok: false, error: { message: 'Invalid method' } })

    const temp: string[] = []
    try {
      let params = body.params as Record<string, unknown> | undefined
      let downloadPath: string | null = null
      if (UPLOAD_METHODS.has(body.method)) {
        if (!body.upload) throw new Error('This operation needs a file')
        const p = path.join(tmpDir, `${randomUUID()}-${path.basename(body.upload.name)}`)
        fs.writeFileSync(p, Buffer.from(body.upload.data, 'base64'), { mode: 0o600 })
        temp.push(p)
        params = { ...(params ?? {}), path: p }
      }
      if (DOWNLOAD_METHODS.has(body.method)) {
        const name = path.basename(String(params?.path ?? 'export'))
        downloadPath = path.join(tmpDir, `${randomUUID()}-${name}`)
        temp.push(downloadPath)
        params = { ...(params ?? {}), path: downloadPath }
      }
      const result = await opts.app.call(body.method as RpcMethod, params as never, { actor })
      const out: RemoteResponse = { ok: true, result }
      if (downloadPath && fs.existsSync(downloadPath))
        out.file = { name: path.basename(downloadPath), data: fs.readFileSync(downloadPath).toString('base64') }
      if (body.method === 'attachments.download') {
        const info = result as { storagePath: string | null; filename: string }
        if (info.storagePath && fs.existsSync(info.storagePath))
          out.file = { name: info.filename, data: fs.readFileSync(info.storagePath).toString('base64') }
      }
      send(200, out)
    } catch (err) {
      const message = opts.app.logger.scrubber.scrub(err instanceof Error ? err.message : String(err))
      send(200, { ok: false, error: { message, code: (err as { code?: string })?.code } })
    } finally {
      for (const p of temp) fs.rmSync(p, { force: true })
    }
  }

  const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ ok: false, error: { message: String(err) } }))
    })
  }
  const server = opts.tls
    ? https.createServer({ cert: fs.readFileSync(opts.tls.cert), key: fs.readFileSync(opts.tls.key) }, listener)
    : http.createServer(listener)
  server.on('close', () => {
    for (const c of clients) c.end()
    clients.clear()
  })
  return server
}
