import type { ErrorKind } from '@shared/types'

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

export interface RefreshParams {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface TokenResult {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  /** サーバーが新しい refresh token を返した場合（Microsoft はローテーションする） */
  refreshToken?: string;
}

/** 再試行しても直らない OAuth エラー */
const AUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
  'interaction_required',
  'consent_required',
  'login_required',
  'access_denied',
])

export async function refreshAccessToken(p: RefreshParams): Promise<TokenResult> {
  const body = new URLSearchParams()
  body.set('grant_type', 'refresh_token')
  body.set('client_id', p.clientId)
  body.set('refresh_token', p.refreshToken)
  if (p.clientSecret) body.set('client_secret', p.clientSecret)
  if (p.scope) body.set('scope', p.scope)

  const signals: AbortSignal[] = [AbortSignal.timeout(p.timeoutMs)]
  if (p.signal) signals.push(p.signal)
  const signal = AbortSignal.any(signals)
  const doFetch = p.fetchImpl ?? fetch

  let res: Response
  try {
    res = await doFetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal,
    })
  } catch (err) {
    if (p.signal?.aborted) throw err
    const msg = err instanceof Error ? err.message : String(err)
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new OAuthError(
      isTimeout ? 'OAuth token request timed out' : `OAuth token request failed: ${msg}`,
      'connection',
      isTimeout ? 'ETIMEDOUT' : 'ENETWORK',
    )
  }

  let json: Record<string, unknown>
  const text = await res.text()
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    json = {}
  }

  if (!res.ok) {
    const code = typeof json.error === 'string' ? json.error : `http_${res.status}`
    const desc = typeof json.error_description === 'string' ? json.error_description : ''
    const message = `OAuth ${code}${desc ? `: ${desc.slice(0, 200)}` : ''}`
    if (AUTH_ERROR_CODES.has(code)) throw new OAuthError(message, 'auth', code)
    if (res.status >= 500 || res.status === 429) throw new OAuthError(message, 'connection', code)
    if (res.status === 400 || res.status === 401) throw new OAuthError(message, 'auth', code)
    throw new OAuthError(message, 'unknown', code)
  }

  const accessToken = typeof json.access_token === 'string' ? json.access_token : ''
  if (!accessToken) throw new OAuthError('OAuth response did not include access_token', 'unknown')
  const expiresIn =
    typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in ?? 3600)
  const result: TokenResult = {
    accessToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  }
  if (
    typeof json.refresh_token === 'string' &&
    json.refresh_token &&
    json.refresh_token !== p.refreshToken
  ) {
    result.refreshToken = json.refresh_token
  }
  return result
}
