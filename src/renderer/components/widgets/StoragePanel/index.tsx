import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import type { StorageStats } from '@shared/types'
import { api, errorMessage } from 'lib/api'
import { formatBytes, formatDateTime } from 'utils/format'

/** 保存容量: 使用量の表示と、保存期間に従った整理・DB の最適化 */
export default function StoragePanel(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const notify = useAppStore((s) => s.notify)
  const settings = useAppStore((s) => s.settings)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStats(await api.call('storage.stats', {}))
    } catch (err) {
      notify('error', errorMessage(err))
    }
  }, [notify])
  useEffect(() => {
    void load()
  }, [load])

  const cleanup = async () => {
    setBusy(true)
    try {
      const dry = await api.call('storage.cleanup', { dryRun: true })
      const total = dry.messagesRemoved + dry.attachmentFilesRemoved + dry.orphanDirsRemoved
      if (total === 0) {
        notify('info', t('storage.nothing'))
        return
      }
      if (
        !window.confirm(
          t('storage.confirm', {
            messages: dry.messagesRemoved,
            files: dry.attachmentFilesRemoved + dry.orphanDirsRemoved,
            size: formatBytes(dry.bytesFreed),
          }),
        )
      )
        return
      const r = await api.call('storage.cleanup', {})
      notify(
        'info',
        t('storage.done', {
          messages: r.messagesRemoved,
          files: r.attachmentFilesRemoved + r.orphanDirsRemoved,
          size: formatBytes(r.bytesFreed),
        }),
      )
      await load()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const vacuum = async () => {
    setBusy(true)
    try {
      const r = await api.call('storage.vacuum', {})
      notify('info', t('storage.vacuumed', { before: formatBytes(r.before ?? 0), after: formatBytes(r.after ?? 0) }))
      await load()
    } catch (err) {
      notify('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section data-testid="storage">
      <h2>{t('storage.title')}</h2>
      {stats && (
        <dl className="props">
          <div className="prop">
            <dt>{t('storage.db')}</dt>
            <dd>{stats.dbBytes === null ? '—' : formatBytes(stats.dbBytes)}</dd>
          </div>
          <div className="prop">
            <dt>{t('storage.attachments')}</dt>
            <dd>
              {formatBytes(stats.attachmentBytes)}（{t('common.count', { count: stats.attachmentFiles })}）
            </dd>
          </div>
          <div className="prop">
            <dt>{t('storage.messages')}</dt>
            <dd>
              {t('common.count', { count: stats.messages })} · {t('storage.bodies')}{' '}
              {formatBytes(stats.bodyBytes)}
            </dd>
          </div>
          <div className="prop">
            <dt>{t('storage.oldest')}</dt>
            <dd>{formatDateTime(stats.oldestMessageAt, locale)}</dd>
          </div>
        </dl>
      )}
      <p className="muted small">
        {t('storage.policy', {
          messages: settings?.retentionDays ? t('storage.days', { count: settings.retentionDays }) : t('storage.forever'),
          attachments: settings?.attachmentRetentionDays
            ? t('storage.days', { count: settings.attachmentRetentionDays })
            : t('storage.forever'),
        })}
      </p>
      <div className="toolbar">
        <button className="btn" onClick={cleanup} disabled={busy} data-testid="storage-cleanup">
          {t('storage.cleanup')}
        </button>
        <button className="btn" onClick={vacuum} disabled={busy || stats?.dbBytes === null}>
          {t('storage.vacuum')}
        </button>
        <button className="btn" onClick={() => void load()} disabled={busy}>
          {t('common.refresh')}
        </button>
      </div>
    </section>
  )
}
