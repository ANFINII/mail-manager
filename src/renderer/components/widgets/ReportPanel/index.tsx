import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import { api, errorMessage } from 'lib/api'

/** 日次レポートの設定・プレビュー・今すぐ送信 */
export default function ReportPanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const settings = useAppStore((s) => s.settings)
  const accounts = useAppStore((s) => s.accounts)
  const refreshSettings = useAppStore((s) => s.refreshSettings)
  const notify = useAppStore((s) => s.notify)
  const [form, setForm] = useState(() =>
    settings
      ? {
          reportTime: settings.reportTime,
          reportTo: settings.reportTo,
          reportFromAccountId: settings.reportFromAccountId,
          reportWebhook: settings.reportWebhook,
        }
      : null,
  )
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!form) return null

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    run(async () => {
      await api.call('settings.update', form)
      await refreshSettings()
      notify('info', t('settings.saved'))
    })
  const showPreview = () =>
    run(async () => {
      const r = await api.call('report.preview', {})
      setPreview(`${r.subject}\n\n${r.text}`)
    })
  const sendNow = () =>
    run(async () => {
      await api.call('settings.update', form)
      const r = await api.call('report.send', {})
      notify('info', t('report.sent', { via: [r.email && t('report.viaEmail'), r.webhook && 'Webhook'].filter(Boolean).join(' / ') }))
    })

  return (
    <section data-testid="report">
      <h2>{t('report.title')}</h2>
      <p className="muted small">{t('report.hint')}</p>
      <div className="form">
        <label>
          {t('report.time')}
          <input type="time" value={form.reportTime} onChange={(e) => setForm({ ...form, reportTime: e.target.value })} data-testid="report-time" />
        </label>
        <label>
          {t('report.to')}
          <input value={form.reportTo} onChange={(e) => setForm({ ...form, reportTo: e.target.value })} placeholder="you@example.com" />
        </label>
        <label>
          {t('report.from')}
          <select value={form.reportFromAccountId} onChange={(e) => setForm({ ...form, reportFromAccountId: e.target.value })}>
            <option value="">{t('report.chooseFrom')}</option>
            {accounts
              .filter((a) => a.authStatus === 'ok')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.reportWebhook} onChange={(e) => setForm({ ...form, reportWebhook: e.target.checked })} />
          {t('report.webhook')}
        </label>
      </div>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {t('common.save')}
        </button>
        <button className="btn" onClick={showPreview} disabled={busy} data-testid="report-preview">
          {t('report.preview')}
        </button>
        <button className="btn" onClick={sendNow} disabled={busy}>
          {t('report.sendNow')}
        </button>
      </div>
      {preview && <pre className="report-preview">{preview}</pre>}
    </section>
  )
}
