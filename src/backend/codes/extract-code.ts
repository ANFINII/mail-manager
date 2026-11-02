import { stripHtml } from '../sync/message-parser'

export interface ExtractedCode {
  /** 認証コード・ワンタイムパスワード（数字 4〜8 桁、または英数字 6〜8 文字） */
  code: string | null;
  /** 確認・ログイン用のリンク */
  link: string | null;
}

/** コードの直前・直後に現れる語（日本語・英語） */
const KEYWORDS = [
  '認証コード',
  '確認コード',
  '検証コード',
  'セキュリティコード',
  'ワンタイムパスワード',
  'ワンタイムコード',
  'ログインコード',
  '承認コード',
  '暗証番号',
  'パスコード',
  'コード',
  '認証番号',
  '確認番号',
  'verification code',
  'security code',
  'confirmation code',
  'one-time password',
  'one-time code',
  'one time password',
  'login code',
  'sign-in code',
  'sign in code',
  'passcode',
  'otp',
  'pin',
  'code',
]
// 英語の語は単語の一部（"shipping" の "pin"、"barcode" の "code"）に一致しないよう境界を付ける
const KEYWORD_RE = new RegExp(
  KEYWORDS.map((k) => {
    const esc = k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    return /^[ -~]+$/.test(k) ? `(?<![A-Za-z])${esc}(?![A-Za-z])` : esc
  }).join('|'),
  'gi',
)

/** 件名に含まれていればコードメールとみなす語 */
const SUBJECT_HINT_RE =
  /認証|確認コード|ワンタイム|コード|パスコード|verification|verify|security code|one-time|otp|passcode|sign[- ]?in|log[- ]?in code|confirm/i

/** コード候補: 4〜8 桁の数字（3+3 / 4+4 の区切りも可）、または大文字英字と数字を両方含む 6〜8 文字 */
const CODE_RE = /(?<![\w/#.-])(\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|\d{4,8}|(?=[A-Z0-9]{6,8}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w/-])/g

/** 確認・ログインリンクらしい URL */
const LINK_HINT_RE =
  /verif|confirm|activat|magic|sign[-_]?in|login|auth|token|validate|one[-_]?time|otp|reset/i
const URL_RE = /https?:\/\/[^\s"'<>()]+/gi

/** 年や時刻・金額・電話番号の一部など、コードではない数字を除く */
function looksLikeNoise(candidate: string, context: string): boolean {
  const digits = candidate.replace(/[ -]/g, '')
  if (/^(19|20)\d{2}$/.test(digits) && /年|year|©|copyright/i.test(context)) return true
  if (/[¥$€£]\s*$|円/.test(context.slice(-3)) || /^\s*(円|yen|usd|ドル)/i.test(context)) return true
  return false
}

const WINDOW = 60

/**
 * 本文から認証コードと確認リンクを取り出す。
 * コードは「認証コード」「verification code」などの語の近く（前後 60 文字以内）にある候補を、距離が近い順に採用する。
 * 件名がコードメールらしい場合は、語が無くても本文の目立つ単独の数字を採用する。
 */
export function extractCode(input: {
  subject: string;
  text: string | null;
  html: string | null;
}): ExtractedCode {
  const body = (input.text && input.text.trim() ? input.text : input.html ? stripHtml(input.html) : '')
    .replace(/\r/g, '')
    .slice(0, 20_000)
  const subject = input.subject ?? ''
  return { code: findCode(subject, body), link: findLink(input.text, input.html) }
}

function findCode(subject: string, body: string): string | null {
  // 件名にコードそのものがある場合（例: "123456 is your code"）
  const fromSubject = nearKeyword(subject)
  if (fromSubject) return fromSubject
  const fromBody = nearKeyword(body)
  if (fromBody) return fromBody
  if (!SUBJECT_HINT_RE.test(subject)) return null
  // 語が無くても、件名がコードメールらしければ「行に単独で書かれた」数字を採用する
  for (const line of body.split('\n')) {
    const m = /^\s*(\d{4,8}|\d{3}[ -]\d{3})\s*$/.exec(line)
    if (m) return normalize(m[1])
  }
  return null
}

function nearKeyword(text: string): string | null {
  if (!text) return null
  let best: { code: string; dist: number } | null = null
  for (const k of text.matchAll(KEYWORD_RE)) {
    const kStart = k.index ?? 0
    const kEnd = kStart + k[0].length
    const from = Math.max(0, kStart - WINDOW)
    const to = Math.min(text.length, kEnd + WINDOW)
    const region = text.slice(from, to)
    for (const c of region.matchAll(CODE_RE)) {
      const cStart = from + (c.index ?? 0)
      const cEnd = cStart + c[0].length
      // キーワード自体の中（例: "otp" の一部）は除く
      if (cStart < kEnd && cEnd > kStart) continue
      const context = text.slice(Math.max(0, cStart - 12), cEnd + 6)
      if (looksLikeNoise(c[0], context)) continue
      const dist = cStart >= kEnd ? cStart - kEnd : kStart - cEnd
      // 後ろにある方を優先する（"コード: 123456" の形が多い）
      const score = cStart >= kEnd ? dist : dist + 20
      if (!best || score < best.dist) best = { code: normalize(c[0]), dist: score }
    }
  }
  return best?.code ?? null
}

function normalize(code: string): string {
  return code.replace(/[ -]/g, '')
}

function findLink(text: string | null, html: string | null): string | null {
  const candidates: string[] = []
  if (html) {
    // アンカーの文言が「確認」「ログイン」なども見る
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeEntities(m[1])
      const label = stripHtml(m[2])
      if (!/^https?:\/\//i.test(href)) continue
      if (/unsubscribe|配信停止|privacy|プライバシー/i.test(href + label)) continue
      if (LINK_HINT_RE.test(href) || /確認|認証|ログイン|有効化|verify|confirm|sign in|log in|activate/i.test(label))
        candidates.push(href)
    }
  }
  for (const m of (text ?? '').matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?）)]+$/, '')
    if (/unsubscribe|配信停止|privacy/i.test(url)) continue
    if (LINK_HINT_RE.test(url)) candidates.push(url)
  }
  return candidates[0] ?? null
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/')
}
