import { describe, expect, it } from 'bun:test';

import { SyncRuntime } from '../src/sync-runtime.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SyncRuntime', () => {
  it('should fire an armed interval until cleared', async () => {
    const runtime = new SyncRuntime();
    let ticks = 0;
    runtime.armInterval('tick', () => { ticks++; }, 5);

    await sleep(20);
    runtime.clearTimer('tick');
    const ticksAtClear = ticks;
    expect(ticksAtClear).toBeGreaterThan(0);

    await sleep(20);
    expect(ticks).toBe(ticksAtClear);
    runtime.dispose();
  });

  it('should replace an armed interval under the same key', async () => {
    const runtime = new SyncRuntime();
    let first = 0;
    let second = 0;
    runtime.armInterval('tick', () => { first++; }, 5);
    runtime.armInterval('tick', () => { second++; }, 5);

    await sleep(25);
    runtime.dispose();

    expect(first).toBe(0);
    expect(second).toBeGreaterThan(0);
  });

  it('should not replace an armed interval through armIntervalIfAbsent', async () => {
    const runtime = new SyncRuntime();
    let first = 0;
    let second = 0;
    runtime.armInterval('tick', () => { first++; }, 5);
    runtime.armIntervalIfAbsent('tick', () => { second++; }, 5);

    await sleep(25);
    runtime.dispose();

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('should arm through armIntervalIfAbsent when the key is unarmed', async () => {
    const runtime = new SyncRuntime();
    let ticks = 0;
    runtime.armIntervalIfAbsent('tick', () => { ticks++; }, 5);

    await sleep(20);
    runtime.dispose();

    expect(ticks).toBeGreaterThan(0);
  });

  it('should cancel every owned timer on dispose and refuse further arming', async () => {
    const runtime = new SyncRuntime();
    let ticks = 0;
    runtime.armInterval('a', () => { ticks++; }, 5);
    runtime.armInterval('b', () => { ticks++; }, 5);

    runtime.dispose();
    expect(runtime.disposed).toBe(true);

    runtime.armInterval('c', () => { ticks++; }, 5);
    runtime.armIntervalIfAbsent('d', () => { ticks++; }, 5);

    await sleep(25);
    expect(ticks).toBe(0);
  });

  it('should tolerate clearing unarmed keys, double dispose, and clears after dispose', () => {
    const runtime = new SyncRuntime();
    runtime.clearTimer('never-armed');
    runtime.dispose();
    runtime.dispose();
    runtime.clearTimer('never-armed');
    expect(runtime.disposed).toBe(true);
  });
});
