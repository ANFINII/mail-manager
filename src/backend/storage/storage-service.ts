import fs from 'node:fs'
import path from 'node:path'
import { sql, type Kysely } from 'kysely'
import type { Settings, StorageCleanupResult, StorageStats } from '@shared/types'
import type { Database } from '../db/schema'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'

export interface StorageServiceDeps {
  db: Kysely<Database>;
  driver: 'sqlite' | 'postgres';
  dbFile: string | null;
  attachmentsDir: string;
  settings: () => Settings;
  events: EventBus;
  logger: Logger;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60_000
const DELETE_CHUNK = 500

/**
 * 保存容量の管理。
 *  - 使用量（DB ファイル・添付ファイル）の集計
 *  - 保存期間を過ぎたメールのローカルコピー削除（サーバー上のメールは消さない）
 *  - 保存期間を過ぎた添付ファイル本体の削除（必要になれば IMAP から取り直す）
 *  - メールが無くなった添付フォルダ（孤立ファイル）の削除
 */
export class StorageService {
  private readonly log: Logger
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private running: Promise<StorageCleanupResult> | null = null

  constructor(private readonly deps: StorageServiceDeps) {
    this.log = deps.logger.child('storage')
    this.now = deps.now ?? (() => Date.now())
  }

  async stats(): Promise<StorageStats> {
    const dbBytes = this.deps.dbFile
      ? ['', '-wal', '-shm'].reduce((n, s) => n + fileSize(`${this.deps.dbFile}${s}`), 0)
      : null
    const att = dirUsage(this.deps.attachmentsDir)
    const row = await this.deps.db
      .selectFrom('messages')
      .select([
        sql<number>`count(*)`.as('c'),
        sql<string | null>`min(coalesce(internal_date, date))`.as('oldest'),
        sql<number>`coalesce(sum(length(coalesce(text_body, '')) + length(coalesce(html_body, ''))), 0)`.as(
          'bodyBytes',
        ),
      ])
      .executeTakeFirstOrThrow()
    return {
      dbBytes,
      attachmentBytes: att.bytes,
      attachmentFiles: att.files,
      messages: Number(row.c),
      bodyBytes: Number(row.bodyBytes),
      oldestMessageAt: row.oldest ?? null,
    }
  }

  /** 保存期間の設定に従って整理する。dryRun なら件数だけ数えて何も消さない */
  cleanup(opts: { dryRun?: boolean } = {}): Promise<StorageCleanupResult> {
    if (opts.dryRun) return this.doCleanup(true)
    if (!this.running)
      this.running = this.doCleanup(false).finally(() => {
        this.running = null
      })
    return this.running
  }

