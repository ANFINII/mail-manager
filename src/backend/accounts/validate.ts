import type {
  AuthType,
  ImportErrorCode,
  ImportRowFields,
  Provider,
  SecureMode,
} from '@shared/types'
import { inferProviderFromEmail, type ProviderRegistry } from '../providers/presets'
import type { Credentials } from '../security/credentials'

export interface ParsedAccount {
  email: string;
  provider: Provider;
  authType: AuthType;
  imapHost: string;
  imapPort: number;
  imapSecure: SecureMode;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: SecureMode | null;
  proxy: string | null;
  credentials: Credentials;
  /** CSV の group 列（グループ名）。空なら取り込み時の既定グループに従う。 */
  groupName: string | null;
}

export type RowValidation =
  { ok: true; account: ParsedAccount } | { ok: false; errors: ImportErrorCode[] };

export interface ValidationContext {
  registry: ProviderRegistry;
  /** DB に登録済みの email（小文字） */
  existingEmails: Set<string>;
  /** 同じ取り込み内で既に出現した email（小文字）。有効行が見つかるたびに呼び出し側が追加する。 */
  seenEmails: Set<string>;
  /** true のとき、DB に既に存在する email を重複エラーにしない（更新対象として扱う） */
  allowExisting?: boolean;
}

const EMAIL_RE = /^[^\s@,;"'<>()]+@[^\s@,;"'<>()]+\.[^\s@,;"'<>()]+$/
const PROXY_RE = /^(socks5h?|socks4a?|https?):\/\/\S+$/i

function str(values: Record<string, string>, key: string): string {
  return (values[key] ?? '').trim()
}

