import cx from 'utils/functions/cx'
import style from './Button.module.scss'

type ButtonVariant = 'default' | 'primary' | 'danger' | 'link'

interface Props {
  children: React.ReactNode
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  type?: 'submit' | 'reset' | 'button'
  className?: string
  disabled?: boolean
  title?: string
  'data-testid'?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

export default function Button(props: Props): React.JSX.Element {
  const { children, variant = 'default', size = 'md', type = 'button', className = '', disabled = false, title, onClick } = props

  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-testid={props['data-testid']}
      className={cx(style.button, variant !== 'link' && style[size], style[variant], className)}
    >
      {children}
    </button>
  )
}
