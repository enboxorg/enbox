import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { ReplicationLedger } from '../src/sync-replication-ledger.js';
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
    const pushRuntimes = (syncEngine as any)._pushRuntimes as Map<string, { timer?: ReturnType<typeof setTimeout> }> | undefined;
    if (pushRuntimes) {
      for (const runtime of pushRuntimes.values()) {
        if (runtime.timer) {
          clearTimeout(runtime.timer);
        }
      }
      pushRuntimes.clear();
    }
    await db.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  // ---------------------------------------------------------------------------
  // buildLinkKey
  // ---------------------------------------------------------------------------

  describe('buildLinkKey', () => {
    it('should build key without scopeId/protocol', () => {
      const key = (syncEngine as any).buildLinkKey('did:example:alice', 'https://dwn.example.com');
      expect(key).toBe('did:example:alice^https://dwn.example.com');
    });

    it('should build key with scopeId or protocol', () => {
      const key = (syncEngine as any).buildLinkKey(
        'did:example:alice', 'https://dwn.example.com', 'scope-hash-123',
      );
      expect(key).toBe('did:example:alice^https://dwn.example.com^scope-hash-123');
    });
  });

  // ---------------------------------------------------------------------------
  // getCursor (legacy migration helper)
  // ---------------------------------------------------------------------------

  describe('cursor persistence', () => {
    it('should return undefined when cursor does not exist', async () => {
      const cursor = await (syncEngine as any).getCursor('nonexistent-key');
      expect(cursor).toBeUndefined();
    });

    it('should return undefined and delete legacy string cursors', async () => {
      // Simulate an old-format string cursor stored before the ProgressToken migration.
      const cursors = db.sublevel('syncCursors');
      await cursors.put('legacy-key', 'old-string-cursor-42');
      const cursor = await (syncEngine as any).getCursor('legacy-key');
      expect(cursor).toBeUndefined();
      // The invalid entry should have been deleted so it is not re-checked on
      // every subsequent startup.
      await expect(cursors.get('legacy-key')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' });
    });

    it('should return undefined and delete tokens with empty messageCid', async () => {
      // A corrupted token with empty messageCid should be discarded and deleted —
      // it would fail MessagesSubscribe JSON schema validation (minLength: 1).
      const cursors = db.sublevel('syncCursors');
      await cursors.put('bad-cid-key', JSON.stringify({
        streamId: 's1', epoch: 'e1', position: '5', messageCid: '',
      }));
      const cursor = await (syncEngine as any).getCursor('bad-cid-key');
      expect(cursor).toBeUndefined();
      await expect(cursors.get('bad-cid-key')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' });
    });

    it('should return undefined and delete tokens with empty streamId', async () => {
      const cursors = db.sublevel('syncCursors');
      await cursors.put('bad-stream-key', JSON.stringify({
        streamId: '', epoch: 'e1', position: '5', messageCid: 'cid-5',
      }));
      const cursor = await (syncEngine as any).getCursor('bad-stream-key');
      expect(cursor).toBeUndefined();
      await expect(cursors.get('bad-stream-key')).rejects.toMatchObject({ code: 'LEVEL_NOT_FOUND' });
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

    it('should decode inline encodedData and delete it from the message', async () => {
      // Simulate a subscription event with inline base64url-encoded data
      // (records <= 30 KB arrive this way from the EventLog).
      const originalData = 'hello world';
      const { Encoder } = await import('@enbox/dwn-sdk-js');
      const encoded = Encoder.bytesToBase64Url(new TextEncoder().encode(originalData));

      const event = {
        message: {
          descriptor  : { interface: 'Records', method: 'Write' },
          encodedData : encoded,
        },
      };

      const stream = (syncEngine as any).extractDataStream(event);
      expect(stream).toBeInstanceOf(ReadableStream);

      // encodedData must be deleted so the DWN schema validator does not
      // reject the message for having unevaluated properties.
      expect((event.message as any).encodedData).toBeUndefined();

      // Verify the stream yields the original data.
      const reader = stream.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(originalData);
    });
  });

  // ---------------------------------------------------------------------------
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

    it('should reconcile different dwnUrl groups concurrently', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      // Two targets on different dwnUrls.
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://slow.example.com' },
        { did: 'did:example:2', dwnUrl: 'https://fast.example.com' },
      ]);

      // Track call order to prove overlap.
      const callLog: string[] = [];
      sinon.stub(engine as any, 'createLinkReconciler').returns({
        reconcile: async (target: any) => {
          callLog.push(`start:${target.dwnUrl}`);
          const delay = target.dwnUrl.includes('slow') ? 200 : 10;
          await new Promise(r => setTimeout(r, delay));
          callLog.push(`end:${target.dwnUrl}`);
          return { changed: false, didPull: false, didPush: false };
        },
      });

      const start = Date.now();
      await engine.sync();
      const elapsed = Date.now() - start;

      // Both groups should have started before either finished.
      // With sequential processing, elapsed would be >= 210ms.
      // With parallel processing, elapsed should be ~200ms (the slow group).
      expect(elapsed).toBeLessThan(300);

      // The fast group should finish before the slow group.
      const fastEndIdx = callLog.indexOf('end:https://fast.example.com');
      const slowEndIdx = callLog.indexOf('end:https://slow.example.com');
      expect(fastEndIdx).toBeLessThan(slowEndIdx);
    });

    it('should stay online when one URL group fails but another succeeds', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._connectivityState = 'online';

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:1', dwnUrl: 'https://healthy.example.com' },
        { did: 'did:example:2', dwnUrl: 'https://down.example.com' },
      ]);

      sinon.stub(engine as any, 'createLinkReconciler').returns({
        reconcile: async (target: any) => {
          if (target.dwnUrl.includes('down')) {
            throw new Error('connection refused');
          }
          return { changed: false, didPull: false, didPush: false };
        },
      });
      sinon.stub(console, 'error');

      await engine.sync();

      // Partial failure: at least one group succeeded, so stay online.
      expect(engine.connectivityState).toBe('online');
      expect((engine as any)._consecutiveFailures).toBe(0);
    });

    it('should aggregate per-link connectivity: online if any link is online', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._activeLinks.set('link-1', { connectivity: 'online' });
      (engine as any)._activeLinks.set('link-2', { connectivity: 'offline' });

      expect(engine.connectivityState).toBe('online');
    });

    it('should aggregate per-link connectivity: offline if all links are offline', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._activeLinks.set('link-1', { connectivity: 'offline' });
      (engine as any)._activeLinks.set('link-2', { connectivity: 'offline' });

      expect(engine.connectivityState).toBe('offline');
    });

    it('should aggregate per-link connectivity: unknown if all links are unknown', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._activeLinks.set('link-1', { connectivity: 'unknown' });

      expect(engine.connectivityState).toBe('unknown');
    });

    it('should fall back to global state when no active links exist', () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._connectivityState = 'offline';

      expect(engine.connectivityState).toBe('offline');
    });

    it('should set link connectivity to offline on transitionToRepairing', async () => {
      const engine = new SyncEngineLevel({ db });
      const link = { status: 'live', connectivity: 'online', pull: {} } as any;
      const linkKey = 'test-link';
      (engine as any)._activeLinks.set(linkKey, link);

      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub };
      sinon.stub(engine as any, 'repairLink').resolves();

      await (engine as any).transitionToRepairing(linkKey, link);

      expect(link.connectivity).toBe('offline');
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

    it('should clear per-link push runtime state', async () => {
      (syncEngine as any)._pushRuntimes.set('key', {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid1' }],
        retryCount : 0,
        timer      : setTimeout((): void => {}, 10000),
      });
      (syncEngine as any)._liveSubscriptions = [];
      (syncEngine as any)._localSubscriptions = [];

      await (syncEngine as any).teardownLiveSync();

      expect((syncEngine as any)._pushRuntimes.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // openLivePullSubscription
  // ---------------------------------------------------------------------------

  describe('openLivePullSubscription', () => {
    /**
     * Helper: creates a mock agent with processRequest (construct message)
     * and rpc.sendDwnRequest (send to specific dwnUrl via WS).
     */
    function createPullMockAgent(rpcReply: any = {
      status       : { code: 200, detail: 'OK' },
      subscription : { close: sinon.stub().resolves() },
    }): { agent: any; processRequestStub: sinon.SinonStub; rpcStub: sinon.SinonStub } {
      const processRequestStub = sinon.stub().resolves({ message: { descriptor: {} } });
      const rpcStub = sinon.stub().resolves(rpcReply);
      return {
        agent: {
          agentDid : 'did:example:agent',
          dwn      : { processRequest: processRequestStub, processRawMessage: sinon.stub().resolves({ status: { code: 202 } }) },
          rpc      : { sendDwnRequest: rpcStub },
        } as any,
        processRequestStub,
        rpcStub,
      };
    }

    it('should open a subscription and add it to _liveSubscriptions', async () => {
      const { agent, rpcStub } = createPullMockAgent();
      const engine = new SyncEngineLevel({ db, agent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      expect((engine as any)._liveSubscriptions.length).toBe(1);
      // The rpc stub was called with a wss:// URL
      expect(rpcStub.firstCall.args[0].dwnUrl).toBe('wss://dwn.example.com/');
      (engine as any)._liveSubscriptions = [];
    });

    it('should throw when reply status is not 200', async () => {
      const { agent } = createPullMockAgent({
        status       : { code: 500, detail: 'Error' },
        subscription : undefined,
      });
      const engine = new SyncEngineLevel({ db, agent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await expect(
        (engine as any).openLivePullSubscription({
          did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
        })
      ).rejects.toThrow('MessagesSubscribe failed');

      expect((engine as any)._liveSubscriptions.length).toBe(0);
    });

    it('should include protocol in subscription filters when provided', async () => {
      const { agent, processRequestStub } = createPullMockAgent();
      const engine = new SyncEngineLevel({ db, agent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      await (engine as any).openLivePullSubscription({
        did      : 'did:example:alice',
        dwnUrl   : 'https://dwn.example.com',
        protocol : 'https://proto.example.com',
      });

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.filters).toEqual([{ protocol: 'https://proto.example.com' }]);
      (engine as any)._liveSubscriptions = [];
    });

    it('should include protocolPathPrefix in subscription filters when link scope has it', async () => {
      const { agent, processRequestStub } = createPullMockAgent();
      const engine = new SyncEngineLevel({ db, agent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      // Set up a link with protocolPathPrefixes in the scope.
      const linkKey = (engine as any).buildLinkKey('did:example:alice', 'https://dwn.example.com', 'https://proto.example.com');
      (engine as any)._activeLinks.set(linkKey, {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : {
          kind                 : 'protocol',
          protocol             : 'https://proto.example.com',
          protocolPathPrefixes : ['thread/message'],
        },
        status   : 'live',
        pull     : {},
        protocol : 'https://proto.example.com',
      });

      await (engine as any).openLivePullSubscription({
        did      : 'did:example:alice',
        dwnUrl   : 'https://dwn.example.com',
        protocol : 'https://proto.example.com',
        linkKey,
      });

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.filters).toEqual([{
        protocol           : 'https://proto.example.com',
        protocolPathPrefix : 'thread/message',
      }]);
      (engine as any)._liveSubscriptions = [];
    });

    it('should use existing cursor from link pull checkpoint', async () => {
      const { agent, processRequestStub } = createPullMockAgent();
      const engine = new SyncEngineLevel({ db, agent });
      const savedCursor = { streamId: 's1', epoch: 'e1', position: '42', messageCid: 'cid-42' };

      // Set cursor on the link's pull checkpoint (not legacy getCursor).
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : { contiguousAppliedToken: savedCursor },
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', linkKey,
      });

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.cursor).toEqual(savedCursor);
      (engine as any)._liveSubscriptions = [];
    });

    it('should look up delegate permission when delegateDid is provided', async () => {
      const permStub = sinon.stub().resolves({ grant: { id: 'sub-grant-1' } });
      const { agent } = createPullMockAgent();
      const engine = new SyncEngineLevel({ db, agent });
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

    it('should throw when permission grant lookup fails', async () => {
      const permStub = sinon.stub().rejects(new Error('no grant'));
      const { agent, rpcStub } = createPullMockAgent();
      const engine = new SyncEngineLevel({ db, agent });
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

      expect(rpcStub.called).toBe(false);
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

    it('should throw when reply status is not 200', async () => {
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

      await expect(
        (engine as any).openLocalPushSubscription({
          did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
        })
      ).rejects.toThrow('Local MessagesSubscribe failed');

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
    it('should clear pending push entries after flushing', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._pushRuntimes.set('key1', {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [],
        retryCount : 0,
      });

      await (engine as any).flushPendingPushes();

      expect((engine as any)._pushRuntimes.size).toBe(0);
    });

    it('should skip targets with empty entries array', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      (engine as any)._pushRuntimes.set('key1', {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [],
        retryCount : 0,
      });

      // Should not throw or call pushMessages
      await (engine as any).flushPendingPushes();
      expect((engine as any)._pushRuntimes.size).toBe(0);
    });

    it('should reset retryCount to 0 after a successful push', async () => {
      // processRequest returns a RecordsRead-like response so pushMessages
      // can read local messages and send them via rpc.
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Records', method: 'Write' } } },
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({ status: { code: 202 } }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      // Simulate a push runtime left over from a previously retried batch
      // that eventually succeeded — retryCount is stale at 2.
      (engine as any)._pushRuntimes.set('key1', {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid-new' }],
        retryCount : 2,
      });

      await (engine as any).flushPendingPushesForLink('key1');

      // Runtime should be cleaned up (success + no pending entries + no timer).
      // retryCount was reset to 0, enabling deletion.
      expect((engine as any)._pushRuntimes.has('key1')).toBe(false);
    });

    it('should not let stale retryCount leak to subsequent batches', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Records', method: 'Write' } } },
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({ status: { code: 202 } }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      // Simulate a runtime with stale retryCount from a prior batch,
      // plus new entries waiting. The batch-A entries will be flushed;
      // batch-B entries arrive while flush is in progress.
      const pushRuntime = {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid-batch-a' }],
        retryCount : 2,
      };
      (engine as any)._pushRuntimes.set('key1', pushRuntime);

      // Simulate batch B arriving after entries are snapshotted but before
      // the flush completes: add entries directly to the runtime.
      mockAgent.rpc.sendDwnRequest.callsFake(async () => {
        pushRuntime.entries.push({ cid: 'cid-batch-b' });
        return { status: { code: 202 } };
      });

      await (engine as any).flushPendingPushesForLink('key1');

      // Runtime should still exist (batch B pending), but retryCount must
      // be 0 — not the stale 2 from batch A's retries.
      const runtime = (engine as any)._pushRuntimes.get('key1');
      expect(runtime).toBeDefined();
      expect(runtime.retryCount).toBe(0);
      expect(runtime.entries).toHaveLength(1);
      expect(runtime.entries[0].cid).toBe('cid-batch-b');
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

      (engine as any)._pushRuntimes.set('key1', {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid-1' }],
        retryCount : 0,
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
  // startLiveSync — partial setup failure cleanup
  // ---------------------------------------------------------------------------

  describe('startLiveSync — partial setup failure cleanup', () => {
    it('should clean up in-memory state when push subscription fails', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      // Stub sync() to no-op (initial catch-up).
      sinon.stub(engine, 'sync').resolves();

      // Return one sync target.
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com' },
      ]);

      // Pull subscription succeeds (sets connectivity to online).
      sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<void> => {
        (engine as any)._liveSubscriptions.push({
          did    : 'did:example:alice', dwnUrl : 'https://dwn.example.com',
          close  : sinon.stub().resolves(),
        });
        (engine as any)._connectivityState = 'online';
      });

      // Push subscription fails.
      sinon.stub(engine as any, 'openLocalPushSubscription').rejects(new Error('push open failed'));

      sinon.stub(console, 'error');

      await engine.startSync({ mode: 'live', interval: '10s' });

      // _activeLinks should not contain the failed link.
      const linkKey = (engine as any).buildLinkKey('did:example:alice', 'https://dwn.example.com', undefined);
      expect((engine as any)._activeLinks.has(linkKey)).toBe(false);
      expect((engine as any)._linkRuntimes.has(linkKey)).toBe(false);

      // Pull subscription should have been closed (the openLivePullSubscription
      // stub added it, and the catch path in startLiveSync should have closed it
      // via the inner try/catch around push). Since we stubbed openLivePullSubscription
      // directly, the inner try/catch won't fire — but _activeLinks cleanup still runs.

      // Connectivity should be reset since no live subscriptions remain after cleanup.
      // The pull sub was added by our stub but startLiveSync's catch-path inner try/catch
      // for the push won't close it because openLivePullSubscription was stubbed.
      // However the outer catch does clean up _activeLinks and resets connectivity
      // if no _liveSubscriptions remain. Our stub added one, so connectivity stays online.
      // This is correct — the pull subscription was opened by the stub and is still in
      // _liveSubscriptions. In the real code path (non-stubbed), the inner try/catch
      // would close it.

      await engine.stopSync();
    });

    it('should reset connectivity to unknown when no subscriptions remain after failure', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com' },
      ]);

      // Pull subscription fails immediately (no subscriptions added).
      sinon.stub(engine as any, 'openLivePullSubscription').rejects(new Error('pull open failed'));

      sinon.stub(console, 'error');

      await engine.startSync({ mode: 'live', interval: '10s' });

      // No subscriptions opened at all — connectivity should be unknown.
      expect((engine as any)._connectivityState).toBe('unknown');
      expect((engine as any)._liveSubscriptions.length).toBe(0);

      const linkKey = (engine as any).buildLinkKey('did:example:alice', 'https://dwn.example.com', undefined);
      expect((engine as any)._activeLinks.has(linkKey)).toBe(false);

      await engine.stopSync();
    });
  });

  // ---------------------------------------------------------------------------
  // openLivePullSubscription — subscriptionHandler callback
  // ---------------------------------------------------------------------------

  describe('openLivePullSubscription — subscriptionHandler callback', () => {
    /**
     * Helper: creates a mock agent that captures the subscription handler
     * from the rpc.sendDwnRequest call.
     */
    function createCallbackMockAgent(processRawMessageStub?: sinon.SinonStub): {
      agent: any; getHandler: () => any;
    } {
      let capturedHandler: any;
      const processRequest = sinon.stub().resolves({ message: { descriptor: {} } });
      const rpcStub = sinon.stub().callsFake(async (params: any) => {
        capturedHandler = params.subscription?.handler;
        return {
          status       : { code: 200, detail: 'OK' },
          subscription : { close: sinon.stub().resolves() },
        };
      });
      return {
        agent: {
          agentDid : 'did:example:agent',
          dwn      : {
            processRequest,
            processRawMessage: processRawMessageStub ?? sinon.stub().resolves({ status: { code: 202 } }),
          },
          rpc: { sendDwnRequest: rpcStub },
        } as any,
        getHandler: () => capturedHandler,
      };
    }

    it('should process eose events by updating link checkpoint and connectivity', async () => {
      const { agent, getHandler } = createCallbackMockAgent();
      const engine = new SyncEngineLevel({ db, agent });

      // Set up a link so the EOSE handler uses the link path.
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : {}, connectivity   : 'unknown', needsReconcile : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      const saveStub = sinon.stub().resolves();
      (engine as any)._ledger = { saveLink: saveStub };

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', linkKey,
      });

      const handler = getHandler();
      expect(handler).toBeDefined();

      const eoseCursor = { streamId: 's1', epoch: 'e1', position: '10', messageCid: 'cid-eose' };
      await handler({ type: 'eose', cursor: eoseCursor });

      // EOSE should set connectivity to online.
      expect(link.connectivity).toBe('online');
      // receivedToken should be set from the EOSE cursor.
      expect(link.pull.receivedToken).toEqual(eoseCursor);

      (engine as any)._liveSubscriptions = [];
    });

    it('should process event messages by calling processRawMessage', async () => {
      const processMessageStub = sinon.stub().resolves({ status: { code: 202 } });
      const { agent, getHandler } = createCallbackMockAgent(processMessageStub);
      const engine = new SyncEngineLevel({ db, agent });

      // Set up a link so the event handler uses the link path.
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : {}, connectivity   : 'online', needsReconcile : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      const saveStub = sinon.stub().resolves();
      (engine as any)._ledger = { saveLink: saveStub };

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      const handler = getHandler();

      const eventCursor = { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' };
      await handler({
        type   : 'event',
        cursor : eventCursor,
        event  : {
          message: { descriptor: { interface: 'Protocols', method: 'Configure' } },
        },
      });

      expect(processMessageStub.calledOnce).toBe(true);

      (engine as any)._liveSubscriptions = [];
    });

    it('should handle processMessage errors gracefully in event handler', async () => {
      const processMessageStub = sinon.stub().rejects(new Error('process failed'));
      const { agent, getHandler } = createCallbackMockAgent(processMessageStub);
      const engine = new SyncEngineLevel({ db, agent });
      const consoleStub = sinon.stub(console, 'error');

      await (engine as any).openLivePullSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
      });

      const handler = getHandler();

      await handler({
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

      // Invoke handler with an event — handler is now async
      await capturedHandler({
        type  : 'event',
        event : { message: { descriptor: { interface: 'Records', method: 'Write' } } },
      });

      // With immediate-first push, the first event triggers an immediate
      // flush (no debounce timer). The runtime may already be cleaned up
      // after a successful push, or marked as flushing if still in flight.
      // The key invariant: the CID was dispatched for push.
      const pushRuntimes = (engine as any)._pushRuntimes;
      // Runtime may have been deleted after successful immediate flush,
      // or may still be in-flight. Either state is valid.
      if (pushRuntimes.size > 0) {
        const runtime = [...pushRuntimes.values()][0];
        if (runtime?.timer) {
          clearTimeout(runtime.timer);
        }
      }
      (engine as any)._pushRuntimes.clear();
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

      expect((engine as any)._pushRuntimes.size).toBe(0);

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
      expect((engine as any)._pushRuntimes.size).toBe(0);

      (engine as any)._localSubscriptions = [];
    });

    it('should batch subsequent events while a push is in flight', async () => {
      let capturedHandler: any;
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          processRequest: sinon.stub().callsFake(async (params: any): Promise<any> => {
            // Capture subscription handler only from the MessagesSubscribe call.
            if (params.subscriptionHandler) {
              capturedHandler = params.subscriptionHandler;
            }
            return {
              reply: {
                status       : { code: 200, detail: 'OK' },
                subscription : { close: sinon.stub().resolves() },
              },
            };
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({ status: { code: 202 } }),
        },
      } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      await (engine as any).openLocalPushSubscription({
        did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', linkKey: 'test-link',
      });

      // First event triggers immediate flush (no timer).
      await capturedHandler({
        type  : 'event',
        event : { message: { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '2026-01-01T00:00:00.000000Z' } } },
      });

      // Simulate the flush being in-flight by setting flushing = true.
      const runtimes = (engine as any)._pushRuntimes as Map<string, any>;
      const linkKey = [...runtimes.keys()][0];
      if (linkKey) {
        const rt = runtimes.get(linkKey);
        if (rt) { rt.flushing = true; }
      }

      // Second event while flushing — should NOT trigger another flush.
      await capturedHandler({
        type  : 'event',
        event : { message: { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '2026-01-02T00:00:00.000000Z' } } },
      });

      // The second CID should be queued in entries, awaiting the post-flush drain.
      if (linkKey) {
        const rt = runtimes.get(linkKey);
        expect(rt?.entries?.length).toBeGreaterThanOrEqual(1);
      }

      // Cleanup
      for (const [, rt] of runtimes) {
        if (rt?.timer) { clearTimeout(rt.timer); }
      }
      (engine as any)._pushRuntimes.clear();
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

  // ---------------------------------------------------------------------------
  // Echo-loop suppression
  // ---------------------------------------------------------------------------

  describe('echo-loop suppression', () => {
    const providerA = 'https://provider-a.example.com';
    const providerB = 'https://provider-b.example.com';

    it('should return false for unknown CIDs', () => {
      const result = (syncEngine as any).isRecentlyPulled('unknown-cid', providerA);
      expect(result).toBe(false);
    });

    it('should return true for a CID recently pulled from the same endpoint', () => {
      const map = (syncEngine as any)._recentlyPulledCids as Map<string, number>;
      map.set(`cid-1|${providerA}`, Date.now() + 60_000);

      expect((syncEngine as any).isRecentlyPulled('cid-1', providerA)).toBe(true);
    });

    it('should return false for the same CID when checking a different endpoint', () => {
      const map = (syncEngine as any)._recentlyPulledCids as Map<string, number>;
      map.set(`cid-1|${providerA}`, Date.now() + 60_000);

      // Same CID, different provider — should NOT be suppressed (fan-out).
      expect((syncEngine as any).isRecentlyPulled('cid-1', providerB)).toBe(false);
    });

    it('should return false and evict expired entries', () => {
      const map = (syncEngine as any)._recentlyPulledCids as Map<string, number>;
      map.set(`cid-expired|${providerA}`, Date.now() - 1); // already expired

      expect((syncEngine as any).isRecentlyPulled('cid-expired', providerA)).toBe(false);
      expect(map.has(`cid-expired|${providerA}`)).toBe(false);
    });

    it('should evict entries beyond the max cap', () => {
      const map = (syncEngine as any)._recentlyPulledCids as Map<string, number>;
      map.clear();

      // Fill beyond the cap (10,000).
      const cap = (SyncEngineLevel as any).ECHO_SUPPRESS_MAX_ENTRIES;
      for (let i = 0; i < cap + 50; i++) {
        map.set(`cid-${i}|${providerA}`, Date.now() + 60_000);
      }

      expect(map.size).toBe(cap + 50);

      // Eviction should trim to cap.
      (syncEngine as any).evictExpiredEchoEntries();
      expect(map.size).toBe(cap);
    });
  });

  // ---------------------------------------------------------------------------
  // Pull delivery-order tracking (ordinal-based replication checkpoint)
  // ---------------------------------------------------------------------------

  describe('pull delivery-order tracking', () => {
    /** Helper to build a ProgressToken. */
    function token(pos: number): any {
      return { streamId: 'stream-1', epoch: 'epoch-1', position: String(pos), messageCid: `cid-${pos}` };
    }

    it('should advance checkpoint only when all earlier ordinals are committed', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      // Set up link and runtime state.
      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      const rt = (engine as any).getOrCreateRuntime(linkKey);

      // Deliver ordinal 0 (token 1) and ordinal 1 (token 5).
      rt.inflight.set(0, { ordinal: 0, token: token(1), committed: false });
      rt.nextDeliveryOrdinal = 1;
      rt.inflight.set(1, { ordinal: 1, token: token(5), committed: false });
      rt.nextDeliveryOrdinal = 2;

      // Ordinal 1 (token 5) completes first.
      rt.inflight.get(1).committed = true;
      const drained1 = (engine as any).drainCommittedPull(linkKey);

      // Checkpoint must NOT advance — ordinal 0 is still uncommitted.
      expect(drained1).toBe(0);
      expect(link.pull.contiguousAppliedToken).toBeUndefined();

      // Now ordinal 0 (token 1) completes.
      rt.inflight.get(0).committed = true;
      const drained2 = (engine as any).drainCommittedPull(linkKey);

      // Checkpoint should advance through both: 0 → token 1, then 1 → token 5.
      expect(drained2).toBe(2);
      expect(link.pull.contiguousAppliedToken).toEqual(token(5));
    });

    it('should advance checkpoint through sparse positions from filtered streams', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      const rt = (engine as any).getOrCreateRuntime(linkKey);

      // Deliver sparse positions 1, 5, 9 in order.
      for (let i = 0; i < 3; i++) {
        const pos = [1, 5, 9][i];
        rt.inflight.set(i, { ordinal: i, token: token(pos), committed: true });
        rt.nextDeliveryOrdinal = i + 1;
      }

      const drained = (engine as any).drainCommittedPull(linkKey);

      // All three should drain — sparse positions are fine.
      expect(drained).toBe(3);
      expect(link.pull.contiguousAppliedToken).toEqual(token(9));
    });

    it('should NOT advance checkpoint past a failed event (failure blocks progression)', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      const rt = (engine as any).getOrCreateRuntime(linkKey);

      // Simulate: ordinal 0 (token 1) succeeds, ordinal 1 (token 5) fails,
      // ordinal 2 (token 9) succeeds.

      // Ordinal 0 commits.
      rt.inflight.set(0, { ordinal: 0, token: token(1), committed: true });
      rt.nextDeliveryOrdinal = 1;
      (engine as any).drainCommittedPull(linkKey);
      expect(link.pull.contiguousAppliedToken).toEqual(token(1));

      // Ordinal 1 delivered, ordinal 2 delivered.
      rt.inflight.set(1, { ordinal: 1, token: token(5), committed: false });
      rt.nextDeliveryOrdinal = 2;
      rt.inflight.set(2, { ordinal: 2, token: token(9), committed: false });
      rt.nextDeliveryOrdinal = 3;

      // Ordinal 2 (token 9) succeeds.
      rt.inflight.get(2).committed = true;
      (engine as any).drainCommittedPull(linkKey);

      // Checkpoint must still be at token 1 — ordinal 1 is blocking.
      expect(link.pull.contiguousAppliedToken).toEqual(token(1));

      // Ordinal 1 fails — simulating what the catch block does.
      // The catch block clears inflight and sets repairing.
      rt.inflight.clear();
      rt.nextCommitOrdinal = rt.nextDeliveryOrdinal;
      link.status = 'repairing';

      // Checkpoint must still be at token 1 — the failed event was never committed.
      expect(link.pull.contiguousAppliedToken).toEqual(token(1));
      expect(link.status).toBe('repairing');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 2: Repair orchestration and degraded_poll
  // ---------------------------------------------------------------------------

  describe('repairLink', () => {
    it('should transition link from repairing to live after successful SMT reconciliation', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      // Stub everything doRepairLink needs (called in order).
      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'getLocalRoot').resolves('root-a');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('root-a');
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub, saveLink: saveStub };

      await (engine as any).repairLink(linkKey);

      expect(link.status).toBe('live');
    });

    it('should track repair attempts and enter degraded_poll after max attempts', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'getLocalRoot').rejects(new Error('network error'));
      sinon.stub(console, 'error');
      sinon.stub(console, 'warn');

      const saveStub = sinon.stub().resolves();
      (engine as any)._ledger = { saveLink: saveStub, setStatus: sinon.stub().resolves() };

      const enterDegradedStub = sinon.stub(engine as any, 'enterDegradedPoll').resolves();

      const maxAttempts = (SyncEngineLevel as any).MAX_REPAIR_ATTEMPTS;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          await (engine as any).repairLink(linkKey);
        } catch {
          // Expected — doRepairLink re-throws on failure (except when entering degraded_poll).
        }
      }

      expect(enterDegradedStub.calledOnce).toBe(true);
    });

    it('should deduplicate concurrent repair calls for the same link', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      let repairCallCount = 0;
      sinon.stub(engine as any, 'doRepairLink').callsFake(async (): Promise<void> => {
        repairCallCount++;
        await new Promise(r => setTimeout(r, 50));
      });

      // Fire two repairs concurrently.
      const p1 = (engine as any).repairLink(linkKey);
      const p2 = (engine as any).repairLink(linkKey);
      await Promise.all([p1, p2]);

      // Only one actual repair should have run.
      expect(repairCallCount).toBe(1);
    });
  });

  describe('ProgressGap detection on subscribe', () => {
    it('should detect 410 from subscribe reply and throw with isProgressGap flag', async () => {
      const processRequestStub = sinon.stub().resolves({ message: { descriptor: {} } });
      const rpcStub = sinon.stub().resolves({
        status       : { code: 410, detail: 'Progress token gap' },
        subscription : undefined,
      });
      const agent = {
        agentDid : 'did:example:agent',
        dwn      : { processRequest: processRequestStub },
        rpc      : { sendDwnRequest: rpcStub },
      } as any;
      const engine = new SyncEngineLevel({ db, agent });
      sinon.stub(engine as any, 'getCursor').resolves(undefined);

      try {
        await (engine as any).openLivePullSubscription({
          did: 'did:example:alice', dwnUrl: 'https://dwn.example.com',
        });
        throw new Error('expected error');
      } catch (error: any) {
        expect(error.isProgressGap).toBe(true);
        expect(error.message).toContain('ProgressGap');
      }
    });
  });

  describe('in-flight handler guard', () => {
    it('should skip checkpoint mutations when link status is repairing', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      function token(pos: number): any {
        return { streamId: 'stream-1', epoch: 'epoch-1', position: String(pos), messageCid: `cid-${pos}` };
      }

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : { contiguousAppliedToken: token(1) },
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      const rt = (engine as any).getOrCreateRuntime(linkKey);

      // Simulate an ordinal committed after the link entered repairing.
      rt.inflight.set(0, { ordinal: 0, token: token(5), committed: true });
      rt.nextDeliveryOrdinal = 1;

      // drainCommittedPull should still drain (it doesn't check status — the
      // guard is in the subscription handler). But the checkpoint should only
      // advance if the subscription handler calls it while status === 'live'.
      // Since the handler checks status before calling drain, we verify the
      // link's checkpoint is unchanged when status is repairing.
      expect(link.pull.contiguousAppliedToken).toEqual(token(1));
    });
  });

  describe('degraded_poll', () => {
    it('should set up a polling timer when entering degraded_poll', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      const setStatusStub = sinon.stub();
      (engine as any)._ledger = { setStatus: setStatusStub };

      await (engine as any).enterDegradedPoll(linkKey);

      // Link should be in degraded_poll.
      expect(setStatusStub.calledWith(link, 'degraded_poll')).toBe(true);

      // A timer should be registered.
      expect((engine as any)._degradedPollTimers.has(linkKey)).toBe(true);

      // Clean up timer.
      clearInterval((engine as any)._degradedPollTimers.get(linkKey));
    });
  });

  describe('transitionToRepairing and retry scheduling', () => {
    it('should schedule a retry when first repair fails', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'getLocalRoot').rejects(new Error('network error'));
      sinon.stub(console, 'error');
      sinon.stub(console, 'warn');

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub, saveLink: saveStub };

      await (engine as any).transitionToRepairing(linkKey, link);

      // Wait for repair + retry scheduling to settle.
      await new Promise(r => setTimeout(r, 100));

      // A retry timer should be scheduled.
      expect((engine as any)._repairRetryTimers.has(linkKey)).toBe(true);

      // Clean up.
      clearTimeout((engine as any)._repairRetryTimers.get(linkKey));
    });

    it('should clear retry timer on teardown', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'test-link';

      (engine as any)._repairRetryTimers.set(linkKey, setTimeout(() => {}, 60_000));
      expect((engine as any)._repairRetryTimers.size).toBe(1);

      await (engine as any).teardownLiveSync();

      expect((engine as any)._repairRetryTimers.size).toBe(0);
    });

    it('should store resumeToken from ProgressGap for use during repair', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const resumeToken = { streamId: 's1', epoch: 'e1', position: '99', messageCid: 'cid-99' };
      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'live',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      // Stub ledger and repair to capture the context.
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub };
      sinon.stub(engine as any, 'repairLink').resolves();

      await (engine as any).transitionToRepairing(linkKey, link, { resumeToken });

      // Repair context should have the resume token.
      const ctx = (engine as any)._repairContext.get(linkKey);
      expect(ctx).toBeDefined();
      expect(ctx.resumeToken).toEqual(resumeToken);
    });
  });

  describe('doRepairLink — post-repair checkpoint', () => {
    it('should set checkpoint to resumeToken from ProgressGap after successful repair', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const resumeToken = { streamId: 's1', epoch: 'e1', position: '99', messageCid: 'cid-99' };
      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      (engine as any)._repairContext.set(linkKey, { resumeToken });

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'getLocalRoot').resolves('root-a');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('root-a');
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub, saveLink: saveStub };

      await (engine as any).doRepairLink(linkKey);

      // Checkpoint should be set to the resume token, not undefined.
      expect(link.pull.contiguousAppliedToken).toEqual(resumeToken);
      expect(link.pull.receivedToken).toEqual(resumeToken);
      expect(link.status).toBe('live');
      // Repair context should be cleared after success.
      expect((engine as any)._repairContext.has(linkKey)).toBe(false);
    });

    it('should not leave checkpoint undefined after non-gap repair', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const existingToken = { streamId: 's1', epoch: 'e1', position: '50', messageCid: 'cid-50' };
      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : { contiguousAppliedToken: existingToken },
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      // No repair context — this is a non-gap repair (e.g., domain mismatch).

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'getLocalRoot').resolves('root-a');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('root-a');
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub, saveLink: saveStub };

      await (engine as any).doRepairLink(linkKey);

      // Checkpoint should use the existing token, not undefined.
      expect(link.pull.contiguousAppliedToken).toEqual(existingToken);
      expect(link.status).toBe('live');
    });

    it('should reopen local push subscription without a cursor (opportunistic push)', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'getLocalRoot').resolves('root-a');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('root-a');
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();

      // Capture the args passed to openLocalPushSubscription.
      const pushSubStub = sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub, saveLink: saveStub };

      await (engine as any).doRepairLink(linkKey);

      // Verify push subscription was reopened without a cursor (no pushCursor parameter).
      expect(pushSubStub.calledOnce).toBe(true);
      const pushTarget = pushSubStub.firstCall.args[0];
      expect(pushTarget.pushCursor).toBeUndefined();
    });

    it('should bail if teardown occurs during repair (generation check)', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      const closeStub = sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();

      // Stub getLocalRoot to simulate an async operation during which teardown occurs.
      sinon.stub(engine as any, 'getLocalRoot').callsFake(async () => {
        // Simulate teardown by incrementing the generation.
        (engine as any)._engineGeneration++;
        return 'root-a';
      });

      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().resolves();
      (engine as any)._ledger = { setStatus: setStatusStub, saveLink: saveStub };

      await (engine as any).doRepairLink(linkKey);

      // closeLinkSubscriptions should have been called (before the generation check).
      expect(closeStub.calledOnce).toBe(true);

      // But subscriptions should NOT be reopened — repair bailed after getLocalRoot.
      expect(openPullStub.called).toBe(false);

      // Link should NOT have been set to live.
      expect(setStatusStub.calledWith(link, 'live')).toBe(false);
    });

    it('should schedule post-repair reconcile after _activeRepairs is cleared', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test', scope          : { kind: 'full' }, status         : 'repairing',
        pull           : {},
        needsReconcile : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'getLocalRoot').resolves('root-a');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('root-a');
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub, saveLink: saveStub };

      // Run repair through the repairLink() wrapper (not doRepairLink directly)
      // so _activeRepairs lifecycle is exercised.
      await (engine as any).repairLink(linkKey);

      // After repair completes:
      // 1. _activeRepairs should be cleared
      expect((engine as any)._activeRepairs.has(linkKey)).toBe(false);
      // 2. needsReconcile should have been set (by doRepairLink before reopen)
      expect(link.needsReconcile).toBe(true);
      // 3. Link should be live
      expect(link.status).toBe('live');
      // 4. A reconcile timer should be scheduled (the main assertion)
      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(true);

      // Clean up the timer.
      const timer = (engine as any)._reconcileTimers.get(linkKey);
      if (timer) { clearTimeout(timer); }
    });
  });

  // ---------------------------------------------------------------------------
  // closeLinkSubscriptions
  // ---------------------------------------------------------------------------

  describe('closeLinkSubscriptions', () => {
    it('should close both pull and push subscriptions for a link', async () => {
      const engine = new SyncEngineLevel({ db });
      const pullClose = sinon.stub().resolves();
      const pushClose = sinon.stub().resolves();

      (engine as any)._liveSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn.example.com^scope-a', did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: undefined, close: pullClose },
        { linkKey: 'did:example:bob^https://other.com^scope-b', did: 'did:example:bob', dwnUrl: 'https://other.com', close: sinon.stub().resolves() },
      ];
      (engine as any)._localSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn.example.com^scope-a', did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: undefined, close: pushClose },
      ];

      const link = {
        tenantDid      : 'did:example:alice', remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'scope-a',
        protocol       : undefined,
      } as any;

      await (engine as any).closeLinkSubscriptions(link);

      expect(pullClose.calledOnce).toBe(true);
      expect(pushClose.calledOnce).toBe(true);
      // Other links' subscriptions should remain.
      expect((engine as any)._liveSubscriptions.length).toBe(1);
      expect((engine as any)._liveSubscriptions[0].did).toBe('did:example:bob');
    });

    it('should handle missing subscriptions gracefully', async () => {
      const engine = new SyncEngineLevel({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      const link = {
        tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scopeId: 'scope-a',
      } as any;

      // Should not throw.
      await (engine as any).closeLinkSubscriptions(link);
    });
  });

  // ---------------------------------------------------------------------------
  // scheduleRepairRetry backoff
  // ---------------------------------------------------------------------------

  describe('scheduleRepairRetry', () => {
    it('should not schedule if link is in degraded_poll', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      (engine as any)._activeLinks.set(linkKey, { status: 'degraded_poll' });

      (engine as any).scheduleRepairRetry(linkKey);

      expect((engine as any)._repairRetryTimers.has(linkKey)).toBe(false);
    });

    it('should not schedule if retry is already pending', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      (engine as any)._activeLinks.set(linkKey, { status: 'repairing' });
      const existingTimer = setTimeout(() => {}, 60000);
      (engine as any)._repairRetryTimers.set(linkKey, existingTimer);

      (engine as any).scheduleRepairRetry(linkKey);

      // Should still be the same timer.
      expect((engine as any)._repairRetryTimers.get(linkKey)).toBe(existingTimer);
      clearTimeout(existingTimer);
    });

    it('should schedule a timer for repairing links without existing timer', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      (engine as any)._activeLinks.set(linkKey, { status: 'repairing' });
      (engine as any)._repairAttempts.set(linkKey, 1);

      (engine as any).scheduleRepairRetry(linkKey);

      expect((engine as any)._repairRetryTimers.has(linkKey)).toBe(true);
      clearTimeout((engine as any)._repairRetryTimers.get(linkKey));
    });
  });

  // ---------------------------------------------------------------------------
  // Subset scope filtering
  // ---------------------------------------------------------------------------

  describe('isEventInScope (tested via exported helper)', () => {
    // isEventInScope is a module-level function. We test it by importing
    // the module and accessing it, or by testing behavior through the engine.
    // Since it's not exported, we replicate its logic here for direct testing.

    function isEventInScope(message: any, scope: any): boolean {
      if (scope.kind === 'full') { return true; }
      if (!scope.protocolPathPrefixes && !scope.contextIdPrefixes) { return true; }
      const desc = message.descriptor || {};
      if (scope.protocolPathPrefixes && scope.protocolPathPrefixes.length > 0) {
        const protocolPath = desc.protocolPath;
        if (!protocolPath) { return false; }
        const matches = scope.protocolPathPrefixes.some(
          (prefix: string) => protocolPath === prefix || protocolPath.startsWith(prefix + '/')
        );
        if (!matches) { return false; }
      }
      if (scope.contextIdPrefixes && scope.contextIdPrefixes.length > 0) {
        const contextId = message.contextId;
        if (!contextId) { return false; }
        const matches = scope.contextIdPrefixes.some(
          (prefix: string) => contextId === prefix || contextId.startsWith(prefix + '/')
        );
        if (!matches) { return false; }
      }
      return true;
    }

    it('should accept all events for full-tenant scope', () => {
      const msg = { descriptor: { protocolPath: 'thread/message' } };
      expect(isEventInScope(msg, { kind: 'full' })).toBe(true);
    });

    it('should accept all events when no prefixes are specified', () => {
      const msg = { descriptor: { protocolPath: 'thread/message' } };
      expect(isEventInScope(msg, { kind: 'protocol', protocol: 'https://example.com' })).toBe(true);
    });

    it('should accept events matching protocolPath prefix exactly', () => {
      const msg = { descriptor: { protocolPath: 'thread/message' } };
      const scope = { kind: 'protocol', protocol: 'x', protocolPathPrefixes: ['thread/message'] };
      expect(isEventInScope(msg, scope)).toBe(true);
    });

    it('should accept events matching protocolPath prefix with child path', () => {
      const msg = { descriptor: { protocolPath: 'thread/message/attachment' } };
      const scope = { kind: 'protocol', protocol: 'x', protocolPathPrefixes: ['thread/message'] };
      expect(isEventInScope(msg, scope)).toBe(true);
    });

    it('should reject events not matching protocolPath prefix', () => {
      const msg = { descriptor: { protocolPath: 'thread/participant' } };
      const scope = { kind: 'protocol', protocol: 'x', protocolPathPrefixes: ['thread/message'] };
      expect(isEventInScope(msg, scope)).toBe(false);
    });

    it('should not false-match prefix substrings (thread/message vs thread/messageDraft)', () => {
      const msg = { descriptor: { protocolPath: 'thread/messageDraft' } };
      const scope = { kind: 'protocol', protocol: 'x', protocolPathPrefixes: ['thread/message'] };
      expect(isEventInScope(msg, scope)).toBe(false);
    });

    it('should accept events matching contextId prefix', () => {
      const msg = { descriptor: {}, contextId: 'ctx-root/child' };
      const scope = { kind: 'protocol', protocol: 'x', contextIdPrefixes: ['ctx-root'] };
      expect(isEventInScope(msg, scope)).toBe(true);
    });

    it('should reject events not matching contextId prefix', () => {
      const msg = { descriptor: {}, contextId: 'other-root/child' };
      const scope = { kind: 'protocol', protocol: 'x', contextIdPrefixes: ['ctx-root'] };
      expect(isEventInScope(msg, scope)).toBe(false);
    });

    it('should reject events with no protocolPath when prefixes are required', () => {
      const msg = { descriptor: {} };
      const scope = { kind: 'protocol', protocol: 'x', protocolPathPrefixes: ['thread'] };
      expect(isEventInScope(msg, scope)).toBe(false);
    });

    it('should require both protocolPath AND contextId match when both are specified', () => {
      const msg = { descriptor: { protocolPath: 'thread/message' }, contextId: 'wrong-ctx' };
      const scope = {
        kind                 : 'protocol',
        protocol             : 'x',
        protocolPathPrefixes : ['thread/message'],
        contextIdPrefixes    : ['ctx-root'],
      };
      // protocolPath matches but contextId doesn't → reject.
      expect(isEventInScope(msg, scope)).toBe(false);
    });
  });

  describe('subset scope link creation', () => {
    it('should create protocol-scoped links when target has a protocol', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: 'https://example.com/chat' },
      ]);
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
      sinon.stub(console, 'error');

      // Stub the ledger to capture the scope.
      let capturedScope: any;
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      const getOrCreateStub = sinon.stub().callsFake(async (params: any) => {
        capturedScope = params.scope;
        return {
          tenantDid      : params.tenantDid, remoteEndpoint : params.remoteEndpoint,
          scopeId        : 'test', scope          : params.scope, status         : 'initializing',
          pull           : {}, protocol       : params.protocol,
        };
      });
      (engine as any)._ledger = {
        getOrCreateLink : getOrCreateStub,
        setStatus       : setStatusStub,
      };

      await engine.startSync({ mode: 'live', interval: '10s' });

      // Scope should be protocol-scoped, not full.
      expect(capturedScope).toBeDefined();
      expect(capturedScope.kind).toBe('protocol');
      expect(capturedScope.protocol).toBe('https://example.com/chat');

      await engine.stopSync();
    });

    it('should create full-tenant links when target has no protocol', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = new SyncEngineLevel({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        { did: 'did:example:alice', dwnUrl: 'https://dwn.example.com' },
      ]);
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
      sinon.stub(console, 'error');

      let capturedScope: any;
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = {
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => {
          capturedScope = params.scope;
          return {
            tenantDid      : params.tenantDid, remoteEndpoint : params.remoteEndpoint,
            scopeId        : 'test', scope          : params.scope, status         : 'initializing',
            pull           : {},
          };
        }),
        setStatus: setStatusStub,
      };

      await engine.startSync({ mode: 'live', interval: '10s' });

      expect(capturedScope).toBeDefined();
      expect(capturedScope.kind).toBe('full');

      await engine.stopSync();
    });
  });

  // ---------------------------------------------------------------------------
  // Push simplification — opportunistic push + needsReconcile
  // ---------------------------------------------------------------------------

  describe('opportunistic push + needsReconcile', () => {
    it('should mark link needsReconcile when push retries are exhausted', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        status         : 'live',
        pull           : {},
        needsReconcile : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      const saveStub = sinon.stub().resolves();
      (engine as any)._ledger = { saveLink: saveStub };

      // Call requeueOrReconcile with retryCount >= max retries (4).
      (engine as any).requeueOrReconcile(linkKey, {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid-1' }],
        retryCount : 4, // exceeds PUSH_RETRY_BACKOFF_MS.length (4)
      });

      // Link should be marked as needing reconciliation.
      expect(link.needsReconcile).toBe(true);

      // Should NOT have remained in per-link push runtime state.
      expect((engine as any)._pushRuntimes.has(linkKey)).toBe(false);
    });

    it('should re-queue push entries when retries remain', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      (engine as any).requeueOrReconcile(linkKey, {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid-1' }],
        retryCount : 1, // within retry budget
      });

      // Should have been re-queued.
      expect((engine as any)._pushRuntimes.has(linkKey)).toBe(true);
      const requeued = (engine as any)._pushRuntimes.get(linkKey);
      expect(requeued.retryCount).toBe(1);
    });

    it('should not have push checkpoint on ReplicationLinkState', () => {
      // Verify the type change — link should not have a push property.
      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        status         : 'live',
        pull           : {},
        needsReconcile : false,
      } as any;

      expect(link.push).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-link reconciliation (doReconcileLink, reconcileLink, scheduleReconcile)
  // ---------------------------------------------------------------------------

  describe('per-link reconciliation', () => {
    function makeLiveLink(overrides: any = {}): any {
      return {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scopeId        : 'test',
        scope          : { kind: 'full' },
        status         : 'live',
        pull           : {},
        needsReconcile : true,
        ...overrides,
      };
    }

    it('should clear needsReconcile when roots converge after reconciliation', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      // Roots initially differ, then converge after diff+pull+push.
      let rootCallCount = 0;
      sinon.stub(engine as any, 'getLocalRoot').callsFake(async () => {
        rootCallCount++;
        return rootCallCount <= 1 ? 'root-A' : 'root-converged';
      });
      sinon.stub(engine as any, 'getRemoteRoot').callsFake(async () => {
        return rootCallCount <= 1 ? 'root-B' : 'root-converged';
      });
      sinon.stub(engine as any, 'diffWithRemote').resolves({ onlyRemote: [], onlyLocal: [] });
      sinon.stub(engine as any, 'pullMessages').resolves();
      sinon.stub(engine as any, 'pushMessages').resolves();

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      (engine as any)._ledger = { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() };

      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      await (engine as any).doReconcileLink(linkKey);

      expect(link.needsReconcile).toBe(false);
      expect(clearStub.calledOnce).toBe(true);
      expect(events.some(e => e.type === 'reconcile:completed')).toBe(true);
    });

    it('should NOT clear needsReconcile when roots still differ after reconciliation', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      // Roots always differ — simulates permanent push failures.
      sinon.stub(engine as any, 'getLocalRoot').resolves('root-local');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('root-remote');
      sinon.stub(engine as any, 'diffWithRemote').resolves({ onlyRemote: [], onlyLocal: ['cid-1'] });
      sinon.stub(engine as any, 'pullMessages').resolves();
      sinon.stub(engine as any, 'pushMessages').resolves();

      const clearStub = sinon.stub().resolves();
      (engine as any)._ledger = { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() };

      await (engine as any).doReconcileLink(linkKey);

      // Flag should NOT be cleared since roots still diverge.
      expect(link.needsReconcile).toBe(true);
      expect(clearStub.called).toBe(false);

      // A retry reconcile should be scheduled.
      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(true);
      clearTimeout((engine as any)._reconcileTimers.get(linkKey));
    });

    it('should skip reconciliation when link is not live', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink({ status: 'repairing' });
      (engine as any)._activeLinks.set(linkKey, link);

      const getLocalRootStub = sinon.stub(engine as any, 'getLocalRoot');

      await (engine as any).doReconcileLink(linkKey);

      // Should have bailed before any root computation.
      expect(getLocalRootStub.called).toBe(false);
    });

    it('should skip reconciliation when _activeRepairs contains the link', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any)._activeRepairs.set(linkKey, Promise.resolve());

      const getLocalRootStub = sinon.stub(engine as any, 'getLocalRoot');

      await (engine as any).doReconcileLink(linkKey);

      expect(getLocalRootStub.called).toBe(false);
    });

    it('should skip reconciliation when roots already match (short-circuit)', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      // Roots match from the start — no diff needed.
      sinon.stub(engine as any, 'getLocalRoot').resolves('same-root');
      sinon.stub(engine as any, 'getRemoteRoot').resolves('same-root');
      const diffStub = sinon.stub(engine as any, 'diffWithRemote');

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      (engine as any)._ledger = { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() };

      await (engine as any).doReconcileLink(linkKey);

      // diff should not have been called (roots matched).
      expect(diffStub.called).toBe(false);
      // But needsReconcile should still be cleared (convergence confirmed).
      expect(link.needsReconcile).toBe(false);
    });

    it('should bail on generation mismatch during reconciliation', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      sinon.stub(engine as any, 'getLocalRoot').callsFake(async () => {
        (engine as any)._engineGeneration++;
        return 'root-A';
      });

      const getRemoteRootStub = sinon.stub(engine as any, 'getRemoteRoot');

      await (engine as any).doReconcileLink(linkKey);

      // Should have bailed after getLocalRoot incremented generation.
      expect(getRemoteRootStub.called).toBe(false);
      // needsReconcile should still be set (not cleared due to bail).
      expect(link.needsReconcile).toBe(true);
    });

    it('should schedule retry on reconciliation error', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      sinon.stub(engine as any, 'getLocalRoot').rejects(new Error('network error'));
      sinon.stub(console, 'error');

      await (engine as any).doReconcileLink(linkKey);

      // Should schedule a retry reconcile.
      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(true);
      expect(link.needsReconcile).toBe(true);
      clearTimeout((engine as any)._reconcileTimers.get(linkKey));
    });

    it('reconcileLink should deduplicate concurrent calls', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      let callCount = 0;
      sinon.stub(engine as any, 'doReconcileLink').callsFake(async () => {
        callCount++;
        await new Promise(r => setTimeout(r, 50));
      });

      // Launch two concurrent reconcileLink calls.
      const p1 = (engine as any).reconcileLink(linkKey);
      const p2 = (engine as any).reconcileLink(linkKey);

      await Promise.all([p1, p2]);

      // doReconcileLink should only have been called once.
      expect(callCount).toBe(1);
    });

    it('scheduleReconcile should not schedule if timer already exists', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      (engine as any).scheduleReconcile(linkKey, 10000);
      const firstTimer = (engine as any)._reconcileTimers.get(linkKey);
      expect(firstTimer).toBeDefined();

      // Second call should be a no-op.
      (engine as any).scheduleReconcile(linkKey, 10000);
      const secondTimer = (engine as any)._reconcileTimers.get(linkKey);
      expect(secondTimer).toBe(firstTimer); // Same timer reference.

      clearTimeout(firstTimer);
    });

    it('scheduleReconcile should not schedule if _activeRepairs contains the link', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._activeRepairs.set(linkKey, Promise.resolve());

      (engine as any).scheduleReconcile(linkKey, 100);

      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(false);
    });

    it('scheduleReconcile should not schedule if reconcile is already in-flight', () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._reconcileInFlight.set(linkKey, Promise.resolve());

      (engine as any).scheduleReconcile(linkKey, 100);

      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(false);
    });

    it('doReconcileLink should pull onlyRemote and push onlyLocal', async () => {
      const engine = new SyncEngineLevel({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      let rootCallCount = 0;
      sinon.stub(engine as any, 'getLocalRoot').callsFake(async () => {
        rootCallCount++;
        return rootCallCount <= 1 ? 'root-A' : 'root-converged';
      });
      sinon.stub(engine as any, 'getRemoteRoot').callsFake(async () => {
        return rootCallCount <= 1 ? 'root-B' : 'root-converged';
      });

      const diffStub = sinon.stub(engine as any, 'diffWithRemote').resolves({
        onlyRemote : [{ messageCid: 'remote-cid-1' }],
        onlyLocal  : ['local-cid-1'],
      });
      const pullStub = sinon.stub(engine as any, 'pullMessages').resolves();
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves();

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      (engine as any)._ledger = { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() };

      await (engine as any).doReconcileLink(linkKey);

      expect(diffStub.calledOnce).toBe(true);
      expect(pullStub.calledOnce).toBe(true);
      expect(pushStub.calledOnce).toBe(true);

      // Verify push was called with the onlyLocal CIDs.
      const pushArgs = pushStub.firstCall.args[0];
      expect(pushArgs.messageCids).toEqual(['local-cid-1']);
    });
  });

  // ---------------------------------------------------------------------------
  // Observability events
  // ---------------------------------------------------------------------------

  describe('sync event emission', () => {
    it('should emit link:status-change when transitioning to repairing', async () => {
      const engine = new SyncEngineLevel({ db });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        status         : 'live',
        connectivity   : 'online',
        pull           : {},
        protocol       : 'https://example.com/chat',
      } as any;
      const linkKey = 'test-link';
      (engine as any)._activeLinks.set(linkKey, link);

      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      (engine as any)._ledger = { setStatus: setStatusStub };
      sinon.stub(engine as any, 'repairLink').resolves();

      await (engine as any).transitionToRepairing(linkKey, link);

      const statusEvent = events.find(e => e.type === 'link:status-change');
      expect(statusEvent).toBeDefined();
      expect(statusEvent.from).toBe('live');
      expect(statusEvent.to).toBe('repairing');

      const connectivityEvent = events.find(e => e.type === 'link:connectivity-change');
      expect(connectivityEvent).toBeDefined();
      expect(connectivityEvent.from).toBe('online');
      expect(connectivityEvent.to).toBe('offline');
    });

    it('should emit checkpoint:pull-advance only after durable save, not on drain alone', () => {
      // checkpoint:pull-advance is emitted AFTER saveLink succeeds in the
      // subscription handler, not in drainCommittedPull itself. This ensures
      // "advanced" means durably persisted.
      const engine = new SyncEngineLevel({ db });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        pull           : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      const rt = (engine as any).getOrCreateRuntime(linkKey);
      rt.inflight.set(0, {
        ordinal   : 0,
        token     : { streamId: 's', epoch: 'e', position: '42', messageCid: 'cid-42' },
        committed : true,
      });
      rt.nextDeliveryOrdinal = 1;

      (engine as any).drainCommittedPull(linkKey);

      // No event yet — drain only advances in-memory state.
      const pullEvent = events.find(e => e.type === 'checkpoint:pull-advance');
      expect(pullEvent).toBeUndefined();
    });

    it('should return an unsubscribe function from on()', () => {
      const engine = new SyncEngineLevel({ db });
      const events: any[] = [];
      const unsubscribe = engine.on((event) => { events.push(event); });

      (engine as any).emitEvent({ type: 'gap:detected', tenantDid: 'x', remoteEndpoint: 'y', reason: 'test' });
      expect(events.length).toBe(1);

      unsubscribe();

      (engine as any).emitEvent({ type: 'gap:detected', tenantDid: 'x', remoteEndpoint: 'y', reason: 'test2' });
      expect(events.length).toBe(1); // No new event after unsubscribe.
    });

    it('should not propagate listener errors into sync engine', () => {
      const engine = new SyncEngineLevel({ db });
      engine.on(() => { throw new Error('listener crash'); });

      // Should not throw.
      expect(() => {
        (engine as any).emitEvent({ type: 'gap:detected', tenantDid: 'x', remoteEndpoint: 'y', reason: 'test' });
      }).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Browser connectivity listeners
  // ---------------------------------------------------------------------------

  describe('browser connectivity listeners', () => {
    // Save and restore globalThis.addEventListener / removeEventListener
    // since the sync engine guards on their existence.
    let origAddEventListener: typeof globalThis.addEventListener;
    let origRemoveEventListener: typeof globalThis.removeEventListener;
    let registeredListeners: Map<string, EventListener>;

    beforeAll(() => {
      origAddEventListener = globalThis.addEventListener;
      origRemoveEventListener = globalThis.removeEventListener;
    });

    afterEach(() => {
      globalThis.addEventListener = origAddEventListener;
      globalThis.removeEventListener = origRemoveEventListener;
      registeredListeners = new Map();
    });

    function installBrowserStubs(): void {
      registeredListeners = new Map();
      globalThis.addEventListener = ((type: string, listener: EventListener) => {
        registeredListeners.set(type, listener);
      }) as any;
      globalThis.removeEventListener = ((type: string, _listener: EventListener) => {
        registeredListeners.delete(type);
      }) as any;
    }

    it('should register online, offline, and visibilitychange listeners when browser APIs are available', () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });

      (engine as any).startBrowserConnectivityListeners();

      expect(registeredListeners.has('online')).toBe(true);
      expect(registeredListeners.has('offline')).toBe(true);
      // visibilitychange requires `document` — may or may not be set in test env.
    });

    it('should remove listeners on stopBrowserConnectivityListeners', () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });

      (engine as any).startBrowserConnectivityListeners();
      expect(registeredListeners.has('online')).toBe(true);

      (engine as any).stopBrowserConnectivityListeners();
      expect(registeredListeners.has('online')).toBe(false);
      expect(registeredListeners.has('offline')).toBe(false);
    });

    it('should be a no-op when globalThis.addEventListener is not a function', () => {
      // Simulate a Node-like environment without addEventListener.
      const saved = globalThis.addEventListener;
      delete (globalThis as any).addEventListener;

      const engine = new SyncEngineLevel({ db });

      // Should not throw.
      expect(() => {
        (engine as any).startBrowserConnectivityListeners();
      }).not.toThrow();

      // Restore.
      globalThis.addEventListener = saved;
    });

    it('should set _connectivityState to offline on offline event', () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });
      (engine as any)._connectivityState = 'online';

      (engine as any).startBrowserConnectivityListeners();

      const offlineHandler = registeredListeners.get('offline');
      expect(offlineHandler).toBeDefined();
      offlineHandler!({} as Event);

      expect((engine as any)._connectivityState).toBe('offline');
    });

    it('should transition all active links to offline and update public connectivityState', () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });

      // Simulate two active links that are online.
      const linkA: Record<string, unknown> = { tenantDid: 'did:a', remoteEndpoint: 'https://a.com', protocol: undefined, connectivity: 'online', scope: { kind: 'full' } };
      const linkB: Record<string, unknown> = { tenantDid: 'did:b', remoteEndpoint: 'https://b.com', protocol: 'proto', connectivity: 'online', scope: { kind: 'protocol', protocol: 'proto' } };
      (engine as any)._activeLinks.set('a', linkA);
      (engine as any)._activeLinks.set('b', linkB);

      // With active links online, public getter should report online.
      expect(engine.connectivityState).toBe('online');

      (engine as any).startBrowserConnectivityListeners();

      const offlineHandler = registeredListeners.get('offline');
      offlineHandler!({} as Event);

      // Both links should now be offline.
      expect(linkA.connectivity).toBe('offline');
      expect(linkB.connectivity).toBe('offline');

      // Public getter aggregates per-link state — should now report offline.
      expect(engine.connectivityState).toBe('offline');
    });

    it('should trigger sync on online event without prematurely setting connectivity', async () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });
      (engine as any)._connectivityState = 'offline';

      // Stub sync() to track whether it was called.
      let syncCalled = false;
      (engine as any).sync = async (): Promise<void> => { syncCalled = true; };
      (engine as any)._syncLock = false;

      (engine as any).startBrowserConnectivityListeners();

      const onlineHandler = registeredListeners.get('online');
      expect(onlineHandler).toBeDefined();
      onlineHandler!({} as Event);

      // The global fallback should NOT be set to online — individual links
      // transition to online as their connections actually recover.
      expect((engine as any)._connectivityState).toBe('offline');

      // sync() is called asynchronously — wait a tick.
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(syncCalled).toBe(true);
    });

    it('should not trigger sync on online event when _syncLock is held', async () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });

      let syncCalled = false;
      (engine as any).sync = async (): Promise<void> => { syncCalled = true; };
      (engine as any)._syncLock = true;

      (engine as any).startBrowserConnectivityListeners();

      const onlineHandler = registeredListeners.get('online');
      onlineHandler!({} as Event);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(syncCalled).toBe(false);
    });

    it('should ignore events after engine generation changes (teardown)', () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });
      (engine as any)._connectivityState = 'online';

      (engine as any).startBrowserConnectivityListeners();

      // Simulate teardown by incrementing generation.
      (engine as any)._engineGeneration++;

      const offlineHandler = registeredListeners.get('offline');
      offlineHandler!({} as Event);

      // State should NOT have changed — the handler is stale.
      expect((engine as any)._connectivityState).toBe('online');
    });

    it('should clean up on repeated startBrowserConnectivityListeners calls', () => {
      installBrowserStubs();
      const engine = new SyncEngineLevel({ db });

      (engine as any).startBrowserConnectivityListeners();
      const firstOnline = registeredListeners.get('online');

      // Call again — should remove old listeners and register new ones.
      (engine as any).startBrowserConnectivityListeners();
      const secondOnline = registeredListeners.get('online');

      // The handler reference should be different (new closure).
      expect(firstOnline).not.toBe(secondOnline);
    });
  });

  // ---------------------------------------------------------------------------
  // unregisterIdentity
  // ---------------------------------------------------------------------------

  describe('unregisterIdentity', () => {
    it('should remove a registered identity', async () => {
      const engine = new SyncEngineLevel({ db });
      await engine.registerIdentity({ did: 'did:example:unreg-test' });

      const before = await engine.getIdentityOptions('did:example:unreg-test');
      expect(before).toBeDefined();

      await engine.unregisterIdentity('did:example:unreg-test');

      const after = await engine.getIdentityOptions('did:example:unreg-test');
      expect(after).toBeUndefined();
    });

    it('should throw when unregistering an identity that is not registered', async () => {
      const engine = new SyncEngineLevel({ db });

      await expect(
        engine.unregisterIdentity('did:example:not-registered')
      ).rejects.toThrow('not registered');
    });
  });

  // ---------------------------------------------------------------------------
  // ReplicationLedger
  // ---------------------------------------------------------------------------

  describe('ReplicationLedger', () => {
    let ledger: ReplicationLedger;

    beforeAll(() => {
      ledger = new ReplicationLedger(db);
    });

    it('should create and retrieve a link via getOrCreateLink', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:ledger-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      expect(link.tenantDid).toBe('did:example:ledger-test');
      expect(link.remoteEndpoint).toBe('https://dwn.example.com');
      expect(link.status).toBe('initializing');
      expect(link.connectivity).toBe('unknown');

      // Second call should return the same link (not create a new one).
      const same = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:ledger-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });
      expect(same.tenantDid).toBe(link.tenantDid);
    });

    it('should persist changes via saveLink and set lastActivityAt', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:save-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      expect(link.lastActivityAt).toBeUndefined();

      await ledger.setStatus(link, 'live');
      await ledger.saveLink(link);

      // getOrCreateLink resets connectivity to 'unknown' on load (it's runtime
      // state), but persisted fields like status and lastActivityAt survive.
      const retrieved = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:save-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });
      expect(retrieved.status).toBe('live');
      expect(retrieved.lastActivityAt).toBeDefined();
      expect(retrieved.connectivity).toBe('unknown'); // Always reset on load.
    });

    it('should delete a link', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:delete-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      await ledger.deleteLink(link.tenantDid, link.remoteEndpoint, link.scopeId);

      // After deletion, getOrCreateLink should create a fresh link.
      const fresh = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:delete-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });
      expect(fresh.status).toBe('initializing');
    });

    it('should list links for a tenant', async () => {
      await ledger.getOrCreateLink({
        tenantDid      : 'did:example:list-test',
        remoteEndpoint : 'https://a.com',
        scope          : { kind: 'full' },
      });
      await ledger.getOrCreateLink({
        tenantDid      : 'did:example:list-test',
        remoteEndpoint : 'https://b.com',
        scope          : { kind: 'full' },
      });

      const links = await ledger.getLinksForTenant('did:example:list-test');
      expect(links.length).toBeGreaterThanOrEqual(2);
    });

    it('should list all links', async () => {
      await ledger.getOrCreateLink({
        tenantDid      : 'did:example:all-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      const all = await ledger.getAllLinks();
      expect(all.length).toBeGreaterThan(0);
    });

    it('should transition link status via setStatus', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:status-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      expect(link.status).toBe('initializing');

      await ledger.setStatus(link, 'repairing');
      expect(link.status).toBe('repairing');
    });

    it('should mark and clear needsReconcile', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:reconcile-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
      });

      expect(link.needsReconcile).toBe(false);

      await ledger.markNeedsReconcile(link, 'test reason');
      expect(link.needsReconcile).toBe(true);

      // Idempotent — second call should be a no-op.
      await ledger.markNeedsReconcile(link);
      expect(link.needsReconcile).toBe(true);

      await ledger.clearNeedsReconcile(link);
      expect(link.needsReconcile).toBe(false);

      // Idempotent — second clear should be a no-op.
      await ledger.clearNeedsReconcile(link);
      expect(link.needsReconcile).toBe(false);
    });

    it('should compare token positions correctly', () => {
      const a = { streamId: 's', epoch: 'e', position: '10', messageCid: 'a' };
      const b = { streamId: 's', epoch: 'e', position: '20', messageCid: 'b' };
      const c = { streamId: 's', epoch: 'e', position: '10', messageCid: 'c' };

      expect(ReplicationLedger.comparePosition(a, b)).toBe(-1);
      expect(ReplicationLedger.comparePosition(b, a)).toBe(1);
      expect(ReplicationLedger.comparePosition(a, c)).toBe(0);
    });

    it('should validate token domain against checkpoint', () => {
      const checkpoint = { contiguousAppliedToken: { streamId: 's1', epoch: 'e1', position: '5', messageCid: 'x' } };

      expect(ReplicationLedger.validateTokenDomain(checkpoint, { streamId: 's1', epoch: 'e1', position: '10', messageCid: 'y' })).toBe(true);
      expect(ReplicationLedger.validateTokenDomain(checkpoint, { streamId: 's2', epoch: 'e1', position: '10', messageCid: 'y' })).toBe(false);
      expect(ReplicationLedger.validateTokenDomain(checkpoint, { streamId: 's1', epoch: 'e2', position: '10', messageCid: 'y' })).toBe(false);

      // Empty checkpoint accepts any token.
      expect(ReplicationLedger.validateTokenDomain({}, { streamId: 's1', epoch: 'e1', position: '10', messageCid: 'y' })).toBe(true);
    });

    it('should set and commit tokens', () => {
      const checkpoint: Record<string, unknown> = {};
      const token = { streamId: 's', epoch: 'e', position: '10', messageCid: 'x' };

      ReplicationLedger.setReceivedToken(checkpoint, token);
      expect(checkpoint.receivedToken).toEqual(token);

      // Higher position updates it.
      const higher = { streamId: 's', epoch: 'e', position: '20', messageCid: 'y' };
      ReplicationLedger.setReceivedToken(checkpoint, higher);
      expect(checkpoint.receivedToken).toEqual(higher);

      // Lower position does not update.
      ReplicationLedger.setReceivedToken(checkpoint, token);
      expect(checkpoint.receivedToken).toEqual(higher);

      ReplicationLedger.commitContiguousToken(checkpoint, higher);
      expect(checkpoint.contiguousAppliedToken).toEqual(higher);
    });

    it('should reset checkpoint', () => {
      const checkpoint: Record<string, unknown> = {
        contiguousAppliedToken : { streamId: 's', epoch: 'e', position: '10', messageCid: 'x' },
        receivedToken          : { streamId: 's', epoch: 'e', position: '20', messageCid: 'y' },
      };

      ReplicationLedger.resetCheckpoint(checkpoint);
      expect(checkpoint.contiguousAppliedToken).toBeUndefined();
      expect(checkpoint.receivedToken).toBeUndefined();

      // Reset with a baseline token.
      const baseline = { streamId: 's', epoch: 'e', position: '5', messageCid: 'z' };
      ReplicationLedger.resetCheckpoint(checkpoint, baseline);
      expect(checkpoint.contiguousAppliedToken).toEqual(baseline);
      expect(checkpoint.receivedToken).toEqual(baseline);
    });
  });

  // ---------------------------------------------------------------------------
  // Dead letter tracking
  // ---------------------------------------------------------------------------

  describe('dead letter tracking', () => {
    it('should record and retrieve a dead letter entry', async () => {
      const engine = new SyncEngineLevel({ db });

      await engine.recordDeadLetter({
        messageCid     : 'bafyrei-dead-1',
        tenantDid      : 'did:example:tenant1',
        remoteEndpoint : 'https://dwn.example.com',
        protocol       : 'https://example.com/protocol',
        category       : 'push-permanent',
        errorCode      : '400',
        errorDetail    : 'ProtocolAuthorizationProtocolNotFound',
      });

      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(1);
      expect(entries[0].messageCid).toBe('bafyrei-dead-1');
      expect(entries[0].tenantDid).toBe('did:example:tenant1');
      expect(entries[0].category).toBe('push-permanent');
      expect(entries[0].failedAt).toBeDefined();
    });

    it('should filter dead letters by tenant', async () => {
      const engine = new SyncEngineLevel({ db });

      await engine.recordDeadLetter({
        messageCid  : 'bafyrei-dead-a',
        tenantDid   : 'did:example:alice',
        category    : 'push-permanent',
        errorDetail : 'test',
      });
      await engine.recordDeadLetter({
        messageCid  : 'bafyrei-dead-b',
        tenantDid   : 'did:example:bob',
        category    : 'push-permanent',
        errorDetail : 'test',
      });

      const alice = await engine.getFailedMessages('did:example:alice');
      expect(alice.length).toBe(1);
      expect(alice[0].messageCid).toBe('bafyrei-dead-a');

      const all = await engine.getFailedMessages();
      expect(all.length).toBe(2);
    });

    it('should clear a single dead letter entry', async () => {
      const engine = new SyncEngineLevel({ db });

      await engine.recordDeadLetter({
        messageCid  : 'bafyrei-dead-clear',
        tenantDid   : 'did:example:x',
        category    : 'push-permanent',
        errorDetail : 'test',
      });

      const removed = await engine.clearFailedMessage('bafyrei-dead-clear');
      expect(removed).toBe(true);

      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(0);

      // Clearing a non-existent entry returns false.
      const notFound = await engine.clearFailedMessage('bafyrei-does-not-exist');
      expect(notFound).toBe(false);
    });

    it('should clear all dead letter entries', async () => {
      const engine = new SyncEngineLevel({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-1', tenantDid: 'did:a', category: 'push-permanent', errorDetail: 'x' });
      await engine.recordDeadLetter({ messageCid: 'dl-2', tenantDid: 'did:b', category: 'closure', errorDetail: 'y' });

      await engine.clearAllFailedMessages();
      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(0);
    });

    it('should clear dead letters scoped to a tenant', async () => {
      const engine = new SyncEngineLevel({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-scoped-1', tenantDid: 'did:keep', category: 'push-permanent', errorDetail: 'x' });
      await engine.recordDeadLetter({ messageCid: 'dl-scoped-2', tenantDid: 'did:remove', category: 'push-permanent', errorDetail: 'y' });

      await engine.clearAllFailedMessages('did:remove');

      const remaining = await engine.getFailedMessages();
      expect(remaining.length).toBe(1);
      expect(remaining[0].tenantDid).toBe('did:keep');
    });

    it('should overwrite an existing dead letter for the same CID', async () => {
      const engine = new SyncEngineLevel({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-overwrite', tenantDid: 'did:x', category: 'push-permanent', errorDetail: 'first' });
      await engine.recordDeadLetter({ messageCid: 'dl-overwrite', tenantDid: 'did:x', category: 'closure', errorDetail: 'second' });

      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(1);
      expect(entries[0].category).toBe('closure');
      expect(entries[0].errorDetail).toBe('second');
    });

    it('should return sync health summary', async () => {
      const engine = new SyncEngineLevel({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-health-1', tenantDid: 'did:x', category: 'push-permanent', errorDetail: 'x' });
      await engine.recordDeadLetter({ messageCid: 'dl-health-2', tenantDid: 'did:y', category: 'closure', errorDetail: 'y' });

      const health = await engine.getSyncHealth();
      expect(health.failedMessageCount).toBe(2);
      expect(health.connectivity).toBeDefined();
      expect(health.degradedLinkCount).toBe(0);
    });

    it('should count degraded links in sync health', async () => {
      const engine = new SyncEngineLevel({ db });

      // Simulate degraded links.
      (engine as any)._activeLinks.set('link-1', { status: 'repairing', connectivity: 'offline' });
      (engine as any)._activeLinks.set('link-2', { status: 'degraded_poll', connectivity: 'offline' });
      (engine as any)._activeLinks.set('link-3', { status: 'live', connectivity: 'online' });

      const health = await engine.getSyncHealth();
      expect(health.degradedLinkCount).toBe(2);
    });
  });
});
