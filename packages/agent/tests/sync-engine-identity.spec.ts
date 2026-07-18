import sinon from 'sinon';

import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncScopeClosureValidator } from '../src/sync-scope-closure-validator.js';

function activateTestLink(engine: SyncEngineLevel, linkKey: string, did: string, remoteEndpoint = 'https://dwn.example.com'): any {
  return (engine as any).activateLink(linkKey, {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    projectionId       : 'projection-id',
    pull               : {},
    push               : {},
    remoteEndpoint,
    scope              : { kind: 'full' },
    status             : 'live',
    tenantDid          : did,
  });
}

describe('SyncEngineLevel — identity management', () => {
  let db: Level<string, string>;
  const messagesGrantEntry = (id: string, grantor: string, grantee: string, scope: Record<string, unknown>): any => ({
    grant: {
      id,
      grantor,
      grantee,
      dateGranted : '2026-01-01T00:00:00.000000Z',
      dateExpires : '2999-01-01T00:00:00.000000Z',
      scope,
    },
    message: {},
  });
  let syncEngine: SyncEngineLevel;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-engine-identity-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  beforeEach(() => {
    sinon.stub(SyncScopeClosureValidator.prototype, 'validateClosure').resolves();
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
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn1.example.com', 'https://dwn2.example.com']),
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

    it('should produce one protocol-set target per URL when protocols is a list', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await engine.registerIdentity({
        did     : 'did:example:scoped',
        options : { protocols: ['https://proto1.example.com', 'https://proto2.example.com'] },
      });
      const targets = await (engine as any).getSyncTargets();

      expect(targets).toHaveLength(1);
      expect(targets[0].scope).toEqual({
        kind      : 'protocolSet',
        protocols : ['https://proto1.example.com', 'https://proto2.example.com'],
      });
      expect(targets[0].authorization).toEqual({ kind: 'owner' });
    });

    it('should skip identity when stored JSON is corrupt', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
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
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = {
        fetchGrants: sinon.stub().resolves([
          messagesGrantEntry('grant-1', 'did:example:delegated', 'did:example:delegate', { interface: 'Messages', method: 'Read' }),
        ]),
      };

      await engine.registerIdentity({
        did     : 'did:example:delegated',
        options : { protocols: 'all', delegateDid: 'did:example:delegate' },
      });
      const targets = await (engine as any).getSyncTargets();

      expect(targets).toHaveLength(1);
      expect(targets[0].delegateDid).toBe('did:example:delegate');
      expect(targets[0].authorization).toEqual({
        kind               : 'delegate',
        delegateDid        : 'did:example:delegate',
        permissionGrantIds : ['grant-1'],
      });
    });

    it('should handle mixed all and scoped registrations', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
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

      // Alice produces 1 full target, Bob produces 1 protocol-set target.
      expect(targets).toHaveLength(2);
      const aliceTarget = targets.find((t: any) => t.did === 'did:example:alice');
      const bobTarget = targets.find((t: any) => t.did === 'did:example:bob');
      expect(aliceTarget!.scope).toEqual({ kind: 'full' });
      expect(bobTarget!.scope).toEqual({
        kind      : 'protocolSet',
        protocols : ['https://proto.example.com/chat/1.0'],
      });
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
    it('should set the agent and rebuild agent-bound target resolution', () => {
      const engine = new SyncEngineLevel({ db });
      const internal = engine as any;
      const initialResolver = internal.targetResolver;
      const initialTopologyGeneration = internal._targetPlanner.generation;
      const mockAgent = { agentDid: 'did:example:agent' } as any;

      engine.agent = mockAgent;

      expect(engine.agent).toBe(mockAgent);
      expect(internal.targetResolver).not.toBe(initialResolver);
      expect(internal._targetPlanner.generation).toBe(initialTopologyGeneration + 1);
    });
  });

  describe('sync lock', () => {
    it('should coalesce a sync() that arrives while the lock is held', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        did      : { dereference: sinon.stub() },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      const lifecycle = (engine as any)._lifecycle;
      const run = sinon.stub().resolves();
      (engine as any)._runCoordinator = { run };

      expect(lifecycle.tryAcquireSync()).toBe(true);

      // Instead of throwing, the call queues a follow-up run behind the lock.
      const queued = engine.sync('pull');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(run.notCalled).toBe(true);

      lifecycle.releaseSync();
      await queued;

      expect(run.calledOnce).toBe(true);
      expect(run.firstCall.args[0]).toBe('pull');
    });
  });

  describe('stopSync', () => {
    it('should stop when there is no sync in progress', async () => {
      const engine = new SyncEngineLevel({ db });
      // With no sync running, stopSync resolves cleanly without throwing.
      await expect(engine.stopSync()).resolves.toBeUndefined();
    });

    it('should throw when sync lock does not clear within timeout', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const engine = new SyncEngineLevel({ db });
        const lifecycle = (engine as any)._lifecycle;
        expect(lifecycle.tryAcquireSync()).toBe(true);

        // Start stopSync but don't await — it will wait until timeout.
        let caught: Error | undefined;
        const promise = engine.stopSync(200).catch((err: Error): void => { caught = err; });

        // Advance past the timeout so the polling loop exceeds the budget.
        await clock.tickAsync(300);
        await promise;

        expect(caught).toBeDefined();
        expect(caught!.message).toContain('did not complete within');

        lifecycle.releaseSync();
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

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:hotadd1', options: { protocols: ['https://proto.example'] } });

      expect(hotAddStub.calledOnce).toBe(true);
      expect(hotAddStub.firstCall.args[0]).toBe('did:example:hotadd1');
      expect(hotAddStub.firstCall.args[1]).toEqual({ protocols: ['https://proto.example'] });
    });

    it('should pass options to addIdentityToLiveSync when protocols is all', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:hotadd-default', options: { protocols: 'all' } });

      expect(hotAddStub.calledOnce).toBe(true);
      expect(hotAddStub.firstCall.args[1]).toEqual({ protocols: 'all' });
    });

    it('should not call addIdentityToLiveSync when sync mode is poll', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'poll';

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:nohot-poll', options: { protocols: 'all' } });

      expect(hotAddStub.called).toBe(false);
    });

    it('should call addIdentityToLiveSync when live mode has no active subscriptions (e.g. after last identity removed)', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:hot-after-removal', options: { protocols: 'all' } });

      // Hot-add should fire because _syncMode is 'live', even with zero
      // existing subscriptions. This handles the case where the last
      // identity was removed and a new one is added.
      expect(hotAddStub.calledOnce).toBe(true);
    });

    it('should still persist identity even if addIdentityToLiveSync throws', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';

      sinon.stub(engine as any, 'addIdentityToLiveSync').rejects(new Error('hot-add boom'));

      await expect(
        engine.registerIdentity({ did: 'did:example:hotadd-fail', options: { protocols: 'all' } })
      ).rejects.toThrow('hot-add boom');

      // The identity should still be persisted because the put happens before hot-add.
      const options = await engine.getIdentityOptions('did:example:hotadd-fail');
      expect(options).toBeDefined();
      expect(options!.protocols).toBe('all');
    });

    // --- unregisterIdentity hot-remove triggers ---

    it('should call removeIdentityFromLiveSync when unregistering during active live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:hotrem1', options: { protocols: 'all' } });

      (engine as any)._syncMode = 'live';

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:hotrem1');

      expect(hotRemoveStub.calledOnce).toBe(true);
      expect(hotRemoveStub.firstCall.args[0]).toBe('did:example:hotrem1');
    });

    it('should not call removeIdentityFromLiveSync when sync mode is poll', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:nohotrem-poll', options: { protocols: 'all' } });

      (engine as any)._syncMode = 'poll';

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:nohotrem-poll');

      expect(hotRemoveStub.called).toBe(false);
    });

    it('should still throw when unregistering a non-registered identity during live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._syncMode = 'live';

      await expect(
        engine.unregisterIdentity('did:example:never-registered-live')
      ).rejects.toThrow('is not registered');
    });

    // --- removeIdentityFromLiveSync subscription isolation ---

    it('removeIdentityFromLiveSync should close and remove subscriptions for the target DID only', async () => {
      const engine = new SyncEngineLevel({ db });

      const closeAlice = sinon.stub().resolves();
      const closeBob = sinon.stub().resolves();
      const aliceKey = 'did:example:alice^https://dwn.example.com';
      const bobKey = 'did:example:bob^https://dwn.example.com';
      const aliceController = activateTestLink(engine, aliceKey, 'did:example:alice');
      const bobController = activateTestLink(engine, bobKey, 'did:example:bob');
      aliceController.setLiveSubscription({ close: closeAlice });
      aliceController.setLocalSubscription({ close: closeAlice });
      bobController.setLiveSubscription({ close: closeBob });
      bobController.setLocalSubscription({ close: closeBob });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(closeAlice.callCount).toBe(2);
      expect(closeBob.called).toBe(false);
      expect(bobController.hasLiveSubscription).toBe(true);
      expect(bobController.hasLocalSubscription).toBe(true);
      expect((engine as any)._linkControllers.has(aliceKey)).toBe(false);
      expect((engine as any)._linkControllers.has(bobKey)).toBe(true);
    });

    it('removeIdentityFromLiveSync should cancel push timers for the target DID only', async () => {
      const engine = new SyncEngineLevel({ db });
      const aliceTimer = setTimeout(() => {}, 60_000);
      const bobTimer = setTimeout(() => {}, 60_000);
      const aliceController = activateTestLink(engine, 'did:example:alice^https://dwn.example.com', 'did:example:alice');
      const bobController = activateTestLink(engine, 'did:example:bob^https://dwn.example.com', 'did:example:bob');
      aliceController.getOrCreatePushRuntime({ did: 'did:example:alice', dwnUrl: 'https://dwn.example.com' }).timer = aliceTimer;
      bobController.getOrCreatePushRuntime({ did: 'did:example:bob', dwnUrl: 'https://dwn.example.com' }).timer = bobTimer;

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(aliceController.pushRuntime).toBeUndefined();
      expect(bobController.pushRuntime).toBeDefined();

      clearTimeout(bobTimer);
    });

    it('removeIdentityFromLiveSync should clear repair attempts and retry timers for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      const aliceRetryTimer = setTimeout(() => {}, 60_000);
      const bobRetryTimer = setTimeout(() => {}, 60_000);
      const aliceController = activateTestLink(engine, 'did:example:alice^https://dwn.example.com^scope1', 'did:example:alice');
      const bobController = activateTestLink(engine, 'did:example:bob^https://dwn.example.com^scope1', 'did:example:bob');
      aliceController.incrementRepairAttempts();
      aliceController.incrementRepairAttempts();
      bobController.incrementRepairAttempts();
      aliceController.setRepairRetryTimer(aliceRetryTimer);
      bobController.setRepairRetryTimer(bobRetryTimer);

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(aliceController.isActive).toBe(false);
      expect(bobController.repairAttempts).toBe(1);
      expect(aliceController.repairRetryTimer).toBeUndefined();
      expect(bobController.repairRetryTimer).toBeDefined();

      clearTimeout(bobRetryTimer);
    });

    it('removeIdentityFromLiveSync should clear reconcile timers and in-flight ops for the target DID', async () => {
      const engine = new SyncEngineLevel({ db });
      const aliceReconcileTimer = setTimeout(() => {}, 60_000);
      const bobReconcileTimer = setTimeout(() => {}, 60_000);
      const aliceController = activateTestLink(engine, 'did:example:alice^https://dwn.example.com^scope1', 'did:example:alice');
      const bobController = activateTestLink(engine, 'did:example:bob^https://dwn.example.com^scope1', 'did:example:bob');
      aliceController.setReconcileTimer(aliceReconcileTimer, Date.now() + 60_000);
      bobController.setReconcileTimer(bobReconcileTimer, Date.now() + 60_000);
      aliceController.setReconcileInFlight(Promise.resolve());

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(aliceController.reconcileTimer).toBeUndefined();
      expect(aliceController.reconcileInFlight).toBeUndefined();
      expect(bobController.reconcileTimer).toBeDefined();
      expect((engine as any)._linkControllers.has(aliceController.linkKey)).toBe(false);

      clearTimeout(bobReconcileTimer);
    });

    it('removeIdentityFromLiveSync should be a safe no-op for a DID with no subscriptions or state', async () => {
      const engine = new SyncEngineLevel({ db });
      const bobController = activateTestLink(engine, 'did:example:bob^https://dwn.example.com', 'did:example:bob');
      bobController.setLiveSubscription({ close: sinon.stub() });
      bobController.setLocalSubscription({ close: sinon.stub() });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(bobController.hasLiveSubscription).toBe(true);
      expect(bobController.hasLocalSubscription).toBe(true);
    });

    it('removeIdentityFromLiveSync should continue even if subscription close throws', async () => {
      const engine = new SyncEngineLevel({ db });

      const closeThrows = sinon.stub().rejects(new Error('close boom'));
      const closeOk = sinon.stub().resolves();
      const first = activateTestLink(engine, 'did:example:alice^https://dwn1.example.com', 'did:example:alice', 'https://dwn1.example.com');
      const second = activateTestLink(engine, 'did:example:alice^https://dwn2.example.com', 'did:example:alice', 'https://dwn2.example.com');
      first.setLiveSubscription({ close: closeThrows });
      second.setLiveSubscription({ close: closeOk });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(closeThrows.calledOnce).toBe(true);
      expect(closeOk.calledOnce).toBe(true);
      expect((engine as any)._linkControllers.size).toBe(0);
    });

    it('removeIdentityFromLiveSync should remove all links for an identity with multiple endpoints', async () => {
      const engine = new SyncEngineLevel({ db });

      const close1 = sinon.stub().resolves();
      const close2 = sinon.stub().resolves();
      const first = activateTestLink(engine, 'did:example:alice^https://dwn1.example.com', 'did:example:alice', 'https://dwn1.example.com');
      const second = activateTestLink(engine, 'did:example:alice^https://dwn2.example.com', 'did:example:alice', 'https://dwn2.example.com');
      first.setLiveSubscription({ close: close1 });
      first.setLocalSubscription({ close: close1 });
      second.setLiveSubscription({ close: close2 });
      second.setLocalSubscription({ close: close2 });

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(close1.callCount).toBe(2);
      expect(close2.callCount).toBe(2);
      expect((engine as any)._linkControllers.size).toBe(0);
    });

    // --- addIdentityToLiveSync ---

    it('addIdentityToLiveSync should be a no-op when identity has no DWN endpoints', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves([]) },
      };
      (engine as any)._agent = mockAgent;

      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      const openPushStub = sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:no-endpoints', { protocols: [] });

      expect(openPullStub.called).toBe(false);
      expect(openPushStub.called).toBe(false);
    });

    it('addIdentityToLiveSync should create one protocol-set target when protocols are specified', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      const ledgerStub = sinon.stub().callsFake(async (params: any) => ({
        tenantDid          : 'did:example:proto',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-1',
        authorizationEpoch : params.authorizationEpoch,
        authorization      : params.authorization,
        scope              : params.scope,
        status             : 'initializing',
        pull               : {},
        connectivity       : 'unknown',
      }));
      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink : ledgerStub,
        setStatus       : sinon.stub().resolves(),
      }));
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:proto', {
        protocols: ['https://proto1.example', 'https://proto2.example'],
      });

      expect(ledgerStub.calledOnce).toBe(true);
      expect(ledgerStub.firstCall.args[0].scope).toEqual({
        kind      : 'protocolSet',
        protocols : ['https://proto1.example', 'https://proto2.example'],
      });
      expect(ledgerStub.firstCall.args[0].authorization).toEqual({ kind: 'owner' });
    });

    it('addIdentityToLiveSync should create a full-tenant link when protocols is all', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      const ledgerStub = sinon.stub().callsFake(async (params: any) => ({
        tenantDid          : 'did:example:full',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-full',
        authorizationEpoch : params.authorizationEpoch,
        authorization      : params.authorization,
        scope              : params.scope,
        status             : 'initializing',
        pull               : {},
        connectivity       : 'unknown',
      }));
      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink : ledgerStub,
        setStatus       : sinon.stub().resolves(),
      }));
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:full', { protocols: 'all' });

      expect(ledgerStub.calledOnce).toBe(true);
      expect(ledgerStub.firstCall.args[0].scope).toEqual({ kind: 'full' });
    });

    it('addIdentityToLiveSync should close pull subscription if push subscription fails', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => ({
          tenantDid          : 'did:example:pushfail',
          remoteEndpoint     : 'https://dwn.example.com',
          projectionId       : 'projection-1',
          authorizationEpoch : params.authorizationEpoch,
          authorization      : params.authorization,
          scope              : { kind: 'full' },
          status             : 'initializing',
          pull               : {},
          connectivity       : 'unknown',
        })),
        setStatus: sinon.stub().resolves(),
      }));

      const pullCloseSpy = sinon.stub().resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (target: any) => {
        (engine as any).getLinkController(target.linkKey).setLiveSubscription({ close: pullCloseSpy });
      });
      sinon.stub(engine as any, 'openLocalPushSubscription').rejects(new Error('push subscription boom'));

      await (engine as any).addIdentityToLiveSync('did:example:pushfail', { protocols: 'all' });

      expect(pullCloseSpy.calledOnce).toBe(true);
      expect([...((engine as any)._linkControllers.keys())].some(
        (key: string) => key.startsWith('did:example:pushfail^https://dwn.example.com^projection-1^')
      )).toBe(false);
    });

    it('addIdentityToLiveSync should schedule a Retry-After reattempt instead of failing permanently on a rate-limit', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => ({
          tenantDid          : 'did:example:ratelimited',
          remoteEndpoint     : 'https://dwn.example.com',
          projectionId       : 'projection-1',
          authorizationEpoch : params.authorizationEpoch,
          authorization      : params.authorization,
          scope              : { kind: 'full' },
          status             : 'initializing',
          pull               : {},
          connectivity       : 'unknown',
        })),
        setStatus: sinon.stub().resolves(),
      }));

      // The remote DWN rate-limits the MessagesSubscribe with a long Retry-After
      // so the reattempt does not fire during the assertions.
      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription').rejects(new RateLimitError(60));
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:ratelimited', { protocols: 'all' });

      // The half-open link is dropped, not left live...
      expect(engine.hasActiveSubscriptions).toBe(false);
      expect((engine as any)._linkControllers.size).toBe(0);
      // ...and exactly one Retry-After reattempt is scheduled.
      expect((engine as any)._linkInitRetryTimers.size).toBe(1);
      expect(openPullStub.calledOnce).toBe(true);

      // Cancel the pending timer so it does not fire against a torn-down engine.
      for (const timer of (engine as any)._linkInitRetryTimers.values()) {
        clearTimeout(timer);
      }
      (engine as any)._linkInitRetryTimers.clear();
    });

    it('addIdentityToLiveSync should establish live sync when the reattempt succeeds after the Retry-After window', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      sinon.stub(engine as any, 'ledger').get(() => ({
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => ({
          tenantDid          : 'did:example:ratelimited-recover',
          remoteEndpoint     : 'https://dwn.example.com',
          projectionId       : 'projection-1',
          authorizationEpoch : params.authorizationEpoch,
          authorization      : params.authorization,
          scope              : { kind: 'full' },
          status             : 'initializing',
          pull               : {},
          connectivity       : 'unknown',
        })),
        setStatus: sinon.stub().resolves(),
      }));

      // Rate-limited on the first attempt, succeeds on the scheduled reattempt.
      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription');
      openPullStub.onFirstCall().rejects(new RateLimitError(1));
      openPullStub.onSecondCall().resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:ratelimited-recover', { protocols: 'all' });
      expect((engine as any)._linkControllers.size).toBe(0);

      // Wait for the 1s Retry-After timer to fire and re-establish the link.
      await new Promise(resolve => setTimeout(resolve, 1400));

      expect(openPullStub.callCount).toBe(2);
      expect((engine as any)._linkControllers.size).toBe(1);
      expect((engine as any)._linkInitRetryTimers.size).toBe(0);
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
      const controller = activateTestLink(engine, 'k', 'did:example:a');
      controller.setLiveSubscription({ close: sinon.stub() });
      expect(engine.hasActiveSubscriptions).toBe(true);
    });

    it('should return false when only the integrity timer is active', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._runtime.armInterval('syncInterval', () => {}, 60_000);
      expect(engine.hasActiveSubscriptions).toBe(false);
      (engine as any)._runtime.dispose();
    });

    it('should return true when local push subscriptions are open', () => {
      const engine = new SyncEngineLevel({ db });
      const controller = activateTestLink(engine, 'k', 'did:example:a');
      controller.setLocalSubscription({ close: sinon.stub() });
      expect(engine.hasActiveSubscriptions).toBe(true);
    });

    it('should return false after all subscriptions are removed', () => {
      const engine = new SyncEngineLevel({ db });
      expect(engine.hasActiveSubscriptions).toBe(false);
    });

    it('should return false when only active links exist but no subscriptions', () => {
      const engine = new SyncEngineLevel({ db });
      activateTestLink(engine, 'some-key', 'did:example:a');
      expect(engine.hasActiveSubscriptions).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // updateIdentityOptions — live subscription refresh
  // ---------------------------------------------------------------------------

  describe('updateIdentityOptions — live subscription refresh', () => {
    it('should hot-remove and hot-add when updating options during live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:update1', options: { protocols: 'all' } });

      (engine as any)._syncMode = 'live';
      activateTestLink(engine, 'did:example:update1^https://dwn.example.com', 'did:example:update1');

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();
      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

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
      await engine.registerIdentity({ did: 'did:example:update-poll', options: { protocols: 'all' } });

      (engine as any)._syncMode = 'poll';

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();
      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.updateIdentityOptions({ did: 'did:example:update-poll', options: { protocols: ['https://new.example'] } });

      expect(hotRemoveStub.called).toBe(false);
      expect(hotAddStub.called).toBe(false);
    });

    it('should not hot-remove/add when identity has no active links (not yet syncing)', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:update-nolinks', options: { protocols: 'all' } });

      (engine as any)._syncMode = 'live';
      // No active links for this DID

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();
      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.updateIdentityOptions({ did: 'did:example:update-nolinks', options: { protocols: ['https://new.example'] } });

      expect(hotRemoveStub.called).toBe(false);
      expect(hotAddStub.called).toBe(false);
    });

    it('should persist new options even if not in live mode', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:persist-opts', options: { protocols: 'all' } });

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

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:after-last-removed', options: { protocols: 'all' } });

      // Hot-add should fire because _syncMode is 'live'.
      expect(hotAddStub.calledOnce).toBe(true);
    });

    it('hasActiveSubscriptions should return false after last identity removed', () => {
      const engine = new SyncEngineLevel({ db });
      // Timer left over from live mode, but no subscriptions.
      (engine as any)._runtime.armInterval('syncInterval', () => {}, 60_000);

      expect(engine.hasActiveSubscriptions).toBe(false);

      (engine as any)._runtime.dispose();
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

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:after-stop', options: { protocols: 'all' } });

      // _syncMode should have been reset by stopSync, so no hot-add.
      expect(hotAddStub.called).toBe(false);
    });

    it('should not hot-remove when sync was explicitly stopped', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:stop-then-unreg', options: { protocols: 'all' } });

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
    it('should discard the target DID controller with its in-flight repair', async () => {
      const engine = new SyncEngineLevel({ db });
      const aliceKey = 'did:example:alice^https://dwn.example.com^scope1';
      const bobKey = 'did:example:bob^https://dwn.example.com^scope1';
      const aliceController = activateTestLink(engine, aliceKey, 'did:example:alice');
      const bobController = activateTestLink(engine, bobKey, 'did:example:bob');
      aliceController.setRepairInFlight(Promise.resolve());
      const bobRepair = Promise.resolve();
      bobController.setRepairInFlight(bobRepair);

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._linkControllers.has(aliceKey)).toBe(false);
      expect((engine as any)._linkControllers.get(bobKey)?.repairInFlight).toBe(bobRepair);
    });

    it('should discard the target DID controller with its repair context', async () => {
      const engine = new SyncEngineLevel({ db });
      const aliceKey = 'did:example:alice^https://dwn.example.com^scope1';
      const bobKey = 'did:example:bob^https://dwn.example.com^scope1';
      const aliceController = activateTestLink(engine, aliceKey, 'did:example:alice');
      const bobController = activateTestLink(engine, bobKey, 'did:example:bob');
      aliceController.setRepairResumeToken({ epoch: 'epoch', position: '1', streamId: 'stream' });
      const bobToken = { epoch: 'epoch', position: '2', streamId: 'stream' };
      bobController.setRepairResumeToken(bobToken);

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._linkControllers.has(aliceKey)).toBe(false);
      expect((engine as any)._linkControllers.get(bobKey)?.repairResumeToken).toEqual(bobToken);
    });
  });
});
