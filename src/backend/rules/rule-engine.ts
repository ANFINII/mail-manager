import type {
  ApplyRulesResult,
  ForwardRule,
  ForwardRuleField,
  ForwardRuleInput,
  RuleAction,
  RulePreview,
} from '@shared/types'
import type { AccountRepository } from '../db/account-repository'
import type { ForwardRuleRepository, ForwardRuleRow } from '../db/forward-rule-repository'
import type { MessageRepository } from '../db/message-repository'
import type { WebhookNotifier } from '../events/webhook'
import type { Logger } from '../logging/logger'
import { ruleQuery, type MessageService } from '../messages/message-service'

export const RULE_ACTIONS: readonly RuleAction[] = [
  'forward',
  'mark_read',
  'flag',
  'move',
  'delete',
  'webhook',
]
const FIELDS: readonly ForwardRuleField[] = ['any', 'subject', 'from', 'body']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface RuleEngineDeps {
  rules: ForwardRuleRepository;
  messages: MessageService;
  messageRepo: MessageRepository;
  accounts: AccountRepository;
  webhook: WebhookNotifier;
  logger: Logger;
  now?: () => string;
}

export function toForwardRule(r: ForwardRuleRow): ForwardRule {
  return {
    id: r.id,
    keyword: r.keyword,
    matchField: r.match_field as ForwardRuleField,
    to: r.to_address,
    enabled: r.enabled === 1,
    action: (r.action ?? 'forward') as RuleAction,
    groupId: r.group_id ?? null,
    applyExisting: (r.apply_existing ?? 1) === 1,
    createdAt: r.created_at,
  }
}

