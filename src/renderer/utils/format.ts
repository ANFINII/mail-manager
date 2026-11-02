export function formatDateTime(iso: string | null | undefined, locale = 'ja-JP'): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale, { hour12: false })
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** 件名から転送メールかどうかを推定する（Fwd:/FW:/転送: など） */
export function isForwardSubject(subject: string | null | undefined): boolean {
  return /^\s*(fwd?|fw|転送)\s*[:：]/i.test(subject ?? '')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
