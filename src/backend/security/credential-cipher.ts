import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM による認証情報の暗号化。
 * - 鍵は 32 バイト。DB には保存せず、main プロセスが macOS Keychain (safeStorage) で保護して渡す。
 * - IV は 12 バイトの乱数、AAD にはアカウントの email を使い、他アカウントへの差し替えを防ぐ。
 */
export interface EncryptedBlob {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export class CredentialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('CredentialCipher requires a 32-byte key')
  }

  static generateKey(): Buffer {
    return randomBytes(32)
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const blob: EncryptedBlob = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    }
    return JSON.stringify(blob)
  }

  decrypt(serialized: string, aad: string): string {
    const blob = JSON.parse(serialized) as EncryptedBlob
    if (blob.v !== 1) throw new Error(`Unsupported credential blob version: ${blob.v}`)
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
    const pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()])
    return pt.toString('utf8')
  }
}
