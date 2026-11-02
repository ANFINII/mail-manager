import net from 'node:net';

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  authUser: string | null;
  authMethod: 'LOGIN' | 'XOAUTH2' | null;
}

export interface FakeSmtpOptions {
  /** email(lower) -> password（AUTH LOGIN 用） */
  passwords?: Record<string, string>;
  /** email(lower) -> accessToken（AUTH XOAUTH2 用） */
  tokens?: Record<string, string>;
  allowUnknown?: boolean;
}

/** テスト用の最小 SMTP サーバー。EHLO / AUTH LOGIN / AUTH XOAUTH2 / MAIL / RCPT / DATA / QUIT に応答する（TLS なし）。 */
export class FakeSmtpServer {
  readonly received: ReceivedMail[] = [];
  readonly stats = { connections: 0, authFailures: 0 };
  port = 0;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();

  constructor(private readonly opts: FakeSmtpOptions = {}) {}

  async start(port = 0): Promise<number> {
    this.server = net.createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }

  private handle(socket: net.Socket): void {
    this.sockets.add(socket);
    this.stats.connections++;
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const send = (line: string) => {
      if (!socket.destroyed) socket.write(line + '\r\n');
    };
    send('220 fake-smtp ready');

    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let mail: ReceivedMail = { from: '', to: [], data: '', authUser: null, authMethod: null };
    // AUTH LOGIN の状態: 0=none, 1=want username, 2=want password
    let loginStage = 0;
    let loginUser = '';

    const authOk = (method: 'LOGIN' | 'XOAUTH2', user: string, secret: string): boolean => {
      const u = user.toLowerCase();
      if (method === 'LOGIN') {
        const pw = this.opts.passwords?.[u];
        return pw !== undefined ? pw === secret : !!this.opts.allowUnknown;
      }
      const tok = this.opts.tokens?.[u];
      return tok !== undefined ? tok === secret : !!this.opts.allowUnknown;
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mail.data = dataLines.join('\n');
            this.received.push(mail);
            mail = {
              from: '',
              to: [],
              data: '',
              authUser: mail.authUser,
              authMethod: mail.authMethod,
            };
            dataLines = [];
            send('250 OK queued');
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        if (loginStage === 1) {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          loginStage = 2;
          send('334 ' + Buffer.from('Password:').toString('base64'));
          continue;
        }
        if (loginStage === 2) {
          const pass = Buffer.from(line, 'base64').toString('utf8');
          loginStage = 0;
          if (authOk('LOGIN', loginUser, pass)) {
            mail.authUser = loginUser;
            mail.authMethod = 'LOGIN';
            send('235 2.7.0 Authentication successful');
          } else {
            this.stats.authFailures++;
            send('535 5.7.8 Authentication credentials invalid');
          }
          continue;
        }
        const [cmdRaw, ...rest] = line.split(' ');
        const cmd = cmdRaw.toUpperCase();
        const arg = rest.join(' ');
        switch (cmd) {
          case 'EHLO':
          case 'HELO':
            send('250-fake-smtp');
            send('250-AUTH LOGIN XOAUTH2');
            send('250 OK');
            break;
          case 'AUTH': {
            const [methodRaw, initial] = arg.split(' ');
            const method = (methodRaw ?? '').toUpperCase();
            if (method === 'LOGIN') {
              loginStage = 1;
              send('334 ' + Buffer.from('Username:').toString('base64'));
            } else if (method === 'XOAUTH2') {
              const decoded = Buffer.from((initial ?? '').trim(), 'base64').toString('utf8');
              const m = /user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01/.exec(decoded);
              const user = m?.[1] ?? '';
              const token = m?.[2] ?? '';
              if (authOk('XOAUTH2', user, token)) {
                mail.authUser = user;
                mail.authMethod = 'XOAUTH2';
                send('235 2.7.0 Authentication successful');
              } else {
                this.stats.authFailures++;
                send('334 ' + Buffer.from('{"status":"401"}').toString('base64'));
                send('535 5.7.8 Authentication failed');
              }
            } else {
              send('504 Unsupported auth method');
            }
            break;
          }
          case 'MAIL':
            mail.from = /FROM:<([^>]*)>/i.exec(arg)?.[1] ?? '';
            send('250 OK');
            break;
          case 'RCPT':
            mail.to.push(/TO:<([^>]*)>/i.exec(arg)?.[1] ?? '');
            send('250 OK');
            break;
          case 'DATA':
            inData = true;
            dataLines = [];
            send('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            mail = {
              from: '',
              to: [],
              data: '',
              authUser: mail.authUser,
              authMethod: mail.authMethod,
            };
            send('250 OK');
            break;
          case 'NOOP':
            send('250 OK');
            break;
          case 'QUIT':
            send('221 Bye');
            socket.end();
            break;
          default:
            send('250 OK');
        }
      }
    });
  }
}
