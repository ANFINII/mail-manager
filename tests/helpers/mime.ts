/**
 * テスト用の MIME メッセージ生成。擬似 IMAP サーバーが返す raw / ENVELOPE / BODYSTRUCTURE / 各パートを組み立てる。
 * 対応する形:
 *   - text/plain のみ
 *   - multipart/alternative (text/plain + text/html)
 *   - multipart/mixed ( (alternative | text/plain), 添付... )
 */
export interface FakeAddress {
  name?: string;
  address: string;
}

export interface FakeAttachmentSpec {
  filename: string;
  contentType: string;
  content: Buffer | string;
}

export interface FakeMessageSpec {
  from: FakeAddress;
  to: FakeAddress[];
  cc?: FakeAddress[];
  subject: string;
  date: Date;
  text: string;
  html?: string;
  attachments?: FakeAttachmentSpec[];
  flags?: string[];
  messageId?: string;
  inReplyTo?: string;
}

export interface BuiltPart {
  body: Buffer;
  mime: Buffer;
}

export interface BuiltMessage {
  raw: Buffer;
  header: Buffer;
  text: Buffer;
  envelope: string;
  bodyStructure: string;
  parts: Map<string, BuiltPart>;
}

interface Node {
  type: string;
  subtype: string;
  params: Record<string, string>;
  encoding: string;
  body: Buffer;
  children: Node[];
  boundary?: string;
  disposition?: { type: string; params: Record<string, string> };
}

const CRLF = '\r\n';
let boundarySeq = 0;

function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(s);
}

