import type { BackendEvent } from '@shared/api'

export type EventListener = (event: BackendEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>()

  on(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: BackendEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch {
        // リスナーの失敗で他を止めない
      }
    }
  }
}

/**
 * 短時間に大量に発生する更新をまとめて 1 イベントにする。
 * 300 アカウントの状態変化を 1 件ずつ GUI に送ると描画が詰まるため。
 */
export class Batcher<T> {
  private items = new Set<T>()
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly flush: (items: T[]) => void | Promise<void>,
    private readonly intervalMs = 100,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  push(item: T): void {
    if (this.disposed) return
    this.items.add(item)
    if (!this.timer) {
      this.timer = setTimeout(() => void this.run(), this.intervalMs)
    }
  }

  async run(): Promise<void> {
    this.timer = null
    if (this.disposed || this.items.size === 0) return
    const items = [...this.items]
    this.items.clear()
    try {
      await this.flush(items)
    } catch (err) {
      this.onError(err)
    }
  }

  /** 以降の push は無視する（DB を閉じた後にタイマーが発火しないように） */
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.items.clear()
  }
}
