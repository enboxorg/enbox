import { describe, expect, it } from 'bun:test';

import type { SyncEngine } from '../src/types/sync.js';

import { AgentSyncApi } from '../src/sync-api.js';

describe('AgentSyncApi', () => {

  describe('get agent', () => {
    it(`returns the 'agent' instance property`, async () => {
      // we are only mocking
      const mockAgent: any = {
        agentDid: 'did:method:abc123'
      };
      const mockSyncEngine: SyncEngine = {} as SyncEngine;
      const syncApi = new AgentSyncApi({ agent: mockAgent, syncEngine: mockSyncEngine });
      const agent = syncApi.agent;
      expect(agent).toBeDefined();
      expect(agent.agentDid).toBe('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, () => {
      const mockSyncEngine: SyncEngine = {} as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });
      expect(() =>
        syncApi.agent
      ).toThrow('Unable to determine agent execution context');
    });
  });

  describe('connectivityState', () => {
    it('should delegate to the underlying sync engine', () => {
      const mockSyncEngine = {
        connectivityState: 'online' as const,
      } as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });
      expect(syncApi.connectivityState).toBe('online');
    });

    it('should return unknown when engine reports unknown', () => {
      const mockSyncEngine = {
        connectivityState: 'unknown' as const,
      } as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });
      expect(syncApi.connectivityState).toBe('unknown');
    });
  });

  describe('startSync', () => {
    it('should delegate to the underlying sync engine with params', async () => {
      let receivedParams: any;
      const mockSyncEngine = {
        startSync: async (params: any): Promise<void> => { receivedParams = params; },
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.startSync({ mode: 'live', interval: '5m' });
      expect(receivedParams).toEqual({ mode: 'live', interval: '5m' });
    });

    it('should accept poll mode', async () => {
      let receivedParams: any;
      const mockSyncEngine = {
        startSync: async (params: any): Promise<void> => { receivedParams = params; },
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.startSync({ mode: 'poll', interval: '2m' });
      expect(receivedParams).toEqual({ mode: 'poll', interval: '2m' });
    });
  });
});
