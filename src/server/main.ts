/* eslint-disable no-console -- サーバーの起動メッセージは標準出力に出す */
/**
 * 共有サーバーとして起動する（Electron なし）。
 *
 *   MM_SERVER_TOKENS="alice:<16文字以上>,bob:<16文字以上>" \
 *   DATABASE_URL=postgres://...   # 省略時は MM_DATA_DIR の SQLite
 *   npm run server
 *
 * 環境変数:
 *   MM_DATA_DIR       データ（SQLite・添付・ログ・鍵ファイル）の場所（既定 ./mail-manager-data）
 *   MM_MASTER_KEY     認証情報の暗号鍵（64 桁の 16 進）。省略時は MM_DATA_DIR/master.key（0600）を作って使う
 *   MM_SERVER_HOST    待ち受けアドレス（既定 127.0.0.1。外部に公開するなら TLS かリバースプロキシを使う）
 *   MM_SERVER_PORT    ポート（既定 8787）
 *   MM_TLS_CERT / MM_TLS_KEY  HTTPS で待ち受ける場合の証明書・秘密鍵
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BackendApp } from '@backend/app'
import { createMailServer, parseTokens } from './http-server'

function masterKey(dataDir: string): Buffer {
  const fromEnv = process.env.MM_MASTER_KEY
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'hex')
    if (key.length !== 32) throw new Error('MM_MASTER_KEY must be 64 hex characters')
    return key
  }
  const file = path.join(dataDir, 'master.key')
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex')
  const key = randomBytes(32)
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  console.warn(`Created ${file}. Keep it safe and back it up: without it stored credentials cannot be decrypted.`)
  return key
}

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.MM_DATA_DIR || 'mail-manager-data')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const tokens = parseTokens(process.env.MM_SERVER_TOKENS)
  const app = await BackendApp.create({
    userDataPath: dataDir,
    masterKey: masterKey(dataDir),
    env: process.env,
    keyMode: 'server',
  })
  const tls =
    process.env.MM_TLS_CERT && process.env.MM_TLS_KEY
      ? { cert: process.env.MM_TLS_CERT, key: process.env.MM_TLS_KEY }
      : undefined
  const server = createMailServer({ app, tokens, tls, tmpDir: path.join(dataDir, 'tmp') })
  const host = process.env.MM_SERVER_HOST || '127.0.0.1'
  const port = Number(process.env.MM_SERVER_PORT || 8787)
  server.listen(port, host, () => {
    app.logger.info('Server listening', { host, port, tls: !!tls, users: tokens.map((t) => t.name) })
    console.log(`Mail Manager server on ${tls ? 'https' : 'http'}://${host}:${port} (${tokens.length} users)`)
  })
  const stop = () => {
    server.close()
    void app.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
