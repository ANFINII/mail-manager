import { useTranslation } from 'react-i18next'
import type { AccountStatus } from '@shared/types'
import Badge, { BadgeTone } from 'components/parts/Badge'

const ACCOUNT_TONE: Record<AccountStatus, BadgeTone> = {
  untested: 'neutral',
  connecting: 'info',
  connected: 'success',
  syncing: 'info',
  auth_error: 'warn',
  connection_error: 'danger',
  error: 'danger',
  sync_error: 'warn',
  disabled: 'muted',
}

interface Props {
  status: AccountStatus
}

export default function StatusBadge(props: Props): React.JSX.Element {
  const { status } = props
  const { t } = useTranslation()

  return (
    <Badge tone={ACCOUNT_TONE[status]} className={`badge-${status}`}>
      <span data-status={status}>{t(`status.${status}`)}</span>
    </Badge>
  )
}
