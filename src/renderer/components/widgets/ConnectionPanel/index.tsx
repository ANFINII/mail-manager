import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { RemoteConfig } from '@shared/types'
import { api, errorMessage } from 'lib/api'

/** 設定画面: 接続先（このPC のバックエンド / チームで共有するサーバー） */
export default function ConnectionPanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [cfg, setCfg] = useState<RemoteConfig | null>(null)
  const [mode, setMode] = useState<'local' | 'remote'>('local')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.remote.get().then((c) => {
      setCfg(c)
      setMode(c.mode)
      setUrl(c.url)
    })
  }, [])
  if (!cfg) return null

  const test = async () => {
    setBusy(true)
    try {
      const version = await api.remote.test(url, token || undefined)
      notify('info', t('remote.ok', { version }))
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!window.confirm(t('remote.confirmRestart'))) return
    try {
      await api.remote.set({ mode, url, token: token || undefined })
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  return (
    <section data-testid="connection-panel">
      <h2>{t('remote.title')}</h2>
      <p className="muted small">{t('remote.hint')}</p>
      <div className="form">
        <label className="check">
          <input type="radio" checked={mode === 'local'} onChange={() => setMode('local')} /> {t('remote.local')}
        </label>
        <label className="check">
          <input type="radio" checked={mode === 'remote'} onChange={() => setMode('remote')} /> {t('remote.remote')}
        </label>
        {mode === 'remote' && (
          <>
            <label>
              {t('remote.url')}
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mail-manager.example.com" />
            </label>
            <label>
              {t('remote.token')}
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={cfg.hasToken ? t('credentials.keepCurrent') : ''}
              />
            </label>
            <button className="btn" onClick={test} disabled={busy || !url}>
              {t('remote.test')}
            </button>
          </>
        )}
        <div className="toolbar">
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || (mode === cfg.mode && url === cfg.url && !token)}
          >
            {t('remote.saveRestart')}
          </button>
          <span className="muted small">{t(cfg.mode === 'remote' ? 'remote.currentRemote' : 'remote.currentLocal', { url: cfg.url })}</span>
        </div>
      </div>
    </section>
  )
}
