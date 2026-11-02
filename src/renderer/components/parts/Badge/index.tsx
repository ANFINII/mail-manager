import cx from 'utils/functions/cx'
import style from './Badge.module.scss'

export type BadgeTone = 'neutral' | 'success' | 'info' | 'warn' | 'danger' | 'muted' | 'purple'

interface Props {
  children: React.ReactNode
  tone?: BadgeTone
  className?: string
}

export default function Badge(props: Props): React.JSX.Element {
  const { children, tone = 'neutral', className = '' } = props
  return <span className={cx(style.badge, tone !== 'neutral' && style[tone], className)}>{children}</span>
}
