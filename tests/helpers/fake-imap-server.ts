import net from 'node:net';
import tls from 'node:tls';
import { generate as generateCert } from 'selfsigned';
import { buildMessage, formatImapDate, type BuiltMessage, type FakeMessageSpec } from './mime';

export type UserBehavior = 'ok' | 'auth_fail' | 'bad_command';

export interface FakeMessage extends BuiltMessage {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  spec: FakeMessageSpec;
}

export interface FakeMailbox {
  path: string;
  specialUse?: string;
  noselect?: boolean;
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
}

export interface FakeUser {
  password?: string;
  accessToken?: string;
  behavior?: UserBehavior;
  /** 認証応答を遅らせる（ms） */
  delayMs?: number;
  /** 指定しなければ INBOX / Sent / Trash / Junk を作る */
  mailboxes?: Map<string, FakeMailbox>;
}

export interface FakeImapOptions {
  tls?: boolean;
  users?: Record<string, FakeUser>;
  allowUnknown?: boolean;
  hang?: boolean;
  dropOnConnect?: boolean;
  greetingDelayMs?: number;
  /** FETCH 応答を遅らせる（ms、メッセージごと） */
  fetchDelayMs?: number;
}

export interface FakeImapStats {
  totalConnections: number;
  current: number;
  maxConcurrent: number;
  currentSessions: number;
  maxConcurrentSessions: number;
  loginAttempts: number;
  xoauth2Attempts: number;
  attemptsByUser: Record<string, number>;
  selects: number;
  fetches: number;
  fetchedMessages: number;
  stores: number;
  moves: number;
  expunges: number;
  appends: number;
  logouts: number;
  /** LOGOUT を受け取らずに切断された接続数 */
  closedWithoutLogout: number;
}

let uidValiditySeq = 1_725_000_000;

export function createMailbox(path: string, specialUse?: string, noselect = false): FakeMailbox {
  return { path, specialUse, noselect, uidValidity: uidValiditySeq++, uidNext: 1, messages: [] };
}

function defaultMailboxes(): Map<string, FakeMailbox> {
  const m = new Map<string, FakeMailbox>();
  m.set('INBOX', createMailbox('INBOX'));
  m.set('Sent', createMailbox('Sent', '\\Sent'));
  m.set('Trash', createMailbox('Trash', '\\Trash'));
  m.set('Junk', createMailbox('Junk', '\\Junk'));
  return m;
}

/**
 * テスト用 IMAP サーバー。認証（LOGIN / AUTHENTICATE PLAIN / XOAUTH2）に加えて、
 * LIST / SELECT / UID SEARCH / UID FETCH（ENVELOPE, BODYSTRUCTURE, BODY[...]）/ UID STORE / EXPUNGE / UID MOVE / COPY に応答する。
 * 同時接続数・セッション数を計測する。
 */
export class FakeImapServer {
  readonly stats: FakeImapStats = {
    totalConnections: 0,
    current: 0,
    maxConcurrent: 0,
    currentSessions: 0,
    maxConcurrentSessions: 0,
    loginAttempts: 0,
    xoauth2Attempts: 0,
    attemptsByUser: {},
    selects: 0,
    fetches: 0,
    fetchedMessages: 0,
    stores: 0,
    moves: 0,
    expunges: 0,
    appends: 0,
    logouts: 0,
    closedWithoutLogout: 0,
  };
  port = 0;
  private server: net.Server | tls.Server | null = null;
  private sockets = new Set<net.Socket>();
  readonly users = new Map<string, FakeUser>();

  constructor(private readonly opts: FakeImapOptions = {}) {
    for (const [email, u] of Object.entries(opts.users ?? {})) this.setUser(email, u);
  }

  setUser(email: string, user: FakeUser): void {
    const existing = this.users.get(email.toLowerCase());
    this.users.set(email.toLowerCase(), {
      ...user,
      mailboxes: user.mailboxes ?? existing?.mailboxes ?? defaultMailboxes(),
    });
  }

  getUser(email: string): FakeUser | undefined {
    return this.users.get(email.toLowerCase());
  }

  mailbox(email: string, path = 'INBOX'): FakeMailbox {
    const u = this.getUser(email);
    if (!u?.mailboxes) throw new Error(`unknown user ${email}`);
    let mb = u.mailboxes.get(path);
    if (!mb) {
      mb = createMailbox(path);
      u.mailboxes.set(path, mb);
    }
    return mb;
  }

