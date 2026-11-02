/**
 * utilityProcess のエントリ。main プロセスから init メッセージ（マスターキー等）を受け取って BackendApp を起動し、
 * RPC とイベントを MessagePort 経由で中継する。
 */
import type { RpcMethod } from '@shared/api'
import { BackendApp } from './app'

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

type InboundMessage =
  | {
      type: 'init';
      userDataPath: string;
      masterKey: string;
      keyMode: 'keychain' | 'insecure-file';
      version: string;
    }
  | { type: 'rpc'; id: number; method: RpcMethod; params: unknown }
  | { type: 'shutdown' };

const port = (process as unknown as { parentPort: ParentPortLike }).parentPort
let app: BackendApp | null = null
let starting: Promise<BackendApp> | null = null

function errorPayload(err: unknown): { message: string; code?: string } {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string })?.code
  return { message: app ? app.logger.scrubber.scrub(message) : message, code }
}

port.on('message', (e) => {
  const msg = e.data as InboundMessage
  if (msg.type === 'init') {
    starting = BackendApp.create({
      userDataPath: msg.userDataPath,
      masterKey: Buffer.from(msg.masterKey, 'base64'),
      env: process.env,
      keyMode: msg.keyMode,
      version: msg.version,
    })
    starting
      .then((created) => {
        app = created
        app.onEvent((event) => port.postMessage({ type: 'event', event }))
        port.postMessage({ type: 'ready', info: app.info() })
      })
      .catch((err) => {
        port.postMessage({ type: 'fatal', error: errorPayload(err) })
      })
    return
  }
  if (msg.type === 'rpc') {
    void (async () => {
      try {
        const target = app ?? (starting ? await starting : null)
        if (!target) throw new Error('Backend not initialised')
        const result = await target.call(msg.method, msg.params as never)
        port.postMessage({ type: 'rpc-result', id: msg.id, result: result ?? null })
      } catch (err) {
        port.postMessage({ type: 'rpc-result', id: msg.id, error: errorPayload(err) })
      }
    })()
    return
  }
  if (msg.type === 'shutdown') {
    void (app ? app.shutdown() : Promise.resolve()).finally(() => process.exit(0))
  }
})

process.on('uncaughtException', (err) => {
  const payload = errorPayload(err)
  app?.logger.error('Uncaught exception in backend', { error: payload.message })
  port.postMessage({ type: 'event', event: { type: 'backend.error', message: payload.message } })
})
process.on('unhandledRejection', (reason) => {
  const payload = errorPayload(reason)
  app?.logger.error('Unhandled rejection in backend', { error: payload.message })
})
