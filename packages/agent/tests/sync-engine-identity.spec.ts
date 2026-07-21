import sinon from 'sinon';

import { Level } from 'level';
import { RateLimitError } from '@enbox/dwn-clients';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRuntime } from '../src/sync-runtime.js';
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
      const initialTopologyGeneration = internal._targetPlanner.topologyGeneration;
      const mockAgent = { agentDid: 'did:example:agent' } as any;

      engine.agent = mockAgent;

      expect(engine.agent).toBe(mockAgent);
      expect(internal.targetResolver).not.toBe(initialResolver);
      expect(internal._targetPlanner.topologyGeneration).toBe(initialTopologyGeneration + 1);
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
      (engine as any)._runtime = new SyncRuntime(true);

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:hotadd1', options: { protocols: ['https://proto.example'] } });

      expect(hotAddStub.calledOnce).toBe(true);
      expect(hotAddStub.firstCall.args[0]).toBe('did:example:hotadd1');
      expect(hotAddStub.firstCall.args[1]).toEqual({ protocols: ['https://proto.example'] });
    });

    it('should pass options to addIdentityToLiveSync when protocols is all', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._runtime = new SyncRuntime(true);

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:hotadd-default', options: { protocols: 'all' } });

      expect(hotAddStub.calledOnce).toBe(true);
      expect(hotAddStub.firstCall.args[1]).toEqual({ protocols: 'all' });
    });

    it('should not call addIdentityToLiveSync when live sync is not running', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._runtime = new SyncRuntime();

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:nohot-idle', options: { protocols: 'all' } });

      expect(hotAddStub.called).toBe(false);
    });

    it('should call addIdentityToLiveSync when live mode has no active subscriptions (e.g. after last identity removed)', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._runtime = new SyncRuntime(true);

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:hot-after-removal', options: { protocols: 'all' } });

      // Hot-add should fire because the runtime mode is 'live', even with zero
      // existing subscriptions. This handles the case where the last
      // identity was removed and a new one is added.
      expect(hotAddStub.calledOnce).toBe(true);
    });

    it('should still persist identity even if addIdentityToLiveSync throws', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._runtime = new SyncRuntime(true);

      sinon.stub(engine as any, 'addIdentityToLiveSync').rejects(new Error('hot-add boom'));

      await expect(
        engine.registerIdentity({ did: 'did:example:hotadd-fail', options: { protocols: 'all' } })
      ).rejects.toThrow('hot-add boom');

      // The identity should still be persisted because the put happens before hot-add.
      const options = await engine.getIdentityOptions('did:example:hotadd-fail');
      expect(options).toBeDefined();
      expect(options!.protocols).toBe('all');
    });

    it('should resolve registerIdentity and keep the identity when hot-add discovery fails', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._runtime = new SyncRuntime(true);

      // DID endpoint discovery is transiently unavailable during the
      // hot-add: planning is best-effort, so a registration that has
      // already persisted must resolve rather than reject — the settle
      // check re-initializes the missing links later.
      sinon.stub((engine as any).targetResolver, 'getEndpointUrls').rejects(new Error('endpoint discovery unavailable'));
      const consoleErrorStub = sinon.stub(console, 'error');

      await engine.registerIdentity({ did: 'did:example:hotadd-discovery-fail', options: { protocols: 'all' } });

      const options = await engine.getIdentityOptions('did:example:hotadd-discovery-fail');
      expect(options).toBeDefined();
      expect(options!.protocols).toBe('all');
      expect(consoleErrorStub.calledOnce).toBe(true);
    });

    it('should serialize unregisterIdentity behind an in-flight settle re-initialization', async () => {
      const engine = new SyncEngineLevel({ db });
      const did = 'did:example:settle-unregister-race';
      await engine.registerIdentity({ did, options: { protocols: 'all' } });
      (engine as any)._runtime = new SyncRuntime(true);

      const target = {
        did,
        dwnUrl             : 'https://dwn.example.com',
        scope              : { kind: 'full' },
        authorization      : { kind: 'owner' },
        authorizationEpoch : 'owner-epoch',
        projectionId       : 'projection-id',
      };
      sinon.stub((engine as any)._runCoordinator, 'settle').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      sinon.stub(engine as any, 'openLinkSubscriptions').resolves('readyForLive');
      sinon.stub(engine as any, 'establishLinkBaseline').resolves();
      sinon.stub(engine as any, 'markLinkLive').resolves();

      // Park the settle re-initialization inside link storage.
      let releaseLinkStorage!: () => void;
      const linkStorageGate = new Promise<void>((resolve) => { releaseLinkStorage = resolve; });
      let reachedLinkStorage!: () => void;
      const linkStorageReached = new Promise<void>((resolve) => { reachedLinkStorage = resolve; });
      sinon.stub(engine as any, 'getOrCreateReplicationLink').callsFake(async (): Promise<any> => {
        reachedLinkStorage();
        await linkStorageGate;
        return {
          tenantDid          : did,
          remoteEndpoint     : 'https://dwn.example.com',
          projectionId       : 'projection-id',
          authorizationEpoch : 'owner-epoch',
          scope              : { kind: 'full' },
          authorization      : { kind: 'owner' },
          status             : 'initializing',
          connectivity       : 'unknown',
          pull               : {},
          push               : {},
        };
      });

      const settlePass = (engine as any).runSettleCheck((engine as any)._runtime);
      await linkStorageReached;

      // The re-initialization holds the exclusive sync lock, so the
      // unregister cannot complete mid-initialization and be resurrected.
      let unregisterSettled = false;
      const unregisterPromise = engine.unregisterIdentity(did).then((): void => { unregisterSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unregisterSettled).toBe(false);

      releaseLinkStorage();
      await settlePass;
      await unregisterPromise;

      // The unregister ran after the pass: no controller or subscription
      // survives, and the identity stays deleted.
      expect(unregisterSettled).toBe(true);
      expect((engine as any)._linkControllers.size).toBe(0);
      expect(await engine.getIdentityOptions(did)).toBeUndefined();
    });

    it('should rebuild only the new scope when updateIdentityOptions races a settle re-initialization', async () => {
      const engine = new SyncEngineLevel({ db });
      const did = 'did:example:settle-update-race';
      await engine.registerIdentity({ did, options: { protocols: ['https://old.example/proto'] } });
      (engine as any)._runtime = new SyncRuntime(true);

      const oldTarget = {
        did,
        dwnUrl             : 'https://dwn.example.com',
        scope              : { kind: 'protocols', protocols: ['https://old.example/proto'] },
        authorization      : { kind: 'owner' },
        authorizationEpoch : 'owner-epoch',
        projectionId       : 'projection-old',
      };
      const newTarget = {
        did,
        dwnUrl             : 'https://dwn.example.com',
        scope              : { kind: 'protocols', protocols: ['https://new.example/proto'] },
        authorization      : { kind: 'owner' },
        authorizationEpoch : 'owner-epoch',
        projectionId       : 'projection-new',
      };
      sinon.stub((engine as any)._runCoordinator, 'settle').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([oldTarget]);
      sinon.stub(engine as any, 'openLinkSubscriptions').resolves('readyForLive');
      sinon.stub(engine as any, 'establishLinkBaseline').resolves();
      sinon.stub(engine as any, 'markLinkLive').resolves();
      sinon.stub((engine as any).targetResolver, 'getEndpointUrls').resolves(['https://dwn.example.com']);
      sinon.stub((engine as any).targetResolver, 'buildTargetsForEndpoint').resolves([newTarget]);

      // Gate only the settle pass's link-storage read; the rebuild's later
      // reads resolve immediately.
      let releaseLinkStorage!: () => void;
      const linkStorageGate = new Promise<void>((resolve) => { releaseLinkStorage = resolve; });
      let reachedLinkStorage!: () => void;
      const linkStorageReached = new Promise<void>((resolve) => { reachedLinkStorage = resolve; });
      let firstLinkRead = true;
      sinon.stub(engine as any, 'getOrCreateReplicationLink').callsFake(async (requested: any): Promise<any> => {
        if (firstLinkRead) {
          firstLinkRead = false;
          reachedLinkStorage();
          await linkStorageGate;
        }
        return {
          tenantDid          : requested.did,
          remoteEndpoint     : requested.dwnUrl,
          projectionId       : requested.projectionId,
          authorizationEpoch : requested.authorizationEpoch,
          scope              : requested.scope,
          authorization      : requested.authorization,
          status             : 'initializing',
          connectivity       : 'unknown',
          pull               : {},
          push               : {},
        };
      });

      const settlePass = (engine as any).runSettleCheck((engine as any)._runtime);
      await linkStorageReached;

      let updateSettled = false;
      const updatePromise = engine
        .updateIdentityOptions({ did, options: { protocols: ['https://new.example/proto'] } })
        .then((): void => { updateSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(updateSettled).toBe(false);

      releaseLinkStorage();
      await settlePass;
      await updatePromise;

      // The update's stop-and-rebuild ran after the pass: only the new
      // scope's link remains.
      const controllerKeys = [...(engine as any)._linkControllers.keys()];
      expect(controllerKeys).toHaveLength(1);
      expect(controllerKeys[0]).toContain('projection-new');
    });

    // --- unregisterIdentity hot-remove triggers ---

    it('should call removeIdentityFromLiveSync when unregistering during active live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:hotrem1', options: { protocols: 'all' } });

      (engine as any)._runtime = new SyncRuntime(true);

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:hotrem1');

      expect(hotRemoveStub.calledOnce).toBe(true);
      expect(hotRemoveStub.firstCall.args[0]).toBe('did:example:hotrem1');
    });

    it('should not call removeIdentityFromLiveSync when live sync is not running', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:nohotrem-idle', options: { protocols: 'all' } });

      (engine as any)._runtime = new SyncRuntime();

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:nohotrem-idle');

      expect(hotRemoveStub.called).toBe(false);
    });

    it('should still throw when unregistering a non-registered identity during live sync', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._runtime = new SyncRuntime(true);

      await expect(
        engine.unregisterIdentity('did:example:never-registered-live')
      ).rejects.toThrow('is not registered');
    });

    // --- pending init-retry cancellation on identity mutations ---
    // The 429 path drops the link controller before arming the Retry-After
    // timer, so an identity mutation can find no active links and skip the
    // live-link rebuild entirely. The pending retry captured the superseded
    // target (old scope, old authorization epoch); it must be cancelled
    // unconditionally, not only when links are rebuilt.

    it('updateIdentityOptions should cancel a pending init retry even without an active link', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const engine = new SyncEngineLevel({ db });
        await engine.registerIdentity({ did: 'did:example:staleretry', options: { protocols: 'all' } });

        const initialize = sinon.stub(engine as any, 'initializeLinkTarget').resolves({ status: 'active' });
        const linkKey = 'did:example:staleretry^https://dwn.example.com^projection-1^epoch-1';
        (engine as any).scheduleLinkInitRetry({ did: 'did:example:staleretry' }, linkKey, 60_000);
        expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:'))).toBe(true);

        await engine.updateIdentityOptions({ did: 'did:example:staleretry', options: { protocols: 'all' } });

        expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:'))).toBe(false);
        await clock.tickAsync(120_000);
        expect(initialize.called).toBe(false);
      } finally {
        clock.restore();
      }
    });

    it('updateIdentityOptions should initialize replacement live targets after cancelling a pending retry', async () => {
      const engine = new SyncEngineLevel({ db });
      const did = 'did:example:replacementretry';
      await engine.registerIdentity({ did, options: { protocols: 'all' } });
      (engine as any)._runtime = new SyncRuntime(true);

      const initializeReplacement = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());
      const linkKey = `${did}^https://dwn.example.com^projection-1^epoch-1`;
      (engine as any).scheduleLinkInitRetry({ did }, linkKey, 60_000);

      const options = { protocols: ['https://new.example'] };
      await engine.updateIdentityOptions({ did, options });

      expect((engine as any)._runtime.hasTimers((key: string) => key === `linkInitRetry:${linkKey}`)).toBe(false);
      expect(initializeReplacement.calledOnceWith(did, options)).toBe(true);
      (engine as any)._runtime.dispose();
    });

    it('unregisterIdentity should cancel a pending init retry even without an active link', async () => {
      const clock = sinon.useFakeTimers();
      try {
        const engine = new SyncEngineLevel({ db });
        await engine.registerIdentity({ did: 'did:example:staleretry2', options: { protocols: 'all' } });

        const initialize = sinon.stub(engine as any, 'initializeLinkTarget').resolves({ status: 'active' });
        const linkKey = 'did:example:staleretry2^https://dwn.example.com^projection-1^epoch-1';
        (engine as any).scheduleLinkInitRetry({ did: 'did:example:staleretry2' }, linkKey, 60_000);
        expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:'))).toBe(true);

        await engine.unregisterIdentity('did:example:staleretry2');

        expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:'))).toBe(false);
        await clock.tickAsync(120_000);
        expect(initialize.called).toBe(false);
      } finally {
        clock.restore();
      }
    });

    it('updateIdentityOptions should drain an already-started init retry before starting replacement targets', async () => {
      const engine = new SyncEngineLevel({ db });
      const did = 'did:example:startedretry';
      await engine.registerIdentity({ did, options: { protocols: 'all' } });
      (engine as any)._runtime = new SyncRuntime(true);

      let releaseRetry!: () => void;
      const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
      const events: string[] = [];
      const initialize = sinon.stub(engine as any, 'initializeLinkTarget').callsFake(async (): Promise<{ status: string }> => {
        await retryGate;
        events.push('stale-retry-finished');
        return { status: 'failed' };
      });
      const initializeReplacement = sinon.stub(engine as any, 'addIdentityToLiveSync').callsFake(async (): Promise<Set<string>> => {
        events.push('replacement-started');
        return new Set();
      });

      // Replicate a Retry-After timer that fired BEFORE the update started:
      // the timer key is already unarmed and the retry task is in flight in
      // the identity task group, exactly as scheduleLinkInitRetry enqueues it.
      const taskGroup = (engine as any)._lifecycle.getIdentityTaskGroup(did);
      void (engine as any)._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => {
        try {
          await initialize({ did });
        } catch {
          // Mirrors scheduleLinkInitRetry's callback.
        }
      });

      const options = { protocols: ['https://replacement.example'] };
      const updatePromise = engine.updateIdentityOptions({ did, options })
        .then((): void => { events.push('update-done'); });

      // The update must block on the in-flight retry, not complete around it
      // and let the stale target activate afterwards.
      const updateFinishedEarly = await Promise.race([
        updatePromise.then((): boolean => true),
        new Promise<boolean>((resolve) => setTimeout((): void => { resolve(false); }, 50)),
      ]);
      expect(updateFinishedEarly).toBe(false);

      releaseRetry();
      await updatePromise;
      expect(events).toEqual(['stale-retry-finished', 'replacement-started', 'update-done']);
      expect(initializeReplacement.calledOnceWith(did, options)).toBe(true);

      // The superseded group was paused for the drain and then discarded:
      // late work enqueued on it is dropped, while the identity's future
      // work runs on a fresh, accepting group.
      let lateRan = false;
      await (engine as any)._lifecycle.runIdentityTask(taskGroup, async (): Promise<void> => { lateRan = true; });
      expect(lateRan).toBe(false);

      const freshGroup = (engine as any)._lifecycle.getIdentityTaskGroup(did);
      expect(freshGroup).not.toBe(taskGroup);
      let freshRan = false;
      await (engine as any)._lifecycle.runIdentityTask(freshGroup, async (): Promise<void> => { freshRan = true; });
      expect(freshRan).toBe(true);
    });

    it('cancelLinkInitRetriesForDid should not cancel a retry for a DID that merely extends the mutated DID', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any).scheduleLinkInitRetry(
        { did: 'did:example:alice' },
        'did:example:alice^https://dwn.example.com^projection-1^epoch-1',
        60_000,
      );
      // Underscores are valid DID characters: this is a DIFFERENT identity
      // whose DID happens to extend the one being mutated.
      (engine as any).scheduleLinkInitRetry(
        { did: 'did:example:alice_extra' },
        'did:example:alice_extra^https://dwn.example.com^projection-1^epoch-1',
        60_000,
      );

      (engine as any).cancelLinkInitRetriesForDid('did:example:alice');

      expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:did:example:alice^'))).toBe(false);
      expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:did:example:alice_extra^'))).toBe(true);

      (engine as any)._runtime.dispose();
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

    it('removeIdentityFromLiveSync should invalidate only the target DID directional replay', async () => {
      const engine = new SyncEngineLevel({ db });
      const aliceController = activateTestLink(engine, 'did:example:alice^https://dwn.example.com', 'did:example:alice');
      const bobController = activateTestLink(engine, 'did:example:bob^https://dwn.example.com', 'did:example:bob');
      const aliceReplay = aliceController.enqueueDirection('push', async (): Promise<string> => 'alice');
      const bobReplay = bobController.enqueueDirection('push', async (): Promise<string> => 'bob');

      expect(aliceController.getPendingDirectionCount('push')).toBe(1);
      expect(bobController.getPendingDirectionCount('push')).toBe(1);

      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect(await aliceReplay).toBeUndefined();
      expect(aliceController.isActive).toBe(false);
      expect(bobController.isActive).toBe(true);
      expect(bobController.getPendingDirectionCount('push')).toBe(1);

      bobController.markReplicationReady();
      expect(await bobReplay).toBe('bob');
      expect(bobController.getPendingDirectionCount('push')).toBe(0);
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
      let releaseBlocker!: () => void;
      let blockerStarted!: () => void;
      const blockerStartedGate = new Promise<void>((resolve) => { blockerStarted = resolve; });
      const blocker = aliceController.enqueue(async (): Promise<void> => {
        blockerStarted();
        await new Promise<void>((resolve) => { releaseBlocker = resolve; });
      });
      let queuedReconcileRan = false;
      const queuedReconcile = aliceController.enqueueShared('reconcile', async (): Promise<void> => {
        queuedReconcileRan = true;
      });

      await blockerStartedGate;
      await (engine as any).removeIdentityFromLiveSync('did:example:alice');
      releaseBlocker();
      await Promise.all([blocker, queuedReconcile]);

      expect(aliceController.reconcileTimer).toBeUndefined();
      expect(queuedReconcileRan).toBe(false);
      expect(aliceController.isMailboxBusy('reconcile')).toBe(false);
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

      const getOrCreateLinkStub = sinon.stub().callsFake(async (params: any) => ({
        tenantDid          : 'did:example:proto',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-1',
        authorizationEpoch : params.authorizationEpoch,
        authorization      : params.authorization,
        scope              : params.scope,
        status             : 'initializing',
        pull               : {},
        push               : {},
        connectivity       : 'unknown',
      }));
      sinon.stub(engine as any, 'replicationLinkStore').get(() => ({
        getOrCreateLink : getOrCreateLinkStub,
        setStatus       : sinon.stub().resolves(),
      }));
      sinon.stub(engine as any, 'openLivePullSubscription').resolves(true);
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves(true);
      sinon.stub(engine as any, 'establishLinkBaseline').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:proto', {
        protocols: ['https://proto1.example', 'https://proto2.example'],
      });

      expect(getOrCreateLinkStub.calledOnce).toBe(true);
      expect(getOrCreateLinkStub.firstCall.args[0].scope).toEqual({
        kind      : 'protocolSet',
        protocols : ['https://proto1.example', 'https://proto2.example'],
      });
      expect(getOrCreateLinkStub.firstCall.args[0].authorization).toEqual({ kind: 'owner' });
    });

    it('addIdentityToLiveSync should create a full-tenant link when protocols is all', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      const getOrCreateLinkStub = sinon.stub().callsFake(async (params: any) => ({
        tenantDid          : 'did:example:full',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-full',
        authorizationEpoch : params.authorizationEpoch,
        authorization      : params.authorization,
        scope              : params.scope,
        status             : 'initializing',
        pull               : {},
        push               : {},
        connectivity       : 'unknown',
      }));
      sinon.stub(engine as any, 'replicationLinkStore').get(() => ({
        getOrCreateLink : getOrCreateLinkStub,
        setStatus       : sinon.stub().resolves(),
      }));
      sinon.stub(engine as any, 'openLivePullSubscription').resolves(true);
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves(true);
      sinon.stub(engine as any, 'establishLinkBaseline').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:full', { protocols: 'all' });

      expect(getOrCreateLinkStub.calledOnce).toBe(true);
      expect(getOrCreateLinkStub.firstCall.args[0].scope).toEqual({ kind: 'full' });
    });

    it('addIdentityToLiveSync should close pull subscription if push subscription fails', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      sinon.stub(engine as any, 'replicationLinkStore').get(() => ({
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => ({
          tenantDid          : 'did:example:pushfail',
          remoteEndpoint     : 'https://dwn.example.com',
          projectionId       : 'projection-1',
          authorizationEpoch : params.authorizationEpoch,
          authorization      : params.authorization,
          scope              : { kind: 'full' },
          status             : 'initializing',
          pull               : {},
          push               : {},
          connectivity       : 'unknown',
        })),
        setStatus: sinon.stub().resolves(),
      }));

      const pullCloseSpy = sinon.stub().resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (target: any) => {
        (engine as any).getLinkController(target.linkKey).setLiveSubscription({ close: pullCloseSpy });
        return true;
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

      sinon.stub(engine as any, 'replicationLinkStore').get(() => ({
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => ({
          tenantDid          : 'did:example:ratelimited',
          remoteEndpoint     : 'https://dwn.example.com',
          projectionId       : 'projection-1',
          authorizationEpoch : params.authorizationEpoch,
          authorization      : params.authorization,
          scope              : { kind: 'full' },
          status             : 'initializing',
          pull               : {},
          push               : {},
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
      // ...and a Retry-After reattempt is scheduled (arming replaces any
      // pending timer for the key, so a 429 burst coalesces to one).
      expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:'))).toBe(true);
      expect(openPullStub.calledOnce).toBe(true);

      // Cancel the pending timer so it does not fire against a torn-down engine.
      (engine as any)._runtime.cancelTimers((key: string) => key.startsWith('linkInitRetry:'));
    });

    it('addIdentityToLiveSync should establish live sync when the reattempt succeeds after the Retry-After window', async () => {
      const engine = new SyncEngineLevel({ db });
      const mockAgent = {
        dwn: { getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']) },
      };
      (engine as any)._agent = mockAgent;

      sinon.stub(engine as any, 'replicationLinkStore').get(() => ({
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => ({
          tenantDid          : 'did:example:ratelimited-recover',
          remoteEndpoint     : 'https://dwn.example.com',
          projectionId       : 'projection-1',
          authorizationEpoch : params.authorizationEpoch,
          authorization      : params.authorization,
          scope              : { kind: 'full' },
          status             : 'initializing',
          pull               : {},
          push               : {},
          connectivity       : 'unknown',
        })),
        setStatus: sinon.stub().resolves(),
      }));

      // Rate-limited on the first attempt, succeeds on the scheduled reattempt.
      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription');
      openPullStub.onFirstCall().rejects(new RateLimitError(1));
      openPullStub.onSecondCall().resolves(true);
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves(true);
      sinon.stub(engine as any, 'establishLinkBaseline').resolves();

      await (engine as any).addIdentityToLiveSync('did:example:ratelimited-recover', { protocols: 'all' });
      expect((engine as any)._linkControllers.size).toBe(0);

      // Wait for the 1s Retry-After timer to fire and re-establish the link.
      await new Promise(resolve => setTimeout(resolve, 1400));

      expect(openPullStub.callCount).toBe(2);
      expect((engine as any)._linkControllers.size).toBe(1);
      expect((engine as any)._runtime.hasTimers((key: string) => key.startsWith('linkInitRetry:'))).toBe(false);
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

      (engine as any)._runtime = new SyncRuntime(true);
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
      await engine.registerIdentity({ did: 'did:example:update-idle', options: { protocols: 'all' } });

      (engine as any)._runtime = new SyncRuntime();

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();
      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.updateIdentityOptions({ did: 'did:example:update-idle', options: { protocols: ['https://new.example'] } });

      expect(hotRemoveStub.called).toBe(false);
      expect(hotAddStub.called).toBe(false);
    });

    it('should not hot-remove/add when identity has no active links (not yet syncing)', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:update-nolinks', options: { protocols: 'all' } });

      (engine as any)._runtime = new SyncRuntime(true);
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
      (engine as any)._runtime = new SyncRuntime(true);

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:after-last-removed', options: { protocols: 'all' } });

      // Hot-add should fire because the runtime mode is 'live'.
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
  // stopSync disposes the runtime (mode undefined) — registerIdentity after stop must not hot-add
  // ---------------------------------------------------------------------------

  describe('registerIdentity after stopSync', () => {
    it('should not hot-add when sync was explicitly stopped', async () => {
      const engine = new SyncEngineLevel({ db });

      // Simulate a live sync session that was explicitly stopped.
      (engine as any)._runtime = new SyncRuntime(true);
      await engine.stopSync();

      const hotAddStub = sinon.stub(engine as any, 'addIdentityToLiveSync').resolves(new Set());

      await engine.registerIdentity({ did: 'did:example:after-stop', options: { protocols: 'all' } });

      // The runtime mode dies with stopSync's disposal, so no hot-add.
      expect(hotAddStub.called).toBe(false);
    });

    it('should not hot-remove when sync was explicitly stopped', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:stop-then-unreg', options: { protocols: 'all' } });

      (engine as any)._runtime = new SyncRuntime(true);
      await engine.stopSync();

      const hotRemoveStub = sinon.stub(engine as any, 'removeIdentityFromLiveSync').resolves();

      await engine.unregisterIdentity('did:example:stop-then-unreg');

      expect(hotRemoveStub.called).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // removeIdentityFromLiveSync clears in-flight repair state
  // ---------------------------------------------------------------------------

  describe('removeIdentityFromLiveSync — in-flight repair disposal', () => {
    it('should discard the target DID controller with its in-flight repair', async () => {
      const engine = new SyncEngineLevel({ db });
      const aliceKey = 'did:example:alice^https://dwn.example.com^scope1';
      const bobKey = 'did:example:bob^https://dwn.example.com^scope1';
      const aliceController = activateTestLink(engine, aliceKey, 'did:example:alice');
      const bobController = activateTestLink(engine, bobKey, 'did:example:bob');
      let releaseAlice!: () => void;
      let aliceStarted!: () => void;
      const aliceStartedGate = new Promise<void>((resolve) => { aliceStarted = resolve; });
      const aliceRepair = aliceController.enqueueShared('repair', async (): Promise<void> => {
        aliceStarted();
        await new Promise<void>((resolve) => { releaseAlice = resolve; });
      });
      let releaseBob!: () => void;
      let bobStarted!: () => void;
      const bobStartedGate = new Promise<void>((resolve) => { bobStarted = resolve; });
      const bobRepair = bobController.enqueueShared('repair', async (): Promise<void> => {
        bobStarted();
        await new Promise<void>((resolve) => { releaseBob = resolve; });
      });

      await Promise.all([aliceStartedGate, bobStartedGate]);
      await (engine as any).removeIdentityFromLiveSync('did:example:alice');

      expect((engine as any)._linkControllers.has(aliceKey)).toBe(false);
      const survivingBob = (engine as any)._linkControllers.get(bobKey);
      let joinedRan = false;
      expect(survivingBob.enqueueShared('repair', async (): Promise<void> => { joinedRan = true; })).toBe(bobRepair);

      releaseAlice();
      releaseBob();
      await Promise.all([aliceRepair, bobRepair]);
      expect(joinedRan).toBe(false);
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
