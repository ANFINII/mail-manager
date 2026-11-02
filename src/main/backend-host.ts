import { utilityProcess, type UtilityProcess } from 'electron'
import type { BackendEvent } from '@shared/api'
import type { AppInfo } from '@shared/types'

export interface BackendHostOptions {
  scriptPath: string;
  userDataPath: string;
  masterKey: Buffer;
  keyMode: 'keychain' | 'insecure-file';
  version: string;
  env: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** backend utilityProcess を起動し、RPC とイベントを中継する。 */
export class BackendHost {
  private child: UtilityProcess | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Set<(e: BackendEvent) => void>()
  private fatal: Error | null = null
  info: AppInfo | null = null

  constructor(private readonly opts: BackendHostOptions) {}

  start(): void {
    this.child = utilityProcess.fork(this.opts.scriptPath, [], {
      serviceName: 'mail-manager-backend',
      env: this.opts.env,
      stdio: 'inherit',
    })
    this.child.on('message', (msg: unknown) => this.handle(msg as Record<string, unknown>))
    this.child.on('exit', (code) => {
      const err = new Error(`Backend process exited (code ${code})`)
      this.fatal = err
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.emit({ type: 'backend.error', message: err.message })
    })
    this.child.postMessage({
      type: 'init',
      userDataPath: this.opts.userDataPath,
      masterKey: this.opts.masterKey.toString('base64'),
      keyMode: this.opts.keyMode,
      version: this.opts.version,
    })
  }

  private handle(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ready':
        this.info = msg.info as AppInfo
        return
      case 'fatal': {
        const e = msg.error as { message: string }
        this.fatal = new Error(e.message)
        this.emit({ type: 'backend.error', message: e.message })
        for (const p of this.pending.values()) p.reject(this.fatal)
        this.pending.clear()
        return
      }
      case 'rpc-result': {
        const p = this.pending.get(msg.id as number)
        if (!p) return
        this.pending.delete(msg.id as number)
        if (msg.error) {
          const e = msg.error as { message: string; code?: string }
          p.reject(Object.assign(new Error(e.message), { code: e.code }))
        } else p.resolve(msg.result)
        return
      }
      case 'event':
        this.emit(msg.event as BackendEvent)
        return
    }
  }

  private emit(event: BackendEvent): void {
    for (const l of this.listeners) l(event)
  }

  onEvent(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal)
    if (!this.child) return Promise.reject(new Error('Backend not started'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child!.postMessage({ type: 'rpc', id, method, params })
    })
  }

  stop(): void {
    if (!this.child) return
    const child = this.child
    this.child = null
    try {
      child.postMessage({ type: 'shutdown' })
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already exited
      }
    }, 2000)
  }
}
