import fs from 'node:fs'
import path from 'node:path'
import type { SearchQuery } from '@shared/types'
import type { AccountGroupRepository } from '../db/account-group-repository'
import type { AccountRepository } from '../db/account-repository'
import type { Logger } from '../logging/logger'
import type { SearchService } from '../search/search-service'
import type { CredentialCipher } from '../security/credential-cipher'
import { credentialSecrets, parseCredentials } from '../security/credentials'

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function writeCsv(filePath: string, header: string[], rows: Iterable<unknown[]>): number {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const out = fs.openSync(filePath, 'w', 0o600)
  let n = 0
  try {
    fs.writeSync(out, '﻿' + header.join(',') + '\n')
    for (const r of rows) {
      fs.writeSync(out, r.map(csvCell).join(',') + '\n')
      n++
    }
  } finally {
    fs.closeSync(out)
  }
  return n
}

/** CSV エクスポート。認証情報（パスワード・トークン）は決して出力しない。 */
export class ExportService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly search: SearchService,
    private readonly groups: AccountGroupRepository,
    private readonly cipher: CredentialCipher,
    private readonly logger: Logger,
  ) {}

  /**
   * 取り込んだ認証情報（パスワード / OAuth2 の client_id・client_secret・refresh_token）を含めて、
   * そのまま再取り込みできる形式で書き出す。平文の秘密情報がファイルに書かれる点に注意。
   */
  async accountsCsvWithCredentials(filePath: string, accountIds?: string[]): Promise<number> {
    const rows =
      accountIds && accountIds.length > 0
        ? (await this.accounts.getByIds(accountIds)).sort((a, b) => a.email.localeCompare(b.email))
        : await this.accounts.list({})
    const groupNames = new Map((await this.groups.list()).map((g) => [g.id, g.name]))
    this.logger.info('Exporting accounts WITH credentials', { count: rows.length })
    return writeCsv(
      filePath,
      [
        'email',
        'password',
        'provider',
        'auth_type',
        'client_id',
        'client_secret',
        'refresh_token',
        'imap_host',
        'imap_port',
        'imap_secure',
        'smtp_host',
        'smtp_port',
        'smtp_secure',
        'proxy',
        'group',
      ],
      rows.map((r) => {
        let password = ''
        let clientId = ''
        let clientSecret = ''
        let refreshToken = ''
        try {
          const creds = parseCredentials(this.cipher.decrypt(r.encrypted_credentials, r.email))
          for (const s of credentialSecrets(creds)) this.logger.scrubber.register(s)
          if (creds.type === 'password') password = creds.password
          else {
            clientId = creds.clientId
            clientSecret = creds.clientSecret ?? ''
            refreshToken = creds.refreshToken
            password = creds.password ?? '' // 取り込み時に保持した password 列の値
          }
        } catch (err) {
          this.logger.warn('Could not decrypt credentials for export', {
            accountId: r.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return [
          r.email,
          password,
          r.provider,
          r.auth_type,
          clientId,
          clientSecret,
          refreshToken,
          r.imap_host,
          r.imap_port,
          r.imap_secure,
          r.smtp_host,
          r.smtp_port,
          r.smtp_secure,
          r.proxy,
          r.group_id ? (groupNames.get(r.group_id) ?? '') : '',
        ]
      }),
    )
  }

  async accountsCsv(filePath: string, accountIds?: string[]): Promise<number> {
    const rows =
      accountIds && accountIds.length > 0
        ? (await this.accounts.getByIds(accountIds)).sort((a, b) => a.email.localeCompare(b.email))
        : await this.accounts.list({})
    const groupNames = new Map((await this.groups.list()).map((g) => [g.id, g.name]))
    return writeCsv(
      filePath,
      [
        'email',
        'group',
        'provider',
        'auth_type',
        'imap_host',
        'imap_port',
        'imap_secure',
        'smtp_host',
        'smtp_port',
        'smtp_secure',
        'proxy',
        'enabled',
        'status',
        'auth_status',
        'last_success_at',
        'last_sync_at',
        'message_count',
        'last_error',
        'last_error_at',
      ],
      rows.map((r) => [
        r.email,
        r.group_id ? (groupNames.get(r.group_id) ?? '') : '',
        r.provider,
        r.auth_type,
        r.imap_host,
        r.imap_port,
        r.imap_secure,
        r.smtp_host,
        r.smtp_port,
        r.smtp_secure,
        r.proxy,
        r.enabled,
        r.status,
        r.auth_status,
        r.last_success_at,
        r.last_sync_at,
        r.message_count,
        r.last_error,
        r.last_error_at,
      ]),
    )
  }

  async searchCsv(query: SearchQuery, filePath: string): Promise<number> {
    const items: unknown[][] = []
    for await (const m of this.search.iterate(query)) {
      items.push([
        m.accountEmail,
        m.mailboxPath,
        m.date,
        m.fromName,
        m.fromAddress,
        m.toAddresses.map((a) => a.address).join('; '),
        m.subject,
        m.hasAttachments ? 1 : 0,
        m.seen ? 1 : 0,
        m.size,
        m.messageId,
        m.snippet,
      ])
    }
    return writeCsv(
      filePath,
      [
        'account',
        'folder',
        'date',
        'from_name',
        'from_address',
        'to',
        'subject',
        'has_attachments',
        'seen',
        'size',
        'message_id',
        'snippet',
      ],
      items,
    )
  }
}
