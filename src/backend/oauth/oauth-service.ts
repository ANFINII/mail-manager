import type { Provider } from '@shared/types'
import { OAuthError, refreshAccessToken } from './oauth-client'
import { TokenCache } from './token-cache'
import type { Logger } from '../logging/logger'
import type { ProviderRegistry } from '../providers/presets'
import type { OAuthCredentials } from '../security/credentials'

export interface OAuthServiceDeps {
  registry: ProviderRegistry;
  logger: Logger;
  timeoutMs: () => number;
  fetchImpl?: typeof fetch;
  cache?: TokenCache;
}

export interface AccessTokenResult {
  accessToken: string;
  rotatedRefreshToken?: string;
}

export class OAuthService {
  readonly cache: TokenCache

  constructor(private readonly deps: OAuthServiceDeps) {
    this.cache = deps.cache ?? new TokenCache()
  }

  /** purpose 'imap'（既定）と 'smtp' で別スコープ・別キャッシュのトークンを取得する */
  async getAccessToken(
    account: { id: string; email: string; provider: Provider },
    creds: OAuthCredentials,
    signal?: AbortSignal,
    purpose: 'imap' | 'smtp' | 'graph' = 'imap',
  ): Promise<AccessTokenResult> {
    const cacheKey = purpose === 'imap' ? account.id : `${purpose}:${account.id}`
    const cached = this.cache.get(cacheKey)
    if (cached) return { accessToken: cached }

    const preset = this.deps.registry.get(account.provider)
    const oauth = preset.oauth
    if (!oauth) {
      throw new OAuthError(
        `Provider ${account.provider} does not support OAuth2`,
        'auth',
        'unsupported_provider',
      )
    }
    const result = await refreshAccessToken({
      tokenUrl: oauth.tokenUrl,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
      scope:
        purpose === 'graph'
          ? (oauth.graphScope ?? oauth.scope)
          : purpose === 'smtp'
            ? oauth.smtpScope
            : oauth.scope,
      timeoutMs: this.deps.timeoutMs(),
      signal,
      fetchImpl: this.deps.fetchImpl,
    })
    this.deps.logger.scrubber.register(result.accessToken)
    if (result.refreshToken) this.deps.logger.scrubber.register(result.refreshToken)
    this.cache.set(cacheKey, result.accessToken, result.expiresAt)
    this.deps.logger.debug('OAuth access token obtained', { accountId: account.id, purpose })
    return { accessToken: result.accessToken, rotatedRefreshToken: result.refreshToken }
  }
}
