import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { LockStatus } from '@shared/types'
import { api, errorMessage } from 'lib/api'

/** 設定画面: アプリのロック（パスコード・有効化・無操作時間・今すぐロック） */
export default function LockPanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [status, setStatus] = useState<LockStatus | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [idle, setIdle] = useState(10)
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    void api.lock.status().then((s) => {
      setStatus(s)
      setIdle(s.idleMinutes)
      setEnabled(s.enabled)
    })
  }, [])
  if (!status) return null

  const run = async (fn: () => Promise<LockStatus>, done: string) => {
    try {
      const s = await fn()
      setStatus(s)
      setCurrent('')
      setNext('')
      notify('info', done)
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <section data-testid="lock-panel">
      <h2>{t('lock.title')}</h2>
      <p className="muted small">{t('lock.hint')}</p>
      <div className="form">
        {status.hasPasscode && (
          <label>
            {t('lock.currentPasscode')}
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="lock-current" />
          </label>
        )}
        <label>
          {status.hasPasscode ? t('lock.newPasscode') : t('lock.setPasscode')}
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} data-testid="lock-next" />
        </label>
        <button
          className="btn"
          disabled={next.length < 4}
          onClick={() => run(() => api.lock.setPasscode(current || undefined, next), t('lock.passcodeSaved'))}
        >
          {status.hasPasscode ? t('lock.changePasscode') : t('lock.setPasscode')}
        </button>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!status.hasPasscode} />
          {t('lock.enable')}
        </label>
        <label>
          {t('lock.idleMinutes')}
          <input type="number" min={1} max={1440} value={idle} onChange={(e) => setIdle(Number(e.target.value))} />
        </label>
        <div className="toolbar">
          <button
            className="btn btn-primary"
            disabled={!status.hasPasscode}
            onClick={() => run(() => api.lock.configure({ enabled, idleMinutes: idle, passcode: current }), t('settings.saved'))}
          >
            {t('common.save')}
          </button>
          <button className="btn" disabled={!status.enabled || !status.hasPasscode} onClick={() => void api.lock.lockNow()}>
            {t('lock.lockNow')}
          </button>
        </div>
        <p className="muted small">{status.touchId ? t('lock.touchIdAvailable') : t('lock.touchIdUnavailable')}</p>
      </div>
    </section>
  )
}
