export const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 15000]

/** attempt は 0 始まり（0 = 1 回目のリトライ前） */
export function retryDelayMs(delays: number[], attempt: number): number {
  if (delays.length === 0) return 0
  return delays[Math.min(attempt, delays.length - 1)]
}

export function parseRetryDelays(value: string | undefined): number[] {
  if (!value) return DEFAULT_RETRY_DELAYS_MS
  const parsed = value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS
}
