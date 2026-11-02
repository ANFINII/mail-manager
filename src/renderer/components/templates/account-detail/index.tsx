import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'hooks/router'
import { useAppStore } from 'stores/app-store'
import type { AccountDetail, MailboxSummary } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'
import AuthBadge from 'components/parts/AuthBadge'
import StatusBadge from 'components/parts/StatusBadge'
import CredentialsEditor from 'components/widgets/CredentialsEditor'
import OAuthLogin from 'components/widgets/OAuthLogin'

export default function AccountDetailTemplate() {
  const { t, i18n } = useTranslation()
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const notify = useAppStore((s) => s.notify)
  const groups = useAppStore((s) => s.groups)
  const summary = useAppStore((s) => s.accounts.find((a) => a.id === id))
  const [detail, setDetail] = useState<AccountDetail | null | undefined>(undefined)
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>([])
  const [editingCredentials, setEditingCredentials] = useState(false)
  const [reauth, setReauth] = useState(false)
  const [detailTick, setDetailTick] = useState(0)
  const mailboxesTick = useAppStore((s) => s.mailboxesTick)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'

  useEffect(() => {
    api
      .call('mailboxes.list', { accountId: id })
      .then(setMailboxes)
      .catch(() => undefined)
  }, [id, mailboxesTick, summary?.lastSyncAt])

  useEffect(() => {
    let cancelled = false
    api
      .call('accounts.get', { id })
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((err) => notify('error', errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [id, notify, summary?.updatedAt, detailTick])

  if (detail === undefined) return <div className="page">{t('common.loading')}</div>
  if (detail === null) {
    return (
      <div className="page">
        <p>{t('detail.notFound')}</p>
        <button className="btn" onClick={() => navigate('/accounts')}>
          {t('common.back')}
        </button>
      </div>
    )
  }
  const a = { ...detail, ...(summary ?? {}) }

  const act = async (fn: () => Promise<string>, after?: () => void) => {
    try {
      notify('info', await fn())
      after?.()
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }

  const rows: Array<[string, React.ReactNode]> = [
    [t('detail.email'), a.email],
    [t('detail.provider'), a.provider],
    [t('detail.authType'), t(`authType.${a.authType}`)],
    [t('detail.imapServer'), `${a.imapHost}:${a.imapPort} (${a.imapSecure})`],
    [
      t('detail.smtpServer'),
      a.smtpHost ? `${a.smtpHost}:${a.smtpPort ?? ''} (${a.smtpSecure ?? ''})` : '—',
    ],
    [t('detail.proxy'), a.proxy ?? '—'],
    [
      t('detail.group'),
      <select
        key="g"
        value={a.groupId ?? ''}
        data-testid="detail-group"
        onChange={(e) =>
          act(async () => {
            await api.call('accounts.setGroup', { ids: [a.id], groupId: e.target.value || null })
            return t('detail.groupChanged')
          })
        }
      >
        <option value="">{t('detail.groupNone')}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>,
    ],
    [t('detail.enabled'), a.enabled ? t('common.yes') : t('common.no')],
    [t('detail.status'), <StatusBadge key="s" status={a.status} />],
    [t('detail.authStatus'), <AuthBadge key="a" status={a.authStatus} />],
    [t('detail.lastSuccess'), formatDateTime(a.lastSuccessAt, locale)],
    [t('detail.lastError'), a.lastError ?? '—'],
    [t('detail.lastErrorAt'), formatDateTime(a.lastErrorAt, locale)],
    [t('detail.retryCount'), String(a.retryCount)],
    [t('detail.lastSync'), formatDateTime(a.lastSyncAt, locale)],
    [t('detail.messageCount'), String(a.messageCount)],
    ...(a.authType === 'oauth2'
      ? ([
          [t('detail.oauthClientId'), detail.oauthClientId ?? '—'],
          [
            t('detail.hasRefreshToken'),
            detail.hasRefreshToken ? t('detail.stored') : t('detail.missing'),
          ],
        ] as Array<[string, React.ReactNode]>)
      : ([
          [t('detail.hasPassword'), detail.hasPassword ? t('detail.stored') : t('detail.missing')],
        ] as Array<[string, React.ReactNode]>)),
    [t('detail.createdAt'), formatDateTime(a.createdAt, locale)],
    [t('detail.updatedAt'), formatDateTime(a.updatedAt, locale)],
  ]

  return (
    <div className="page" data-testid="account-detail">
      <div className="page-head">
        <button className="btn" onClick={() => navigate('/accounts')}>
          ← {t('common.back')}
        </button>
        <h1>{t('detail.title')}</h1>
      </div>
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k} className="prop">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="toolbar">
        <button
          className="btn btn-primary"
          data-testid="btn-test-connection"
          disabled={!a.enabled}
          onClick={() =>
            act(async () => {
              await api.call('auth.test', { ids: [a.id] })
              return t('detail.testStarted')
            })
          }
        >
          {t('detail.testConnection')}
        </button>
        <button
          className="btn btn-primary"
          data-testid="btn-sync-now"
          disabled={!a.enabled}
          onClick={() =>
            act(async () => {
              await api.call('sync.run', { ids: [a.id] })
              return t('detail.syncStarted')
            })
          }
        >
          {t('detail.syncNow')}
        </button>
        <button className="btn" onClick={() => navigate(`/search?accountId=${a.id}`)}>
          {t('detail.searchMail')}
        </button>
        <button
          className="btn"
          onClick={() => setEditingCredentials(true)}
          data-testid="btn-edit-credentials"
        >
          {t('credentials.edit')}
        </button>
        {(a.provider === 'outlook' || a.provider === 'gmail') && (
          <button className="btn" onClick={() => setReauth(true)} data-testid="btn-oauth-reauth">
            {t('oauthLogin.reauth')}
          </button>
        )}
        <button
          className="btn"
          onClick={() =>
            act(async () => {
              const r = await api.call('accounts.setEnabled', { ids: [a.id], enabled: !a.enabled })
              return t('accounts.updated', { count: r.updated })
            })
          }
        >
          {a.enabled ? t('common.disable') : t('common.enable')}
        </button>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (!window.confirm(t('accounts.confirmDelete', { count: 1 }))) return
            void act(
              async () => {
                const r = await api.call('accounts.delete', { ids: [a.id] })
                return t('accounts.deleted', { count: r.deleted })
              },
              () => navigate('/accounts'),
            )
          }}
        >
          {t('common.delete')}
        </button>
      </div>
      {reauth && detail && (
        <OAuthLogin
          account={detail}
          onClose={(id) => {
            setReauth(false)
            if (id) setDetailTick((n) => n + 1)
          }}
        />
      )}
      {editingCredentials && (
        <CredentialsEditor
          account={detail}
          onClose={(saved) => {
            setEditingCredentials(false)
            if (saved) setDetailTick((n) => n + 1)
          }}
        />
      )}
      <h2>{t('detail.mailboxes')}</h2>
      {mailboxes.length === 0 ? (
        <p className="muted">{t('detail.noMailboxes')}</p>
      ) : (
        <table className="simple-table" data-testid="mailboxes">
          <thead>
            <tr>
              <th>{t('detail.mailboxPath')}</th>
              <th>{t('detail.mailboxStored')}</th>
              <th>{t('detail.mailboxTotal')}</th>
              <th>UID</th>
              <th>{t('detail.lastSync')}</th>
            </tr>
          </thead>
          <tbody>
            {mailboxes.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.path}{' '}
                  {m.specialUse ? <span className="muted small">{m.specialUse}</span> : null}
                </td>
                <td>{m.storedMessages}</td>
                <td>{m.totalMessages}</td>
                <td>{m.lastSyncUid}</td>
                <td className="muted small">{formatDateTime(m.lastSyncAt, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
