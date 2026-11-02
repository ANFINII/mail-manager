import type { MailboxSummary } from '@shared/types'
import type { MailboxRow } from '../db/schema'

export function toMailboxSummary(row: MailboxRow, storedMessages: number): MailboxSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    path: row.path,
    name: row.name,
    specialUse: row.special_use,
    uidValidity: row.uid_validity,
    lastSyncUid: row.last_sync_uid,
    totalMessages: row.total_messages,
    storedMessages,
    lastSyncAt: row.last_sync_at,
    syncEnabled: row.sync_enabled === 1,
  }
}
