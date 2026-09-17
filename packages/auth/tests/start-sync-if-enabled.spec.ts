import sinon from 'sinon';
import { describe, expect, test } from 'bun:test';

import { createMockAgent } from './helpers/mock-agent.js';
import { resolveSyncOption, startSyncAndWaitIfEnabled, startSyncInBackgroundIfEnabled } from '../src/connect/lifecycle.js';

describe('resolveSyncOption', () => {
  test('should resolve undefined and "live" to the engine-default settle-check interval', () => {
    expect(resolveSyncOption(undefined)).toEqual({});
    expect(resolveSyncOption('live')).toEqual({});
  });

  test('should resolve the explicit object form, deferring a missing interval to the engine', () => {
    expect(resolveSyncOption({ interval: '30s' })).toEqual({ interval: '30s' });
    expect(resolveSyncOption({})).toEqual({});
  });

  test('should resolve a bare interval string to that settle-check interval', () => {
    expect(resolveSyncOption('30s')).toEqual({ interval: '30s' });
    expect(resolveSyncOption('10s')).toEqual({ interval: '10s' });
  });
});

describe('sync startup', () => {
  test('should call startSync when sync is "live" or the object form', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncAndWaitIfEnabled(agent, 'live');
    await startSyncAndWaitIfEnabled(agent, { interval: '90s' });

    expect(startSyncCalls).toEqual([
      {},
      { interval: '90s' },
    ]);
  });

  test('should not call startSync when sync is "off"', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync: async (params) => { startSyncCalls.push(params); },
    });

    await startSyncAndWaitIfEnabled(agent, 'off');

    expect(startSyncCalls).toHaveLength(0);
  });

  test('should call startSync with the engine-default interval when sync is undefined', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncAndWaitIfEnabled(agent, undefined);

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({});
  });

  test('should call startSync with the given settle-check cadence when sync is a string interval', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncAndWaitIfEnabled(agent, '30s');

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ interval: '30s' });
  });

  test('should skip startSync when sync is already running', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : true,
    });

    await startSyncAndWaitIfEnabled(agent, undefined);

    expect(startSyncCalls).toHaveLength(0);
  });

  test('should call startSync when sync is not running and sync option is an interval', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncAndWaitIfEnabled(agent, '10s');

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ interval: '10s' });
  });

  test('should share background sync startup without waiting for initial catch-up', async () => {
    let finishCatchUp!: () => void;
    const catchUp = new Promise<void>((resolve) => { finishCatchUp = resolve; });
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync: (params) => {
        startSyncCalls.push(params);
        return catchUp;
      },
    });

    expect(startSyncInBackgroundIfEnabled(agent, undefined)).toBeUndefined();
    expect(startSyncInBackgroundIfEnabled(agent, undefined)).toBeUndefined();
    expect(startSyncCalls).toEqual([{}]);

    finishCatchUp();
    await catchUp;
    await Promise.resolve();
    await Promise.resolve();
  });

  test('should stop a background startup that outlives its auth session', async () => {
    let finishCatchUp!: () => void;
    const catchUp = new Promise<void>((resolve) => { finishCatchUp = resolve; });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const stopSyncCalls: Array<number | undefined> = [];
    const agent = createMockAgent({
      syncStartSync : () => catchUp,
      syncStopSync  : async (timeout) => {
        stopSyncCalls.push(timeout);
        finishCleanup();
      },
    });
    const session = new AbortController();

    startSyncInBackgroundIfEnabled(agent, undefined, session.signal);
    session.abort();
    finishCatchUp();
    await cleanup;

    expect(stopSyncCalls).toEqual([undefined]);
  });

  test('should transfer an in-flight startup to the newest auth session', async () => {
    let finishCatchUp!: () => void;
    const catchUp = new Promise<void>((resolve) => { finishCatchUp = resolve; });
    const stopSyncCalls: Array<number | undefined> = [];
    const agent = createMockAgent({
      syncStartSync : () => catchUp,
      syncStopSync  : async (timeout) => { stopSyncCalls.push(timeout); },
    });
    const previousSession = new AbortController();
    const activeSession = new AbortController();

    startSyncInBackgroundIfEnabled(agent, undefined, previousSession.signal);
    previousSession.abort();
    startSyncInBackgroundIfEnabled(agent, undefined, activeSession.signal);
    finishCatchUp();
    await catchUp;
    await Promise.resolve();
    await Promise.resolve();

    expect(stopSyncCalls).toHaveLength(0);
  });

  test('should restart for a new session that arrives during stale cleanup', async () => {
    let finishCatchUp!: () => void;
    const catchUp = new Promise<void>((resolve) => { finishCatchUp = resolve; });
    let cleanupStarted!: () => void;
    const cleanup = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let finishCleanup!: () => void;
    const cleanupFinished = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let restartStarted!: () => void;
    const restart = new Promise<void>((resolve) => { restartStarted = resolve; });
    let startSyncCallCount = 0;
    const agent = createMockAgent({
      syncStartSync: () => {
        startSyncCallCount++;
        if (startSyncCallCount === 2) { restartStarted(); }
        return startSyncCallCount === 1 ? catchUp : Promise.resolve();
      },
      syncStopSync: () => {
        cleanupStarted();
        return cleanupFinished;
      },
    });
    const previousSession = new AbortController();
    const activeSession = new AbortController();

    startSyncInBackgroundIfEnabled(agent, undefined, previousSession.signal);
    previousSession.abort();
    finishCatchUp();
    await cleanup;

    startSyncInBackgroundIfEnabled(agent, undefined, activeSession.signal);
    finishCleanup();
    await restart;

    expect(startSyncCallCount).toBe(2);
  });

  test('should report background sync failures without rejecting the auth caller', async () => {
    const failure = new Error('initial catch-up failed');
    const report = sinon.stub(console, 'error');
    const agent = createMockAgent({
      syncStartSync: async () => { throw failure; },
    });

    try {
      expect(startSyncInBackgroundIfEnabled(agent, undefined)).toBeUndefined();
      await Promise.resolve();
      await Promise.resolve();

      expect(report.calledOnceWithExactly('[@enbox/auth] Sync failed:', failure)).toBe(true);
    } finally {
      report.restore();
    }
  });

  test('should clean up a failed startup after its auth session ends', async () => {
    const failure = new Error('initial catch-up failed after starting');
    let failCatchUp!: () => void;
    const catchUp = new Promise<void>((_resolve, reject) => {
      failCatchUp = (): void => { reject(failure); };
    });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const report = sinon.stub(console, 'error');
    const agent = createMockAgent({
      syncStartSync : () => catchUp,
      syncStopSync  : async () => { finishCleanup(); },
    });
    const session = new AbortController();

    try {
      startSyncInBackgroundIfEnabled(agent, undefined, session.signal);
      session.abort();
      failCatchUp();
      await cleanup;

      expect(report.calledOnceWithExactly('[@enbox/auth] Sync failed:', failure)).toBe(true);
    } finally {
      report.restore();
    }
  });
});
