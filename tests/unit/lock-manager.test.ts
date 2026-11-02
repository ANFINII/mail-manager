import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockManager } from '../../src/main/lock-manager';

let dir: string;
let idle = 0;
const changes: boolean[] = [];
const make = () =>
  new LockManager({
    file: path.join(dir, 'lock.json'),
    systemIdleSeconds: () => idle,
    touchIdAvailable: () => false,
    onChange: (s) => changes.push(s.locked),
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lock-'));
  idle = 0;
  changes.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('LockManager', () => {
  it('is inactive until a passcode is set and the lock is enabled', () => {
    const m = make();
    expect(m.status()).toMatchObject({ enabled: false, hasPasscode: false, locked: false });
    expect(() => m.configure({ enabled: true, idleMinutes: 5 })).toThrow(/パスコード/);
    m.setPasscode(undefined, '2468');
    m.configure({ enabled: true, idleMinutes: 5, passcode: '2468' });
    expect(m.isActive()).toBe(true);
    expect(m.isLocked()).toBe(false);
  });

  it('starts locked after a restart, unlocks with the passcode and stores only a hash', () => {
    const m = make();
    m.setPasscode(undefined, '2468');
    m.configure({ enabled: true, idleMinutes: 5, passcode: '2468' });
    const raw = fs.readFileSync(path.join(dir, 'lock.json'), 'utf8');
    expect(raw).not.toContain('2468');
    const restarted = make();
    expect(restarted.isLocked()).toBe(true);
    expect(() => restarted.unlockWithPasscode('0000')).toThrow(/違います/);
    expect(restarted.unlockWithPasscode('2468').locked).toBe(false);
  });

  it('locks after the idle time and blocks brute force', () => {
    const m = make();
    m.setPasscode(undefined, '2468');
    m.configure({ enabled: true, idleMinutes: 5, passcode: '2468' });
    idle = 299;
    m.checkIdle();
    expect(m.isLocked()).toBe(false);
    idle = 300;
    m.checkIdle();
    expect(m.isLocked()).toBe(true);
    for (let i = 0; i < 5; i++) expect(() => m.unlockWithPasscode('1111')).toThrow();
    expect(() => m.unlockWithPasscode('2468')).toThrow(/試行回数/);
    expect(m.status().retryAfterMs).toBeGreaterThan(0);
    expect(m.unlockWithOsAuth().locked).toBe(false);
  });

  it('requires the passcode to disable the lock or change the passcode', () => {
    const m = make();
    m.setPasscode(undefined, '2468');
    m.configure({ enabled: true, idleMinutes: 5, passcode: '2468' });
    expect(() => m.configure({ enabled: false, idleMinutes: 5, passcode: 'x' })).toThrow();
    expect(() => m.setPasscode('wrong', '1357')).toThrow(/現在/);
    m.setPasscode('2468', '1357');
    m.lock();
    expect(() => m.configure({ enabled: false, idleMinutes: 5, passcode: '1357' })).toThrow(/ロック中/);
    m.unlockWithPasscode('1357');
    expect(m.configure({ enabled: false, idleMinutes: 5, passcode: '1357' }).enabled).toBe(false);
    expect(changes).toContain(true);
  });
});
