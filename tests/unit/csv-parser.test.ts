import { describe, expect, it } from 'vitest';
import { normalizeHeader, parseAccountsCsv } from '@backend/accounts/csv-parser';

describe('parseAccountsCsv', () => {
  it('parses the legacy 8-column format from the spec', () => {
    const csv =
      'email,password,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure\n' +
      'user001@example.com,password001,imap.example.com,993,true,smtp.example.com,465,true\n' +
      'user002@example.com,password002,imap.example.com,993,true,smtp.example.com,465,true\n';
    const parsed = parseAccountsCsv(csv);
    expect(parsed.format).toBe('csv');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].row).toBe(2);
    expect(parsed.rows[0].values).toMatchObject({
      email: 'user001@example.com',
      password: 'password001',
      imap_port: '993',
    });
    expect(parsed.rows[1].row).toBe(3);
  });

  it('normalises headers, BOM and quoted values', () => {
    const csv = '﻿Email,Pass,Refresh Token,ClientId\n"a@x.com","p,1","rt","cid"\n';
    const parsed = parseAccountsCsv(csv);
    expect(parsed.columns).toEqual(['email', 'password', 'refresh_token', 'client_id']);
    expect(parsed.rows[0].values.password).toBe('p,1');
  });

  it('keeps password whitespace intact', () => {
    const parsed = parseAccountsCsv('email,password\na@x.com, spaced \n');
    expect(parsed.rows[0].values.password).toBe(' spaced ');
  });

  it('parses the dash-separated token format', () => {
    const parsed = parseAccountsCsv(
      'a@outlook.com----pw----cid----rtoken\n\nb@outlook.com----pw2----cid----rtoken2\n',
    );
    expect(parsed.format).toBe('dash-separated');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].values).toMatchObject({
      email: 'a@outlook.com',
      client_id: 'cid',
      refresh_token: 'rtoken',
      auth_type: 'oauth2',
    });
    expect(parsed.rows[1].row).toBe(3);
  });

  it('maps header aliases', () => {
    expect(normalizeHeader(' Refresh-Token ')).toBe('refresh_token');
    expect(normalizeHeader('IMAP_HOST')).toBe('imap_host');
    expect(normalizeHeader('secret')).toBe('client_secret');
  });
});
