import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LockStatus } from '@shared/types'
import { api, errorMessage } from 'lib/api'

/** ロック画面（ロック中は他の画面を描画しない） */
export default function LockScreen({ status }: { status: LockStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const unlock = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.lock.unlock(passcode)
    } catch (err) {
      setError(errorMessage(err))
      setPasscode('')
    } finally {
      setBusy(false)
    }
  }
  const touchId = async () => {
    setError(null)
    try {
      await api.lock.touchId()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  // Touch ID が使えるなら最初に一度だけ促す
  useEffect(() => {
    if (status.touchId) void touchId()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="lock-screen" data-testid="lock-screen">
      <div className="lock-box">
        <div className="lock-icon">🔒</div>
        <h1>{t('lock.locked')}</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void unlock()
          }}
        >
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder={t('lock.passcode')}
            autoFocus
            disabled={busy}
            data-testid="lock-passcode"
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !passcode}>
            {t('lock.unlock')}
          </button>
        </form>
        {status.touchId && (
          <button className="btn" onClick={touchId} type="button">
            {t('lock.touchId')}
          </button>
        )}
        {error && <p className="warn">{error}</p>}
      </div>
    </div>
  )
}
