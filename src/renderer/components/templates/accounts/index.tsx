import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate, useSearchParams } from 'hooks/router'
import { useAppStore } from 'stores/app-store'
import type { AccountFilter, AccountSummary } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'
import AuthBadge from 'components/parts/AuthBadge'
import StatusBadge from 'components/parts/StatusBadge'
import GroupAssign from 'components/widgets/GroupAssign'
import GroupManager from 'components/widgets/GroupManager'
import TagAssign from 'components/widgets/TagAssign'

const FILTERS: AccountFilter[] = [
  'all',
  'connected',
  'error',
  'sync_error',
  'auth_error',
  'connection_error',
  'untested',
  'connecting',
]

function matchesFilter(a: AccountSummary, filter: AccountFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'connected':
      return a.status === 'connected'
    case 'error':
      return (
        a.status === 'auth_error' ||
        a.status === 'connection_error' ||
        a.status === 'error' ||
        a.status === 'sync_error'
      )
    case 'sync_error':
      return a.status === 'sync_error'
    case 'auth_error':
      return a.status === 'auth_error'
    case 'connection_error':
      return a.status === 'connection_error'
    case 'untested':
      return a.status === 'untested'
    case 'connecting':
      return a.status === 'connecting'
    case 'syncing':
      return a.status === 'syncing'
    case 'disabled':
      return !a.enabled
  }
}

