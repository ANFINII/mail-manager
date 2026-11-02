import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { ForwardTarget } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import Button from 'components/parts/Button'
import Modal from 'components/parts/Modal'

interface Props {
  /** 転送対象の説明（例: "3 件を転送" / "検索結果 全 120 件を転送"） */
  title: string
  onCancel: () => void
  onConfirm: (to: string) => Promise<void>
}

/** 保存済みの転送先から選ぶか、直接入力して転送するダイアログ。 */
export default function Forward(props: Props): React.JSX.Element {
  const { title, onCancel, onConfirm } = props
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [targets, setTargets] = useState<ForwardTarget[]>([])
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .call('forwardTargets.list', {})
      .then(setTargets)
      .catch(() => undefined)
  }, [])

  const confirm = async () => {
    if (!to.trim()) return
    setBusy(true)
    try {
      await onConfirm(to.trim())
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal data-testid="forward-dialog" onBackdropClick={onCancel}>
      <h2>{t('forward.title')}</h2>
      <p className="muted">{title}</p>
      {targets.length > 0 && (
        <label className="field-block">
          {t('forward.savedTargets')}
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setTo(e.target.value)
            }}
            data-testid="forward-target-select"
          >
            <option value="">{t('forward.choose')}</option>
            {targets.map((tg) => (
              <option key={tg.id} value={tg.address}>
                {tg.label ? `${tg.label} <${tg.address}>` : tg.address}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field-block">
        {t('forward.destination')}
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="dest@example.com" data-testid="forward-to" autoFocus />
      </label>
      <p className="muted small">{t('forward.dedupNote')}</p>
      <div className="toolbar">
        <Button variant="primary" onClick={confirm} disabled={busy || !to.trim()}>
          {t('forward.send')}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  )
}
