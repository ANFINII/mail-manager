import type { Settings } from '@shared/types'
import { parseRetryDelays } from '../auth/retry-policy'
import type { SettingsRepository } from '../db/settings-repository'

export const DEFAULT_SETTINGS: Settings = {
  authConcurrency: 10,
  syncConcurrency: 20,
  maxRetries: 3,
  connectTimeoutMs: 20_000,
  tlsRejectUnauthorized: true,
  syncFolders: 'all',
  initialSyncMessages: 500,
  maxMessageBytes: 3 * 1024 * 1024,
  autoSyncIntervalMin: 1,
  autoSyncIntervalSec: 0,
  autoSyncOnAuth: true,
  notifyNewMail: true,
  webhookUrl: '',
  storeAttachments: true,
  healthStaleHours: 24,
  syncFlagChanges: true,
  idleGroupId: '',
  idleMaxConnections: 50,
  retentionDays: 0,
  attachmentRetentionDays: 0,
  reportTime: '',
  reportTo: '',
  reportFromAccountId: '',
  reportWebhook: false,
}

type Spec =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'string'; max: number }
  | { kind: 'enum'; values: readonly string[] };

const SPECS: Record<keyof Settings, Spec> = {
  authConcurrency: { kind: 'int', min: 1, max: 100 },
  syncConcurrency: { kind: 'int', min: 1, max: 100 },
  maxRetries: { kind: 'int', min: 0, max: 10 },
  connectTimeoutMs: { kind: 'int', min: 1_000, max: 120_000 },
  tlsRejectUnauthorized: { kind: 'bool' },
  syncFolders: { kind: 'enum', values: ['inbox', 'all'] },
  initialSyncMessages: { kind: 'int', min: 0, max: 1_000_000 },
  maxMessageBytes: { kind: 'int', min: 64 * 1024, max: 100 * 1024 * 1024 },
  autoSyncIntervalMin: { kind: 'int', min: 0, max: 24 * 60 },
  autoSyncIntervalSec: { kind: 'int', min: 0, max: 24 * 60 * 60 },
  autoSyncOnAuth: { kind: 'bool' },
  notifyNewMail: { kind: 'bool' },
  webhookUrl: { kind: 'string', max: 2048 },
  storeAttachments: { kind: 'bool' },
  healthStaleHours: { kind: 'int', min: 0, max: 24 * 365 },
  syncFlagChanges: { kind: 'bool' },
  idleGroupId: { kind: 'string', max: 64 },
  idleMaxConnections: { kind: 'int', min: 1, max: 1000 },
  retentionDays: { kind: 'int', min: 0, max: 36500 },
  attachmentRetentionDays: { kind: 'int', min: 0, max: 36500 },
  reportTime: { kind: 'string', max: 5 },
  reportTo: { kind: 'string', max: 320 },
  reportFromAccountId: { kind: 'string', max: 64 },
  reportWebhook: { kind: 'bool' },
}

const ENV_KEYS: Record<keyof Settings, string> = {
  authConcurrency: 'MM_AUTH_CONCURRENCY',
  syncConcurrency: 'MM_SYNC_CONCURRENCY',
  maxRetries: 'MM_MAX_RETRIES',
  connectTimeoutMs: 'MM_CONNECT_TIMEOUT_MS',
  tlsRejectUnauthorized: 'MM_TLS_REJECT_UNAUTHORIZED',
  syncFolders: 'MM_SYNC_FOLDERS',
  initialSyncMessages: 'MM_INITIAL_SYNC_MESSAGES',
  maxMessageBytes: 'MM_MAX_MESSAGE_BYTES',
  autoSyncIntervalMin: 'MM_AUTO_SYNC_INTERVAL_MIN',
  autoSyncIntervalSec: 'MM_AUTO_SYNC_INTERVAL_SEC',
  autoSyncOnAuth: 'MM_AUTO_SYNC_ON_AUTH',
  notifyNewMail: 'MM_NOTIFY_NEW_MAIL',
  webhookUrl: 'MM_WEBHOOK_URL',
  storeAttachments: 'MM_STORE_ATTACHMENTS',
  healthStaleHours: 'MM_HEALTH_STALE_HOURS',
  syncFlagChanges: 'MM_SYNC_FLAG_CHANGES',
  idleGroupId: 'MM_IDLE_GROUP_ID',
  idleMaxConnections: 'MM_IDLE_MAX_CONNECTIONS',
  retentionDays: 'MM_RETENTION_DAYS',
  attachmentRetentionDays: 'MM_ATTACHMENT_RETENTION_DAYS',
  reportTime: 'MM_REPORT_TIME',
  reportTo: 'MM_REPORT_TO',
  reportFromAccountId: 'MM_REPORT_FROM_ACCOUNT_ID',
  reportWebhook: 'MM_REPORT_WEBHOOK',
}

/**
 * 設定は DB に保存する。環境変数 (MM_*) は開発・テスト用の上書きで、GUI からの変更より優先される。
 */
export class SettingsService {
  private current: Settings = { ...DEFAULT_SETTINGS }
  private listeners = new Set<(s: Settings) => void>()
  readonly envOverrides: string[] = []
  readonly retryDelaysMs: number[]

  constructor(
    private readonly repo: SettingsRepository,
    private readonly env: NodeJS.ProcessEnv = {},
  ) {
    this.retryDelaysMs = parseRetryDelays(env.MM_RETRY_DELAYS_MS)
    if (env.MM_RETRY_DELAYS_MS) this.envOverrides.push('MM_RETRY_DELAYS_MS')
  }

  async load(): Promise<void> {
    const stored = await this.repo.getAll()
    const next: Settings = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      const fromDb = stored[key]
      if (fromDb !== undefined) assign(next, key, fromDb)
      const fromEnv = this.env[ENV_KEYS[key]]
      if (fromEnv !== undefined && fromEnv !== '') {
        assign(next, key, fromEnv)
        this.envOverrides.push(ENV_KEYS[key])
      }
    }
    this.current = next
  }

  get(): Settings {
    return { ...this.current }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next: Settings = { ...this.current }
    for (const [key, value] of Object.entries(patch) as Array<[keyof Settings, unknown]>) {
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue
      assign(next, key, value)
      await this.repo.set(key, String(next[key]))
    }
    this.current = next
    for (const l of this.listeners) l(this.get())
    return this.get()
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function assign(target: Settings, key: keyof Settings, raw: unknown): void {
  const spec = SPECS[key]
  const t = target as unknown as Record<string, unknown>
  switch (spec.kind) {
    case 'bool':
      t[key] =
        typeof raw === 'boolean'
          ? raw
          : !['false', '0', 'no', 'off'].includes(String(raw).toLowerCase())
      return
    case 'string':
      t[key] = String(raw ?? '').slice(0, spec.max)
      return
    case 'enum':
      if (spec.values.includes(String(raw))) t[key] = String(raw)
      return
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return
      t[key] = Math.min(spec.max, Math.max(spec.min, Math.round(n)))
    }
  }
}
