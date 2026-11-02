import { MailError } from '../email-provider'

export interface ApiClientOptions {
  baseUrl: string;
  accessToken: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** エラーメッセージに付ける API 名 */
  label: string;
}

/**
 * Graph / Gmail API 共通の HTTP 呼び出し。401/403 は認証エラー、429/5xx は接続エラー（再試行対象）。
 * 429 は Retry-After（10 秒まで）を待って 1 回だけ再試行する。
 */
export async function apiRequest<T>(
  o: ApiClientOptions,
  method: string,
  pathOrUrl: string,
  body?: unknown,
  opts: { raw?: boolean } = {},
): Promise<T> {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${o.baseUrl}${pathOrUrl}`
  for (let attempt = 0; ; attempt++) {
    const signals = [AbortSignal.timeout(o.timeoutMs)]
    if (o.signal) signals.push(o.signal)
    let res: Response
    try {
      res = await (o.fetchImpl ?? fetch)(url, {
        method,
        headers: {
          Authorization: `Bearer ${o.accessToken}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any(signals),
      })
    } catch (err) {
      if (o.signal?.aborted) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new MailError(`${o.label} request failed: ${msg}`, 'connection', 'ENETWORK')
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(10, Number(res.headers.get('retry-after') ?? '1') || 1)
      await new Promise((r) => setTimeout(r, wait * 1000))
      continue
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T
      if (opts.raw) return Buffer.from(await res.arrayBuffer()) as T
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    }
    const text = (await res.text().catch(() => '')).slice(0, 300)
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 || res.status >= 500 ? 'connection' : 'unknown'
    throw new MailError(`${o.label} ${method} ${res.status}: ${text}`, kind, `http_${res.status}`)
  }
}
