import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ImportErrorCode, ImportResult, ImportRowEdit, ImportRowError } from '@shared/types'
import { toSummary } from './account-service'
import { parseAccountsCsv, type RawCsvRow } from './csv-parser'
import { publicFields, validateRow, type ParsedAccount } from './validate'
import type { AccountGroupRepository } from '../db/account-group-repository'
import type { AccountRepository } from '../db/account-repository'
import type { NewAccountRow } from '../db/schema'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'
import type { OAuthService } from '../oauth/oauth-service'
import type { ProviderRegistry } from '../providers/presets'
import type { CredentialCipher } from '../security/credential-cipher'
import { credentialSecrets, serializeCredentials } from '../security/credentials'

const SECRET_FIELDS = new Set(['password', 'client_secret', 'refresh_token'])

interface SessionRow {
  values: Record<string, string>;
  errors: ImportErrorCode[];
}

interface ImportSession {
  id: string;
  source: string;
  createdAt: number;
  /** 行番号 → 未解決の行。秘密情報を含むため backend のメモリにだけ置く。 */
  invalid: Map<number, SessionRow>;
  /** 取り込み画面で選んだ既定グループ。CSV の group 列があればそちらを優先する。 */
  defaultGroupId: string | null;
  /** 既存アカウントを更新するモードか */
  updateExisting: boolean;
}

export interface ImportOptions {
  groupId?: string | null;
  /** 既存アカウントは重複エラーにせず認証情報・接続設定を更新する */
  updateExisting?: boolean;
}

export interface ImportServiceDeps {
  repo: AccountRepository;
  groups: AccountGroupRepository;
  oauth: OAuthService;
  cipher: CredentialCipher;
  registry: ProviderRegistry;
  logger: Logger;
  events: EventBus;
  now?: () => string;
}

export class ImportService {
  private sessions = new Map<string, ImportSession>()
  private readonly now: () => string

  constructor(private readonly deps: ImportServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async importCsvFile(filePath: string, opts: ImportOptions = {}): Promise<ImportResult> {
    if (opts.groupId && !(await this.deps.groups.getById(opts.groupId)))
      throw new Error('グループが見つかりません')
    const content = await fs.readFile(filePath, 'utf8')
    const parsed = parseAccountsCsv(content)
    this.deps.logger.info('CSV parsed', {
      source: path.basename(filePath),
      rows: parsed.rows.length,
      format: parsed.format,
      columns: parsed.columns,
    })
    const session: ImportSession = {
      id: randomUUID(),
      source: path.basename(filePath),
      createdAt: Date.now(),
      invalid: new Map(),
      defaultGroupId: opts.groupId ?? null,
      updateExisting: opts.updateExisting ?? false,
    }
    this.sessions.set(session.id, session)
    return this.processRows(session, parsed.rows)
  }

  async retryRows(sessionId: string, edits: ImportRowEdit[]): Promise<ImportResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Import session not found')
    const rows: RawCsvRow[] = []
    for (const edit of edits) {
      const existing = session.invalid.get(edit.row)
      if (!existing) continue
      const values = { ...existing.values }
      for (const [k, v] of Object.entries(edit.fields)) {
        if (v === undefined) continue
        if (SECRET_FIELDS.has(k) && v === '') continue // 空は「変更なし」
        values[k] = v
      }
      session.invalid.delete(edit.row)
      rows.push({ row: edit.row, values })
    }
    return this.processRows(session, rows)
  }

