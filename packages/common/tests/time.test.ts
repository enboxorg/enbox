import { describe, expect, it } from 'bun:test';

import { nowMs, sleep, timed } from '../src/time.js';

describe('sleep', () => {
  it('returns a Promise that resolves after at least the given duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Allow generous slack for scheduling jitter (CI machines vary).
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('resolves promptly for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    // 0ms still goes through setTimeout, but the wait should be tiny.
    expect(elapsed).toBeLessThan(50);
  });

  it('resolves promptly for negative durations (treated as 0)', async () => {
    // Browsers / Node clamp negative timeouts to 0 — verify we don't hang.
    const start = Date.now();
    await sleep(-100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('multiple concurrent sleeps run in parallel (not serialized)', async () => {
    const start = Date.now();
    await Promise.all([sleep(50), sleep(50), sleep(50)]);
    const elapsed = Date.now() - start;
    // Three serial 50ms sleeps would take ~150ms; parallel should take ~50ms.
    expect(elapsed).toBeLessThan(120);
  });

  it('returns void on resolution', async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});

describe('nowMs', () => {
  it('returns a numeric timestamp', () => {
    expect(typeof nowMs()).toBe('number');
  });
});

describe('timed', () => {
  it('returns the operation result and logs success duration', async () => {
    const messages: string[] = [];

    const result = await timed('test.operation', () => Promise.resolve('ok'), {
      log: (message) => { messages.push(message); },
    });

    expect(result).toBe('ok');
    expect(messages).toHaveLength(1);
    expect(messages[0].startsWith('test.operation ok in ')).toBe(true);
  });

  it('rethrows operation errors and logs failure duration', async () => {
    const messages: string[] = [];

    await expect(timed('test.operation', () => Promise.reject(new Error('boom')), {
      log: (message) => { messages.push(message); },
    })).rejects.toThrow('boom');

    expect(messages).toHaveLength(1);
    expect(messages[0].startsWith('test.operation fail in ')).toBe(true);
  });
});
