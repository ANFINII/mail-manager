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

/** OAuth2 token endpoint の擬似サーバー。refresh_token → access_token を返す。 */
export class FakeOAuthServer {
  readonly grants = new Map<string, FakeGrant>();
  readonly stats = { requests: 0, byRefreshToken: {} as Record<string, number>, lastBody: '' };
  port = 0;
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();

  get tokenUrl(): string {
    return `http://127.0.0.1:${this.port}/token`;
  }

  setGrant(refreshToken: string, grant: FakeGrant): void {
    this.grants.set(refreshToken, grant);
  }

  async start(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.stats.requests++;
        this.stats.lastBody = body;
        const params = new URLSearchParams(body);
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
