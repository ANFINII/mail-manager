import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import type { LockStatus } from '@shared/types'

interface LockFile {
  enabled: boolean;
  idleMinutes: number;
  salt: string | null;
  hash: string | null;
}

export interface LockManagerDeps {
  /** 設定ファイル（userData/lock.json） */
  file: string;
  /** OS 全体の無操作時間（秒）。Electron の powerMonitor.getSystemIdleTime */
  systemIdleSeconds: () => number;
  /** Touch ID が使えるか（macOS） */
  touchIdAvailable: () => boolean;
  onChange: (status: LockStatus) => void;
}

const DEFAULTS: LockFile = { enabled: false, idleMinutes: 10, salt: null, hash: null }
/** パスコードの試行回数の上限（超えたら一定時間受け付けない） */
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 60_000

function hashPasscode(passcode: string, salt: string): string {
  return scryptSync(passcode.normalize('NFKC'), Buffer.from(salt, 'hex'), 32).toString('hex')
}

/**
 * アプリのロック。ロック中はメインプロセスが RPC と画面へのイベント送信を止める（画面を隠すだけではない）。
 * 起動時・一定時間の無操作・画面ロックやスリープでロックし、パスコードか Touch ID で解除する。
 * パスコードは scrypt で派生したハッシュだけを保存する。
 */
export class LockManager {
  private cfg: LockFile
  private locked: boolean
  private failures = 0
  private lockedOutUntil = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: LockManagerDeps) {
    this.cfg = this.read()
    // 有効ならアプリ起動時はロックした状態で始める
    this.locked = this.isActive()
  }

  private read(): LockFile {
    try {
      return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(this.deps.file, 'utf8')) as Partial<LockFile>) }
    } catch {
      return { ...DEFAULTS }
    }
  }

  private write(): void {
    fs.writeFileSync(this.deps.file, JSON.stringify(this.cfg), { mode: 0o600 })
  }

  /** ロック機能が有効（有効化され、パスコードが設定済み） */
  isActive(): boolean {
    return this.cfg.enabled && !!this.cfg.hash
  }

  isLocked(): boolean {
    return this.locked
  }

  status(): LockStatus {
    return {
      enabled: this.cfg.enabled,
      hasPasscode: !!this.cfg.hash,
      idleMinutes: this.cfg.idleMinutes,
      locked: this.locked,
      touchId: this.deps.touchIdAvailable(),
      retryAfterMs: Math.max(0, this.lockedOutUntil - Date.now()),
    }
  }

  lock(): void {
    if (!this.isActive() || this.locked) return
    this.locked = true
    this.deps.onChange(this.status())
  }

  private unlocked(): LockStatus {
    this.locked = false
    this.failures = 0
    this.deps.onChange(this.status())
    return this.status()
  }

  unlockWithPasscode(passcode: string): LockStatus {
    if (!this.locked) return this.status()
    if (Date.now() < this.lockedOutUntil) throw new Error('試行回数が多すぎます。しばらく待ってからやり直してください')
    if (this.verify(passcode)) return this.unlocked()
    this.failures++
    if (this.failures >= MAX_ATTEMPTS) {
      this.failures = 0
      this.lockedOutUntil = Date.now() + LOCKOUT_MS
    }
    throw new Error('パスコードが違います')
  }

  /** Touch ID などの OS 認証に成功したときに呼ぶ */
  unlockWithOsAuth(): LockStatus {
    return this.unlocked()
  }

  private verify(passcode: string): boolean {
    if (!this.cfg.hash || !this.cfg.salt) return false
    const a = Buffer.from(hashPasscode(passcode, this.cfg.salt), 'hex')
    const b = Buffer.from(this.cfg.hash, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** パスコードの設定・変更。既に設定済みなら現在のパスコードが必要 */
  setPasscode(current: string | undefined, next: string): LockStatus {
    if (this.locked) throw new Error('ロック中は変更できません')
    if (this.cfg.hash && !this.verify(current ?? '')) throw new Error('現在のパスコードが違います')
    if (next.length < 4) throw new Error('パスコードは 4 文字以上にしてください')
    const salt = randomBytes(16).toString('hex')
    this.cfg = { ...this.cfg, salt, hash: hashPasscode(next, salt) }
    this.write()
    this.deps.onChange(this.status())
    return this.status()
  }

  /** 有効・無効と無操作時間の設定。無効化と時間の変更にもパスコードが要る（ロックを勝手に外させない） */
  configure(opts: { enabled: boolean; idleMinutes: number; passcode?: string }): LockStatus {
    if (this.locked) throw new Error('ロック中は変更できません')
    if (this.cfg.hash && !this.verify(opts.passcode ?? '')) throw new Error('パスコードが違います')
    if (opts.enabled && !this.cfg.hash) throw new Error('先にパスコードを設定してください')
    this.cfg = {
      ...this.cfg,
      enabled: opts.enabled,
      idleMinutes: Math.min(24 * 60, Math.max(1, Math.round(opts.idleMinutes || 10))),
    }
    this.write()
    this.deps.onChange(this.status())
    return this.status()
  }

  /** OS の無操作時間を見て、設定時間を超えたらロックする */
  checkIdle(): void {
    if (!this.isActive() || this.locked) return
    if (this.deps.systemIdleSeconds() >= this.cfg.idleMinutes * 60) this.lock()
  }

  start(intervalMs = 15_000): void {
    this.stop()
    this.timer = setInterval(() => this.checkIdle(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
