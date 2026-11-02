import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { useAppStore } from 'stores/app-store'
import type { AccountHealth, HealthSeverity } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'

/**
 * 健全性モニタ: 認証失敗・連続失敗・長期間未成功・転送失敗などで「要対応」のアカウントを一覧にする。
 * 一覧から選んで、まとめて認証テスト / 同期をやり直せる。
 */
export default function HealthTemplate() {
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const groups = useAppStore((s) => s.groups)
  const statsTick = useAppStore((s) => s.stats)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [items, setItems] = useState<AccountHealth[]>([])
  const [includeInfo, setIncludeInfo] = useState(false)
  const [severity, setSeverity] = useState<HealthSeverity | 'all'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.call('health.list', { includeInfo }))
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [includeInfo, notify])

  // 統計が更新される（認証・同期の完了など）たびに読み直す
  useEffect(() => {
    void load()
  }, [load, statsTick])

  const visible = useMemo(
    () => (severity === 'all' ? items : items.filter((i) => i.severity === severity)),
    [items, severity],
  )
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name ?? ''
  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 }
    for (const i of items) c[i.severity]++
    return c
  }, [items])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allSelected = visible.length > 0 && visible.every((i) => selected.has(i.accountId))
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(visible.map((i) => i.accountId)))
  const targetIds = () =>
    selected.size > 0 ? [...selected] : visible.map((i) => i.accountId)

  const retest = async () => {
    const ids = targetIds()
    if (ids.length === 0) return
    try {
      await api.call('auth.test', { ids })
      notify('info', t('dashboard.testStarted', { count: ids.length }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const resync = async () => {
    const ids = targetIds()
    if (ids.length === 0) return
    try {
      await api.call('sync.run', { ids })
      notify('info', t('dashboard.syncStarted', { count: ids.length }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <div className="page" data-testid="health">
      <div className="page-head">
        <h1>{t('health.title')}</h1>
        <span className="muted">{t('common.count', { count: items.length })}</span>
        <span className="spacer" />
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {t('common.refresh')}
        </button>
      </div>
      <p className="muted">{t('health.hint')}</p>

      <div className="toolbar">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as HealthSeverity | 'all')}
          data-testid="health-severity"
        >
          <option value="all">{t('common.all')}</option>
          <option value="critical">
            {t('health.severity.critical')} ({counts.critical})
          </option>
          <option value="warning">
            {t('health.severity.warning')} ({counts.warning})
          </option>
          {includeInfo && (
            <option value="info">
              {t('health.severity.info')} ({counts.info})
            </option>
          )}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={includeInfo}
            onChange={(e) => setIncludeInfo(e.target.checked)}
          />{' '}
          {t('health.includeInfo')}
        </label>
        <span className="spacer" />
        {selected.size > 0 && (
          <span className="muted">{t('common.selected', { count: selected.size })}</span>
        )}
        <button className="btn" onClick={retest} disabled={visible.length === 0}>
          {selected.size > 0 ? t('health.retestSelected') : t('health.retestAll')}
        </button>
        <button className="btn" onClick={resync} disabled={visible.length === 0}>
          {selected.size > 0 ? t('health.resyncSelected') : t('health.resyncAll')}
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="empty" data-testid="health-empty">
          {loading ? t('common.loading') : t('health.allGood')}
        </p>
      ) : (
        <table className="simple-table full" data-testid="health-list">
          <thead>
            <tr>
              <th>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
              <th>{t('health.severityCol')}</th>
              <th>{t('accounts.columns.email')}</th>
              <th>{t('health.issues')}</th>
              <th>{t('health.lastSuccess')}</th>
              <th>{t('health.lastError')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((h) => (
              <tr key={h.accountId} data-severity={h.severity}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(h.accountId)}
                    onChange={() => toggle(h.accountId)}
                  />
                </td>
                <td>
                  <span className={`badge sev-${h.severity}`}>
                    {t(`health.severity.${h.severity}`)}
                  </span>
                </td>
                <td>
                  <Link to="/accounts/$id" params={{ id: h.accountId }} className="mono">
                    {h.email}
                  </Link>
                  {h.groupId && <div className="muted small">{groupName(h.groupId)}</div>}
                </td>
                <td>
                  <ul className="issue-list">
                    {h.issues.map((i) => (
                      <li key={i.reason}>
                        {t(`health.reason.${i.reason}`, { value: i.value ?? 0 })}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="nowrap">{formatDateTime(h.lastSuccessAt, locale)}</td>
                <td className="cell-error" title={h.lastError ?? ''}>
                  {h.lastError ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
