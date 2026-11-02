import { createHash } from 'node:crypto'
import net from 'node:net'
import nodemailer, { type Transporter } from 'nodemailer'
import type { Provider, SecureMode } from '@shared/types'
import { MailError } from './email-provider'
import type { AccountRow } from '../db/schema'
import type { Logger } from '../logging/logger'
import type { OAuthService } from '../oauth/oauth-service'
import { ProviderRegistry } from '../providers/presets'
import type { CredentialCipher } from '../security/credential-cipher'
import { credentialSecrets, parseCredentials } from '../security/credentials'

export interface SmtpSenderDeps {
  cipher: CredentialCipher;
  oauth: OAuthService;
  registry: ProviderRegistry;
  logger: Logger;
  connectTimeoutMs: () => number;
  tlsRejectUnauthorized: () => boolean;
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string | null;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

interface PooledTransport {
  transporter: Transporter;
  /** 接続先と認証情報のハッシュ。変わったら作り直す（トークン更新など） */
  key: string;
  lastUsed: number;
}

/** アカウントごとに同時に開く SMTP 接続数（Gmail/Outlook の同時接続制限を超えない値） */
const MAX_CONNECTIONS_PER_ACCOUNT = 3
/** この時間使われなかった接続プールは閉じる */
const POOL_IDLE_MS = 60_000

/**
 * アカウントの認証情報で SMTP 送信する。パスワード or OAuth2(XOAUTH2) に対応。
 * 接続はアカウントごとにプールして使い回す（1 通ごとに TLS 接続 + 認証をやり直さない）。
 */
export class SmtpSender {
  private readonly pools = new Map<string, PooledTransport>()
  private sweeper: NodeJS.Timeout | null = null

  constructor(private readonly deps: SmtpSenderDeps) {}

  private async transportFor(account: AccountRow, signal?: AbortSignal): Promise<PooledTransport> {
    const creds = parseCredentials(
      this.deps.cipher.decrypt(account.encrypted_credentials, account.email),
    )
    for (const s of credentialSecrets(creds)) this.deps.logger.scrubber.register(s)
    const preset = this.deps.registry.get(account.provider as Provider)
    const host = account.smtp_host || preset.smtpHost
    const port = account.smtp_port ?? preset.smtpPort ?? 587
    const secure =
      (account.smtp_secure as SecureMode | null) ??
      preset.smtpSecure ??
      (port === 465 ? 'tls' : 'starttls')
    if (!host) throw new MailError('SMTP host is not configured', 'unknown')

    let auth: Record<string, string>
    let secret: string
    if (creds.type === 'password') {
      auth = { user: account.email, pass: creds.password }
      secret = creds.password
    } else {
      const token = await this.deps.oauth.getAccessToken(
        { id: account.id, email: account.email, provider: account.provider as Provider },
        creds,
        signal,
        'smtp',
      )
      auth = { type: 'OAuth2', user: account.email, accessToken: token.accessToken }
      secret = token.accessToken
    }
    const key = createHash('sha256')
      .update(`${host}:${port}:${secure}:${creds.type}:${secret}`)
      .digest('hex')

    const existing = this.pools.get(account.id)
    if (existing && existing.key === key) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing) this.drop(account.id, existing)

    const transporter = nodemailer.createTransport({
      pool: true,
      maxConnections: MAX_CONNECTIONS_PER_ACCOUNT,
      maxMessages: 200,
      host,
      port,
      secure: secure === 'tls',
      requireTLS: secure === 'starttls',
      connectionTimeout: this.deps.connectTimeoutMs(),
      greetingTimeout: this.deps.connectTimeoutMs(),
      socketTimeout: Math.max(this.deps.connectTimeoutMs(), 60_000),
      tls: {
        rejectUnauthorized: this.deps.tlsRejectUnauthorized(),
        ...(net.isIP(host) ? {} : { servername: host }),
      },
      auth,
    })
    const entry: PooledTransport = { transporter, key, lastUsed: Date.now() }
    this.pools.set(account.id, entry)
    this.ensureSweeper()
    return entry
  }

  async send(account: AccountRow, message: OutgoingMessage, signal?: AbortSignal): Promise<string> {
    const entry = await this.transportFor(account, signal)
    try {
      const info = await entry.transporter.sendMail({
        from: account.email,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        inReplyTo: message.inReplyTo ?? undefined,
        attachments: message.attachments,
      })
      entry.lastUsed = Date.now()
      this.deps.logger.info('SMTP message sent', {
        accountId: account.id,
        to: message.to,
        messageId: info.messageId,
      })
      return info.messageId ?? ''
    } catch (err) {
      // 失敗した接続プールは捨て、次回は新しく接続する
      this.drop(account.id, entry)
      const scrubbed = this.deps.logger.scrubber.scrub(
        err instanceof Error ? err.message : String(err),
      )
      // XOAUTH2 のスコープ不足はメッセージから判別して分かりやすくする
      const kind = /auth|credential|5\.7\.|invalid_grant|scope|535/i.test(scrubbed)
        ? 'auth'
        : 'connection'
      throw new MailError(scrubbed, kind)
    }
  }

  /** 開いている接続プール数（テスト・統計用） */
  get openPools(): number {
    return this.pools.size
  }

  private drop(accountId: string, entry: PooledTransport): void {
    if (this.pools.get(accountId) === entry) this.pools.delete(accountId)
    try {
      entry.transporter.close()
    } catch {
      // already closed
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      const now = Date.now()
      for (const [id, entry] of this.pools) {
        if (now - entry.lastUsed > POOL_IDLE_MS) this.drop(id, entry)
      }
      if (this.pools.size === 0 && this.sweeper) {
        clearInterval(this.sweeper)
        this.sweeper = null
      }
    }, 15_000)
    this.sweeper.unref?.()
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    for (const [id, entry] of [...this.pools]) this.drop(id, entry)
  }
}
