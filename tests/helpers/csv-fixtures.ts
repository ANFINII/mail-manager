export const CSV_COLUMNS = [
  'email',
  'provider',
  'auth_type',
  'password',
  'client_id',
  'client_secret',
  'refresh_token',
  'imap_host',
  'imap_port',
  'imap_secure',
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'proxy',
  'group',
] as const;

export type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], string>>;

function escapeCsv(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: CsvRow[], columns: readonly string[] = CSV_COLUMNS): string {
  const lines = [columns.join(',')];
  for (const r of rows) {
    lines.push(
      columns.map((c) => escapeCsv((r as Record<string, string | undefined>)[c] ?? '')).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export interface FixtureOptions {
  count: number;
  imapHost: string;
  imapPort: number;
  imapSecure?: 'tls' | 'starttls' | 'none';
  /** i 番目のアカウントを oauth2 (outlook) にするか */
  isOAuth?: (i: number) => boolean;
  domainPassword?: string;
  domainOAuth?: string;
}

export interface FixtureAccount extends CsvRow {
  email: string;
  index: number;
}

export function passwordFor(i: number): string {
  return `Pa$$w0rd-${String(i).padStart(3, '0')}-secret`;
}
export function refreshTokenFor(i: number): string {
  return `M.C5refresh.${String(i).padStart(3, '0')}.RT-secret-value`;
}
export function accessTokenFor(i: number): string {
  return `EwB.access.${String(i).padStart(3, '0')}.AT-secret-value`;
}

/** 擬似サーバー向けのダミーアカウントを生成する。パスワード/トークンは全て偽物。 */
export function generateAccounts(opts: FixtureOptions): FixtureAccount[] {
  const isOAuth = opts.isOAuth ?? ((i: number) => i % 2 === 0);
  const out: FixtureAccount[] = [];
  for (let i = 1; i <= opts.count; i++) {
    const n = String(i).padStart(3, '0');
    if (isOAuth(i)) {
      out.push({
        index: i,
        email: `user${n}@${opts.domainOAuth ?? 'outlook.com'}`,
        provider: 'outlook',
        auth_type: 'oauth2',
        client_id: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
        refresh_token: refreshTokenFor(i),
        imap_host: opts.imapHost,
        imap_port: String(opts.imapPort),
        imap_secure: opts.imapSecure ?? 'none',
      });
    } else {
      out.push({
        index: i,
        email: `user${n}@${opts.domainPassword ?? 'gmail.com'}`,
        provider: 'gmail',
        auth_type: 'password',
        password: passwordFor(i),
        imap_host: opts.imapHost,
        imap_port: String(opts.imapPort),
        imap_secure: opts.imapSecure ?? 'none',
      });
    }
  }
  return out;
}
