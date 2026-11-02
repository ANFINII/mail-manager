export interface PasswordCredentials {
  type: 'password';
  password: string;
}

export interface OAuthCredentials {
  type: 'oauth2';
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  /**
   * 取り込み時に password 列にあった値。OAuth2 認証には使わないが、
   * 取り込んだ情報をそのまま保持・再出力するために残す（トークン配布ツールの識別子など）。
   */
  password?: string;
}

export type Credentials = PasswordCredentials | OAuthCredentials;

export function serializeCredentials(c: Credentials): string {
  return JSON.stringify(c)
}

export function parseCredentials(json: string): Credentials {
  const parsed = JSON.parse(json) as Credentials
  if (parsed.type !== 'password' && parsed.type !== 'oauth2') {
    throw new Error('Unknown credentials type')
  }
  return parsed
}

/** ログのスクラバーに登録すべき秘密値を列挙する。 */
export function credentialSecrets(c: Credentials): string[] {
  if (c.type === 'password') return [c.password]
  return [c.refreshToken, c.clientSecret ?? '', c.password ?? ''].filter(Boolean)
}
