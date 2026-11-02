import { useTranslation } from 'react-i18next'
import type { AuthStatus } from '@shared/types'
import Badge, { BadgeTone } from 'components/parts/Badge'

const AUTH_TONE: Record<AuthStatus, BadgeTone> = {
  untested: 'neutral',
  ok: 'success',
  failed: 'warn',
}

interface Props {
  status: AuthStatus
}

export default function AuthBadge(props: Props): React.JSX.Element {
  const { status } = props
  const { t } = useTranslation()
  return (
    <Badge tone={AUTH_TONE[status]}>
      <span data-status={status}>{t(`authStatus.${status}`)}</span>
    </Badge>
  )
}
