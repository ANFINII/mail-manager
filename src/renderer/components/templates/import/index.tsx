import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'hooks/router'
import { useAppStore } from 'stores/app-store'
import type { ImportResult, ImportRowError } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDuration } from 'utils/format'
import OAuthLogin from 'components/widgets/OAuthLogin'

type Edits = Record<number, Record<string, string>>;

const NEW_GROUP = '__new__'
const PROVIDERS = ['', 'outlook', 'gmail', 'custom']
const AUTH_TYPES = ['', 'password', 'oauth2']
const SECURE = ['', 'tls', 'starttls', 'none']

export default function ImportTemplate() {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const refreshAccounts = useAppStore((s) => s.refreshAccounts)
  const groups = useAppStore((s) => s.groups)
  const [path, setPath] = useState('')
  // 取り込むアカウントを入れるグループ: '' = なし / '__new__' = 新規作成 / それ以外はグループ ID
  const [groupChoice, setGroupChoice] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  // 既存アカウント（同じメールアドレス）の認証情報を更新するか
  const [updateExisting, setUpdateExisting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [edits, setEdits] = useState<Edits>({})
  const [showHelp, setShowHelp] = useState(false)
  const [oauthOpen, setOauthOpen] = useState(false)
  const navigate = useNavigate()

  const browse = async () => {
    const p = await api.openCsvDialog()
    if (p) setPath(p)
  }

  const runImport = async () => {
    if (!path.trim()) {
      notify('error', t('import.noPath'))
      return
    }
    if (groupChoice === NEW_GROUP && !newGroupName.trim()) {
      notify('error', t('groups.nameRequired'))
      return
    }
    setBusy(true)
    try {
      let groupId: string | null = groupChoice && groupChoice !== NEW_GROUP ? groupChoice : null
      if (groupChoice === NEW_GROUP) {
        const name = newGroupName.trim()
        const list = await api.call('groups.create', { name })
        const created = list.find((g) => g.name.toLowerCase() === name.toLowerCase())
        if (!created) throw new Error(t('groups.nameRequired'))
        groupId = created.id
        setGroupChoice(groupId)
        setNewGroupName('')
      }
      const r = await api.call('accounts.importCsv', { path: path.trim(), groupId, updateExisting })
      setResult(r)
      setEdits({})
      notify('info', r.updated > 0 ? t('import.doneUpdated', { count: r.imported, updated: r.updated }) : t('import.done', { count: r.imported }))
      await refreshAccounts()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const retry = async () => {
    if (!result) return
    const rows = Object.entries(edits)
      .filter(([, fields]) => Object.values(fields).some((v) => v !== ''))
      .map(([row, fields]) => ({ row: Number(row), fields }))
    if (rows.length === 0) return
    setBusy(true)
    try {
      const r = await api.call('accounts.retryImport', {
        sessionId: result.sessionId,
        edits: rows,
      })
      setResult({ ...r, source: result.source })
      setEdits({})
      notify('info', t('import.done', { count: r.imported }))
      await refreshAccounts()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    if (!result) return
    try {
      await api.call('accounts.discardImport', { sessionId: result.sessionId })
    } catch {
      // セッションが既に無い場合も画面はクリアする
    }
    setResult(null)
    setEdits({})
  }

  const setEdit = (row: number, key: string, value: string) =>
    setEdits((prev) => ({ ...prev, [row]: { ...(prev[row] ?? {}), [key]: value } }))
  const val = (r: ImportRowError, key: keyof ImportRowError['fields']) => {
    const e = edits[r.row]?.[key]
    if (e !== undefined) return e
    const v = r.fields[key]
    return typeof v === 'string' ? v : ''
  }

  return (
    <div className="page" data-testid="import">
      <div className="page-head">
        <h1>{t('import.title')}</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => setOauthOpen(true)} data-testid="btn-oauth-login">
          {t('oauthLogin.open')}
        </button>
      </div>
      {oauthOpen && (
        <OAuthLogin
          onClose={(id) => {
            setOauthOpen(false)
            if (id) navigate(`/accounts/${id}`)
          }}
        />
      )}
      <div className="form-row">
        <label htmlFor="csv-path">{t('import.path')}</label>
        <input
          id="csv-path"
          className="grow"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          data-testid="csv-path"
          placeholder="/path/to/accounts.csv"
        />
        <button className="btn" onClick={browse} disabled={busy}>
          {t('import.browse')}
        </button>
        <button
          className="btn btn-primary"
          onClick={runImport}
          disabled={busy}
          data-testid="btn-run-import"
        >
          {busy ? t('import.running') : t('import.run')}
        </button>
      </div>
      <div className="form-row">
        <label htmlFor="import-group">{t('import.group')}</label>
        <select
          id="import-group"
          value={groupChoice}
          onChange={(e) => setGroupChoice(e.target.value)}
          data-testid="import-group"
          disabled={busy}
        >
          <option value="">{t('import.groupNone')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.accountCount})
            </option>
          ))}
          <option value={NEW_GROUP}>{t('import.newGroup')}</option>
        </select>
        {groupChoice === NEW_GROUP && (
          <input
            className="grow"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder={t('import.newGroupName')}
            data-testid="import-group-name"
            disabled={busy}
          />
        )}
        <span className="muted small">{t('import.groupHint')}</span>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={updateExisting}
          onChange={(e) => setUpdateExisting(e.target.checked)}
          data-testid="import-update-existing"
          disabled={busy}
        />
        {t('import.updateExisting')}
      </label>
      <p className="muted small">{t('import.updateExistingHint')}</p>
      <button className="link" onClick={() => setShowHelp((v) => !v)}>
        {t('import.formatHelp')} {showHelp ? '▴' : '▾'}
      </button>
      {showHelp && <pre className="help">{t('import.formatDetails')}</pre>}

      {result && (
        <section className="result" data-testid="import-result">
          <h2>{t('import.result')}</h2>
          <div className="summary">
            <span>
              {t('import.source')}: <b>{result.source}</b>
            </span>
            <span>
              {t('import.imported')}: <b data-testid="import-imported">{result.imported}</b>
            </span>
            <span>
              {t('import.updated')}: <b data-testid="import-updated">{result.updated}</b>
            </span>
            <span>
              {t('import.invalid')}: <b data-testid="import-invalid">{result.invalid.length}</b>
            </span>
            <span>
              {t('import.duration')}: <b>{formatDuration(result.durationMs)}</b>
            </span>
          </div>

          {result.invalid.length > 0 && (
            <>
              <h3>{t('import.fixTitle')}</h3>
              <p className="muted">{t('import.fixHint')}</p>
              <div className="fix-table-wrap">
                <table className="fix-table">
                  <thead>
                    <tr>
                      <th>{t('import.row')}</th>
                      <th>{t('import.errors')}</th>
                      <th>email</th>
                      <th>group</th>
                      <th>provider</th>
                      <th>auth_type</th>
                      <th>password</th>
                      <th>client_id</th>
                      <th>client_secret</th>
                      <th>refresh_token</th>
                      <th>imap_host</th>
                      <th>imap_port</th>
                      <th>imap_secure</th>
                      <th>proxy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.invalid.map((r) => (
                      <tr key={r.row} data-testid="invalid-row">
                        <td>{r.row}</td>
                        <td className="errors">
                          {r.errors.map((code) => (
                            <div key={code}>{t(`importError.${code}`)}</div>
                          ))}
                        </td>
                        <td>
                          <input
                            value={val(r, 'email')}
                            onChange={(e) => setEdit(r.row, 'email', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            value={val(r, 'group')}
                            onChange={(e) => setEdit(r.row, 'group', e.target.value)}
                          />
                        </td>
                        <td>
                          <select
                            value={val(r, 'provider')}
                            onChange={(e) => setEdit(r.row, 'provider', e.target.value)}
                          >
                            {PROVIDERS.map((p) => (
                              <option key={p} value={p}>
                                {p || '(auto)'}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            value={val(r, 'auth_type')}
                            onChange={(e) => setEdit(r.row, 'auth_type', e.target.value)}
                          >
                            {AUTH_TYPES.map((p) => (
                              <option key={p} value={p}>
                                {p || '(auto)'}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={val(r, 'password')}
                            onChange={(e) => setEdit(r.row, 'password', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            value={val(r, 'client_id')}
                            onChange={(e) => setEdit(r.row, 'client_id', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={val(r, 'client_secret')}
                            onChange={(e) => setEdit(r.row, 'client_secret', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={val(r, 'refresh_token')}
                            onChange={(e) => setEdit(r.row, 'refresh_token', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            value={val(r, 'imap_host')}
                            onChange={(e) => setEdit(r.row, 'imap_host', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="narrow"
                            value={val(r, 'imap_port')}
                            onChange={(e) => setEdit(r.row, 'imap_port', e.target.value)}
                          />
                        </td>
                        <td>
                          <select
                            value={val(r, 'imap_secure')}
                            onChange={(e) => setEdit(r.row, 'imap_secure', e.target.value)}
                          >
                            {SECURE.map((p) => (
                              <option key={p} value={p}>
                                {p || '(auto)'}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            value={val(r, 'proxy')}
                            onChange={(e) => setEdit(r.row, 'proxy', e.target.value)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="toolbar">
                <button
                  className="btn btn-primary"
                  onClick={retry}
                  disabled={busy}
                  data-testid="btn-retry-import"
                >
                  {t('import.retry')}
                </button>
                <button className="btn" onClick={discard} disabled={busy}>
                  {t('import.discard')}
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}
