import { describe, expect, test } from 'bun:test';

import { createMockAgent } from './helpers/mock-agent.js';
import { resolveSyncOption, startSyncIfEnabled } from '../src/connect/lifecycle.js';

describe('resolveSyncOption', () => {
  test('should resolve undefined and "live" to the default settle-check interval', () => {
    expect(resolveSyncOption(undefined)).toEqual({ interval: '5m' });
    expect(resolveSyncOption('live')).toEqual({ interval: '5m' });
  });

  test('should resolve the explicit object form with the default interval fallback', () => {
    expect(resolveSyncOption({ interval: '30s' })).toEqual({ interval: '30s' });
    expect(resolveSyncOption({})).toEqual({ interval: '5m' });
  });

  test('should resolve a bare interval string to that settle-check interval', () => {
    expect(resolveSyncOption('30s')).toEqual({ interval: '30s' });
    expect(resolveSyncOption('10s')).toEqual({ interval: '10s' });
  });
});

describe('startSyncIfEnabled', () => {
  test('should call startSync when sync is "live" or the object form', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncIfEnabled(agent, 'live');
    await startSyncIfEnabled(agent, { interval: '90s' });

    expect(startSyncCalls).toEqual([
      { interval: '5m' },
      { interval: '90s' },
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

  test('should call startSync with the default interval when sync is undefined', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncIfEnabled(agent, undefined);

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ interval: '5m' });
  });

  test('should call startSync with the given settle-check cadence when sync is a string interval', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : false,
    });

    await startSyncIfEnabled(agent, '30s');

    expect(startSyncCalls).toHaveLength(1);
    expect(startSyncCalls[0]).toEqual({ interval: '30s' });
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
    expect(startSyncCalls[0]).toEqual({ interval: '10s' });
  });
});
