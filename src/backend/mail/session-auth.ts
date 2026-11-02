import type { Provider } from '@shared/types'
import type { ConnectionTestParams } from './email-provider'
import type { AccountRepository } from '../db/account-repository'
import type { AccountRow } from '../db/schema'
import type { Logger } from '../logging/logger'
import type { OAuthService } from '../oauth/oauth-service'
import type { CredentialCipher } from '../security/credential-cipher'
import { credentialSecrets, parseCredentials, serializeCredentials } from '../security/credentials'

export interface SessionAuthDeps {
  repo: AccountRepository;
  cipher: CredentialCipher;
  oauth: OAuthService;
  logger: Logger;
  connectTimeoutMs: () => number;
  tlsRejectUnauthorized: () => boolean;
  now: () => string;
}

/**
 * アカウントの暗号化済み認証情報から IMAP 接続パラメータを組み立てる。
 * OAuth2 の場合はアクセストークンを取得し、refresh token がローテーションされたら保存し直す。
 */
export async function buildSessionParams(
  account: AccountRow,
  deps: SessionAuthDeps,
  signal?: AbortSignal,
): Promise<ConnectionTestParams> {
  const creds = parseCredentials(deps.cipher.decrypt(account.encrypted_credentials, account.email))
  for (const s of credentialSecrets(creds)) deps.logger.scrubber.register(s)
  const base = {
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_secure as 'tls' | 'starttls' | 'none',
    user: account.email,
    proxy: account.proxy,
    timeoutMs: deps.connectTimeoutMs(),
    rejectUnauthorized: deps.tlsRejectUnauthorized(),
  }
  if (creds.type === 'password') {
    return { ...base, auth: { type: 'password', password: creds.password } }
  }
  const token = await deps.oauth.getAccessToken(
    { id: account.id, email: account.email, provider: account.provider as Provider },
    creds,
    signal,
  )
  if (token.rotatedRefreshToken) {
    const rotated = { ...creds, refreshToken: token.rotatedRefreshToken }
    await deps.repo.updateCredentials(
      account.id,
      deps.cipher.encrypt(serializeCredentials(rotated), account.email),
      deps.now(),
    )
    deps.logger.debug('Refresh token rotated', { accountId: account.id })
  }
  return { ...base, auth: { type: 'oauth2', accessToken: token.accessToken } }
}
