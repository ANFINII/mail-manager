import { DatabaseSync } from 'node:sqlite'
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from 'kysely'

/**
 * Node.js 組み込みの node:sqlite を Kysely から使うための Dialect。
 * better-sqlite3 のようなネイティブアドオンを使わないので Electron でのリビルドが不要。
 */
export interface NodeSqliteDialectConfig {
  database: () => DatabaseSync;
}

class Mutex {
  private locked = false
  private waiters: Array<() => void> = []

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  unlock(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.locked = false
  }
}

function normalizeParam(p: unknown): string | number | bigint | Uint8Array | null {
  if (p === undefined || p === null) return null
  if (typeof p === 'boolean') return p ? 1 : 0
  if (p instanceof Date) return p.toISOString()
  if (typeof p === 'string' || typeof p === 'number' || typeof p === 'bigint') return p
  if (p instanceof Uint8Array) return p
  return JSON.stringify(p)
}

class NodeSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: DatabaseSync) {}

  async executeQuery<O>(compiled: CompiledQuery): Promise<QueryResult<O>> {
    const stmt = this.db.prepare(compiled.sql)
    const params = compiled.parameters.map(normalizeParam)
    const isReader = stmt.columns().length > 0
    if (isReader) {
      const rows = stmt.all(...params) as O[]
      return { rows }
    }
    const info = stmt.run(...params)
    return {
      rows: [],
      numAffectedRows: BigInt(info.changes),
      insertId:
        typeof info.lastInsertRowid === 'bigint'
          ? info.lastInsertRowid
          : BigInt(info.lastInsertRowid),
    }
  }

  // eslint-disable-next-line require-yield -- 未対応スタブ（呼ばれたら即例外）
  async *streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
    throw new Error('streamQuery is not supported by NodeSqliteDialect')
  }
}

class NodeSqliteDriver implements Driver {
  private db!: DatabaseSync
  private connection!: NodeSqliteConnection
  private readonly mutex = new Mutex()

  constructor(private readonly config: NodeSqliteDialectConfig) {}

  async init(): Promise<void> {
    this.db = this.config.database()
    this.connection = new NodeSqliteConnection(this.db)
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.mutex.lock()
    return this.connection
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'))
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'))
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'))
  }

  async releaseConnection(): Promise<void> {
    this.mutex.unlock()
  }

  async destroy(): Promise<void> {
    this.db.close()
  }
}

export class NodeSqliteDialect implements Dialect {
  constructor(private readonly config: NodeSqliteDialectConfig) {}

  createDriver(): Driver {
    return new NodeSqliteDriver(this.config)
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler()
  }
  createAdapter() {
    return new SqliteAdapter()
  }
  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db)
  }
}