  private async doCleanup(dryRun: boolean): Promise<StorageCleanupResult> {
    const s = this.deps.settings()
    const now = this.now()
    const result: StorageCleanupResult = {
      dryRun,
      messagesRemoved: 0,
      attachmentFilesRemoved: 0,
      orphanDirsRemoved: 0,
      bytesFreed: 0,
    }

    // 1) 古いメールのローカルコピー
    if (s.retentionDays > 0) {
      const cutoff = new Date(now - s.retentionDays * DAY_MS).toISOString()
      const old = this.deps.db
        .selectFrom('messages')
        .select('id')
        .where(sql<string>`coalesce(internal_date, date, created_at)`, '<', cutoff)
      if (dryRun) {
        const r = await this.deps.db
          .selectFrom('messages')
          .select(sql<number>`count(*)`.as('c'))
          .where(sql<string>`coalesce(internal_date, date, created_at)`, '<', cutoff)
          .executeTakeFirstOrThrow()
        result.messagesRemoved = Number(r.c)
      } else {
        for (;;) {
          const ids = (await old.limit(DELETE_CHUNK).execute()).map((r) => r.id)
          if (ids.length === 0) break
          for (const id of ids) result.bytesFreed += removeDir(path.join(this.deps.attachmentsDir, id))
          // SQLite は削除トリガーが全文検索表の行も消す。添付・転送記録は外部キーで消える
          await this.deps.db.deleteFrom('messages').where('id', 'in', ids).execute()
          result.messagesRemoved += ids.length
          this.deps.events.emit({ type: 'messages.changed', ids, deleted: true })
          if (ids.length < DELETE_CHUNK) break
        }
        if (result.messagesRemoved > 0) await this.refreshMessageCounts()
      }
    }

    // 2) 古い添付ファイル本体（メタデータは残し、必要時に取り直す）
    if (s.attachmentRetentionDays > 0) {
      const cutoff = new Date(now - s.attachmentRetentionDays * DAY_MS).toISOString()
      const rows = await this.deps.db
        .selectFrom('attachments')
        .select(['id', 'storage_path'])
        .where('storage_path', 'is not', null)
        .where('created_at', '<', cutoff)
        .execute()
      const removedIds: string[] = []
      for (const r of rows) {
        if (!r.storage_path) continue
        const size = fileSize(r.storage_path)
        if (!dryRun && size > 0) fs.rmSync(r.storage_path, { force: true })
        if (size > 0) {
          result.attachmentFilesRemoved++
          result.bytesFreed += size
        }
        removedIds.push(r.id)
      }
      if (!dryRun)
        for (let i = 0; i < removedIds.length; i += DELETE_CHUNK)
          await this.deps.db
            .updateTable('attachments')
            .set({ storage_path: null })
            .where('id', 'in', removedIds.slice(i, i + DELETE_CHUNK))
            .execute()
    }

    // 3) 孤立した添付フォルダ（メールが削除済み）
    if (fs.existsSync(this.deps.attachmentsDir)) {
      const dirs = fs.readdirSync(this.deps.attachmentsDir)
      for (let i = 0; i < dirs.length; i += DELETE_CHUNK) {
        const chunk = dirs.slice(i, i + DELETE_CHUNK)
        const alive = new Set(
          (
            await this.deps.db.selectFrom('messages').select('id').where('id', 'in', chunk).execute()
          ).map((r) => r.id),
        )
        for (const d of chunk) {
          if (alive.has(d)) continue
          const full = path.join(this.deps.attachmentsDir, d)
          const size = dirUsage(full).bytes
          if (!dryRun) removeDir(full)
          result.orphanDirsRemoved++
          result.bytesFreed += size
        }
      }
    }

    if (!dryRun && (result.messagesRemoved > 0 || result.bytesFreed > 0))
      this.log.info('Storage cleanup finished', { ...result })
    return result
  }

  /** SQLite ファイルを詰めて空き領域を OS に返す（大量削除の後に使う） */
  async vacuum(): Promise<{ before: number | null; after: number | null }> {
    if (this.deps.driver !== 'sqlite') throw new Error('VACUUM is only supported for SQLite')
    const before = (await this.stats()).dbBytes
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(this.deps.db)
    await sql`VACUUM`.execute(this.deps.db)
    const after = (await this.stats()).dbBytes
    this.log.info('Database vacuumed', { before, after })
    return { before, after }
  }

  private async refreshMessageCounts(): Promise<void> {
    await sql`UPDATE accounts SET message_count = (SELECT count(*) FROM messages m WHERE m.account_id = accounts.id)`.execute(
      this.deps.db,
    )
  }

  /** 起動 1 分後と、以後 1 日ごとに自動で整理する（保存期間がどちらも 0 なら孤立ファイルの掃除だけ） */
  startSchedule(firstDelayMs = 60_000, intervalMs = DAY_MS): void {
    this.stopSchedule()
    const run = () =>
      void this.cleanup().catch((err) =>
        this.log.warn('Scheduled storage cleanup failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    this.timer = setTimeout(() => {
      run()
      this.timer = setInterval(run, intervalMs)
      this.timer.unref?.()
    }, firstDelayMs)
    this.timer.unref?.()
  }

  stopSchedule(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
    }
    this.timer = null
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

function dirUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { bytes, files }
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      const u = dirUsage(full)
      bytes += u.bytes
      files += u.files
    } else if (e.isFile()) {
      bytes += fileSize(full)
      files++
    }
  }
  return { bytes, files }
}

function removeDir(dir: string): number {
  const { bytes } = dirUsage(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return bytes
}