/** 入力を検証・正規化する（不正なら例外） */
export function normalizeRuleInput(p: ForwardRuleInput): Required<ForwardRuleInput> {
  const action = p.action ?? 'forward'
  if (!RULE_ACTIONS.includes(action)) throw new Error(`不明なアクションです: ${action}`)
  if (!FIELDS.includes(p.matchField)) throw new Error(`不明な照合対象です: ${p.matchField}`)
  const keyword = p.keyword.trim()
  if (!keyword) throw new Error('キーワードを入力してください')
  const to = (p.to ?? '').trim()
  if (action === 'forward' && !EMAIL_RE.test(to)) throw new Error('転送先メールアドレスが不正です')
  if (action === 'move' && !to) throw new Error('移動先フォルダを入力してください')
  if (action === 'webhook' && to && !/^https?:\/\//i.test(to))
    throw new Error('Webhook URL は http(s):// で始めてください')
  return {
    keyword,
    matchField: p.matchField,
    to,
    enabled: p.enabled,
    action,
    groupId: p.groupId || null,
    applyExisting: p.applyExisting ?? true,
  }
}

/**
 * 動的ルール。受信メールが条件に一致したとき、アクション（転送・既読・スター・移動・削除・Webhook）を実行する。
 *  - 転送は従来どおり転送ログで重複を防ぐ
 *  - それ以外は rule_hits に記録し、同じメールへ二度適用しない（ユーザーが未読に戻しても再び既読にしない）
 *  - 「既存メールにも適用」が OFF のルールは、ルール作成後に取り込んだメールだけが対象
 */
export class RuleEngine {
  private readonly log: Logger
  private readonly now: () => string
  private running: Promise<ApplyRulesResult> | null = null

  constructor(private readonly deps: RuleEngineDeps) {
    this.log = deps.logger.child('rules')
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async list(): Promise<ForwardRule[]> {
    return (await this.deps.rules.list()).map(toForwardRule)
  }

  async add(input: ForwardRuleInput): Promise<ForwardRule[]> {
    const p = normalizeRuleInput(input)
    await this.deps.rules.add(p, this.now())
    return this.list()
  }

  private async scopeAccountIds(groupId: string | null): Promise<string[] | undefined> {
    if (!groupId) return undefined
    const ids = await this.deps.accounts.listIdsByGroup(groupId)
    // グループが空（または削除済み）なら何にも一致させない
    return ids.length > 0 ? ids : ['__none__']
  }

  /** ルールを保存する前に、どのくらいのメールに一致し、今適用すると何件が対象になるかを返す */
  async preview(input: ForwardRuleInput): Promise<RulePreview> {
    const p = normalizeRuleInput(input)
    const query = ruleQuery(
      { keyword: p.keyword, match_field: p.matchField },
      await this.scopeAccountIds(p.groupId),
    )
    if (!query) return { matched: 0, wouldApply: 0, samples: [] }
    const ids = await this.deps.messageRepo.searchAllIds(query)
    let wouldApply: number
    if (!p.applyExisting) wouldApply = 0 // 保存後に届くメールだけが対象
    else if (p.action === 'forward')
      wouldApply = (await this.deps.messages.forwardCandidates(ids, p.to)).length
    else if (p.action === 'mark_read' || p.action === 'flag')
      wouldApply = (await this.filterByFlag(ids, p.action)).length
    else wouldApply = ids.length
    const { rows } = await this.deps.messageRepo.search({ ...query, page: 1, pageSize: 10 })
    return {
      matched: ids.length,
      wouldApply,
      samples: rows.map((r) => ({
        id: r.id,
        accountEmail: r.account_email,
        from: r.from_name || r.from_address,
        subject: r.subject,
        date: r.date,
      })),
    }
  }

  /** 既読化・スターは、すでにその状態のメールを除く */
  private async filterByFlag(ids: string[], action: 'mark_read' | 'flag'): Promise<string[]> {
    const rows = await this.deps.messageRepo.getRefsWithFlags(ids)
    return rows.filter((r) => (action === 'mark_read' ? r.seen === 0 : r.flagged === 0)).map((r) => r.id)
  }

  /** 有効なルールをすべて適用する。同時に呼ばれたら実行中の結果を共有する */
  apply(): Promise<ApplyRulesResult> {
    if (!this.running)
      this.running = this.applyAll().finally(() => {
        this.running = null
      })
    return this.running
  }

  private async applyAll(): Promise<ApplyRulesResult> {
    const rules = await this.deps.rules.listEnabled()
    let forwarded = 0
    let deferred = 0
    let actioned = 0
    for (const rule of rules) {
      try {
        const query = ruleQuery(rule, await this.scopeAccountIds(rule.group_id))
        if (!query) continue
        const action = (rule.action ?? 'forward') as RuleAction
        if (action === 'forward') {
          const r = await this.deps.messages.applyForwardRule(rule, query)
          forwarded += r.forwarded
          deferred += r.deferred
          continue
        }
        actioned += await this.applyAction(rule, action, query)
      } catch (err) {
        this.log.warn('Rule failed', {
          rule: rule.id,
          action: rule.action,
          error: this.deps.logger.scrubber.scrub(err instanceof Error ? err.message : String(err)),
        })
      }
    }
    return { rules: rules.length, forwarded, deferred, actioned }
  }

  private async applyAction(
    rule: ForwardRuleRow,
    action: Exclude<RuleAction, 'forward'>,
    query: NonNullable<ReturnType<typeof ruleQuery>>,
  ): Promise<number> {
    const matched = await this.deps.messageRepo.searchAllIds(query)
    const fresh = await this.deps.rules.filterNotHit(rule.id, matched)
    if (fresh.length === 0) return 0
    const targets =
      action === 'mark_read' || action === 'flag' ? await this.filterByFlag(fresh, action) : fresh
    // 履歴に「どのルールの操作か」を残し、ルール単位で取り消せるようにする
    const origin = { source: 'rule' as const, ruleId: rule.id, label: rule.keyword }
    switch (action) {
      case 'mark_read':
        if (targets.length) await this.deps.messages.setFlags(targets, { seen: true }, origin)
        break
      case 'flag':
        if (targets.length) await this.deps.messages.setFlags(targets, { flagged: true }, origin)
        break
      case 'delete':
        await this.deps.messages.delete(targets, origin)
        break
      case 'move':
        await this.deps.messages.move(targets, rule.to_address, { ...origin, label: `${rule.keyword} → ${rule.to_address}` })
        break
      case 'webhook': {
        const rows = await this.deps.messageRepo.getByIds(targets)
        for (const m of rows)
          this.deps.webhook.send(
            'RULE_MATCHED',
            {
              ruleId: rule.id,
              keyword: rule.keyword,
              messageId: m.id,
              accountEmail: m.account_email,
              from: m.from_address,
              subject: m.subject,
              date: m.date,
              snippet: m.snippet,
              // 認証コード・確認リンクを抽出できていれば添える（別システムへの自動入力用）
              code: m.otp_code ?? null,
              link: m.otp_link ?? null,
            },
            rule.to_address || undefined,
          )
        break
      }
    }
    // 削除・移動はローカル行が消えると rule_hits も外部キーで消えるが、処理中に再適用されないよう先に記録する
    await this.deps.rules.recordHits(rule.id, fresh, this.now())
    this.log.info('Rule applied', {
      rule: rule.id,
      action,
      keyword: rule.keyword,
      matched: matched.length,
      applied: targets.length,
    })
    return targets.length
  }
}
