import { randomUUID } from 'node:crypto'
import type { JobInfo, JobType } from '@shared/types'

export interface Job {
  info: JobInfo;
  controller: AbortController;
  /** アカウント ID → 完了済みか */
  remaining: Set<string>;
}

export class JobTracker {
  private jobs = new Map<string, Job>()

  constructor(private readonly onChange: (job: JobInfo) => void) {}

  create(type: JobType, accountIds: string[]): Job {
    const job: Job = {
      info: {
        id: randomUUID(),
        type,
        status: 'running',
        total: accountIds.length,
        done: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      controller: new AbortController(),
      remaining: new Set(accountIds),
    }
    this.jobs.set(job.info.id, job)
    if (accountIds.length === 0) this.finish(job)
    this.onChange({ ...job.info })
    return job
  }

  complete(job: Job, accountId: string, outcome: 'succeeded' | 'failed' | 'cancelled'): void {
    if (!job.remaining.delete(accountId)) return
    job.info.done++
    job.info[outcome]++
    if (job.remaining.size === 0) this.finish(job)
    this.onChange({ ...job.info })
  }

  cancelAll(): number {
    let n = 0
    for (const job of this.jobs.values()) {
      if (job.info.status === 'running') {
        job.controller.abort()
        n++
      }
    }
    return n
  }

  private finish(job: Job): void {
    job.info.status = job.controller.signal.aborted ? 'cancelled' : 'completed'
    job.info.finishedAt = new Date().toISOString()
  }

  list(): JobInfo[] {
    return [...this.jobs.values()]
      .map((j) => ({ ...j.info }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 20)
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  activeCount(): number {
    let n = 0
    for (const j of this.jobs.values()) if (j.info.status === 'running') n++
    return n
  }
}
