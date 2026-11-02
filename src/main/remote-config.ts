import fs from 'node:fs'
import type { RemoteConfig } from '@shared/types'

interface Stored {
  mode: 'local' | 'remote';
  url: string;
  /** safeStorage で暗号化したトークン（base64） */
  token: string | null;
}

export interface Cipher {
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

/** 接続先（このPC / 共有サーバー）の設定。トークンは OS の安全なストレージで暗号化して保存する */
export class RemoteConfigStore {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  private read(): Stored {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Stored>
      return { mode: v.mode === 'remote' ? 'remote' : 'local', url: v.url ?? '', token: v.token ?? null }
    } catch {
      return { mode: 'local', url: '', token: null }
    }
  }

  get(): RemoteConfig {
    const s = this.read()
    return { mode: s.mode, url: s.url, hasToken: !!s.token }
  }

  /** 接続に使う値（トークンは復号済み）。ローカルなら null */
  connection(): { url: string; token: string } | null {
    const s = this.read()
    if (s.mode !== 'remote' || !s.url || !s.token) return null
    return { url: s.url, token: this.cipher.decryptString(Buffer.from(s.token, 'base64')) }
  }

  /** token を省略（空）すると保存済みのトークンを使い続ける */
  set(next: { mode: 'local' | 'remote'; url: string; token?: string }): RemoteConfig {
    const cur = this.read()
    const url = next.url.trim()
    if (next.mode === 'remote') {
      if (!/^https?:\/\//.test(url)) throw new Error('サーバーの URL は http(s):// で始めてください')
      if (!next.token && !cur.token) throw new Error('アクセストークンを入力してください')
    }
    const token = next.token ? this.cipher.encryptString(next.token).toString('base64') : cur.token
    fs.writeFileSync(this.file, JSON.stringify({ mode: next.mode, url, token }), { mode: 0o600 })
    return this.get()
  }
}

/** サーバーに届くか・トークンが通るかを確かめる。サーバーのバージョンを返す */
export async function testRemote(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const base = url.trim().replace(/\/+$/, '')
  const health = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(10_000) })
  if (!health.ok) throw new Error(`サーバーに接続できません（HTTP ${health.status}）`)
  const res = await fetchImpl(`${base}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'app.info', params: {} }),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 401) throw new Error('トークンが正しくありません')
  const body = (await res.json()) as { ok: boolean; result?: { version: string }; error?: { message: string } }
  if (!body.ok) throw new Error(body.error?.message ?? 'サーバーエラー')
  return body.result!.version
}
