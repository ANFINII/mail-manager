import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify from 'dompurify'
import { useAppStore } from 'stores/app-store'
import type { AddressInfo, MessageDetail } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatDateTime } from 'utils/format'
import Button from 'components/parts/Button'
import CodeChip from 'components/parts/CodeChip'
import Forward from 'components/widgets/Forward'
import Reply from 'components/widgets/Reply'

function formatAddr(a: AddressInfo): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'frame',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'link',
    'meta',
    'base',
    'svg',
    'math',
  ],
  FORBID_ATTR: ['srcset', 'formaction', 'xlink:href', 'ping'],
  ALLOW_UNKNOWN_PROTOCOLS: false,
}

/**
 * HTML メールは信頼できないデータとして扱う。
 * 1. DOMPurify でスクリプト・フォーム・イベント属性を除去
 * 2. sandbox 属性付き iframe（スクリプト実行・ナビゲーション禁止）に srcdoc で描画
 * 3. iframe 内の CSP で外部画像をデフォルト遮断（ユーザーが明示的に許可したときだけ https/http を許可）
 */
export function buildMailFrame(html: string, allowRemoteImages: boolean): string {
  const sanitized = DOMPurify.sanitize(html, PURIFY_CONFIG)
  const imgSrc = allowRemoteImages ? 'data: cid: https: http:' : 'data: cid:'
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src 'none'; frame-src 'none'; script-src 'none'; connect-src 'none'`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;font-size:13px;line-height:1.5;margin:12px;color:#1f2933;word-break:break-word}img{max-width:100%;height:auto}a{color:#2563eb}blockquote{border-left:3px solid #d9dde3;margin:8px 0;padding-left:10px;color:#4b5563}table{max-width:100%}</style></head><body>${sanitized}</body></html>`
}

interface Props {
  messageId: string
  onClose?: () => void
  onChanged?: () => void
}

