import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { MailOpSummary } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'

/** 操作履歴: 削除・移動・既読・スターの一括操作（手動・ルール）を一覧し、元に戻す */
export default function HistoryTemplate() {
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const jobs = useAppStore((s) => s.jobs)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [ops, setOps] = useState<MailOpSummary[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const lastJob = jobs.find((j) => j.type === 'mail_op')?.status

  const load = useCallback(async () => {
    try {
      setOps(await api.call('history.list', {}))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }, [notify])
  useEffect(() => {
    void load()
  }, [load, lastJob])

  const undo = async (op: MailOpSummary) => {
    if (!window.confirm(t('history.confirm', { count: op.undoable }))) return
    setBusy(op.id)
    try {
      const r = await api.call('history.undo', { id: op.id })
      notify(
        r.failed > 0 ? 'error' : 'info',
        t('history.done', { restored: r.restored, skipped: r.skipped, failed: r.failed }),
      )
      await load()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page" data-testid="history">
      <div className="page-head">
        <h1>{t('history.title')}</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </div>
      <p className="muted">{t('history.hint')}</p>
      {ops.length === 0 ? (
        <p className="empty">{t('history.empty')}</p>
      ) : (
        <table className="simple-table full" data-testid="history-list">
          <thead>
            <tr>
              <th>{t('history.when')}</th>
              <th>{t('history.what')}</th>
              <th>{t('history.by')}</th>
              <th>{t('history.count')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ops.map((op) => (
              <tr key={op.id} className={op.undoneAt ? 'muted' : ''}>
                <td className="nowrap">{formatDateTime(op.createdAt, locale)}</td>
                <td>
                  {t(`history.kind.${op.kind}`)}
                  {op.label && <span className="muted"> · {op.label}</span>}
                </td>
                <td>{t(`history.source.${op.source}`)}</td>
                <td>
                  {op.items}
                  {op.undoable < op.items && (
                    <span className="muted small"> {t('history.notUndoable', { count: op.items - op.undoable })}</span>
                  )}
                </td>
                <td>
                  {op.undoneAt ? (
                    <span className="muted small">{t('history.undone', { at: formatDateTime(op.undoneAt, locale) })}</span>
                  ) : (
                    <button
                      className="btn btn-small"
                      onClick={() => undo(op)}
                      disabled={busy !== null || op.undoable === 0}
                      data-testid="btn-undo"
                    >
                      {t('history.undo')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
