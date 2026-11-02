import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { MessageSummary, SearchResult } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime, isForwardSubject } from 'utils/format'
import Compose from 'components/widgets/Compose'
import MessageViewer from 'components/widgets/MessageViewer'

const PAGE_SIZE = 50

/**
 * 送信メール: 各アカウントの送信済み（Sent）フォルダのメール一覧。
 * 種別カラムで、転送（件名が Fwd:/転送: など）か通常の送信かを判別できる。
 */
export default function SentTemplate() {
  const { t, i18n } = useTranslation()
  const accounts = useAppStore((s) => s.accounts)
  const accountGroups = useAppStore((s) => s.groups)
  const notify = useAppStore((s) => s.notify)
  const changedTick = useAppStore((s) => s.messagesChangedTick)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'

  const [accountId, setAccountId] = useState('')
  // グループで絞り込む（アカウント選択があればそちらを優先）。所属アカウントの ID 群に展開して検索する
  const [groupId, setGroupId] = useState('')
  const groupAccounts = useMemo(
    () => (groupId ? accounts.filter((a) => a.groupId === groupId) : accounts),
    [accounts, groupId],
  )
  // 送信先フィルタ（自由入力）: 入力欄の値（toInput）を 300ms 遅らせて検索条件（to）に反映する
  const [toInput, setToInput] = useState('')
  const [to, setTo] = useState('')
  const [kind, setKind] = useState<'' | 'forward' | 'normal'>('')
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<'date' | 'account'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [composeOpen, setComposeOpen] = useState(false)

  const query = useMemo(
    () => ({
      mailboxSpecialUse: '\\Sent',
      // 空のグループは「該当なし」にする（accountIds が空配列だと全件になるため）
      accountIds: accountId
        ? [accountId]
        : groupId
          ? groupAccounts.length > 0
            ? groupAccounts.map((a) => a.id)
            : ['__none__']
          : undefined,
      to: to || undefined,
      sortBy,
      sortDir,
      page,
      pageSize: PAGE_SIZE,
    }),
    [accountId, groupId, groupAccounts, to, sortBy, sortDir, page],
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = toInput.trim()
      if (next !== to) {
        setPage(1)
        setTo(next)
      }
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toInput])

  // background=true のときは loading 表示を行わない（受信中の再描画でボタンを揺らさない）
  const run = async (opts: { background?: boolean } = {}) => {
    if (!opts.background) setBusy(true)
    try {
      setResult(await api.call('search.query', query))
    } catch (err) {
      if (!opts.background) notify('error', errorMessage(err))
    } finally {
      if (!opts.background) setBusy(false)
    }
  }

  // 初回・グループ/アカウント/宛先/ページ変更・並び替え: 通常の検索
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, groupId, to, page, sortBy, sortDir])

  // ソート可能なカラム（種別・宛先・件名は対象外）
  const toggleSort = (col: 'date' | 'account') => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(col)
      setSortDir(col === 'date' ? 'desc' : 'asc')
    }
    if (page !== 1) setPage(1)
  }
  const sortMark = (col: 'date' | 'account') => (sortBy === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  // メール変更（受信中など）: 最大 1 秒に 1 回だけバックグラウンド再検索する
  const lastRefreshRef = useRef(0)
  useEffect(() => {
    if (changedTick === 0) return
    const delay = Math.max(0, 1000 - (Date.now() - lastRefreshRef.current))
    const timer = setTimeout(() => {
      lastRefreshRef.current = Date.now()
      void run({ background: true })
    }, delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedTick])

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1
  // 種別フィルタは取得済みページ内で適用する（サーバー側は Sent 全件を返す）
  const items = (result?.items ?? []).filter((m) => {
    if (kind === 'forward') return isForwardSubject(m.subject)
    if (kind === 'normal') return !isForwardSubject(m.subject)
    return true
  })

  const ids = [...selected]
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // 送信済みの重複した転送控えを整理する（現在のグループ／アカウントの絞り込みを対象にする）
  const dedupeScope = () =>
    accountId ? [accountId] : groupId ? groupAccounts.map((a) => a.id) : undefined
  const dedupeSent = async () => {
    setBusy(true)
    try {
      const stats = await api.call('sent.duplicateCopies', { accountIds: dedupeScope() })
      if (stats.extra === 0) {
        notify('info', t('sent.dedupeNone'))
        return
      }
      const ok = window.confirm(
        t('sent.dedupeConfirm', {
          accounts: stats.accounts,
          groups: stats.groups,
          extra: stats.extra,
          samples: stats.sampleSubjects.join('\n'),
        }),
      )
      if (!ok) return
      const r = await api.call('sent.deleteDuplicateCopies', { accountIds: dedupeScope() })
      notify('info', t('sent.dedupeStarted', { count: r.count }))
      setSelected(new Set())
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const deleteSelected = async () => {
    if (ids.length === 0) return
    if (!window.confirm(t('sent.confirmDelete', { count: ids.length }))) return
    try {
      await api.call('messages.delete', { ids })
      notify('info', t('sent.deleteQueued', { count: ids.length }))
      setSelected(new Set())
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  const renderRow = (m: MessageSummary) => {
    const forwarded = isForwardSubject(m.subject)
    return (
      <div
        key={m.id}
        className={`row result-row sent-row ${openId === m.id ? 'row-open' : ''}`}
        data-testid="sent-row"
        data-kind={forwarded ? 'forward' : 'normal'}
        onClick={() => setOpenId(m.id)}
      >
        <div onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected.has(m.id)}
            onChange={() => toggleOne(m.id)}
            aria-label={m.subject}
          />
        </div>
        <div title={m.accountEmail}>{m.accountEmail}</div>
        <div>
          <span className={`badge ${forwarded ? 'badge-forwarded' : ''}`}>
            {forwarded ? t('sent.kindForward') : t('sent.kindNormal')}
          </span>
        </div>
        <div title={m.toAddresses.map((a) => a.address).join(', ')}>
          {m.toAddresses.map((a) => a.name || a.address).join(', ') || '—'}
        </div>
        <div className="cell-subject" title={m.snippet}>
          {m.hasAttachments ? '📎 ' : ''}
          {m.subject || t('viewer.noSubject')}
        </div>
        <div className="muted small">{formatDateTime(m.date, locale)}</div>
      </div>
    )
  }

  return (
    <div className="page page-search" data-testid="sent">
      <div className="page-head">
        <h1>{t('nav.sent')}</h1>
        <span className="muted" data-testid="sent-total">
          {result ? t('sent.total', { total: result.total }) : ''}
        </span>
      </div>
      <div className="toolbar">
        <label className="field-inline">
          {t('search.group')}
          <select
            value={groupId}
            onChange={(e) => {
              setPage(1)
              setGroupId(e.target.value)
              setAccountId('')
            }}
            data-testid="sent-group"
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
              setPage(1)
              setAccountId(e.target.value)
            }}
            data-testid="sent-account"
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
          {t('sent.to')}
          <input
            className="search"
            type="text"
            autoComplete="off"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            placeholder={t('sent.toPlaceholder')}
            data-testid="sent-to"
          />
          {toInput && (
            <button
              type="button"
              className="btn"
              onClick={() => setToInput('')}
              title={t('sent.toClear')}
              data-testid="sent-to-clear"
            >
              ×
            </button>
          )}
        </label>
        <label className="field-inline">
          {t('sent.type')}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as '' | 'forward' | 'normal')}
            data-testid="sent-kind"
          >
            <option value="">{t('sent.kindAny')}</option>
            <option value="forward">{t('sent.kindForward')}</option>
            <option value="normal">{t('sent.kindNormal')}</option>
          </select>
        </label>
        <button className="btn" onClick={() => run()} disabled={busy}>
          {t('common.refresh')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => setComposeOpen(true)}
          data-testid="btn-compose"
        >
          {t('compose.new')}
        </button>
        <button
          className="btn btn-danger"
          onClick={deleteSelected}
          disabled={selected.size === 0}
          data-testid="btn-delete-sent"
        >
          {t('sent.deleteSelected')}
        </button>
        <button
          className="btn"
          onClick={dedupeSent}
          disabled={busy}
          title={t('sent.dedupeHint')}
          data-testid="btn-dedupe-sent"
        >
          {t('sent.dedupe')}
        </button>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || busy}
        >
          ‹
        </button>
        <span className="muted">
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

      <div className={`search-split ${openId ? 'with-viewer' : ''}`}>
        <div className="table results">
          <div className="row result-row sent-row row-head">
            <div />
            <div className="sortable" onClick={() => toggleSort('account')} data-testid="sort-account">
              {t('search.columns.account')}
              {sortMark('account')}
            </div>
            <div>{t('sent.type')}</div>
            <div>{t('sent.to')}</div>
            <div>{t('search.columns.subject')}</div>
            <div className="sortable" onClick={() => toggleSort('date')} data-testid="sort-date">
              {t('search.columns.date')}
              {sortMark('date')}
            </div>
          </div>
          <div className="table-body">
            {items.length === 0 ? (
              <p className="muted empty">{result ? t('sent.empty') : t('common.loading')}</p>
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
      {composeOpen && (
        <Compose
          accounts={accounts}
          defaultAccountId={accountId || undefined}
          onClose={(sent) => {
            setComposeOpen(false)
            if (sent) void run()
          }}
        />
      )}
    </div>
  )
}
