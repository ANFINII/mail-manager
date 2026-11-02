import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { ForwardFailureRecord, ForwardRecord } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'

type Tab = 'failed' | 'success'
const PAGE_SIZE = 100

/**
 * 転送ログ: 転送の成功履歴と、失敗（自動再試行のバックオフ待ち）を確認する。
 * 失敗は選んで「今すぐ再試行」または「記録を消去」できる。
 */
export default function ForwardLogTemplate() {
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const tick = useAppStore((s) => s.messagesChangedTick)
  const jobs = useAppStore((s) => s.jobs)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [tab, setTab] = useState<Tab>('failed')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [success, setSuccess] = useState<{ items: ForwardRecord[]; total: number }>({
    items: [],
    total: 0,
  })
  const [failed, setFailed] = useState<{ items: ForwardFailureRecord[]; total: number }>({
    items: [],
    total: 0,
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastJobDone = jobs.find((j) => j.type === 'mail_op' && j.status !== 'running')?.id

  const load = useCallback(async () => {
    try {
      const q = { to: to.trim() || undefined, page, pageSize: PAGE_SIZE }
      const [s, f] = await Promise.all([
        api.call('forwards.list', q),
        api.call('forwardFailures.list', q),
      ])
      setSuccess({ items: s.items, total: s.total })
      setFailed({ items: f.items, total: f.total })
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }, [to, page, notify])

  useEffect(() => {
    void load()
  }, [load, tick, lastJobDone])

  const key = (r: { messageId: string; to: string }) => `${r.messageId}\u0000${r.to}`
  const selectedItems = () =>
    failed.items.filter((r) => selected.has(key(r))).map((r) => ({ messageId: r.messageId, to: r.to }))

  const retry = async () => {
    const items = selectedItems()
    if (items.length === 0) return
    try {
      const r = await api.call('forwardFailures.retry', { items })
      notify('info', t('forwardLog.retried', { queued: r.queued, skipped: r.skipped }))
      setSelected(new Set())
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const clear = async (all: boolean) => {
    if (all && !window.confirm(t('forwardLog.confirmClearAll'))) return
    try {
      const r = await api.call('forwardFailures.clear', all ? {} : { items: selectedItems() })
      notify('info', t('forwardLog.cleared', { count: r.cleared }))
      setSelected(new Set())
      void load()
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  const total = tab === 'failed' ? failed.total : success.total
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const allSelected =
    failed.items.length > 0 && failed.items.every((r) => selected.has(key(r)))

  return (
    <div className="page" data-testid="forward-log">
      <div className="page-head">
        <h1>{t('forwardLog.title')}</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </div>
      <p className="muted">{t('forwardLog.hint')}</p>

      <div className="toolbar">
        <button
          className={`btn ${tab === 'failed' ? 'btn-primary' : ''}`}
          onClick={() => {
            setTab('failed')
            setPage(1)
          }}
          data-testid="tab-failed"
        >
          {t('forwardLog.failedTab', { count: failed.total })}
        </button>
        <button
          className={`btn ${tab === 'success' ? 'btn-primary' : ''}`}
          onClick={() => {
            setTab('success')
            setPage(1)
          }}
          data-testid="tab-success"
        >
          {t('forwardLog.successTab', { count: success.total })}
        </button>
        <input
          placeholder={t('forwardLog.filterTo')}
          value={to}
          onChange={(e) => {
            setTo(e.target.value)
            setPage(1)
          }}
        />
        <span className="spacer" />
        {tab === 'failed' && (
          <>
            <button className="btn" onClick={retry} disabled={selected.size === 0}>
              {t('forwardLog.retry', { count: selected.size })}
            </button>
            <button className="btn" onClick={() => clear(false)} disabled={selected.size === 0}>
              {t('forwardLog.clearSelected', { count: selected.size })}
            </button>
            <button
              className="btn btn-danger"
              onClick={() => clear(true)}
              disabled={failed.total === 0}
            >
              {t('forwardLog.clearAll')}
            </button>
          </>
        )}
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ‹
        </button>
        <span className="muted">
          {page} / {pages}
        </span>
        <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          ›
        </button>
      </div>

      {tab === 'failed' ? (
        failed.items.length === 0 ? (
          <p className="empty">{t('forwardLog.noFailures')}</p>
        ) : (
          <table className="simple-table full" data-testid="forward-failures">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(failed.items.map(key)))
                    }
                  />
                </th>
                <th>{t('forwardLog.account')}</th>
                <th>{t('forwardLog.subject')}</th>
                <th>{t('forwardLog.to')}</th>
                <th>{t('forwardLog.attempts')}</th>
                <th>{t('forwardLog.lastAttempt')}</th>
                <th>{t('forwardLog.nextRetry')}</th>
                <th>{t('forwardLog.error')}</th>
              </tr>
            </thead>
            <tbody>
              {failed.items.map((r) => (
                <tr key={key(r)}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(key(r))}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(key(r))) next.delete(key(r))
                          else next.add(key(r))
                          return next
                        })
                      }
                    />
                  </td>
                  <td className="mono">{r.accountEmail}</td>
                  <td>{r.subject || t('viewer.noSubject')}</td>
                  <td className="mono">{r.to}</td>
                  <td>{r.attempts}</td>
                  <td className="nowrap">{formatDateTime(r.lastAttemptAt, locale)}</td>
                  <td className="nowrap">{formatDateTime(r.nextRetryAt, locale)}</td>
                  <td className="cell-error" title={r.lastError ?? ''}>
                    {r.lastError ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : success.items.length === 0 ? (
        <p className="empty">{t('forwardLog.noSuccess')}</p>
      ) : (
        <table className="simple-table full" data-testid="forward-success">
          <thead>
            <tr>
              <th>{t('forwardLog.forwardedAt')}</th>
              <th>{t('forwardLog.account')}</th>
              <th>{t('forwardLog.from')}</th>
              <th>{t('forwardLog.subject')}</th>
              <th>{t('forwardLog.to')}</th>
            </tr>
          </thead>
          <tbody>
            {success.items.map((r) => (
              <tr key={key(r)}>
                <td className="nowrap">{formatDateTime(r.forwardedAt, locale)}</td>
                <td className="mono">{r.accountEmail}</td>
                <td>{r.fromName || r.fromAddress || '—'}</td>
                <td>{r.subject || t('viewer.noSubject')}</td>
                <td className="mono">{r.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
