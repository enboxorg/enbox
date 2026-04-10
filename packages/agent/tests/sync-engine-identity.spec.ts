import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

describe('SyncEngineLevel — identity management', () => {
  let db: Level<string, string>;
  let syncEngine: SyncEngineLevel;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-engine-identity-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
    await db.clear();
    sinon.restore();
  });

  afterAll(async () => {
    await db.close();
  });

  describe('registerIdentity', () => {
    it('should register an identity with default options', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:register1' });
      const options = await syncEngine.getIdentityOptions('did:example:register1');
      expect(options).toBeDefined();
      expect(options!.protocols).toEqual([]);
    });

    it('should register an identity with custom options', async () => {
      await syncEngine.registerIdentity({
        did     : 'did:example:register2',
        options : { protocols: ['https://example.com/protocol1'], delegateDid: 'did:example:delegate' },
      });
      const options = await syncEngine.getIdentityOptions('did:example:register2');
      expect(options).toBeDefined();
      expect(options!.protocols).toEqual(['https://example.com/protocol1']);
      expect(options!.delegateDid).toBe('did:example:delegate');
    });

    it('should throw when registering an already registered identity', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:dup' });
      await expect(
        syncEngine.registerIdentity({ did: 'did:example:dup' })
      ).rejects.toThrow('is already registered');
    });
  });

  describe('unregisterIdentity', () => {
    it('should unregister a registered identity', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:unreg1' });
      await syncEngine.unregisterIdentity('did:example:unreg1');
      const options = await syncEngine.getIdentityOptions('did:example:unreg1');
      expect(options).toBeUndefined();
    });

    it('should throw when unregistering a non-registered identity', async () => {
      await expect(
        syncEngine.unregisterIdentity('did:example:never-registered')
      ).rejects.toThrow('is not registered');
    });
  });

  describe('getIdentityOptions', () => {
    it('should return undefined for a non-registered identity', async () => {
      const options = await syncEngine.getIdentityOptions('did:example:unknown');
      expect(options).toBeUndefined();
    });

    it('should throw on unexpected Level errors', async () => {
      // Stub the sublevel to throw a non-LEVEL_NOT_FOUND error.
      const stubGet = sinon.stub().rejects({ code: 'LEVEL_IO_ERROR' });
      const sublevelStub = sinon.stub(db, 'sublevel').returns({ get: stubGet } as any);

      await expect(
        syncEngine.getIdentityOptions('did:example:error')
      ).rejects.toThrow('Error reading level: LEVEL_IO_ERROR');

      sublevelStub.restore();
    });
  });

  describe('updateIdentityOptions', () => {
    it('should update options for a registered identity', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:upd1', options: { protocols: ['old'] } });
      await syncEngine.updateIdentityOptions({
        did     : 'did:example:upd1',
        options : { protocols: ['new1', 'new2'] },
      });
      const options = await syncEngine.getIdentityOptions('did:example:upd1');
      expect(options!.protocols).toEqual(['new1', 'new2']);
    });

    it('should throw when updating a non-registered identity', async () => {
      await expect(
        syncEngine.updateIdentityOptions({
          did     : 'did:example:nonexistent',
          options : { protocols: [] },
        })
      ).rejects.toThrow('is not registered');
    });
  });

  describe('clear', () => {
    it('should clear the sync engine state', async () => {
      // Register an identity, then clear and verify it's gone.
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await engine.registerIdentity({ did: 'did:example:clear1' });
      expect(await engine.getIdentityOptions('did:example:clear1')).toBeDefined();

      await engine.clear();
      expect(await engine.getIdentityOptions('did:example:clear1')).toBeUndefined();
    });
  });

  describe('connectivityState', () => {
    it('should default to unknown', () => {
      const engine = new SyncEngineLevel({ db });
      expect(engine.connectivityState).toBe('unknown');
    });
  });

  describe('agent setter', () => {
    it('should set the agent and update permissionsApi', () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      engine.agent = mockAgent;
      expect(engine.agent).toBe(mockAgent);
    });
  });

  describe('sync lock', () => {
    it('should throw when sync is already in progress', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        did      : { dereference: sinon.stub() },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      // Manually set the lock to simulate a sync in progress.
      (engine as any)._syncLock = true;

      await expect(engine.sync()).rejects.toThrow('Sync operation is already in progress');

      // Reset the lock.
      (engine as any)._syncLock = false;
    });
  });

  describe('topologicalSort (static)', () => {
    it('should delegate to the standalone topologicalSort function', () => {
      const messages = [{ message: { descriptor: { interface: 'Records', method: 'Write' } } }];
      const result = SyncEngineLevel.topologicalSort(messages as any);
      expect(result).toEqual(messages);
    });
  });

  describe('stopSync', () => {
    it('should stop when there is no sync in progress', async () => {
      const engine = new SyncEngineLevel({ db });
      // Should not throw.
      await engine.stopSync();
    });

    it('should throw when sync lock does not clear within timeout', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncLock = true;

      // Use timeout < 100 so stopSync only needs one short sleep before
      // throwing, making the test fast and resilient to CI timer jitter.
      await expect(engine.stopSync(10)).rejects.toThrow('did not complete within');

      (engine as any)._syncLock = false;
    });
  });
});
