import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

export interface MasterKey {
  key: Buffer;
  mode: 'keychain' | 'insecure-file';
}

/**
 * 認証情報暗号化用のマスターキーを用意する。
 * - 通常: 乱数 32 バイトを生成し、Electron safeStorage（macOS では Keychain 由来の鍵）で包んで userData/master.key に保存
 * - MM_INSECURE_KEY_FILE=1（テスト専用）: 0600 のファイルに生の鍵を置く
 * どちらの場合も鍵は DB には入らない。
 */
export async function loadOrCreateMasterKey(
  userDataPath: string,
  opts: { allowInsecure: boolean },
): Promise<MasterKey> {
  fs.mkdirSync(userDataPath, { recursive: true })
  const keyPath = path.join(userDataPath, 'master.key')
  const insecurePath = path.join(userDataPath, 'master.key.insecure')

  if (!opts.allowInsecure && safeStorage.isEncryptionAvailable()) {
    if (fs.existsSync(keyPath)) {
      const hex = safeStorage.decryptString(fs.readFileSync(keyPath))
      const key = Buffer.from(hex, 'hex')
      if (key.length !== 32) throw new Error('master.key is corrupted')
      return { key, mode: 'keychain' }
    }
    const key = randomBytes(32)
    fs.writeFileSync(keyPath, safeStorage.encryptString(key.toString('hex')), { mode: 0o600 })
    return { key, mode: 'keychain' }
  }

  if (opts.allowInsecure) {
    if (fs.existsSync(insecurePath)) {
      const key = Buffer.from(fs.readFileSync(insecurePath, 'utf8').trim(), 'hex')
      if (key.length === 32) return { key, mode: 'insecure-file' }
    }
    const key = randomBytes(32)
    fs.writeFileSync(insecurePath, key.toString('hex'), { mode: 0o600 })
    return { key, mode: 'insecure-file' }
  }

  throw new Error(
    'OS の安全なストレージ (Keychain) が利用できないため、認証情報の暗号鍵を保護できません。',
  )
}
