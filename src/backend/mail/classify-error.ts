import type { ErrorKind } from '@shared/types'

export interface ClassifiedError {
  kind: ErrorKind;
  code: string | null;
  message: string;
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ETIMEOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EPROTO',
  'ENETWORK',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'NoConnection',
  'ProxyError',
  'ClosedAfterConnectTLS',
  'ClosedAfterConnect',
])

const AUTH_MESSAGE =
  /authenticat|invalid credentials|login failed|bad password|invalid password|invalid_grant|AUTHENTICATIONFAILED|LOGIN failed|Not authenticated|OAuth/i
const CONNECTION_MESSAGE =
  /timeout|timed out|ECONN|socket|network|TLS|certificate|greeting|handshake|refused|unreachable|reset by peer|hang up|closed/i

/**
 * ImapFlow / OAuth / Node のエラーを auth / connection / unknown に分類する。
 * auth はリトライしない。connection はリトライする。
 */
export function classifyError(err: unknown): ClassifiedError {
  const e = (err ?? {}) as {
    name?: string;
    message?: string;
    code?: string | number;
    kind?: ErrorKind;
    authenticationFailed?: boolean;
    responseStatus?: string;
    serverResponseCode?: string;
    responseText?: string;
  }
  const message = typeof e.message === 'string' && e.message ? e.message : String(err)
  const code = e.code !== undefined && e.code !== null ? String(e.code) : null

  if (e.kind === 'auth' || e.kind === 'connection' || e.kind === 'unknown') {
    return { kind: e.kind, code, message }
  }
  if (e.authenticationFailed === true) return { kind: 'auth', code, message }
  if (
    e.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    e.serverResponseCode === 'AUTHORIZATIONFAILED'
  ) {
    return { kind: 'auth', code, message }
  }
  if (code && CONNECTION_CODES.has(code)) return { kind: 'connection', code, message }
  if (e.name === 'TimeoutError') return { kind: 'connection', code: code ?? 'ETIMEDOUT', message }
  if (e.responseStatus === 'NO' && AUTH_MESSAGE.test(`${message} ${e.responseText ?? ''}`)) {
    return { kind: 'auth', code, message }
  }
  if (AUTH_MESSAGE.test(message)) return { kind: 'auth', code, message }
  if (CONNECTION_MESSAGE.test(message)) return { kind: 'connection', code, message }
  return { kind: 'unknown', code, message }
}
