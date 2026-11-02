import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '@shared/types'
import { parseFetchedMessage, type ParsedMessage } from './message-parser'
import { extractCode } from '../codes/extract-code'
import type { MailboxRepository } from '../db/mailbox-repository'
import type {
  FtsRow,
  MessageRepository,
  NewAttachmentRow,
  NewMessageRow,
} from '../db/message-repository'
import type { AccountRow, MailboxRow } from '../db/schema'
import type { Logger } from '../logging/logger'
import type { FetchedMessage, MailSession } from '../mail/mail-session'
import { AbortError } from '../queue/task-queue'

/** 同期時に本体保存する添付ファイルの上限（これを超えるものは転送時に取得する） */
const STORE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

export interface SyncContext {
  account: AccountRow;
  session: MailSession;
  mailboxRepo: MailboxRepository;
  messageRepo: MessageRepository;
  settings: Settings;
  attachmentsDir: string;
  logger: Logger;
  signal: AbortSignal;
  now: () => string;
  /** true なら初回上限を無視し UID 1 から全件を取得する */
  fullResync?: boolean;
  onProgress: (mailboxPath: string, fetched: number, total: number) => void;
  onMailboxes?: () => void;
}

export interface SyncOutcome {
  newMessages: number;
  mailboxesSynced: number;
  /** サーバー側でフラグ（既読・スター・返信済み）が変わり、ローカルへ反映したメッセージ ID */
  flagChangedIds: string[];
  /** サーバー側で削除（または別フォルダへ移動）されたため、ローカルから消したメッセージ ID */
  removedIds: string[];
  latest: { subject: string; from: string | null } | null;
}

const FETCH_CHUNK = 50
const SKIP_SPECIAL_USE = new Set(['\\All', '\\Important', '\\Flagged'])

export function selectMailboxesToSync(
  rows: MailboxRow[],
  mode: Settings['syncFolders'],
): MailboxRow[] {
  const enabled = rows.filter((m) => m.sync_enabled === 1)
  const inbox = enabled.filter((m) => m.path.toUpperCase() === 'INBOX')
  if (mode === 'inbox') return inbox
  const others = enabled.filter(
    (m) =>
      m.path.toUpperCase() !== 'INBOX' && !(m.special_use && SKIP_SPECIAL_USE.has(m.special_use)),
  )
  return [...inbox, ...others]
}

export function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'attachment'
  return base.slice(0, 180)
}

/**
 * 1 アカウントの差分同期。
 *   Last UID → UID SEARCH → 新着 UID → FETCH（構造 + 本文）→ DB
 * 取得済みメッセージは (account, mailbox, UID) で判定し、再取得しない。
 * チャンクごとに last_sync_uid を進めるので、途中で止まっても続きから再開できる。
 */
