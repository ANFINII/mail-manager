import http from 'node:http';
import net from 'node:net';

export interface GraphSent {
  token: string;
  to: string[];
  subject: string;
  bodyType: string;
  body: string;
  attachments: string[];
  saveToSentItems: boolean;
}

/** Microsoft Graph の /me/sendMail を模した擬似サーバー。有効な accessToken を要求する。 */
export class FakeGraphServer {
  readonly sent: GraphSent[] = [];
  readonly stats = { requests: 0, unauthorized: 0 };
  /** 受け付ける Bearer トークン。空なら何でも受理 */
  validTokens = new Set<string>();
  /** 'accept' なら送信受理、'reject' なら常に 403（未同意を模す） */
  mode: 'accept' | 'reject' = 'accept';
  port = 0;
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();

  get sendUrl(): string {
    return `http://127.0.0.1:${this.port}/me/sendMail`;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.stats.requests++;
        const auth = req.headers['authorization'] || '';
        const token = auth.replace(/^Bearer /, '');
        if (this.mode === 'reject' || (this.validTokens.size > 0 && !this.validTokens.has(token))) {
          this.stats.unauthorized++;
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'ErrorAccessDenied', message: 'Mail.Send not consented' },
            }),
          );
          return;
        }
        try {
          const j = JSON.parse(body);
          const m = j.message ?? {};
          this.sent.push({
            token,
            to: (m.toRecipients ?? []).map(
              (r: { emailAddress: { address: string } }) => r.emailAddress.address,
            ),
            subject: m.subject ?? '',
            bodyType: m.body?.contentType ?? '',
            body: m.body?.content ?? '',
            attachments: (m.attachments ?? []).map((a: { name: string }) => a.name),
            saveToSentItems: !!j.saveToSentItems,
          });
        } catch {
          // ignore parse errors
        }
        res.writeHead(202);
        res.end();
      });
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.sendUrl;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }
}