  addMessage(email: string, path: string, spec: FakeMessageSpec): FakeMessage {
    const mb = this.mailbox(email, path);
    const uid = mb.uidNext++;
    const built = buildMessage(spec, uid);
    const msg: FakeMessage = {
      ...built,
      uid,
      flags: new Set(spec.flags ?? []),
      internalDate: spec.date,
      spec,
    };
    mb.messages.push(msg);
    return msg;
  }

  addMessages(email: string, path: string, specs: FakeMessageSpec[]): FakeMessage[] {
    return specs.map((s) => this.addMessage(email, path, s));
  }

  /** UIDVALIDITY を変えて全メッセージを新しい UID で振り直す（サーバー再構築の再現） */
  bumpUidValidity(email: string, path = 'INBOX'): void {
    const mb = this.mailbox(email, path);
    mb.uidValidity = uidValiditySeq++;
    let uid = 1;
    for (const m of mb.messages) m.uid = uid++;
    mb.uidNext = uid;
  }

  async start(port = 0): Promise<number> {
    const handler = (socket: net.Socket) => this.handle(socket);
    if (this.opts.tls) {
      const pems = await generateCert([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048,
      });
      this.server = tls.createServer({ key: pems.private, cert: pems.cert }, handler);
    } else {
      this.server = net.createServer(handler);
    }
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
    this.stats.totalConnections++;
    this.stats.current++;
    this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.stats.current);
    let sessionOpen = true;
    this.stats.currentSessions++;
    this.stats.maxConcurrentSessions = Math.max(
      this.stats.maxConcurrentSessions,
      this.stats.currentSessions,
    );
    const endSession = (viaLogout = false) => {
      if (!sessionOpen) return;
      sessionOpen = false;
      this.stats.currentSessions--;
      if (viaLogout) this.stats.logouts++;
      else this.stats.closedWithoutLogout++;
    };
    socket.on('close', () => {
      this.stats.current--;
      this.sockets.delete(socket);
      endSession();
    });
    socket.on('error', () => undefined);

    if (this.opts.dropOnConnect) {
      socket.destroy();
      return;
    }
    if (this.opts.hang) return;

    const write = (data: string | Buffer) => {
      if (!socket.destroyed) socket.write(data);
    };
    const send = (line: string) => write(line + '\r\n');
    const capabilities = 'IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2 UIDPLUS MOVE SPECIAL-USE';
    const sendGreeting = () => send(`* OK [CAPABILITY ${capabilities}] Fake IMAP ready`);
    if (this.opts.greetingDelayMs) setTimeout(sendGreeting, this.opts.greetingDelayMs);
    else sendGreeting();

    const session = new Session(this, socket, send, write, capabilities, () => endSession(true));
    let buffer = '';
    let literalWait: { line: string; remaining: number } | null = null;
    let processing = Promise.resolve();

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      processing = processing.then(async () => {
        while (true) {
          if (literalWait) {
            if (buffer.length < literalWait.remaining) return;
            const lit = buffer.slice(0, literalWait.remaining);
            buffer = buffer.slice(literalWait.remaining);
            const nl = buffer.indexOf('\r\n');
            if (nl < 0) return;
            const rest = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const line = `${literalWait.line}${JSON.stringify(lit)}${rest}`;
            literalWait = null;
            await session.handleLine(line);
            continue;
          }
          const nl = buffer.indexOf('\r\n');
          if (nl < 0) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const litMatch = /^(.*)\{(\d+)\}$/.exec(line);
          if (litMatch && !session.pending) {
            literalWait = { line: litMatch[1], remaining: Number(litMatch[2]) };
            send('+ go ahead');
            continue;
          }
          await session.handleLine(line);
        }
      });
    });
  }
}

interface AuthResult {
  ok: boolean;
  behavior: UserBehavior;
  delayMs?: number;
  user: string;
}

class Session {
  pending: { tag: string; mechanism: 'PLAIN' | 'XOAUTH2' } | { tag: string; failNo: true } | null =
    null;
  private user: FakeUser | null = null;
  private selected: FakeMailbox | null = null;

  constructor(
    private readonly server: FakeImapServer,
    private readonly socket: net.Socket,
    private readonly send: (line: string) => void,
    private readonly write: (data: string | Buffer) => void,
    private readonly capabilities: string,
    private readonly endSession: () => void,
  ) {}

