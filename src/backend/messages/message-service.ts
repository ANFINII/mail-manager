import fs from 'node:fs'
import path from 'node:path'
import { simpleParser } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer'
import type {
  AddressInfo,
  AttachmentInfo,
  ForwardResult,
  JobInfo,
  MessageDetail,
  MessageSummary,
  SearchQuery,
} from '@shared/types'
import type { AccountRepository } from '../db/account-repository'
import type { ForwardRuleRepository } from '../db/forward-rule-repository'
import type { MailboxRepository } from '../db/mailbox-repository'
import type {
  MessageRef,
  MessageRepository,
  MessageWithContext,
  SentCopy,
} from '../db/message-repository'
import type { AccountRow, AttachmentRow } from '../db/schema'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'
import { MailError, type EmailProvider } from '../mail/email-provider'
import type { GraphSender } from '../mail/graph-sender'
import type { MailSession } from '../mail/mail-session'
import { buildSessionParams, type SessionAuthDeps } from '../mail/session-auth'
import type { OutgoingMessage, SmtpSender } from '../mail/smtp-sender'
import { JobTracker, type Job } from '../queue/job-tracker'
import { AbortError, TaskQueue } from '../queue/task-queue'
import { safeFilename } from '../sync/mailbox-sync'
import { stripHtml } from '../sync/message-parser'

export interface MessageServiceDeps {
  accountRepo: AccountRepository;
  mailboxRepo: MailboxRepository;
  messageRepo: MessageRepository;
  provider: EmailProvider;
  auth: SessionAuthDeps;
  events: EventBus;
  logger: Logger;
  attachmentsDir: string;
  smtp: SmtpSender;
  graph: GraphSender;
  ruleRepo: ForwardRuleRepository;
  /** 送信後に、その控えを取り込むためアカウントを同期するコールバック */
  onSent?: (accountId: string) => void;
  concurrency?: number;
  now?: () => string;
}

function parseAddresses(json: string): AddressInfo[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function toMessageSummary(row: MessageWithContext): MessageSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail: row.account_email,
    mailboxId: row.mailbox_id,
    mailboxPath: row.mailbox_path,
    remoteUid: row.remote_uid,
    messageId: row.message_id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddresses: parseAddresses(row.to_addresses),
    subject: row.subject,
    date: row.date,
    size: row.size,
    hasAttachments: row.has_attachments === 1,
    seen: row.seen === 1,
    flagged: row.flagged === 1,
    snippet: row.snippet,
    forwarded: (row.forward_count ?? 0) > 0,
  }
}

export function toAttachmentInfo(row: AttachmentRow): AttachmentInfo {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    partId: row.part_id,
    storagePath: row.storage_path,
  }
}

interface MailOp {
  kind: 'flags' | 'delete';
  seen?: boolean;
  flagged?: boolean;
}

/** 1 アカウントから同時に送る通数（Graph は 1 メールボックスあたり同時 4 リクエストまで、SMTP はプール 3 接続） */
const PER_ACCOUNT_SEND_CONCURRENCY = 3
/** 認証系エラーで送れなかった経路（Graph / SMTP）を、そのアカウントで再試行しない時間 */
const SEND_BLOCK_MS = 15 * 60_000
/** 手動操作（転送・削除・既読）は自動転送ルールより先に処理する */
const PRIORITY_MANUAL = 1

interface SendBlock {
  until: number;
  reason: string;
}

/** 1 アカウント分の転送で使い回す IMAP セッション（添付取得用） */
interface AttachmentFetchContext {
  session: MailSession | null;
  openedMailbox: string | null;
  /** 1 本の IMAP 接続でフォルダ選択と取得が混ざらないよう、添付取得は直列にする */
  lock: Promise<void>;
}

const forwardKey = (messageId: string, to: string): string => `${messageId}\u0000${to.toLowerCase()}`

