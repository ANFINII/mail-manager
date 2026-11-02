/**
 * ダミーアカウント CSV を生成する（実アカウントは一切含まない）。
 *   npm run gen:csv -- --count 300 --host 127.0.0.1 --port 3143 --secure none --out tests/fixtures/generated/accounts-300.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateAccounts, toCsv } from '../tests/helpers/csv-fixtures';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const count = Number(arg('count', '300'));
const host = arg('host', '127.0.0.1');
const port = Number(arg('port', '3143'));
const secure = arg('secure', 'none') as 'tls' | 'starttls' | 'none';
const out = arg('out', `tests/fixtures/generated/accounts-${count}.csv`);

const rows = generateAccounts({ count, imapHost: host, imapPort: port, imapSecure: secure });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, toCsv(rows), 'utf8');
console.log(`wrote ${rows.length} dummy accounts to ${out}`);