  private get opts(): FakeImapOptions {
    return (this.server as unknown as { opts: FakeImapOptions }).opts;
  }

  private checkPassword(user: string, password: string): AuthResult {
    this.server.stats.loginAttempts++;
    this.server.stats.attemptsByUser[user] = (this.server.stats.attemptsByUser[user] ?? 0) + 1;
    const u = this.server.getUser(user);
    if (!u) return { ok: !!this.opts.allowUnknown, behavior: 'ok', user };
    return {
      ok: u.password !== undefined && u.password === password,
      behavior: u.behavior ?? 'ok',
      delayMs: u.delayMs,
      user,
    };
  }

  private checkToken(user: string, token: string): AuthResult {
    this.server.stats.xoauth2Attempts++;
    this.server.stats.attemptsByUser[user] = (this.server.stats.attemptsByUser[user] ?? 0) + 1;
    const u = this.server.getUser(user);
    if (!u) return { ok: !!this.opts.allowUnknown, behavior: 'ok', user };
    return {
      ok: u.accessToken !== undefined && u.accessToken === token,
      behavior: u.behavior ?? 'ok',
      delayMs: u.delayMs,
      user,
    };
  }

  private async finishAuth(tag: string, r: AuthResult): Promise<void> {
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.behavior === 'bad_command') {
      this.send(`${tag} BAD Unknown command`);
      return;
    }
    if (r.ok && r.behavior === 'ok') {
      this.user = this.server.getUser(r.user) ?? { mailboxes: new Map() };
      if (!this.user.mailboxes) this.user.mailboxes = new Map();
      if (this.opts.allowUnknown && !this.server.getUser(r.user))
        this.server.setUser(r.user, this.user);
      this.send(`${tag} OK [CAPABILITY ${this.capabilities}] ${r.user} authenticated`);
    } else {
      this.send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);
      // 認証に失敗した接続はクライアントが切断する。TCP の終了を待たずにセッション終了として数える
      this.endSession();
    }
  }

  private async handleSasl(
    tag: string,
    mechanism: 'PLAIN' | 'XOAUTH2',
    payload: string,
  ): Promise<void> {
    const decoded = Buffer.from(payload.trim(), 'base64').toString('utf8');
    if (mechanism === 'PLAIN') {
      const parts = decoded.split('\0');
      await this.finishAuth(tag, this.checkPassword(parts[1] ?? '', parts[2] ?? ''));
      return;
    }
    const m = /user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01/.exec(decoded);
    const r = this.checkToken(m?.[1] ?? '', m?.[2] ?? '');
    if (r.ok && r.behavior === 'ok') {
      await this.finishAuth(tag, r);
    } else if (r.behavior === 'bad_command') {
      this.send(`${tag} BAD Unknown command`);
    } else {
      this.send(
        '+ ' +
          Buffer.from(
            '{"status":"401","schemes":"bearer","scope":"https://mail.example/"}',
          ).toString('base64'),
      );
      this.pending = { tag, failNo: true };
    }
  }

  async handleLine(line: string): Promise<void> {
    if (this.pending && 'failNo' in this.pending) {
      const tag = this.pending.tag;
      this.pending = null;
      this.send(`${tag} NO [AUTHENTICATIONFAILED] AUTHENTICATE failed`);
      this.endSession();
      return;
    }
    if (this.pending && 'mechanism' in this.pending) {
      const { tag, mechanism } = this.pending;
      this.pending = null;
      if (line === '*') {
        this.send(`${tag} BAD Authentication cancelled`);
        return;
      }
      await this.handleSasl(tag, mechanism, line);
      return;
    }
    const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    if (!m) {
      this.send('* BAD Invalid command');
      return;
    }
    const [, tag, cmdRaw, args = ''] = m;
    let cmd = cmdRaw.toUpperCase();
    let rest = args;
    let uidMode = false;
    if (cmd === 'UID') {
      const sub = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
      cmd = (sub?.[1] ?? '').toUpperCase();
      rest = sub?.[2] ?? '';
      uidMode = true;
    }
    try {
      await this.dispatch(tag, cmd, rest, uidMode);
    } catch (err) {
      this.send(`${tag} BAD ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async dispatch(tag: string, cmd: string, args: string, uidMode: boolean): Promise<void> {
    switch (cmd) {
      case 'CAPABILITY':
        this.send(`* CAPABILITY ${this.capabilities}`);
        this.send(`${tag} OK CAPABILITY completed`);
        return;
      case 'NOOP':
        this.send(`${tag} OK NOOP completed`);
        return;
      case 'LOGOUT':
        this.send('* BYE Logging out');
        this.send(`${tag} OK LOGOUT completed`);
        this.endSession();
        this.socket.end();
        return;
      case 'ID':
        this.send('* ID NIL');
        this.send(`${tag} OK ID completed`);
        return;
      case 'NAMESPACE':
        this.send('* NAMESPACE (("" "/")) NIL NIL');
        this.send(`${tag} OK NAMESPACE completed`);
        return;
      case 'LOGIN': {
        const [user = '', pass = ''] = parseAtoms(args);
        await this.finishAuth(tag, this.checkPassword(user, pass));
        return;
      }
      case 'AUTHENTICATE': {
        const [mechRaw, initial] = args.split(/\s+/, 2);
        const mech = (mechRaw ?? '').toUpperCase();
        if (mech !== 'PLAIN' && mech !== 'XOAUTH2') {
          this.send(`${tag} NO Unsupported mechanism`);
          return;
        }
        if (initial) await this.handleSasl(tag, mech, initial);
        else {
          this.pending = { tag, mechanism: mech };
          this.send('+ ');
        }
        return;
      }
    }

    if (!this.user) {
      this.send(`${tag} NO Not authenticated`);
      return;
    }
    const mailboxes = this.user.mailboxes!;

    switch (cmd) {
      case 'LIST':
      case 'LSUB':
      case 'XLIST': {
        // LIST [(選択オプション)] "参照名" "パターン" [RETURN (...)]
        const atoms = parseAtoms(args.replace(/\s+RETURN\s+\([^)]*\)\s*$/i, ''));
        const nonOption = atoms.filter((a) => !a.startsWith('('));
        const [reference = '', pattern = ''] = nonOption;
        const respName = cmd === 'LSUB' ? 'LSUB' : 'LIST';
        if (reference === '' && pattern === '') {
          // 区切り文字の問い合わせ
          this.send(`* ${respName} (\\Noselect) "/" ""`);
          this.send(`${tag} OK ${cmd} completed`);
          return;
        }
        const full = reference + pattern;
        const regex = new RegExp(
          '^' +
            full
              .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/%/g, '[^/]*') +
            '$',
          'i',
        );
        for (const mb of mailboxes.values()) {
          if (!regex.test(mb.path)) continue;
          const flags = [
            mb.noselect ? '\\Noselect' : '\\HasNoChildren',
            ...(mb.specialUse ? [mb.specialUse] : []),
          ];
          this.send(`* ${respName} (${flags.join(' ')}) "/" ${quoteAtom(mb.path)}`);
        }
        this.send(`${tag} OK ${cmd} completed`);
        return;
      }
      case 'STATUS': {
        const [path] = parseAtoms(args);
        const mb = mailboxes.get(path);
        if (!mb) {
          this.send(`${tag} NO No such mailbox`);
          return;
        }
        const unseen = mb.messages.filter((m) => !m.flags.has('\\Seen')).length;
        this.send(
          `* STATUS ${quoteAtom(mb.path)} (MESSAGES ${mb.messages.length} UIDNEXT ${mb.uidNext} UIDVALIDITY ${mb.uidValidity} UNSEEN ${unseen})`,
        );
        this.send(`${tag} OK STATUS completed`);
        return;
      }
      case 'SELECT':
      case 'EXAMINE': {
        const [path] = parseAtoms(args);
        const mb = mailboxes.get(path);
        if (!mb || mb.noselect) {
          this.selected = null;
          this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
          return;
        }
        this.server.stats.selects++;
        this.selected = mb;
        this.send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
        this.send(
          '* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted',
        );
        this.send(`* ${mb.messages.length} EXISTS`);
        this.send('* 0 RECENT');
        this.send(`* OK [UIDVALIDITY ${mb.uidValidity}] UIDs valid`);
        this.send(`* OK [UIDNEXT ${mb.uidNext}] Predicted next UID`);
        this.send(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} completed`);
        return;
      }
      case 'CLOSE':
        this.expunge(false);
        this.selected = null;
        this.send(`${tag} OK CLOSE completed`);
        return;
      case 'CREATE': {
        const [path] = parseAtoms(args);
        if (!mailboxes.has(path)) mailboxes.set(path, createMailbox(path));
        this.send(`${tag} OK CREATE completed`);
        return;
      }
      case 'APPEND': {
        this.server.stats.appends++;
        const atoms = parseAtoms(args);
        const path = atoms[0];
        const raw = Buffer.from(atoms[atoms.length - 1] ?? '', 'utf8');
        let mb = mailboxes.get(path);
        if (!mb) {
          mb = createMailbox(path);
          mailboxes.set(path, mb);
        }
        const uid = mb.uidNext++;
        const headerEnd = raw.indexOf('\r\n\r\n');
        const header = headerEnd >= 0 ? raw.subarray(0, headerEnd + 4) : raw;
        const text = headerEnd >= 0 ? raw.subarray(headerEnd + 4) : Buffer.alloc(0);
        mb.messages.push({
          raw,
          header,
          text,
          envelope: 'NIL',
          bodyStructure:
            '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "8BIT" ' +
            text.length +
            ' 1 NIL NIL NIL NIL)',
          parts: new Map([['1', { body: text, mime: header }]]),
          uid,
          flags: new Set(['\\Seen']),
          internalDate: new Date(),
          spec: {
            from: { address: 'me@local' },
            to: [{ address: 'x@x' }],
            subject: 'appended',
            date: new Date(),
            text: '',
          },
        });
        this.send(`${tag} OK [APPENDUID ${mb.uidValidity} ${uid}] APPEND completed`);
        return;
      }
    }

    const mb = this.selected;
    if (!mb) {
      this.send(`${tag} BAD No mailbox selected`);
      return;
    }

    switch (cmd) {
      case 'SEARCH': {
        const uids = this.search(mb, args, uidMode);
        this.send(`* SEARCH${uids.length ? ' ' + uids.join(' ') : ''}`);
        this.send(`${tag} OK SEARCH completed`);
        return;
      }
      case 'FETCH': {
        await this.fetch(tag, mb, args, uidMode);
        return;
      }
      case 'STORE': {
        this.server.stats.stores++;
        const m = /^(\S+)\s+([+-]?FLAGS)(\.SILENT)?\s+\(?([^)]*)\)?$/i.exec(args);
        if (!m) throw new Error('Invalid STORE');
        const targets = this.resolve(mb, m[1], uidMode);
        const op = m[2].toUpperCase();
        const silent = !!m[3];
        const flags = m[4].split(/\s+/).filter(Boolean);
        for (const msg of targets) {
          if (op === 'FLAGS') msg.flags = new Set(flags);
          else if (op === '+FLAGS') flags.forEach((f) => msg.flags.add(f));
          else flags.forEach((f) => msg.flags.delete(f));
          if (!silent)
            this.send(
              `* ${mb.messages.indexOf(msg) + 1} FETCH (UID ${msg.uid} FLAGS (${[...msg.flags].join(' ')}))`,
            );
        }
        this.send(`${tag} OK STORE completed`);
        return;
      }
      case 'EXPUNGE': {
        const only =
          uidMode && args.trim()
            ? new Set(this.resolve(mb, args.trim(), true).map((m) => m.uid))
            : null;
        this.expunge(true, only);
        this.send(`${tag} OK EXPUNGE completed`);
        return;
      }
      case 'COPY':
      case 'MOVE': {
        const [set, destRaw] = splitFirst(args);
        const [dest] = parseAtoms(destRaw);
        const target = mailboxes.get(dest);
        if (!target) {
          this.send(`${tag} NO [TRYCREATE] No such mailbox`);
          return;
        }
        const targets = this.resolve(mb, set, uidMode);
        const srcUids: number[] = [];
        const dstUids: number[] = [];
        for (const msg of targets) {
          const copy: FakeMessage = { ...msg, uid: target.uidNext++, flags: new Set(msg.flags) };
          target.messages.push(copy);
          srcUids.push(msg.uid);
          dstUids.push(copy.uid);
        }
        this.send(
          `* OK [COPYUID ${target.uidValidity} ${srcUids.join(',')} ${dstUids.join(',')}] ${cmd}`,
        );
        if (cmd === 'MOVE') {
          this.server.stats.moves++;
          for (const msg of [...targets].sort(
            (a, b) => mb.messages.indexOf(b) - mb.messages.indexOf(a),
          )) {
            const seq = mb.messages.indexOf(msg) + 1;
            mb.messages.splice(seq - 1, 1);
            this.send(`* ${seq} EXPUNGE`);
          }
        }
        this.send(`${tag} OK ${cmd} completed`);
        return;
      }
      default:
        this.send(`${tag} BAD Unknown command`);
    }
  }

  private expunge(report: boolean, only: Set<number> | null = null): void {
    const mb = this.selected;
    if (!mb) return;
    for (let i = mb.messages.length - 1; i >= 0; i--) {
      const msg = mb.messages[i];
      if (msg.flags.has('\\Deleted') && (!only || only.has(msg.uid))) {
        mb.messages.splice(i, 1);
        this.server.stats.expunges++;
        if (report) this.send(`* ${i + 1} EXPUNGE`);
      }
    }
  }

  /** シーケンスセット（"1:*", "3,5:7"）を UID または連番で解決する */
  private resolve(mb: FakeMailbox, set: string, uidMode: boolean): FakeMessage[] {
    const out: FakeMessage[] = [];
    const maxUid = mb.messages.length ? mb.messages[mb.messages.length - 1].uid : 0;
    const maxSeq = mb.messages.length;
    const ranges = set.split(',');
    for (const r of ranges) {
      const [aRaw, bRaw] = r.split(':');
      const max = uidMode ? maxUid : maxSeq;
      let a = aRaw === '*' ? max : Number(aRaw);
      let b = bRaw === undefined ? a : bRaw === '*' ? max : Number(bRaw);
      if (a > b) [a, b] = [b, a];
      for (let i = 0; i < mb.messages.length; i++) {
        const key = uidMode ? mb.messages[i].uid : i + 1;
        if (key >= a && key <= b && !out.includes(mb.messages[i])) out.push(mb.messages[i]);
      }
    }
    return out;
  }

  private search(mb: FakeMailbox, args: string, uidMode: boolean): number[] {
    const tokens = args.trim().split(/\s+/);
    let candidates = mb.messages;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].toUpperCase();
      if (t === 'ALL') continue;
      if (t === 'UID') {
        const set = tokens[++i];
        const matched = this.resolve(mb, set, true);
        candidates = candidates.filter((m) => matched.includes(m));
      } else if (t === 'UNSEEN') candidates = candidates.filter((m) => !m.flags.has('\\Seen'));
      else if (t === 'SEEN') candidates = candidates.filter((m) => m.flags.has('\\Seen'));
      else if (/^[\d*:,]+$/.test(t)) {
        const matched = this.resolve(mb, t, false);
        candidates = candidates.filter((m) => matched.includes(m));
      }
    }
    return candidates.map((m) => (uidMode ? m.uid : mb.messages.indexOf(m) + 1));
  }

  private async fetch(tag: string, mb: FakeMailbox, args: string, uidMode: boolean): Promise<void> {
    this.server.stats.fetches++;
    const [set, itemsRaw] = splitFirst(args);
    const targets = this.resolve(mb, set, uidMode);
    const items = parseFetchItems(itemsRaw);
    for (const msg of targets) {
      if (this.opts.fetchDelayMs) await new Promise((r) => setTimeout(r, this.opts.fetchDelayMs));
      this.server.stats.fetchedMessages++;
      const seq = mb.messages.indexOf(msg) + 1;
      const chunks: Array<string | Buffer> = [];
      const parts: Array<string | Buffer> = [];
      let includeUid = uidMode;
      for (const item of items) {
        switch (item.name) {
          case 'UID':
            includeUid = true;
            break;
          case 'FLAGS':
            parts.push(`FLAGS (${[...msg.flags].join(' ')})`);
            break;
          case 'INTERNALDATE':
            parts.push(`INTERNALDATE "${formatImapDate(msg.internalDate)}"`);
            break;
          case 'RFC822.SIZE':
            parts.push(`RFC822.SIZE ${msg.raw.length}`);
            break;
          case 'ENVELOPE':
            parts.push(`ENVELOPE ${msg.envelope}`);
            break;
          case 'BODYSTRUCTURE':
          case 'BODY':
            parts.push(`BODYSTRUCTURE ${msg.bodyStructure}`);
            break;
          case 'BODY[': {
            let data = sectionData(msg, item.section ?? '');
            let origin = '';
            if (item.partial) {
              const [start, len] = item.partial;
              data = data.subarray(start, len !== undefined ? start + len : undefined);
              origin = `<${start}>`;
            }
            parts.push(
              Buffer.concat([
                Buffer.from(`BODY[${item.section ?? ''}]${origin} {${data.length}}\r\n`),
                data,
              ]),
            );
            break;
          }
          default:
            break;
        }
      }
      if (includeUid) parts.unshift(`UID ${msg.uid}`);
      chunks.push(`* ${seq} FETCH (`);
      parts.forEach((p, i) => {
        if (i > 0) chunks.push(' ');
        chunks.push(p);
      });
      chunks.push(')\r\n');
      this.write(
        Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c))),
      );
    }
    this.send(`${tag} OK FETCH completed`);
  }
}

