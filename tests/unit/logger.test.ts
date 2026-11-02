import { describe, expect, it } from 'vitest';
import { Logger, MemorySink, SecretScrubber, redactKeys } from '@backend/logging/logger';

describe('logger', () => {
  it('redacts secret-looking keys', () => {
    const out = redactKeys({
      email: 'a@b',
      password: 'p',
      nested: { refresh_token: 'r', ok: 1 },
      list: [{ token: 't' }],
    }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).refresh_token).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect((out.list as Array<Record<string, unknown>>)[0].token).toBe('[REDACTED]');
  });

  it('scrubs registered secrets from free text and meta', () => {
    const sink = new MemorySink();
    const scrubber = new SecretScrubber();
    scrubber.register('SuperSecret123');
    const logger = new Logger({ level: 'debug', sinks: [sink], scrubber });
    logger.error('LOGIN failed for user with SuperSecret123', {
      detail: 'pw=SuperSecret123',
      password: 'SuperSecret123',
    });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toContain('SuperSecret123');
    expect(sink.lines[0]).toContain('[ERROR]');
    expect(sink.lines[0]).toContain('***');
  });

  it('honours level and context', () => {
    const sink = new MemorySink();
    const logger = new Logger({
      level: 'warn',
      sinks: [sink],
      scrubber: new SecretScrubber(),
    }).child('auth');
    logger.info('hidden');
    logger.warn('shown');
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatch(/\[WARN\] \[auth\] shown$/);
  });
});
