import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { SyncNextWorkPump } from '../src/sync-next/work-pump.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SyncNextWorkPump', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should coalesce requests and release a native task between requeued operations', async () => {
    const clock = sinon.useFakeTimers();
    let calls = 0;
    const pump = new SyncNextWorkPump(async (): Promise<void> => {
      calls++;
      if (calls === 1) {
        pump.request();
        pump.request();
      }
    }, () => {});

    pump.request();
    await clock.tickAsync(0);
    expect(calls).toBe(1);
    await clock.tickAsync(1);
    expect(calls).toBe(2);
    await pump.waitForIdle();
  });

  it('should run independent pumps while one operation is blocked', async () => {
    const blocked = deferred();
    const firstStarted = deferred();
    let secondCalls = 0;
    const first = new SyncNextWorkPump(async (): Promise<void> => {
      firstStarted.resolve();
      await blocked.promise;
    }, () => {});
    const second = new SyncNextWorkPump(async (): Promise<void> => {
      secondCalls++;
    }, () => {});

    first.request();
    second.request();
    await firstStarted.promise;
    await second.waitForIdle();

    expect(secondCalls).toBe(1);
    blocked.resolve();
    await first.waitForIdle();
  });

  it('should preserve a delayed retry requested while an operation is running', async () => {
    const clock = sinon.useFakeTimers();
    const blocked = deferred();
    const started = deferred();
    let calls = 0;
    const pump = new SyncNextWorkPump(async (): Promise<void> => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await blocked.promise;
      }
    }, () => {});

    pump.request();
    await clock.tickAsync(0);
    await started.promise;
    pump.request(1_000);
    blocked.resolve();
    await Promise.resolve();
    await clock.tickAsync(999);
    expect(calls).toBe(1);
    await clock.tickAsync(1);
    expect(calls).toBe(2);
  });

  it('should keep the earliest delayed request and cancel it on disposal', async () => {
    const clock = sinon.useFakeTimers();
    let calls = 0;
    const pump = new SyncNextWorkPump(async (): Promise<void> => { calls++; }, () => {});

    pump.request(1_000);
    pump.request(2_000);
    await clock.tickAsync(999);
    expect(calls).toBe(0);
    pump.dispose();
    await clock.tickAsync(2_000);
    expect(calls).toBe(0);
  });

  it('should report an operation error without poisoning later requests', async () => {
    const clock = sinon.useFakeTimers();
    const error = new Error('failed');
    const report = sinon.stub();
    let calls = 0;
    const pump = new SyncNextWorkPump(async (): Promise<void> => {
      calls++;
      if (calls === 1) {
        throw error;
      }
    }, report);

    pump.request();
    await clock.tickAsync(0);
    expect(report.calledOnceWithExactly(error)).toBe(true);
    pump.request();
    await clock.tickAsync(0);
    expect(calls).toBe(2);
  });
});
