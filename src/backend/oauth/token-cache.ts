interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** アクセストークンはメモリにだけ保持する。DB には保存しない。 */
export class TokenCache {
  private tokens = new Map<string, CachedToken>()

  constructor(private readonly safetyMarginMs = 60_000) {}

  get(accountId: string, now = Date.now()): string | null {
    const t = this.tokens.get(accountId)
    if (!t) return null
    if (t.expiresAt - this.safetyMarginMs <= now) {
      this.tokens.delete(accountId)
      return null
    }
    return t.accessToken
  }

  set(accountId: string, accessToken: string, expiresAt: number): void {
    this.tokens.set(accountId, { accessToken, expiresAt })
  }

  delete(accountId: string): void {
    this.tokens.delete(accountId)
  }

  clear(): void {
    this.tokens.clear()
  }
}
