import { useTranslation } from 'react-i18next'
import { useAppStore } from 'stores/app-store'
import cx from 'utils/functions/cx'

/**
 * 自動同期の ON/OFF ボタン。起動時は OFF で、ON にすると認証済みアカウントを一度受信し、
 * 以後は設定した間隔（と認証完了時）に自動で受信する。受信メール画面とダッシュボードに置く。
 */
export default function AutoSyncToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const autoSync = useAppStore((s) => s.autoSync)
  const setAutoSync = useAppStore((s) => s.setAutoSync)
  const enabled = autoSync?.enabled ?? false

  return (
    <button
      type="button"
      className={cx('btn', enabled && 'btn-primary')}
      onClick={() => void setAutoSync(!enabled)}
      aria-pressed={enabled}
      title={t('autoSync.hint')}
      data-testid="btn-auto-sync"
      data-enabled={enabled ? '1' : '0'}
    >
      {enabled ? '● ' : '○ '}
      {t(enabled ? 'autoSync.on' : 'autoSync.off')}
    </button>
  )
}
