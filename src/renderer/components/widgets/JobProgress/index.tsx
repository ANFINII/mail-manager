import { useTranslation } from 'react-i18next'
import type { JobInfo } from '@shared/types'
import { formatDateTime } from 'utils/format'
import JobBadge from 'components/parts/JobBadge'

interface Props {
  job: JobInfo
}

export default function JobProgress(props: Props): React.JSX.Element {
  const { job } = props

  const { t, i18n } = useTranslation()
  const pct = job.total === 0 ? 100 : Math.round((job.done / job.total) * 100)
  const locale = i18n.language === 'en' ? 'en-US' : 'ja-JP'

  return (
    <div className="job" data-testid={`job-${job.id}`}>
      <div className="job-head">
        <span className="job-type">{t(`jobType.${job.type}`)}</span>
        <JobBadge status={job.status} />
        <span className="job-counts">
          {job.done} / {job.total}
        </span>
        <span className="muted">{t('dashboard.outcome', { succeeded: job.succeeded, failed: job.failed, cancelled: job.cancelled })}</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">
        {t('dashboard.started')}: {formatDateTime(job.startedAt, locale)}
        {job.finishedAt ? ` · ${t('dashboard.finished')}: ${formatDateTime(job.finishedAt, locale)}` : ''}
      </div>
    </div>
  )
}
