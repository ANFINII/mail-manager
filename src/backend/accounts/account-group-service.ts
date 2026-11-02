import type { AccountGroupInfo } from '@shared/types'
import { toSummary } from './account-service'
import type { AccountGroupRepository, AccountGroupRow } from '../db/account-group-repository'
import type { AccountRepository } from '../db/account-repository'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'

const MAX_NAME = 100

export interface AccountGroupServiceDeps {
  groups: AccountGroupRepository;
  accounts: AccountRepository;
  events: EventBus;
  logger: Logger;
  now?: () => string;
}

/** アカウントグループの作成・改名・削除と、アカウントの所属変更。変更のたびに groups.changed を通知する。 */
export class AccountGroupService {
  private readonly now: () => string

  constructor(private readonly deps: AccountGroupServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async list(): Promise<AccountGroupInfo[]> {
    const [rows, counts] = await Promise.all([this.deps.groups.list(), this.deps.groups.accountCounts()])
    return rows.map((r) => toInfo(r, counts[r.id] ?? 0))
  }

  async create(name: string): Promise<AccountGroupInfo[]> {
    const clean = this.validateName(name)
    if (await this.deps.groups.getByName(clean)) throw new Error(`グループ「${clean}」は既にあります`)
    await this.deps.groups.create(clean, this.now())
    this.deps.logger.info('Account group created', { name: clean })
    return this.changed()
  }

  async rename(id: string, name: string): Promise<AccountGroupInfo[]> {
    const clean = this.validateName(name)
    const dup = await this.deps.groups.getByName(clean)
    if (dup && dup.id !== id) throw new Error(`グループ「${clean}」は既にあります`)
    if ((await this.deps.groups.rename(id, clean, this.now())) === 0) throw new Error('グループが見つかりません')
    return this.changed()
  }

  /** グループを削除する。所属アカウントは FK (ON DELETE SET NULL) で未所属に戻る。 */
  async remove(id: string): Promise<AccountGroupInfo[]> {
    const members = await this.deps.accounts.listIdsByGroup(id)
    if ((await this.deps.groups.remove(id)) === 0) throw new Error('グループが見つかりません')
    this.deps.logger.info('Account group removed', { id, members: members.length })
    if (members.length > 0) await this.emitAccounts(members)
    return this.changed()
  }

  /** アカウントの所属グループを変更する（groupId=null で外す） */
  async assign(ids: string[], groupId: string | null): Promise<number> {
    if (groupId && !(await this.deps.groups.getById(groupId))) throw new Error('グループが見つかりません')
    const updated = await this.deps.accounts.setGroup([...new Set(ids)], groupId, this.now())
    if (updated > 0) {
      await this.emitAccounts(ids)
      this.deps.events.emit({ type: 'groups.changed', groups: await this.list() })
    }
    return updated
  }

  private validateName(name: string): string {
    const clean = name.trim()
    if (!clean) throw new Error('グループ名を入力してください')
    if ([...clean].length > MAX_NAME) throw new Error(`グループ名は ${MAX_NAME} 文字以内にしてください`)
    return clean
  }

  private async emitAccounts(ids: string[]): Promise<void> {
    const rows = await this.deps.accounts.getByIds(ids)
    if (rows.length > 0) this.deps.events.emit({ type: 'accounts.updated', accounts: rows.map(toSummary) })
  }

  private async changed(): Promise<AccountGroupInfo[]> {
    const groups = await this.list()
    this.deps.events.emit({ type: 'groups.changed', groups })
    return groups
  }
}

function toInfo(r: AccountGroupRow, accountCount: number): AccountGroupInfo {
  return { id: r.id, name: r.name, accountCount, createdAt: r.created_at, updatedAt: r.updated_at }
}
