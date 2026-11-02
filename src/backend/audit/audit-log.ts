import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { sql, type Kysely } from 'kysely'
import type { RpcMethod, RpcMethods } from '@shared/api'
import type { AuditEntry, AuditQuery } from '@shared/types'
import type { Database } from '../db/schema'

const KEEP_DAYS = 365

type Summary = { target?: string; detail?: Record<string, unknown> }
type Summarizer<M extends RpcMethod> = (
  params: RpcMethods[M]['params'],
  result: RpcMethods[M]['result'],
) => Summary

/**
 * 監査ログに残す操作と、その要約（秘密値は絶対に入れない: パスワード・トークン・本文は記録しない）。
 * ここに無い操作（一覧・検索・閲覧など）は記録しない。
 */
export const AUDITED: { [M in RpcMethod]?: Summarizer<M> } = {
  'accounts.importCsv': (p, r) => ({ target: fileName(p.path), detail: { imported: r.imported, updated: r.updated, invalid: r.invalid.length, updateExisting: !!p.updateExisting } }),
  'accounts.delete': (p, r) => ({ detail: { accounts: p.ids.length, deleted: r.deleted } }),
  'accounts.setEnabled': (p) => ({ detail: { accounts: p.ids.length, enabled: p.enabled } }),
  'accounts.updateCredentials': (p) => ({ target: p.id, detail: { authType: p.update.authType ?? null } }),
  'accounts.exportCsvWithCredentials': (p, r) => ({ target: fileName(p.path), detail: { count: r.count, selected: p.accountIds?.length ?? null } }),
  'accounts.exportCsv': (p, r) => ({ target: fileName(p.path), detail: { count: r.count } }),
  'accounts.setFetchVia': (p, r) => ({ target: p.via, detail: { ...r } }),
  'accounts.setGroup': (p) => ({ detail: { accounts: p.ids.length, groupId: p.groupId } }),
  'groups.create': (p) => ({ target: p.name }),
  'groups.rename': (p) => ({ target: p.name, detail: { id: p.id } }),
  'groups.remove': (p) => ({ target: p.id }),
  'oauth.start': (p) => ({ target: p.email || p.accountId || p.provider, detail: { provider: p.provider, reauth: !!p.accountId } }),
  'settings.update': (p) => ({ detail: { keys: Object.keys(p).sort() } }),
  'forwardRules.add': (p) => ({ target: p.keyword, detail: { action: p.action ?? 'forward', field: p.matchField, to: p.to, groupId: p.groupId ?? null } }),
  'forwardRules.remove': (p) => ({ target: p.id }),
  'forwardRules.setEnabled': (p) => ({ target: p.id, detail: { enabled: p.enabled } }),
  'messages.delete': (p) => ({ detail: { messages: p.ids.length } }),
  'messages.move': (p) => ({ target: p.destination, detail: { messages: p.ids.length } }),
  'messages.forward': (p, r) => ({ target: p.to, detail: { requested: p.ids.length, queued: r.queued } }),
  'messages.forwardAll': (p, r) => ({ target: p.to, detail: { queued: r.queued, skipped: r.skipped } }),
  'messages.send': (p) => ({ target: p.to, detail: { accountId: p.accountId } }),
  'messages.reply': (p) => ({ target: p.id, detail: { replyAll: !!p.replyAll } }),
  'search.exportCsv': (p, r) => ({ target: fileName(p.path), detail: { count: r.count } }),
  'history.undo': (p, r) => ({ target: p.id, detail: { ...r } }),
  'app.backup': (p, r) => ({ target: fileName(p.path), detail: { bytes: r.bytes } }),
  'app.restore': (p) => ({ target: fileName(p.path) }),
  'storage.cleanup': (p, r) => (p?.dryRun ? {} : { detail: { ...r } }),
  'storage.vacuum': () => ({}),
  'report.send': (_p, r) => ({ detail: { ...r } }),
  'templates.save': (p) => ({ target: p.name }),
  'templates.remove': (p) => ({ target: p.id }),
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/**
 * 監査ログ: 誰が・いつ・どの重要な操作をしたか（成功・失敗とも）。1 年で消す。
 * actor は OS のユーザー名（複数人で同じ PC / 共有サーバーを使う場合の手がかり）。
 */
export class AuditLog {
  private readonly actor: string

  constructor(
    private readonly db: Kysely<Database>,
    actor?: string,
  ) {
    let user = actor
    if (!user)
      try {
        user = os.userInfo().username
      } catch {
        user = 'unknown'
      }
    this.actor = user
  }

  shouldRecord(method: string): boolean {
    return method in AUDITED
  }

  async recordCall(method: RpcMethod, params: unknown, result: unknown, error: unknown | null): Promise<void> {
    if (method === 'storage.cleanup' && (params as { dryRun?: boolean } | undefined)?.dryRun) return
    const summarize = AUDITED[method] as Summarizer<RpcMethod> | undefined
    if (!summarize) return
    let summary: Summary
    try {
      // 失敗時は結果が無いので、要約関数が結果を参照して落ちたら対象・内容なしで記録する
      summary = error ? summarize(params as never, {} as never) : summarize(params as never, result as never)
    } catch {
      summary = {}
    }
    await this.record({
      action: method,
      target: summary.target ?? null,
      detail: summary.detail ?? null,
      ok: !error,
      error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 300) : null,
    })
  }

  async record(e: { action: string; target?: string | null; detail?: Record<string, unknown> | null; ok?: boolean; error?: string | null; actor?: string }): Promise<void> {
    const now = new Date().toISOString()
    await this.db
      .insertInto('audit_log')
      .values({
        id: randomUUID(),
        at: now,
        actor: e.actor ?? this.actor,
        action: e.action,
        target: e.target ?? null,
        detail: e.detail ? JSON.stringify(e.detail) : null,
        ok: e.ok === false ? 0 : 1,
        error: e.error ?? null,
      })
      .execute()
  }

  async list(q: AuditQuery = {}): Promise<AuditEntry[]> {
    let query = this.db.selectFrom('audit_log').selectAll()
    if (q.action) query = query.where('action', '=', q.action)
    if (q.failedOnly) query = query.where('ok', '=', 0)
    if (q.text?.trim()) {
      const like = `%${q.text.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
      query = query.where((eb) =>
        eb.or([
          eb(sql`lower(action)`, 'like', like),
          eb(sql`lower(coalesce(target, ''))`, 'like', like),
          eb(sql`lower(coalesce(detail, ''))`, 'like', like),
          eb(sql`lower(actor)`, 'like', like),
        ]),
      )
    }
    const rows = await query
      .orderBy('at', 'desc')
      .limit(Math.min(2000, Math.max(1, q.limit ?? 500)))
      .execute()
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      target: r.target,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
      ok: r.ok === 1,
      error: r.error,
    }))
  }

  async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()
    await this.db.deleteFrom('audit_log').where('at', '<', cutoff).execute()
  }
}
