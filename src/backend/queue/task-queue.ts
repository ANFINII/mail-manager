/**
 * 同時実行数を制限するタスクキュー（Queue + Worker 方式）。
 * 300 アカウントを一斉に接続しないための中核部品。外部依存なし。
 */
export class AbortError extends Error {
  constructor(message = 'Task aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

interface QueueItem {
  run: () => Promise<void>;
  cancel: () => void;
  /** 大きいほど先に実行する（同じ優先度は到着順） */
  priority: number;
}

export class TaskQueue {
  private queue: QueueItem[] = []
  private active = 0
  private concurrencyValue: number
  private idleWaiters: Array<() => void> = []
  /** 統計用: 同時に走った最大ワーカー数 */
  peakActive = 0

  constructor(concurrency: number) {
    this.concurrencyValue = Math.max(1, Math.floor(concurrency))
  }

  get concurrency(): number {
    return this.concurrencyValue
  }

  set concurrency(value: number) {
    this.concurrencyValue = Math.max(1, Math.floor(value))
    this.pump()
  }

  get pending(): number {
    return this.queue.length
  }

  get running(): number {
    return this.active
  }

  add<T>(
    task: () => Promise<T>,
    opts: { signal?: AbortSignal; priority?: number } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new AbortError())
        return
      }
      const item: QueueItem = {
        run: async () => {
          opts.signal?.removeEventListener('abort', onAbort)
          try {
            resolve(await task())
          } catch (err) {
            reject(err)
          }
        },
        cancel: () => reject(new AbortError()),
        priority: opts.priority ?? 0,
      }
      const onAbort = () => {
        const idx = this.queue.indexOf(item)
        if (idx >= 0) {
          this.queue.splice(idx, 1)
          item.cancel()
          this.checkIdle()
        }
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      // 優先度の高いタスク（手動操作）を、待ち行列にある低優先度（自動転送など）より前に入れる
      let idx = this.queue.length
      while (idx > 0 && this.queue[idx - 1].priority < item.priority) idx--
      this.queue.splice(idx, 0, item)
      this.pump()
    })
  }

  /** 未実行のタスクをすべて破棄する。実行中のタスクは各自の AbortSignal で止める。 */
  clear(): number {
    const dropped = this.queue.splice(0)
    for (const item of dropped) item.cancel()
    this.checkIdle()
    return dropped.length
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private pump(): void {
    while (this.active < this.concurrencyValue && this.queue.length > 0) {
      const item = this.queue.shift()!
      this.active++
      this.peakActive = Math.max(this.peakActive, this.active)
      void item.run().finally(() => {
        this.active--
        this.pump()
        this.checkIdle()
      })
    }
  }

  private checkIdle(): void {
    if (this.active === 0 && this.queue.length === 0) {
      const waiters = this.idleWaiters.splice(0)
      for (const w of waiters) w()
    }
  }
}
