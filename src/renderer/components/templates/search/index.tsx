import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'hooks/router'
import { useAppStore } from 'stores/app-store'
import type { AccountGroup, MessageSummary, SearchQuery, SearchResult } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'
import AutoSyncToggle from 'components/widgets/AutoSyncToggle'
import Forward from 'components/widgets/Forward'
import MessageViewer from 'components/widgets/MessageViewer'

const PAGE_SIZE = 50

export default function SearchTemplate() {
  const { t, i18n } = useTranslation()
  const [params] = useSearchParams()
  const accounts = useAppStore((s) => s.accounts)
  const accountGroups = useAppStore((s) => s.groups)
  const notify = useAppStore((s) => s.notify)
  const changedTick = useAppStore((s) => s.messagesChangedTick)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'

  const [text, setText] = useState('')
  const [accountId, setAccountId] = useState(params.get('accountId') ?? '')
  // グループで絞り込む（アカウント選択があればそちらを優先）。所属アカウントの ID 群に展開して検索する
  const [groupId, setGroupId] = useState('')
  const groupAccounts = useMemo(
    () => (groupId ? accounts.filter((a) => a.groupId === groupId) : accounts),
    [accounts, groupId],
  )
  const [folder, setFolder] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [hasAttachments, setHasAttachments] = useState(false)
  const [unseenOnly, setUnseenOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<'date' | 'account' | 'from' | 'mailbox'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 認証コード画面などから messageId 付きで開かれたら、そのメールを表示する
  const [openId, setOpenId] = useState<string | null>(params.get('messageId'))
  // 表示モード: 'list' = 通常の一覧 / 'grouped' = アカウント別グループ
  const [viewMode, setViewMode] = useState<'list' | 'grouped'>('list')
  const [groups, setGroups] = useState<AccountGroup[] | null>(null)

  useEffect(() => {
    api
      .call('mailboxes.paths', {})
      .then(setFolders)
      .catch(() => undefined)
  }, [accounts.length])

  const query = useMemo<SearchQuery>(
    () => ({
      text: text.trim() || undefined,
      // 空のグループは「該当なし」にする（accountIds が空配列だと全件になるため）
      accountIds: accountId
        ? [accountId]
        : groupId
          ? groupAccounts.length > 0
            ? groupAccounts.map((a) => a.id)
            : ['__none__']
          : undefined,
      mailboxPath: folder || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      from: from.trim() || undefined,
      subject: subject.trim() || undefined,
      hasAttachments: hasAttachments || undefined,
      unseenOnly: unseenOnly || undefined,
      sortBy,
      sortDir,
      page,
      pageSize: PAGE_SIZE,
    }),
    [
      text,
      accountId,
      groupId,
      groupAccounts,
      folder,
      dateFrom,
      dateTo,
      from,
      subject,
      hasAttachments,
      unseenOnly,
      sortBy,
      sortDir,
      page,
    ],
  )

  // 背景再検索が「検索前の古いクエリ」で発火して結果が一瞬戻るのを防ぐため、常に最新クエリを参照する
  const queryRef = useRef(query)
  queryRef.current = query

  // background=true のときはボタンの loading 表示や選択解除を行わない
  // （受信中に大量のイベントで再検索が走ってもボタンがチカチカしないようにするため）
  const run = async (q: SearchQuery = query, opts: { background?: boolean } = {}) => {
    if (!opts.background) setBusy(true)
    try {
      const r = await api.call('search.query', q)
      setResult(r)
      if (!opts.background) setSelected(new Set())
      else {
        // 背景更新では選択を保つが、削除などで一覧から消えた ID は選択から外す
        const present = new Set(r.items.map((m) => m.id))
        setSelected((prev) => {
          const next = new Set([...prev].filter((id) => present.has(id)))
          return next.size === prev.size ? prev : next
        })
      }
    } catch (err) {
      if (!opts.background) notify('error', errorMessage(err))
    } finally {
      if (!opts.background) setBusy(false)
    }
  }

  // 初回・ページ変更・並び替え・アカウント選択: 通常の（loading 表示ありの）検索
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sortBy, sortDir, accountId, groupId])

  // ソート可能なカラム（件名など自由文は対象外）
  type SortCol = 'date' | 'account' | 'from' | 'mailbox'
  const toggleSort = (col: SortCol) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(col)
      setSortDir(col === 'date' ? 'desc' : 'asc')
    }
    if (page !== 1) setPage(1)
  }
  const sortMark = (col: SortCol) => (sortBy === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  // メール変更（受信中など）: 最大 1 秒に 1 回だけバックグラウンド再検索する。
  // イベントごとに再検索すると busy がトグルしてボタンが揺れ、リストもチカチカするため間引く。
  const lastRefreshRef = useRef(0)
  useEffect(() => {
    if (changedTick === 0) return
    // メールを開いている間は再描画で操作（転送ダイアログ等）を邪魔しないよう自動更新を止める
    if (openId) return
    const delay = Math.max(0, 1000 - (Date.now() - lastRefreshRef.current))
    const timer = setTimeout(() => {
      lastRefreshRef.current = Date.now()
      void run(queryRef.current, { background: true })
    }, delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedTick, openId])

  // アカウント別グループ: 現在の検索条件（アカウント指定は無視）で件数集計する
  useEffect(() => {
    if (viewMode !== 'grouped') return
    let cancelled = false
    api
      .call('search.accountGroups', { ...query, accountIds: undefined, page: 1 })
      .then((g) => {
        if (!cancelled) setGroups(g)
      })
      .catch((err) => notify('error', errorMessage(err)))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, text, folder, dateFrom, dateTo, from, subject, hasAttachments, unseenOnly, changedTick])

  // グループのアカウントを選ぶと、そのアカウントで絞った一覧に切り替える
  const openGroup = (accountId: string) => {
    setAccountId(accountId)
    setPage(1)
    setViewMode('list')
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (page !== 1) setPage(1)
    else void run({ ...query, page: 1 })
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1
  const items = result?.items ?? []
  const allSelected = items.length > 0 && items.every((m) => selected.has(m.id))

  const bulk = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn()
      notify('info', done)
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const ids = [...selected]
  const markSeen = (seen: boolean) =>
    bulk(
      () => api.call('messages.setFlags', { ids, seen }),
      t('search.flagsQueued', { count: ids.length }),
    )
  const remove = () => {
    if (!window.confirm(t('search.confirmDelete', { count: ids.length }))) return
    void bulk(
      () => api.call('messages.delete', { ids }),
      t('search.deleteQueued', { count: ids.length }),
    )
  }
  const [forwardMode, setForwardMode] = useState<null | 'selected' | 'all'>(null)
  const runForward = async (to: string) => {
    const res =
      forwardMode === 'all'
        ? await api.call('messages.forwardAll', { query: { ...query, page: 1 }, to })
        : await api.call('messages.forward', { ids, to })
    setForwardMode(null)
    notify('info', t('search.forwardResult', { queued: res.queued, skipped: res.skipped, to }))
  }
  const exportCsv = async () => {
    const p = await api.saveFileDialog({
      title: t('search.exportTitle'),
      defaultName: 'search-results.csv',
      extensions: ['csv'],
    })
    if (!p) return
    await bulk(async () => {
      const r = await api.call('search.exportCsv', { query: { ...query, page: 1 }, path: p })
      await api.showItemInFolder(p)
      return r
    }, t('search.exported'))
  }
  // 受信同期: 認証済みアカウントだけを対象に、UID 差分で未取得の新着メールだけを取得する（全件再取得ではない）
  const receiveSync = async () => {
    try {
      const job = await api.call('sync.run', { ids: 'authenticated' })
      if (job.total === 0) notify('info', t('dashboard.noAuthenticated'))
      else notify('info', t('search.receiveSyncStarted', { count: job.total }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  // メールを開くと同時に既読にする（未読のときだけ）。一覧は楽観的に更新する。
  const openMessage = (m: MessageSummary) => {
    setOpenId(m.id)
    if (m.seen) return
    setResult((prev) =>
      prev ? { ...prev, items: prev.items.map((x) => (x.id === m.id ? { ...x, seen: true } : x)) } : prev,
    )
    api.call('messages.setFlags', { ids: [m.id], seen: true }).catch((err) => notify('error', errorMessage(err)))
  }

  const renderRow = (m: MessageSummary) => (
    <div
      key={m.id}
      className={`row result-row ${m.seen ? 'seen' : 'unseen'} ${openId === m.id ? 'row-open' : ''} ${selected.has(m.id) ? 'row-selected' : ''}`}
      data-testid="result-row"
      onClick={() => openMessage(m)}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected.has(m.id)}
          onChange={() =>
            setSelected((prev) => {
              const next = new Set(prev)
              if (next.has(m.id)) next.delete(m.id)
              else next.add(m.id)
              return next
            })
          }
        />
      </div>
      <div title={m.accountEmail}>{m.accountEmail}</div>
      <div title={m.fromAddress ?? ''}>{m.fromName || m.fromAddress || '—'}</div>
      <div className="cell-subject" title={m.snippet}>
        {m.hasAttachments ? '📎 ' : ''}
        {m.subject || t('viewer.noSubject')}
        <span className="muted snippet"> — {m.snippet}</span>
      </div>
      <div>{m.mailboxPath}</div>
      <div className="muted small">{formatDateTime(m.date, locale)}</div>
    </div>
  )

  return (
    <div className="page page-search" data-testid="search">
      <div className="page-head">
        <h1>{t('nav.search')}</h1>
        <div className="viewmode" role="tablist">
          <button
            className={`btn ${viewMode === 'list' ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => setViewMode('list')}
            data-testid="viewmode-list"
          >
            {t('search.viewList')}
          </button>
          <button
            className={`btn ${viewMode === 'grouped' ? 'btn-primary' : ''}`}
            type="button"
            onClick={() => setViewMode('grouped')}
            data-testid="viewmode-grouped"
          >
            {t('search.viewGrouped')}
          </button>
        </div>
        <span className="spacer" />
        <AutoSyncToggle />
        <button
          className="btn btn-primary"
          type="button"
          onClick={receiveSync}
          data-testid="btn-receive-sync"
          title={t('search.receiveSyncHint')}
        >
          ⟳ {t('search.receiveSync')}
        </button>
      </div>
      <form className="search-form" onSubmit={submit}>
        <div className="form-row">
          <input
            className="grow"
            placeholder={t('search.textPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="search-text"
          />
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy}
            data-testid="btn-search"
          >
            {busy ? t('common.loading') : t('search.run')}
          </button>
          <button
            className="btn"
            type="button"
            onClick={exportCsv}
            disabled={!result || result.total === 0}
          >
            {t('search.export')}
          </button>
        </div>
        <div className="form-row wrap">
          <label className="field-inline">
            {t('search.group')}
            <select
              value={groupId}
              onChange={(e) => {
                setPage(1)
                setGroupId(e.target.value)
                setAccountId('')
              }}
              data-testid="search-group"
            >
              <option value="">{t('search.allGroups')}</option>
              {accountGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.accountCount})
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            {t('search.account')}
            <select
              value={accountId}
              onChange={(e) => {
                // アカウントを選ぶと自動で検索する（ページは 1 に戻す）
                setPage(1)
                setAccountId(e.target.value)
              }}
              data-testid="search-account"
            >
              <option value="">{t('search.allAccounts')}</option>
              {groupAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            {t('search.folder')}
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">{t('search.allFolders')}</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            {t('search.date')}
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            –
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <label className="field-inline">
            {t('search.from')}
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="search-from"
            />
          </label>
          <label className="field-inline">
            {t('search.subject')}
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="search-subject"
            />
          </label>
          <label className="field-inline">
            <input
              type="checkbox"
              checked={hasAttachments}
              onChange={(e) => setHasAttachments(e.target.checked)}
            />
            {t('search.hasAttachments')}
          </label>
          <label className="field-inline">
            <input
              type="checkbox"
              checked={unseenOnly}
              onChange={(e) => setUnseenOnly(e.target.checked)}
            />
            {t('search.unseenOnly')}
          </label>
        </div>
      </form>

      <div className="toolbar">
        <span className="muted" data-testid="search-total">
          {result ? t('search.total', { total: result.total, ms: result.tookMs }) : ''}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => markSeen(true)} disabled={ids.length === 0}>
          {t('viewer.markRead')}
        </button>
        <button className="btn" onClick={() => markSeen(false)} disabled={ids.length === 0}>
          {t('viewer.markUnread')}
        </button>
        <button
          className="btn"
          onClick={() => setForwardMode('selected')}
          disabled={ids.length === 0}
          data-testid="btn-forward-selected"
        >
          {t('search.forwardSelected', { count: ids.length })}
        </button>
        <button
          className="btn"
          onClick={() => setForwardMode('all')}
          disabled={!result || result.total === 0}
          data-testid="btn-forward-all"
        >
          {t('search.forwardAll', { count: result?.total ?? 0 })}
        </button>
        <button className="btn btn-danger" onClick={remove} disabled={ids.length === 0}>
          {t('common.delete')}
        </button>
        <button
          className="btn"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || busy}
        >
          ‹
        </button>
        <span className="muted" data-testid="search-page">
          {page} / {totalPages}
        </span>
        <button
          className="btn"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages || busy}
        >
          ›
        </button>
      </div>

      {viewMode === 'grouped' ? (
        <div className="table results" data-testid="account-groups">
          <div className="row group-row row-head">
            <div>{t('search.columns.account')}</div>
            <div className="num">{t('search.groupUnseen')}</div>
            <div className="num">{t('search.groupTotal')}</div>
          </div>
          <div className="table-body">
            {groups === null ? (
              <p className="muted empty">{t('common.loading')}</p>
            ) : groups.length === 0 ? (
              <p className="muted empty">{t('search.noResults')}</p>
            ) : (
              groups.map((g) => (
                <div
                  key={g.accountId}
                  className="row group-row"
                  data-testid="account-group-row"
                  onClick={() => openGroup(g.accountId)}
                >
                  <div title={g.email}>{g.email}</div>
                  <div className="num">
                    {g.unseen > 0 ? <strong>{g.unseen}</strong> : <span className="muted">0</span>}
                  </div>
                  <div className="num">{g.total}</div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className={`search-split ${openId ? 'with-viewer' : ''}`}>
        <div className="table results">
          <div className="row result-row row-head">
            <div>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(items.map((m) => m.id)))
                }
                aria-label="select all"
              />
            </div>
            <div className="sortable" onClick={() => toggleSort('account')} data-testid="sort-account">
              {t('search.columns.account')}
              {sortMark('account')}
            </div>
            <div className="sortable" onClick={() => toggleSort('from')} data-testid="sort-from">
              {t('search.columns.from')}
              {sortMark('from')}
            </div>
            <div>{t('search.columns.subject')}</div>
            <div className="sortable" onClick={() => toggleSort('mailbox')} data-testid="sort-mailbox">
              {t('search.columns.folder')}
              {sortMark('mailbox')}
            </div>
            <div className="sortable" onClick={() => toggleSort('date')} data-testid="sort-date">
              {t('search.columns.date')}
              {sortMark('date')}
            </div>
          </div>
          <div className="table-body">
            {items.length === 0 ? (
              <p className="muted empty">{result ? t('search.noResults') : t('common.loading')}</p>
            ) : (
              items.map(renderRow)
            )}
          </div>
        </div>
        {openId && (
          <MessageViewer
            messageId={openId}
            onClose={() => setOpenId(null)}
            onChanged={() => void run()}
          />
        )}
        </div>
      )}
      {forwardMode && (
        <Forward
          title={
            forwardMode === 'all'
              ? t('search.forwardAllTitle', { count: result?.total ?? 0 })
              : t('search.forwardSelectedTitle', { count: ids.length })
          }
          onCancel={() => setForwardMode(null)}
          onConfirm={runForward}
        />
      )}
    </div>
  )
}
