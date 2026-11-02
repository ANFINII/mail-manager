import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

export interface MasterKey {
  key: Buffer;
  mode: 'keychain' | 'insecure-file' | 'basic-text';
}

/**
 * 認証情報暗号化用のマスターキーを用意する。
 * - 通常: 乱数 32 バイトを生成し、Electron safeStorage（macOS: Keychain / Windows: DPAPI / Linux: libsecret・KWallet）で包んで userData/master.key に保存
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
    // Linux でキーリング（GNOME Keyring / KWallet）が無いと safeStorage は固定鍵（basic_text）になり、
    // 実質的に保護されない。動作は続けるが、設定画面で警告する。
    const mode: MasterKey['mode'] =
      process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'
        ? 'basic-text'
        : 'keychain'
    if (fs.existsSync(keyPath)) {
      const hex = safeStorage.decryptString(fs.readFileSync(keyPath))
      const key = Buffer.from(hex, 'hex')
      if (key.length !== 32) throw new Error('master.key is corrupted')
      return { key, mode }
    }
    const key = randomBytes(32)
    fs.writeFileSync(keyPath, safeStorage.encryptString(key.toString('hex')), { mode: 0o600 })
    return { key, mode }
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
    'OS の安全なストレージ（Keychain / DPAPI / キーリング）が利用できないため、認証情報の暗号鍵を保護できません。',
  )
}