async function serialized<T>(ctx: AttachmentFetchContext, fn: () => Promise<T>): Promise<T> {
  const prev = ctx.lock
  let release!: () => void
  ctx.lock = new Promise<void>((r) => (release = r))
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * メッセージの閲覧と一括操作（既読/未読、スター、削除）、添付ファイルの取得。
 * サーバー操作はアカウントごとに 1 セッションにまとめ、キューで同時実行数を制限する。
 */
export class MessageService {
  readonly queue: TaskQueue
  readonly tracker: JobTracker
  private readonly now: () => string
  private readonly log: Logger
  /** 送信中（まだ forwards に記録されていない）の message_id + 宛先。二重送信の防止用 */
  private readonly inFlightForwards = new Set<string>()
  private readonly graphBlocked = new Map<string, SendBlock>()
  private readonly smtpBlocked = new Map<string, SendBlock>()

  constructor(private readonly deps: MessageServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.log = deps.logger.child('mail')
    this.queue = new TaskQueue(deps.concurrency ?? 5)
    this.tracker = new JobTracker((job) => deps.events.emit({ type: 'job.updated', job }))
  }

  /**
   * 送信経路を選ぶ: Microsoft の OAuth2 は Graph API（SMTP AUTH 無効でも送れる）、それ以外は SMTP。
   * 権限不足などの認証エラーで使えなかった経路はアカウントごとに SEND_BLOCK_MS の間記憶し、
   * 同じ失敗を 1 通ごとに繰り返さない（手動の転送・送信はこの記憶を消してから再試行する）。
   */
  private async submit(
    account: AccountRow,
    message: OutgoingMessage,
    signal?: AbortSignal,
  ): Promise<string> {
    const now = Date.now()
    const scrub = (err: unknown) =>
      this.deps.logger.scrubber.scrub(err instanceof Error ? err.message : String(err))
    const isAuth = (err: unknown) => (err as { kind?: string } | null)?.kind === 'auth'
    if (this.deps.graph.canSend(account) && !this.activeBlock(this.graphBlocked, account.id, now)) {
      try {
        return await this.deps.graph.send(account, message, signal)
      } catch (err) {
        if (err instanceof AbortError || signal?.aborted) throw err
        if (isAuth(err)) {
          // Mail.Send 未同意など。しばらく Graph を試さず SMTP に直行する
          this.graphBlocked.set(account.id, { until: now + SEND_BLOCK_MS, reason: scrub(err) })
          this.log.warn(
            `Graph send unavailable for ${account.email}; using SMTP for ${SEND_BLOCK_MS / 60_000} min`,
            { accountId: account.id, error: scrub(err) },
          )
        } else {
          this.log.warn(`Graph send failed, falling back to SMTP for ${account.email}`, {
            accountId: account.id,
            error: scrub(err),
          })
        }
      }
    }
    const smtpBlock = this.activeBlock(this.smtpBlocked, account.id, now)
    if (smtpBlock) {
      const minutes = Math.max(1, Math.ceil((smtpBlock.until - now) / 60_000))
      throw new MailError(
        `送信を見送りました（直前の認証エラー: ${smtpBlock.reason}）。約 ${minutes} 分後に再試行します`,
        'auth',
      )
    }
    try {
      return await this.deps.smtp.send(account, message, signal)
    } catch (err) {
      if (isAuth(err) && !(err instanceof AbortError))
        this.smtpBlocked.set(account.id, { until: now + SEND_BLOCK_MS, reason: scrub(err) })
      throw err
    }
  }

  private activeBlock(map: Map<string, SendBlock>, accountId: string, now: number): SendBlock | null {
    const block = map.get(accountId)
    if (!block) return null
    if (block.until <= now) {
      map.delete(accountId)
      return null
    }
    return block
  }

  /** 手動の送信・転送は明示的な再試行なので、送信不可の記憶を消す */
  private clearSendBlocks(accountId: string): void {
    this.graphBlocked.delete(accountId)
    this.smtpBlocked.delete(accountId)
  }

  async get(id: string): Promise<MessageDetail | null> {
    const row = await this.deps.messageRepo.getById(id)
    if (!row) return null
    const attachments = await this.deps.messageRepo.listAttachments(id)
    return {
      ...toMessageSummary(row),
      ccAddresses: parseAddresses(row.cc_addresses),
      inReplyTo: row.in_reply_to,
      textBody: row.text_body,
      htmlBody: row.html_body,
      attachments: attachments.map(toAttachmentInfo),
      forwards: await this.deps.messageRepo.listForwards(id),
    }
  }

  async setFlags(ids: string[], patch: { seen?: boolean; flagged?: boolean }): Promise<JobInfo> {
    return this.runOperation(ids, { kind: 'flags', ...patch })
  }

  async delete(ids: string[]): Promise<JobInfo> {
    return this.runOperation(ids, { kind: 'delete' })
  }

  /** 送信済みフォルダの重複した転送控えを数える（削除はしない） */
  async duplicateSentCopies(
    accountIds?: string[],
  ): Promise<import('@shared/types').DuplicateSentCopies> {
    const r = await this.deps.messageRepo.findDuplicateSentCopies(accountIds)
    return { groups: r.groups, extra: r.ids.length, accounts: r.accounts, sampleSubjects: r.sampleSubjects }
  }

  /** 重複した転送控えを、各グループの最古の 1 通を残して削除する（サーバーではゴミ箱へ移動） */
  async deleteDuplicateSentCopies(
    accountIds?: string[],
  ): Promise<{ job: JobInfo | null; count: number }> {
    const r = await this.deps.messageRepo.findDuplicateSentCopies(accountIds)
    if (r.ids.length === 0) return { job: null, count: 0 }
    this.log.info('Deleting duplicate Sent copies', {
      count: r.ids.length,
      groups: r.groups,
      accounts: r.accounts,
    })
    const job = await this.runOperation(r.ids, { kind: 'delete' })
    return { job, count: r.ids.length }
  }

  /** 選択したメールを指定アドレスへ転送する。送信は各メールの受信アカウントから行う。 */
  /** 選択したメールを転送する（転送済みは自動でスキップ） */
  async forward(ids: string[], to: string): Promise<ForwardResult> {
    return this.runForward([...new Set(ids)], to, { manual: true })
  }

  /** 新規メールを送信する。SMTP で送り、送信控えを Sent フォルダにも保存する。 */
  async send(
    accountId: string,
    to: string,
    subject: string,
    text: string,
  ): Promise<import('@shared/types').SendResult> {
    const dest = to.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) throw new Error('宛先メールアドレスが不正です')
    const account = await this.deps.accountRepo.getById(accountId)
    if (!account) throw new Error('アカウントが見つかりません')
    this.clearSendBlocks(accountId)
    const viaGraph = this.deps.graph.canSend(account)
    let messageId: string
    try {
      messageId = await this.submit(account, { to: dest, subject, text })
    } catch (err) {
      const reason = this.deps.logger.scrubber.scrub(
        err instanceof Error ? err.message : String(err),
      )
      this.log.error(`Failed to send message from ${account.email}`, {
        accountId,
        to: dest,
        error: reason,
      })
      throw err
    }

    // Graph 送信は saveToSentItems で控えを自動保存するため IMAP APPEND は不要
    let savedToSent = viaGraph
    if (!viaGraph)
      try {
        const raw: Buffer = await new Promise((resolve, reject) => {
          new MailComposer({ from: account.email, to: dest, subject, text, messageId })
            .compile()
            .build((err, msg) => (err ? reject(err) : resolve(msg)))
        })
        const session = await this.deps.provider.openSession(
          await buildSessionParams(account, this.deps.auth),
        )
        try {
          const mailboxes = await session.listMailboxes()
          const sent =
            mailboxes.find((m) => m.specialUse === '\\Sent') ??
            mailboxes.find((m) => /^sent/i.test(m.path))
          if (sent) {
            await session.append(sent.path, raw, ['\\Seen'])
            savedToSent = true
          }
        } finally {
          await session.close().catch(() => undefined)
        }
      } catch (err) {
        this.log.warn(`Sent copy not saved for ${account.email}`, {
          accountId,
          error: this.deps.logger.scrubber.scrub(err instanceof Error ? err.message : String(err)),
        })
      }
    this.log.info(`Sent message from ${account.email}`, { accountId, to: dest, savedToSent })
    if (savedToSent) this.deps.onSent?.(accountId)
    return { messageId, savedToSent }
  }

  /** 検索条件に一致する全メールを転送する（転送済みは自動でスキップ） */
  async forwardAll(query: SearchQuery, to: string): Promise<ForwardResult> {
    const dest = this.validateDest(to)
    // 全件転送は受信メールだけ。送信済みフォルダの転送控えを二重に送らない
    const ids = await this.deps.messageRepo.searchAllIds({ ...query, receivedOnly: true })
    return this.runForward(ids, dest, { manual: true })
  }

  /**
   * 自動転送ルールを適用する。各ルールのキーワードに一致し、まだ転送先へ送っていないメールを転送する。
   * 直前に失敗したメールはバックオフ（5分 → 10分 → … 最大 24 時間）が明けるまで再試行しない。
   */
  async applyRules(): Promise<import('@shared/types').ApplyRulesResult> {
    const rules = await this.deps.ruleRepo.listEnabled()
    let forwarded = 0
    let deferred = 0
    for (const rule of rules) {
      const kw = rule.keyword.trim()
      if (!kw) continue
      // 自分の転送控え（送信済みの Fwd:）にキーワードが一致して再転送し続けないよう、受信メールだけを対象にする
      const query: SearchQuery = { page: 1, pageSize: 500, receivedOnly: true }
      if (rule.match_field === 'subject') query.subject = kw
      else if (rule.match_field === 'from') query.from = kw
      else query.text = kw // 'body' / 'any' は全文検索
      const ids = await this.deps.messageRepo.searchAllIds(query)
      if (ids.length === 0) continue
      const retryable = await this.deps.messageRepo.filterRetryable(ids, rule.to_address, this.now())
      const waiting = ids.length - retryable.length
      deferred += waiting
      if (retryable.length === 0) continue
      try {
        const res = await this.runForward(retryable, rule.to_address, { manual: false })
        forwarded += res.queued
        if (res.queued > 0 || res.skipped > 0)
          this.log.info('Auto-forward rule applied', {
            rule: rule.id,
            keyword: kw,
            field: rule.match_field,
            to: rule.to_address,
            queued: res.queued,
            skipped: res.skipped,
            deferred: waiting,
          })
      } catch (err) {
        this.log.warn('Auto-forward rule failed', {
          rule: rule.id,
          error: this.deps.logger.scrubber.scrub(err instanceof Error ? err.message : String(err)),
        })
      }
    }
    return { rules: rules.length, forwarded, deferred }
  }

  private validateDest(to: string): string {
    const dest = to.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) throw new Error('転送先メールアドレスが不正です')
    return dest
  }

  private async runForward(
    requestedIds: string[],
    to: string,
    opts: { manual: boolean } = { manual: true },
  ): Promise<ForwardResult> {
    const dest = this.validateDest(to)
    // 同じ宛先へ転送済み、または今まさに送信中のメールは除外する（重複送信の防止）
    const notForwarded = await this.deps.messageRepo.filterNotForwarded(requestedIds, dest)
    const toSend = notForwarded.filter((id) => !this.inFlightForwards.has(forwardKey(id, dest)))
    // DB 読み込みを待つ前に予約する（同時に呼ばれた転送が同じメールを二重に積まないように）
    for (const id of toSend) this.inFlightForwards.add(forwardKey(id, dest))
    const loaded = await this.deps.messageRepo.getByIds(toSend)
    const found = new Set(loaded.map((m) => m.id))
    for (const id of toSend) if (!found.has(id)) this.inFlightForwards.delete(forwardKey(id, dest))
    // 自動転送では、自分が送った転送控え（差出人が自分で件名が Fwd:）は対象にしない（転送ループ防止）
    const ownCopies = opts.manual
      ? []
      : loaded.filter(
          (m) =>
            (m.from_address ?? '').toLowerCase() === m.account_email.toLowerCase() &&
            isOwnForwardSubject(m.subject),
        )
    for (const m of ownCopies) this.inFlightForwards.delete(forwardKey(m.id, dest))
    const candidates = loaded.filter((m) => !ownCopies.includes(m))
    // 行 ID では未転送でも、恒久ログや送信済みフォルダの控えで転送済みと分かるものは除く
    const { send: messages, alreadySent } = await this.dropAlreadyForwarded(candidates, dest)
    for (const m of alreadySent) this.inFlightForwards.delete(forwardKey(m.id, dest))
    const skipped = requestedIds.length - messages.length
    const job = this.tracker.create(
      'mail_op',
      messages.map((m) => m.id),
    )
    // アカウントごとにまとめて、添付取得の IMAP 接続と送信接続を使い回す。
    // 並列はアカウント単位（1 アカウントの大量転送が全スロットを占有しない）。
    const byAccount = new Map<string, MessageWithContext[]>()
    for (const m of messages)
      byAccount.set(m.account_id, [...(byAccount.get(m.account_id) ?? []), m])
    if (opts.manual) for (const accountId of byAccount.keys()) this.clearSendBlocks(accountId)
    this.log.info('Forward started', {
      jobId: job.info.id,
      requested: requestedIds.length,
      queued: messages.length,
      skipped,
      accounts: byAccount.size,
      to: dest,
      manual: opts.manual,
    })
    for (const [accountId, list] of byAccount) {
      this.queue
        .add(() => this.forwardAccountBatch(job, accountId, list, dest), {
          signal: job.controller.signal,
          priority: opts.manual ? PRIORITY_MANUAL : 0,
        })
        .catch((err) => {
          const outcome = err instanceof AbortError ? 'cancelled' : 'failed'
          for (const m of list) {
            this.inFlightForwards.delete(forwardKey(m.id, dest))
            this.tracker.complete(job, m.id, outcome)
          }
        })
    }
    return { job: { ...job.info }, queued: messages.length, skipped }
  }

  /**
   * 行 ID の照合では未転送でも、実際には転送済みのメールを除く。
   * (1) 恒久ログ forward_log（Message-ID 単位）に残っているもの
   * (2) そのアカウントの送信済みフォルダに、同じ宛先への控え（本文に元メールの Message-ID または Date+Subject を含む）があるもの
   * 見つかったものは forwards / forward_log に記録し、以後は行 ID の照合だけで除外できるようにする。
   */
  private async dropAlreadyForwarded(
    rows: MessageWithContext[],
    dest: string,
  ): Promise<{ send: MessageWithContext[]; alreadySent: MessageWithContext[] }> {
    if (rows.length === 0) return { send: [], alreadySent: [] }
    const alreadySent: MessageWithContext[] = []
    const now = this.now()
    const logged = new Set((await this.deps.messageRepo.forwardLogHits(rows, dest)).map((m) => m.id))
    for (const m of rows) {
      if (!logged.has(m.id)) continue
      alreadySent.push(m)
      await this.deps.messageRepo.recordForward(m.id, dest, now)
    }
    const remaining = rows.filter((m) => !logged.has(m.id))
    const byAccount = new Map<string, MessageWithContext[]>()
    for (const m of remaining)
      byAccount.set(m.account_id, [...(byAccount.get(m.account_id) ?? []), m])
    const send: MessageWithContext[] = []
    for (const [accountId, list] of byAccount) {
      const copies = await this.deps.messageRepo.findSentCopies(accountId, dest)
      for (const m of list) {
        const copy = copies.length > 0 ? findSentCopyOf(m, copies) : undefined
        if (copy) {
          alreadySent.push(m)
          await this.deps.messageRepo.markForwarded(m, dest, copy.date ?? now)
        } else send.push(m)
      }
    }
    if (alreadySent.length > 0)
      this.log.info('Skipped messages already forwarded (log / Sent copy)', {
        to: dest,
        skipped: alreadySent.length,
        viaLog: logged.size,
      })
    return { send, alreadySent }
  }

  /** 1 アカウント分の転送。添付取得の IMAP セッションを使い回し、同時 PER_ACCOUNT_SEND_CONCURRENCY 通まで送る。 */
  private async forwardAccountBatch(
    job: Job,
    accountId: string,
    messages: MessageWithContext[],
    to: string,
  ): Promise<void> {
    const account = await this.deps.accountRepo.getById(accountId)
    if (!account) {
      for (const m of messages) {
        this.inFlightForwards.delete(forwardKey(m.id, to))
        this.tracker.complete(job, m.id, 'failed')
      }
      return
    }
    const ctx: AttachmentFetchContext = { session: null, openedMailbox: null, lock: Promise.resolve() }
    const getSession = async (): Promise<MailSession> => {
      if (!ctx.session) {
        ctx.session = await this.deps.provider.openSession(
          await buildSessionParams(account, this.deps.auth, job.controller.signal),
          job.controller.signal,
        )
        ctx.openedMailbox = null
      }
      return ctx.session
    }
    try {
      await runWithConcurrency(messages, PER_ACCOUNT_SEND_CONCURRENCY, async (msg) => {
        if (job.controller.signal.aborted) {
          this.inFlightForwards.delete(forwardKey(msg.id, to))
          this.tracker.complete(job, msg.id, 'cancelled')
          return
        }
        await this.forwardOne(job, account, msg, to, getSession, ctx)
      })
    } finally {
      if (ctx.session) await ctx.session.close().catch(() => undefined)
    }
  }

  private async forwardOne(
    job: Job,
    account: AccountRow,
    msg: MessageWithContext,
    to: string,
    getSession: () => Promise<MailSession>,
    ctx: AttachmentFetchContext,
  ): Promise<void> {
    try {
      const files = await this.collectAttachmentFiles(msg, getSession, ctx)
      const origFrom = msg.from_name
        ? `${msg.from_name} <${msg.from_address ?? ''}>`
        : (msg.from_address ?? '')
      // Date / Message-ID は送信済みフォルダの控えから「転送済み」を判定するためのマーカーにもなる
      const header =
        '\n\n---------- 転送メッセージ ----------\n' +
        `From: ${origFrom}\nDate: ${msg.date ?? ''}\nSubject: ${msg.subject}\nTo: ${msg.account_email}\n` +
        `Message-ID: ${msg.message_id ?? ''}\n\n`
      await this.submit(
        account,
        {
          to,
          subject: /^fwd:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`,
          text:
            (msg.text_body ?? (msg.html_body ? stripHtml(msg.html_body) : msg.snippet)) + header,
          html: msg.html_body
            ? `<div>${escapeHtml(msg.snippet)}</div><hr><p>---------- 転送メッセージ ----------<br>From: ${escapeHtml(origFrom)}<br>Date: ${escapeHtml(msg.date ?? '')}<br>Subject: ${escapeHtml(msg.subject)}<br>Message-ID: ${escapeHtml(msg.message_id ?? '')}</p>${msg.html_body}`
            : undefined,
          attachments: files,
        },
        job.controller.signal,
      )
      await this.deps.messageRepo.markForwarded(msg, to, this.now())
      this.log.info(`Forwarded message from ${account.email}`, {
        accountId: account.id,
        messageId: msg.id,
        to,
      })
      this.tracker.complete(job, msg.id, 'succeeded')
    } catch (err) {
      if (err instanceof AbortError || job.controller.signal.aborted) {
        this.tracker.complete(job, msg.id, 'cancelled')
        return
      }
      const reason = this.deps.logger.scrubber.scrub(
        err instanceof Error ? err.message : String(err),
      )
      const attempt = await this.deps.messageRepo
        .recordForwardFailure(msg.id, to, reason, this.now())
        .catch(() => null)
      this.log.error(`Failed to forward message from ${account.email}`, {
        accountId: account.id,
        messageId: msg.id,
        to,
        error: reason,
        attempts: attempt?.attempts,
        nextRetryAt: attempt?.nextRetryAt,
      })
      this.tracker.complete(job, msg.id, 'failed')
    } finally {
      this.inFlightForwards.delete(forwardKey(msg.id, to))
    }
  }

  /** 転送に添える添付ファイルを集める。未保存のものは共有 IMAP セッションで取得する（1 接続なので直列） */
  private async collectAttachmentFiles(
    msg: MessageWithContext,
    getSession: () => Promise<MailSession>,
    ctx: AttachmentFetchContext,
  ): Promise<Array<{ filename: string; content: Buffer; contentType?: string }>> {
    const attachments = await this.deps.messageRepo.listAttachments(msg.id)
    const files: Array<{ filename: string; content: Buffer; contentType?: string }> = []
    for (const att of attachments) {
      const stored = att.storage_path && fs.existsSync(att.storage_path) ? att.storage_path : null
      const file =
        stored ??
        (await serialized(ctx, async () =>
          this.fetchAttachmentFile(att, msg, await getSession(), ctx),
        ))
      files.push({ filename: att.filename, content: fs.readFileSync(file), contentType: att.content_type })
    }
    return files
  }

  listJobs(): JobInfo[] {
    return this.tracker.list()
  }

  /** 削除・フラグ変更で同時に開く IMAP セッション数（同期と同じ設定値を使う） */
  setConcurrency(n: number): void {
    this.queue.concurrency = n
  }

  cancelAll(): number {
    const n = this.tracker.cancelAll()
    this.queue.clear()
    return n
  }

  dispose(): void {
    this.cancelAll()
    this.deps.smtp.dispose()
  }

  private async runOperation(ids: string[], op: MailOp): Promise<JobInfo> {
    // 本文は不要なので軽い参照だけ読む（数万件の削除でもメモリを使わない）
    const rows = await this.deps.messageRepo.getRefsByIds([...new Set(ids)])
    const byAccount = new Map<string, MessageRef[]>()
    for (const r of rows) {
      const list = byAccount.get(r.account_id) ?? []
      list.push(r)
      byAccount.set(r.account_id, list)
    }
    const job = this.tracker.create('mail_op', [...byAccount.keys()])
    this.log.info('Mail operation started', {
      jobId: job.info.id,
      op: op.kind,
      messages: rows.length,
      accounts: byAccount.size,
    })
    for (const [accountId, messages] of byAccount) {
      this.queue
        .add(() => this.runForAccount(job, accountId, messages, op), {
          signal: job.controller.signal,
          priority: PRIORITY_MANUAL,
        })
        .catch((err) => {
          this.tracker.complete(job, accountId, err instanceof AbortError ? 'cancelled' : 'failed')
        })
    }
    return { ...job.info }
  }

  private async runForAccount(
    job: Job,
    accountId: string,
    messages: MessageRef[],
    op: MailOp,
  ): Promise<void> {
    const account = await this.deps.accountRepo.getById(accountId)
    if (!account) {
      this.tracker.complete(job, accountId, 'failed')
      return
    }
    let session: MailSession | null = null
    try {
      session = await this.deps.provider.openSession(
        await buildSessionParams(account, this.deps.auth, job.controller.signal),
        job.controller.signal,
      )
      const byMailbox = new Map<string, MessageRef[]>()
      for (const m of messages)
        byMailbox.set(m.mailbox_path, [...(byMailbox.get(m.mailbox_path) ?? []), m])
      const trash = await this.deps.mailboxRepo.findTrash(accountId)
      for (const [mailboxPath, list] of byMailbox) {
        await session.openMailbox(mailboxPath, false)
        const uids = list.map((m) => m.remote_uid)
        if (op.kind === 'flags') {
          if (op.seen === true) await session.addFlags(uids, ['\\Seen'])
          if (op.seen === false) await session.removeFlags(uids, ['\\Seen'])
          if (op.flagged === true) await session.addFlags(uids, ['\\Flagged'])
          if (op.flagged === false) await session.removeFlags(uids, ['\\Flagged'])
          await this.deps.messageRepo.updateFlags(
            list.map((m) => m.id),
            { seen: op.seen, flagged: op.flagged },
            this.now(),
          )
          this.deps.events.emit({ type: 'messages.changed', ids: list.map((m) => m.id) })
        } else {
          if (trash && trash.path !== mailboxPath) await session.moveTo(uids, trash.path)
          else await session.deleteMessages(uids)
          await this.deps.messageRepo.deleteByIds(list.map((m) => m.id))
          this.deps.events.emit({
            type: 'messages.changed',
            ids: list.map((m) => m.id),
            deleted: true,
          })
        }
      }
      const count = await this.deps.messageRepo.countByAccount(accountId)
      await this.deps.accountRepo.updateStatus(
        accountId,
        { message_count: count } as never,
        this.now(),
      )
      this.log.info(`Account ${account.email} mail operation completed`, {
        accountId,
        op: op.kind,
        messages: messages.length,
      })
      this.tracker.complete(job, accountId, 'succeeded')
    } catch (err) {
      if (err instanceof AbortError) {
        this.tracker.complete(job, accountId, 'cancelled')
        return
      }
      this.log.error(`Account ${account.email} mail operation failed`, {
        accountId,
        op: op.kind,
        error: this.deps.logger.scrubber.scrub(err instanceof Error ? err.message : String(err)),
      })
      this.tracker.complete(job, accountId, 'failed')
    } finally {
      if (session) await session.close().catch(() => undefined)
    }
  }

  /** 添付ファイルを IMAP から取得してローカルに保存し、そのパスを返す */
  async downloadAttachment(attachmentId: string): Promise<AttachmentInfo> {
    const att = await this.deps.messageRepo.getAttachment(attachmentId)
    if (!att) throw new Error('Attachment not found')
    if (att.storage_path && fs.existsSync(att.storage_path)) return toAttachmentInfo(att)
    const message = await this.deps.messageRepo.getById(att.message_id)
    if (!message) throw new Error('Message not found')
    const account = await this.deps.accountRepo.getById(message.account_id)
    if (!account) throw new Error('Account not found')
    const session = await this.deps.provider.openSession(
      await buildSessionParams(account, this.deps.auth),
    )
    const ctx: AttachmentFetchContext = { session, openedMailbox: null, lock: Promise.resolve() }
    try {
      const target = await this.fetchAttachmentFile(att, message, session, ctx)
      return toAttachmentInfo({ ...att, storage_path: target })
    } finally {
      await session.close().catch(() => undefined)
    }
  }

  /** 開いている IMAP セッションで添付 1 件を取得して保存し、保存先パスを返す（フォルダは同じなら選び直さない） */
  private async fetchAttachmentFile(
    att: AttachmentRow,
    message: MessageWithContext,
    session: MailSession,
    ctx: AttachmentFetchContext,
  ): Promise<string> {
    const dir = path.join(this.deps.attachmentsDir, message.id)
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, safeFilename(att.filename))
    if (ctx.openedMailbox !== message.mailbox_path) {
      await session.openMailbox(message.mailbox_path, true)
      ctx.openedMailbox = message.mailbox_path
    }
    let content: Buffer | null = null
    if (att.part_id) {
      content = (await session.downloadPart(message.remote_uid, att.part_id)).content
    } else {
      for await (const m of session.fetch([message.remote_uid], {
        source: true,
        structure: false,
      })) {
        if (!m.source) continue
        const parsed = await simpleParser(m.source)
        const all = await this.deps.messageRepo.listAttachments(message.id)
        const idx = all.findIndex((a) => a.id === att.id)
        const candidate =
          parsed.attachments.find((a) => a.filename === att.filename) ?? parsed.attachments[idx]
        if (candidate) content = candidate.content
      }
    }
    if (!content) throw new Error('Attachment content not available')
    fs.writeFileSync(target, content, { mode: 0o600 })
    await this.deps.messageRepo.setAttachmentStorage(att.id, target)
    this.log.info('Attachment downloaded', {
      attachmentId: att.id,
      messageId: message.id,
      bytes: fs.statSync(target).size,
    })
    return target
  }
}

/**
 * 送信済みフォルダの控えのうち、元メール m の転送と判定できるものを返す。
 * 本文（text/html）に「Message-ID: <元の ID>」か「Date: <元の日時>」+「Subject: <元の件名>」の両方が含まれ、
 * 控えの日時が元メール以降であること。件名だけの一致では判定しない（同じ件名の別メールを取り違えないため）。
 */
function findSentCopyOf(m: MessageWithContext, copies: SentCopy[]): SentCopy | undefined {
  const mid = (m.message_id ?? '').trim()
  const midMarkers = mid ? [`Message-ID: ${mid}`, `Message-ID: ${escapeHtml(mid)}`] : []
  const dateMarkers = m.date ? [`Date: ${m.date}`] : []
  const subjectMarkers = [`Subject: ${m.subject}`, `Subject: ${escapeHtml(m.subject)}`]
  return copies.find((c) => {
    if (c.date && m.date && c.date < m.date) return false
    const body = `${c.text_body ?? ''}\n${c.html_body ?? ''}`
    if (midMarkers.some((k) => body.includes(k))) return true
    return (
      dateMarkers.some((k) => body.includes(k)) && subjectMarkers.some((k) => body.includes(k))
    )
  })
}

/** 件名が転送メール（Fwd: / FW: / 転送:）か */
function isOwnForwardSubject(subject: string): boolean {
  return /^\s*(fwd?|転送)\s*:/i.test(subject)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
