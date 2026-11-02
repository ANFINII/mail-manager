import http from 'node:http';
import type net from 'node:net';
import { buildMessage, type FakeMessageSpec } from './mime';

export interface ApiMessage {
  id: string;
  /** Graph: フォルダ ID / Gmail: ラベル ID の集合 */
  folders: Set<string>;
  raw: Buffer;
  read: boolean;
  flagged: boolean;
  received: Date;
}

/**
 * Microsoft Graph と Gmail API の擬似サーバー（必要なエンドポイントだけ）。
 * Graph は /graph/v1.0/..., Gmail は /gmail/v1/... で受ける。トークンは token で照合する。
 */
export class FakeMailApiServer {
  port = 0;
  token = 'AT-api';
  readonly messages: ApiMessage[] = [];
  readonly stats = { requests: 0, raws: 0 };
  /** Graph のフォルダ（id, 表示名, 既知の別名） */
  readonly graphFolders = [
    { id: 'f-inbox', displayName: 'Inbox', alias: 'inbox' },
    { id: 'f-sent', displayName: 'Sent Items', alias: 'sentitems' },
    { id: 'f-trash', displayName: 'Deleted Items', alias: 'deleteditems' },
    { id: 'f-archive', displayName: 'Archive', alias: 'archive' },
  ];
  readonly gmailLabels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
    { id: 'TRASH', name: 'TRASH', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'STARRED', name: 'STARRED', type: 'system' },
    { id: 'Label_1', name: 'Work', type: 'user' },
  ];
  private seq = 0;
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();

  get graphUrl(): string {
    return `http://127.0.0.1:${this.port}/graph/v1.0`;
  }
  get gmailUrl(): string {
    return `http://127.0.0.1:${this.port}/gmail/v1`;
  }

  add(folder: string, spec: FakeMessageSpec, opts: { read?: boolean; flagged?: boolean } = {}): ApiMessage {
    const id = `m${++this.seq}`;
    const m: ApiMessage = {
      id,
      folders: new Set([folder]),
      raw: buildMessage(spec, this.seq).raw,
      read: opts.read ?? false,
      flagged: opts.flagged ?? false,
      received: spec.date,
    };
    this.messages.push(m);
    return m;
  }

  in(folder: string): ApiMessage[] {
    return this.messages.filter((m) => m.folders.has(folder));
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.stats.requests++;
        if (req.headers.authorization !== `Bearer ${this.token}`) {
          res.writeHead(401).end(JSON.stringify({ error: { code: 'InvalidAuthenticationToken' } }));
          return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        const json = (status: number, v?: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(v === undefined ? '' : JSON.stringify(v));
        };
        try {
          if (url.pathname.startsWith('/graph/v1.0/')) this.graph(req.method!, url, body ? JSON.parse(body) : undefined, res, json);
          else if (url.pathname.startsWith('/gmail/v1/')) this.gmail(req.method!, url, body ? JSON.parse(body) : undefined, res, json);
          else json(404, {});
        } catch (err) {
          json(500, { error: String(err) });
        }
      });
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private graph(method: string, url: URL, body: any, res: http.ServerResponse, json: (s: number, v?: unknown) => void): void {
    const p = url.pathname.replace('/graph/v1.0', '');
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/me/mailFolders') return json(200, { value: this.graphFolders.map(({ id, displayName }) => ({ id, displayName })) });
    if (method === 'GET' && (m = /^\/me\/mailFolders\/([^/]+)$/.exec(p))) {
      const f = this.graphFolders.find((x) => x.alias === m![1] || x.id === m![1]);
      return f ? json(200, { id: f.id, displayName: f.displayName }) : json(404, { error: { code: 'ErrorFolderNotFound' } });
    }
    if (method === 'GET' && (m = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(p))) {
      const list = this.in(m[1]).sort((a, b) => a.received.getTime() - b.received.getTime());
      // 1 ページ 2 件にしてページ送り（@odata.nextLink）も試す
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      const page = list.slice(skip, skip + 2);
      const next = skip + 2 < list.length ? `${this.graphUrl}${p}?$skip=${skip + 2}` : undefined;
      return json(200, {
        value: page.map((x) => ({
          id: x.id,
          isRead: x.read,
          flag: { flagStatus: x.flagged ? 'flagged' : 'notFlagged' },
          receivedDateTime: x.received.toISOString(),
        })),
        ...(next ? { '@odata.nextLink': next } : {}),
      });
    }
    if (method === 'GET' && (m = /^\/me\/messages\/([^/]+)\/\$value$/.exec(p))) {
      const msg = this.messages.find((x) => x.id === m![1]);
      if (!msg) return json(404, {});
      this.stats.raws++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(msg.raw);
      return;
    }
    if (method === 'PATCH' && (m = /^\/me\/messages\/([^/]+)$/.exec(p))) {
      const msg = this.messages.find((x) => x.id === m![1])!;
      if (body.isRead !== undefined) msg.read = body.isRead;
      if (body.flag) msg.flagged = body.flag.flagStatus === 'flagged';
      return json(200, { id: msg.id });
    }
    if (method === 'POST' && (m = /^\/me\/messages\/([^/]+)\/move$/.exec(p))) {
      const msg = this.messages.find((x) => x.id === m![1])!;
      // Graph は移動すると ID が変わる
      msg.id = `m${++this.seq}`;
      msg.folders = new Set([body.destinationId]);
      return json(201, { id: msg.id });
    }
    if (method === 'DELETE' && (m = /^\/me\/messages\/([^/]+)$/.exec(p))) {
      const i = this.messages.findIndex((x) => x.id === m![1]);
      if (i >= 0) this.messages.splice(i, 1);
      return json(204);
    }
    json(404, {});
  }

  private gmail(method: string, url: URL, body: any, res: http.ServerResponse, json: (s: number, v?: unknown) => void): void {
    const p = url.pathname.replace('/gmail/v1', '');
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/users/me/profile') return json(200, { emailAddress: 'x' });
    if (method === 'GET' && p === '/users/me/labels') return json(200, { labels: this.gmailLabels });
    if (method === 'GET' && p === '/users/me/messages') {
      const labels = url.searchParams.getAll('labelIds');
      const list = this.messages
        .filter((x) =>
          labels.every((l) => (l === 'UNREAD' ? !x.read : l === 'STARRED' ? x.flagged : x.folders.has(l))),
        )
        .sort((a, b) => b.received.getTime() - a.received.getTime()); // 新しい順
      return json(200, { messages: list.map((x) => ({ id: x.id })) });
    }
    if (method === 'GET' && (m = /^\/users\/me\/messages\/([^/]+)$/.exec(p))) {
      const msg = this.messages.find((x) => x.id === m![1]);
      if (!msg) return json(404, {});
      this.stats.raws++;
      return json(200, { id: msg.id, raw: msg.raw.toString('base64url'), internalDate: String(msg.received.getTime()) });
    }
    if (method === 'POST' && p === '/users/me/messages/batchModify') {
      for (const id of body.ids) this.modify(id, body.addLabelIds ?? [], body.removeLabelIds ?? []);
      return json(204);
    }
    if (method === 'POST' && (m = /^\/users\/me\/messages\/([^/]+)\/modify$/.exec(p))) {
      this.modify(m[1], body.addLabelIds ?? [], body.removeLabelIds ?? []);
      return json(200, { id: m[1] });
    }
    if (method === 'DELETE' && (m = /^\/users\/me\/messages\/([^/]+)$/.exec(p))) {
      const i = this.messages.findIndex((x) => x.id === m![1]);
      if (i >= 0) this.messages.splice(i, 1);
      return json(204);
    }
    json(404, {});
  }

  private modify(id: string, add: string[], remove: string[]): void {
    const msg = this.messages.find((x) => x.id === id)!;
    for (const l of add) {
      if (l === 'UNREAD') msg.read = false;
      else if (l === 'STARRED') msg.flagged = true;
      else msg.folders.add(l);
    }
    for (const l of remove) {
      if (l === 'UNREAD') msg.read = true;
      else if (l === 'STARRED') msg.flagged = false;
      else msg.folders.delete(l);
    }
  }
}
