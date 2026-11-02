import type { ErrorKind, SecureMode } from '@shared/types'
import type { MailSession } from './mail-session'

export interface ConnectionTestParams {
  host: string;
  port: number;
  secure: SecureMode;
  user: string;
  auth: { type: 'password'; password: string } | { type: 'oauth2'; accessToken: string };
  proxy?: string | null;
  timeoutMs: number;
  rejectUnauthorized: boolean;
}

/**
 * メールサーバー接続層の抽象。Phase 1 は ImapFlow 実装のみ。
 * 将来 EmailEngine (REST) や Microsoft Graph 実装に差し替えられるようにしている。
 */
export interface EmailProvider {
  testConnection(params: ConnectionTestParams, signal?: AbortSignal): Promise<void>;
  openSession(params: ConnectionTestParams, signal?: AbortSignal): Promise<MailSession>;
}

export class MailError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'MailError'
  }
}
