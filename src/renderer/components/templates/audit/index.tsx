import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { AuditEntry } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'

/** 監査ログ: 認証情報の書き出し・削除・ルール変更・ロック解除などの重要な操作を誰がいつ行ったか */
export default function AuditTemplate() {
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [items, setItems] = useState<AuditEntry[]>([])
  const [text, setText] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems(await api.call('audit.list', { text: text.trim() || undefined, failedOnly }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }, [text, failedOnly, notify])
  useEffect(() => {
    void load()
  }, [load])

  const actionLabel = (a: string) => {
    const key = `audit.actions.${a.replace(/\./g, '_')}`
    const label = t(key)
    return label === key ? a : label
  }

  return (
    <div className="page" data-testid="audit">
      <div className="page-head">
        <h1>{t('audit.title')}</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </div>
      <p className="muted">{t('audit.hint')}</p>
      <div className="toolbar">
        <input placeholder={t('audit.filter')} value={text} onChange={(e) => setText(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> {t('audit.failedOnly')}
        </label>
      </div>
      {items.length === 0 ? (
        <p className="empty">{t('audit.empty')}</p>
      ) : (
        <table className="simple-table full" data-testid="audit-list">
          <thead>
            <tr>
              <th>{t('audit.at')}</th>
              <th>{t('audit.actor')}</th>
              <th>{t('audit.action')}</th>
              <th>{t('audit.target')}</th>
              <th>{t('audit.detail')}</th>
              <th>{t('audit.result')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{formatDateTime(e.at, locale)}</td>
                <td className="mono">{e.actor}</td>
                <td>{actionLabel(e.action)}</td>
                <td className="mono">{e.target ?? '—'}</td>
                <td className="muted small mono">{e.detail ? JSON.stringify(e.detail) : ''}</td>
                <td>
                  {e.ok ? (
                    <span className="badge sev-info">{t('audit.ok')}</span>
                  ) : (
                    <span className="badge sev-critical" title={e.error ?? ''}>
                      {t('audit.failed')}
                    </span>
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
