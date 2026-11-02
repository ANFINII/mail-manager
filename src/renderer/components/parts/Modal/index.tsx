import cx from 'utils/functions/cx'
import style from './Modal.module.scss'

interface Props {
  children: React.ReactNode
  wide?: boolean
  className?: string
  'data-testid'?: string
  onBackdropClick?: () => void
}

export default function Modal(props: Props): React.JSX.Element {
  const { children, wide = false, className = '', onBackdropClick } = props

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onBackdropClick?.()
  }

  return (
    <div className={style.backdrop} onClick={onBackdrop}>
      <div
        className={cx(style.modal, wide && style.wide, className)}
        data-testid={props['data-testid']}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  )
}
