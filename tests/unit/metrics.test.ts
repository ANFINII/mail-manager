import { describe, expect, it } from 'vitest';
import { MetricsService, THROTTLE_RE } from '@backend/metrics/metrics-service';
import type { EmailProvider } from '@backend/mail/email-provider';
import type { MailSession } from '@backend/mail/mail-session';

describe('MetricsService', () => {
  it('detects throttling messages', () => {
    for (const m of [
      'NO [LIMIT] Too many simultaneous connections',
      'User is authenticated but not connected. ApplicationThrottled',
      '421 4.7.0 Try again later',
      'OAuth http_429',
    ])
      expect(THROTTLE_RE.test(m)).toBe(true);
    expect(THROTTLE_RE.test('Invalid credentials (Failure)')).toBe(false);
  });

  it('counts open connections, peaks, failures and throttles per minute and host', async () => {
    let now = Date.parse('2026-11-02T10:00:30Z');
    const m = new MetricsService(() => now);
    let fail: Error | null = null;
    const fake: EmailProvider = {
      testConnection: async () => undefined,
      openSession: async () => {
        if (fail) throw fail;
        return { close: async () => undefined } as unknown as MailSession;
      },
    };
    const p = m.wrap(fake);
    const params = { host: 'imap.x', user: 'a@x' } as never;
    const s1 = await p.openSession(params);
    const s2 = await p.openSession(params);
    fail = new Error('NO Too many simultaneous connections');
    await expect(p.openSession(params)).rejects.toThrow();
    let snap = m.snapshot();
    expect(snap).toMatchObject({ open: 2, peak: 2 });
    expect(snap.hosts[0]).toMatchObject({ host: 'imap.x', open: 2, connects: 3, failures: 1, throttled: 1 });
    expect(snap.series.at(-1)).toMatchObject({ connects: 3, failures: 1, throttled: 1 });
    expect(snap.events[0]).toMatchObject({ kind: 'throttled', account: 'a@x' });

    await s1.close();
    await s1.close(); // 二重 close は 1 回だけ数える
    now += 5 * 60_000;
    m.sendResult('smtp.x', 'a@x', new Error('550 rejected'));
    snap = m.snapshot();
    expect(snap.open).toBe(1);
    expect(snap.series).toHaveLength(60);
    expect(snap.series.at(-1)).toMatchObject({ connects: 0, sends: 1, sendFailures: 1 });
    expect(snap.series.at(-6)?.connects).toBe(3);
    await s2.close();
    // 60 分より古い集計は消える
    now += 61 * 60_000;
    expect(m.snapshot().series.every((b) => b.connects === 0)).toBe(true);
  });
});
