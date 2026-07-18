import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { SyncRuntime } from '../src/sync-runtime.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture the wrappers SyncRuntime hands to the native setInterval and
 * setTimeout, so a test can invoke one as if the event loop had already
 * queued that firing before a replacement or disposal happened. Clearing a
 * native timer cannot retract such a queued firing; the runtime's ownership
 * re-check must neutralize it.
 */
function captureScheduledCallbacks(): Array<() => void> {
  const scheduled: Array<() => void> = [];
  let nextHandle = 1;
  const capture = ((callback: () => void): number => {
    scheduled.push(callback);
    return nextHandle++;
  }) as unknown;
  const ignore = ((): void => {}) as unknown;
  sinon.stub(globalThis, 'setInterval').callsFake(capture as typeof setInterval);
  sinon.stub(globalThis, 'clearInterval').callsFake(ignore as typeof clearInterval);
  sinon.stub(globalThis, 'setTimeout').callsFake(capture as typeof setTimeout);
  sinon.stub(globalThis, 'clearTimeout').callsFake(ignore as typeof clearTimeout);
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

  it('should carry its mode for the generation and lose it on disposal', () => {
    const modeless = new SyncRuntime();
    expect(modeless.mode).toBeUndefined();

    const runtime = new SyncRuntime('live');
    expect(runtime.mode).toBe('live');

    // Mode is a property of the generation: a disposed scope has none,
    // exactly as the engine between runtimes has none.
    runtime.dispose();
    expect(runtime.mode).toBeUndefined();
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

  it('should fire an armed timeout once, unarming its key before the callback runs', async () => {
    const runtime = new SyncRuntime();
    let runs = 0;
    let armedDuringCallback: boolean | undefined;
    runtime.armTimeout('retry', () => {
      runs++;
      armedDuringCallback = runtime.hasTimers((key) => key === 'retry');
    }, 5);

    expect(runtime.hasTimers((key) => key === 'retry')).toBe(true);
    await sleep(20);
    runtime.dispose();

    expect(runs).toBe(1);
    expect(armedDuringCallback).toBe(false);
  });

  it('should let a timeout callback re-arm its own key', async () => {
    const runtime = new SyncRuntime();
    let runs = 0;
    runtime.armTimeout('retry', () => {
      runs++;
      runtime.armTimeout('retry', () => { runs++; }, 5);
    }, 5);

    await sleep(30);
    runtime.dispose();

    expect(runs).toBe(2);
  });

  it('should replace a pending timeout under the same key', async () => {
    const runtime = new SyncRuntime();
    let first = 0;
    let second = 0;
    runtime.armTimeout('retry', () => { first++; }, 5);
    runtime.armTimeout('retry', () => { second++; }, 5);

    await sleep(20);
    runtime.dispose();

    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  it('should neutralize a timeout firing queued before dispose or replacement', () => {
    const scheduled = captureScheduledCallbacks();
    const runtime = new SyncRuntime();
    let staleRan = 0;
    let currentRan = 0;
    runtime.armTimeout('retry', () => { staleRan++; }, 5);
    runtime.armTimeout('retry', () => { currentRan++; }, 5);

    // The replaced timeout's firing was already queued: it must not start.
    scheduled[0]();
    expect(staleRan).toBe(0);

    // The replacement still owns the key until delivery.
    scheduled[1]();
    expect(currentRan).toBe(1);

    // A firing queued before dispose must not start either.
    runtime.armTimeout('late', () => { staleRan++; }, 5);
    runtime.dispose();
    scheduled[2]();
    expect(staleRan).toBe(0);
  });

  it('should query and clear timers by key predicate', () => {
    const scheduled = captureScheduledCallbacks();
    const runtime = new SyncRuntime();
    let aliceRan = 0;
    let bobRan = 0;
    runtime.armTimeout('linkInitRetry:did:example:alice^https://a.example', () => { aliceRan++; }, 5);
    runtime.armTimeout('linkInitRetry:did:example:bob^https://b.example', () => { bobRan++; }, 5);
    runtime.armInterval('syncInterval', () => {}, 5);

    expect(runtime.hasTimers((key) => key.startsWith('linkInitRetry:'))).toBe(true);
    runtime.clearTimers((key) => key.startsWith('linkInitRetry:did:example:alice^'));

    expect(runtime.hasTimers((key) => key.startsWith('linkInitRetry:did:example:alice^'))).toBe(false);
    expect(runtime.hasTimers((key) => key.startsWith('linkInitRetry:did:example:bob^'))).toBe(true);
    expect(runtime.hasTimers((key) => key === 'syncInterval')).toBe(true);

    // The cleared timer's queued firing is neutralized; the survivor runs.
    scheduled[0]();
    scheduled[1]();
    expect(aliceRan).toBe(0);
    expect(bobRan).toBe(1);

    runtime.dispose();
  });
});