export default function AccountsTemplate() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const accounts = useAppStore((s) => s.accounts)
  const groups = useAppStore((s) => s.groups)
  const jobs = useAppStore((s) => s.jobs)
  const notify = useAppStore((s) => s.notify)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'

  const filterParam = params.get('filter') as AccountFilter | null
  const filter: AccountFilter = filterParam && FILTERS.includes(filterParam) ? filterParam : 'all'
  // グループ絞り込み: '' = すべて / 'none' = 未所属 / それ以外はグループ ID
  const groupFilter = params.get('group') ?? ''
  const tagFilter = params.get('tag') ?? ''
  const setUrlParams = (next: { filter?: string; group?: string; tag?: string }) => {
    const merged = {
      filter: next.filter ?? filter,
      group: next.group ?? groupFilter,
      tag: next.tag ?? tagFilter,
    }
    const out: Record<string, string> = {}
    if (merged.filter && merged.filter !== 'all') out.filter = merged.filter
    if (merged.group) out.group = merged.group
    if (merged.tag) out.tag = merged.tag
    setParams(out)
  }
  const allTags = useMemo(() => [...new Set(accounts.flatMap((a) => a.tags))].sort(), [accounts])
  const [tagDialog, setTagDialog] = useState(false)
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [groupDialog, setGroupDialog] = useState<null | 'assign' | 'manage'>(null)

  const matchesGroup = (a: AccountSummary): boolean =>
    !groupFilter || (groupFilter === 'none' ? a.groupId === null : a.groupId === groupFilter)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return accounts.filter(
      (a) =>
        matchesFilter(a, filter) &&
        matchesGroup(a) &&
        (!tagFilter || a.tags.includes(tagFilter)) &&
        (!q ||
          a.email.toLowerCase().includes(q) ||
          (a.note ?? '').toLowerCase().includes(q) ||
          a.tags.some((tg) => tg.toLowerCase().includes(q))),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, filter, groupFilter, tagFilter, search])

  // ソート（エラー本文などの自由文は対象外）。未指定なら元の並び順のまま。
  type AccountSortCol =
    | 'email'
    | 'group'
    | 'provider'
    | 'status'
    | 'auth'
    | 'lastSuccess'
    | 'messages'
    | 'lastSync'
    | 'retries'
    | 'lastErrorAt'
  const [sortBy, setSortBy] = useState<AccountSortCol | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const sorted = useMemo(() => {
    if (!sortBy) return filtered
    const val = (a: AccountSummary): string | number => {
      switch (sortBy) {
        case 'email':
          return a.email.toLowerCase()
        case 'group':
          return a.groupId ? (groupName.get(a.groupId) ?? '').toLowerCase() : ''
        case 'provider':
          return a.provider ?? ''
        case 'status':
          return a.status
        case 'auth':
          return a.authStatus
        case 'messages':
          return a.messageCount
        case 'retries':
          return a.retryCount
        case 'lastSuccess':
          return a.lastSuccessAt ?? ''
        case 'lastSync':
          return a.lastSyncAt ?? ''
        case 'lastErrorAt':
          return a.lastErrorAt ?? ''
      }
    }
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const va = val(a)
      const vb = val(b)
      // 空（未取得）の値は並び順によらず常に末尾へ
      if (va === '' && vb !== '') return 1
      if (vb === '' && va !== '') return -1
      if (va < vb) return -dir
      if (va > vb) return dir
      return 0
    })
  }, [filtered, sortBy, sortDir, groupName])

  const toggleSort = (col: AccountSortCol) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortBy(col)
      setSortDir(col === 'lastSuccess' || col === 'lastSync' || col === 'messages' ? 'desc' : 'asc')
    }
  }
  const sortMark = (col: AccountSortCol) =>
    sortBy === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  // 削除などで消えた ID を選択から外す
  useEffect(() => {
    const ids = new Set(accounts.map((a) => a.id))
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [accounts])

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 15,
  })

  const allVisibleSelected = filtered.length > 0 && filtered.every((a) => selected.has(a.id))
  const toggleAll = () => {
    if (allVisibleSelected) setSelected(new Set())
    else setSelected(new Set(filtered.map((a) => a.id)))
  }
  // 未認証（認証にまだ成功していない）アカウントだけを選択する
  const untestedVisible = filtered.filter((a) => a.authStatus !== 'ok')
  const selectUntested = () => setSelected(new Set(untestedVisible.map((a) => a.id)))
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const running = jobs.some((j) => j.status === 'running')
  const selectedIds = [...selected]

  const run = async (fn: () => Promise<string>) => {
    try {
      notify('info', await fn())
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const stopAll = () =>
    run(async () => {
      const r = await api.call('jobs.cancelAll', {})
      return t('dashboard.stopped', { count: r.cancelled })
    })
  const authSelected = () =>
    run(async () => {
      const job = await api.call('auth.test', { ids: selectedIds })
      return t('dashboard.testStarted', { count: job.total })
    })
  const exportSelected = () =>
    run(async () => {
      const p = await api.saveFileDialog({
        title: t('accounts.exportTitle'),
        defaultName: `accounts-${new Date().toISOString().slice(0, 10)}.csv`,
        extensions: ['csv'],
      })
      if (!p) return ''
      const r = await api.call('accounts.exportCsv', { path: p, accountIds: selectedIds })
      await api.showItemInFolder(p)
      return t('accounts.exported', { count: r.count })
    })
  const exportWithCredentials = () => {
    if (!window.confirm(t('accounts.exportCredsConfirm', { count: selectedIds.length }))) return
    void run(async () => {
      const p = await api.saveFileDialog({
        title: t('accounts.exportCredsTitle'),
        defaultName: `accounts-with-credentials-${new Date().toISOString().slice(0, 10)}.csv`,
        extensions: ['csv'],
      })
      if (!p) return ''
      const r = await api.call('accounts.exportCsvWithCredentials', { path: p, accountIds: selectedIds })
      await api.showItemInFolder(p)
      return t('accounts.exportedCreds', { count: r.count })
    })
  }
  const deleteSelected = () => {
    if (!window.confirm(t('accounts.confirmDelete', { count: selectedIds.length }))) return
    void run(async () => {
      const r = await api.call('accounts.delete', { ids: selectedIds })
      setSelected(new Set())
      return t('accounts.deleted', { count: r.deleted })
    })
  }

  return (
    <div className="page page-accounts" data-testid="accounts">
      <div className="page-head">
        <h1>{t('accounts.title')}</h1>
        <span className="muted" data-testid="accounts-count">
          {t('accounts.showing', { shown: filtered.length, total: accounts.length })}
        </span>
      </div>
      <div className="toolbar">
        <label className="field-inline">
          {t('accounts.filter')}
          <select
            value={filter}
            onChange={(e) => setUrlParams({ filter: e.target.value })}
            data-testid="filter"
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {t(`filter.${f}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          {t('accounts.group')}
          <select
            value={groupFilter}
            onChange={(e) => setUrlParams({ group: e.target.value })}
            data-testid="group-filter"
          >
            <option value="">{t('accounts.groupFilterAll')}</option>
            <option value="none">{t('accounts.groupNone')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.accountCount})
              </option>
            ))}
          </select>
        </label>
        {allTags.length > 0 && (
          <label className="field-inline">
            {t('tags.title')}
            <select value={tagFilter} onChange={(e) => setUrlParams({ tag: e.target.value })} data-testid="tag-filter">
              <option value="">{t('tags.all')}</option>
              {allTags.map((tg) => (
                <option key={tg} value={tg}>
                  {tg}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="btn" onClick={() => setGroupDialog('manage')} data-testid="btn-manage-groups">
          {t('accounts.manageGroups')}
        </button>
        <input
          className="search"
          placeholder={t('common.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="search"
        />
        <span className="muted">{t('common.selected', { count: selected.size })}</span>
        <button
          className="btn"
          onClick={selectUntested}
          disabled={untestedVisible.length === 0}
          data-testid="btn-select-untested"
        >
          {t('accounts.selectUntested', { count: untestedVisible.length })}
        </button>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => setGroupDialog('assign')}
          disabled={selected.size === 0}
          data-testid="btn-assign-group"
        >
          {t('accounts.assignGroup')}
        </button>
        <button
          className="btn"
          onClick={() => setTagDialog(true)}
          disabled={selected.size === 0}
          data-testid="btn-assign-tags"
        >
          {t('tags.assign')}
        </button>
        <button
          className="btn"
          onClick={exportSelected}
          disabled={selected.size === 0}
          data-testid="btn-export-selected"
        >
          {t('accounts.exportSelected', { count: selected.size })}
        </button>
        <button
          className="btn"
          onClick={exportWithCredentials}
          disabled={selected.size === 0}
          data-testid="btn-export-credentials"
          title={t('accounts.exportCredsHint')}
        >
          {t('accounts.exportCreds', { count: selected.size })}
        </button>
        <button
          className="btn btn-primary"
          onClick={authSelected}
          disabled={selected.size === 0}
          data-testid="btn-auth-selected"
        >
          {t('accounts.authSelected')}
        </button>
        <button className="btn btn-danger" onClick={stopAll} disabled={!running}>
          {t('accounts.stopAll')}
        </button>
        <button
          className="btn btn-danger"
          onClick={deleteSelected}
          disabled={selected.size === 0}
          data-testid="btn-delete-selected"
        >
          {t('accounts.deleteSelected')}
        </button>
      </div>

      <div className="table">
        <div className="row row-head">
          <div>
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAll}
              aria-label="select all"
              data-testid="select-all"
            />
          </div>
          <div className="sortable" onClick={() => toggleSort('email')} data-testid="sort-email">
            {t('accounts.columns.email')}
            {sortMark('email')}
          </div>
          <div className="sortable" onClick={() => toggleSort('provider')}>
            {t('accounts.columns.provider')}
            {sortMark('provider')}
          </div>
          <div className="sortable" onClick={() => toggleSort('group')} data-testid="sort-group">
            {t('accounts.columns.group')}
            {sortMark('group')}
          </div>
          <div className="sortable" onClick={() => toggleSort('status')}>
            {t('accounts.columns.status')}
            {sortMark('status')}
          </div>
          <div className="sortable" onClick={() => toggleSort('auth')}>
            {t('accounts.columns.auth')}
            {sortMark('auth')}
          </div>
          <div className="sortable" onClick={() => toggleSort('lastSuccess')}>
            {t('accounts.columns.lastSuccess')}
            {sortMark('lastSuccess')}
          </div>
          <div className="sortable" onClick={() => toggleSort('messages')}>
            {t('accounts.columns.messages')}
            {sortMark('messages')}
          </div>
          <div className="sortable" onClick={() => toggleSort('lastSync')}>
            {t('accounts.columns.lastSync')}
            {sortMark('lastSync')}
          </div>
          <div className="sortable" onClick={() => toggleSort('retries')}>
            {t('accounts.columns.retries')}
            {sortMark('retries')}
          </div>
          <div>{t('accounts.columns.error')}</div>
          <div className="sortable" onClick={() => toggleSort('lastErrorAt')}>
            {t('accounts.columns.lastErrorAt')}
            {sortMark('lastErrorAt')}
          </div>
        </div>
        <div className="table-body" ref={parentRef} data-testid="accounts-table">
          {filtered.length === 0 ? (
            <p className="muted empty">
              {accounts.length === 0 ? t('accounts.empty') : t('common.none')}
            </p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const a = sorted[item.index]
                return (
                  <div
                    key={a.id}
                    className={`row ${selected.has(a.id) ? 'row-selected' : ''}`}
                    data-testid="account-row"
                    data-email={a.email}
                    data-status={a.status}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: item.size,
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <div>
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() => toggleOne(a.id)}
                        aria-label={a.email}
                      />
                    </div>
                    <div className="cell-email">
                      <a
                        href={`#/accounts/${a.id}`}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate(`/accounts/${a.id}`)
                        }}
                      >
                        {a.email}
                      </a>
                      {a.tags.map((tg) => (
                        <span key={tg} className="tag-chip small">
                          {tg}
                        </span>
                      ))}
                      {a.note && (
                        <span className="note-mark" title={a.note}>
                          ✎
                        </span>
                      )}
                    </div>
                    <div>{a.provider}</div>
                    <div className="cell-group" data-testid="cell-group" title={a.groupId ? groupName.get(a.groupId) ?? '' : ''}>
                      {a.groupId ? groupName.get(a.groupId) ?? '' : ''}
                    </div>
                    <div>
                      <StatusBadge status={a.status} />
                    </div>
                    <div>
                      <AuthBadge status={a.authStatus} />
                    </div>
                    <div className="muted small">{formatDateTime(a.lastSuccessAt, locale)}</div>
                    <div data-testid="cell-messages">{a.messageCount}</div>
                    <div className="muted small">{formatDateTime(a.lastSyncAt, locale)}</div>
                    <div>{a.retryCount}</div>
                    <div className="cell-error" title={a.lastError ?? ''}>
                      {a.lastError ?? ''}
                    </div>
                    <div className="muted small">{formatDateTime(a.lastErrorAt, locale)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      {groupDialog === 'assign' && (
        <GroupAssign
          ids={selectedIds}
          onCancel={() => setGroupDialog(null)}
          onDone={() => setGroupDialog(null)}
        />
      )}
      {groupDialog === 'manage' && <GroupManager onClose={() => setGroupDialog(null)} />}
      {tagDialog && <TagAssign ids={[...selected]} onClose={() => setTagDialog(false)} />}
    </div>
  )
}
