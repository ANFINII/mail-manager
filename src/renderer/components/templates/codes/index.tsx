import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'hooks/router'
import { useAppStore } from 'stores/app-store'
import type { ReceivedCode } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'
import CodeChip from 'components/parts/CodeChip'

const RANGES = [1, 24, 168, 0]

/** 認証コード: 受信メールから抽出したワンタイムパスワード・確認リンクを新しい順に一覧する */
export default function CodesTemplate() {
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const tick = useAppStore((s) => s.messagesChangedTick)
  const navigate = useNavigate()
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [hours, setHours] = useState(24)
  const [text, setText] = useState('')
  const [items, setItems] = useState<ReceivedCode[]>([])

  const load = useCallback(async () => {
    try {
      setItems(await api.call('codes.list', { sinceHours: hours, text: text.trim() || undefined }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }, [hours, text, notify])

  // 新着・変更のたびに読み直す
  useEffect(() => {
    void load()
  }, [load, tick])

  return (
    <div className="page" data-testid="codes">
      <div className="page-head">
        <h1>{t('codes.title')}</h1>
        <span className="muted">{t('common.count', { count: items.length })}</span>
        <span className="spacer" />
        <button className="btn" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </div>
      <p className="muted">{t('codes.hint')}</p>
      <div className="toolbar">
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} data-testid="codes-range">
          {RANGES.map((h) => (
            <option key={h} value={h}>
              {h === 0 ? t('codes.all') : t('codes.withinHours', { count: h })}
            </option>
          ))}
        </select>
        <input placeholder={t('codes.filter')} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {items.length === 0 ? (
        <p className="empty">{t('codes.empty')}</p>
      ) : (
        <table className="simple-table full" data-testid="codes-list">
          <thead>
            <tr>
              <th>{t('codes.received')}</th>
              <th>{t('codes.account')}</th>
              <th>{t('codes.from')}</th>
              <th>{t('codes.subject')}</th>
              <th>{t('codes.code')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.messageId} className={c.seen ? '' : 'unread'}>
                <td className="nowrap">{formatDateTime(c.receivedAt, locale)}</td>
                <td className="mono">{c.accountEmail}</td>
                <td>{c.from ?? '—'}</td>
                <td>
                  <button className="link" onClick={() => navigate(`/search?accountId=${c.accountId}&messageId=${c.messageId}`)}>
                    {c.subject || t('viewer.noSubject')}
                  </button>
                </td>
                <td>
                  <CodeChip code={c.code} link={c.link} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
