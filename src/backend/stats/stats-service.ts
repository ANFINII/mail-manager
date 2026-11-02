import type { DashboardStats } from '@shared/types'
import type { AccountRepository } from '../db/account-repository'
import type { MessageRepository } from '../db/message-repository'

export class StatsService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly messages: MessageRepository,
    private readonly activeJobs: () => number,
  ) {}

  async get(): Promise<DashboardStats> {
    const [total, byStatus, lastTestAt, lastSyncAt, messages] = await Promise.all([
      this.repo.countAll(),
      this.repo.countByStatus(),
      this.repo.lastTestAt(),
      this.repo.lastSyncAt(),
      this.messages.countAll(),
    ])
    return {
      total,
      connected: byStatus.connected ?? 0,
      connecting: byStatus.connecting ?? 0,
      authError: byStatus.auth_error ?? 0,
      connectionError: byStatus.connection_error ?? 0,
      unknownError: byStatus.error ?? 0,
      syncError: byStatus.sync_error ?? 0,
      // 各カテゴリは status で排他。untested + connecting + syncing + connected + 各エラー + disabled = total
      untested: byStatus.untested ?? 0,
      disabled: byStatus.disabled ?? 0,
      syncing: byStatus.syncing ?? 0,
      messages,
      lastTestAt,
      lastSyncAt,
      activeJobs: this.activeJobs(),
    }
  }
}
