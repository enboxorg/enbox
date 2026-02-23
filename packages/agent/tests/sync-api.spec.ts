import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import type { SyncEngine } from '../src/types/sync.js';

import { AgentSyncApi } from '../src/sync-api.js';

describe('AgentSyncApi', () => {

  afterEach(() => {
    sinon.restore();
  });

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

  describe('set agent', () => {
    it('should forward the agent to the underlying sync engine', () => {
      const mockSyncEngine: any = {};
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      const mockAgent: any = { agentDid: 'did:method:new-agent' };
      syncApi.agent = mockAgent;

      expect(syncApi.agent.agentDid).toBe('did:method:new-agent');
      expect(mockSyncEngine.agent).toBe(mockAgent);
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

    it('should return offline when engine reports offline', () => {
      const mockSyncEngine = {
        connectivityState: 'offline' as const,
      } as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });
      expect(syncApi.connectivityState).toBe('offline');
    });
  });

  describe('registerIdentity', () => {
    it('should delegate to the underlying sync engine', async () => {
      const registerSpy = sinon.spy();
      const mockSyncEngine = {
        registerIdentity: registerSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      const params = { did: 'did:example:123', options: { protocols: ['https://foo.xyz'] } };
      await syncApi.registerIdentity(params);

      expect(registerSpy.calledOnce).toBe(true);
      expect(registerSpy.firstCall.args[0]).toEqual(params);
    });
  });

  describe('unregisterIdentity', () => {
    it('should delegate to the underlying sync engine', async () => {
      const unregisterSpy = sinon.spy();
      const mockSyncEngine = {
        unregisterIdentity: unregisterSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.unregisterIdentity('did:example:123');

      expect(unregisterSpy.calledOnce).toBe(true);
      expect(unregisterSpy.firstCall.args[0]).toBe('did:example:123');
    });
  });

  describe('getIdentityOptions', () => {
    it('should delegate to the underlying sync engine and return result', async () => {
      const expectedOptions = { protocols: ['https://foo.xyz'], delegateDid: 'did:example:delegate' };
      const mockSyncEngine = {
        getIdentityOptions: sinon.stub().resolves(expectedOptions),
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      const result = await syncApi.getIdentityOptions('did:example:123');

      expect(result).toEqual(expectedOptions);
    });

    it('should return undefined for unregistered identity', async () => {
      const mockSyncEngine = {
        getIdentityOptions: sinon.stub().resolves(undefined),
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      const result = await syncApi.getIdentityOptions('did:example:unknown');

      expect(result).toBeUndefined();
    });
  });

  describe('updateIdentityOptions', () => {
    it('should delegate to the underlying sync engine', async () => {
      const updateSpy = sinon.spy();
      const mockSyncEngine = {
        updateIdentityOptions: updateSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      const params = { did: 'did:example:123', options: { protocols: ['https://bar.xyz'] } };
      await syncApi.updateIdentityOptions(params);

      expect(updateSpy.calledOnce).toBe(true);
      expect(updateSpy.firstCall.args[0]).toEqual(params);
    });
  });

  describe('sync', () => {
    it('should delegate to the underlying sync engine without direction', async () => {
      const syncSpy = sinon.spy();
      const mockSyncEngine = {
        sync: syncSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.sync();

      expect(syncSpy.calledOnce).toBe(true);
      expect(syncSpy.firstCall.args[0]).toBeUndefined();
    });

    it('should delegate with push direction', async () => {
      const syncSpy = sinon.spy();
      const mockSyncEngine = {
        sync: syncSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.sync('push');

      expect(syncSpy.calledOnce).toBe(true);
      expect(syncSpy.firstCall.args[0]).toBe('push');
    });

    it('should delegate with pull direction', async () => {
      const syncSpy = sinon.spy();
      const mockSyncEngine = {
        sync: syncSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.sync('pull');

      expect(syncSpy.calledOnce).toBe(true);
      expect(syncSpy.firstCall.args[0]).toBe('pull');
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

  describe('stopSync', () => {
    it('should delegate to the underlying sync engine without timeout', async () => {
      const stopSpy = sinon.spy();
      const mockSyncEngine = {
        stopSync: stopSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.stopSync();

      expect(stopSpy.calledOnce).toBe(true);
      expect(stopSpy.firstCall.args[0]).toBeUndefined();
    });

    it('should delegate with custom timeout', async () => {
      const stopSpy = sinon.spy();
      const mockSyncEngine = {
        stopSync: stopSpy,
      } as unknown as SyncEngine;
      const syncApi = new AgentSyncApi({ syncEngine: mockSyncEngine });

      await syncApi.stopSync(5000);

      expect(stopSpy.calledOnce).toBe(true);
      expect(stopSpy.firstCall.args[0]).toBe(5000);
    });
  });
});