export async function syncAccount(ctx: SyncContext): Promise<SyncOutcome> {
  const { account, session, settings, logger, signal } = ctx
  const check = () => {
    if (signal.aborted) throw new AbortError()
  }
  const outcome: SyncOutcome = {
    newMessages: 0,
    mailboxesSynced: 0,
    flagChangedIds: [],
    removedIds: [],
    latest: null,
  }
  let latestDate = ''

  const list = await session.listMailboxes()
  const rows = await ctx.mailboxRepo.upsertMany(
    account.id,
    list
      .filter((m) => !m.noselect)
      .map((m) => ({
        path: m.path,
        name: m.name,
        delimiter: m.delimiter,
        specialUse: m.specialUse,
      })),
    ctx.now(),
  )
  ctx.onMailboxes?.()

  for (const mailbox of selectMailboxesToSync(rows, settings.syncFolders)) {
    check()
    const opened = await session.openMailbox(mailbox.path, true)
    let lastUid = mailbox.last_sync_uid
    if (mailbox.uid_validity !== null && mailbox.uid_validity !== opened.uidValidity) {
      const removed = await ctx.messageRepo.deleteByMailbox(mailbox.id)
      logger.warn(
        `Account ${account.email} mailbox ${mailbox.path} UIDVALIDITY changed, resynchronising`,
        {
          accountId: account.id,
          removed,
        },
      )
      lastUid = 0
    }

    // 既存メールの変更を取り込む（UIDVALIDITY が変わって全消去した場合・初回は対象なし）
    let reconciledModseq: string | null = null
    if (lastUid > 0 && settings.syncFlagChanges) {
      const r = await reconcileExisting(ctx, mailbox, opened, lastUid)
      outcome.flagChangedIds.push(...r.flagChangedIds)
      outcome.removedIds.push(...r.removedIds)
      reconciledModseq = r.modseq
    }

    // 全件取得モードでは UID 1 から探し、初回上限で飛ばした古いメールも遡って取得する。
    // 重複は existingUids で除外するので取得済みは再ダウンロードしない。
    const fromUid = ctx.fullResync ? 1 : lastUid + 1
    let uids = await session.searchUidsFrom(fromUid)
    uids = uids.filter((u) => u >= fromUid)
    const initial = lastUid === 0
    const limit = ctx.fullResync ? 0 : settings.initialSyncMessages
    let skipped = 0
    if (initial && limit > 0 && uids.length > limit) {
      skipped = uids.length - limit
      uids = uids.slice(-limit)
    }
    const highestUid =
      uids.length > 0 ? uids[uids.length - 1] : Math.max(lastUid, opened.uidNext - 1)
    const existing = await ctx.messageRepo.existingUids(mailbox.id, uids)
    uids = uids.filter((u) => !existing.has(u))

    let fetched = 0
    ctx.onProgress(mailbox.path, 0, uids.length)
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      check()
      const chunk = uids.slice(i, i + FETCH_CHUNK)
      const metas = new Map<number, FetchedMessage>()
      for await (const m of session.fetch(chunk, { source: false, structure: true }))
        metas.set(m.uid, m)
      const small = chunk.filter((u) => (metas.get(u)?.size ?? 0) <= settings.maxMessageBytes)
      for await (const m of session.fetch(small, { source: true, structure: false })) {
        const meta = metas.get(m.uid)
        if (meta) meta.source = m.source
      }

      const now = ctx.now()
      const messageRows: NewMessageRow[] = []
      const ftsRows: FtsRow[] = []
      const attachmentRows: NewAttachmentRow[] = []
      for (const uid of chunk) {
        check()
        const meta = metas.get(uid)
        if (!meta) continue
        let parsed: ParsedMessage
        try {
          parsed = await parseFetchedMessage(meta, session, {
            maxPartBytes: settings.maxMessageBytes,
          })
        } catch (err) {
          logger.warn(`Account ${account.email} failed to parse message`, {
            accountId: account.id,
            mailbox: mailbox.path,
            uid,
            error: err instanceof Error ? err.message : String(err),
          })
          continue
        }
        const id = randomUUID()
        const hasAttachments = parsed.attachments.length > 0
        const otp = extractCode({ subject: parsed.subject, text: parsed.text, html: parsed.html })
        messageRows.push({
          id,
          account_id: account.id,
          mailbox_id: mailbox.id,
          remote_uid: uid,
          message_id: parsed.messageId,
          in_reply_to: parsed.inReplyTo,
          from_address: parsed.from?.address ?? null,
          from_name: parsed.from?.name ?? null,
          to_addresses: JSON.stringify(parsed.to),
          cc_addresses: JSON.stringify(parsed.cc),
          subject: parsed.subject,
          text_body: parsed.text,
          html_body: parsed.html,
          snippet: parsed.snippet,
          date: parsed.date,
          internal_date: meta.internalDate,
          size: meta.size,
          has_attachments: hasAttachments ? 1 : 0,
          seen: meta.flags.has('\\Seen') ? 1 : 0,
          flagged: meta.flags.has('\\Flagged') ? 1 : 0,
          answered: meta.flags.has('\\Answered') ? 1 : 0,
          otp_code: otp.code,
          otp_link: otp.link,
          otp_scanned: 1,
          created_at: now,
          updated_at: now,
        })
        ftsRows.push({
          message_id: id,
          subject: parsed.subject,
          from_text: [parsed.from?.name, parsed.from?.address].filter(Boolean).join(' '),
          to_text: [...parsed.to, ...parsed.cc]
            .map((a) => [a.name, a.address].filter(Boolean).join(' '))
            .join(' '),
          body: parsed.text ?? (parsed.html ? parsed.snippet : ''),
          attachments: parsed.attachments.map((a) => a.filename).join(' '),
        })
        for (const a of parsed.attachments) {
          let storagePath: string | null = null
          // 同期時に添付本体を保存しておくと、転送のときに IMAP へ取り直さずに済む（送信のみで速い）。
          // 巨大な添付はディスクを圧迫するので上限を超えるものは保存せず、転送時に必要なら取得する。
          if (settings.storeAttachments && a.content && a.content.length <= STORE_ATTACHMENT_MAX_BYTES) {
            const dir = path.join(ctx.attachmentsDir, id)
            fs.mkdirSync(dir, { recursive: true })
            storagePath = path.join(dir, safeFilename(a.filename))
            fs.writeFileSync(storagePath, a.content, { mode: 0o600 })
          }
          attachmentRows.push({
            id: randomUUID(),
            message_id: id,
            filename: a.filename,
            content_type: a.contentType,
            size: a.size,
            part_id: a.partId,
            content_id: a.contentId,
            storage_path: storagePath,
            created_at: now,
          })
        }
        if (mailbox.path.toUpperCase() === 'INBOX' && (parsed.date ?? '') > latestDate) {
          latestDate = parsed.date ?? ''
          outcome.latest = { subject: parsed.subject, from: parsed.from?.address ?? null }
        }
      }
      await ctx.messageRepo.insertMany(messageRows, ftsRows, attachmentRows)
      fetched += chunk.length
      outcome.newMessages += messageRows.length
      await ctx.mailboxRepo.updateSyncState(
        mailbox.id,
        {
          uid_validity: opened.uidValidity,
          last_sync_uid: chunk[chunk.length - 1],
          total_messages: opened.exists,
          last_sync_at: ctx.now(),
        },
        ctx.now(),
      )
      ctx.onProgress(mailbox.path, fetched, uids.length)
    }

    await ctx.mailboxRepo.updateSyncState(
      mailbox.id,
      {
        uid_validity: opened.uidValidity,
        last_sync_uid: Math.max(highestUid, lastUid),
        total_messages: opened.exists,
        last_sync_at: ctx.now(),
        // 初回（lastUid = 0）も、今回取り込んだ時点の MODSEQ を起点にする
        highest_modseq: reconciledModseq ?? opened.highestModseq,
      },
      ctx.now(),
    )
    outcome.mailboxesSynced++
    logger.info(`Account ${account.email} mailbox ${mailbox.path} synced`, {
      accountId: account.id,
      newMessages: fetched,
      skippedOlder: skipped,
      exists: opened.exists,
    })
  }
  return outcome
}

