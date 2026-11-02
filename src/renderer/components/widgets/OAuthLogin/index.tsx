import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { AccountDetail, OAuthLoginStart } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import Modal from 'components/parts/Modal'

interface Props {
  /** 既存アカウントの再サインイン（未指定なら新規登録） */
  account?: AccountDetail
  onClose: (accountId?: string) => void
}

type Provider = OAuthLoginStart['provider']
const STORAGE_KEY = 'mm.oauth.clientIds'

function loadClientIds(): Partial<Record<Provider, string>> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Record<Provider, string>>
  } catch {
    return {}
  }
}
function saveClientId(provider: Provider, clientId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadClientIds(), [provider]: clientId }))
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/**
 * OAuth2 の対話ログイン。ブラウザでサインイン・同意すると refresh token を受け取り、
 * アカウントを登録（または既存アカウントの認証情報を更新）して認証テストまで行う。
 */
export default function OAuthLogin({ account, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const groups = useAppStore((s) => s.groups)
  const initialProvider: Provider = account?.provider === 'gmail' ? 'gmail' : 'outlook'
  const [provider, setProvider] = useState<Provider>(initialProvider)
  const [clientId, setClientId] = useState(
    account?.oauthClientId ?? loadClientIds()[initialProvider] ?? '',
  )
  const [clientSecret, setClientSecret] = useState('')
  const [email, setEmail] = useState(account?.email ?? '')
  const [groupId, setGroupId] = useState('')
  const [graph, setGraph] = useState(account?.fetchVia === 'graph')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current)
    },
    [],
  )

  const changeProvider = (p: Provider) => {
    setProvider(p)
    setClientId(loadClientIds()[p] ?? '')
  }

  const start = async () => {
    setError(null)
    try {
      const r = await api.call('oauth.start', {
        provider,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        email: email.trim() || undefined,
        accountId: account?.id,
        groupId: account ? undefined : groupId || null,
        graph: provider === 'outlook' ? graph : undefined,
      })
      saveClientId(provider, clientId.trim())
      setSessionId(r.sessionId)
      await api.openExternal(r.authorizeUrl)
      timer.current = setInterval(async () => {
        const s = await api.call('oauth.status', { sessionId: r.sessionId })
        if (s.state === 'pending') return
        if (timer.current) clearInterval(timer.current)
        timer.current = null
        setSessionId(null)
        if (s.state === 'done') {
          notify('info', t('oauthLogin.done', { email: s.email }))
          onClose(s.accountId)
        } else setError(s.error ?? t('common.error'))
      }, 1000)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const cancel = async () => {
    if (sessionId) await api.call('oauth.cancel', { sessionId }).catch(() => undefined)
    onClose()
  }

  const waiting = sessionId !== null
  return (
    <Modal data-testid="oauth-login" onBackdropClick={waiting ? undefined : () => onClose()}>
      <h2>{account ? t('oauthLogin.reauthTitle', { email: account.email }) : t('oauthLogin.title')}</h2>
      <p className="muted small">{t('oauthLogin.hint')}</p>
      <div className="form">
        <label>
          {t('oauthLogin.provider')}
          <select
            value={provider}
            onChange={(e) => changeProvider(e.target.value as Provider)}
            disabled={waiting || !!account}
          >
            <option value="outlook">Outlook / Microsoft 365</option>
            <option value="gmail">Gmail / Google Workspace</option>
          </select>
        </label>
        <label>
          client_id
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={waiting} data-testid="oauth-client-id" />
        </label>
        {provider === 'gmail' && (
          <label>
            client_secret
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              disabled={waiting}
              placeholder={account ? t('credentials.keepCurrent') : ''}
            />
          </label>
        )}
        <label>
          {t('oauthLogin.email')}
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={waiting || !!account}
            placeholder="user@example.com"
          />
        </label>
        {!account && groups.length > 0 && (
          <label>
            {t('accounts.group')}
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={waiting}>
              <option value="">{t('accounts.groupNone')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {provider === 'outlook' && (
          <label className="check">
            <input type="checkbox" checked={graph} onChange={(e) => setGraph(e.target.checked)} disabled={waiting} />
            {t('oauthLogin.graph')}
          </label>
        )}
        <p className="muted small">{t('oauthLogin.redirectNote')}</p>
      </div>
      {waiting && <p data-testid="oauth-waiting">{t('oauthLogin.waiting')}</p>}
      {error && <p className="warn">{error}</p>}
      <div className="toolbar">
        <span className="spacer" />
        <button className="btn" onClick={cancel}>
          {t('common.cancel')}
        </button>
        <button
          className="btn btn-primary"
          onClick={start}
          disabled={waiting || !clientId.trim() || (provider === 'gmail' && !account && !clientSecret.trim())}
          data-testid="oauth-start"
        >
          {t('oauthLogin.start')}
        </button>
      </div>
    </Modal>
  )
}
