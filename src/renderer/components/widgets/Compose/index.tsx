import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { AccountSummary } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import Button from 'components/parts/Button'
import Modal from 'components/parts/Modal'

interface Props {
  accounts: AccountSummary[]
  defaultAccountId?: string
  onClose: (sent: boolean) => void
}

/** 新規メールを作成して送信するダイアログ。送信元アカウントを選び、宛先・件名・本文を入力する。 */
export default function Compose(props: Props): React.JSX.Element {
  const { accounts, defaultAccountId, onClose } = props
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  // 送信元は認証済み（送信できる可能性がある）アカウントを優先
  const sendable = accounts.filter((a) => a.authStatus === 'ok')
  const [accountId, setAccountId] = useState(defaultAccountId || sendable[0]?.id || accounts[0]?.id || '')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!accountId || !to.trim()) return
    setBusy(true)
    try {
      const r = await api.call('messages.send', { accountId, to: to.trim(), subject, text: body })
      notify('info', r.savedToSent ? t('compose.sentSaved') : t('compose.sentNoSave'))
      onClose(true)
    } catch (err) {
      notify('error', errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal wide data-testid="compose-dialog" onBackdropClick={() => onClose(false)}>
      <h2>{t('compose.title')}</h2>
      <label className="field-block">
        {t('compose.from')}
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} data-testid="compose-from">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
              {a.authStatus === 'ok' ? '' : t('compose.notAuthenticated')}
            </option>
          ))}
        </select>
      </label>
      <label className="field-block">
        {t('compose.to')}
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="dest@example.com" data-testid="compose-to" autoFocus />
      </label>
      <label className="field-block">
        {t('compose.subject')}
        <input value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="compose-subject" />
      </label>
      <label className="field-block">
        {t('compose.body')}
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} data-testid="compose-body" />
      </label>
      <p className="muted small">{t('compose.note')}</p>
      <div className="toolbar">
        <Button variant="primary" onClick={send} disabled={busy || !accountId || !to.trim()}>
          {t('compose.send')}
        </Button>
        <Button onClick={() => onClose(false)} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  )
}
