import { describe, expect, it } from 'vitest';
import { evaluateHealth, worstSeverity } from '@backend/stats/health-service';
import type { AccountRow } from '@backend/db/schema';

const NOW = Date.parse('2026-11-02T12:00:00Z');

function account(patch: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'a1',
    email: 'u@example.com',
    provider: 'custom',
    auth_type: 'password',
    imap_host: 'h',
    imap_port: 993,
    imap_secure: 'tls',
    smtp_host: null,
    smtp_port: null,
    smtp_secure: null,
    proxy: null,
    encrypted_credentials: 'x',
    enabled: 1,
    status: 'connected',
    auth_status: 'ok',
    last_error: null,
    last_error_at: null,
    last_success_at: '2026-11-02T11:00:00Z',
    last_sync_at: '2026-11-02T11:00:00Z',
    retry_count: 0,
    message_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    group_id: null,
    consecutive_failures: 0,
    ...patch,
  };
}

const evalOf = (patch: Partial<AccountRow>, forwardFailures = 0, staleHours = 24) =>
  evaluateHealth({ account: account(patch), forwardFailures, staleHours, now: NOW });

describe('evaluateHealth', () => {
  it('reports nothing for a healthy, recently synced account', () => {
    expect(evalOf({})).toEqual([]);
  });

  it('flags failed authentication as critical', () => {
    const issues = evalOf({ status: 'auth_error', auth_status: 'failed' });
    expect(issues.map((i) => i.reason)).toEqual(['auth_failed']);
    expect(worstSeverity(issues)).toBe('critical');
  });

  it('flags repeated failures once the threshold is reached', () => {
    expect(evalOf({ consecutive_failures: 2 })).toEqual([]);
    expect(evalOf({ consecutive_failures: 3 })).toContainEqual({
      reason: 'repeated_failures',
      severity: 'critical',
      value: 3,
    });
  });

  it('flags a stale account with the elapsed hours, and respects staleHours = 0', () => {
    const old = { last_success_at: '2026-10-31T12:00:00Z', last_sync_at: '2026-10-31T12:00:00Z' };
    expect(evalOf(old)).toContainEqual({ reason: 'stale', severity: 'warning', value: 48 });
    expect(evalOf(old, 0, 0)).toEqual([]);
  });

  it('marks sync errors as warning and connection errors as critical', () => {
    expect(worstSeverity(evalOf({ status: 'sync_error' }))).toBe('warning');
    expect(worstSeverity(evalOf({ status: 'connection_error' }))).toBe('critical');
  });

  it('reports forward failures, untested and never-synced accounts', () => {
    expect(evalOf({}, 4)).toContainEqual({ reason: 'forward_failures', severity: 'warning', value: 4 });
    expect(evalOf({ status: 'untested', auth_status: 'untested' }).map((i) => i.reason)).toEqual([
      'untested',
    ]);
    expect(evalOf({ last_sync_at: null }).map((i) => i.reason)).toEqual(['never_synced']);
  });

  it('ignores disabled accounts', () => {
    expect(evalOf({ enabled: 0, status: 'auth_error', auth_status: 'failed' })).toEqual([]);
  });
});
