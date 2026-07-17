import { describe, expect, test } from 'bun:test';

import { createMockAgent } from './helpers/mock-agent.js';
import { resolveSyncOption, startSyncIfEnabled } from '../src/connect/lifecycle.js';

describe('resolveSyncOption', () => {
  test('should resolve undefined and "live" to live mode with the default interval', () => {
    expect(resolveSyncOption(undefined)).toEqual({ mode: 'live', interval: '5m' });
    expect(resolveSyncOption('live')).toEqual({ mode: 'live', interval: '5m' });
  });

  test('should resolve the explicit object form with per-mode interval defaults', () => {
    expect(resolveSyncOption({ mode: 'live', interval: '30s' })).toEqual({ mode: 'live', interval: '30s' });
    expect(resolveSyncOption({ mode: 'live' })).toEqual({ mode: 'live', interval: '5m' });
    expect(resolveSyncOption({ mode: 'poll' })).toEqual({ mode: 'poll', interval: '2m' });
    expect(resolveSyncOption({ mode: 'poll', interval: '45s' })).toEqual({ mode: 'poll', interval: '45s' });
  });

  test('should keep the deprecated bare-interval form on poll mode and warn at most once', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => { warnings.push(String(args[0])); };
    try {
      expect(resolveSyncOption('30s')).toEqual({ mode: 'poll', interval: '30s' });
      const warningsAfterFirst = warnings.length;
      expect(warningsAfterFirst).toBeLessThanOrEqual(1);

      expect(resolveSyncOption('10s')).toEqual({ mode: 'poll', interval: '10s' });
      // The deprecation warning is latched process-wide — never repeated.
      expect(warnings.length).toBe(warningsAfterFirst);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('startSyncIfEnabled', () => {
  test('should call startSync with live mode when sync is "live" or the object form', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncIfEnabled(agent, 'live');
    await startSyncIfEnabled(agent, { mode: 'live', interval: '90s' });

    expect(startSyncCalls).toEqual([
      { mode: 'live', interval: '5m' },
      { mode: 'live', interval: '90s' },
    ]);
  });

  test('should not call startSync when sync is "off"', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync: async (params) => { startSyncCalls.push(params); },
    });

    await startSyncIfEnabled(agent, 'off');

    expect(startSyncCalls).toHaveLength(0);
  });

  test('should call startSync with live mode when sync is undefined', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncIfEnabled(agent, undefined);

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ mode: 'live', interval: '5m' });
  });

  test('should call startSync with poll mode when sync is a string interval', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncIfEnabled(agent, '30s');

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ mode: 'poll', interval: '30s' });
  });

  test('should skip startSync when sync is already running', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : true,
    });

    await startSyncIfEnabled(agent, undefined);

    expect(startSyncCalls).toHaveLength(0);
  });

  test('should call startSync when sync is not running and sync option is an interval', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncIfEnabled(agent, '10s');

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ mode: 'poll', interval: '10s' });
  });
});
