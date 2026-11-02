import { useTranslation } from 'react-i18next'
import type { JobStatus } from '@shared/types'
import Badge, { BadgeTone } from 'components/parts/Badge'

const JOB_TONE: Record<JobStatus, BadgeTone> = {
  running: 'info',
  completed: 'success',
  cancelled: 'muted',
}

interface Props {
  status: JobStatus
}

export default function JobBadge(props: Props): React.JSX.Element {
  const { status } = props
  const { t } = useTranslation()
  return (
    <Badge tone={JOB_TONE[status]} className={`job-${status}`}>
      <span data-status={status}>{t(`jobStatus.${status}`)}</span>
    </Badge>
  )
}
