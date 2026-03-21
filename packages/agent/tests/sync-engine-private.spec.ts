import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

describe('SyncEngineLevel — private methods', () => {
  let db: Level<string, string>;
  let syncEngine: SyncEngineLevel;

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-engine-private-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
    sinon.restore();
    // Clear timers that might have been set
    if ((syncEngine as any)._syncIntervalId) {
      clearInterval((syncEngine as any)._syncIntervalId);
      (syncEngine as any)._syncIntervalId = undefined;
    }
    if ((syncEngine as any)._pushDebounceTimer) {
      clearTimeout((syncEngine as any)._pushDebounceTimer);
      (syncEngine as any)._pushDebounceTimer = undefined;
    }
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  // ---------------------------------------------------------------------------
  // buildCursorKey
  // ---------------------------------------------------------------------------

  describe('buildCursorKey', () => {
    it('should build key without protocol', () => {
      const key = (syncEngine as any).buildCursorKey('did:example:alice', 'https://dwn.example.com');
      expect(key).toBe('did:example:alice^https://dwn.example.com');
    });

    it('should build key with protocol', () => {
      const key = (syncEngine as any).buildCursorKey(
        'did:example:alice', 'https://dwn.example.com', 'https://proto.example.com',
      );
      expect(key).toBe('did:example:alice^https://dwn.example.com^https://proto.example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // getCursor / setCursor
  // ---------------------------------------------------------------------------

  describe('cursor persistence', () => {
    it('should return undefined when cursor does not exist', async () => {
      const cursor = await (syncEngine as any).getCursor('nonexistent-key');
      expect(cursor).toBeUndefined();
    });

    it('should persist and retrieve a cursor', async () => {
      await (syncEngine as any).setCursor('test-key', 'cursor-value-123');
      const cursor = await (syncEngine as any).getCursor('test-key');
      expect(cursor).toBe('cursor-value-123');
    });

    it('should rethrow non-LEVEL_NOT_FOUND errors from getCursor', async () => {
      const ioError = new Error('IO error') as Error & { code: string };
      ioError.code = 'LEVEL_IO_ERROR';
      const cursors = db.sublevel('syncCursors');
      sinon.stub(cursors, 'get').rejects(ioError);
      sinon.stub(db, 'sublevel').returns(cursors as any);

      await expect((syncEngine as any).getCursor('key')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // extractDataStream
  // ---------------------------------------------------------------------------

  describe('extractDataStream', () => {
    it('should return undefined for non-RecordsWrite events', () => {
      const event = { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } };
      expect((syncEngine as any).extractDataStream(event)).toBeUndefined();
    });

    it('should return data stream for RecordsWrite with data', () => {
      const mockStream = new ReadableStream();
      const event = {
        message : { descriptor: { interface: 'Records', method: 'Write' } },
        data    : mockStream,
      };
      expect((syncEngine as any).extractDataStream(event)).toBe(mockStream);
    });

    it('should return undefined for RecordsWrite without data', () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } };
      expect((syncEngine as any).extractDataStream(event)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // tryGetCidSync
  // ---------------------------------------------------------------------------

  describe('tryGetCidSync', () => {
    it('should return messageCid from message as synchronous fallback', () => {
      const message = { messageCid: 'cid-123', descriptor: {} };
      const result = (syncEngine as any).tryGetCidSync(message);
      expect(result).toBe('cid-123');
    });

    it('should return undefined when no messageCid and async not resolved', () => {
      const message = { descriptor: {} };
      const result = (syncEngine as any).tryGetCidSync(message);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getDefaultHashHex
  // ---------------------------------------------------------------------------

  describe('getDefaultHashHex', () => {
    it('should return hex-encoded default hash for depth 0', async () => {
      const engine = new SyncEngineLevel({ db });
      const hash = await (engine as any).getDefaultHashHex(0);
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });

    it('should return different hashes for different depths', async () => {
      const engine = new SyncEngineLevel({ db });
      const hash0 = await (engine as any).getDefaultHashHex(0);
      const hash1 = await (engine as any).getDefaultHashHex(1);
      expect(hash0).not.toBe(hash1);
    });

    it('should return empty string for depth beyond MAX_DIFF_DEPTH (16)', async () => {
      const engine = new SyncEngineLevel({ db });
      const hash = await (engine as any).getDefaultHashHex(17);
      expect(hash).toBe('');
    });

    it('should cache results after first call', async () => {
      const engine = new SyncEngineLevel({ db });
      expect((engine as any)._defaultHashHex).toBeUndefined();
      await (engine as any).getDefaultHashHex(0);
      expect((engine as any)._defaultHashHex).toBeDefined();
      // Second call should use cache
      const hash = await (engine as any).getDefaultHashHex(0);
      expect(typeof hash).toBe('string');
    });
  });

  // ---------------------------------------------------------------------------
  // getSyncPermissionGrantId
  // ---------------------------------------------------------------------------

  describe('getSyncPermissionGrantId', () => {
    it('should return undefined when no delegateDid', async () => {
      const result = await (syncEngine as any).getSyncPermissionGrantId('did:example:alice');
      expect(result).toBeUndefined();
    });

    it('should throw when permission fetch fails for a delegate DID', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      (engine as any)._permissionsApi = {
        getPermissionForRequest : sinon.stub().rejects(new Error('not found')),
        clear                   : sinon.stub(),
      };

      await expect(
        (engine as any).getSyncPermissionGrantId('did:example:alice', 'did:example:delegate')
      ).rejects.toThrow('not found');
    });

    it('should return grant ID when delegate permission is found', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      (engine as any)._permissionsApi = {
        getPermissionForRequest : sinon.stub().resolves({ grant: { id: 'grant-123' } }),
        clear                   : sinon.stub(),
      };

      const result = await (engine as any).getSyncPermissionGrantId('did:example:alice', 'did:example:delegate');
      expect(result).toBe('grant-123');
    });
  });

  // ---------------------------------------------------------------------------
  // getSyncTargets
  // ---------------------------------------------------------------------------

  describe('getSyncTargets', () => {
    it('should return empty array when no identities registered', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { getDwnEndpointUrlsForTarget: sinon.stub() },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toEqual([]);
    });

    it('should skip identities whose DID has no DWN endpoints', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves([]),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      await engine.registerIdentity({ did: 'did:example:no-endpoints' });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toEqual([]);
    });

    it('should produce one target per DWN URL when protocols is empty', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      await engine.registerIdentity({ did: 'did:example:alice', options: { protocols: [] } });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].did).toBe('did:example:alice');
      expect(targets[0].dwnUrl).toBe('https://dwn.example.com');
      expect(targets[0].protocol).toBeUndefined();
    });

    it('should produce one target per protocol per DWN URL', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      await engine.registerIdentity({
        did     : 'did:example:bob',
        options : { protocols: ['https://proto1.example.com', 'https://proto2.example.com'] },
      });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toHaveLength(2);
      expect(targets[0].protocol).toBe('https://proto1.example.com');
      expect(targets[1].protocol).toBe('https://proto2.example.com');
    });

    it('should include delegateDid from identity options', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      await engine.registerIdentity({
        did     : 'did:example:carol',
        options : { protocols: [], delegateDid: 'did:example:delegate' },
      });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].delegateDid).toBe('did:example:delegate');
    });

    it('should handle invalid JSON in identity options gracefully', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      // Manually write invalid JSON to the sublevel
      const identities = db.sublevel('registeredIdentities');
      await identities.put('did:example:broken', 'not-valid-json');

      const targets = await (engine as any).getSyncTargets();
      // Should fall back to { protocols: [] } and produce one target
      expect(targets).toHaveLength(1);
      expect(targets[0].did).toBe('did:example:broken');
    });
  });

  // ---------------------------------------------------------------------------
  // sync() — SMT tree comparison
  // ---------------------------------------------------------------------------

  describe('sync() — SMT tree comparison', () => {
    it('should skip targets where local root matches remote root', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').resolves('aabbcc');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('aabbcc');
      const diffStub = sinon.stub(engine as any, 'diffWithRemote');

      await engine.sync();

      expect(diffStub.called).toBe(false);
    });

    it('should walk tree diff and pull/push when roots differ', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').resolves('aabbcc');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('ddeeff');
      sinon.stub(engine as any, 'diffWithRemote').resolves({
        onlyLocal  : ['cid-local-1'],
        onlyRemote : [{ messageCid: 'cid-remote-1' }],
      });
      const pullStub = sinon.stub(engine as any, 'pullMessages').resolves();
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves();

      await engine.sync();

      expect(pullStub.calledOnce).toBe(true);
      expect(pushStub.calledOnce).toBe(true);
    });

    it('should only pull when direction is "pull"', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').resolves('aabbcc');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('ddeeff');
      sinon.stub(engine as any, 'diffWithRemote').resolves({
        onlyLocal  : ['cid-local-1'],
        onlyRemote : [{ messageCid: 'cid-remote-1' }],
      });
      const pullStub = sinon.stub(engine as any, 'pullMessages').resolves();
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves();

      await engine.sync('pull');

      expect(pullStub.calledOnce).toBe(true);
      expect(pushStub.called).toBe(false);
    });

    it('should only push when direction is "push"', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').resolves('aabbcc');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('ddeeff');
      sinon.stub(engine as any, 'diffWithRemote').resolves({
        onlyLocal  : ['cid-local-1'],
        onlyRemote : [{ messageCid: 'cid-remote-1' }],
      });
      const pullStub = sinon.stub(engine as any, 'pullMessages').resolves();
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves();

      await engine.sync('push');

      expect(pullStub.called).toBe(false);
      expect(pushStub.calledOnce).toBe(true);
    });

    it('should skip when diff has empty onlyRemote for pull', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').resolves('aabbcc');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('ddeeff');
      sinon.stub(engine as any, 'diffWithRemote').resolves({
        onlyLocal  : [],
        onlyRemote : [],
      });
      const pullStub = sinon.stub(engine as any, 'pullMessages').resolves();
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves();

      await engine.sync();

      expect(pullStub.called).toBe(false);
      expect(pushStub.called).toBe(false);
    });

    it('should skip remaining targets for a DWN URL that errored', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
        { did: 'did:example:2', dwnUrl: 'https://dwn.example.com' },
      ]);
      const getLocalRootStub = sinon.stub(engine as any, 'getLocalRoot').rejects(new Error('network error'));
      const consoleStub = sinon.stub(console, 'error');

      await engine.sync(); // should not throw

      // getLocalRoot should only be called once — second target has same errored dwnUrl
      expect(getLocalRootStub.calledOnce).toBe(true);
      expect(consoleStub.called).toBe(true);
    });

    it('should set connectivity to online after successful sync with targets', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').resolves('same');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('same');

      await engine.sync();

      expect(engine.connectivityState).toBe('online');
    });

    it('should increment consecutive failures and set offline on error', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      // Set initial state to online
      (engine as any)._connectivityState = 'online';

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').rejects(new Error('timeout'));
      sinon.stub(console, 'error');

      await engine.sync();

      expect((engine as any)._consecutiveFailures).toBe(1);
      expect(engine.connectivityState).toBe('offline');
    });

    it('should reset consecutive failures on success', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      (engine as any)._consecutiveFailures = 3;

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'getLocalRoot').resolves('same');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('same');

      await engine.sync();

      expect((engine as any)._consecutiveFailures).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // startSync / stopSync — poll mode
  // ---------------------------------------------------------------------------

  describe('startSync / stopSync — poll mode', () => {
    it('should start and stop poll mode sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();

      await engine.startSync({ mode: 'poll', interval: '100ms' });
      expect(syncStub.calledOnce).toBe(true); // immediate sync on start

      await engine.stopSync();
      expect((engine as any)._syncIntervalId).toBeUndefined();
    });

    it('should clear existing interval when starting new sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();

      await engine.startSync({ mode: 'poll', interval: '500ms' });
      expect(syncStub.calledOnce).toBe(true);

      // Start again — should clear previous interval
      await engine.startSync({ mode: 'poll', interval: '500ms' });
      expect(syncStub.calledTwice).toBe(true);

      await engine.stopSync();
    });
  });

  // ---------------------------------------------------------------------------
  // startSync / stopSync — live mode
  // ---------------------------------------------------------------------------

  describe('startSync / stopSync — live mode', () => {
    it('should start live mode with initial catch-up sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);

      await engine.startSync({ mode: 'live', interval: '500ms' });
      expect(syncStub.calledOnce).toBe(true); // initial catch-up
      expect((engine as any)._syncMode).toBe('live');

      await engine.stopSync();
    });

    it('should handle error during initial live sync catch-up', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').rejects(new Error('initial sync failed'));
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);
      const consoleStub = sinon.stub(console, 'error');

      await engine.startSync({ mode: 'live', interval: '500ms' });
      expect(consoleStub.called).toBe(true);

      await engine.stopSync();
    });

    it('should tear down previous live subscriptions when starting new sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const closeStub = sinon.stub().resolves();
      (engine as any)._liveSubscriptions = [{ did: 'did:1', dwnUrl: 'url', close: closeStub }];

      sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);

      await engine.startSync({ mode: 'poll', interval: '500ms' });

      expect(closeStub.calledOnce).toBe(true);
      expect((engine as any)._liveSubscriptions).toEqual([]);

      await engine.stopSync();
    });
  });

  // ---------------------------------------------------------------------------
  // teardownLiveSync
  // ---------------------------------------------------------------------------

  describe('teardownLiveSync', () => {
    it('should close all live and local subscriptions', async () => {
      const close1 = sinon.stub().resolves();
      const close2 = sinon.stub().resolves();
      const close3 = sinon.stub().resolves();

      (syncEngine as any)._liveSubscriptions = [
        { did: 'did:1', dwnUrl: 'url1', close: close1 },
      ];
      (syncEngine as any)._localSubscriptions = [
        { did: 'did:2', dwnUrl: 'url2', close: close2 },
        { did: 'did:3', dwnUrl: 'url3', close: close3 },
      ];

      await (syncEngine as any).teardownLiveSync();

      expect(close1.calledOnce).toBe(true);
      expect(close2.calledOnce).toBe(true);
      expect(close3.calledOnce).toBe(true);
      expect((syncEngine as any)._liveSubscriptions).toEqual([]);
      expect((syncEngine as any)._localSubscriptions).toEqual([]);
    });

    it('should handle errors during subscription close gracefully', async () => {
      (syncEngine as any)._liveSubscriptions = [
        { did: 'did:1', dwnUrl: 'url1', close: sinon.stub().rejects(new Error('fail')) },
      ];
      (syncEngine as any)._localSubscriptions = [
        { did: 'did:2', dwnUrl: 'url2', close: sinon.stub().rejects(new Error('fail2')) },
      ];

      // Should not throw
      await (syncEngine as any).teardownLiveSync();
      expect((syncEngine as any)._liveSubscriptions).toEqual([]);
      expect((syncEngine as any)._localSubscriptions).toEqual([]);
    });

    it('should clear push debounce timer and pending CIDs', async () => {
      (syncEngine as any)._pushDebounceTimer = setTimeout((): void => {}, 10000);
      (syncEngine as any)._pendingPushCids.set('key', { cids: ['cid1'] });
      (syncEngine as any)._liveSubscriptions = [];
      (syncEngine as any)._localSubscriptions = [];

      await (syncEngine as any).teardownLiveSync();

      expect((syncEngine as any)._pushDebounceTimer).toBeUndefined();
      expect((syncEngine as any)._pendingPushCids.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // openLivePullSubscription
  // ---------------------------------------------------------------------------

  describe('openLivePullSubscription', () => {
    it('should open a subscription and add it to _liveSubscriptions', async () => {
      const closeStub = sinon.stub().resolves();
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          sendRequest: sinon.stub().resolves({
            reply: {
              status       : { code: 200, detail: 'OK' },
              subscription : { close: closeStub },
            },
          }),
          node: { processMessage: sinon.stub().resolves({ status: { code: 202 } }) },
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect((engine as any)._liveSubscriptions.length).toBe(1);
      expect((engine as any)._connectivityState).toBe('online');

      // Cleanup
      (engine as any)._liveSubscriptions = [];
    });

    it('should not add subscription when reply status is not 200', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          sendRequest: sinon.stub().resolves({
            reply: {
              status       : { code: 500, detail: 'Error' },
              subscription : undefined,
            },
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);
      sinon.stub(console, 'error');

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect((engine as any)._liveSubscriptions.length).toBe(0);
    });

    it('should include protocol in subscription filters when provided', async () => {
      const sendRequestStub = sinon.stub().resolves({
        reply: {
          status       : { code: 200, detail: 'OK' },
          subscription : { close: sinon.stub().resolves() },
        },
      });
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { sendRequest: sendRequestStub },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).openLivePullSubscription({
        did      : 'did:example:alice',
        dwnUrl   : 'https://dwn.example.com',
        protocol : 'https://proto.example.com',
      });

      const callArgs = sendRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.filters).toEqual([{ protocol: 'https://proto.example.com' }]);

      (engine as any)._liveSubscriptions = [];
    });

    it('should use existing cursor when available', async () => {
      const sendRequestStub = sinon.stub().resolves({
        reply: {
          status       : { code: 200, detail: 'OK' },
          subscription : { close: sinon.stub().resolves() },
        },
      });
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { sendRequest: sendRequestStub },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      sinon.stub(engine as any, 'getCursor').resolves('saved-cursor-value');

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      const callArgs = sendRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.cursor).toBe('saved-cursor-value');

      (engine as any)._liveSubscriptions = [];
    });

    it('should look up delegate permission when delegateDid is provided', async () => {
      const permStub = sinon.stub().resolves({ grant: { id: 'sub-grant-1' } });
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          sendRequest: sinon.stub().resolves({
            reply: {
              status       : { code: 200, detail: 'OK' },
              subscription : { close: sinon.stub().resolves() },
            },
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = {
        getPermissionForRequest : permStub,
        clear                   : sinon.stub(),
      };
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).openLivePullSubscription({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        delegateDid : 'did:example:delegate',
      });

      expect(permStub.called).toBe(true);
      (engine as any)._liveSubscriptions = [];
    });

    it('should fall back to MessagesRead grant when MessagesSubscribe grant not found', async () => {
      const permStub = sinon.stub()
        .onFirstCall().rejects(new Error('no subscribe grant'))
        .onSecondCall().resolves({ grant: { id: 'read-grant-1' } });
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          sendRequest: sinon.stub().resolves({
            reply: {
              status       : { code: 200, detail: 'OK' },
              subscription : { close: sinon.stub().resolves() },
            },
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = {
        getPermissionForRequest : permStub,
        clear                   : sinon.stub(),
      };
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).openLivePullSubscription({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        delegateDid : 'did:example:delegate',
      });

      expect(permStub.callCount).toBe(2);
      (engine as any)._liveSubscriptions = [];
    });

    it('should throw when both permission grant lookups fail', async () => {
      const permStub = sinon.stub().rejects(new Error('no grant'));
      const sendRequestStub = sinon.stub();
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { sendRequest: sendRequestStub },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = {
        getPermissionForRequest : permStub,
        clear                   : sinon.stub(),
      };
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await expect(
        (engine as any).openLivePullSubscription({
          did         : 'did:example:alice',
          dwnUrl      : 'https://dwn.example.com',
          delegateDid : 'did:example:delegate',
        })
      ).rejects.toThrow('no grant');

      // sendRequest should not have been called since we threw
      expect(sendRequestStub.called).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // openLocalPushSubscription
  // ---------------------------------------------------------------------------

  describe('openLocalPushSubscription', () => {
    it('should open a local subscription and add it to _localSubscriptions', async () => {
      const closeStub = sinon.stub().resolves();
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            reply: {
              status       : { code: 200, detail: 'OK' },
              subscription : { close: closeStub },
            },
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect((engine as any)._localSubscriptions.length).toBe(1);

      // Cleanup
      (engine as any)._localSubscriptions = [];
    });

    it('should not add subscription when reply status is not 200', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            reply: {
              status       : { code: 500, detail: 'Error' },
              subscription : undefined,
            },
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      sinon.stub(console, 'error');

      await (engine as any).openLocalPushSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect((engine as any)._localSubscriptions.length).toBe(0);
    });

    it('should throw when delegate permission lookup fails', async () => {
      const permStub = sinon.stub().rejects(new Error('no grant'));
      const processRequestStub = sinon.stub();
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { processRequest: processRequestStub },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = {
        getPermissionForRequest : permStub,
        clear                   : sinon.stub(),
      };

      await expect(
        (engine as any).openLocalPushSubscription({
          did         : 'did:example:alice',
          dwnUrl      : 'https://dwn.example.com',
          delegateDid : 'did:example:delegate',
        })
      ).rejects.toThrow('no grant');

      expect(processRequestStub.called).toBe(false);
    });

    it('should include protocol in subscription filters when provided', async () => {
      const processRequestStub = sinon.stub().resolves({
        reply: {
          status       : { code: 200, detail: 'OK' },
          subscription : { close: sinon.stub().resolves() },
        },
      });
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { processRequest: processRequestStub },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription({
        did      : 'did:example:alice',
        dwnUrl   : 'https://dwn.example.com',
        protocol : 'https://proto.example.com',
      });

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.filters).toEqual([{ protocol: 'https://proto.example.com' }]);

      (engine as any)._localSubscriptions = [];
    });
  });

  // ---------------------------------------------------------------------------
  // flushPendingPushes
  // ---------------------------------------------------------------------------

  describe('flushPendingPushes', () => {
    it('should clear pending push CIDs after flushing', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._pendingPushCids.set('key1', {
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', cids: [],
      });

      await (engine as any).flushPendingPushes();

      expect((engine as any)._pendingPushCids.size).toBe(0);
      expect((engine as any)._pushDebounceTimer).toBeUndefined();
    });

    it('should skip entries with empty cids array', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      (engine as any)._pendingPushCids.set('key1', {
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', cids: [],
      });

      // Should not throw or call pushMessages
      await (engine as any).flushPendingPushes();
      expect((engine as any)._pendingPushCids.size).toBe(0);
    });

    it('should handle push errors gracefully', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
            },
          }),
        },
        rpc: { sendDwnRequest: sinon.stub().rejects(new Error('network error')) },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      (engine as any)._pendingPushCids.set('key1', {
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', cids: ['cid-1'],
      });

      const consoleStub = sinon.stub(console, 'error');

      // Should not throw — errors are caught
      await (engine as any).flushPendingPushes();
      expect(consoleStub.called).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getLocalRoot / getRemoteRoot
  // ---------------------------------------------------------------------------

  describe('getLocalRoot / getRemoteRoot', () => {
    it('getLocalRoot should query StateIndex directly for the root hash', async () => {
      // The local root method now accesses the StateIndex directly (no processMessage).
      const fakeHash = new Uint8Array(32);
      fakeHash[0] = 0xaa; fakeHash[1] = 0xbb;
      const mockStateIndex = {
        getRoot         : sinon.stub().resolves(fakeHash),
        getProtocolRoot : sinon.stub().resolves(fakeHash),
      };
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { node: { storage: { stateIndex: mockStateIndex } } },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      const root = await (engine as any).getLocalRoot('did:example:alice');

      expect(root).toBeTruthy();
      expect(mockStateIndex.getRoot.calledOnce).toBe(true);
      expect(mockStateIndex.getRoot.firstCall.args[0]).toBe('did:example:alice');
    });

    it('getLocalRoot should use getProtocolRoot when protocol is specified', async () => {
      const fakeHash = new Uint8Array(32);
      const mockStateIndex = {
        getRoot         : sinon.stub().resolves(fakeHash),
        getProtocolRoot : sinon.stub().resolves(fakeHash),
      };
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { node: { storage: { stateIndex: mockStateIndex } } },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      await (engine as any).getLocalRoot('did:example:alice', undefined, 'https://proto.example.com');

      expect(mockStateIndex.getProtocolRoot.calledOnce).toBe(true);
      expect(mockStateIndex.getProtocolRoot.firstCall.args[1]).toBe('https://proto.example.com');
    });

    it('getRemoteRoot should send to remote and return root hash', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            message : { descriptor: { action: 'root' } },
            reply   : { status: { code: 200 } },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            root   : 'remotehash',
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      const root = await (engine as any).getRemoteRoot('did:example:alice', 'https://dwn.example.com');
      expect(root).toBe('remotehash');
    });
  });

  // ---------------------------------------------------------------------------
  // getLocalSubtreeHash / getRemoteSubtreeHash / getLocalLeaves / getRemoteLeaves
  // ---------------------------------------------------------------------------

  describe('subtree hash and leaf methods', () => {
    it('getLocalSubtreeHash should query StateIndex directly', async () => {
      const fakeHash = new Uint8Array(32);
      fakeHash[0] = 0xab;
      const mockStateIndex = {
        getSubtreeHash         : sinon.stub().resolves(fakeHash),
        getProtocolSubtreeHash : sinon.stub().resolves(fakeHash),
      };
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { node: { storage: { stateIndex: mockStateIndex } } },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const hash = await (engine as any).getLocalSubtreeHash('did:example:alice', '01');
      expect(hash).toBeTruthy();
      expect(mockStateIndex.getSubtreeHash.calledOnce).toBe(true);
    });

    it('getLocalSubtreeHash should return default hash hex for empty subtree', async () => {
      // Empty subtrees return the default hash (all zeros at the leaf level)
      const emptyHash = new Uint8Array(32); // all zeros
      const mockStateIndex = {
        getSubtreeHash         : sinon.stub().resolves(emptyHash),
        getProtocolSubtreeHash : sinon.stub().resolves(emptyHash),
      };
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { node: { storage: { stateIndex: mockStateIndex } } },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const hash = await (engine as any).getLocalSubtreeHash('did:example:alice', '01');
      // The hash should be a hex string (even if it's the default/empty hash)
      expect(typeof hash).toBe('string');
    });

    it('getRemoteSubtreeHash should return hash from remote DWN', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            message : {},
            reply   : { status: { code: 200 } },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            hash   : 'subtree-hash-remote',
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const hash = await (engine as any).getRemoteSubtreeHash(
        'did:example:alice', 'https://dwn.example.com', '01',
      );
      expect(hash).toBe('subtree-hash-remote');
    });

    it('getLocalLeaves should query StateIndex directly and return CIDs', async () => {
      const mockStateIndex = {
        getLeaves         : sinon.stub().resolves(['cid-a', 'cid-b']),
        getProtocolLeaves : sinon.stub().resolves(['cid-a', 'cid-b']),
      };
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { node: { storage: { stateIndex: mockStateIndex } } },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const leaves = await (engine as any).getLocalLeaves('did:example:alice', '01');
      expect(leaves).toEqual(['cid-a', 'cid-b']);
      expect(mockStateIndex.getLeaves.calledOnce).toBe(true);
    });

    it('getLocalLeaves should return empty array when no entries', async () => {
      const mockStateIndex = {
        getLeaves         : sinon.stub().resolves([]),
        getProtocolLeaves : sinon.stub().resolves([]),
      };
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { node: { storage: { stateIndex: mockStateIndex } } },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const leaves = await (engine as any).getLocalLeaves('did:example:alice', '01');
      expect(leaves).toEqual([]);
    });

    it('getRemoteLeaves should return entries from remote DWN', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            message : {},
            reply   : { status: { code: 200 } },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200 },
            entries : ['cid-x', 'cid-y'],
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const leaves = await (engine as any).getRemoteLeaves(
        'did:example:alice', 'https://dwn.example.com', '01',
      );
      expect(leaves).toEqual(['cid-x', 'cid-y']);
    });
  });

  // ---------------------------------------------------------------------------
  // walkTreeDiff
  // ---------------------------------------------------------------------------

  describe('walkTreeDiff', () => {
    it('should return empty diff when all subtrees match', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      // All subtrees match
      sinon.stub(engine as any, 'getLocalSubtreeHash').resolves('same-hash');
      sinon.stub(engine as any, 'getRemoteSubtreeHash').resolves('same-hash');
      sinon.stub(engine as any, 'getSyncPermissionGrantId').resolves(undefined);

      const diff = await (engine as any).walkTreeDiff({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect(diff.onlyLocal).toEqual([]);
      expect(diff.onlyRemote).toEqual([]);
    });

    it('should enumerate leaves when reaching MAX_DIFF_DEPTH', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      // Root level differs, all intermediate levels differ, leaf level has different CIDs
      const localSubtreeStub = sinon.stub(engine as any, 'getLocalSubtreeHash');
      const remoteSubtreeStub = sinon.stub(engine as any, 'getRemoteSubtreeHash');
      const localLeavesStub = sinon.stub(engine as any, 'getLocalLeaves');
      const remoteLeavesStub = sinon.stub(engine as any, 'getRemoteLeaves');
      sinon.stub(engine as any, 'getSyncPermissionGrantId').resolves(undefined);

      // For all prefixes shorter than 16, return different hashes and non-default hashes
      localSubtreeStub.callsFake(async (_did: string, prefix: string): Promise<string> => {
        if (prefix.length >= 16) { return 'local-leaf-hash'; }
        // Only the leftmost child (all zeros) differs
        if (prefix === '' || prefix.split('').every((c: string): boolean => c === '0')) {
          return 'local-' + prefix;
        }
        return 'matching-' + prefix;
      });
      remoteSubtreeStub.callsFake(async (_did: string, _url: string, prefix: string): Promise<string> => {
        if (prefix.length >= 16) { return 'remote-leaf-hash'; }
        if (prefix === '' || prefix.split('').every((c: string): boolean => c === '0')) {
          return 'remote-' + prefix;
        }
        return 'matching-' + prefix;
      });

      // Override getDefaultHashHex to return a unique value that won't match
      sinon.stub(engine as any, 'getDefaultHashHex').resolves('default-empty');

      // At leaf level (prefix of length 16), return different CID sets
      localLeavesStub.resolves(['cid-local-only', 'cid-shared']);
      remoteLeavesStub.resolves(['cid-remote-only', 'cid-shared']);

      const diff = await (engine as any).walkTreeDiff({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect(diff.onlyLocal).toContain('cid-local-only');
      expect(diff.onlyRemote).toContain('cid-remote-only');
      // The shared CID should not appear in either
      expect(diff.onlyLocal).not.toContain('cid-shared');
      expect(diff.onlyRemote).not.toContain('cid-shared');
    });

    it('should short-circuit when remote is empty subtree', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };
      sinon.stub(engine as any, 'getSyncPermissionGrantId').resolves(undefined);

      // Remote returns default (empty) hash, local has data
      sinon.stub(engine as any, 'getLocalSubtreeHash').resolves('local-has-data');
      sinon.stub(engine as any, 'getRemoteSubtreeHash').resolves('default-empty');
      sinon.stub(engine as any, 'getDefaultHashHex').resolves('default-empty');
      sinon.stub(engine as any, 'getLocalLeaves').resolves(['cid-1', 'cid-2']);

      const diff = await (engine as any).walkTreeDiff({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect(diff.onlyLocal).toEqual(['cid-1', 'cid-2']);
      expect(diff.onlyRemote).toEqual([]);
    });

    it('should short-circuit when local is empty subtree', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };
      sinon.stub(engine as any, 'getSyncPermissionGrantId').resolves(undefined);

      // Local returns default (empty) hash, remote has data
      sinon.stub(engine as any, 'getLocalSubtreeHash').resolves('default-empty');
      sinon.stub(engine as any, 'getRemoteSubtreeHash').resolves('remote-has-data');
      sinon.stub(engine as any, 'getDefaultHashHex').resolves('default-empty');
      sinon.stub(engine as any, 'getRemoteLeaves').resolves(['cid-r1', 'cid-r2']);

      const diff = await (engine as any).walkTreeDiff({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect(diff.onlyLocal).toEqual([]);
      expect(diff.onlyRemote).toEqual(['cid-r1', 'cid-r2']);
    });
  });

  // ---------------------------------------------------------------------------
  // clear / close
  // ---------------------------------------------------------------------------

  describe('clear / close', () => {
    it('clear should clear permissionsApi and db', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const clearDb = new Level<string, string>('__TESTDATA__/sync-engine-clear-spec');
      const engine = new SyncEngineLevel({ db: clearDb, agent: mockAgent });
      (engine as any)._permissionsApi = { clear: sinon.stub().resolves() };

      await engine.registerIdentity({ did: 'did:example:test' });
      expect(await engine.getIdentityOptions('did:example:test')).toBeDefined();

      await engine.clear();
      expect(await engine.getIdentityOptions('did:example:test')).toBeUndefined();
      expect((engine as any)._permissionsApi.clear.calledOnce).toBe(true);

      await clearDb.close();
    });

    it('close should close the db', async () => {
      const closeDb = new Level<string, string>('__TESTDATA__/sync-engine-close-spec');
      const engine = new SyncEngineLevel({ db: closeDb });

      await engine.close();
      // After closing, operations should fail
      await expect(engine.registerIdentity({ did: 'did:example:after-close' })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // startPollSync — intervalSync closure
  // ---------------------------------------------------------------------------

  describe('startPollSync — intervalSync closure', () => {
    it('should execute intervalSync callback and apply backoff on failure', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      // Sync succeeds on first call (immediate), then fails on second (interval callback)
      let callCount = 0;
      sinon.stub(engine, 'sync').callsFake(async (): Promise<void> => {
        callCount++;
        if (callCount >= 2) {
          (engine as any)._consecutiveFailures = 2;
        }
      });

      await engine.startSync({ mode: 'poll', interval: '50ms' });

      // Wait for the interval to fire at least once
      await new Promise((resolve): void => { setTimeout(resolve, 150); });

      expect(callCount).toBeGreaterThanOrEqual(2);

      await engine.stopSync();
    });

    it('should skip intervalSync when syncLock is held', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();

      // Start poll with very short interval
      await engine.startSync({ mode: 'poll', interval: '50ms' });
      expect(syncStub.calledOnce).toBe(true);

      // Set lock — interval callbacks should skip
      (engine as any)._syncLock = true;

      // Wait for interval to fire
      await new Promise((resolve): void => { setTimeout(resolve, 100); });

      // sync should not have been called again while locked
      expect(syncStub.calledOnce).toBe(true);

      (engine as any)._syncLock = false;
      await engine.stopSync();
    });

    it('should handle sync error in intervalSync and continue', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const consoleStub = sinon.stub(console, 'error');
      // First call succeeds (immediate sync at line 377), second call fails (intervalSync closure)
      const syncStub = sinon.stub(engine, 'sync');
      syncStub.onFirstCall().resolves();
      syncStub.onSecondCall().rejects(new Error('sync failed'));
      syncStub.resolves(); // subsequent calls resolve

      await engine.startSync({ mode: 'poll', interval: '50ms' });

      // Wait for interval to fire and call the intervalSync closure
      await new Promise((resolve): void => { setTimeout(resolve, 150); });

      expect(consoleStub.called).toBe(true);

      await engine.stopSync();
    });
  });

  // ---------------------------------------------------------------------------
  // startLiveSync — integrityCheck closure
  // ---------------------------------------------------------------------------

  describe('startLiveSync — integrityCheck closure', () => {
    it('should execute integrityCheck interval and handle errors', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      let syncCallCount = 0;
      const consoleStub = sinon.stub(console, 'error');
      sinon.stub(engine, 'sync').callsFake(async (): Promise<void> => {
        syncCallCount++;
        // First call succeeds (initial catch-up), second fails (integrity check)
        if (syncCallCount >= 2) {
          throw new Error('integrity check failed');
        }
      });
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);

      await engine.startSync({ mode: 'live', interval: '50ms' });

      // Wait for integrity check interval
      await new Promise((resolve): void => { setTimeout(resolve, 150); });

      expect(syncCallCount).toBeGreaterThanOrEqual(2);
      expect(consoleStub.called).toBe(true);

      await engine.stopSync();
    });

    it('should skip integrityCheck when syncLock is held', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);

      await engine.startSync({ mode: 'live', interval: '50ms' });
      expect(syncStub.calledOnce).toBe(true); // initial catch-up

      // Set lock — integrity check should skip
      (engine as any)._syncLock = true;

      await new Promise((resolve): void => { setTimeout(resolve, 100); });

      expect(syncStub.calledOnce).toBe(true);

      (engine as any)._syncLock = false;
      await engine.stopSync();
    });
  });

  // ---------------------------------------------------------------------------
  // openLivePullSubscription — subscriptionHandler callback
  // ---------------------------------------------------------------------------

  describe('openLivePullSubscription — subscriptionHandler callback', () => {
    it('should process eose events by persisting cursor', async () => {
      let capturedHandler: any;
      const closeStub = sinon.stub().resolves();
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          sendRequest: sinon.stub().callsFake(async (params: any): Promise<any> => {
            capturedHandler = params.subscriptionHandler;
            return {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { close: closeStub },
              },
            };
          }),
          node: { processMessage: sinon.stub().resolves({ status: { code: 202 } }) },
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);
      const setCursorStub = sinon.stub(engine as any, 'setCursor').resolves();

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect(capturedHandler).toBeDefined();

      // Invoke with eose event
      await capturedHandler({ type: 'eose', cursor: 'eose-cursor-1' });

      expect(setCursorStub.calledOnce).toBe(true);
      expect(setCursorStub.firstCall.args[1]).toBe('eose-cursor-1');
      expect((engine as any)._connectivityState).toBe('online');

      (engine as any)._liveSubscriptions = [];
    });

    it('should process event messages by calling processMessage', async () => {
      let capturedHandler: any;
      const processMessageStub = sinon.stub().resolves({ status: { code: 202 } });
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          sendRequest: sinon.stub().callsFake(async (params: any): Promise<any> => {
            capturedHandler = params.subscriptionHandler;
            return {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { close: sinon.stub().resolves() },
              },
            };
          }),
          processRawMessage: processMessageStub,
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);
      const setCursorStub = sinon.stub(engine as any, 'setCursor').resolves();

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      // Invoke with event message (non-RecordsWrite)
      await capturedHandler({
        type   : 'event',
        cursor : 'event-cursor-1',
        event  : {
          message: { descriptor: { interface: 'Protocols', method: 'Configure' } },
        },
      });

      expect(processMessageStub.calledOnce).toBe(true);
      expect(setCursorStub.calledOnce).toBe(true);

      (engine as any)._liveSubscriptions = [];
    });

    it('should handle processMessage errors gracefully in event handler', async () => {
      let capturedHandler: any;
      const processMessageStub = sinon.stub().rejects(new Error('process failed'));
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          sendRequest: sinon.stub().callsFake(async (params: any): Promise<any> => {
            capturedHandler = params.subscriptionHandler;
            return {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { close: sinon.stub().resolves() },
              },
            };
          }),
          processRawMessage: processMessageStub,
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);
      sinon.stub(engine as any, 'setCursor').resolves();
      const consoleStub = sinon.stub(console, 'error');

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      await capturedHandler({
        type   : 'event',
        cursor : 'event-cursor-err',
        event  : { message: { descriptor: {} } },
      });

      expect(consoleStub.called).toBe(true);

      (engine as any)._liveSubscriptions = [];
    });
  });

  // ---------------------------------------------------------------------------
  // openLocalPushSubscription — subscriptionHandler callback
  // ---------------------------------------------------------------------------

  describe('openLocalPushSubscription — subscriptionHandler callback', () => {
    it('should accumulate CIDs and set debounce timer on event', async () => {
      let capturedHandler: any;
      const processRequestStub = sinon.stub().callsFake(async (params: any): Promise<any> => {
        capturedHandler = params.subscriptionHandler;
        return {
          reply: {
            status       : { code: 200, detail: 'OK' },
            subscription : { close: sinon.stub().resolves() },
          },
        };
      });
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { processRequest: processRequestStub },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect(capturedHandler).toBeDefined();

      // Invoke handler with an event that has a messageCid
      capturedHandler({
        type  : 'event',
        event : { message: { messageCid: 'cid-push-1', descriptor: {} } },
      });

      // Check that CID was accumulated in pending pushes
      const pendingMap = (engine as any)._pendingPushCids;
      expect(pendingMap.size).toBeGreaterThanOrEqual(1);

      // Check debounce timer was set
      expect((engine as any)._pushDebounceTimer).toBeDefined();

      // Cleanup
      if ((engine as any)._pushDebounceTimer) {
        clearTimeout((engine as any)._pushDebounceTimer);
        (engine as any)._pushDebounceTimer = undefined;
      }
      (engine as any)._pendingPushCids.clear();
      (engine as any)._localSubscriptions = [];
    });

    it('should skip non-event messages', async () => {
      let capturedHandler: any;
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().callsFake(async (params: any): Promise<any> => {
            capturedHandler = params.subscriptionHandler;
            return {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { close: sinon.stub().resolves() },
              },
            };
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      capturedHandler({ type: 'eose', cursor: 'some-cursor' });

      expect((engine as any)._pendingPushCids.size).toBe(0);

      (engine as any)._localSubscriptions = [];
    });

    it('should skip events where CID cannot be determined', async () => {
      let capturedHandler: any;
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().callsFake(async (params: any): Promise<any> => {
            capturedHandler = params.subscriptionHandler;
            return {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { close: sinon.stub().resolves() },
              },
            };
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      // Event with no messageCid and descriptor that won't sync-resolve
      capturedHandler({
        type  : 'event',
        event : { message: { descriptor: {} } },
      });

      // CID is undefined, so nothing should be accumulated
      expect((engine as any)._pendingPushCids.size).toBe(0);

      (engine as any)._localSubscriptions = [];
    });

    it('should clear and reset debounce timer on subsequent events', async () => {
      let capturedHandler: any;
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().callsFake(async (params: any): Promise<any> => {
            capturedHandler = params.subscriptionHandler;
            return {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { close: sinon.stub().resolves() },
              },
            };
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      // Send first event
      capturedHandler({
        type  : 'event',
        event : { message: { messageCid: 'cid-a', descriptor: {} } },
      });
      const _firstTimer = (engine as any)._pushDebounceTimer;

      // Send second event — should reset timer
      capturedHandler({
        type  : 'event',
        event : { message: { messageCid: 'cid-b', descriptor: {} } },
      });

      // Timer reference may have changed (cleared and reset)
      expect((engine as any)._pushDebounceTimer).toBeDefined();

      // Cleanup
      if ((engine as any)._pushDebounceTimer) {
        clearTimeout((engine as any)._pushDebounceTimer);
        (engine as any)._pushDebounceTimer = undefined;
      }
      (engine as any)._pendingPushCids.clear();
      (engine as any)._localSubscriptions = [];
    });
  });

  // ---------------------------------------------------------------------------
  // pullMessages / pushMessages delegate wrappers
  // ---------------------------------------------------------------------------

  describe('pullMessages / pushMessages delegate wrappers', () => {
    it('pullMessages should delegate to sync-messages pullMessages', async () => {
      const mockAgent = {
        agentDid          : 'did:example:agent',
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        dwn               : {
          processRawMessage: sinon.stub().resolves({ status: { code: 202 } }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
          }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      // Should not throw
      await (engine as any).pullMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
      });

      expect(mockAgent.dwn.processRawMessage.called).toBe(true);
    });

    it('pushMessages should delegate to sync-messages pushMessages', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({ status: { code: 202 } }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      await (engine as any).pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
      });

      expect(mockAgent.rpc.sendDwnRequest.called).toBe(true);
    });
  });
});
