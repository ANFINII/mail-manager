import type { FakeMessageSpec } from './mime';

const SUBJECTS = [
  'Invoice #{n}',
  '請求書 {n} 月分',
  'Re: meeting notes',
  'Your order {n} has shipped',
  'Newsletter #{n}',
  'パスワード変更のお知らせ',
  'Weekly report {n}',
];
const SENDERS = [
  { name: 'Billing', address: 'billing@vendor.example' },
  { name: '山田 太郎', address: 'taro@example.jp' },
  { name: 'Support', address: 'support@shop.example' },
  { name: 'Newsletter', address: 'news@media.example' },
];

/** 決定的なダミーメールを生成する（i は 1 始まり） */
export function makeMessageSpec(
  i: number,
  to: string,
  base = new Date('2026-01-01T00:00:00Z'),
): FakeMessageSpec {
  const subject = SUBJECTS[i % SUBJECTS.length].replace('{n}', String(i));
  const from = SENDERS[i % SENDERS.length];
  const date = new Date(base.getTime() + i * 3_600_000);
  const withAttachment = i % 10 === 0;
  const withHtml = i % 3 !== 0;
  return {
    from,
    to: [{ address: to }],
    subject,
    date,
    text: `Message ${i} body. ${i % 5 === 0 ? 'urgent keyword' : 'normal text'} 番号${i}`,
    html: withHtml
      ? `<div><p>Message <b>${i}</b> body.</p><img src="http://tracker.example/${i}.png"><a href="http://x.example">link</a></div>`
      : undefined,
    attachments: withAttachment
      ? [
          {
            filename: `report-${i}.pdf`,
            contentType: 'application/pdf',
            content: Buffer.from(`%PDF-1.4 report ${i}`),
          },
        ]
      : undefined,
    flags: i % 4 === 0 ? ['\\Seen'] : [],
    messageId: `<msg-${i}-${to}>`,
  };
}
