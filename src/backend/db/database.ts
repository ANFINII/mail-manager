import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Kysely, PostgresDialect } from 'kysely'
import { migrateToLatest, setMigrationDriver } from './migrations'
import { NodeSqliteDialect } from './node-sqlite-dialect'
import type { Database } from './schema'

export type DbConfig =
  { driver: 'sqlite'; file: string } | { driver: 'postgres'; connectionString: string };

export type Db = Kysely<Database>;

export function dbConfigFromEnv(env: NodeJS.ProcessEnv, defaultSqliteFile: string): DbConfig {
  if (env.MM_DB_DRIVER === 'postgres' || (env.DATABASE_URL && env.MM_DB_DRIVER !== 'sqlite')) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for postgres driver')
    return { driver: 'postgres', connectionString: env.DATABASE_URL }
  }
  return { driver: 'sqlite', file: env.MM_DB_FILE ?? defaultSqliteFile }
}

export async function createDatabase(config: DbConfig): Promise<Db> {
  let db: Db
  if (config.driver === 'sqlite') {
    if (config.file !== ':memory:') {
      fs.mkdirSync(path.dirname(config.file), { recursive: true })
    }
    db = new Kysely<Database>({
      dialect: new NodeSqliteDialect({
        database: () => {
          const sqlite = new DatabaseSync(config.file)
          sqlite.exec('PRAGMA journal_mode = WAL')
          sqlite.exec('PRAGMA foreign_keys = ON')
          sqlite.exec('PRAGMA busy_timeout = 5000')
          return sqlite
        },
      }),
    })
  } else {
    // pg は動的 import にして、SQLite のみで動かす場合にモジュール読み込みを避ける
    const { default: pg } = await import('pg')
    db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: config.connectionString, max: 5 }),
      }),
    })
  }
  setMigrationDriver(config.driver)
  await migrateToLatest(db as unknown as Kysely<unknown>)
  return db
}
