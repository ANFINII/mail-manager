import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage, setLanguage, type Language } from 'i18n/index'
import { useAppStore } from 'stores/app-store'
import type { ForwardTarget } from '@shared/types'
import type { Settings } from '@shared/types'
import { api, errorMessage } from 'lib/api'

export default function SettingsTemplate() {
  const { t } = useTranslation()
  const settings = useAppStore((s) => s.settings)
  const info = useAppStore((s) => s.info)
  const notify = useAppStore((s) => s.notify)
  const refreshSettings = useAppStore((s) => s.refreshSettings)
  const [form, setForm] = useState<Settings | null>(settings)
  const [lang, setLang] = useState<Language>(currentLanguage())
  const [targets, setTargets] = useState<ForwardTarget[]>([])
  const [newAddr, setNewAddr] = useState('')
  const [newLabel, setNewLabel] = useState('')

  useEffect(() => {
    api
      .call('forwardTargets.list', {})
      .then(setTargets)
      .catch(() => undefined)
  }, [])

  const addTarget = async () => {
    if (!newAddr.trim()) return
    try {
      setTargets(
        await api.call('forwardTargets.add', {
          address: newAddr.trim(),
          label: newLabel.trim() || undefined,
        }),
      )
      setNewAddr('')
      setNewLabel('')
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const removeTarget = async (id: string) => {
    try {
      setTargets(await api.call('forwardTargets.remove', { id }))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  if (!form) return <div className="page">{t('common.loading')}</div>

  const save = async () => {
    try {
      await api.call('settings.update', form)
      await refreshSettings()
      setLanguage(lang)
      notify('info', t('settings.saved'))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  const num = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: Number(e.target.value) })

  const withDialog = async (fn: () => Promise<string>) => {
    try {
      const msg = await fn()
      if (msg) notify('info', msg)
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }
  const exportAccounts = () =>
    withDialog(async () => {
      const p = await api.saveFileDialog({
        title: t('settings.exportAccounts'),
        defaultName: 'accounts.csv',
        extensions: ['csv'],
      })
      if (!p) return ''
      const r = await api.call('accounts.exportCsv', { path: p })
      await api.showItemInFolder(p)
      return t('settings.exported', { count: r.count })
    })
  const backup = () =>
    withDialog(async () => {
      const p = await api.saveFileDialog({
        title: t('settings.backup'),
        defaultName: `mail-manager-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
        extensions: ['sqlite'],
      })
      if (!p) return ''
      const r = await api.call('app.backup', { path: p })
      await api.showItemInFolder(r.path)
      return t('settings.backupDone')
    })
  const restore = () =>
    withDialog(async () => {
      const p = await api.openFileDialog({ title: t('settings.restore'), extensions: ['sqlite'] })
      if (!p) return ''
      if (!window.confirm(t('settings.restoreConfirm'))) return ''
      await api.call('app.restore', { path: p })
      return t('settings.restoreScheduled')
    })

  return (
    <div className="page" data-testid="settings">
      <h1>{t('settings.title')}</h1>
      <div className="form">
        <label>
          {t('settings.authConcurrency')}
          <input
            type="number"
            min={1}
            max={100}
            value={form.authConcurrency}
            onChange={num('authConcurrency')}
            data-testid="auth-concurrency"
          />
        </label>
        <label>
          {t('settings.maxRetries')}
          <input
            type="number"
            min={0}
            max={10}
            value={form.maxRetries}
            onChange={num('maxRetries')}
          />
        </label>
        <label>
          {t('settings.connectTimeout')}
          <input
            type="number"
            min={1000}
            max={120000}
            step={1000}
            value={form.connectTimeoutMs}
            onChange={num('connectTimeoutMs')}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.tlsRejectUnauthorized}
            onChange={(e) => setForm({ ...form, tlsRejectUnauthorized: e.target.checked })}
          />
          {t('settings.tlsVerify')}
        </label>
        <h2>{t('settings.syncSection')}</h2>
        <label>
          {t('settings.syncConcurrency')}
          <input
            type="number"
            min={1}
            max={100}
            value={form.syncConcurrency}
            onChange={num('syncConcurrency')}
            data-testid="sync-concurrency"
          />
        </label>
        <label>
          {t('settings.syncFolders')}
          <select
            value={form.syncFolders}
            onChange={(e) =>
              setForm({ ...form, syncFolders: e.target.value as Settings['syncFolders'] })
            }
          >
            <option value="inbox">{t('settings.syncFoldersInbox')}</option>
            <option value="all">{t('settings.syncFoldersAll')}</option>
          </select>
        </label>
        <label>
          {t('settings.initialSyncMessages')}
          <input
            type="number"
            min={0}
            max={1000000}
            value={form.initialSyncMessages}
            onChange={num('initialSyncMessages')}
          />
        </label>
        <label>
          {t('settings.maxMessageMb')}
          <input
            type="number"
            min={1}
            max={100}
            value={Math.round(form.maxMessageBytes / 1024 / 1024)}
            onChange={(e) =>
              setForm({ ...form, maxMessageBytes: Number(e.target.value) * 1024 * 1024 })
            }
          />
        </label>
        <label>
          {t('settings.autoSync')}
          <input
            type="number"
            min={0}
            max={1440}
            value={form.autoSyncIntervalMin}
            onChange={num('autoSyncIntervalMin')}
          />
        </label>
        <label>
          {t('settings.autoSyncSec')}
          <input
            type="number"
            min={0}
            max={86400}
            value={form.autoSyncIntervalSec}
            onChange={num('autoSyncIntervalSec')}
            data-testid="settings-auto-sync-sec"
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.autoSyncOnAuth}
            onChange={(e) => setForm({ ...form, autoSyncOnAuth: e.target.checked })}
            data-testid="settings-auto-sync-on-auth"
          />
          {t('settings.autoSyncOnAuth')}
        </label>
        <p className="muted small" data-testid="settings-auto-sync-note">
          {t('settings.autoSyncNote')}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={form.notifyNewMail}
            onChange={(e) => setForm({ ...form, notifyNewMail: e.target.checked })}
          />
          {t('settings.notifyNewMail')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.storeAttachments}
            onChange={(e) => setForm({ ...form, storeAttachments: e.target.checked })}
          />
          {t('settings.storeAttachments')}
        </label>
        <label>
          {t('settings.webhookUrl')}
          <input
            value={form.webhookUrl}
            onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
            placeholder="https://example.com/hook"
          />
        </label>
        <label>
          {t('settings.language')}
          <select value={lang} onChange={(e) => setLang(e.target.value as Language)}>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </label>
        <div className="toolbar">
          <button className="btn btn-primary" onClick={save} data-testid="btn-save-settings">
            {t('common.save')}
          </button>
        </div>
      </div>

      <section data-testid="forward-targets">
        <h2>{t('settings.forwardTargetsSection')}</h2>
        <p className="muted small">{t('settings.forwardTargetsHint')}</p>
        <div className="form-row">
          <input
            placeholder={t('settings.forwardTargetAddress')}
            value={newAddr}
            onChange={(e) => setNewAddr(e.target.value)}
            data-testid="forward-target-address"
          />
          <input
            placeholder={t('settings.forwardTargetLabel')}
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button
            className="btn"
            onClick={addTarget}
            disabled={!newAddr.trim()}
            data-testid="forward-target-add"
          >
            {t('settings.forwardTargetAdd')}
          </button>
        </div>
        {targets.length === 0 ? (
          <p className="muted">{t('settings.forwardTargetsEmpty')}</p>
        ) : (
          <table className="simple-table" data-testid="forward-target-list">
            <tbody>
              {targets.map((tg) => (
                <tr key={tg.id}>
                  <td>{tg.label || '—'}</td>
                  <td>{tg.address}</td>
                  <td>
                    <button className="link" onClick={() => removeTarget(tg.id)}>
                      {t('settings.forwardTargetRemove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>{t('settings.dataSection')}</h2>
        <div className="toolbar">
          <button className="btn" onClick={exportAccounts}>
            {t('settings.exportAccounts')}
          </button>
          <button className="btn" onClick={backup}>
            {t('settings.backup')}
          </button>
          <button className="btn" onClick={restore}>
            {t('settings.restore')}
          </button>
        </div>
        <p className="muted small">{t('settings.dataHint')}</p>
      </section>

      {info && (
        <section>
          <h2>{t('settings.info')}</h2>
          <dl className="props">
            <div className="prop">
              <dt>{t('settings.version')}</dt>
              <dd>{info.version}</dd>
            </div>
            <div className="prop">
              <dt>{t('settings.dbPath')}</dt>
              <dd>
                <code>{info.dbPath}</code>{' '}
                <button className="link" onClick={() => api.showItemInFolder(info.dbPath)}>
                  {t('settings.showInFinder')}
                </button>
              </dd>
            </div>
            <div className="prop">
              <dt>{t('settings.logPath')}</dt>
              <dd>
                <code>{info.logPath}</code>{' '}
                <button className="link" onClick={() => api.showItemInFolder(info.logPath)}>
                  {t('settings.showInFinder')}
                </button>
              </dd>
            </div>
            <div className="prop">
              <dt>{t('settings.keyMode')}</dt>
              <dd className={info.keyMode === 'insecure-file' ? 'warn' : ''}>
                {t(`keyMode.${info.keyMode}`)}
              </dd>
            </div>
            {info.envOverrides.length > 0 && (
              <div className="prop">
                <dt>{t('settings.envOverrides')}</dt>
                <dd className="warn">
                  {t('settings.envWarning')}: <code>{info.envOverrides.join(', ')}</code>
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </div>
  )
}
