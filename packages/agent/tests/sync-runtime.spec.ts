import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncRuntime } from '../src/sync-runtime.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture the wrappers SyncRuntime hands to the native setInterval, so a
 * test can invoke one as if the event loop had already queued that firing
 * before a replacement or disposal happened. clearInterval cannot retract
 * such a queued firing; the runtime's ownership re-check must neutralize it.
 */
function captureScheduledCallbacks(): Array<() => void> {
  const scheduled: Array<() => void> = [];
  let nextHandle = 1;
  sinon.stub(globalThis, 'setInterval').callsFake(((callback: () => void): number => {
    scheduled.push(callback);
    return nextHandle++;
  }) as unknown as typeof setInterval);
  sinon.stub(globalThis, 'clearInterval').callsFake(((): void => {}) as unknown as typeof clearInterval);
  return scheduled;
}

describe('SyncRuntime', () => {
  afterEach(() => {
    sinon.restore();
  });

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

  it('should neutralize a firing queued before dispose', () => {
    const scheduled = captureScheduledCallbacks();
    const runtime = new SyncRuntime();
    let ran = 0;
    runtime.armInterval('tick', () => { ran++; }, 5);

    runtime.dispose();
    // The event loop had already queued this firing when dispose ran.
    scheduled[0]();

    expect(ran).toBe(0);
  });

  it('should neutralize a replaced timer\'s queued firing and protect the replacement from it', () => {
    const scheduled = captureScheduledCallbacks();
    const runtime = new SyncRuntime();
    let staleRan = 0;
    let currentRan = 0;

    // The stale callback behaves like the engine's poll tick: it clears its
    // own key. Delivered after replacement, it must neither run nor clear
    // the replacement timer.
    runtime.armInterval('tick', () => {
      staleRan++;
      runtime.clearTimer('tick');
    }, 5);
    runtime.armInterval('tick', () => { currentRan++; }, 5);

    scheduled[0]();
    expect(staleRan).toBe(0);

    // The replacement still owns the key: its firings execute.
    scheduled[1]();
    expect(currentRan).toBe(1);
  });
});
