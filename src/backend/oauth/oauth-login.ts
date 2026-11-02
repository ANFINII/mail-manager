import { createHash, randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthLoginStart, OAuthLoginStatus, Provider } from '@shared/types'
import type { Logger } from '../logging/logger'
import type { ProviderRegistry } from '../providers/presets'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface OAuthLoginResult {
  provider: Provider;
  email: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

export interface OAuthLoginDeps {
  registry: ProviderRegistry;
  logger: Logger;
  timeoutMs: () => number;
  fetchImpl?: typeof fetch;
  /** 取得した refresh token でアカウントを作成・更新し、アカウント ID を返す */
  onAuthorized: (result: OAuthLoginResult, req: OAuthLoginStart) => Promise<string>;
}

interface LoginSession {
  id: string;
  req: OAuthLoginStart;
  state: string;
  verifier: string;
  redirectUri: string;
  server: http.Server;
  timer: NodeJS.Timeout;
  status: OAuthLoginStatus;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** id_token（JWT）の payload からメールアドレスを取り出す（トークンエンドポイントから直接受け取った値なので署名検証はしない） */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  const part = idToken.split('.')[1]
  if (!part) return null
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    for (const key of ['email', 'preferred_username', 'upn']) {
      const v = payload[key]
      if (typeof v === 'string' && EMAIL_RE.test(v)) return v.toLowerCase()
    }
  } catch {
    // 解析できなければメールアドレスは入力値を使う
  }
  return null
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  '<body style="font-family:-apple-system,system-ui,sans-serif;padding:40px;max-width:560px;margin:auto">' +
  `<h2>${title}</h2><p>${body}</p></body>`

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * OAuth2 の対話ログイン（RFC 8252: ネイティブアプリ向け、認可コード + PKCE + ループバックリダイレクト）。
 *  1. start: 127.0.0.1 の空きポートで受け口を開き、認可 URL を返す（renderer がブラウザで開く）
 *  2. ユーザーがブラウザでサインイン・同意すると、http://127.0.0.1:PORT/callback に認可コードが届く
 *  3. 認可コードを refresh token に交換し、onAuthorized でアカウントを作成・更新する
 *  4. renderer は status をポーリングして完了を知る
 */
export class OAuthLoginService {
  private readonly sessions = new Map<string, LoginSession>()
  private readonly log: Logger

  constructor(private readonly deps: OAuthLoginDeps) {
    this.log = deps.logger.child('oauth-login')
  }

  async start(req: OAuthLoginStart): Promise<{ sessionId: string; authorizeUrl: string }> {
    const preset = this.deps.registry.get(req.provider).oauth
    if (!preset) throw new Error('このプロバイダーは OAuth2 に対応していません')
    const clientId = req.clientId.trim()
    if (!clientId) throw new Error('client_id を入力してください')
    if (preset.clientSecretRequired && !req.clientSecret?.trim())
      throw new Error('このプロバイダーは client_secret が必要です')
    if (req.email && !EMAIL_RE.test(req.email.trim())) throw new Error('メールアドレスが不正です')

    const id = randomUUID()
    const state = randomBytes(16).toString('base64url')
    const { verifier, challenge } = pkcePair()
    const server = http.createServer((r, res) => void this.handle(id, r, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const url = new URL(preset.authorizeUrl)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', req.graph && preset.graphLoginScope ? preset.graphLoginScope : preset.loginScope)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (req.email) url.searchParams.set('login_hint', req.email.trim())
    for (const [k, v] of Object.entries(preset.authorizeParams ?? {})) url.searchParams.set(k, v)

    const timer = setTimeout(() => this.finish(id, { state: 'error', error: 'タイムアウトしました（5 分以内にサインインしてください）' }), LOGIN_TIMEOUT_MS)
    timer.unref?.()
    this.sessions.set(id, {
      id,
      req: { ...req, clientId, clientSecret: req.clientSecret?.trim() || undefined },
      state,
      verifier,
      redirectUri,
      server,
      timer,
      status: { state: 'pending' },
    })
    this.log.info('OAuth login started', { sessionId: id, provider: req.provider, port })
    return { sessionId: id, authorizeUrl: url.toString() }
  }

  status(sessionId: string): OAuthLoginStatus {
    return this.sessions.get(sessionId)?.status ?? { state: 'error', error: 'ログインセッションが見つかりません' }
  }

  cancel(sessionId: string): void {
    this.finish(sessionId, { state: 'error', error: 'キャンセルしました' })
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.cancel(id)
  }

  private finish(id: string, status: OAuthLoginStatus): void {
    const s = this.sessions.get(id)
    if (!s || s.status.state !== 'pending') return
    s.status = status
    clearTimeout(s.timer)
    // 受け付けを止める。応答中のブラウザ接続は、ページを返し終える猶予を置いてから切る
    s.server.close()
    const kill = setTimeout(() => s.server.closeAllConnections?.(), 1000)
    kill.unref?.()
    // 結果はしばらく参照できるようにしてから破棄する
    const cleanup = setTimeout(() => this.sessions.delete(id), 10 * 60_000)
    cleanup.unref?.()
  }

  private async handle(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const s = this.sessions.get(id)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!s || url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const reply = (status: number, title: string, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page(title, body))
    }
    if (s.status.state !== 'pending') {
      reply(400, 'Mail Manager', 'このログインはすでに終了しています。アプリに戻ってください。')
      return
    }
    if (url.searchParams.get('state') !== s.state) {
      reply(400, 'Mail Manager', '不正なリクエストです（state が一致しません）。')
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      const desc = url.searchParams.get('error_description') ?? ''
      this.finish(id, { state: 'error', error: `${error}${desc ? `: ${desc.slice(0, 200)}` : ''}` })
      reply(400, 'サインインできませんでした', escapeHtml(error))
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      reply(400, 'Mail Manager', '認可コードがありません。')
      return
    }
    try {
      const result = await this.exchange(s, code)
      const accountId = await this.deps.onAuthorized(result, s.req)
      this.finish(id, { state: 'done', email: result.email, accountId })
      this.log.info('OAuth login completed', { sessionId: id, provider: result.provider, accountId })
      reply(200, 'サインインしました', `${escapeHtml(result.email)} を Mail Manager に登録しました。このタブを閉じてアプリに戻ってください。`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.finish(id, { state: 'error', error: message })
      this.log.warn('OAuth login failed', { sessionId: id, error: this.deps.logger.scrubber.scrub(message) })
      reply(400, 'サインインできませんでした', escapeHtml(message))
    }
  }

  private async exchange(s: LoginSession, code: string): Promise<OAuthLoginResult> {
    const preset = this.deps.registry.get(s.req.provider).oauth!
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: s.redirectUri,
      client_id: s.req.clientId,
      code_verifier: s.verifier,
    })
    if (s.req.clientSecret) body.set('client_secret', s.req.clientSecret)
    const res = await (this.deps.fetchImpl ?? fetch)(preset.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.deps.timeoutMs()),
    })
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      // 非 JSON 応答
    }
    if (!res.ok) {
      const code = typeof json.error === 'string' ? json.error : `http_${res.status}`
      const desc = typeof json.error_description === 'string' ? `: ${json.error_description.slice(0, 200)}` : ''
      throw new Error(`トークンの取得に失敗しました（${code}${desc}）`)
    }
    const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : ''
    if (!refreshToken)
      throw new Error('refresh token が返されませんでした（オフラインアクセスの同意が必要です）')
    this.deps.logger.scrubber.register(refreshToken)
    const fromToken = emailFromIdToken(typeof json.id_token === 'string' ? json.id_token : undefined)
    const requested = s.req.email?.trim().toLowerCase() || null
    if (requested && fromToken && requested !== fromToken)
      throw new Error(`入力したメールアドレス（${requested}）と、サインインしたアカウント（${fromToken}）が違います`)
    const email = fromToken ?? requested
    if (!email) throw new Error('メールアドレスを取得できませんでした。メールアドレスを入力してやり直してください')
    return {
      provider: s.req.provider,
      email,
      clientId: s.req.clientId,
      clientSecret: s.req.clientSecret,
      refreshToken,
    }
  }
}