export function parsePort(value: string | undefined, fallback: number | undefined): number | null {
  const v = (value ?? '').trim()
  if (!v) return fallback ?? null
  if (!/^\d+$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= 65535 ? n : null
}

export function parseSecure(
  value: string | undefined,
  fallback: SecureMode | undefined,
): SecureMode | null {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return fallback ?? null
  if (['tls', 'ssl', 'ssl/tls', 'true', '1', 'yes', 'implicit'].includes(v)) return 'tls'
  if (['starttls', 'start_tls', 'explicit'].includes(v)) return 'starttls'
  if (['none', 'false', '0', 'no', 'plain', 'off'].includes(v)) return 'none'
  return null
}

export function defaultSecureForPort(port: number | null): SecureMode {
  if (port === 143 || port === 587 || port === 25) return 'starttls'
  return 'tls'
}

export function validateRow(values: Record<string, string>, ctx: ValidationContext): RowValidation {
  const errors: ImportErrorCode[] = []

  const email = str(values, 'email')
  if (!email) errors.push('missing_email')
  else if (!EMAIL_RE.test(email)) errors.push('invalid_email')
  const emailLower = email.toLowerCase()
  if (email && errors.length === 0) {
    if (ctx.seenEmails.has(emailLower)) errors.push('duplicate_in_file')
    else if (!ctx.allowExisting && ctx.existingEmails.has(emailLower)) errors.push('duplicate_in_db')
  }

  const providerStr = str(values, 'provider').toLowerCase()
  let provider: Provider
  if (!providerStr) provider = email ? inferProviderFromEmail(email) : 'custom'
  else if (ctx.registry.isProvider(providerStr)) provider = providerStr
  else {
    errors.push('invalid_provider')
    provider = 'custom'
  }
  const preset = ctx.registry.get(provider)

  const authStr = str(values, 'auth_type').toLowerCase()
  let authType: AuthType
  if (!authStr) authType = str(values, 'refresh_token') ? 'oauth2' : 'password'
  else if (authStr === 'password' || authStr === 'oauth2') authType = authStr
  else if (authStr === 'oauth') authType = 'oauth2'
  else {
    errors.push('invalid_auth_type')
    authType = 'password'
  }

  let credentials: Credentials | null = null
  if (authType === 'password') {
    if (!preset.passwordAuthSupported) errors.push('password_auth_not_supported')
    const password = values.password ?? ''
    if (!password) errors.push('missing_password')
    else credentials = { type: 'password', password }
  } else {
    const clientId = str(values, 'client_id')
    const refreshToken = str(values, 'refresh_token')
    const clientSecret = str(values, 'client_secret')
    if (!clientId) errors.push('missing_client_id')
    if (!refreshToken) errors.push('missing_refresh_token')
    if (clientId && refreshToken) {
      // password 列の値は OAuth2 認証には使わないが、取り込んだ情報を残すため保持する
      const extraPassword = values.password ?? ''
      credentials = {
        type: 'oauth2',
        clientId,
        refreshToken,
        ...(clientSecret ? { clientSecret } : {}),
        ...(extraPassword ? { password: extraPassword } : {}),
      }
    }
  }

  const imapHost = str(values, 'imap_host') || preset.imapHost || ''
  if (!imapHost) errors.push('missing_imap_host')
  const imapPort = parsePort(values.imap_port, preset.imapPort ?? 993)
  if (imapPort === null) errors.push('invalid_imap_port')
  const imapSecure = parseSecure(
    values.imap_secure,
    preset.imapSecure ?? defaultSecureForPort(imapPort),
  )
  if (imapSecure === null) errors.push('invalid_imap_secure')

  const smtpHost = str(values, 'smtp_host') || preset.smtpHost || null
  let smtpPort: number | null = preset.smtpPort ?? null
  if (str(values, 'smtp_port')) {
    smtpPort = parsePort(values.smtp_port, undefined)
    if (smtpPort === null) errors.push('invalid_smtp_port')
  }
  let smtpSecure: SecureMode | null = preset.smtpSecure ?? null
  if (str(values, 'smtp_secure')) {
    smtpSecure = parseSecure(values.smtp_secure, undefined)
    if (smtpSecure === null) errors.push('invalid_smtp_secure')
  } else if (smtpHost && !smtpSecure) {
    smtpSecure = defaultSecureForPort(smtpPort)
  }

  const proxyRaw = str(values, 'proxy')
  let proxy: string | null = null
  if (proxyRaw) {
    if (PROXY_RE.test(proxyRaw)) proxy = proxyRaw
    else errors.push('invalid_proxy')
  }

  if (errors.length > 0 || !credentials || imapPort === null || imapSecure === null) {
    return { ok: false, errors: errors.length > 0 ? errors : ['missing_password'] }
  }
  return {
    ok: true,
    account: {
      email,
      provider,
      authType,
      imapHost,
      imapPort,
      imapSecure,
      smtpHost,
      smtpPort,
      smtpSecure,
      proxy,
      credentials,
      groupName: str(values, 'group') || null,
    },
  }
}

/** GUI に返してよい（秘密情報を含まない）行の内容 */
export function publicFields(values: Record<string, string>): ImportRowFields {
  return {
    email: str(values, 'email'),
    provider: str(values, 'provider'),
    auth_type: str(values, 'auth_type'),
    imap_host: str(values, 'imap_host'),
    imap_port: str(values, 'imap_port'),
    imap_secure: str(values, 'imap_secure'),
    smtp_host: str(values, 'smtp_host'),
    smtp_port: str(values, 'smtp_port'),
    smtp_secure: str(values, 'smtp_secure'),
    proxy: str(values, 'proxy'),
    group: str(values, 'group'),
    client_id: str(values, 'client_id'),
    has_password: (values.password ?? '').length > 0,
    has_client_secret: str(values, 'client_secret').length > 0,
    has_refresh_token: str(values, 'refresh_token').length > 0,
    // 取り込み画面での表示・再編集用。取り込みセッション（メモリ上）限定で、DB・ログには残さない。
    password: values.password ?? '',
    client_secret: str(values, 'client_secret'),
    refresh_token: str(values, 'refresh_token'),
  }
}