  discard(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private async processRows(session: ImportSession, rows: RawCsvRow[]): Promise<ImportResult> {
    const started = Date.now()
    const existingEmails = await this.deps.repo.allEmailsLower()
    const seenEmails = new Set<string>()
    // セッション内に残っている他の無効行の email も「ファイル内重複」の対象にする
    for (const r of session.invalid.values()) {
      const e = (r.values.email ?? '').trim().toLowerCase()
      if (e) seenEmails.add(e)
    }

    const valid: Array<{ row: number; account: ParsedAccount }> = []
    for (const raw of rows) {
      const result = validateRow(raw.values, {
        registry: this.deps.registry,
        existingEmails,
        seenEmails,
        allowExisting: session.updateExisting,
      })
      if (result.ok) {
        seenEmails.add(result.account.email.toLowerCase())
        valid.push({ row: raw.row, account: result.account })
      } else {
        session.invalid.set(raw.row, { values: raw.values, errors: result.errors })
      }
    }

    // group 列のグループ名を ID に解決する（無ければ作る）。列が無い行は取り込み画面の既定グループ。
    const now = this.now()
    const groupIds = new Map<string, string>()
    let groupsCreated = false
    for (const { account } of valid) {
      const name = account.groupName
      if (!name) continue
      const key = name.toLowerCase()
      if (groupIds.has(key)) continue
      const existing = await this.deps.groups.getByName(name)
      if (existing) groupIds.set(key, existing.id)
      else {
        groupIds.set(key, (await this.deps.groups.create(name, now)).id)
        groupsCreated = true
      }
    }
    const groupFor = (name: string | null): string | null =>
      name ? (groupIds.get(name.toLowerCase()) ?? session.defaultGroupId) : session.defaultGroupId

    // 更新モードのときは、既存アカウントは削除せず認証情報・接続設定・グループだけ更新する
    const emailToId = session.updateExisting ? await this.deps.repo.emailIdMap() : new Map<string, string>()
    const toInsert: Array<{ row: number; account: ParsedAccount }> = []
    const toUpdate: Array<{ row: number; account: ParsedAccount; id: string }> = []
    for (const v of valid) {
      const existingId = emailToId.get(v.account.email.toLowerCase())
      if (session.updateExisting && existingId) toUpdate.push({ ...v, id: existingId })
      else toInsert.push(v)
    }
    let updated = 0
    for (const { account, id } of toUpdate) {
      for (const s of credentialSecrets(account.credentials)) this.deps.logger.scrubber.register(s)
      await this.deps.repo.updateForReimport(
        id,
        {
          auth_type: account.authType,
          encrypted_credentials: this.deps.cipher.encrypt(
            serializeCredentials(account.credentials),
            account.email,
          ),
          // グループは、CSV に group 列があるか既定グループを選んだ場合だけ更新（未指定なら既存のまま）
          ...(account.groupName || session.defaultGroupId
            ? { group_id: groupFor(account.groupName) }
            : {}),
        },
        now,
      )
      // 認証情報が変わったので、キャッシュ済みのアクセストークンを捨てる（新しい refresh_token で取り直す）
      for (const key of [id, `smtp:${id}`, `graph:${id}`]) this.deps.oauth.cache.delete(key)
      updated++
    }

    // 平文の認証情報はここで暗号化し、以後は暗号文だけを扱う
    const entities: NewAccountRow[] = toInsert.map(({ account }) => {
      for (const s of credentialSecrets(account.credentials)) this.deps.logger.scrubber.register(s)
      return {
        group_id: groupFor(account.groupName),
        id: randomUUID(),
        email: account.email,
        provider: account.provider,
        auth_type: account.authType,
        imap_host: account.imapHost,
        imap_port: account.imapPort,
        imap_secure: account.imapSecure,
        smtp_host: account.smtpHost,
        smtp_port: account.smtpPort,
        smtp_secure: account.smtpSecure,
        proxy: account.proxy,
        encrypted_credentials: this.deps.cipher.encrypt(
          serializeCredentials(account.credentials),
          account.email,
        ),
        enabled: 1,
        status: 'untested',
        auth_status: 'untested',
        last_error: null,
        last_error_at: null,
        last_success_at: null,
        last_sync_at: null,
        retry_count: 0,
        message_count: 0,
        created_at: now,
        updated_at: now,
      }
    })
    const imported = await this.deps.repo.insertMany(entities)
    if (updated > 0) {
      const ids = toUpdate.map((u) => u.id)
      const rows = await this.deps.repo.getByIds(ids)
      this.deps.events.emit({ type: 'accounts.updated', accounts: rows.map(toSummary) })
    }

    const invalid: ImportRowError[] = [...session.invalid.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([row, r]) => ({
        row,
        email: (r.values.email ?? '').trim(),
        errors: r.errors,
        fields: publicFields(r.values),
      }))

    const durationMs = Date.now() - started
    this.deps.logger.info('CSV import processed', {
      session: session.id,
      rows: rows.length,
      imported,
      updated,
      invalid: invalid.length,
      durationMs,
    })
    if (imported > 0) this.deps.events.emit({ type: 'accounts.imported', count: imported })
    if (
      groupsCreated ||
      ((imported > 0 || updated > 0) && (session.defaultGroupId || groupIds.size > 0))
    ) {
      const [groups, counts] = await Promise.all([
        this.deps.groups.list(),
        this.deps.groups.accountCounts(),
      ])
      this.deps.events.emit({
        type: 'groups.changed',
        groups: groups.map((g) => ({
          id: g.id,
          name: g.name,
          accountCount: counts[g.id] ?? 0,
          createdAt: g.created_at,
          updatedAt: g.updated_at,
        })),
      })
    }
    if (invalid.length === 0) this.sessions.delete(session.id)

    return {
      sessionId: session.id,
      total: rows.length,
      imported,
      updated,
      invalid,
      durationMs,
      source: session.source,
    }
  }
}
