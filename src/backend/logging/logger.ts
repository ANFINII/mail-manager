import fs from 'node:fs'
import path from 'node:path'

/** これを超えたログファイルは起動時に .1 へ退避する */
const LOG_ROTATE_BYTES = 200 * 1024 * 1024

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogSink {
  write(line: string): void;
  close?(): void;
}

/** キー名で秘密情報と判断してマスクする。 */
const SECRET_KEY_PATTERN = /(pass|secret|token|credential|authorization|master_?key|cookie)/i

export function redactKeys(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]'
  if (Array.isArray(value)) return value.map((v) => redactKeys(v, depth + 1))
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: value.message }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redactKeys(v, depth + 1)
    }
    return out
  }
  return value
}

/**
 * 既知の秘密文字列（パスワード・トークン等）を登録し、ログ行から除去する。
 * キー名ベースの redact だけでは防げない「エラーメッセージに混入した秘密」を潰すための最終防衛線。
 */
export class SecretScrubber {
  private secrets = new Set<string>()

  register(secret: string | undefined | null): void {
    if (!secret || secret.length < 4) return
    this.secrets.add(secret)
  }

  scrub(text: string): string {
    let out = text
    for (const s of this.secrets) {
      if (out.includes(s)) out = out.split(s).join('***')
    }
    return out
  }
}

export class Logger {
  constructor(
    private readonly opts: {
      level: LogLevel;
      sinks: LogSink[];
      scrubber: SecretScrubber;
      context?: string;
    },
  ) {}

  child(context: string): Logger {
    const ctx = this.opts.context ? `${this.opts.context}:${context}` : context
    return new Logger({ ...this.opts, context: ctx })
  }

  get scrubber(): SecretScrubber {
    return this.opts.scrubber
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log('debug', msg, meta)
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.log('info', msg, meta)
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log('warn', msg, meta)
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.log('error', msg, meta)
  }

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.opts.level]) return
    const ts = new Date().toISOString()
    const ctx = this.opts.context ? ` [${this.opts.context}]` : ''
    let line = `${ts} [${level.toUpperCase()}]${ctx} ${msg}`
    if (meta && Object.keys(meta).length > 0) {
      line += ' ' + JSON.stringify(redactKeys(meta))
    }
    line = this.opts.scrubber.scrub(line)
    for (const sink of this.opts.sinks) {
      try {
        sink.write(line)
      } catch {
        // ログ出力の失敗でアプリを止めない
      }
    }
  }

  close(): void {
    for (const sink of this.opts.sinks) sink.close?.()
  }
}

export function fileSink(filePath: string): LogSink {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // 起動時に大きくなりすぎたログを 1 世代だけ退避する（app.log → app.log.1）。書き込み中の回転はしない。
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > LOG_ROTATE_BYTES) {
      fs.renameSync(filePath, `${filePath}.1`)
    }
  } catch {
    // 退避できなくても追記は続ける
  }
  const stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 })
  return {
    write: (line) => {
      stream.write(line + '\n')
    },
    close: () => stream.end(),
  }
}

export function consoleSink(): LogSink {
  return {
    write: (line) => {
      process.stdout.write(line + '\n')
    },
  }
}

export class MemorySink implements LogSink {
  lines: string[] = []
  write(line: string): void {
    this.lines.push(line)
  }
}

export function createLogger(opts: {
  level?: LogLevel;
  filePath?: string;
  console?: boolean;
  sinks?: LogSink[];
  scrubber?: SecretScrubber;
}): Logger {
  const sinks: LogSink[] = [...(opts.sinks ?? [])]
  if (opts.filePath) sinks.push(fileSink(opts.filePath))
  if (opts.console) sinks.push(consoleSink())
  return new Logger({
    level: opts.level ?? 'info',
    sinks,
    scrubber: opts.scrubber ?? new SecretScrubber(),
  })
}
