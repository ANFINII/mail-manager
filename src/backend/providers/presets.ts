import type { Provider, SecureMode } from '@shared/types'

export interface OAuthPreset {
  tokenUrl: string;
  scope: string;
  /** SMTP 送信用のスコープ（IMAP 用とは別に取得する） */
  smtpScope: string;
  /** Graph API 送信用のスコープ（Microsoft のみ） */
  graphScope?: string;
  /** Graph API の sendMail エンドポイント（Microsoft のみ） */
  graphSendUrl?: string;
  /** Google は client_secret が必須、Microsoft の公開クライアントは不要 */
  clientSecretRequired: boolean;
}

export interface ProviderPreset {
  provider: Provider;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: SecureMode;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: SecureMode;
  /** パスワード（アプリパスワード含む）による IMAP 認証が可能か */
  passwordAuthSupported: boolean;
  oauth?: OAuthPreset;
}

const DEFAULTS: Record<Provider, ProviderPreset> = {
  outlook: {
    provider: 'outlook',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: 'tls',
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: 'starttls',
    // Microsoft は多くの環境で Basic 認証(IMAP パスワード)を無効化しているが、
    // 有効なアカウントもあるため、取り込みでは許可して実際の認証はサーバー判定に任せる。
    // （無効なアカウントは認証テスト/同期で「取得失敗」や認証エラーになる）
    passwordAuthSupported: true,
    oauth: {
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      smtpScope: 'https://outlook.office.com/SMTP.Send offline_access',
      graphScope: 'https://graph.microsoft.com/Mail.Send offline_access',
      graphSendUrl: 'https://graph.microsoft.com/v1.0/me/sendMail',
      clientSecretRequired: false,
    },
  },
  gmail: {
    provider: 'gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: 'tls',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: 'tls',
    // 2 段階認証 + アプリパスワードで LOGIN 可能
    passwordAuthSupported: true,
    oauth: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://mail.google.com/',
      smtpScope: 'https://mail.google.com/',
      clientSecretRequired: true,
    },
  },
  custom: {
    provider: 'custom',
    passwordAuthSupported: true,
  },
}

const DOMAIN_TO_PROVIDER: Record<string, Provider> = {
  'outlook.com': 'outlook',
  'outlook.jp': 'outlook',
  'hotmail.com': 'outlook',
  'hotmail.co.jp': 'outlook',
  'live.com': 'outlook',
  'live.jp': 'outlook',
  'msn.com': 'outlook',
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
}

export function inferProviderFromEmail(email: string): Provider {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return DOMAIN_TO_PROVIDER[domain] ?? 'custom'
}

export class ProviderRegistry {
  private presets: Record<Provider, ProviderPreset>

  /**
   * @param env 開発・テスト用の上書き。
   *   MM_OAUTH_TOKEN_URL_OUTLOOK / MM_OAUTH_TOKEN_URL_GMAIL で token endpoint を擬似サーバーに向けられる。
   */
  constructor(env: NodeJS.ProcessEnv = {}) {
    this.presets = structuredClone(DEFAULTS)
    const outlookUrl = env.MM_OAUTH_TOKEN_URL_OUTLOOK
    const gmailUrl = env.MM_OAUTH_TOKEN_URL_GMAIL
    if (outlookUrl && this.presets.outlook.oauth) this.presets.outlook.oauth.tokenUrl = outlookUrl
    if (gmailUrl && this.presets.gmail.oauth) this.presets.gmail.oauth.tokenUrl = gmailUrl
    const graphUrl = env.MM_GRAPH_SEND_URL_OUTLOOK
    if (graphUrl && this.presets.outlook.oauth) this.presets.outlook.oauth.graphSendUrl = graphUrl
  }

  get(provider: Provider): ProviderPreset {
    return this.presets[provider]
  }

  isProvider(value: string): value is Provider {
    return value === 'outlook' || value === 'gmail' || value === 'custom'
  }
}
