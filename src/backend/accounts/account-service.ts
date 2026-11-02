import type {
  AccountCredentialsUpdate,
  AccountDetail,
  AccountListQuery,
  AccountStatus,
  AccountSummary,
  AuthStatus,
  AuthType,
  Provider,
  SecureMode,
} from '@shared/types'
import type { AccountRepository } from '../db/account-repository'
import type { AccountRow } from '../db/schema'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'
import type { OAuthService } from '../oauth/oauth-service'
import type { ProviderRegistry } from '../providers/presets'
import type { CredentialCipher } from '../security/credential-cipher'
import {
  credentialSecrets,
  parseCredentials,
  serializeCredentials,
  type Credentials,
} from '../security/credentials'

export function toSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    email: row.email,
    provider: row.provider as Provider,
    authType: row.auth_type as AuthType,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure as SecureMode,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure as SecureMode | null,
    proxy: row.proxy,
    enabled: row.enabled === 1,
    status: row.status as AccountStatus,
    authStatus: row.auth_status as AuthStatus,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastSuccessAt: row.last_success_at,
    lastSyncAt: row.last_sync_at,
    retryCount: row.retry_count,
    messageCount: row.message_count,
    groupId: row.group_id ?? null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class AccountService {
  constructor(
    private readonly deps: {
      repo: AccountRepository;
      cipher: CredentialCipher;
      events: EventBus;
      logger: Logger;
      registry: ProviderRegistry;
      oauth: OAuthService;
      now?: () => string;
    },
  ) {}

  /**
   * 認証情報を更新する。秘密値は空なら現在の値を維持し、暗号化して保存する。
   * 保存後は認証状態を「未テスト」に戻し、キャッシュ済みのアクセストークンを捨てる。
   */
  async updateCredentials(id: string, update: AccountCredentialsUpdate): Promise<AccountDetail> {
    const row = await this.deps.repo.getById(id)
    if (!row) throw new Error('アカウントが見つかりません')
    let current: Credentials | null
    try {
      current = parseCredentials(this.deps.cipher.decrypt(row.encrypted_credentials, row.email))
    } catch {
      current = null
    }
    const authType: AuthType = update.authType ?? (row.auth_type as AuthType)
    const preset = this.deps.registry.get(row.provider as Provider)
    const pick = (next: string | undefined, prev: string | undefined): string =>
      next !== undefined && next !== '' ? next : (prev ?? '')

    let next: Credentials
    if (authType === 'password') {
      if (!preset.passwordAuthSupported)
        throw new Error('このプロバイダーはパスワード認証に対応していません')
      const password = pick(update.password, current?.type === 'password' ? current.password : '')
      if (!password) throw new Error('パスワードを入力してください')
      next = { type: 'password', password }
    } else {
      if (!preset.oauth) throw new Error('このプロバイダーは OAuth2 に対応していません')
      const prev = current?.type === 'oauth2' ? current : null
      const clientId = pick(update.clientId?.trim(), prev?.clientId).trim()
      const refreshToken = pick(update.refreshToken?.trim(), prev?.refreshToken).trim()
      const clientSecret = pick(update.clientSecret?.trim(), prev?.clientSecret).trim()
      if (!clientId) throw new Error('client_id を入力してください')
      if (!refreshToken) throw new Error('refresh_token を入力してください')
      if (preset.oauth.clientSecretRequired && !clientSecret)
        throw new Error('このプロバイダーは client_secret が必要です')
      // OAuth2 認証には使わないが、取り込み時に保持した password 列の値は維持する
      const keepPassword = update.password !== undefined ? update.password : (prev?.password ?? '')
      next = {
        type: 'oauth2',
        clientId,
        refreshToken,
        ...(clientSecret ? { clientSecret } : {}),
        ...(keepPassword ? { password: keepPassword } : {}),
      }
    }
    for (const s of credentialSecrets(next)) this.deps.logger.scrubber.register(s)

    const now = (this.deps.now ?? (() => new Date().toISOString()))()
    await this.deps.repo.updateCredentials(
      id,
      this.deps.cipher.encrypt(serializeCredentials(next), row.email),
      now,
      authType !== row.auth_type ? authType : undefined,
    )
    // 認証情報が変わったので、状態は未テストに戻し、古いトークンは捨てる
    await this.deps.repo.updateStatus(
      id,
      { auth_status: 'untested', status: row.enabled === 1 ? 'untested' : 'disabled', retry_count: 0 },
      now,
    )
    for (const key of [id, `smtp:${id}`, `graph:${id}`]) this.deps.oauth.cache.delete(key)
    this.deps.logger.info('Account credentials updated', { accountId: id, authType })
    const updated = await this.deps.repo.getById(id)
    if (updated) this.deps.events.emit({ type: 'accounts.updated', accounts: [toSummary(updated)] })
    const detail = await this.get(id)
    if (!detail) throw new Error('アカウントが見つかりません')
    return detail
  }

  async list(query: AccountListQuery): Promise<AccountSummary[]> {
    const rows = await this.deps.repo.list(query)
    return rows.map(toSummary)
  }

  async get(id: string): Promise<AccountDetail | null> {
    const row = await this.deps.repo.getById(id)
    if (!row) return null
    const summary = toSummary(row)
    let oauthClientId: string | null = null
    let hasPassword = false
    let hasClientSecret = false
    let hasRefreshToken = false
    try {
      const creds = parseCredentials(
        this.deps.cipher.decrypt(row.encrypted_credentials, row.email),
      )
      if (creds.type === 'password') hasPassword = creds.password.length > 0
      else {
        oauthClientId = creds.clientId
        hasClientSecret = !!creds.clientSecret
        hasRefreshToken = creds.refreshToken.length > 0
      }
    } catch (err) {
      this.deps.logger.warn('Failed to decrypt credentials for detail view', {
        accountId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return { ...summary, oauthClientId, hasPassword, hasClientSecret, hasRefreshToken }
  }

  async delete(ids: string[]): Promise<number> {
    const deleted = await this.deps.repo.deleteByIds(ids)
    this.deps.logger.info('Accounts deleted', { count: deleted })
    if (deleted > 0) this.deps.events.emit({ type: 'accounts.removed', ids })
    return deleted
  }

  async setEnabled(ids: string[], enabled: boolean): Promise<number> {
    const updated = await this.deps.repo.setEnabled(ids, enabled, new Date().toISOString())
    this.deps.logger.info(enabled ? 'Accounts enabled' : 'Accounts disabled', { count: updated })
    if (updated > 0) {
      const rows = await this.deps.repo.getByIds(ids)
      this.deps.events.emit({ type: 'accounts.updated', accounts: rows.map(toSummary) })
    }
    return updated
  }
}
