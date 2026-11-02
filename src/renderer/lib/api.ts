import type {} from '@shared/api'

export const api = window.api

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method 'rpc': (Error: )?/, '')
  return String(err)
}