interface FetchItem {
  name: string;
  section?: string;
  partial?: [number, number | undefined];
}

function parseFetchItems(raw: string): FetchItem[] {
  let s = raw.trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const upper = s.toUpperCase();
  if (upper === 'FAST')
    return [{ name: 'FLAGS' }, { name: 'INTERNALDATE' }, { name: 'RFC822.SIZE' }];
  if (upper === 'ALL')
    return [
      { name: 'FLAGS' },
      { name: 'INTERNALDATE' },
      { name: 'RFC822.SIZE' },
      { name: 'ENVELOPE' },
    ];
  if (upper === 'FULL')
    return [
      { name: 'FLAGS' },
      { name: 'INTERNALDATE' },
      { name: 'RFC822.SIZE' },
      { name: 'ENVELOPE' },
      { name: 'BODY' },
    ];
  const items: FetchItem[] = [];
  const re = /(BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?|[A-Z0-9.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2] !== undefined) {
      items.push({
        name: 'BODY[',
        section: m[2].toUpperCase(),
        partial:
          m[3] !== undefined
            ? [Number(m[3]), m[4] !== undefined ? Number(m[4]) : undefined]
            : undefined,
      });
    } else {
      items.push({ name: m[1].toUpperCase() });
    }
  }
  return items;
}

