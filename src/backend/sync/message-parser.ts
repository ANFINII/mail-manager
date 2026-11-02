import type { MessageEnvelopeObject, MessageStructureObject } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'
import type { AddressInfo } from '@shared/types'
import type { FetchedMessage, MailSession } from '../mail/mail-session'

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  partId: string | null;
  contentId: string | null;
  content?: Buffer;
}

export interface ParsedMessage {
  messageId: string | null;
  inReplyTo: string | null;
  from: AddressInfo | null;
  to: AddressInfo[];
  cc: AddressInfo[];
  subject: string;
  date: string | null;
  text: string | null;
  html: string | null;
  snippet: string;
  attachments: ParsedAttachment[];
}

export interface StructureAttachment {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
}

const SNIPPET_LENGTH = 200

export function makeSnippet(text: string | null, html: string | null): string {
  const src = text && text.trim() ? text : html ? stripHtml(html) : ''
  return src.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH)
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

function envelopeAddresses(list: MessageEnvelopeObject['to']): AddressInfo[] {
  return (list ?? [])
    .filter((a) => a.address)
    .map((a) => ({ name: a.name ?? null, address: a.address as string }))
}

function mailparserAddresses(obj: AddressObject | AddressObject[] | undefined): AddressInfo[] {
  if (!obj) return []
  const list = Array.isArray(obj) ? obj : [obj]
  const out: AddressInfo[] = []
  for (const o of list) {
    for (const v of o.value ?? []) {
      if (v.address) out.push({ name: v.name || null, address: v.address })
      else if (v.group)
        for (const g of v.group)
          if (g.address) out.push({ name: g.name || null, address: g.address })
    }
  }
  return out
}

/** BODYSTRUCTURE を走査して添付パートを列挙する */
export function attachmentsFromStructure(
  node: MessageStructureObject | undefined,
): StructureAttachment[] {
  const out: StructureAttachment[] = []
  const walk = (n: MessageStructureObject) => {
    if (n.childNodes && n.childNodes.length > 0) {
      for (const c of n.childNodes) walk(c)
      return
    }
    const type = (n.type ?? '').toLowerCase()
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? ''
    const isAttachment =
      (n.disposition ?? '').toLowerCase() === 'attachment' ||
      (!!filename && !type.startsWith('text/')) ||
      (!type.startsWith('text/') && !type.startsWith('multipart/') && !!n.part)
    if (isAttachment && n.part) {
      out.push({
        partId: n.part,
        filename: filename || `part-${n.part}`,
        contentType: type || 'application/octet-stream',
        size: n.size ?? 0,
        contentId: n.id ?? null,
      })
    }
  }
  if (node) walk(node)
  return out
}

/** 本文として表示するテキスト/HTML パート（添付ではない最初のもの）を探す */
export function findTextParts(node: MessageStructureObject | undefined): {
  plain?: string;
  html?: string;
} {
  const found: { plain?: string; html?: string } = {}
  const walk = (n: MessageStructureObject) => {
    if (n.childNodes && n.childNodes.length > 0) {
      for (const c of n.childNodes) walk(c)
      return
    }
    const type = (n.type ?? '').toLowerCase()
    const isAttachment = (n.disposition ?? '').toLowerCase() === 'attachment'
    if (isAttachment) return
    if (type === 'text/plain' && !found.plain) found.plain = n.part ?? '1'
    if (type === 'text/html' && !found.html) found.html = n.part ?? '1'
  }
  if (node) walk(node)
  return found
}

/**
 * IMAP から取得したメッセージを DB 保存用の構造に変換する。
 * - source があれば mailparser で解析（通常ケース）
 * - 無ければ ENVELOPE + BODYSTRUCTURE を使い、本文パートだけを個別に取得（巨大メッセージ向け）
 */
export async function parseFetchedMessage(
  msg: FetchedMessage,
  session: MailSession | null,
  opts: { maxPartBytes: number },
): Promise<ParsedMessage> {
  const structureAttachments = attachmentsFromStructure(msg.bodyStructure)
  if (msg.source) {
    const parsed = await simpleParser(msg.source, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
    })
    const from = mailparserAddresses(parsed.from)[0] ?? null
    const text = parsed.text ?? null
    const html = typeof parsed.html === 'string' ? parsed.html : null
    const fileAttachments = parsed.attachments.filter(
      (a) => !a.related || a.contentDisposition === 'attachment',
    )
    const attachments: ParsedAttachment[] = fileAttachments.map((a, i) => ({
      filename: a.filename || `attachment-${i + 1}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size ?? a.content?.length ?? 0,
      partId:
        structureAttachments.length === fileAttachments.length
          ? structureAttachments[i].partId
          : null,
      contentId: a.contentId ?? null,
      content: a.content,
    }))
    return {
      messageId: parsed.messageId ?? msg.envelope?.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      from,
      to: mailparserAddresses(parsed.to),
      cc: mailparserAddresses(parsed.cc),
      subject: parsed.subject ?? msg.envelope?.subject ?? '',
      date: parsed.date
        ? parsed.date.toISOString()
        : msg.envelope?.date
          ? new Date(msg.envelope.date).toISOString()
          : msg.internalDate,
      text,
      html,
      snippet: makeSnippet(text, html),
      attachments,
    }
  }

  const env = msg.envelope ?? {}
  const parts = findTextParts(msg.bodyStructure)
  let text: string | null = null
  let html: string | null = null
  if (session) {
    if (parts.plain) {
      const dl = await session.downloadPart(msg.uid, parts.plain, opts.maxPartBytes)
      text = dl.content.toString('utf8')
    }
    if (parts.html) {
      const dl = await session.downloadPart(msg.uid, parts.html, opts.maxPartBytes)
      html = dl.content.toString('utf8')
    }
  }
  const from = envelopeAddresses(env.from)[0] ?? null
  return {
    messageId: env.messageId ?? null,
    inReplyTo: env.inReplyTo ?? null,
    from,
    to: envelopeAddresses(env.to),
    cc: envelopeAddresses(env.cc),
    subject: env.subject ?? '',
    date: env.date ? new Date(env.date).toISOString() : msg.internalDate,
    text,
    html,
    snippet: makeSnippet(text, html),
    attachments: structureAttachments.map((a) => ({ ...a })),
  }
}
