import { useAppStore } from 'stores/app-store'
import cx from 'utils/functions/cx'

export default function Toasts(): React.JSX.Element {
  const toasts = useAppStore((s) => s.toasts)
  const dismiss = useAppStore((s) => s.dismissToast)
  return (
    <div className="toasts" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.kind}`)} onClick={() => dismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
