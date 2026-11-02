import type { AccountHealth, HealthIssue, HealthSeverity } from '@shared/types'
import type { AccountRepository } from '../db/account-repository'
import type { MessageRepository } from '../db/message-repository'
import type { AccountRow } from '../db/schema'

/** 連続失敗がこの回数以上なら critical */
export const REPEATED_FAILURE_THRESHOLD = 3

const SEVERITY_RANK: Record<HealthSeverity, number> = { critical: 0, warning: 1, info: 2 }

export interface HealthInput {
  account: AccountRow;
  forwardFailures: number;
  staleHours: number;
  now: number;
}

/** 1 アカウントの健全性を判定する（純粋関数。無効化されたアカウントは対象外） */
export function evaluateHealth(input: HealthInput): HealthIssue[] {
  const { account: a, forwardFailures, staleHours, now } = input
  if (a.enabled !== 1) return []
  const issues: HealthIssue[] = []
  const failures = Number(a.consecutive_failures ?? 0)

  if (a.auth_status === 'failed') issues.push({ reason: 'auth_failed', severity: 'critical' })
  else if (['auth_error', 'connection_error', 'error', 'sync_error'].includes(a.status))
    issues.push({
      reason: 'error_status',
      severity: a.status === 'sync_error' ? 'warning' : 'critical',
    })

  if (failures >= REPEATED_FAILURE_THRESHOLD)
    issues.push({ reason: 'repeated_failures', severity: 'critical', value: failures })

  if (a.auth_status === 'ok' && staleHours > 0) {
    if (!a.last_sync_at) {
      issues.push({ reason: 'never_synced', severity: 'info' })
    } else {
      const last = Date.parse(a.last_success_at ?? a.last_sync_at)
      const hours = Math.floor((now - last) / 3_600_000)
      if (Number.isFinite(hours) && hours >= staleHours)
        issues.push({ reason: 'stale', severity: 'warning', value: hours })
    }
  }

  if (a.status === 'untested') issues.push({ reason: 'untested', severity: 'info' })

  if (forwardFailures > 0)
    issues.push({ reason: 'forward_failures', severity: 'warning', value: forwardFailures })

  return issues
}

export function worstSeverity(issues: HealthIssue[]): HealthSeverity {
  return issues.reduce<HealthSeverity>(
    (w, i) => (SEVERITY_RANK[i.severity] < SEVERITY_RANK[w] ? i.severity : w),
    'info',
  )
}

/**
 * 健全性モニタ。300 アカウント規模で「どれに手を入れるべきか」を一覧にする。
 * critical: 認証失敗・エラー状態・連続失敗 / warning: 長期間未成功・転送失敗 / info: 未テスト・未同期
 */
export class HealthService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly messages: MessageRepository,
    private readonly staleHours: () => number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list(opts: { includeInfo?: boolean } = {}): Promise<AccountHealth[]> {
    const [rows, fwd] = await Promise.all([
      this.accounts.list({}),
      this.messages.forwardFailureCountsByAccount(),
    ])
    const now = this.now()
    const staleHours = this.staleHours()
    const out: AccountHealth[] = []
    for (const a of rows) {
      const issues = evaluateHealth({
        account: a,
        forwardFailures: fwd.get(a.id) ?? 0,
        staleHours,
        now,
      })
      if (issues.length === 0) continue
      const severity = worstSeverity(issues)
      if (severity === 'info' && !opts.includeInfo) continue
      out.push({
        accountId: a.id,
        email: a.email,
        groupId: a.group_id ?? null,
        status: a.status as AccountHealth['status'],
        severity,
        issues: issues.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]),
        lastError: a.last_error,
        lastSuccessAt: a.last_success_at,
        lastSyncAt: a.last_sync_at,
      })
    }
    return out.sort(
      (x, y) =>
        SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || x.email.localeCompare(y.email),
    )
  }

  /** critical / warning のアカウント数 */
  async countNeedsAttention(): Promise<number> {
    return (await this.list()).length
  }
}
