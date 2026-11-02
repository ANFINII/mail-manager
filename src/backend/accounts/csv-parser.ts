import { parse } from 'csv-parse/sync'

export interface RawCsvRow {
  /** ファイル内の行番号（1 始まり、ヘッダー行を含む） */
  row: number;
  values: Record<string, string>;
}

export interface ParsedCsv {
  columns: string[];
  rows: RawCsvRow[];
  format: 'csv' | 'dash-separated';
}

const HEADER_ALIASES: Record<string, string> = {
  mail: 'email',
  e_mail: 'email',
  address: 'email',
  user: 'email',
  username: 'email',
  pass: 'password',
  pwd: 'password',
  host: 'imap_host',
  server: 'imap_host',
  port: 'imap_port',
  ssl: 'imap_secure',
  secure: 'imap_secure',
  tls: 'imap_secure',
  clientid: 'client_id',
  client: 'client_id',
  clientsecret: 'client_secret',
  secret: 'client_secret',
  refresh: 'refresh_token',
  refreshtoken: 'refresh_token',
  token: 'refresh_token',
  auth: 'auth_type',
  type: 'auth_type',
  group_name: 'group',
  groupname: 'group',
  グループ: 'group',
  socks: 'proxy',
  proxy_url: 'proxy',
}

export function normalizeHeader(name: string): string {
  const key = name
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  return HEADER_ALIASES[key] ?? key
}

/**
 * アカウント CSV をパースする。値のトリムはここでは行わない（パスワードの前後空白を壊さないため）。
 * 「email----password----client_id----refresh_token」形式（Outlook トークン一括配布で一般的）も受け付ける。
 */
export function parseAccountsCsv(content: string): ParsedCsv {
  const text = content.replace(/^﻿/, '')
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  if (firstLine.includes('----') && !firstLine.includes(',')) {
    return parseDashSeparated(text)
  }
  const records = parse(text, {
    columns: (header: string[]) => header.map(normalizeHeader),
    skip_empty_lines: true,
    bom: true,
    trim: false,
    relax_column_count: true,
    relax_quotes: true,
    info: true,
  }) as Array<{ record: Record<string, string>; info: { lines: number } }>
  const columns = records.length > 0 ? Object.keys(records[0].record) : []
  const rows: RawCsvRow[] = records.map(({ record, info }) => ({
    row: info.lines,
    values: Object.fromEntries(
      Object.entries(record).map(([k, v]) => [k, typeof v === 'string' ? v : String(v ?? '')]),
    ),
  }))
  return { columns, rows, format: 'csv' }
}

function parseDashSeparated(text: string): ParsedCsv {
  const rows: RawCsvRow[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, idx) => {
    if (!line.trim()) return
    const parts = line.split('----')
    const [email = '', password = '', client_id = '', refresh_token = ''] = parts
    rows.push({
      row: idx + 1,
      values: {
        email: email.trim(),
        password,
        client_id: client_id.trim(),
        refresh_token: refresh_token.trim(),
        auth_type: refresh_token.trim() ? 'oauth2' : 'password',
      },
    })
  })
  return {
    columns: ['email', 'password', 'client_id', 'refresh_token'],
    rows,
    format: 'dash-separated',
  }
}
