import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import { replySubject } from '@shared/template'
import type { MessageDetail } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'
import Button from 'components/parts/Button'
import Modal from 'components/parts/Modal'
import TemplatePicker from 'components/widgets/TemplatePicker'

/** 受信メールへの返信（全員に返信・引用・定型文） */
export default function Reply(props: {
  message: MessageDetail
  replyAll: boolean
  onClose: (sent: boolean) => void
}): React.JSX.Element {
  const { message: m, replyAll, onClose } = props
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [body, setBody] = useState('')
  const [quote, setQuote] = useState(true)
  const [busy, setBusy] = useState(false)
  const self = m.accountEmail.toLowerCase()
  const sender = m.fromName || m.fromAddress || ''
  const others = replyAll
    ? [...m.toAddresses, ...m.ccAddresses].filter(
        (a) => a.address.toLowerCase() !== self && a.address.toLowerCase() !== (m.fromAddress ?? '').toLowerCase(),
      )
    : []

  const send = async () => {
    setBusy(true)
    try {
      const r = await api.call('messages.reply', {
        id: m.id,
        text: body,
        replyAll,
        quote,
        quoteHeader: t('reply.quoteHeader', { date: formatDateTime(m.date, locale), from: sender }),
      })
      notify('info', r.savedToSent ? t('compose.sentSaved') : t('compose.sentNoSave'))
      onClose(true)
    } catch (err) {
      notify('error', errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal wide data-testid="reply-dialog" onBackdropClick={() => !busy && onClose(false)}>
      <h2>{replyAll ? t('reply.titleAll') : t('reply.title')}</h2>
      <dl className="props compact">
        <div className="prop">
          <dt>{t('compose.from')}</dt>
          <dd className="mono">{m.accountEmail}</dd>
        </div>
        <div className="prop">
          <dt>{t('compose.to')}</dt>
          <dd>{m.fromAddress}</dd>
        </div>
        {others.length > 0 && (
          <div className="prop">
            <dt>Cc</dt>
            <dd>{others.map((a) => a.address).join(', ')}</dd>
          </div>
        )}
        <div className="prop">
          <dt>{t('compose.subject')}</dt>
          <dd>{replySubject(m.subject)}</dd>
        </div>
      </dl>
      <TemplatePicker
        vars={{
          account: m.accountEmail,
          to: m.fromAddress ?? '',
          from: m.fromAddress ?? '',
          from_name: m.fromName ?? m.fromAddress ?? '',
          subject: m.subject,
          date: formatDateTime(new Date().toISOString(), locale),
          original_date: formatDateTime(m.date, locale),
        }}
        onPick={(_subject, text) => setBody(text)}
      />
      <label className="field-block">
        {t('compose.body')}
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} autoFocus data-testid="reply-body" />
      </label>
      <label className="check">
        <input type="checkbox" checked={quote} onChange={(e) => setQuote(e.target.checked)} /> {t('reply.quote')}
      </label>
      <div className="toolbar">
        <Button variant="primary" onClick={send} disabled={busy || !body.trim()} data-testid="reply-send">
          {t('compose.send')}
        </Button>
        <Button onClick={() => onClose(false)} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  )
}
