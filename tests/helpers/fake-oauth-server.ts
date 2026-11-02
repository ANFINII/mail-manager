import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

export type GrantBehavior = 'ok' | 'invalid_grant' | 'server_error' | 'hang' | 'malformed';

export interface FakeGrant {
  accessToken: string;
  expiresIn?: number;
  /** レスポンスで新しい refresh token を返す（ローテーション再現） */
  rotateTo?: string;
  behavior?: GrantBehavior;
}

/** 対話ログイン（/authorize）でサインインしたことにするユーザー */
export interface FakeLoginUser {
  email: string;
  refreshToken: string;
  accessToken: string;
  /** id_token を返さない（メールアドレスはアプリの入力値に頼る） */
  noIdToken?: boolean;
  /** ユーザーが同意を拒否した */
  deny?: boolean;
}

/** OAuth2 token endpoint の擬似サーバー。refresh_token → access_token を返す。 */
export class FakeOAuthServer {
  readonly grants = new Map<string, FakeGrant>();
  loginUser: FakeLoginUser | null = null;
  private readonly codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; user: FakeLoginUser }
  >();
  lastAuthorizeParams: URLSearchParams | null = null;
  readonly stats = { requests: 0, byRefreshToken: {} as Record<string, number>, lastBody: '' };
  port = 0;
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();

  get tokenUrl(): string {
    return `http://127.0.0.1:${this.port}/token`;
  }

  get authorizeUrl(): string {
    return `http://127.0.0.1:${this.port}/authorize`;
  }

  /** GET /authorize: サインイン・同意済みとして redirect_uri へ認可コードを返す */
  private authorize(req: http.IncomingMessage, res: http.ServerResponse): void {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    this.lastAuthorizeParams = q;
    const redirect = new URL(q.get('redirect_uri') ?? '');
    redirect.searchParams.set('state', q.get('state') ?? '');
    const user = this.loginUser;
    if (!user || user.deny) {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', 'The user denied consent');
    } else {
      const code = randomBytes(8).toString('hex');
      this.codes.set(code, {
        challenge: q.get('code_challenge') ?? '',
        redirectUri: q.get('redirect_uri') ?? '',
        clientId: q.get('client_id') ?? '',
        user,
      });
      redirect.searchParams.set('code', code);
    }
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
  }

  /** POST /token grant_type=authorization_code */
  private exchangeCode(params: URLSearchParams, res: http.ServerResponse): void {
    const entry = this.codes.get(params.get('code') ?? '');
    const verifier = params.get('code_verifier') ?? '';
    const ok =
      entry &&
      entry.redirectUri === params.get('redirect_uri') &&
      entry.clientId === params.get('client_id') &&
      createHash('sha256').update(verifier).digest('base64url') === entry.challenge;
    if (!ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code or verifier' }));
      return;
    }
    this.codes.delete(params.get('code')!);
    const u = entry.user;
    this.setGrant(u.refreshToken, { accessToken: u.accessToken });
    const idToken = u.noIdToken
      ? undefined
      : ['e30', Buffer.from(JSON.stringify({ email: u.email })).toString('base64url'), 'sig'].join('.');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        token_type: 'Bearer',
        access_token: u.accessToken,
        refresh_token: u.refreshToken,
        expires_in: 3600,
        ...(idToken ? { id_token: idToken } : {}),
      }),
    );
  }

  setGrant(refreshToken: string, grant: FakeGrant): void {
    this.grants.set(refreshToken, grant);
  }

  async start(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/authorize')) {
        this.authorize(req, res);
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.stats.requests++;
        this.stats.lastBody = body;
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'authorization_code') {
          this.exchangeCode(params, res);
          return;
        }
        const refreshToken = params.get('refresh_token') ?? '';
        this.stats.byRefreshToken[refreshToken] =
          (this.stats.byRefreshToken[refreshToken] ?? 0) + 1;
        const grant = this.grants.get(refreshToken);
        const behavior = grant?.behavior ?? (grant ? 'ok' : 'invalid_grant');
        if (behavior === 'hang') return; // 応答しない
        if (behavior === 'malformed') {
          // access_token を含まない 200 応答 → アプリ側では分類不能な「その他のエラー」になる
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token_type: 'Bearer' }));
          return;
        }
        if (behavior === 'server_error') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
          return;
        }
        if (behavior === 'invalid_grant' || !grant) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'AADSTS70000: The refresh token has expired or is invalid.',
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            token_type: 'Bearer',
            access_token: grant.accessToken,
            expires_in: grant.expiresIn ?? 3600,
            ...(grant.rotateTo ? { refresh_token: grant.rotateTo } : {}),
          }),
        );
      });
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.tokenUrl;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }
}
