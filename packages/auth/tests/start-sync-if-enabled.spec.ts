import { describe, expect, test } from 'bun:test';

import { createMockAgent } from './helpers/mock-agent.js';
import { startSyncIfEnabled } from '../src/connect/lifecycle.js';

describe('startSyncIfEnabled', () => {
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

  test('should skip startSync when sync is already running with poll mode', async () => {
    const startSyncCalls: any[] = [];
    const agent = createMockAgent({
      syncStartSync              : async (params) => { startSyncCalls.push(params); },
      syncHasActiveSubscriptions : true,
    });

    await startSyncIfEnabled(agent, '2m');

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
