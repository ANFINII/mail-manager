import { useTranslation } from 'react-i18next'
import { useNavigate } from 'hooks/router'
import { useAppStore } from 'stores/app-store'
import type { AccountFilter } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'
import AutoSyncToggle from 'components/widgets/AutoSyncToggle'
import JobProgress from 'components/widgets/JobProgress'

interface Tile {
  key: string;
  value: number;
  filter: AccountFilter;
  className: string;
}

export default function DashboardTemplate() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const stats = useAppStore((s) => s.stats)
  const jobs = useAppStore((s) => s.jobs)
  const notify = useAppStore((s) => s.notify)
  const accounts = useAppStore((s) => s.accounts)
  const syncProgress = useAppStore((s) => s.syncProgress)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'

  const tiles: Tile[] = stats
    ? [
        { key: 'accounts', value: stats.total, filter: 'all', className: 'tile-total' },
        { key: 'connected', value: stats.connected, filter: 'connected', className: 'tile-ok' },
        {
          key: 'connecting',
          value: stats.connecting,
          filter: 'connecting',
          className: 'tile-info',
        },
        { key: 'syncing', value: stats.syncing, filter: 'syncing', className: 'tile-info' },
        { key: 'authError', value: stats.authError, filter: 'auth_error', className: 'tile-warn' },
        {
          key: 'connectionError',
          value: stats.connectionError,
          filter: 'connection_error',
          className: 'tile-err',
        },
        { key: 'unknownError', value: stats.unknownError, filter: 'error', className: 'tile-err' },
        { key: 'syncError', value: stats.syncError, filter: 'sync_error', className: 'tile-warn' },
        { key: 'untested', value: stats.untested, filter: 'untested', className: 'tile-muted' },
      ]
    : []

  const running = jobs.filter((j) => j.status === 'running')
  const syncingAccounts = accounts.filter((a) => a.status === 'syncing')
  const recent = jobs.filter((j) => j.status !== 'running').slice(0, 5)

  const stopAll = async () => {
    try {
      const r = await api.call('jobs.cancelAll', {})
      notify('info', t('dashboard.stopped', { count: r.cancelled }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <div className="page" data-testid="dashboard">
      <h1>{t('dashboard.title')}</h1>
      <div className="tiles">
        {tiles.map((tile) => (
          <button
            key={tile.key}
            className={`tile ${tile.className}`}
            data-testid={`tile-${tile.key}`}
            data-value={tile.value}
            onClick={() => navigate(`/accounts?filter=${tile.filter}`)}
          >
            <div className="tile-label">{t(`dashboard.${tile.key}`)}</div>
            <div className="tile-value">{tile.value}</div>
          </button>
        ))}
      </div>
      <div className="tiles">
        <button
          className={`tile ${(stats?.needsAttention ?? 0) > 0 ? 'tile-err' : 'tile-ok'}`}
          data-testid="tile-needsAttention"
          data-value={stats?.needsAttention ?? 0}
          onClick={() => navigate('/health')}
        >
          <div className="tile-label">{t('dashboard.needsAttention')}</div>
          <div className="tile-value">{stats?.needsAttention ?? 0}</div>
        </button>
        <button
          className="tile tile-total"
          data-testid="tile-messages"
          data-value={stats?.messages ?? 0}
          onClick={() => navigate('/search')}
        >
          <div className="tile-label">{t('dashboard.messages')}</div>
          <div className="tile-value">{stats?.messages ?? 0}</div>
        </button>
      </div>
      <div className="muted" data-testid="last-test">
        {t('dashboard.lastTest')}: {formatDateTime(stats?.lastTestAt, locale)} ·{' '}
        {t('dashboard.lastSync')}:{' '}
        <span data-testid="last-sync">{formatDateTime(stats?.lastSyncAt, locale)}</span>
      </div>
      <div className="toolbar">
        <AutoSyncToggle />
        <button
          className="btn btn-danger"
          onClick={stopAll}
          data-testid="btn-stop-all"
          disabled={running.length === 0}
        >
          {t('dashboard.stopAll')}
        </button>
      </div>

      <h2>{t('dashboard.runningJob')}</h2>
      {running.length === 0 ? (
        <p className="muted">{t('common.none')}</p>
      ) : (
        running.map((j) => <JobProgress key={j.id} job={j} />)
      )}
      {syncingAccounts.length > 0 && (
        <ul className="sync-progress" data-testid="sync-progress">
          {syncingAccounts.slice(0, 25).map((a) => {
            const p = syncProgress[a.id]
            return (
              <li key={a.id}>
                <span className="mono">{a.email}</span>
                {p ? (
                  <span className="muted">
                    {' '}
                    {p.mailboxPath} {p.fetched} / {p.total}
                  </span>
                ) : (
                  <span className="muted"> …</span>
                )}
              </li>
            )
          })}
          {syncingAccounts.length > 25 && <li className="muted">+{syncingAccounts.length - 25}</li>}
        </ul>
      )}

      <h2>{t('dashboard.recentJobs')}</h2>
      {recent.length === 0 ? (
        <p className="muted">{t('dashboard.noJobs')}</p>
      ) : (
        recent.map((j) => <JobProgress key={j.id} job={j} />)
      )}
    </div>
  )
}
