/** テンプレートで使える差し込み項目 */
export const TEMPLATE_VARIABLES = [
  'account',
  'to',
  'from',
  'from_name',
  'subject',
  'date',
  'original_date',
] as const

export type TemplateVariables = Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string>>

/** {{name}} 形式の差し込みを置き換える。未知・未指定の項目は空文字にする */
export function renderTemplate(text: string, vars: TemplateVariables): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) =>
    (TEMPLATE_VARIABLES as readonly string[]).includes(key) ? (vars[key as keyof TemplateVariables] ?? '') : '',
  )
}

/** 返信の件名（既に Re: が付いていれば重ねない） */
export function replySubject(subject: string): string {
  return /^\s*(re|返信)\s*[:：]/i.test(subject) ? subject : `Re: ${subject}`
}

/** 返信本文の引用部分 */
export function quoteBody(text: string, header: string): string {
  const quoted = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')
  return `\n\n${header}\n${quoted}`
}
