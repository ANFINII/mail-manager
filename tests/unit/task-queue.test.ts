import { describe, expect, it } from 'vitest';
import { AbortError, TaskQueue } from '@backend/queue/task-queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TaskQueue', () => {
  it('never runs more than `concurrency` tasks at once', async () => {
    const q = new TaskQueue(10);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 300 }, (_, i) =>
      q.add(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(2);
        active--;
        return i;
      }),
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(300);
    expect(peak).toBe(10);
    expect(q.peakActive).toBe(10);
  });

  it('supports changing concurrency at runtime', async () => {
    const q = new TaskQueue(1);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, () =>
      q.add(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(5);
        active--;
      }),
    );
    await sleep(1);
    q.concurrency = 5;
    await Promise.all(tasks);
    expect(peak).toBe(5);
  });

  it('clear() rejects pending tasks and leaves running ones', async () => {
    const q = new TaskQueue(1);
    const first = q.add(async () => {
      await sleep(20);
      return 'done';
    });
    const second = q.add(async () => 'never');
    expect(q.clear()).toBe(1);
    await expect(second).rejects.toBeInstanceOf(AbortError);
    await expect(first).resolves.toBe('done');
  });

  it('honours AbortSignal for queued tasks', async () => {
    const q = new TaskQueue(1);
    const ctrl = new AbortController();
    const blocker = q.add(() => sleep(20));
    const queued = q.add(async () => 'x', { signal: ctrl.signal });
    ctrl.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortError);
    await blocker;
    await q.onIdle();
    expect(q.pending).toBe(0);
  });

  it('propagates task errors without stalling the queue', async () => {
    const q = new TaskQueue(2);
    await expect(
      q.add(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(q.add(async () => 42)).resolves.toBe(42);
  });
});

describe('TaskQueue priority', () => {
  it('runs higher-priority tasks before queued lower-priority ones (FIFO within a priority)', async () => {
    const q = new TaskQueue(1);
    const order: string[] = [];
    const blocker = q.add(async () => {
      await sleep(20);
      order.push('running');
    });
    const auto1 = q.add(async () => {
      order.push('auto1');
    });
    const auto2 = q.add(async () => {
      order.push('auto2');
    });
    const manual1 = q.add(
      async () => {
        order.push('manual1');
      },
      { priority: 1 },
    );
    const manual2 = q.add(
      async () => {
        order.push('manual2');
      },
      { priority: 1 },
    );
    await Promise.all([blocker, auto1, auto2, manual1, manual2]);
    expect(order).toEqual(['running', 'manual1', 'manual2', 'auto1', 'auto2']);
  });
});
