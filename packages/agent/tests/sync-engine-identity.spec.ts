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
    it('should register an identity with protocols: all', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:register1', options: { protocols: 'all' } });
      const options = await syncEngine.getIdentityOptions('did:example:register1');
      expect(options).toBeDefined();
      expect(options!.protocols).toBe('all');
    });

    it('should register an identity with specific protocols and delegateDid', async () => {
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
      await syncEngine.registerIdentity({ did: 'did:example:dup', options: { protocols: 'all' } });
      await expect(
        syncEngine.registerIdentity({ did: 'did:example:dup', options: { protocols: 'all' } })
      ).rejects.toThrow('is already registered');
    });
  });

  describe('unregisterIdentity', () => {
    it('should unregister a registered identity', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:unreg1', options: { protocols: 'all' } });
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

    it('should not normalize non-empty protocol arrays', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:specific', options: { protocols: ['https://proto.example'] } });
      const options = await syncEngine.getIdentityOptions('did:example:specific');
      expect(options).toBeDefined();
      expect(options!.protocols).toEqual(['https://proto.example']);
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
          options : { protocols: 'all' },
        })
      ).rejects.toThrow('is not registered');
    });

    it('should reject an empty protocols array', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:upd-empty', options: { protocols: ['old'] } });
      await expect(
        syncEngine.updateIdentityOptions({
          did     : 'did:example:upd-empty',
          options : { protocols: [] } as any,
        })
      ).rejects.toThrow('empty array is ambiguous');
    });

    it('should reject when options is missing entirely (JS caller)', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:upd-no-opts', options: { protocols: ['old'] } });
      await expect(
        (syncEngine as any).updateIdentityOptions({ did: 'did:example:upd-no-opts' })
      ).rejects.toThrow('options.protocols is required');
    });
  });

  describe('explicit protocol scope', () => {
    it('should persist protocols: all and retrieve it as the string all', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:scope-all', options: { protocols: 'all' } });
      const options = await syncEngine.getIdentityOptions('did:example:scope-all');
      expect(options).toBeDefined();
      expect(options!.protocols).toBe('all');
      expect(typeof options!.protocols).toBe('string');
    });

    it('should persist a specific protocol list and retrieve it as an array', async () => {
      const protos = ['https://proto.example.com/chat/1.0', 'https://proto.example.com/notes/1.0'];
      await syncEngine.registerIdentity({ did: 'did:example:scope-list', options: { protocols: protos } });
      const options = await syncEngine.getIdentityOptions('did:example:scope-list');
      expect(options).toBeDefined();
      expect(Array.isArray(options!.protocols)).toBe(true);
      expect(options!.protocols).toEqual(protos);
    });

    it('should reject an empty protocols array at registration time', async () => {
      await expect(
        syncEngine.registerIdentity({ did: 'did:example:scope-empty', options: { protocols: [] } })
      ).rejects.toThrow('empty array is ambiguous');
    });

    it('should reject when options is missing entirely (JS caller)', async () => {
      await expect(
        (syncEngine as any).registerIdentity({ did: 'did:example:no-opts' })
      ).rejects.toThrow('options.protocols is required');
    });

    it('should reject non-array non-all protocols value', async () => {
      await expect(
        (syncEngine as any).registerIdentity({ did: 'did:example:bad', options: { protocols: 'foo' } })
      ).rejects.toThrow('must be \'all\' or a non-empty string array');
    });

    it('should reject undefined protocols', async () => {
      await expect(
        (syncEngine as any).registerIdentity({ did: 'did:example:undef', options: { protocols: undefined } })
      ).rejects.toThrow('must be \'all\' or a non-empty string array');
    });

    it('should update from protocols: all to a specific list', async () => {
      await syncEngine.registerIdentity({ did: 'did:example:scope-switch', options: { protocols: 'all' } });
      await syncEngine.updateIdentityOptions({
        did     : 'did:example:scope-switch',
        options : { protocols: ['https://proto.example.com/notes/1.0'] },
      });
      const options = await syncEngine.getIdentityOptions('did:example:scope-switch');
      expect(options!.protocols).toEqual(['https://proto.example.com/notes/1.0']);
    });

    it('should update from a specific list to protocols: all', async () => {
      await syncEngine.registerIdentity({
        did     : 'did:example:scope-widen',
        options : { protocols: ['https://proto.example.com/notes/1.0'] },
      });
      await syncEngine.updateIdentityOptions({
        did     : 'did:example:scope-widen',
        options : { protocols: 'all' },
      });
      const options = await syncEngine.getIdentityOptions('did:example:scope-widen');
      expect(options!.protocols).toBe('all');
    });
  });

  describe('getSyncTargets — protocol scope handling', () => {
    it('should produce one unscoped target per URL when protocols is all', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn1.example.com', 'https://dwn2.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await engine.registerIdentity({ did: 'did:example:all-protos', options: { protocols: 'all' } });
      const targets = await (engine as any).getSyncTargets();

      expect(targets).toHaveLength(2);
      expect(targets[0].protocol).toBeUndefined();
      expect(targets[1].protocol).toBeUndefined();
      expect(targets[0].dwnUrl).toBe('https://dwn1.example.com');
      expect(targets[1].dwnUrl).toBe('https://dwn2.example.com');
    });

    it('should produce one target per protocol per URL when protocols is a list', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await engine.registerIdentity({
        did     : 'did:example:scoped',
        options : { protocols: ['https://proto1.example.com', 'https://proto2.example.com'] },
      });
      const targets = await (engine as any).getSyncTargets();

      expect(targets).toHaveLength(2);
      expect(targets[0].protocol).toBe('https://proto1.example.com');
      expect(targets[1].protocol).toBe('https://proto2.example.com');
    });

    it('should skip identity when stored JSON is corrupt', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      // Write corrupt JSON directly to the sublevel.
      const identities = db.sublevel('registeredIdentities');
      await identities.put('did:example:corrupt', '}{not-json');

      const warnStub = sinon.stub(console, 'warn');
      const targets = await (engine as any).getSyncTargets();

      // Corrupt identity is skipped — no targets generated.
      expect(targets).toHaveLength(0);
      expect(warnStub.calledOnce).toBe(true);
      warnStub.restore();
    });

    it('should include delegateDid in targets from registration options', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await engine.registerIdentity({
        did     : 'did:example:delegated',
        options : { protocols: 'all', delegateDid: 'did:example:delegate' },
      });
      const targets = await (engine as any).getSyncTargets();

      expect(targets).toHaveLength(1);
      expect(targets[0].delegateDid).toBe('did:example:delegate');
    });

    it('should handle mixed all and scoped registrations', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await engine.registerIdentity({
        did     : 'did:example:alice',
        options : { protocols: 'all' },
      });
      await engine.registerIdentity({
        did     : 'did:example:bob',
        options : { protocols: ['https://proto.example.com/chat/1.0'] },
      });

      const targets = await (engine as any).getSyncTargets();

      // Alice produces 1 unscoped target, Bob produces 1 scoped target.
      expect(targets).toHaveLength(2);
      const aliceTarget = targets.find((t: any) => t.did === 'did:example:alice');
      const bobTarget = targets.find((t: any) => t.did === 'did:example:bob');
      expect(aliceTarget!.protocol).toBeUndefined();
      expect(bobTarget!.protocol).toBe('https://proto.example.com/chat/1.0');
    });
  });

  describe('clear', () => {
    it('should clear the sync engine state', async () => {
      // Register an identity, then clear and verify it's gone.
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await engine.registerIdentity({ did: 'did:example:clear1', options: { protocols: 'all' } });
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
      const clock = sinon.useFakeTimers();
      try {
        const engine = new SyncEngineLevel({ db });
        (engine as any)._syncLock = true;

        // Start stopSync but don't await — it will poll until timeout.
        let caught: Error | undefined;
        const promise = engine.stopSync(200).catch((err: Error): void => { caught = err; });

        // Advance past the timeout so the polling loop exceeds the budget.
        await clock.tickAsync(300);
        await promise;

        expect(caught).toBeDefined();
        expect(caught!.message).toContain('did not complete within');

        (engine as any)._syncLock = false;
      } finally {
        clock.restore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-identity hot-add / hot-remove
  // ---------------------------------------------------------------------------

  describe('multi-identity hot-add / hot-remove', () => {

    // --- registerIdentity hot-add triggers ---

    it('should call addIdentityToLiveSync when registering during active live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';
      (engine as any)._liveSubscriptions = [{ linkKey: 'existing', did: 'did:example:existing', dwnUrl: 'https://dwn.example.com', close: sinon.stub() }];

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.registerIdentity({ did: 'did:example:hotadd1', options: { protocols: ['https://proto.example'] } });

      expect(hotAddStub.calledOnce).toBe(true);
      expect(hotAddStub.firstCall.args[0]).toBe('did:example:hotadd1');
      expect(hotAddStub.firstCall.args[1]).toEqual({ protocols: ['https://proto.example'] });
    });

    it('should pass default options to addIdentityToLiveSync when none provided', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';
      (engine as any)._liveSubscriptions = [{ linkKey: 'existing', did: 'did:example:existing', dwnUrl: 'https://dwn.example.com', close: sinon.stub() }];

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.registerIdentity({ did: 'did:example:hotadd-default' });

      expect(hotAddStub.calledOnce).toBe(true);
      expect(hotAddStub.firstCall.args[1]).toEqual({ protocols: [] });
    });

    it('should not call addIdentityToLiveSync when sync mode is poll', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'poll';
      (engine as any)._liveSubscriptions = [];

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.registerIdentity({ did: 'did:example:nohot-poll' });

      expect(hotAddStub.called).toBe(false);
    });

    it('should call addIdentityToLiveSync when live mode has no active subscriptions (e.g. after last identity removed)', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';
      (engine as any)._liveSubscriptions = [];

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.registerIdentity({ did: 'did:example:hot-after-removal' });

      // Hot-add should fire because _syncMode is 'live', even with zero
      // existing subscriptions. This handles the case where the last
      // identity was removed and a new one is added.
      expect(hotAddStub.calledOnce).toBe(true);
    });

    it('should still persist identity even if addIdentityToLiveSync throws', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';
      (engine as any)._liveSubscriptions = [{ linkKey: 'existing', did: 'did:example:existing', dwnUrl: 'https://dwn.example.com', close: sinon.stub() }];

      sinon.stub(engine as any, 'addIdentityToLiveSync').rejects(new Error('hot-add boom'));

      await expect(
        engine.registerIdentity({ did: 'did:example:hotadd-fail' })
      ).rejects.toThrow('hot-add boom');

      // The identity should still be persisted because the put happens before hot-add.
      const options = await engine.getIdentityOptions('did:example:hotadd-fail');
      expect(options).toBeDefined();
      expect(options!.protocols).toEqual([]);
    });

    // --- unregisterIdentity hot-remove triggers ---

    it('should call removeIdentityFromLiveSync when unregistering during active live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:hotrem1' });

      (engine as any)._syncMode = 'live';
      (engine as any)._liveSubscriptions = [{ linkKey: 'existing', did: 'did:example:existing', dwnUrl: 'https://dwn.example.com', close: sinon.stub() }];

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:hotrem1');

      expect(hotRemoveStub.calledOnce).toBe(true);
      expect(hotRemoveStub.firstCall.args[0]).toBe('did:example:hotrem1');
    });

    it('should not call removeIdentityFromLiveSync when sync mode is poll', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:nohotrem-poll' });

      (engine as any)._syncMode = 'poll';
      (engine as any)._liveSubscriptions = [];

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:nohotrem-poll');

      expect(hotRemoveStub.called).toBe(false);
    });

    it('should still throw when unregistering a non-registered identity during live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';
      (engine as any)._liveSubscriptions = [{ linkKey: 'existing', did: 'did:example:existing', close: sinon.stub() }];

      await expect(
        engine.unregisterIdentity('did:example:never-registered-live')
      ).rejects.toThrow('is not registered');
    });

    // --- removeIdentityFromLiveSync subscription isolation ---

    it('removeIdentityFromLiveSync should close and remove subscriptions for the target DID only', async () => {
      const engine = new SyncEngineLevel({ db });

      const closeAlice = sinon.stub().resolves();
      const closeBob = sinon.stub().resolves();

      (engine as any)._liveSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', close: closeAlice },
        { linkKey: 'did:example:bob^https://dwn.example.com', did: 'did:example:bob', dwnUrl: 'https://dwn.example.com', close: closeBob },
      ];
      (engine as any)._localSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', close: closeAlice },
        { linkKey: 'did:example:bob^https://dwn.example.com', did: 'did:example:bob', dwnUrl: 'https://dwn.example.com', close: closeBob },
      ];

      (engine as any)._activeLinks.set('did:example:alice^https://dwn.example.com', { tenantDid: 'did:example:alice' });
      (engine as any)._activeLinks.set('did:example:bob^https://dwn.example.com', { tenantDid: 'did:example:bob' });
      (engine as any)._linkRuntimes.set('did:example:alice^https://dwn.example.com', { nextDeliveryOrdinal: 0, nextCommitOrdinal: 0, inflight: new Map() });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(closeAlice.callCount).toBe(2);
      expect(closeBob.called).toBe(false);
      expect((engine as any)._liveSubscriptions).toHaveLength(1);
      expect((engine as any)._liveSubscriptions[0].did).toBe('did:example:bob');
      expect((engine as any)._localSubscriptions).toHaveLength(1);
      expect((engine as any)._localSubscriptions[0].did).toBe('did:example:bob');
      expect((engine as any)._activeLinks.has('did:example:alice^https://dwn.example.com')).toBe(false);
      expect((engine as any)._linkRuntimes.has('did:example:alice^https://dwn.example.com')).toBe(false);
      expect((engine as any)._activeLinks.has('did:example:bob^https://dwn.example.com')).toBe(true);
    });

    it('removeIdentityFromLiveSync should cancel push timers for the target DID only', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      const aliceTimer = setTimeout(() => {}, 60_000);
      const bobTimer = setTimeout(() => {}, 60_000);
      (engine as any)._pushRuntimes.set('did:example:alice^https://dwn.example.com', {
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', entries: [], retryCount: 0, timer: aliceTimer,
      });
      (engine as any)._pushRuntimes.set('did:example:bob^https://dwn.example.com', {
        did: 'did:example:bob', dwnUrl: 'https://dwn.example.com', entries: [], retryCount: 0, timer: bobTimer,
      });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._pushRuntimes.has('did:example:alice^https://dwn.example.com')).toBe(false);
      expect((engine as any)._pushRuntimes.has('did:example:bob^https://dwn.example.com')).toBe(true);

      clearTimeout(bobTimer);
    });

    it('removeIdentityFromLiveSync should clear degraded-poll timers for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      const aliceTimer = setInterval(() => {}, 60_000);
      const bobTimer = setInterval(() => {}, 60_000);
      (engine as any)._degradedPollTimers.set('did:example:alice^https://dwn.example.com^scope1', aliceTimer);
      (engine as any)._degradedPollTimers.set('did:example:bob^https://dwn.example.com^scope2', bobTimer);

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._degradedPollTimers.has('did:example:alice^https://dwn.example.com^scope1')).toBe(false);
      expect((engine as any)._degradedPollTimers.has('did:example:bob^https://dwn.example.com^scope2')).toBe(true);

      clearInterval(bobTimer);
    });

    it('removeIdentityFromLiveSync should clear repair attempts and retry timers for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      (engine as any)._repairAttempts.set('did:example:alice^https://dwn.example.com^scope1', 2);
      (engine as any)._repairAttempts.set('did:example:bob^https://dwn.example.com^scope1', 1);

      const aliceRetryTimer = setTimeout(() => {}, 60_000);
      const bobRetryTimer = setTimeout(() => {}, 60_000);
      (engine as any)._repairRetryTimers.set('did:example:alice^https://dwn.example.com^scope1', aliceRetryTimer);
      (engine as any)._repairRetryTimers.set('did:example:bob^https://dwn.example.com^scope1', bobRetryTimer);

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._repairAttempts.has('did:example:alice^https://dwn.example.com^scope1')).toBe(false);
      expect((engine as any)._repairAttempts.has('did:example:bob^https://dwn.example.com^scope1')).toBe(true);
      expect((engine as any)._repairRetryTimers.has('did:example:alice^https://dwn.example.com^scope1')).toBe(false);
      expect((engine as any)._repairRetryTimers.has('did:example:bob^https://dwn.example.com^scope1')).toBe(true);

      clearTimeout(bobRetryTimer);
    });

    it('removeIdentityFromLiveSync should clear reconcile timers and in-flight ops for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      const aliceReconcileTimer = setTimeout(() => {}, 60_000);
      const bobReconcileTimer = setTimeout(() => {}, 60_000);
      (engine as any)._reconcileTimers.set('did:example:alice^https://dwn.example.com^scope1', aliceReconcileTimer);
      (engine as any)._reconcileTimers.set('did:example:bob^https://dwn.example.com^scope1', bobReconcileTimer);
      (engine as any)._reconcileInFlight.set('did:example:alice^https://dwn.example.com^scope1', Promise.resolve());

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._reconcileTimers.has('did:example:alice^https://dwn.example.com^scope1')).toBe(false);
      expect((engine as any)._reconcileTimers.has('did:example:bob^https://dwn.example.com^scope1')).toBe(true);
      expect((engine as any)._reconcileInFlight.has('did:example:alice^https://dwn.example.com^scope1')).toBe(false);

      clearTimeout(bobReconcileTimer);
    });

    it('removeIdentityFromLiveSync should clear the closure evaluation context for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      (engine as any)._closureContexts.set('did:example:alice', { someState: true });
      (engine as any)._closureContexts.set('did:example:bob', { someState: true });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._closureContexts.has('did:example:alice')).toBe(false);
      expect((engine as any)._closureContexts.has('did:example:bob')).toBe(true);
    });

    it('removeIdentityFromLiveSync should be a safe no-op for a DID with no subscriptions or state', async () => {
      const engine = new SyncEngineLevel({ db });

      (engine as any)._liveSubscriptions = [
        { linkKey: 'did:example:bob^https://dwn.example.com', did: 'did:example:bob', dwnUrl: 'https://dwn.example.com', close: sinon.stub() },
      ];
      (engine as any)._localSubscriptions = [
        { linkKey: 'did:example:bob^https://dwn.example.com', did: 'did:example:bob', dwnUrl: 'https://dwn.example.com', close: sinon.stub() },
      ];

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._liveSubscriptions).toHaveLength(1);
      expect((engine as any)._localSubscriptions).toHaveLength(1);
    });

    it('removeIdentityFromLiveSync should continue even if subscription close throws', async () => {
      const engine = new SyncEngineLevel({ db });

      const closeThrows = sinon.stub().rejects(new Error('close boom'));
      const closeOk = sinon.stub().resolves();

      (engine as any)._liveSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn1.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn1.example.com', close: closeThrows },
        { linkKey: 'did:example:alice^https://dwn2.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn2.example.com', close: closeOk },
      ];
      (engine as any)._localSubscriptions = [];

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(closeThrows.calledOnce).toBe(true);
      expect(closeOk.calledOnce).toBe(true);
      expect((engine as any)._liveSubscriptions).toHaveLength(0);
    });

    it('removeIdentityFromLiveSync should remove all links for an identity with multiple endpoints', async () => {
      const engine = new SyncEngineLevel({ db });

      const close1 = sinon.stub().resolves();
      const close2 = sinon.stub().resolves();

      (engine as any)._liveSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn1.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn1.example.com', close: close1 },
        { linkKey: 'did:example:alice^https://dwn2.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn2.example.com', close: close2 },
      ];
      (engine as any)._localSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn1.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn1.example.com', close: close1 },
        { linkKey: 'did:example:alice^https://dwn2.example.com', did: 'did:example:alice', dwnUrl: 'https://dwn2.example.com', close: close2 },
      ];
      (engine as any)._activeLinks.set('did:example:alice^https://dwn1.example.com', { tenantDid: 'did:example:alice' });
      (engine as any)._activeLinks.set('did:example:alice^https://dwn2.example.com', { tenantDid: 'did:example:alice' });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(close1.callCount).toBe(2);
      expect(close2.callCount).toBe(2);
      expect((engine as any)._liveSubscriptions).toHaveLength(0);
      expect((engine as any)._localSubscriptions).toHaveLength(0);
      expect((engine as any)._activeLinks.size).toBe(0);
    });

    // --- addIdentityToLiveSync ---

    it('addIdentityToLiveSync should be a no-op when identity has no DWN endpoints', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getDwnEndpointUrlsForTarget: sinon.stub().resolves([]) },
      };
      (engine as any)._agent = mockAgent;

      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      const openPushStub = sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:no-endpoints', { protocols: [] });

      expect(openPullStub.called).toBe(false);
      expect(openPushStub.called).toBe(false);
    });

    it('addIdentityToLiveSync should create per-protocol targets when protocols are specified', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      const ledgerStub = sinon.stub().resolves({
        tenantDid      : 'did:example:proto',
        remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'scope1',
        scope          : { kind: 'protocol', protocol: '' },
        status         : 'initializing',
        pull           : {},
        connectivity   : 'unknown',
      });
      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink : ledgerStub,
        saveLink        : sinon.stub().resolves(),
        setStatus       : sinon.stub().resolves(),
      }));
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).addIdentityToLiveSync('did:example:proto', {
        protocols: ['https://proto1.example', 'https://proto2.example'],
      });

      expect(ledgerStub.callCount).toBe(2);
      expect(ledgerStub.firstCall.args[0].scope).toEqual({ kind: 'protocol', protocol: 'https://proto1.example' });
      expect(ledgerStub.secondCall.args[0].scope).toEqual({ kind: 'protocol', protocol: 'https://proto2.example' });
    });

    it('addIdentityToLiveSync should create a full-tenant link when protocols is all', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      const ledgerStub = sinon.stub().resolves({
        tenantDid      : 'did:example:full',
        remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'scope-full',
        scope          : { kind: 'full' },
        status         : 'initializing',
        pull           : {},
        connectivity   : 'unknown',
      });
      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink : ledgerStub,
        saveLink        : sinon.stub().resolves(),
        setStatus       : sinon.stub().resolves(),
      }));
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).addIdentityToLiveSync('did:example:full', { protocols: 'all' });

      expect(ledgerStub.calledOnce).toBe(true);
      expect(ledgerStub.firstCall.args[0].scope).toEqual({ kind: 'full' });
    });

    it('addIdentityToLiveSync should close pull subscription if push subscription fails', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink: sinon.stub().resolves({
          tenantDid      : 'did:example:pushfail',
          remoteEndpoint : 'https://dwn.example.com',
          scopeId        : 'scope1',
          scope          : { kind: 'full' },
          status         : 'initializing',
          pull           : {},
          connectivity   : 'unknown',
        }),
        saveLink  : sinon.stub().resolves(),
        setStatus : sinon.stub().resolves(),
      }));
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      const pullCloseSpy = sinon.stub().resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (target: any) => {
        (engine as any)._liveSubscriptions.push({
          linkKey: target.linkKey, did: target.did, dwnUrl: target.dwnUrl, close: pullCloseSpy,
        });
      });
      sinon.stub(engine as any, 'openLocalPushSubscription').rejects(new Error('push subscription boom'));

      await (engine as any).addIdentityToLiveSync('did:example:pushfail', { protocols: 'all' });

      expect(pullCloseSpy.calledOnce).toBe(true);
      expect((engine as any)._liveSubscriptions).toHaveLength(0);
      expect((engine as any)._activeLinks.has('did:example:pushfail^https://dwn.example.com^scope1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // hasActiveSubscriptions
  // ---------------------------------------------------------------------------

  describe('hasActiveSubscriptions', () => {
    it('should return false when no subscriptions are open', () => {
      const engine = new SyncEngineLevel({ db });
      expect(engine.hasActiveSubscriptions).toBe(false);
    });

    it('should return true when live pull subscriptions are open', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [{ linkKey: 'k', did: 'did:example:a', close: sinon.stub() }];
      expect(engine.hasActiveSubscriptions).toBe(true);
      (engine as any)._liveSubscriptions = [];
    });

    it('should return false when only the integrity timer is active', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncIntervalId = setInterval(() => {}, 60_000);
      expect(engine.hasActiveSubscriptions).toBe(false);
      clearInterval((engine as any)._syncIntervalId);
      (engine as any)._syncIntervalId = undefined;
    });

    it('should return true when local push subscriptions are open', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._localSubscriptions = [{ linkKey: 'k', did: 'did:example:a', close: sinon.stub() }];
      expect(engine.hasActiveSubscriptions).toBe(true);
      (engine as any)._localSubscriptions = [];
    });

    it('should return false after all subscriptions are removed', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];
      expect(engine.hasActiveSubscriptions).toBe(false);
    });

    it('should return false when only active links exist but no subscriptions', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._activeLinks.set('some-key', { tenantDid: 'did:example:a' });
      expect(engine.hasActiveSubscriptions).toBe(false);
      (engine as any)._activeLinks.clear();
    });
  });

  // ---------------------------------------------------------------------------
  // updateIdentityOptions — live subscription refresh
  // ---------------------------------------------------------------------------

  describe('updateIdentityOptions — live subscription refresh', () => {
    it('should hot-remove and hot-add when updating options during live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:update1' });

      (engine as any)._syncMode = 'live';
      (engine as any)._activeLinks.set('did:example:update1^https://dwn.example.com', { tenantDid: 'did:example:update1' });

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();
      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      const newOptions = { protocols: ['https://new-proto.example'], delegateDid: 'did:example:delegate' };
      await engine.updateIdentityOptions({ did: 'did:example:update1', options: newOptions });

      expect(hotRemoveStub.calledOnce).toBe(true);
      expect(hotAddStub.calledOnce).toBe(true);
      expect(hotAddStub.firstCall.args[1]).toEqual(newOptions);
      // hot-remove should be called before hot-add
      expect(hotRemoveStub.calledBefore(hotAddStub)).toBe(true);
    });

    it('should not hot-remove/add when updating options while sync is not live', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:update-poll' });

      (engine as any)._syncMode = 'poll';

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();
      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.updateIdentityOptions({ did: 'did:example:update-poll', options: { protocols: ['https://new.example'] } });

      expect(hotRemoveStub.called).toBe(false);
      expect(hotAddStub.called).toBe(false);
    });

    it('should not hot-remove/add when identity has no active links (not yet syncing)', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:update-nolinks' });

      (engine as any)._syncMode = 'live';
      // No active links for this DID

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();
      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.updateIdentityOptions({ did: 'did:example:update-nolinks', options: { protocols: ['https://new.example'] } });

      expect(hotRemoveStub.called).toBe(false);
      expect(hotAddStub.called).toBe(false);
    });

    it('should persist new options even if not in live mode', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:persist-opts' });

      const newOptions = { protocols: ['https://persisted.example'] };
      await engine.updateIdentityOptions({ did: 'did:example:persist-opts', options: newOptions });

      const stored = await engine.getIdentityOptions('did:example:persist-opts');
      expect(stored).toEqual(newOptions);
    });
  });

  // ---------------------------------------------------------------------------
  // remove-last-then-add scenario
  // ---------------------------------------------------------------------------

  describe('remove last identity, then add new one', () => {
    it('should hot-add the new identity even when no subscriptions remain', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';

      // Simulate: identity A was syncing, then removed (no subscriptions left).
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.registerIdentity({ did: 'did:example:after-last-removed' });

      // Hot-add should fire because _syncMode is 'live'.
      expect(hotAddStub.calledOnce).toBe(true);
    });

    it('hasActiveSubscriptions should return false after last identity removed', () => {
      const engine = new SyncEngineLevel({ db });
      // Timer left over from live mode, but no subscriptions.
      (engine as any)._syncIntervalId = setInterval(() => {}, 60_000);
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      expect(engine.hasActiveSubscriptions).toBe(false);

      clearInterval((engine as any)._syncIntervalId);
    });
  });

  // ---------------------------------------------------------------------------
  // stopSync resets _syncMode — registerIdentity after stop must not hot-add
  // ---------------------------------------------------------------------------

  describe('registerIdentity after stopSync', () => {
    it('should not hot-add when sync was explicitly stopped', async () => {
      const engine = new SyncEngineLevel({ db });

      // Simulate a live sync session that was explicitly stopped.
      (engine as any)._syncMode = 'live';
      await engine.stopSync();

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves();

      await engine.registerIdentity({ did: 'did:example:after-stop' });

      // _syncMode should have been reset by stopSync, so no hot-add.
      expect(hotAddStub.called).toBe(false);
    });

    it('should not hot-remove when sync was explicitly stopped', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:stop-then-unreg' });

      (engine as any)._syncMode = 'live';
      await engine.stopSync();

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:stop-then-unreg');

      expect(hotRemoveStub.called).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // removeIdentityFromLiveSync clears in-flight repair state
  // ---------------------------------------------------------------------------

  describe('removeIdentityFromLiveSync — in-flight repair cleanup', () => {
    it('should clear _activeRepairs for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      (engine as any)._activeRepairs.set('did:example:alice^https://dwn.example.com^scope1', Promise.resolve());
      (engine as any)._activeRepairs.set('did:example:bob^https://dwn.example.com^scope1', Promise.resolve());

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._activeRepairs.has('did:example:alice^https://dwn.example.com^scope1')).toBe(false);
      expect((engine as any)._activeRepairs.has('did:example:bob^https://dwn.example.com^scope1')).toBe(true);
    });

    it('should clear _repairContext for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      (engine as any)._repairContext.set('did:example:alice^https://dwn.example.com^scope1', { resumeToken: 'tok1' });
      (engine as any)._repairContext.set('did:example:bob^https://dwn.example.com^scope1', { resumeToken: 'tok2' });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._repairContext.has('did:example:alice^https://dwn.example.com^scope1')).toBe(false);
      expect((engine as any)._repairContext.has('did:example:bob^https://dwn.example.com^scope1')).toBe(true);
    });
  });
});