function sectionData(msg: FakeMessage, section: string): Buffer {
  if (section === '') return msg.raw;
  if (section === 'HEADER') return msg.header;
  if (section === 'TEXT') return msg.text;
  if (section.startsWith('HEADER.FIELDS')) {
    const wanted = (/\(([^)]*)\)/.exec(section)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => h.toLowerCase());
    const lines = msg.header.toString('utf8').split('\r\n');
    const out: string[] = [];
    let keep = false;
    for (const line of lines) {
      if (/^\s/.test(line)) {
        if (keep) out.push(line);
        continue;
      }
      const name = line.split(':')[0]?.toLowerCase();
      keep = wanted.includes(name);
      if (keep) out.push(line);
    }
    return Buffer.from(out.join('\r\n') + '\r\n\r\n', 'utf8');
  }
  const mime = /^(.+)\.MIME$/.exec(section);
  if (mime) return msg.parts.get(mime[1])?.mime ?? Buffer.alloc(0);
  return msg.parts.get(section)?.body ?? Buffer.alloc(0);
}

function splitFirst(s: string): [string, string] {
  const t = s.trim();
  const i = t.indexOf(' ');
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1).trim()];
}

function quoteAtom(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 引用符付き文字列とアトムを分割する */
export function parseAtoms(args: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    while (args[i] === ' ') i++;
    if (i >= args.length) break;
    if (args[i] === '"') {
      let j = i + 1;
      let s = '';
      while (j < args.length && args[j] !== '"') {
        if (args[j] === '\\' && j + 1 < args.length) {
          s += args[j + 1];
          j += 2;
        } else {
          s += args[j];
          j++;
        }
      }
      out.push(s);
      i = j + 1;
    } else if (args[i] === '(') {
      let depth = 0;
      let j = i;
      while (j < args.length) {
        if (args[j] === '(') depth++;
        if (args[j] === ')') depth--;
        j++;
        if (depth === 0) break;
      }
      out.push(args.slice(i, j));
      i = j;
    } else {
      let j = i;
      while (j < args.length && args[j] !== ' ') j++;
      out.push(args.slice(i, j));
      i = j;
    }
  }
  return out;
}