export function encodeWord(s: string): string {
  return isAscii(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function formatAddress(a: FakeAddress): string {
  if (!a.name) return a.address;
  const name = isAscii(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : encodeWord(a.name);
  return `${name} <${a.address}>`;
}

function quote(s: string | undefined | null): string {
  if (s === undefined || s === null) return 'NIL';
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function envelopeAddresses(list: FakeAddress[] | undefined): string {
  if (!list || list.length === 0) return 'NIL';
  return (
    '(' +
    list
      .map((a) => {
        const [mailbox, host] = a.address.split('@');
        return `(${a.name ? quote(encodeWord(a.name)) : 'NIL'} NIL ${quote(mailbox)} ${quote(host)})`;
      })
      .join('') +
    ')'
  );
}

function base64Lines(buf: Buffer): string {
  const b64 = buf.toString('base64');
  return b64.replace(/(.{76})/g, '$1\r\n');
}

function textNode(subtype: 'plain' | 'html', text: string): Node {
  return {
    type: 'text',
    subtype,
    params: { charset: 'utf-8' },
    encoding: '8bit',
    body: Buffer.from(text.replace(/\r?\n/g, CRLF), 'utf8'),
    children: [],
  };
}

function attachmentNode(a: FakeAttachmentSpec): Node {
  const [type, subtype] = a.contentType.split('/');
  const content = typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : a.content;
  return {
    type: type ?? 'application',
    subtype: subtype ?? 'octet-stream',
    params: { name: a.filename },
    encoding: 'base64',
    body: Buffer.from(base64Lines(content), 'ascii'),
    children: [],
    disposition: { type: 'attachment', params: { filename: a.filename } },
  };
}

function multipartNode(subtype: string, children: Node[]): Node {
  const boundary = `=_fake_${Date.now().toString(36)}_${(boundarySeq++).toString(36)}`;
  return {
    type: 'multipart',
    subtype,
    params: { boundary },
    encoding: '7bit',
    body: Buffer.alloc(0),
    children,
    boundary,
  };
}

function partHeaders(n: Node): string {
  const params = Object.entries(n.params)
    .map(([k, v]) => `; ${k}="${v}"`)
    .join('');
  let h = `Content-Type: ${n.type}/${n.subtype}${params}${CRLF}`;
  if (n.type !== 'multipart') h += `Content-Transfer-Encoding: ${n.encoding}${CRLF}`;
  if (n.disposition) {
    const dp = Object.entries(n.disposition.params)
      .map(([k, v]) => `; ${k}="${v}"`)
      .join('');
    h += `Content-Disposition: ${n.disposition.type}${dp}${CRLF}`;
  }
  return h;
}

/** ノードの本体（マルチパートなら boundary で結合した全体）を返す */
function serializeBody(n: Node): Buffer {
  if (n.type !== 'multipart') return n.body;
  const chunks: Buffer[] = [];
  for (const c of n.children) {
    chunks.push(Buffer.from(`--${n.boundary}${CRLF}${partHeaders(c)}${CRLF}`, 'utf8'));
    chunks.push(serializeBody(c));
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${n.boundary}--${CRLF}`, 'utf8'));
  return Buffer.concat(chunks);
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n + (buf[buf.length - 1] === 0x0a ? 0 : 1);
}

function bodyStructureOf(n: Node): string {
  if (n.type === 'multipart') {
    return `(${n.children.map(bodyStructureOf).join('')} ${quote(n.subtype.toUpperCase())} ("BOUNDARY" ${quote(n.boundary ?? '')}) NIL NIL NIL)`;
  }
  const params =
    Object.keys(n.params).length === 0
      ? 'NIL'
      : '(' +
        Object.entries(n.params)
          .map(([k, v]) => `${quote(k.toUpperCase())} ${quote(v)}`)
          .join(' ') +
        ')';
  const body = serializeBody(n);
  const size = body.length;
  const basic = `${quote(n.type.toUpperCase())} ${quote(n.subtype.toUpperCase())} ${params} NIL NIL ${quote(n.encoding.toUpperCase())} ${size}`;
  const lines = n.type === 'text' ? ` ${countLines(body)}` : '';
  const disposition = n.disposition
    ? `(${quote(n.disposition.type.toUpperCase())} (${Object.entries(n.disposition.params)
        .map(([k, v]) => `${quote(k.toUpperCase())} ${quote(v)}`)
        .join(' ')}))`
    : 'NIL';
  return `(${basic}${lines} NIL ${disposition} NIL NIL)`;
}

function collectParts(n: Node, prefix: string, parts: Map<string, BuiltPart>): void {
  if (n.type === 'multipart') {
    n.children.forEach((c, i) => {
      const id = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      parts.set(id, { body: serializeBody(c), mime: Buffer.from(partHeaders(c), 'utf8') });
      collectParts(c, id, parts);
    });
  }
}

export function formatImapDate(d: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

export function buildMessage(spec: FakeMessageSpec, uidForId = 0): BuiltMessage {
  let root: Node;
  const textPart = textNode('plain', spec.text);
  const content = spec.html
    ? multipartNode('alternative', [textPart, textNode('html', spec.html)])
    : textPart;
  if (spec.attachments && spec.attachments.length > 0) {
    root = multipartNode('mixed', [content, ...spec.attachments.map(attachmentNode)]);
  } else {
    root = content;
  }

  const messageId = spec.messageId ?? `<fake-${uidForId}-${Date.now().toString(36)}@fake.test>`;
  const headerLines = [
    `From: ${formatAddress(spec.from)}`,
    `To: ${spec.to.map(formatAddress).join(', ')}`,
    ...(spec.cc && spec.cc.length > 0 ? [`Cc: ${spec.cc.map(formatAddress).join(', ')}`] : []),
    `Subject: ${encodeWord(spec.subject)}`,
    `Date: ${spec.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    ...(spec.inReplyTo ? [`In-Reply-To: ${spec.inReplyTo}`] : []),
    'MIME-Version: 1.0',
  ];
  const header = Buffer.from(headerLines.join(CRLF) + CRLF + partHeaders(root) + CRLF, 'utf8');
  const text = serializeBody(root);
  const raw = Buffer.concat([header, text]);

  const parts = new Map<string, BuiltPart>();
  if (root.type === 'multipart') collectParts(root, '', parts);
  else parts.set('1', { body: text, mime: Buffer.from(partHeaders(root), 'utf8') });

  const envelope = `(${quote(spec.date.toUTCString().replace('GMT', '+0000'))} ${quote(encodeWord(spec.subject))} ${envelopeAddresses([spec.from])} ${envelopeAddresses([spec.from])} ${envelopeAddresses([spec.from])} ${envelopeAddresses(spec.to)} ${envelopeAddresses(spec.cc)} NIL ${spec.inReplyTo ? quote(spec.inReplyTo) : 'NIL'} ${quote(messageId)})`;

  return { raw, header, text, envelope, bodyStructure: bodyStructureOf(root), parts };
}
