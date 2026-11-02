import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionMetrics } from '@shared/types'
import { api } from 'lib/api'
import { formatDateTime } from 'utils/format'
import MiniBarChart from 'components/parts/MiniBarChart'

/** 接続状況: IMAP の同時接続数、1 分ごとの接続数・スロットリング、ホスト別の集計、直近のエラー */
export default function ConnectionsTemplate() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [m, setM] = useState<ConnectionMetrics | null>(null)
  const [idle, setIdle] = useState<{ connected: number; watching: number } | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [metrics, idleStatus] = await Promise.all([api.call('metrics.get', {}), api.call('idle.status', {})])
        if (!alive) return
        setM(metrics)
        setIdle(idleStatus)
      } catch {
        // バックエンドの再起動中などは次回に読み直す
      }
    }
    void load()
    const timer = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (!m) return <div className="page">{t('common.loading')}</div>
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  const throttledTotal = m.series.reduce((n, b) => n + b.throttled, 0)

  return (
    <div className="page" data-testid="connections">
      <h1>{t('connections.title')}</h1>
      <p className="muted">{t('connections.hint')}</p>
      <div className="tiles">
        <div className="tile tile-info" data-testid="tile-open">
          <div className="tile-label">{t('connections.open')}</div>
          <div className="tile-value">{m.open}</div>
        </div>
        <div className="tile tile-total">
          <div className="tile-label">{t('connections.peak')}</div>
          <div className="tile-value">{m.peak}</div>
        </div>
        {idle && (
          <div className="tile tile-total">
            <div className="tile-label">{t('connections.idle')}</div>
            <div className="tile-value">
              {idle.connected}
              <span className="muted small"> / {idle.watching}</span>
            </div>
          </div>
        )}
        <div className={`tile ${throttledTotal > 0 ? 'tile-warn' : 'tile-ok'}`}>
          <div className="tile-label">{t('connections.throttled60')}</div>
          <div className="tile-value">{throttledTotal}</div>
        </div>
      </div>

      <div className="chart-row">
        <MiniBarChart
          title={t('connections.connectsPerMin')}
          points={m.series.map((b) => ({ label: time(b.at), value: b.connects }))}
          color="var(--primary)"
          unit={t('connections.times')}
          startLabel={t('connections.ago60')}
          endLabel={t('connections.now')}
          data-testid="chart-connects"
        />
        <MiniBarChart
          title={t('connections.throttledPerMin')}
          points={m.series.map((b) => ({ label: time(b.at), value: b.throttled }))}
          color="var(--warn)"
          unit={t('connections.times')}
          startLabel={t('connections.ago60')}
          endLabel={t('connections.now')}
        />
      </div>

      <h2>{t('connections.byHost')}</h2>
      {m.hosts.length === 0 ? (
        <p className="muted">{t('common.none')}</p>
      ) : (
        <table className="simple-table" data-testid="hosts">
          <thead>
            <tr>
              <th>{t('connections.host')}</th>
              <th>{t('connections.open')}</th>
              <th>{t('connections.peak')}</th>
              <th>{t('connections.connects')}</th>
              <th>{t('connections.failures')}</th>
              <th>{t('connections.throttled')}</th>
              <th>{t('connections.sends')}</th>
              <th>{t('connections.sendFailures')}</th>
            </tr>
          </thead>
          <tbody>
            {m.hosts.map((h) => (
              <tr key={h.host}>
                <td className="mono">{h.host}</td>
                <td>{h.open}</td>
                <td>{h.peak}</td>
                <td>{h.connects}</td>
                <td>{h.failures}</td>
                <td className={h.throttled > 0 ? 'warn' : ''}>{h.throttled}</td>
                <td>{h.sends}</td>
                <td>{h.sendFailures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{t('connections.events')}</h2>
      {m.events.length === 0 ? (
        <p className="muted">{t('common.none')}</p>
      ) : (
        <table className="simple-table full">
          <tbody>
            {m.events.map((e, i) => (
              <tr key={i}>
                <td className="nowrap">{formatDateTime(e.at, locale)}</td>
                <td>
                  <span className={`badge ${e.kind === 'throttled' ? 'sev-warning' : 'sev-critical'}`}>{t(`connections.kind.${e.kind}`)}</span>
                </td>
                <td className="mono">{e.host}</td>
                <td className="mono">{e.account}</td>
                <td className="cell-error" title={e.message}>
                  {e.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