const FLAG_KEYS = [
  ['seen', '\\Seen'],
  ['flagged', '\\Flagged'],
  ['answered', '\\Answered'],
] as const

/**
 * 取得済みメールのサーバー側の変更をローカルへ反映する。
 *  - フラグ: CONDSTORE 対応なら前回 MODSEQ 以降に変わったものだけ、非対応なら取得済み範囲のフラグを一括取得して比較
 *  - 削除: UID SEARCH でサーバーに残っている UID を調べ、無くなったものをローカルから消す
 */
export async function reconcileExisting(
  ctx: SyncContext,
  mailbox: MailboxRow,
  opened: { highestModseq: string | null },
  lastUid: number,
): Promise<{ flagChangedIds: string[]; removedIds: string[]; modseq: string | null }> {
  const { session, messageRepo, signal } = ctx
  const local = await messageRepo.flagStates(mailbox.id, lastUid)
  if (local.length === 0) return { flagChangedIds: [], removedIds: [], modseq: opened.highestModseq }
  const byUid = new Map(local.map((m) => [m.remote_uid, m]))

  // 1) 削除の検出
  const serverUids = new Set(await session.searchUidsFrom(1))
  const removed = local.filter((m) => !serverUids.has(m.remote_uid))
  const removedIds = removed.map((m) => m.id)
  if (removedIds.length > 0) await messageRepo.deleteByIds(removedIds)
  for (const m of removed) byUid.delete(m.remote_uid)

  // 2) フラグ変更の取り込み
  const flagChangedIds: string[] = []
  const prevModseq = mailbox.highest_modseq
  const unchanged = !!prevModseq && !!opened.highestModseq && prevModseq === opened.highestModseq
  if (!unchanged && byUid.size > 0) {
    const changedSince = prevModseq && opened.highestModseq ? prevModseq : null
    const minUid = Math.min(...byUid.keys())
    const updates: Array<{ id: string; seen: number; flagged: number; answered: number }> = []
    for await (const f of session.fetchFlags(minUid, lastUid, changedSince)) {
      if (signal.aborted) throw new AbortError()
      const row = byUid.get(f.uid)
      if (!row) continue
      const next = {
        id: row.id,
        seen: f.flags.has(FLAG_KEYS[0][1]) ? 1 : 0,
        flagged: f.flags.has(FLAG_KEYS[1][1]) ? 1 : 0,
        answered: f.flags.has(FLAG_KEYS[2][1]) ? 1 : 0,
      }
      if (next.seen !== row.seen || next.flagged !== row.flagged || next.answered !== row.answered)
        updates.push(next)
    }
    await messageRepo.applyFlagStates(updates, ctx.now())
    flagChangedIds.push(...updates.map((u) => u.id))
  }
  if (removedIds.length > 0 || flagChangedIds.length > 0)
    ctx.logger.info(`Account ${ctx.account.email} mailbox ${mailbox.path} reconciled`, {
      accountId: ctx.account.id,
      flagChanges: flagChangedIds.length,
      removed: removedIds.length,
      condstore: !!opened.highestModseq,
    })
  return { flagChangedIds, removedIds, modseq: opened.highestModseq }
}
