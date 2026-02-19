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
});
