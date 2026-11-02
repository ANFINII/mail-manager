import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { AccountDetail, AuthType } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import Button from 'components/parts/Button'
import Modal from 'components/parts/Modal'

interface Props {
  account: AccountDetail
  onClose: (saved: boolean) => void
}

/**
 * アカウント詳細から認証情報（パスワード / OAuth2 の client_id・client_secret・refresh_token）を修正するダイアログ。
 * 秘密値は空欄のままなら現在の値を維持する。保存後は認証テストを自動で実行する。
 */
export default function CredentialsEditor(props: Props): React.JSX.Element {
  const { account, onClose } = props
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [authType, setAuthType] = useState<AuthType>(account.authType)
  const [password, setPassword] = useState('')
  const [clientId, setClientId] = useState(account.oauthClientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [reveal, setReveal] = useState(false)
  const [testAfterSave, setTestAfterSave] = useState(true)
  const [busy, setBusy] = useState(false)

  const switching = authType !== account.authType
  const canSave =
    authType === 'password'
      ? password.trim().length > 0 || (!switching && account.hasPassword)
      : clientId.trim().length > 0 &&
        (refreshToken.trim().length > 0 || (!switching && account.hasRefreshToken))

  const save = async () => {
    setBusy(true)
    try {
      await api.call('accounts.updateCredentials', {
        id: account.id,
        update: {
          authType,
          password: password || undefined,
          clientId: clientId.trim() || undefined,
          clientSecret: clientSecret || undefined,
          refreshToken: refreshToken.trim() || undefined,
          testAfterSave,
        },
      })
      notify('info', testAfterSave ? t('credentials.savedAndTesting') : t('credentials.saved'))
      onClose(true)
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const secretType = reveal ? 'text' : 'password'

  return (
    <Modal data-testid="credentials-dialog" onBackdropClick={() => onClose(false)}>
      <h2>{t('credentials.title')}</h2>
      <p className="muted">{account.email}</p>
      <label className="field-block">
        {t('detail.authType')}
        <select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)} data-testid="cred-auth-type">
          <option value="password">{t('authType.password')}</option>
          <option value="oauth2">{t('authType.oauth2')}</option>
        </select>
      </label>
      {authType === 'password' ? (
        <label className="field-block">
          {t('credentials.password')}
          <input
            type={secretType}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={!switching && account.hasPassword ? t('credentials.keepCurrent') : ''}
            data-testid="cred-password"
            autoFocus
          />
        </label>
      ) : (
        <>
          <label className="field-block">
            client_id
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid="cred-client-id" autoFocus />
          </label>
          <label className="field-block">
            client_secret <span className="muted small">{t('credentials.optionalForMicrosoft')}</span>
            <input
              type={secretType}
              autoComplete="off"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={!switching && account.hasClientSecret ? t('credentials.keepCurrent') : ''}
              data-testid="cred-client-secret"
            />
          </label>
          <label className="field-block">
            refresh_token
            <textarea
              rows={3}
              autoComplete="off"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder={!switching && account.hasRefreshToken ? t('credentials.keepCurrent') : ''}
              data-testid="cred-refresh-token"
              style={reveal ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
            />
          </label>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
        {t('credentials.reveal')}
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={testAfterSave}
          onChange={(e) => setTestAfterSave(e.target.checked)}
          data-testid="cred-test-after-save"
        />
        {t('credentials.testAfterSave')}
      </label>
      <p className="muted small">{t('credentials.note')}</p>
      <div className="toolbar">
        <Button variant="primary" onClick={save} disabled={busy || !canSave} data-testid="cred-save">
          {t('common.save')}
        </Button>
        <Button onClick={() => onClose(false)} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  )
}
