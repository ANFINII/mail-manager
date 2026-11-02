import type { Provider } from '@shared/types'
import { MailError } from './email-provider'
import type { OutgoingMessage } from './smtp-sender'
import type { AccountRow } from '../db/schema'
import type { Logger } from '../logging/logger'
import type { OAuthService } from '../oauth/oauth-service'
import { ProviderRegistry } from '../providers/presets'
import type { CredentialCipher } from '../security/credential-cipher'
import { credentialSecrets, parseCredentials } from '../security/credentials'

export interface GraphSenderDeps {
  cipher: CredentialCipher;
  oauth: OAuthService;
  registry: ProviderRegistry;
  logger: Logger;
  timeoutMs: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Microsoft Graph API 経由でメールを送信する。
 * SMTP AUTH がメールボックスで無効でも、Mail.Send スコープがあれば送信できる。
 * saveToSentItems により送信控えは自動で Sent に保存される。
 */
export class GraphSender {
  constructor(private readonly deps: GraphSenderDeps) {}

  /** このアカウントで Graph 送信が使えるか（Microsoft の OAuth2 アカウント） */
  canSend(account: AccountRow): boolean {
    if (account.auth_type !== 'oauth2') return false
    return !!this.deps.registry.get(account.provider as Provider).oauth?.graphSendUrl
  }

  async send(account: AccountRow, message: OutgoingMessage, signal?: AbortSignal): Promise<string> {
    const preset = this.deps.registry.get(account.provider as Provider)
    const url = preset.oauth?.graphSendUrl
    if (!url) throw new MailError('Graph send is not supported for this provider', 'unknown')
    const creds = parseCredentials(
      this.deps.cipher.decrypt(account.encrypted_credentials, account.email),
    )
    if (creds.type !== 'oauth2') throw new MailError('Graph send requires OAuth2', 'auth')
    for (const s of credentialSecrets(creds)) this.deps.logger.scrubber.register(s)

    const token = await this.deps.oauth.getAccessToken(
      { id: account.id, email: account.email, provider: account.provider as Provider },
      creds,
      signal,
      'graph',
    )

    const body: Record<string, unknown> = {
      message: {
        subject: message.subject,
        body: message.html
          ? { contentType: 'HTML', content: message.html }
          : { contentType: 'Text', content: message.text ?? '' },
        toRecipients: [{ emailAddress: { address: message.to } }],
        ...(message.attachments && message.attachments.length > 0
          ? {
              attachments: message.attachments.map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.filename,
                contentType: a.contentType ?? 'application/octet-stream',
                contentBytes: a.content.toString('base64'),
              })),
            }
          : {}),
      },
      saveToSentItems: true,
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(this.deps.timeoutMs())]
    if (signal) signals.push(signal)
    const doFetch = this.deps.fetchImpl ?? fetch
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isTimeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new MailError(
        isTimeout ? 'Graph send timed out' : `Graph send failed: ${msg}`,
        'connection',
      )
    }

    if (res.status === 202 || res.ok) {
      this.deps.logger.info('Graph message sent', { accountId: account.id, to: message.to })
      return `graph-${Date.now()}`
    }
    const text = await res.text().catch(() => '')
    let code = `http_${res.status}`
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string } }
      if (j.error?.code) code = j.error.code
    } catch {
      // non-JSON
    }
    const scrubbed = this.deps.logger.scrubber.scrub(text).slice(0, 300)
    // 401/403 は権限/同意（Mail.Send 未同意など）→ auth
    const kind =
      res.status === 401 || res.status === 403
        ? 'auth'
        : res.status >= 500
          ? 'connection'
          : 'unknown'
    throw new MailError(`Graph send error ${res.status} ${code}: ${scrubbed}`, kind)
  }
}
