import { describe, expect, it } from 'vitest';
import { extractCode } from '@backend/codes/extract-code';

const code = (subject: string, text: string, html: string | null = null) =>
  extractCode({ subject, text, html }).code;

describe('extractCode', () => {
  it('finds Japanese and English verification codes next to a keyword', () => {
    expect(code('ログインのお知らせ', 'あなたの認証コードは 482913 です。10 分間有効です。')).toBe('482913');
    expect(code('Security alert', 'Your verification code is: 7731\nIt expires in 5 minutes.')).toBe('7731');
    expect(code('Sign in', 'Use code\n\n  905 112  \n\nto sign in.')).toBe('905112');
    expect(code('Your OTP', 'OTP: K7Q2ZP')).toBe('K7Q2ZP');
    expect(code('確認コードのお知らせ', '確認コード：1234-5678')).toBe('12345678');
  });

  it('reads a code from the subject', () => {
    expect(code('123456 is your Instagram code', 'Hi there')).toBe('123456');
    expect(code('Microsoft アカウントのセキュリティ コード: 3417', '')).toBe('3417');
  });

  it('uses a stand-alone number when the subject looks like a code mail', () => {
    expect(code('ワンタイムパスワード', 'こんにちは\n\n  650021\n\nよろしくお願いします')).toBe('650021');
  });

  it('ignores ordinary numbers in non-code mail', () => {
    expect(code('Your order 10 has shipped', 'Order 12345 shipped on 2026-01-01. Total ¥3980.')).toBeNull();
    expect(code('Weekly report 12', 'Message 12 body. 番号12')).toBeNull();
    expect(code('Shipping update', 'Your shipping number 77123456 and barcode 99881234')).toBeNull();
    expect(code('Newsletter', '© 2026 Example Inc. All rights reserved.')).toBeNull();
  });

  it('does not pick a year or a price near the keyword', () => {
    expect(code('code', 'Promo code valid until 2026年. Price $1999')).toBeNull();
  });

  it('extracts the code from HTML when there is no text part', () => {
    expect(code('Verify', '', '<p>Your code is <b>551 204</b></p>')).toBe('551204');
  });

  it('finds verification links and skips unsubscribe links', () => {
    const r = extractCode({
      subject: 'Confirm your email',
      text: null,
      html:
        '<a href="https://x.example/unsubscribe?u=1">Unsubscribe</a>' +
        '<a href="https://x.example/account/verify?token=abc&amp;u=1">メールアドレスを確認</a>',
    });
    expect(r.link).toBe('https://x.example/account/verify?token=abc&u=1');
    expect(
      extractCode({ subject: 'Login', text: 'Click https://app.example/magic-link/abc123. Thanks', html: null }).link,
    ).toBe('https://app.example/magic-link/abc123');
    expect(extractCode({ subject: 'News', text: 'See https://news.example/today', html: null }).link).toBeNull();
  });
});