export default function MessageViewer(props: Props): React.JSX.Element {
  const { messageId, onClose, onChanged } = props
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const [detail, setDetail] = useState<MessageDetail | null | undefined>(undefined)
  const [mode, setMode] = useState<'html' | 'text'>('html')
  const [remoteImages, setRemoteImages] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [showForward, setShowForward] = useState(false)
  const [replyMode, setReplyMode] = useState<'one' | 'all' | null>(null)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'

  useEffect(() => {
    let cancelled = false
    setDetail(undefined)
    setRemoteImages(false)
    api
      .call('messages.get', { id: messageId })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        setMode(d?.htmlBody ? 'html' : 'text')
      })
      .catch((err) => notify('error', errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [messageId, notify])

  const frame = useMemo(
    () => (detail?.htmlBody ? buildMailFrame(detail.htmlBody, remoteImages) : ''),
    [detail?.htmlBody, remoteImages],
  )

  if (detail === undefined) return <div className="viewer muted">{t('common.loading')}</div>
  if (detail === null) return <div className="viewer muted">{t('viewer.notFound')}</div>

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const setSeen = (seen: boolean) =>
    act('seen', async () => {
      await api.call('messages.setFlags', { ids: [detail.id], seen })
      setDetail({ ...detail, seen })
      onChanged?.()
    })
  const remove = () => {
    if (!window.confirm(t('viewer.confirmDelete'))) return
    void act('delete', async () => {
      await api.call('messages.delete', { ids: [detail.id] })
      notify('info', t('viewer.deleted'))
      onChanged?.()
      onClose?.()
    })
  }
  const forward = () => setShowForward(true)
  const download = (id: string) =>
    act(`att-${id}`, async () => {
      const info = await api.call('attachments.download', { id })
      if (info.storagePath) {
        setDetail({
          ...detail,
          attachments: detail.attachments.map((a) => (a.id === id ? info : a)),
        })
        await api.showItemInFolder(info.storagePath)
      }
    })

  return (
    <div className="viewer" data-testid="message-viewer">
      <div className="viewer-head">
        <div className="viewer-head-top">
          <h2 className="viewer-subject">{detail.subject || t('viewer.noSubject')}</h2>
          <CodeChip code={detail.otpCode} link={detail.otpLink} />
          {onClose && (
            <button
              type="button"
              className="viewer-close"
              onClick={onClose}
              title={t('common.close')}
              aria-label={t('common.close')}
              data-testid="btn-close-viewer"
            >
              ✕
            </button>
          )}
        </div>
        <div className="toolbar">
          <Button onClick={() => setSeen(!detail.seen)} disabled={busy !== null}>
            {detail.seen ? t('viewer.markUnread') : t('viewer.markRead')}
          </Button>
          <Button onClick={() => setReplyMode('one')} disabled={busy !== null} data-testid="btn-reply">
            {t('reply.reply')}
          </Button>
          <Button onClick={() => setReplyMode('all')} disabled={busy !== null} data-testid="btn-reply-all">
            {t('reply.replyAll')}
          </Button>
          <Button onClick={forward} disabled={busy !== null} data-testid="btn-forward">
            {t('viewer.forward')}
          </Button>
          <Button variant="danger" onClick={remove} disabled={busy !== null}>
            {t('common.delete')}
          </Button>
        </div>
      </div>
      <dl className="props compact">
        <div className="prop">
          <dt>{t('viewer.from')}</dt>
          <dd>
            {detail.fromName
              ? `${detail.fromName} <${detail.fromAddress ?? ''}>`
              : (detail.fromAddress ?? '—')}
          </dd>
        </div>
        <div className="prop">
          <dt>{t('viewer.to')}</dt>
          <dd>{detail.toAddresses.map(formatAddr).join(', ') || '—'}</dd>
        </div>
        {detail.ccAddresses.length > 0 && (
          <div className="prop">
            <dt>{t('viewer.cc')}</dt>
            <dd>{detail.ccAddresses.map(formatAddr).join(', ')}</dd>
          </div>
        )}
        <div className="prop">
          <dt>{t('viewer.date')}</dt>
          <dd>{formatDateTime(detail.date, locale)}</dd>
        </div>
        <div className="prop">
          <dt>{t('viewer.account')}</dt>
          <dd>
            {detail.accountEmail} / {detail.mailboxPath}
          </dd>
        </div>
        {detail.attachments.length > 0 && (
          <div className="prop">
            <dt>{t('viewer.attachments')}</dt>
            <dd>
              <ul className="attachments">
                {detail.attachments.map((a) => (
                  <li key={a.id}>
                    <span>
                      {a.filename}{' '}
                      <span className="muted small">
                        ({a.contentType}, {formatBytes(a.size)})
                      </span>
                    </span>{' '}
                    <Button variant="link" onClick={() => download(a.id)} disabled={busy !== null} data-testid="btn-download-attachment">
                      {a.storagePath ? t('viewer.reveal') : t('viewer.download')}
                    </Button>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      <div className="viewer-body-tools">
        {detail.htmlBody && detail.textBody && (
          <label className="field-inline">
            <select value={mode} onChange={(e) => setMode(e.target.value as 'html' | 'text')}>
              <option value="html">HTML</option>
              <option value="text">{t('viewer.textMode')}</option>
            </select>
          </label>
        )}
        {mode === 'html' && detail.htmlBody && (
          <label className="field-inline">
            <input
              type="checkbox"
              checked={remoteImages}
              onChange={(e) => setRemoteImages(e.target.checked)}
            />
            {t('viewer.loadRemoteImages')}
          </label>
        )}
      </div>
      {mode === 'html' && detail.htmlBody ? (
        <iframe
          className="mail-frame"
          title="mail"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={frame}
          data-testid="mail-frame"
        />
      ) : (
        <pre className="mail-text" data-testid="mail-text">
          {detail.textBody ?? ''}
        </pre>
      )}
      {replyMode && (
        <Reply message={detail} replyAll={replyMode === 'all'} onClose={() => setReplyMode(null)} />
      )}
      {showForward && (
        <Forward
          title={t('viewer.forwardOne')}
          onCancel={() => setShowForward(false)}
          onConfirm={async (to) => {
            const res = await api.call('messages.forward', { ids: [detail.id], to })
            setShowForward(false)
            if (res.skipped > 0 && res.queued === 0) notify('info', t('forward.alreadyDone'))
            else notify('info', t('viewer.forwardQueued', { to }))
          }}
        />
      )}
    </div>
  )
}
