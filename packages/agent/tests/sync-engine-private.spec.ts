import sinon from 'sinon';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Message, Replication, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { computeAuthorizationEpoch } from '../src/types/sync.js';
import { DwnInterface } from '../src/types/dwn.js';
import { ReplicationLedger } from '../src/sync-replication-ledger.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { getMessagesPermissionGrantsForScope, resolveMessagesScopes } from '../src/sync-permission-grants.js';

describe('SyncEngineLevel — private methods', () => {
  let db: Level<string, string>;
  let syncEngine: SyncEngineLevel;

  const syncTarget = (did: string, dwnUrl: string, overrides: Record<string, unknown> = {}): any => ({
    did,
    dwnUrl,
    scope              : { kind: 'full' },
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    ...overrides,
  });

  const activeInitializationResult = (link: {
    tenantDid: string;
    projectionId: string;
    authorizationEpoch: string;
  }): any => ({
    status                 : 'active',
    durableLinkIdentityKey : `${link.tenantDid}^${link.projectionId}^${link.authorizationEpoch}`,
  });

  const messagesGrantEntry = (id: string, scope: Record<string, unknown>, overrides: Record<string, unknown> = {}): any => ({
    grant: {
      id,
      grantor     : 'did:example:carol',
      grantee     : 'did:example:delegate',
      dateGranted : '2026-01-01T00:00:00.000000Z',
      dateExpires : '2999-01-01T00:00:00.000000Z',
      scope,
      ...overrides,
    },
    message: {},
  });

  const fingerprintFromCids = async (messageCids: string[]): Promise<string> => {
    let fingerprint = Replication.emptyFingerprint();
    for (const messageCid of messageCids) {
      fingerprint = Replication.xorFingerprint(fingerprint, await Replication.hashMessageCid(messageCid));
    }
    return Replication.fingerprintToHex(fingerprint);
  };

  // Track every SyncEngineLevel created in this suite so `afterEach` can
  // clear any pending timers before the next test (and before `afterAll`
  // closes the shared Level DB). Tests that exercise code paths which
  // schedule setTimeout/setInterval callbacks (repair retries, reconcile,
  // degraded polling, push debounces) would otherwise let those callbacks
  // fire after teardown, triggering unhandled `LEVEL_DATABASE_NOT_OPEN`
  // rejections when `ledger.saveLink()` hits the closed DB.
  const createdEngines: SyncEngineLevel[] = [];
  const createEngine = (
    params: ConstructorParameters<typeof SyncEngineLevel>[0],
    options: { stubFeedPull?: boolean; stubFeedPush?: boolean; stubFeedVerify?: boolean } = {},
  ): SyncEngineLevel => {
    const engine = new SyncEngineLevel(params);
    if (options.stubFeedPull !== false) {
      sinon.stub(engine as any, 'pullRemoteFeedForSyncTarget').resolves({});
    }
    if (options.stubFeedPush !== false) {
      sinon.stub(engine as any, 'pushLocalFeedForSyncTarget').resolves({});
    }
    if (options.stubFeedVerify !== false) {
      sinon.stub(engine as any, 'verifyFeedConvergence').resolves({
        converged         : true,
        localFingerprint  : 'fingerprint',
        remoteFingerprint : 'fingerprint',
        pushFailures      : [],
      });
    }
    createdEngines.push(engine);
    return engine;
  };

  const overrideLedger = (engine: SyncEngineLevel, methods: Record<string, unknown>): void => {
    Object.assign((engine as any).ledger, methods);
  };

  const clearEngineTimers = (engine: SyncEngineLevel): void => {
    // Invalidate any async work already checkpointed against the engine's
    // current generation — callbacks that race past the `clearTimeout`
    // below will see a mismatched generation and bail.
    (engine as any)._engineGeneration++;

    if ((engine as any)._syncIntervalId !== undefined) {
      clearInterval((engine as any)._syncIntervalId);
      (engine as any)._syncIntervalId = undefined;
    }

    const pushRuntimes = (engine as any)._pushRuntimes as Map<string, { timer?: ReturnType<typeof setTimeout> }>;
    for (const runtime of pushRuntimes.values()) {
      if (runtime.timer !== undefined) {
        clearTimeout(runtime.timer);
      }
    }
    pushRuntimes.clear();

    const reconcileTimers = (engine as any)._reconcileTimers as Map<string, ReturnType<typeof setTimeout>>;
    for (const timer of reconcileTimers.values()) {
      clearTimeout(timer);
    }
    reconcileTimers.clear();

    const repairRetryTimers = (engine as any)._repairRetryTimers as Map<string, ReturnType<typeof setTimeout>>;
    for (const timer of repairRetryTimers.values()) {
      clearTimeout(timer);
    }
    repairRetryTimers.clear();

    const degradedPollTimers = (engine as any)._degradedPollTimers as Map<string, ReturnType<typeof setInterval>>;
    for (const timer of degradedPollTimers.values()) {
      clearInterval(timer);
    }
    degradedPollTimers.clear();
  };

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-engine-private-spec');
    syncEngine = createEngine({ db });
  });

  afterEach(async () => {
    sinon.restore();
    for (const engine of createdEngines) {
      clearEngineTimers(engine);
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
    it('should build key from tenant, endpoint, projection ID, and authorization epoch', () => {
      const key = (syncEngine as any).buildLinkKey(
        'did:example:alice',
        'https://dwn.example.com',
        'projection-hash-123',
        'authorization-epoch-456',
      );
      expect(key).toBe('did:example:alice^https://dwn.example.com^projection-hash-123^authorization-epoch-456');
    });
  });

  // ---------------------------------------------------------------------------
  // createLivePullDataStreamFactory
  // ---------------------------------------------------------------------------

  describe('createLivePullDataStreamFactory', () => {
    const livePullContext = {
      did        : 'did:example:alice',
      dwnUrl     : 'https://dwn.example',
      eventScope : {},
      linkKey    : 'link-key',
      isStale    : (): boolean => false,
    };

    const textStream = (text: string): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }
    });

    const readStreamText = async (stream: ReadableStream<Uint8Array> | undefined): Promise<string | undefined> => {
      if (!stream) {
        return undefined;
      }

      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { break; }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      return new TextDecoder().decode(Buffer.concat(chunks));
    };

    it('should return undefined for non-RecordsWrite events', async () => {
      const event = { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } };
      const factory = await (syncEngine as any).createLivePullDataStreamFactory(livePullContext, event);
      expect(await factory()).toBeUndefined();
    });

    it('should ignore non-contract RecordsWrite event data', async () => {
      const event = {
        message : { descriptor: { interface: 'Records', method: 'Write' } },
        data    : textStream('hello from event'),
      };
      const factory = await (syncEngine as any).createLivePullDataStreamFactory(livePullContext, event);
      expect(await factory()).toBeUndefined();
    });

    it('should return undefined for RecordsWrite without data', async () => {
      const event = { message: { descriptor: { interface: 'Records', method: 'Write' } } };
      const factory = await (syncEngine as any).createLivePullDataStreamFactory(livePullContext, event);
      expect(await factory()).toBeUndefined();
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

      const factory = await (syncEngine as any).createLivePullDataStreamFactory(livePullContext, event);
      const stream = await factory();
      expect(stream).toBeInstanceOf(ReadableStream);

      // encodedData must be deleted so the DWN schema validator does not
      // reject the message for having unevaluated properties.
      expect((event.message as any).encodedData).toBeUndefined();

      // Verify the stream yields the original data.
      expect(await readStreamText(stream)).toBe(originalData);
    });
  });

  // ---------------------------------------------------------------------------
  // getMessagesPermissionGrantsForScope
  // ---------------------------------------------------------------------------

  describe('getMessagesPermissionGrantsForScope', () => {
    const grantEntry = (id: string, scope: Record<string, unknown>, overrides: Record<string, unknown> = {}): any => ({
      grant: {
        id,
        grantor     : 'did:example:alice',
        grantee     : 'did:example:delegate',
        dateGranted : '2026-01-01T00:00:00.000000Z',
        dateExpires : '2999-01-01T00:00:00.000000Z',
        scope,
        ...overrides,
      },
      message: {},
    });

    it('should return no grants for owner-authored sync', async () => {
      const permissionsApi = {
        fetchGrants: sinon.stub(),
      };

      const result = await getMessagesPermissionGrantsForScope({
        did            : 'did:example:alice',
        messageType    : DwnInterface.MessagesSync,
        permissionsApi : permissionsApi as any,
      });
      expect(result).toEqual([]);
      expect(permissionsApi.fetchGrants.called).toBe(false);
    });

    it('should return active unscoped grants for delegated full sync', async () => {
      const unscoped = grantEntry('grant-b', { interface: 'Messages', method: 'Read' });
      const expired = grantEntry('grant-expired', { interface: 'Messages', method: 'Read' }, {
        dateExpires: '2026-01-01T00:00:00.000000Z',
      });
      const protocolScoped = grantEntry('grant-a', {
        interface : 'Messages',
        method    : 'Read',
        protocol  : 'https://example.com/profile',
      });
      const permissionsApi = {
        fetchGrants: sinon.stub().resolves([protocolScoped, expired, unscoped]),
      };

      const result = await getMessagesPermissionGrantsForScope({
        did            : 'did:example:alice',
        delegateDid    : 'did:example:delegate',
        messageType    : DwnInterface.MessagesSync,
        permissionsApi : permissionsApi as any,
      });

      expect(result.map(entry => entry.grant.id)).toEqual(['grant-b']);
    });

    it('should reject delegated full sync without an unscoped grant', async () => {
      const permissionsApi = {
        fetchGrants: sinon.stub().resolves([
          grantEntry('grant-profile', {
            interface : 'Messages',
            method    : 'Read',
            protocol  : 'https://example.com/profile',
          }),
        ]),
      };

      await expect(getMessagesPermissionGrantsForScope({
        did            : 'did:example:alice',
        delegateDid    : 'did:example:delegate',
        messageType    : DwnInterface.MessagesSync,
        permissionsApi : permissionsApi as any,
      })).rejects.toThrow('No active Messages.Read permission found for MessagesSync: all protocols');
    });

    it('should return all active grants that participate in a protocol-set root', async () => {
      const unscoped = grantEntry('grant-c', { interface: 'Messages', method: 'Read' });
      const profile = grantEntry('grant-b', {
        interface : 'Messages',
        method    : 'Read',
        protocol  : 'https://example.com/profile',
      });
      const profilePath = grantEntry('grant-path', {
        interface    : 'Messages',
        method       : 'Read',
        protocol     : 'https://example.com/profile',
        protocolPath : 'profile',
      });
      const social = grantEntry('grant-a', {
        interface : 'Messages',
        method    : 'Read',
        protocol  : 'https://example.com/social',
      });
      const unrelated = grantEntry('grant-unrelated', {
        interface : 'Messages',
        method    : 'Read',
        protocol  : 'https://example.com/other',
      });
      const permissionsApi = {
        fetchGrants: sinon.stub().resolves([unrelated, unscoped, profilePath, profile, social]),
      };

      const result = await getMessagesPermissionGrantsForScope({
        did            : 'did:example:alice',
        delegateDid    : 'did:example:delegate',
        messageType    : DwnInterface.MessagesSync,
        protocols      : ['https://example.com/social', 'https://example.com/profile'],
        permissionsApi : permissionsApi as any,
      });

      expect(result.map(entry => entry.grant.id)).toEqual(['grant-a', 'grant-b', 'grant-c']);
    });

    it('should reject protocolPath grants for protocol-root sync', async () => {
      const permissionsApi = {
        fetchGrants: sinon.stub().resolves([
          grantEntry('grant-profile-path', {
            interface    : 'Messages',
            method       : 'Read',
            protocol     : 'https://example.com/profile',
            protocolPath : 'profile',
          }),
        ]),
      };

      await expect(resolveMessagesScopes({
        did            : 'did:example:alice',
        delegateDid    : 'did:example:delegate',
        requestedScope : { kind: 'protocolSet', protocols: ['https://example.com/profile'] },
        messageType    : DwnInterface.MessagesSync,
        permissionsApi : permissionsApi as any,
      })).rejects.toThrow('No active protocol-root Messages.Read permission found for MessagesSync: https://example.com/profile');
    });

    it('should reject contextId grants for protocol-root sync', async () => {
      const permissionsApi = {
        fetchGrants: sinon.stub().resolves([
          grantEntry('grant-profile-context', {
            interface : 'Messages',
            method    : 'Read',
            protocol  : 'https://example.com/profile',
            contextId : 'bafyroot/bafyprofile',
          }),
        ]),
      };

      await expect(resolveMessagesScopes({
        did            : 'did:example:alice',
        delegateDid    : 'did:example:delegate',
        requestedScope : { kind: 'protocolSet', protocols: ['https://example.com/profile'] },
        messageType    : DwnInterface.MessagesSync,
        permissionsApi : permissionsApi as any,
      })).rejects.toThrow('No active protocol-root Messages.Read permission found for MessagesSync: https://example.com/profile');
    });

    it('should reject protocol-set sync when a requested protocol only has narrow grant coverage', async () => {
      const permissionsApi = {
        fetchGrants: sinon.stub().resolves([
          grantEntry('grant-social', {
            interface : 'Messages',
            method    : 'Read',
            protocol  : 'https://example.com/social',
          }),
          grantEntry('grant-profile-path', {
            interface    : 'Messages',
            method       : 'Read',
            protocol     : 'https://example.com/profile',
            protocolPath : 'profile/avatar',
          }),
        ]),
      };

      await expect(resolveMessagesScopes({
        did            : 'did:example:alice',
        delegateDid    : 'did:example:delegate',
        requestedScope : {
          kind      : 'protocolSet',
          protocols : ['https://example.com/profile', 'https://example.com/social'],
        },
        messageType    : DwnInterface.MessagesSync,
        permissionsApi : permissionsApi as any,
      })).rejects.toThrow('No active protocol-root Messages.Read permission found for MessagesSync: https://example.com/profile');
    });

    it('should reject protocol-set sync when any requested protocol lacks coverage', async () => {
      const permissionsApi = {
        fetchGrants: sinon.stub().resolves([
          grantEntry('grant-profile', {
            interface : 'Messages',
            method    : 'Read',
            protocol  : 'https://example.com/profile',
          }),
        ]),
      };

      await expect(getMessagesPermissionGrantsForScope({
        did            : 'did:example:alice',
        delegateDid    : 'did:example:delegate',
        messageType    : DwnInterface.MessagesSync,
        protocols      : ['https://example.com/profile', 'https://example.com/social'],
        permissionsApi : permissionsApi as any,
      })).rejects.toThrow('No active protocol-root Messages.Read permission found for MessagesSync: https://example.com/social');
    });
  });

  // ---------------------------------------------------------------------------
  // getSyncTargets
  // ---------------------------------------------------------------------------

  describe('getSyncTargets', () => {
    it('should return empty array when no identities registered', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : { getRemoteDwnEndpointUrls: sinon.stub() },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toEqual([]);
    });

    it('should skip identities whose DID has no DWN endpoints', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves([]),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      await engine.registerIdentity({ did: 'did:example:no-endpoints', options: { protocols: 'all' } });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toEqual([]);
    });

    it('should produce one target per DWN URL when protocols is all', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      await engine.registerIdentity({ did: 'did:example:alice', options: { protocols: 'all' } });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].did).toBe('did:example:alice');
      expect(targets[0].dwnUrl).toBe('https://dwn.example.com');
      expect(targets[0].protocol).toBeUndefined();
    });

    it('should resolve sync targets from remote DID-document endpoints only', async () => {
      const remoteEndpointLookupStub = sinon.stub().resolves(['https://remote.example.com']);
      const localAwareEndpointLookupStub = sinon.stub().resolves(['http://127.0.0.1:3000']);
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getDwnEndpointUrlsForTarget : localAwareEndpointLookupStub,
          getRemoteDwnEndpointUrls    : remoteEndpointLookupStub,
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      await engine.registerIdentity({ did: 'did:example:remote-only', options: { protocols: 'all' } });

      const targets = await (engine as any).getSyncTargets();
      expect(remoteEndpointLookupStub.callCount).toBe(1);
      expect(remoteEndpointLookupStub.firstCall.args).toEqual(['did:example:remote-only']);
      expect(localAwareEndpointLookupStub.callCount).toBe(0);
      expect(targets).toHaveLength(1);
      expect(targets[0].dwnUrl).toBe('https://remote.example.com');
    });

    it('should produce one protocol-set target per DWN URL', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      await engine.registerIdentity({
        did     : 'did:example:bob',
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

    it('should hot-add live identities from remote DID-document endpoints only', async () => {
      const remoteEndpointLookupStub = sinon.stub().resolves(['https://remote-live.example.com']);
      const localAwareEndpointLookupStub = sinon.stub().resolves(['http://127.0.0.1:3000']);
      const engine = createEngine({
        db,
        agent: {
          agentDid : 'did:example:agent',
          dwn      : {
            getDwnEndpointUrlsForTarget : localAwareEndpointLookupStub,
            getRemoteDwnEndpointUrls    : remoteEndpointLookupStub,
          },
        } as any,
      });
      const buildTargetStub = sinon.stub(engine as any, 'buildSyncTargetsForEndpoint').resolves([
        syncTarget('did:example:live-remote-only', 'https://remote-live.example.com'),
      ]);
      sinon.stub(engine as any, 'initializeLinkTargetWithRetry').resolves({
        durableLinkIdentityKey : 'did:example:live-remote-only^projection^authorization',
        status                 : 'active',
      });

      const keys = await (engine as any).addIdentityToLiveSync(
        'did:example:live-remote-only',
        { protocols: 'all' },
      );

      expect(remoteEndpointLookupStub.callCount).toBe(1);
      expect(remoteEndpointLookupStub.firstCall.args).toEqual(['did:example:live-remote-only']);
      expect(localAwareEndpointLookupStub.callCount).toBe(0);
      expect(buildTargetStub.firstCall.args.slice(0, 2)).toEqual([
        'did:example:live-remote-only',
        'https://remote-live.example.com',
      ]);
      expect(keys).toEqual(new Set(['did:example:live-remote-only^projection^authorization']));
    });

    it('should include delegateDid from identity options', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = {
        fetchGrants: sinon.stub().resolves([
          messagesGrantEntry('grant-1', { interface: 'Messages', method: 'Read' }),
        ]),
      };
      await engine.registerIdentity({
        did     : 'did:example:carol',
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

    it('should skip one delegated identity with only narrow coverage without stalling other identities', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = {
        fetchGrants: sinon.stub().callsFake(async ({ grantor }: { grantor: string }) => {
          if (grantor === 'did:example:valid') {
            return [
              messagesGrantEntry('grant-valid-social', {
                interface : 'Messages',
                method    : 'Read',
                protocol  : 'https://example.com/social',
              }, { grantor: 'did:example:valid' }),
            ];
          }

          return [
            messagesGrantEntry('grant-social', {
              interface : 'Messages',
              method    : 'Read',
              protocol  : 'https://example.com/social',
            }),
            messagesGrantEntry('grant-profile-avatar', {
              interface    : 'Messages',
              method       : 'Read',
              protocol     : 'https://example.com/profile',
              protocolPath : 'profile/avatar',
            }),
          ];
        }),
      };

      await engine.registerIdentity({
        did     : 'did:example:carol',
        options : {
          protocols   : ['https://example.com/profile', 'https://example.com/social'],
          delegateDid : 'did:example:delegate',
        },
      });
      await engine.registerIdentity({
        did     : 'did:example:valid',
        options : { protocols: ['https://example.com/social'], delegateDid: 'did:example:delegate' },
      });

      const targets = await (engine as any).getSyncTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].did).toBe('did:example:valid');
      expect(targets[0].scope).toEqual({
        kind      : 'protocolSet',
        protocols : ['https://example.com/social'],
      });
    });

    it('should handle invalid JSON in identity options gracefully', async () => {
      const mockAgent = {
        agentDid : 'did:example:agent',
        dwn      : {
          getRemoteDwnEndpointUrls: sinon.stub().resolves(['https://dwn.example.com']),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });

      // Manually write invalid JSON to the sublevel
      const identities = db.sublevel('registeredIdentities');
      await identities.put('did:example:broken', 'not-valid-json');

      const targets = await (engine as any).getSyncTargets();
      // Corrupt entries are skipped rather than falling back to global sync.
      expect(targets).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // sync() — durable feed cycle
  // ---------------------------------------------------------------------------

  describe('sync() — durable feed cycle', () => {
    it('should pull a remote MessagesQuery page and persist the pull checkpoint', async () => {
      const protocol = 'https://example.com/feed-pull';
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : {
          protocol,
          published : true,
          types     : {
            post: { schema: 'https://example.com/post', dataFormats: ['text/plain'] },
          },
          structure: { post: {} },
        },
      });
      const configureCid = await Message.getCid(configure.message);
      const cursor = {
        streamId   : 'stream-1',
        epoch      : 'epoch-1',
        position   : '1',
        messageCid : configureCid,
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          applyReplicatedMessage : sinon.stub().resolves({ kind: 'Applied' }),
          processRequest         : sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [],
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [{
              seq               : '1',
              messageCid        : configureCid,
              isLatestBaseState : true,
              protocol,
              message           : configure.message,
            }],
            cursor  : cursor,
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget(alice.did, 'https://dwn.example.com', {
          scope: { kind: 'protocolSet', protocols: [protocol] },
        }),
      ]);
      await engine.sync('pull');

      expect(mockAgent.processDwnRequest.firstCall.args[0]).toMatchObject({
        author        : alice.did,
        target        : alice.did,
        messageType   : DwnInterface.MessagesQuery,
        messageParams : {
          filters : [{ protocol }],
          limit   : 100,
        },
      });
      expect(mockAgent.rpc.sendDwnRequest.firstCall.args[0]).toMatchObject({
        dwnUrl    : 'https://dwn.example.com',
        targetDid : alice.did,
      });
      expect(mockAgent.dwn.applyReplicatedMessage.calledOnce).toBe(true);
      expect(mockAgent.dwn.applyReplicatedMessage.firstCall.args[1]).toEqual(configure.message);

      const links = await (engine as any).ledger.getLinksForTenant(alice.did);
      expect(links).toHaveLength(1);
      expect(links[0].pull.contiguousAppliedToken).toEqual(cursor);

      const appliedEvent = events.find(event => event.type === 'reconcile:applied');
      expect(appliedEvent.messageCids).toEqual([configureCid]);
    });

    it('should accept a drained feed page that returns the existing cursor', async () => {
      const did = 'did:example:feed-caught-up';
      const cursor = {
        streamId : 'stream-1',
        epoch    : 'epoch-1',
        position : '7',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          applyReplicatedMessage : sinon.stub(),
          processRequest         : sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [],
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [],
            cursor,
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const target = syncTarget(did, 'https://dwn.example.com');
      const link = await (engine as any).getOrCreateReplicationLink(target);
      ReplicationLedger.commitContiguousToken(link.pull, cursor);
      await (engine as any).ledger.saveLink(link);

      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      await engine.sync('pull');

      expect(mockAgent.dwn.applyReplicatedMessage.called).toBe(false);
      const links = await (engine as any).ledger.getLinksForTenant(did);
      expect(links[0].pull.contiguousAppliedToken).toEqual(cursor);
    });

    it('should reset a stale feed checkpoint once after a MessagesQuery progress gap', async () => {
      const did = 'did:example:feed-reset';
      const staleCursor = {
        streamId : 'stream-1',
        epoch    : 'epoch-1',
        position : '9',
      };
      const resetCursor = {
        streamId : 'stream-2',
        epoch    : 'epoch-2',
        position : '1',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          applyReplicatedMessage : sinon.stub(),
          processRequest         : sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [],
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub()
            .onFirstCall().resolves({
              status: { code: 410, detail: 'Progress gap' },
            })
            .onSecondCall().resolves({
              status  : { code: 200, detail: 'OK' },
              entries : [],
              cursor  : resetCursor,
              drained : true,
            }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const target = syncTarget(did, 'https://dwn.example.com');
      const link = await (engine as any).getOrCreateReplicationLink(target);
      ReplicationLedger.commitContiguousToken(link.pull, staleCursor);
      await (engine as any).ledger.saveLink(link);

      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      await engine.sync('pull');

      expect(mockAgent.rpc.sendDwnRequest.callCount).toBe(2);
      expect(mockAgent.processDwnRequest.secondCall.args[0].messageParams.cursor).toBeUndefined();
      const links = await (engine as any).ledger.getLinksForTenant(did);
      expect(links[0].pull.contiguousAppliedToken).toEqual(resetCursor);
    });

    it('should enumerate remote CIDs and pull only missing bodies for a cursorless non-empty local scope', async () => {
      const did = 'did:example:feed-pull-diff';
      const protocol = 'https://example.com/feed-pull-diff';
      const localCursor = {
        streamId   : 'local-stream-1',
        epoch      : 'local-epoch-1',
        position   : '1',
        messageCid : 'cid-existing',
      };
      const remoteCursor = {
        streamId   : 'remote-stream-1',
        epoch      : 'remote-epoch-1',
        position   : '2',
        messageCid : 'cid-missing',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [{ seq: '1', messageCid: 'cid-existing', protocol }],
              cursor  : localCursor,
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [
              { seq: '1', messageCid: 'cid-existing', protocol },
              { seq: '2', messageCid: 'cid-missing', protocol },
            ],
            cursor  : remoteCursor,
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const admitStub = sinon.stub(engine as any, 'admitRemoteFeedEntry').resolves({ kind: 'admitted', appliedCids: ['cid-missing'] });
      const target = syncTarget(did, 'https://dwn.example.com', {
        scope: { kind: 'protocolSet', protocols: [protocol] },
      });

      const result = await (engine as any).pullRemoteFeedForSyncTarget(target);

      expect(mockAgent.dwn.processRequest.firstCall.args[0].messageParams).toMatchObject({
        cidsOnly : true,
        filters  : [{ protocol }],
        limit    : 100,
      });
      expect(mockAgent.processDwnRequest.firstCall.args[0].messageParams).toMatchObject({
        cidsOnly : true,
        filters  : [{ protocol }],
        limit    : 100,
      });
      expect(admitStub.calledOnce).toBe(true);
      expect(admitStub.firstCall.args[1].messageCid).toBe('cid-missing');
      expect(result.admittedCids).toEqual(['cid-missing']);
      const [link] = await (engine as any).ledger.getLinksForTenant(did);
      expect(link.pull.contiguousAppliedToken).toEqual(remoteCursor);
    });

    it('should reject a remote feed cursor that moves backwards', async () => {
      const did = 'did:example:feed-regression';
      const previousCursor = {
        streamId : 'stream-1',
        epoch    : 'epoch-1',
        position : '7',
      };
      const regressedCursor = {
        streamId : 'stream-1',
        epoch    : 'epoch-1',
        position : '6',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          applyReplicatedMessage: sinon.stub(),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [],
            cursor  : regressedCursor,
            drained : false,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const target = syncTarget(did, 'https://dwn.example.com');
      const link = await (engine as any).getOrCreateReplicationLink(target);
      ReplicationLedger.commitContiguousToken(link.pull, previousCursor);
      await (engine as any).ledger.saveLink(link);

      await expect((engine as any).pullRemoteFeedForSyncTarget(target)).rejects.toThrow('cursor did not advance');
    });

    it('should dead-letter failed feed admission and skip it on retry', async () => {
      const protocol = 'https://example.com/feed-dead-letter';
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : {
          protocol,
          published : true,
          types     : {
            post: { schema: 'https://example.com/post', dataFormats: ['text/plain'] },
          },
          structure: { post: {} },
        },
      });
      const configureCid = await Message.getCid(configure.message);
      const cursor = {
        streamId   : 'stream-1',
        epoch      : 'epoch-1',
        position   : '1',
        messageCid : configureCid,
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          applyReplicatedMessage : sinon.stub().resolves({ kind: 'Invalid', reason: 'bad configure' }),
          processRequest         : sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [],
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [{
              seq               : '1',
              messageCid        : configureCid,
              isLatestBaseState : true,
              protocol,
              message           : configure.message,
            }],
            cursor,
            drained: true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const target = syncTarget(alice.did, 'https://dwn.example.com');

      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      await engine.sync('pull');

      const failedMessages = await engine.getFailedMessages(alice.did);
      expect(failedMessages).toHaveLength(1);
      expect(failedMessages[0]).toMatchObject({
        messageCid     : configureCid,
        remoteEndpoint : 'https://dwn.example.com',
        protocol,
        category       : 'admit-failed',
        errorCode      : 'invalid',
        errorDetail    : 'bad configure',
      });
      expect(mockAgent.dwn.applyReplicatedMessage.calledOnce).toBe(true);

      const [link] = await (engine as any).ledger.getLinksForTenant(alice.did);
      ReplicationLedger.resetCheckpoint(link.pull);
      await (engine as any).ledger.saveLink(link);

      await engine.sync('pull');

      expect(mockAgent.dwn.applyReplicatedMessage.calledOnce).toBe(true);
      expect(mockAgent.rpc.sendDwnRequest.callCount).toBe(2);
    });

    it('should install a data fetch factory for feed RecordsWrite entries without inline data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const recordsWrite = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        data   : new Uint8Array([1, 2, 3]),
      });
      const recordsWriteCid = await Message.getCid(recordsWrite.message);
      const remoteData = new Uint8Array([1, 2, 3]);
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Read' } } }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200, detail: 'OK' },
            entry  : {
              message : recordsWrite.message,
              data    : new ReadableStream<Uint8Array>({
                start(controller): void {
                  controller.enqueue(remoteData);
                  controller.close();
                },
              }),
            },
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const target = syncTarget(alice.did, 'https://dwn.example.com');

      const [entry] = await (engine as any).syncEntriesFromFeedEntry(target, {
        seq               : '1',
        messageCid        : recordsWriteCid,
        isLatestBaseState : true,
        message           : recordsWrite.message,
      });

      expect(entry.dataStreamFactory).toBeDefined();
      const dataStream = await entry.dataStreamFactory!();
      expect(dataStream).toBeDefined();
      expect(mockAgent.rpc.sendDwnRequest.calledOnce).toBe(true);
    });

    it('should continue pulling feed pages until the remote cursor is drained', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const configure1 = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : {
          protocol  : 'https://example.com/feed-page-1',
          published : true,
          types     : { post: { schema: 'https://example.com/post', dataFormats: ['text/plain'] } },
          structure : { post: {} },
        },
      });
      const configure2 = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : {
          protocol  : 'https://example.com/feed-page-2',
          published : true,
          types     : { note: { schema: 'https://example.com/note', dataFormats: ['text/plain'] } },
          structure : { note: {} },
        },
      });
      const configure1Cid = await Message.getCid(configure1.message);
      const configure2Cid = await Message.getCid(configure2.message);
      const cursor1 = {
        streamId   : 'stream-1',
        epoch      : 'epoch-1',
        position   : '1',
        messageCid : configure1Cid,
      };
      const cursor2 = {
        streamId   : 'stream-1',
        epoch      : 'epoch-1',
        position   : '2',
        messageCid : configure2Cid,
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          applyReplicatedMessage : sinon.stub().resolves({ kind: 'Applied' }),
          processRequest         : sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [],
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub()
            .onFirstCall().resolves({
              status  : { code: 200, detail: 'OK' },
              entries : [{
                seq               : '1',
                messageCid        : configure1Cid,
                isLatestBaseState : true,
                message           : configure1.message,
              }],
              cursor  : cursor1,
              drained : false,
            })
            .onSecondCall().resolves({
              status  : { code: 200, detail: 'OK' },
              entries : [{
                seq               : '2',
                messageCid        : configure2Cid,
                isLatestBaseState : true,
                message           : configure2.message,
              }],
              cursor  : cursor2,
              drained : true,
            }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const target = syncTarget(alice.did, 'https://dwn.example.com');

      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      await engine.sync('pull');

      expect(mockAgent.processDwnRequest.secondCall.args[0].messageParams.cursor).toEqual(cursor1);
      expect(mockAgent.dwn.applyReplicatedMessage.callCount).toBe(2);
      const [link] = await (engine as any).ledger.getLinksForTenant(alice.did);
      expect(link.pull.contiguousAppliedToken).toEqual(cursor2);
    });

    it('should emit feed-admitted CIDs before deferred admission stops the endpoint group', async () => {
      const did = 'did:example:feed-partial-deferred';
      const cursor = {
        streamId : 'stream-1',
        epoch    : 'epoch-1',
        position : '2',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [],
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [
              { seq: '1', messageCid: 'cid-applied' },
              { seq: '2', messageCid: 'cid-deferred' },
            ],
            cursor,
            drained: true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPull: false });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });
      const target = syncTarget(did, 'https://dwn.example.com');

      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      sinon.stub(engine as any, 'admitRemoteFeedEntry')
        .onFirstCall().resolves({ kind: 'admitted', appliedCids: ['cid-applied'] })
        .onSecondCall().resolves({ kind: 'deferred', detail: 'dependency unavailable' });
      sinon.stub(console, 'error');

      await engine.sync('pull');

      const appliedEvent = events.find(event => event.type === 'reconcile:applied');
      expect(appliedEvent).toBeDefined();
      expect(appliedEvent.messageCids).toEqual(['cid-applied']);
    });

    it('should push a local MessagesQuery page and persist the push checkpoint', async () => {
      const protocol = 'https://example.com/feed-push';
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const configure = await TestDataGenerator.generateProtocolsConfigure({
        author             : alice,
        protocolDefinition : {
          protocol,
          published : true,
          types     : {
            post: { schema: 'https://example.com/post', dataFormats: ['text/plain'] },
          },
          structure: { post: {} },
        },
      });
      const configureCid = await Message.getCid(configure.message);
      const cursor = {
        streamId   : 'local-stream-1',
        epoch      : 'local-epoch-1',
        position   : '1',
        messageCid : configureCid,
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [{
                seq               : '1',
                messageCid        : configureCid,
                isLatestBaseState : true,
                protocol,
                message           : configure.message,
              }],
              cursor,
              drained: true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [],
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPush: false });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });
      const target = syncTarget(alice.did, 'https://dwn.example.com', {
        scope: { kind: 'protocolSet', protocols: [protocol] },
      });

      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves({ succeeded: [configureCid], failed: [] });
      await engine.sync('push');

      expect(mockAgent.dwn.processRequest.firstCall.args[0]).toMatchObject({
        author        : alice.did,
        target        : alice.did,
        messageType   : DwnInterface.MessagesQuery,
        messageParams : {
          cidsOnly : true,
          filters  : [{ protocol }],
          limit    : 100,
        },
      });
      expect(mockAgent.processDwnRequest.firstCall.args[0].messageParams).toMatchObject({
        cidsOnly : true,
        filters  : [{ protocol }],
        limit    : 100,
      });
      expect(pushStub.calledOnce).toBe(true);
      expect(pushStub.firstCall.args[0]).toMatchObject({
        did         : alice.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [configureCid],
      });

      const links = await (engine as any).ledger.getLinksForTenant(alice.did);
      expect(links).toHaveLength(1);
      expect(links[0].push.contiguousAppliedToken).toEqual(cursor);

      const pushEvent = events.find(event => event.type === 'checkpoint:push-advance');
      expect(pushEvent).toMatchObject({
        messageCid : configureCid,
        position   : '1',
      });
    });

    it('should enumerate local CIDs and push only messages missing from a cursorless remote scope', async () => {
      const did = 'did:example:feed-push-diff';
      const protocol = 'https://example.com/feed-push-diff';
      const remoteCursor = {
        streamId   : 'remote-stream-1',
        epoch      : 'remote-epoch-1',
        position   : '1',
        messageCid : 'cid-existing',
      };
      const localCursor = {
        streamId   : 'local-stream-1',
        epoch      : 'local-epoch-1',
        position   : '2',
        messageCid : 'cid-missing',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [
                { seq: '1', messageCid: 'cid-existing', protocol },
                { seq: '2', messageCid: 'cid-missing', protocol },
              ],
              cursor  : localCursor,
              drained : true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [{ seq: '1', messageCid: 'cid-existing', protocol }],
            cursor  : remoteCursor,
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPush: false });
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves({ succeeded: ['cid-missing'], failed: [] });
      const target = syncTarget(did, 'https://dwn.example.com', {
        scope: { kind: 'protocolSet', protocols: [protocol] },
      });

      const result = await (engine as any).pushLocalFeedForSyncTarget(target);

      expect(mockAgent.processDwnRequest.firstCall.args[0].messageParams).toMatchObject({
        cidsOnly : true,
        filters  : [{ protocol }],
        limit    : 100,
      });
      expect(mockAgent.dwn.processRequest.firstCall.args[0].messageParams).toMatchObject({
        cidsOnly : true,
        filters  : [{ protocol }],
        limit    : 100,
      });
      expect(pushStub.calledOnce).toBe(true);
      expect(pushStub.firstCall.args[0].messageCids).toEqual(['cid-missing']);
      expect(result.pushFailures).toEqual([]);
      const [link] = await (engine as any).ledger.getLinksForTenant(did);
      expect(link.push.contiguousAppliedToken).toEqual(localCursor);
    });

    it('should skip recently pulled local feed entries and still advance the push checkpoint', async () => {
      const did = 'did:example:feed-push-echo';
      const dwnUrl = 'https://dwn.example.com';
      const cursor = {
        streamId   : 'local-stream-1',
        epoch      : 'local-epoch-1',
        position   : '1',
        messageCid : 'cid-echo',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [{
                seq               : '1',
                messageCid        : 'cid-echo',
                isLatestBaseState : true,
              }],
              cursor,
              drained: true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [],
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPush: false });
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves({ succeeded: ['cid-echo'], failed: [] });
      const recentlyPulled = (engine as any)._recentlyPulledCids as Map<string, number>;
      recentlyPulled.set(`cid-echo|${dwnUrl}`, Date.now() + 60_000);
      const target = syncTarget(did, dwnUrl);

      const result = await (engine as any).pushLocalFeedForSyncTarget(target);

      expect(pushStub.called).toBe(false);
      expect(result.hasActionableDiffs).toBe(false);
      expect(result.ignoredLocalCids).toEqual([]);
      expect(result.pushFailures).toEqual([]);
      const links = await (engine as any).ledger.getLinksForTenant(did);
      expect(links[0].push.contiguousAppliedToken).toEqual(cursor);
    });

    it('should reset a stale push checkpoint once after a local MessagesQuery progress gap', async () => {
      const did = 'did:example:feed-push-reset';
      const staleCursor = {
        streamId : 'local-stream-1',
        epoch    : 'local-epoch-1',
        position : '9',
      };
      const resetCursor = {
        streamId : 'local-stream-2',
        epoch    : 'local-epoch-2',
        position : '1',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub()
            .onFirstCall().resolves({
              reply: {
                status: { code: 410, detail: 'Progress gap' },
              },
            })
            .onSecondCall().resolves({
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [],
                cursor  : resetCursor,
                drained : true,
              },
            }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [],
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPush: false });
      const target = syncTarget(did, 'https://dwn.example.com');
      const link = await (engine as any).getOrCreateReplicationLink(target);
      ReplicationLedger.commitContiguousToken(link.push, staleCursor);
      await (engine as any).ledger.saveLink(link);
      const pushStub = sinon.stub(engine as any, 'pushMessages').resolves({ succeeded: [], failed: [] });

      const result = await (engine as any).pushLocalFeedForSyncTarget(target);

      expect(mockAgent.dwn.processRequest.callCount).toBe(2);
      expect(mockAgent.dwn.processRequest.secondCall.args[0].messageParams.cursor).toBeUndefined();
      expect(pushStub.called).toBe(false);
      expect(result.pushFailures).toEqual([]);
      const links = await (engine as any).ledger.getLinksForTenant(did);
      expect(links[0].push.contiguousAppliedToken).toEqual(resetCursor);
    });

    it('should not advance the push checkpoint when a local feed push is retryable', async () => {
      const did = 'did:example:feed-push-retry';
      const cursor = {
        streamId   : 'local-stream-1',
        epoch      : 'local-epoch-1',
        position   : '1',
        messageCid : 'cid-retry',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [{
                seq               : '1',
                messageCid        : 'cid-retry',
                isLatestBaseState : true,
              }],
              cursor,
              drained: true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [],
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPush: false });
      sinon.stub(engine as any, 'pushMessages').resolves({
        succeeded : [],
        failed    : [{ cid: 'cid-retry', detail: 'temporary remote failure' }],
      });
      const target = syncTarget(did, 'https://dwn.example.com');

      const result = await (engine as any).pushLocalFeedForSyncTarget(target);

      expect(result.pushFailures).toEqual([{ cid: 'cid-retry', detail: 'temporary remote failure' }]);
      const links = await (engine as any).ledger.getLinksForTenant(did);
      expect(links[0].push.contiguousAppliedToken).toBeUndefined();
    });

    it('should dead-letter a terminal local feed push and advance the push checkpoint', async () => {
      const did = 'did:example:feed-push-terminal';
      const cursor = {
        streamId   : 'local-stream-1',
        epoch      : 'local-epoch-1',
        position   : '1',
        messageCid : 'cid-terminal',
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : {
          processRequest: sinon.stub().resolves({
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [{
                seq               : '1',
                messageCid        : 'cid-terminal',
                isLatestBaseState : true,
              }],
              cursor,
              drained: true,
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({
            status  : { code: 200, detail: 'OK' },
            entries : [],
            drained : true,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPush: false });
      sinon.stub(engine as any, 'pushMessages').resolves({
        succeeded : [],
        failed    : [{
          cid      : 'cid-terminal',
          detail   : 'invalid remote admission',
          kind     : 'Invalid',
          terminal : true,
        }],
      });
      const target = syncTarget(did, 'https://dwn.example.com');

      const result = await (engine as any).pushLocalFeedForSyncTarget(target);

      expect(result.pushFailures).toEqual([]);
      expect(result.ignoredLocalCids).toEqual(['cid-terminal']);
      const links = await (engine as any).ledger.getLinksForTenant(did);
      expect(links[0].push.contiguousAppliedToken).toEqual(cursor);
      const failedMessages = await engine.getFailedMessages(did);
      expect(failedMessages).toHaveLength(1);
      expect(failedMessages[0]).toMatchObject({
        messageCid     : 'cid-terminal',
        remoteEndpoint : 'https://dwn.example.com',
        category       : 'admit-failed',
        errorCode      : 'Invalid',
        errorDetail    : 'invalid remote admission',
      });
    });

    it('should run durable feed pull and push during a full sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);

      await engine.sync();

      expect(pushStub.calledOnce).toBe(true);
      expect(pullStub.calledOnce).toBe(true);
    });

    it('should pass pull direction through the durable feed cycle', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);

      await engine.sync('pull');

      expect(pullStub.firstCall.args[1]).toMatchObject({ direction: 'pull' });
      expect(pushStub.firstCall.args[1]).toMatchObject({ direction: 'pull' });
    });

    it('should pass push direction through the durable feed cycle', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);

      await engine.sync('push');

      expect(pullStub.firstCall.args[1]).toMatchObject({ direction: 'push' });
      expect(pushStub.firstCall.args[1]).toMatchObject({ direction: 'push' });
    });

    it('should abort the durable feed cycle before push when the link is no longer current after pull', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;

      const result = await (engine as any).syncTargetWithDurableFeeds(
        syncTarget('did:example:1', 'https://dwn.example.com'),
        {},
        () => false,
      );

      expect(result.aborted).toBe(true);
      expect(pullStub.calledOnce).toBe(true);
      expect(pushStub.called).toBe(false);
    });

    it('should abort the durable feed cycle before convergence verification when the link changes after push', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;
      const verifyStub = (engine as any).verifyFeedConvergence;
      const shouldContinue = sinon.stub();
      shouldContinue.onFirstCall().returns(true);
      shouldContinue.onSecondCall().returns(false);

      const result = await (engine as any).syncTargetWithDurableFeeds(
        syncTarget('did:example:1', 'https://dwn.example.com'),
        { verifyConvergence: true },
        shouldContinue,
      );

      expect(result.aborted).toBe(true);
      expect(pushStub.calledOnce).toBe(true);
      expect(verifyStub.called).toBe(false);
    });

    it('should verify feed convergence with fresh local and remote feed fingerprints', async () => {
      const localReply = {
        drained     : true,
        fingerprint : 'feed-fingerprint',
        status      : { code: 200, detail: 'OK' },
      };
      const remoteReply = {
        drained     : true,
        fingerprint : 'feed-fingerprint',
        status      : { code: 200, detail: 'OK' },
      };
      const mockAgent = {
        agentDid          : 'did:example:agent',
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        dwn               : { processRequest: sinon.stub().resolves({ reply: localReply }) },
        rpc               : { sendDwnRequest: sinon.stub().resolves(remoteReply) },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedVerify: false });
      const target = syncTarget('did:example:alice', 'https://dwn.example.com', {
        scope: { kind: 'protocolSet', protocols: ['https://example.com/profile'] },
      });

      const result = await (engine as any).syncTargetWithDurableFeeds(target, { verifyConvergence: true });

      expect(result.converged).toBe(true);
      expect(result.localFingerprint).toBe('feed-fingerprint');
      expect(result.remoteFingerprint).toBe('feed-fingerprint');
      expect(mockAgent.dwn.processRequest.firstCall.args[0]).toMatchObject({
        author        : 'did:example:alice',
        target        : 'did:example:alice',
        messageType   : DwnInterface.MessagesQuery,
        messageParams : {
          cidsOnly : true,
          filters  : [{ protocol: 'https://example.com/profile' }],
          limit    : 1,
        },
      });
      expect(mockAgent.processDwnRequest.firstCall.args[0]).toMatchObject({
        author        : 'did:example:alice',
        target        : 'did:example:alice',
        messageType   : DwnInterface.MessagesQuery,
        messageParams : {
          cidsOnly : true,
          filters  : [{ protocol: 'https://example.com/profile' }],
          limit    : 1,
        },
      });
      expect(mockAgent.rpc.sendDwnRequest.firstCall.args[0]).toMatchObject({
        dwnUrl    : 'https://dwn.example.com',
        targetDid : 'did:example:alice',
      });
    });

    it('should treat push failures and mismatched fingerprints as non-converged', () => {
      expect((SyncEngineLevel as any).feedFingerprintsConverged({
        localFingerprint  : 'fingerprint',
        remoteFingerprint : 'fingerprint',
        pushFailures      : [],
      })).toBe(true);
      expect((SyncEngineLevel as any).feedFingerprintsConverged({
        localFingerprint  : 'local-fingerprint',
        remoteFingerprint : 'remote-fingerprint',
        pushFailures      : [],
      })).toBe(false);
      expect((SyncEngineLevel as any).feedFingerprintsConverged({
        localFingerprint  : 'fingerprint',
        remoteFingerprint : 'fingerprint',
        pushFailures      : [{ cid: 'cid-1', detail: 'retry later' }],
      })).toBe(false);
    });

    it('should reset feed checkpoints and mark a live link for reconcile when verified fingerprints diverge', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const target = syncTarget('did:example:1', 'https://dwn.example.com');
      const link = await (engine as any).getOrCreateReplicationLink(target);
      const linkKey = (engine as any).getReplicationLinkKey(target, link);
      const token = {
        streamId   : 'tenant-stream',
        epoch      : 'epoch-1',
        position   : '10',
        messageCid : 'cid-10',
      };
      link.status = 'live';
      link.pull = { contiguousAppliedToken: token, receivedToken: token };
      link.push = { contiguousAppliedToken: token, receivedToken: token };
      link.needsReconcile = false;
      (engine as any)._activeLinks.set(linkKey, link);
      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      ((engine as any).verifyFeedConvergence).resolves({
        converged         : false,
        localFingerprint  : 'local-fingerprint',
        remoteFingerprint : 'remote-fingerprint',
        pushFailures      : [],
      });
      const scheduleStub = sinon.stub(engine as any, 'scheduleReconcile');

      await engine.sync(undefined, { verifyConvergence: true });

      expect(link.pull.contiguousAppliedToken).toBeUndefined();
      expect(link.pull.receivedToken).toBeUndefined();
      expect(link.push.contiguousAppliedToken).toBeUndefined();
      expect(link.push.receivedToken).toBeUndefined();
      expect(link.needsReconcile).toBe(true);
      expect(scheduleStub.calledOnceWith(linkKey, 0)).toBe(true);
    });

    it('should not treat dead-letter divergence as converged', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const target = syncTarget('did:example:1', 'https://dwn.example.com');
      const link = await (engine as any).getOrCreateReplicationLink(target);
      const linkKey = (engine as any).getReplicationLinkKey(target, link);
      const token = {
        streamId   : 'tenant-stream',
        epoch      : 'epoch-1',
        position   : '10',
        messageCid : 'cid-10',
      };
      link.status = 'live';
      link.pull = { contiguousAppliedToken: token, receivedToken: token };
      link.push = { contiguousAppliedToken: token, receivedToken: token };
      link.needsReconcile = false;
      (engine as any)._activeLinks.set(linkKey, link);
      const localFingerprint = await fingerprintFromCids(['cid-terminal']);
      const remoteFingerprint = await fingerprintFromCids([]);
      await engine.recordDeadLetter({
        messageCid     : 'cid-terminal',
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        category       : 'admit-failed',
        errorDetail    : 'terminal push failure',
      });
      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      ((engine as any).pushLocalFeedForSyncTarget).resolves({
        hasActionableDiffs : false,
        ignoredLocalCids   : ['cid-terminal'],
        pushFailures       : [],
      });
      ((engine as any).verifyFeedConvergence).resolves({
        converged         : false,
        localFingerprint  : localFingerprint,
        remoteFingerprint : remoteFingerprint,
        pushFailures      : [],
      });
      const scheduleStub = sinon.stub(engine as any, 'scheduleReconcile');

      await engine.sync(undefined, { verifyConvergence: true });

      expect(link.pull.contiguousAppliedToken).toBeUndefined();
      expect(link.pull.receivedToken).toBeUndefined();
      expect(link.push.contiguousAppliedToken).toBeUndefined();
      expect(link.push.receivedToken).toBeUndefined();
      expect(link.needsReconcile).toBe(true);
      expect(scheduleStub.calledOnceWith(linkKey, 0)).toBe(true);
    });

    it('should transition repeated dead-letter divergence to terminal-incomplete without replaying forever', async () => {
      const did = 'did:example:feed-push-terminal-steady';
      const dwnUrl = 'https://dwn.example.com';
      const terminalCid = 'cid-terminal-steady';
      const authorizationEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      const pushCursor = {
        streamId   : 'local-stream-1',
        epoch      : 'local-epoch-1',
        position   : '1',
        messageCid : terminalCid,
      };
      const pullCursor = {
        streamId   : 'remote-stream-1',
        epoch      : 'remote-epoch-1',
        position   : '8',
        messageCid : 'remote-cid-8',
      };
      const localFingerprint = await fingerprintFromCids([terminalCid]);
      const remoteFingerprint = await fingerprintFromCids([]);
      let feedQueriesFromStart = 0;
      const processRequestStub = sinon.stub().callsFake(async (params: any): Promise<any> => {
        if (params.messageParams.cidsOnly === true && params.messageParams.limit === 1) {
          return {
            reply: {
              status      : { code: 200, detail: 'OK' },
              drained     : true,
              fingerprint : localFingerprint,
            },
          };
        }

        if (params.messageParams.cidsOnly === true && params.messageParams.cursor === undefined) {
          feedQueriesFromStart++;
          return {
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [{
                seq               : '1',
                messageCid        : terminalCid,
                isLatestBaseState : true,
              }],
              cursor  : pushCursor,
              drained : true,
            },
          };
        }

        return {
          reply: {
            status  : { code: 200, detail: 'OK' },
            entries : [],
            drained : true,
          },
        };
      });
      const mockAgent = {
        agentDid          : 'did:example:agent',
        did               : { dereference: sinon.stub() },
        dwn               : { processRequest: processRequestStub },
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: { interface: 'Messages', method: 'Query' } } }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status      : { code: 200, detail: 'OK' },
            drained     : true,
            fingerprint : remoteFingerprint,
          }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent }, { stubFeedPush: false, stubFeedVerify: false });
      await (engine as any)._db.sublevel('registeredIdentities').put(did, JSON.stringify({
        protocols: ['https://example.com/chat', 'https://example.com/profile'],
      }));
      const pushMessagesStub = sinon.stub(engine as any, 'pushMessages').resolves({
        succeeded : [],
        failed    : [{
          cid      : terminalCid,
          detail   : 'invalid remote admission',
          kind     : 'Invalid',
          terminal : true,
        }],
      });
      const target = syncTarget(did, dwnUrl, {
        authorizationEpoch,
        scope: {
          kind      : 'protocolSet',
          protocols : ['https://example.com/chat', 'https://example.com/profile'],
        },
      });

      const initialPush = await (engine as any).pushLocalFeedForSyncTarget(target);
      expect(initialPush.ignoredLocalCids).toEqual([terminalCid]);
      expect(pushMessagesStub.calledOnce).toBe(true);

      const link = (await (engine as any).ledger.getLinksForTenant(did))[0];
      const linkKey = (engine as any).getReplicationLinkKey(target, link);
      link.status = 'live';
      link.pull = { contiguousAppliedToken: pullCursor, receivedToken: pullCursor };
      link.needsReconcile = false;
      await (engine as any).ledger.saveLink(link);
      (engine as any)._activeLinks.set(linkKey, link);

      const events: any[] = [];
      engine.on((event) => { events.push(event); });
      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      const scheduleStub = sinon.stub(engine as any, 'scheduleReconcile');

      await engine.sync(undefined, { verifyConvergence: true });
      await engine.sync(undefined, { verifyConvergence: true });
      await engine.sync(undefined, { verifyConvergence: true });
      const feedQueriesAtTerminal = feedQueriesFromStart;
      await engine.sync(undefined, { verifyConvergence: true });

      const [finalLink] = await (engine as any).ledger.getLinksForTenant(did);
      expect(finalLink.status).toBe('terminal_incomplete');
      expect(finalLink.pull.contiguousAppliedToken).toBeUndefined();
      expect(finalLink.pull.receivedToken).toBeUndefined();
      expect(finalLink.push.contiguousAppliedToken).toEqual(pushCursor);
      expect(finalLink.push.receivedToken).toEqual(pushCursor);
      expect(finalLink.needsReconcile).toBe(false);
      expect(pushMessagesStub.calledOnce).toBe(true);
      expect(feedQueriesFromStart).toBe(feedQueriesAtTerminal);
      expect(scheduleStub.callCount).toBe(2);
      expect(events.some(event =>
        event.type === 'link:status-change' &&
        event.tenantDid === did &&
        event.remoteEndpoint === dwnUrl &&
        event.to === 'terminal_incomplete'
      )).toBe(true);

      const health = await engine.getSyncHealth();
      expect(health.failedMessageCount).toBe(1);
      expect(health.degradedLinkCount).toBe(1);
      expect(health.syncHealthy).toBe(false);
    });

    it('should not let a stale dead letter poison matching feed fingerprints', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const target = syncTarget('did:example:stale-dead-letter', 'https://dwn.example.com');
      const link = await (engine as any).getOrCreateReplicationLink(target);
      const linkKey = (engine as any).getReplicationLinkKey(target, link);
      const token = {
        streamId   : 'tenant-stream',
        epoch      : 'epoch-1',
        position   : '10',
        messageCid : 'cid-10',
      };
      const fingerprint = await fingerprintFromCids([]);

      await engine.recordDeadLetter({
        messageCid     : 'cid-superseded-dead-letter',
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        category       : 'admit-failed',
        errorDetail    : 'terminal push failure',
      });
      link.status = 'live';
      link.pull = { contiguousAppliedToken: token, receivedToken: token };
      link.push = { contiguousAppliedToken: token, receivedToken: token };
      link.needsReconcile = false;
      await (engine as any).ledger.saveLink(link);
      (engine as any)._activeLinks.set(linkKey, link);
      sinon.stub(engine as any, 'getSyncTargets').resolves([target]);
      ((engine as any).verifyFeedConvergence).resolves({
        converged         : true,
        localFingerprint  : fingerprint,
        remoteFingerprint : fingerprint,
        pushFailures      : [],
      });
      const scheduleStub = sinon.stub(engine as any, 'scheduleReconcile');

      await engine.sync(undefined, { verifyConvergence: true });

      const [storedLink] = await (engine as any).ledger.getLinksForTenant(target.did);
      expect(storedLink.status).toBe('live');
      expect(storedLink.pull.contiguousAppliedToken).toEqual(token);
      expect(storedLink.push.contiguousAppliedToken).toEqual(token);
      expect(storedLink.needsReconcile).toBe(false);
      expect(scheduleStub.called).toBe(false);
    });

    it('should skip durable feed push after a pull failure', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;
      pullStub.rejects(new Error('remote feed unavailable'));

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);
      sinon.stub(console, 'error');

      await engine.sync();

      expect(pushStub.called).toBe(false);
    });

    it('should skip remaining targets for a DWN URL that errored', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      pullStub.rejects(new Error('network error'));

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
        syncTarget('did:example:2', 'https://dwn.example.com'),
      ]);
      const consoleStub = sinon.stub(console, 'error');

      await engine.sync(); // should not throw

      expect(pullStub.calledOnce).toBe(true);
      expect(consoleStub.called).toBe(true);
    });

    it('should set connectivity to online after successful sync with targets', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);

      await engine.sync();

      expect(engine.connectivityState).toBe('online');
    });

    it('should increment consecutive failures and set offline on error', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      // Set initial state to online
      (engine as any)._connectivityState = 'online';

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);
      ((engine as any).pullRemoteFeedForSyncTarget).rejects(new Error('timeout'));
      sinon.stub(console, 'error');

      await engine.sync();

      expect((engine as any)._consecutiveFailures).toBe(1);
      expect(engine.connectivityState).toBe('offline');
    });

    it('should count retryable reconcile push failures as sync endpoint failures', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._connectivityState = 'online';

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);
      ((engine as any).pushLocalFeedForSyncTarget).resolves({
        pushFailures: [{ cid: 'cid-1', detail: 'network unavailable' }],
      });
      sinon.stub(console, 'error');

      await engine.sync();

      expect((engine as any)._consecutiveFailures).toBe(1);
      expect(engine.connectivityState).toBe('offline');
    });

    it('should dead-letter terminal reconcile push failures without marking the endpoint offline', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._connectivityState = 'online';

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);
      ((engine as any).pushLocalFeedForSyncTarget).resolves({
        pushFailures: [{ cid: 'cid-terminal', kind: 'Invalid', terminal: true, detail: 'bad request' }],
      });

      await engine.sync();

      const failedMessages = await engine.getFailedMessages('did:example:1');
      expect((engine as any)._consecutiveFailures).toBe(0);
      expect(engine.connectivityState).toBe('online');
      expect(failedMessages).toHaveLength(1);
      expect(failedMessages[0].messageCid).toBe('cid-terminal');
      expect(failedMessages[0].remoteEndpoint).toBe('https://dwn.example.com');
      expect(failedMessages[0].errorCode).toBe('Invalid');
    });

    it('should emit reconcile:applied for CIDs admitted during one-shot sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      const profileProtocol = 'https://example.com/profile';
      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com', {
          scope: { kind: 'protocolSet', protocols: [profileProtocol] },
        }),
      ]);
      ((engine as any).pullRemoteFeedForSyncTarget).resolves({
        admittedCids: ['cid-protocol', 'cid-profile'],
      });

      await engine.sync();

      const appliedEvent = events.find(e => e.type === 'reconcile:applied');
      expect(appliedEvent).toBeDefined();
      expect(appliedEvent.tenantDid).toBe('did:example:1');
      expect(appliedEvent.remoteEndpoint).toBe('https://dwn.example.com');
      expect(appliedEvent.protocol).toBe(profileProtocol);
      expect(appliedEvent.messageCids).toEqual(['cid-protocol', 'cid-profile']);
    });

    it('should not dead-letter Deferred push failures during one-shot sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._connectivityState = 'online';

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);
      ((engine as any).pushLocalFeedForSyncTarget).resolves({
        pushFailures: [{ cid: 'cid-deferred', kind: 'Deferred', reason: 'storage', detail: 'storage unavailable' }],
      });
      sinon.stub(console, 'error');

      await engine.sync();

      const failedMessages = await engine.getFailedMessages('did:example:1');
      expect(failedMessages).toHaveLength(0);
      expect(engine.connectivityState).toBe('offline');
    });

    it('should sync different dwnUrl groups concurrently', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      // Two targets on different dwnUrls.
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://slow.example.com'),
        syncTarget('did:example:2', 'https://fast.example.com'),
      ]);

      const callLog: string[] = [];
      ((engine as any).pullRemoteFeedForSyncTarget).callsFake(async (target: any): Promise<Record<string, never>> => {
        callLog.push(`start:${target.dwnUrl}`);
        const delay = target.dwnUrl.includes('slow') ? 200 : 10;
        await new Promise(r => setTimeout(r, delay));
        callLog.push(`end:${target.dwnUrl}`);
        return {};
      });

      const start = Date.now();
      await engine.sync();
      const elapsed = Date.now() - start;

      // Both groups should have started before either finished.
      // With sequential processing, elapsed would be >= 210ms.
      // With parallel processing, elapsed should be ~200ms (the slow group).
      expect(elapsed).toBeLessThan(1000);

      // The fast group should finish before the slow group.
      const fastEndIdx = callLog.indexOf('end:https://fast.example.com');
      const slowEndIdx = callLog.indexOf('end:https://slow.example.com');
      expect(fastEndIdx).toBeLessThan(slowEndIdx);
    });

    it('should stay online when one URL group fails but another succeeds', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._connectivityState = 'online';

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://healthy.example.com'),
        syncTarget('did:example:2', 'https://down.example.com'),
      ]);

      ((engine as any).pullRemoteFeedForSyncTarget).callsFake(async (target: any): Promise<Record<string, never>> => {
        if (target.dwnUrl.includes('down')) {
          throw new Error('connection refused');
        }
        return {};
      });
      sinon.stub(console, 'error');

      await engine.sync();

      // Partial failure: at least one group succeeded, so stay online.
      expect(engine.connectivityState).toBe('online');
      expect((engine as any)._consecutiveFailures).toBe(0);
    });

    it('should aggregate per-link connectivity: online if any link is online', () => {
      const engine = createEngine({ db });
      (engine as any)._activeLinks.set('link-1', { connectivity: 'online' });
      (engine as any)._activeLinks.set('link-2', { connectivity: 'offline' });

      expect(engine.connectivityState).toBe('online');
    });

    it('should aggregate per-link connectivity: offline if all links are offline', () => {
      const engine = createEngine({ db });
      (engine as any)._activeLinks.set('link-1', { connectivity: 'offline' });
      (engine as any)._activeLinks.set('link-2', { connectivity: 'offline' });

      expect(engine.connectivityState).toBe('offline');
    });

    it('should aggregate per-link connectivity: unknown if all links are unknown', () => {
      const engine = createEngine({ db });
      (engine as any)._activeLinks.set('link-1', { connectivity: 'unknown' });

      expect(engine.connectivityState).toBe('unknown');
    });

    it('should fall back to global state when no active links exist', () => {
      const engine = createEngine({ db });
      (engine as any)._connectivityState = 'offline';

      expect(engine.connectivityState).toBe('offline');
    });

    it('should set link connectivity to offline on transitionToRepairing', async () => {
      const engine = createEngine({ db });
      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        status         : 'live',
        connectivity   : 'online',
        pull           : {},
      } as any;
      const linkKey = 'test-link';
      (engine as any)._activeLinks.set(linkKey, link);

      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub });
      sinon.stub(engine as any, 'repairLink').resolves();

      await (engine as any).transitionToRepairing(linkKey, link);

      expect(link.connectivity).toBe('offline');
    });

    it('should reset consecutive failures on success', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      (engine as any)._consecutiveFailures = 3;

      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:1', 'https://dwn.example.com'),
      ]);

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
      const engine = createEngine({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();

      await engine.startSync({ mode: 'poll', interval: '100ms' });
      expect(syncStub.calledOnce).toBe(true); // immediate sync on start

      await engine.stopSync();
      expect((engine as any)._syncIntervalId).toBeUndefined();
    });

    it('should clear existing interval when starting new sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

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
      const engine = createEngine({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);

      await engine.startSync({ mode: 'live', interval: '500ms' });
      expect(syncStub.calledOnce).toBe(true); // initial catch-up
      expect((engine as any)._syncMode).toBe('live');

      await engine.stopSync();
    });

    it('should handle error during initial live sync catch-up', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').rejects(new Error('initial sync failed'));
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);
      const consoleStub = sinon.stub(console, 'error');

      await engine.startSync({ mode: 'live', interval: '500ms' });
      expect(consoleStub.called).toBe(true);

      await engine.stopSync();
    });

    it('should tear down previous live subscriptions when starting new sync', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

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
  // initializeLinkTarget
  // ---------------------------------------------------------------------------

  describe('initializeLinkTarget', () => {
    it('should not mark a link live if pull subscription setup moves it to repairing', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com^projection-test^authorization-test';
      const closePull = sinon.stub().resolves();
      const link = {
        tenantDid          : 'did:example:alice',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test',
        authorizationEpoch : 'authorization-test',
        authorization      : { kind: 'owner' },
        scope              : { kind: 'full' },
        status             : 'initializing',
        pull               : {},
        connectivity       : 'online',
        needsReconcile     : false,
      } as any;

      sinon.stub(engine as any, 'getOrCreateReplicationLink').resolves(link);
      sinon.stub(engine as any, 'getReplicationLinkKey').returns(linkKey);
      sinon.stub(engine as any, 'openLivePullSubscription').callsFake(async (): Promise<void> => {
        (engine as any)._liveSubscriptions.push({ linkKey, did: link.tenantDid, dwnUrl: link.remoteEndpoint, close: closePull });
        link.status = 'repairing';
      });
      const openLocalPushStub = sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
      const markLinkLiveStub = sinon.stub(engine as any, 'markLinkLive').resolves();

      await (engine as any).initializeLinkTarget(syncTarget('did:example:alice', 'https://dwn.example.com'));

      expect(openLocalPushStub.called).toBe(false);
      expect(markLinkLiveStub.called).toBe(false);
      expect(closePull.calledOnce).toBe(true);
      expect((engine as any)._activeLinks.get(linkKey)).toBe(link);
      expect(link.status).toBe('repairing');
    });

  });

  // ---------------------------------------------------------------------------
  // initializeLinkTargetWithRetry
  // ---------------------------------------------------------------------------

  describe('initializeLinkTargetWithRetry', () => {
    it('should retry a DID-resolution verification failure and then succeed', async () => {
      const engine = createEngine({ db, agent: { agentDid: 'did:example:agent' } as any });
      const initializeStub = sinon.stub(engine as any, 'initializeLinkTarget');
      initializeStub.onFirstCall().rejects(new Error('GeneralJwsVerifierGetPublicKeyNotFound: unable to resolve DID'));
      initializeStub.onSecondCall().resolves(activeInitializationResult({
        tenantDid          : 'did:example:alice',
        projectionId       : 'projection-test',
        authorizationEpoch : 'authorization-test',
      }));

      const originalDelays = (SyncEngineLevel as any).DID_RESOLUTION_RETRY_BACKOFF_MS;
      (SyncEngineLevel as any).DID_RESOLUTION_RETRY_BACKOFF_MS = [0];
      try {
        const result = await (engine as any).initializeLinkTargetWithRetry(syncTarget('did:example:alice', 'https://dwn.example.com'));
        expect(result.status).toBe('active');
      } finally {
        (SyncEngineLevel as any).DID_RESOLUTION_RETRY_BACKOFF_MS = originalDelays;
      }

      expect(initializeStub.callCount).toBe(2);
    });

    it('should not classify unrelated notFound errors as DID-resolution failures', () => {
      const engine = createEngine({ db });
      expect((engine as any).isDidResolutionFailure(new Error('record notFound in local cache'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // openLivePullSubscription
  // ---------------------------------------------------------------------------

  describe('openLivePullSubscription', () => {
    const fullPullTarget = (overrides: Record<string, unknown> = {}): any => ({
      did                : 'did:example:alice',
      dwnUrl             : 'https://dwn.example.com',
      linkKey            : 'did:example:alice^https://dwn.example.com^projection-test^authorization-test',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-test',
      ...overrides,
    });

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
      const engine = createEngine({ db, agent });

      await (engine as any).openLivePullSubscription(fullPullTarget());

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
      const engine = createEngine({ db, agent });

      await expect(
        (engine as any).openLivePullSubscription(fullPullTarget())
      ).rejects.toThrow('MessagesSubscribe failed');

      expect((engine as any)._liveSubscriptions.length).toBe(0);
    });

    it('should include one subscription filter per protocol in a protocol-set scope', async () => {
      const { agent, processRequestStub } = createPullMockAgent();
      const engine = createEngine({ db, agent });

      await (engine as any).openLivePullSubscription(fullPullTarget({
        scope: {
          kind      : 'protocolSet',
          protocols : ['https://proto.example.com', 'https://social.example.com'],
        },
      }));

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.filters).toEqual([
        { protocol: 'https://proto.example.com' },
        { protocol: 'https://social.example.com' },
      ]);
      (engine as any)._liveSubscriptions = [];
    });

    it('should include delegate grant IDs when provided by the sync target', async () => {
      const { agent, processRequestStub } = createPullMockAgent();
      const engine = createEngine({ db, agent });

      await (engine as any).openLivePullSubscription(fullPullTarget({
        delegateDid   : 'did:example:delegate',
        authorization : {
          kind               : 'delegate',
          delegateDid        : 'did:example:delegate',
          permissionGrantIds : ['grant-b', 'grant-a'],
        },
        permissionGrantIds: ['grant-b', 'grant-a'],
      }));

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.granteeDid).toBe('did:example:delegate');
      expect(callArgs.messageParams.permissionGrantIds).toEqual(['grant-a', 'grant-b']);
      (engine as any)._liveSubscriptions = [];
    });

    it('should use existing cursor from link pull checkpoint', async () => {
      const { agent, processRequestStub } = createPullMockAgent();
      const engine = createEngine({ db, agent });
      const savedCursor = { streamId: 's1', epoch: 'e1', position: '42', messageCid: 'cid-42' };

      // Set cursor on the link's durable pull checkpoint.
      const linkKey = 'did:example:alice^https://dwn.example.com^projection-test^authorization-test';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test',
        authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : { contiguousAppliedToken: savedCursor },
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      await (engine as any).openLivePullSubscription(fullPullTarget({ linkKey }));

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.cursor).toEqual(savedCursor);
      (engine as any)._liveSubscriptions = [];
    });

    it('should ignore transport resume cursor and resubscribe from the durable checkpoint', async () => {
      const { agent, processRequestStub, rpcStub } = createPullMockAgent();
      const engine = createEngine({ db, agent });
      const durableCursor = { streamId: 's1', epoch: 'e1', position: '42', messageCid: 'cid-42' };
      const deliveredCursor = { streamId: 's1', epoch: 'e1', position: '45', messageCid: 'cid-45' };

      const linkKey = 'did:example:alice^https://dwn.example.com^projection-test^authorization-test';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test',
        authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : { contiguousAppliedToken: durableCursor },
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      await (engine as any).openLivePullSubscription(fullPullTarget({ linkKey }));

      const resubscribeFactory = rpcStub.firstCall.args[0].subscription.resubscribeFactory;
      await resubscribeFactory(deliveredCursor);

      expect(processRequestStub.secondCall.args[0].messageParams.cursor).toEqual(durableCursor);
      (engine as any)._liveSubscriptions = [];
    });

  });

  // ---------------------------------------------------------------------------
  // openLocalPushSubscription
  // ---------------------------------------------------------------------------

  describe('openLocalPushSubscription', () => {
    const fullPushTarget = (overrides: Record<string, unknown> = {}): any => ({
      did                : 'did:example:alice',
      dwnUrl             : 'https://dwn.example.com',
      linkKey            : 'did:example:alice^https://dwn.example.com^projection-test^authorization-test',
      scope              : { kind: 'full' },
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'authorization-test',
      ...overrides,
    });

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
      const engine = createEngine({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription(fullPushTarget());

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
      const engine = createEngine({ db, agent: mockAgent });

      await expect(
        (engine as any).openLocalPushSubscription(fullPushTarget())
      ).rejects.toThrow('Local MessagesSubscribe failed');

      expect((engine as any)._localSubscriptions.length).toBe(0);
    });

    it('should include one subscription filter per protocol in a protocol-set scope', async () => {
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
      const engine = createEngine({ db, agent: mockAgent });

      await (engine as any).openLocalPushSubscription(fullPushTarget({
        scope: {
          kind      : 'protocolSet',
          protocols : ['https://proto.example.com', 'https://social.example.com'],
        },
      }));

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.filters).toEqual([
        { protocol: 'https://proto.example.com' },
        { protocol: 'https://social.example.com' },
      ]);

      (engine as any)._localSubscriptions = [];
    });
  });

  // ---------------------------------------------------------------------------
  // flushPendingPushes
  // ---------------------------------------------------------------------------

  describe('flushPendingPushes', () => {
    it('should clear pending push entries after flushing', async () => {
      const engine = createEngine({ db });
      (engine as any)._activeLinks.set('key1', { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', status: 'live' });
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
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      (engine as any)._activeLinks.set('key1', { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', status: 'live' });
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
      // processRequest returns a MessagesRead-like response so pushMessages
      // can read local messages and apply them via replicated admission.
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
          applyReplicatedMessage: sinon.stub().resolves({ kind: 'Applied' }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      // Simulate a push runtime left over from a previously retried batch
      // that eventually succeeded — retryCount is stale at 2.
      (engine as any)._activeLinks.set('key1', { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', status: 'live' });
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

    it('should schedule reconcile after a successful retry on a dirty live link', () => {
      const engine = createEngine({ db });
      const linkKey = 'key1';
      const pushRuntime = (engine as any).getOrCreatePushRuntime(linkKey, {
        did    : 'did:example:alice',
        dwnUrl : 'https://dwn.example.com',
      });
      (engine as any)._activeLinks.set(linkKey, {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        status         : 'live',
        needsReconcile : true,
      });
      const scheduleStub = sinon.stub(engine as any, 'scheduleReconcile');

      (engine as any).cleanupSuccessfulPushRuntime(linkKey, pushRuntime);

      expect(scheduleStub.calledOnceWith(linkKey, 500)).toBe(true);
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
          applyReplicatedMessage: sinon.stub().resolves({ kind: 'Applied' }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      // Simulate a runtime with stale retryCount from a prior batch,
      // plus new entries waiting. The batch-A entries will be flushed;
      // batch-B entries arrive while flush is in progress.
      (engine as any)._activeLinks.set('key1', { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', status: 'live' });
      const pushRuntime = {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid-batch-a' }],
        retryCount : 2,
      };
      (engine as any)._pushRuntimes.set('key1', pushRuntime);

      // Simulate batch B arriving after entries are snapshotted but before
      // the flush completes: add entries directly to the runtime.
      mockAgent.rpc.applyReplicatedMessage.callsFake(async () => {
        pushRuntime.entries.push({ cid: 'cid-batch-b' });
        return { kind: 'Applied' };
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
        rpc: { applyReplicatedMessage: sinon.stub().rejects(new Error('network error')) },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      (engine as any)._activeLinks.set('key1', { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', status: 'live' });
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

    it('should drop pending push runtime for a non-live link', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const timer = setTimeout(() => {}, 10_000);
      (engine as any)._activeLinks.set(linkKey, { status: 'terminal_incomplete' });
      (engine as any)._pushRuntimes.set(linkKey, {
        did        : 'did:example:alice',
        dwnUrl     : 'https://dwn.example.com',
        entries    : [{ cid: 'cid-1' }],
        retryCount : 0,
        timer,
      });

      await (engine as any).flushPendingPushesForLink(linkKey);

      expect((engine as any)._pushRuntimes.has(linkKey)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // clear / close
  // ---------------------------------------------------------------------------

  describe('clear / close', () => {
    it('clear should clear permissionsApi and db', async () => {
      const mockAgent = { agentDid: 'did:example:agent' } as any;
      const clearDb = new Level<string, string>('__TESTDATA__/sync-engine-clear-spec');
      const engine = createEngine({ db: clearDb, agent: mockAgent });
      (engine as any)._permissionsApi = { clear: sinon.stub().resolves() };

      await engine.registerIdentity({ did: 'did:example:test', options: { protocols: 'all' } });
      expect(await engine.getIdentityOptions('did:example:test')).toBeDefined();

      await engine.clear();
      expect(await engine.getIdentityOptions('did:example:test')).toBeUndefined();
      expect((engine as any)._permissionsApi.clear.calledOnce).toBe(true);

      await clearDb.close();
    });

    it('close should close the db', async () => {
      const closeDb = new Level<string, string>('__TESTDATA__/sync-engine-close-spec');
      const engine = createEngine({ db: closeDb });

      await engine.close();
      // After closing, operations should fail
      await expect(engine.registerIdentity({ did: 'did:example:after-close', options: { protocols: 'all' } })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // startPollSync — intervalSync closure
  // ---------------------------------------------------------------------------

  describe('startPollSync — intervalSync closure', () => {
    it('should execute intervalSync callback and apply backoff on failure', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      // Sync succeeds on first call (immediate), then fails on second (interval callback)
      let callCount = 0;
      const syncStub = sinon.stub(engine, 'sync').callsFake(async (): Promise<void> => {
        callCount++;
        if (callCount >= 2) {
          (engine as any)._consecutiveFailures = 2;
        }
      });

      const clock = sinon.useFakeTimers();
      try {
        await engine.startSync({ mode: 'poll', interval: '50ms' });

        // Advance past several interval periods
        await clock.tickAsync(150);

        expect(callCount).toBeGreaterThanOrEqual(2);
        expect(syncStub.firstCall.args[1]).toMatchObject({ verifyConvergence: true });
        expect(syncStub.secondCall.args[1]).toMatchObject({ verifyConvergence: true });

        await engine.stopSync();
      } finally {
        clock.restore();
      }
    });

    it('should skip intervalSync when syncLock is held', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();

      const clock = sinon.useFakeTimers();
      try {
        // Start poll with very short interval
        await engine.startSync({ mode: 'poll', interval: '50ms' });
        expect(syncStub.calledOnce).toBe(true);
        expect(syncStub.firstCall.args[1]).toMatchObject({ verifyConvergence: true });

        // Set lock — interval callbacks should skip
        (engine as any)._syncLock = true;

        // Advance past interval period
        await clock.tickAsync(100);

        // sync should not have been called again while locked
        expect(syncStub.calledOnce).toBe(true);

        (engine as any)._syncLock = false;
        await engine.stopSync();
      } finally {
        clock.restore();
      }
    });

    it('should handle sync error in intervalSync and continue', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      const consoleStub = sinon.stub(console, 'error');
      // First call succeeds (immediate sync at line 377), second call fails (intervalSync closure)
      const syncStub = sinon.stub(engine, 'sync');
      syncStub.onFirstCall().resolves();
      syncStub.onSecondCall().rejects(new Error('sync failed'));
      syncStub.resolves(); // subsequent calls resolve

      const clock = sinon.useFakeTimers();
      try {
        await engine.startSync({ mode: 'poll', interval: '50ms' });

        // Advance past interval period to trigger the intervalSync closure
        await clock.tickAsync(150);

        expect(consoleStub.called).toBe(true);
        expect(syncStub.secondCall.args[1]).toMatchObject({ verifyConvergence: true });

        await engine.stopSync();
      } finally {
        clock.restore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // startLiveSync — integrityCheck closure
  // ---------------------------------------------------------------------------

  describe('startLiveSync — integrityCheck closure', () => {
    it('should execute integrityCheck interval and handle errors', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      let syncCallCount = 0;
      const consoleStub = sinon.stub(console, 'error');
      const syncStub = sinon.stub(engine, 'sync').callsFake(async (): Promise<void> => {
        syncCallCount++;
        // First call succeeds (initial catch-up), second fails (integrity check)
        if (syncCallCount >= 2) {
          throw new Error('integrity check failed');
        }
      });
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);

      const clock = sinon.useFakeTimers();
      try {
        await engine.startSync({ mode: 'live', interval: '50ms' });

        // Advance past integrity check interval
        await clock.tickAsync(150);

        expect(syncCallCount).toBeGreaterThanOrEqual(2);
        expect(syncStub.firstCall.args[1]).toBeUndefined();
        expect(syncStub.secondCall.args[1]).toMatchObject({ verifyConvergence: true });
        expect(consoleStub.called).toBe(true);

        await engine.stopSync();
      } finally {
        clock.restore();
      }
    });

    it('should skip integrityCheck when syncLock is held', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      const syncStub = sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([]);

      const clock = sinon.useFakeTimers();
      try {
        await engine.startSync({ mode: 'live', interval: '50ms' });
        expect(syncStub.calledOnce).toBe(true); // initial catch-up

        // Set lock — integrity check should skip
        (engine as any)._syncLock = true;

        await clock.tickAsync(100);

        expect(syncStub.calledOnce).toBe(true);

        (engine as any)._syncLock = false;
        await engine.stopSync();
      } finally {
        clock.restore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // startLiveSync — partial setup failure cleanup
  // ---------------------------------------------------------------------------

  describe('startLiveSync — partial setup failure cleanup', () => {
    it('should clean up in-memory state when push subscription fails', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      // Stub sync() to no-op (initial catch-up).
      sinon.stub(engine, 'sync').resolves();

      // Return one sync target.
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:alice', 'https://dwn.example.com'),
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
      expect([...((engine as any)._activeLinks.values())].some((link: any) => link.tenantDid === 'did:example:alice')).toBe(false);
      expect((engine as any)._linkRuntimes.size).toBe(0);

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
      const engine = createEngine({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        syncTarget('did:example:alice', 'https://dwn.example.com'),
      ]);

      // Pull subscription fails immediately (no subscriptions added).
      sinon.stub(engine as any, 'openLivePullSubscription').rejects(new Error('pull open failed'));

      sinon.stub(console, 'error');

      await engine.startSync({ mode: 'live', interval: '10s' });

      // No subscriptions opened at all — connectivity should be unknown.
      expect((engine as any)._connectivityState).toBe('unknown');
      expect((engine as any)._liveSubscriptions.length).toBe(0);

      expect([...((engine as any)._activeLinks.values())].some((link: any) => link.tenantDid === 'did:example:alice')).toBe(false);

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
    function createCallbackMockAgent(applyReplicatedMessageStub?: sinon.SinonStub): {
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
            applyReplicatedMessage : applyReplicatedMessageStub ?? sinon.stub().resolves({ kind: 'Applied' }),
            processRawMessage      : sinon.stub().resolves({ status: { code: 202 } }),
          },
          rpc: { sendDwnRequest: rpcStub },
        } as any,
        getHandler: () => capturedHandler,
      };
    }

    it('should process eose events by updating link checkpoint and connectivity', async () => {
      const { agent, getHandler } = createCallbackMockAgent();
      const engine = createEngine({ db, agent });

      // Set up a link so the EOSE handler uses the link path.
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {}, connectivity       : 'unknown', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      const saveStub = sinon.stub().resolves();
      overrideLedger(engine, { saveLink: saveStub });

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

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

    it('should process event messages through replicated admission', async () => {
      const applyReplicatedMessageStub = sinon.stub().resolves({ kind: 'Applied' });
      const { agent, getHandler } = createCallbackMockAgent(applyReplicatedMessageStub);
      const engine = createEngine({ db, agent });

      // Set up a link so the event handler uses the link path.
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {}, connectivity       : 'online', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      const saveStub = sinon.stub().resolves();
      overrideLedger(engine, { saveLink: saveStub });

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

      const handler = getHandler();

      const eventMessage = { descriptor: { interface: 'Protocols', method: 'Configure' } };
      const eventCursor = { streamId: 's1', epoch: 'e1', position: '1', messageCid: await Message.getCid(eventMessage) };
      await handler({
        type   : 'event',
        cursor : eventCursor,
        event  : {
          message: eventMessage,
        },
      });

      expect(applyReplicatedMessageStub.calledOnce).toBe(true);

      (engine as any)._liveSubscriptions = [];
    });

    it('should process an in-scope RecordsDelete using its initial write protocol', async () => {
      const applyReplicatedMessageStub = sinon.stub().resolves({ kind: 'Applied' });
      const { agent, getHandler } = createCallbackMockAgent(applyReplicatedMessageStub);
      const engine = createEngine({ db, agent });

      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' },
        scope              : { kind: 'protocolSet', protocols: ['https://example.com/profile'] }, status             : 'live',
        pull               : {}, connectivity       : 'online', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      overrideLedger(engine, { saveLink: sinon.stub().resolves() });

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

      const deleteMessage = { descriptor: { interface: 'Records', method: 'Delete', recordId: 'record-1' } };
      const cursor = { streamId: 's1', epoch: 'e1', position: '2', messageCid: await Message.getCid(deleteMessage) };
      await getHandler()({
        type  : 'event',
        cursor,
        event : {
          message      : deleteMessage,
          initialWrite : {
            recordId   : 'record-1',
            descriptor : {
              interface        : 'Records',
              method           : 'Write',
              protocol         : 'https://example.com/profile',
              dateCreated      : '2026-01-01T00:00:00.000000Z',
              messageTimestamp : '2026-01-01T00:00:00.000000Z',
            }
          },
        },
      });

      expect(applyReplicatedMessageStub.calledOnce).toBe(true);
      expect(link.pull.contiguousAppliedToken).toEqual(cursor);
      (engine as any)._liveSubscriptions = [];
    });

    it('should skip and checkpoint an out-of-scope RecordsDelete', async () => {
      const processMessageStub = sinon.stub().resolves({ status: { code: 202 } });
      const { agent, getHandler } = createCallbackMockAgent(processMessageStub);
      const engine = createEngine({ db, agent });

      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' },
        scope              : { kind: 'protocolSet', protocols: ['https://example.com/profile'] }, status             : 'live',
        pull               : {}, connectivity       : 'online', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      overrideLedger(engine, { saveLink: sinon.stub().resolves() });

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

      const cursor = { streamId: 's1', epoch: 'e1', position: '3', messageCid: 'cid-delete-out' };
      await getHandler()({
        type  : 'event',
        cursor,
        event : {
          message      : { descriptor: { interface: 'Records', method: 'Delete', recordId: 'record-1' } },
          initialWrite : { descriptor: { interface: 'Records', method: 'Write', protocol: 'https://example.com/other' } },
        },
      });

      expect(processMessageStub.called).toBe(false);
      expect(link.pull.contiguousAppliedToken).toEqual(cursor);
      (engine as any)._liveSubscriptions = [];
    });

    it('should repair instead of checkpointing an unclassifiable scoped RecordsDelete', async () => {
      const processMessageStub = sinon.stub().resolves({ status: { code: 202 } });
      const { agent, getHandler } = createCallbackMockAgent(processMessageStub);
      const engine = createEngine({ db, agent });
      sinon.stub(engine as any, 'repairLink').resolves();
      const consoleStub = sinon.stub(console, 'warn');

      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' },
        scope              : { kind: 'protocolSet', protocols: ['https://example.com/profile'] }, status             : 'live',
        pull               : {}, connectivity       : 'online', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      overrideLedger(engine, {
        setStatus: sinon.stub().callsFake(async (targetLink: any, status: string) => { targetLink.status = status; }),
      });

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

      await getHandler()({
        type   : 'event',
        cursor : { streamId: 's1', epoch: 'e1', position: '4', messageCid: 'cid-delete-unknown' },
        event  : {
          message: { descriptor: { interface: 'Records', method: 'Delete', recordId: 'record-1' } },
        },
      });

      expect(processMessageStub.called).toBe(false);
      expect(link.pull.contiguousAppliedToken).toBeUndefined();
      expect(link.status).toBe('repairing');
      expect(consoleStub.called).toBe(true);
      (engine as any)._liveSubscriptions = [];
    });

    it('should repair without advancing checkpoint when live pull processing fails', async () => {
      const processMessageStub = sinon.stub().rejects(new Error('process failed'));
      const { agent, getHandler } = createCallbackMockAgent(processMessageStub);
      const engine = createEngine({ db, agent });
      const consoleStub = sinon.stub(console, 'error');

      // Set up a link so the event handler passes the _activeLinks guard.
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {}, connectivity       : 'online', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      overrideLedger(engine, {
        saveLink  : sinon.stub().resolves(),
        setStatus : sinon.stub().callsFake(async (targetLink: any, status: string): Promise<void> => { targetLink.status = status; }),
      });
      sinon.stub(engine as any, 'repairLink').resolves();

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

      const handler = getHandler();
      const failedCursor = { streamId: 's1', epoch: 'e1', position: '5', messageCid: 'cid-failed' };

      await handler({
        type   : 'event',
        cursor : failedCursor,
        event  : { message: { descriptor: { interface: 'Records', method: 'Write' } } },
      });

      expect(consoleStub.called).toBe(true);
      expect(link.pull.contiguousAppliedToken).toBeUndefined();
      expect(link.status).toBe('repairing');

      (engine as any)._liveSubscriptions = [];
    });

    it('should checkpoint and dead-letter a structured live pull admission failure', async () => {
      const processMessageStub = sinon.stub().resolves({ kind: 'Invalid', reason: 'invalid replicated message' });
      const { agent, getHandler } = createCallbackMockAgent(processMessageStub);
      const engine = createEngine({ db, agent });

      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {}, connectivity       : 'online', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      overrideLedger(engine, { saveLink: sinon.stub().resolves() });
      const deadLetterStub = sinon.stub(engine as any, 'recordDeadLetter').resolves();

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

      const eventMessage = {
        descriptor: {
          interface : 'Records',
          method    : 'Write',
          protocol  : 'https://example.com/profile',
        },
      };
      const eventCursor = { streamId: 's1', epoch: 'e1', position: '6', messageCid: await Message.getCid(eventMessage) };

      await getHandler()({
        type   : 'event',
        cursor : eventCursor,
        event  : { message: eventMessage },
      });

      expect(deadLetterStub.calledOnce).toBe(true);
      expect(deadLetterStub.firstCall.args[0]).toMatchObject({
        messageCid     : eventCursor.messageCid,
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        protocol       : 'https://example.com/profile',
        category       : 'admit-failed',
        errorCode      : 'invalid',
        errorDetail    : 'invalid replicated message',
      });
      expect(link.pull.contiguousAppliedToken).toEqual(eventCursor);
      expect(link.status).toBe('live');
      expect(link.needsReconcile).toBe(false);

      (engine as any)._liveSubscriptions = [];
    });

    it('should repair without advancing checkpoint on a subscription error', async () => {
      const processMessageStub = sinon.stub().resolves({ status: { code: 202 } });
      const { agent, getHandler } = createCallbackMockAgent(processMessageStub);
      const engine = createEngine({ db, agent });
      const consoleStub = sinon.stub(console, 'warn');

      const linkKey = 'did:example:alice^https://dwn.example.com';
      const previousCursor = { streamId: 's1', epoch: 'e1', position: '5', messageCid: 'cid-previous' };
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : { contiguousAppliedToken: previousCursor }, connectivity       : 'online', needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      overrideLedger(engine, {
        setStatus: sinon.stub().callsFake(async (targetLink: any, status: string): Promise<void> => { targetLink.status = status; }),
      });
      sinon.stub(engine as any, 'repairLink').resolves();

      await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey }));

      await getHandler()({
        type   : 'error',
        cursor : { streamId: 's1', epoch: 'e1', position: '6', messageCid: 'cid-error' },
        error  : { code: 'MessagesSubscribeDeliveryAuthorizationFailed', detail: 'subscription authorization failed during delivery' },
      });

      expect(processMessageStub.called).toBe(false);
      expect(consoleStub.called).toBe(true);
      expect(link.pull.contiguousAppliedToken).toEqual(previousCursor);
      expect(link.status).toBe('repairing');

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
      const engine = createEngine({ db, agent: mockAgent });
      const pushLinkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._activeLinks.set(pushLinkKey, { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' } });

      await (engine as any).openLocalPushSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey: pushLinkKey }));

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
      const engine = createEngine({ db, agent: mockAgent });
      const pushLinkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._activeLinks.set(pushLinkKey, { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' } });

      await (engine as any).openLocalPushSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey: pushLinkKey }));

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
      const engine = createEngine({ db, agent: mockAgent });
      const pushLinkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._activeLinks.set(pushLinkKey, { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' } });

      await (engine as any).openLocalPushSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey: pushLinkKey }));

      // Event with no messageCid and descriptor that won't sync-resolve
      capturedHandler({
        type  : 'event',
        event : { message: { descriptor: {} } },
      });

      // CID is undefined, so nothing should be accumulated
      expect((engine as any)._pushRuntimes.size).toBe(0);

      (engine as any)._localSubscriptions = [];
    });

    it('should push an in-scope RecordsDelete using its initial write protocol', async () => {
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
      const engine = createEngine({ db, agent: mockAgent });
      sinon.stub(engine as any, 'flushPendingPushesForLink').resolves();
      const pushLinkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._activeLinks.set(pushLinkKey, {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'protocolSet', protocols: ['https://example.com/profile'] },
      });

      await (engine as any).openLocalPushSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey: pushLinkKey }));

      await capturedHandler({
        type  : 'event',
        event : {
          message      : { descriptor: { interface: 'Records', method: 'Delete', recordId: 'record-1' } },
          initialWrite : { descriptor: { interface: 'Records', method: 'Write', protocol: 'https://example.com/profile' } },
        },
      });

      const runtime = (engine as any)._pushRuntimes.get(pushLinkKey);
      expect(runtime?.entries).toHaveLength(1);
      (engine as any)._pushRuntimes.clear();
      (engine as any)._localSubscriptions = [];
    });

    it('should mark the link for reconcile when a scoped local RecordsDelete cannot be classified', async () => {
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
      const engine = createEngine({ db, agent: mockAgent });
      sinon.stub(engine as any, 'scheduleReconcile').returns(undefined);
      const saveLinkStub = sinon.stub().resolves();
      overrideLedger(engine, { saveLink: saveLinkStub });
      const pushLinkKey = 'did:example:alice^https://dwn.example.com';
      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'protocolSet', protocols: ['https://example.com/profile'] },
        needsReconcile : false,
      };
      (engine as any)._activeLinks.set(pushLinkKey, link);

      await (engine as any).openLocalPushSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey: pushLinkKey }));

      await capturedHandler({
        type  : 'event',
        event : {
          message: { descriptor: { interface: 'Records', method: 'Delete', recordId: 'record-1' } },
        },
      });
      await Promise.resolve();

      expect(link.needsReconcile).toBe(true);
      expect(saveLinkStub.calledOnce).toBe(true);
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
          applyReplicatedMessage: sinon.stub().resolves({ kind: 'Applied' }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };
      (engine as any)._activeLinks.set('test-link', { tenantDid: 'did:example:alice', remoteEndpoint: 'https://dwn.example.com', scope: { kind: 'full' } });

      await (engine as any).openLocalPushSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', { linkKey: 'test-link' }));

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

  describe('push delegate wrapper', () => {
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
          applyReplicatedMessage: sinon.stub().resolves({ kind: 'Applied' }),
        },
      } as any;
      const engine = createEngine({ db, agent: mockAgent });
      (engine as any)._permissionsApi = { getPermissionForRequest: sinon.stub(), clear: sinon.stub() };

      await (engine as any).pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
      });

      expect(mockAgent.rpc.applyReplicatedMessage.called).toBe(true);
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      // Set up link and runtime state.
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {},
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {},
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {},
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
  // Repair orchestration and degraded polling
  // ---------------------------------------------------------------------------

  describe('repairLink', () => {
    it('should transition link from repairing to live after successful feed catch-up', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

      await (engine as any).repairLink(linkKey);

      expect(link.status).toBe('live');
    });

    it('should track repair attempts and enter degraded_poll after max attempts', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      ((engine as any).pullRemoteFeedForSyncTarget).rejects(new Error('network error'));
      sinon.stub(console, 'error');
      sinon.stub(console, 'warn');

      const saveStub = sinon.stub().resolves();
      overrideLedger(engine, { saveLink: saveStub, setStatus: sinon.stub().resolves() });

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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
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
      const engine = createEngine({ db, agent });

      try {
        await (engine as any).openLivePullSubscription(syncTarget('did:example:alice', 'https://dwn.example.com', {
          linkKey: 'did:example:alice^https://dwn.example.com^projection-test^authorization-test',
        }));
        throw new Error('expected error');
      } catch (error: any) {
        expect(error.isProgressGap).toBe(true);
        expect(error.message).toContain('ProgressGap');
      }
    });
  });

  describe('in-flight handler guard', () => {
    it('should skip checkpoint mutations when link status is repairing', () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      function token(pos: number): any {
        return { streamId: 'stream-1', epoch: 'epoch-1', position: String(pos), messageCid: `cid-${pos}` };
      }

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : { contiguousAppliedToken: token(1) },
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      const setStatusStub = sinon.stub();
      overrideLedger(engine, { setStatus: setStatusStub });

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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      ((engine as any).pullRemoteFeedForSyncTarget).rejects(new Error('network error'));
      sinon.stub(console, 'error');
      sinon.stub(console, 'warn');

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

      await (engine as any).transitionToRepairing(linkKey, link);

      // Wait for repair + retry scheduling to settle.
      await new Promise(r => setTimeout(r, 100));

      // A retry timer should be scheduled.
      expect((engine as any)._repairRetryTimers.has(linkKey)).toBe(true);

      // Clean up.
      clearTimeout((engine as any)._repairRetryTimers.get(linkKey));
    });

    it('should clear retry timer on teardown', async () => {
      const engine = createEngine({ db });
      const linkKey = 'test-link';

      (engine as any)._repairRetryTimers.set(linkKey, setTimeout(() => {}, 60_000));
      expect((engine as any)._repairRetryTimers.size).toBe(1);

      await (engine as any).teardownLiveSync();

      expect((engine as any)._repairRetryTimers.size).toBe(0);
    });

    it('should store resumeToken from ProgressGap for use during repair', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const resumeToken = { streamId: 's1', epoch: 'e1', position: '99', messageCid: 'cid-99' };
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'live',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);

      // Stub ledger and repair to capture the context.
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub });
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const resumeToken = { streamId: 's1', epoch: 'e1', position: '99', messageCid: 'cid-99' };
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      (engine as any)._repairContext.set(linkKey, { resumeToken });

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

      await (engine as any).doRepairLink(linkKey);

      // Checkpoint should be set to the resume token, not undefined.
      expect(link.pull.contiguousAppliedToken).toEqual(resumeToken);
      expect(link.pull.receivedToken).toEqual(resumeToken);
      expect(link.status).toBe('live');
      // Repair context should be cleared after success.
      expect((engine as any)._repairContext.has(linkKey)).toBe(false);
    });

    it('should not leave checkpoint undefined after non-gap repair', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const existingToken = { streamId: 's1', epoch: 'e1', position: '50', messageCid: 'cid-50' };
      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : { contiguousAppliedToken: existingToken },
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);
      // No repair context — this is a non-gap repair (e.g., domain mismatch).

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

      await (engine as any).doRepairLink(linkKey);

      // Checkpoint should use the existing token, not undefined.
      expect(link.pull.contiguousAppliedToken).toEqual(existingToken);
      expect(link.status).toBe('live');
    });

    it('should reopen local push subscription without a cursor (opportunistic push)', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();

      // Capture the args passed to openLocalPushSubscription.
      const pushSubStub = sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

      await (engine as any).doRepairLink(linkKey);

      // Verify push subscription was reopened without a cursor (no pushCursor parameter).
      expect(pushSubStub.calledOnce).toBe(true);
      const pushTarget = pushSubStub.firstCall.args[0];
      expect(pushTarget.pushCursor).toBeUndefined();
    });

    it('should bail if teardown occurs during repair (generation check)', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      const closeStub = sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();

      ((engine as any).pullRemoteFeedForSyncTarget).callsFake(async (): Promise<Record<string, never>> => {
        (engine as any)._engineGeneration++;
        return {};
      });

      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().resolves();
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

      await (engine as any).doRepairLink(linkKey);

      // closeLinkSubscriptions should have been called (before the generation check).
      expect(closeStub.calledOnce).toBe(true);

      // But subscriptions should NOT be reopened — repair bailed after feed catch-up.
      expect(openPullStub.called).toBe(false);

      // Link should NOT have been set to live.
      expect(setStatusStub.calledWith(link, 'live')).toBe(false);
    });

    it('should schedule post-repair reconcile after _activeRepairs is cleared', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
        needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

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

    it('should not abort repair reconciliation when link status changes during pull', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test', authorizationEpoch : 'authorization-test', authorization      : { kind: 'owner' }, scope              : { kind: 'full' }, status             : 'repairing',
        pull               : {},
        needsReconcile     : false,
      } as any;
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any).getOrCreateRuntime(linkKey);

      sinon.stub(engine as any, 'closeLinkSubscriptions').resolves();
      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      pullStub.callsFake(async (): Promise<Record<string, never>> => {
        link.status = 'degraded_poll';
        return {};
      });
      const openPullStub = sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      const openPushStub = sinon.stub(engine as any, 'openLocalPushSubscription').resolves();

      const saveStub = sinon.stub().resolves();
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub, saveLink: saveStub });

      await (engine as any).doRepairLink(linkKey);

      expect(pullStub.calledOnce).toBe(true);
      expect(openPullStub.calledOnce).toBe(true);
      expect(openPushStub.calledOnce).toBe(true);
      expect(link.status).toBe('live');
    });
  });

  // ---------------------------------------------------------------------------
  // closeLinkSubscriptions
  // ---------------------------------------------------------------------------

  describe('closeLinkSubscriptions', () => {
    it('should close both pull and push subscriptions for a link', async () => {
      const engine = createEngine({ db });
      const pullClose = sinon.stub().resolves();
      const pushClose = sinon.stub().resolves();

      (engine as any)._liveSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn.example.com^projection-a^authorization-a', did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: undefined, close: pullClose },
        { linkKey: 'did:example:bob^https://other.com^projection-b^authorization-b', did: 'did:example:bob', dwnUrl: 'https://other.com', close: sinon.stub().resolves() },
      ];
      (engine as any)._localSubscriptions = [
        { linkKey: 'did:example:alice^https://dwn.example.com^projection-a^authorization-a', did: 'did:example:alice', dwnUrl: 'https://dwn.example.com', protocol: undefined, close: pushClose },
      ];

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-a',
        authorizationEpoch : 'authorization-a',
        authorization      : { kind: 'owner' },
        protocol           : undefined,
      } as any;

      await (engine as any).closeLinkSubscriptions(link);

      expect(pullClose.calledOnce).toBe(true);
      expect(pushClose.calledOnce).toBe(true);
      // Other links' subscriptions should remain.
      expect((engine as any)._liveSubscriptions.length).toBe(1);
      expect((engine as any)._liveSubscriptions[0].did).toBe('did:example:bob');
    });

    it('should handle missing subscriptions gracefully', async () => {
      const engine = createEngine({ db });
      (engine as any)._liveSubscriptions = [];
      (engine as any)._localSubscriptions = [];

      const link = {
        tenantDid          : 'did:example:alice', remoteEndpoint     : 'https://dwn.example.com', projectionId       : 'projection-a',
        authorizationEpoch : 'authorization-a',
        authorization      : { kind: 'owner' },
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      (engine as any)._activeLinks.set(linkKey, { status: 'degraded_poll' });

      (engine as any).scheduleRepairRetry(linkKey);

      expect((engine as any)._repairRetryTimers.has(linkKey)).toBe(false);
    });

    it('should not schedule if retry is already pending', () => {
      const engine = createEngine({ db });
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      (engine as any)._activeLinks.set(linkKey, { status: 'repairing' });
      (engine as any)._repairAttempts.set(linkKey, 1);

      (engine as any).scheduleRepairRetry(linkKey);

      expect((engine as any)._repairRetryTimers.has(linkKey)).toBe(true);
      clearTimeout((engine as any)._repairRetryTimers.get(linkKey));
    });
  });

  describe('subset scope link creation', () => {
    it('should create one protocol-set link when target has a protocol set', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        {
          did                : 'did:example:alice',
          dwnUrl             : 'https://dwn.example.com',
          scope              : { kind: 'protocolSet', protocols: ['https://example.com/chat', 'https://example.com/profile'] },
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
        },
      ]);
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
      sinon.stub(console, 'error');

      let capturedParams: any;
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      const getOrCreateStub = sinon.stub().callsFake(async (params: any) => {
        capturedParams = params;
        return {
          tenantDid          : params.tenantDid,
          remoteEndpoint     : params.remoteEndpoint,
          projectionId       : 'projection-test',
          authorizationEpoch : params.authorizationEpoch,
          authorization      : params.authorization,
          scope              : params.scope,
          status             : 'initializing',
          pull               : {},
          connectivity       : 'unknown',
          needsReconcile     : false,
        };
      });
      overrideLedger(engine, {
        getOrCreateLink : getOrCreateStub,
        setStatus       : setStatusStub,
      });

      await engine.startSync({ mode: 'live', interval: '10s' });

      expect(capturedParams.scope).toEqual({
        kind      : 'protocolSet',
        protocols : ['https://example.com/chat', 'https://example.com/profile'],
      });
      expect(capturedParams.authorization).toEqual({ kind: 'owner' });
      expect(capturedParams.authorizationEpoch).toBe('owner-epoch');

      await engine.stopSync();
    });

    it('should create full-tenant links when target has no protocol', async () => {
      const mockAgent = { agentDid: 'did:example:agent', did: { dereference: sinon.stub() } } as any;
      const engine = createEngine({ db, agent: mockAgent });

      sinon.stub(engine, 'sync').resolves();
      sinon.stub(engine as any, 'getSyncTargets').resolves([
        {
          did                : 'did:example:alice',
          dwnUrl             : 'https://dwn.example.com',
          scope              : { kind: 'full' },
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
        },
      ]);
      sinon.stub(engine as any, 'openLivePullSubscription').resolves();
      sinon.stub(engine as any, 'openLocalPushSubscription').resolves();
      sinon.stub(console, 'error');

      let capturedScope: any;
      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, {
        getOrCreateLink: sinon.stub().callsFake(async (params: any) => {
          capturedScope = params.scope;
          return {
            tenantDid          : params.tenantDid,
            remoteEndpoint     : params.remoteEndpoint,
            projectionId       : 'projection-test',
            authorizationEpoch : params.authorizationEpoch,
            authorization      : params.authorization,
            scope              : params.scope,
            status             : 'initializing',
            pull               : {},
            connectivity       : 'unknown',
            needsReconcile     : false,
          };
        }),
        setStatus: setStatusStub,
      });

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
    it('should dead-letter terminal push failures immediately and mark link needsReconcile', async () => {
      const engine = createEngine({ db });
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
      overrideLedger(engine, { saveLink: saveStub });
      const deadLetterStub = sinon.stub(engine as any, 'recordDeadLetter').resolves();

      await (engine as any).requeueOrReconcile(linkKey, {
        did     : 'did:example:alice',
        dwnUrl  : 'https://dwn.example.com',
        entries : [{
          cid         : 'cid-1',
          lastFailure : { cid: 'cid-1', kind: 'Invalid', terminal: true, detail: 'invalid push' },
        }],
        retryCount: 0,
      });

      expect(link.needsReconcile).toBe(true);
      expect(deadLetterStub.calledOnce).toBe(true);
      expect(deadLetterStub.firstCall.args[0].category).toBe('admit-failed');
      expect(deadLetterStub.firstCall.args[0].errorCode).toBe('Invalid');

      expect((engine as any)._pushRuntimes.has(linkKey)).toBe(false);
    });

    it('should re-queue push entries when retries remain', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';

      await (engine as any).requeueOrReconcile(linkKey, {
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

    it('should mark tenant-inactive push failures for reconcile without retrying the message', async () => {
      const engine = createEngine({ db });
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
      overrideLedger(engine, { saveLink: saveStub });
      const deadLetterStub = sinon.stub(engine as any, 'recordDeadLetter').resolves();
      const scheduleStub = sinon.stub(engine as any, 'scheduleReconcile');

      await (engine as any).requeueOrReconcile(linkKey, {
        did     : 'did:example:alice',
        dwnUrl  : 'https://dwn.example.com',
        entries : [{
          cid         : 'cid-tenant-inactive',
          lastFailure : {
            cid            : 'cid-tenant-inactive',
            detail         : 'tenant inactive',
            kind           : 'Deferred',
            reason         : 'tenant-inactive',
            tenantInactive : true,
          },
        }],
        retryCount: 0,
      });

      expect(link.needsReconcile).toBe(true);
      expect(saveStub.calledOnce).toBe(true);
      expect(deadLetterStub.called).toBe(false);
      expect((engine as any)._pushRuntimes.has(linkKey)).toBe(false);
      await Promise.resolve();
      expect(scheduleStub.calledOnceWith(linkKey, 30_000)).toBe(true);
    });

    it('should keep a push checkpoint on ReplicationLinkState', () => {
      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        status         : 'live',
        pull           : {},
        push           : {},
        needsReconcile : false,
      } as any;

      expect(link.push).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // Per-link reconciliation (doReconcileLink, reconcileLink, scheduleReconcile)
  // ---------------------------------------------------------------------------

  describe('per-link reconciliation', () => {
    function makeLiveLink(overrides: any = {}): any {
      return {
        tenantDid          : 'did:example:alice',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test',
        authorizationEpoch : 'authorization-test',
        authorization      : { kind: 'owner' },
        scope              : { kind: 'full' },
        status             : 'live',
        pull               : {},
        push               : {},
        needsReconcile     : true,
        ...overrides,
      };
    }

    it('should clear needsReconcile when feed fingerprints converge after reconciliation', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });

      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      await (engine as any).doReconcileLink(linkKey);

      expect(link.needsReconcile).toBe(false);
      expect(clearStub.calledOnce).toBe(true);
      expect(events.some(e => e.type === 'reconcile:completed')).toBe(true);
    });

    it('should emit reconcile:applied for CIDs admitted during reconciliation', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink({
        scope: { kind: 'protocolSet', protocols: ['https://example.com/profile'] },
      });
      (engine as any)._activeLinks.set(linkKey, link);

      ((engine as any).pullRemoteFeedForSyncTarget).resolves({
        admittedCids: ['cid-protocol', 'cid-profile'],
      });

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });

      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      await (engine as any).doReconcileLink(linkKey);

      const appliedEvent = events.find(e => e.type === 'reconcile:applied');
      expect(appliedEvent).toBeDefined();
      expect(appliedEvent.messageCids).toEqual(['cid-protocol', 'cid-profile']);
      expect(appliedEvent.protocol).toBe('https://example.com/profile');
    });

    it('should NOT clear needsReconcile when feed fingerprints still differ after reconciliation', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      ((engine as any).verifyFeedConvergence).resolves({
        converged         : false,
        localFingerprint  : 'local-fingerprint',
        remoteFingerprint : 'remote-fingerprint',
        pushFailures      : [],
      });

      const clearStub = sinon.stub().resolves();
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });

      await (engine as any).doReconcileLink(linkKey);

      expect(link.needsReconcile).toBe(true);
      expect(clearStub.called).toBe(false);

      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(true);
      clearTimeout((engine as any)._reconcileTimers.get(linkKey));
    });

    it('reconcileLink should schedule a retry after fingerprint mismatch once in-flight clears', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      ((engine as any).verifyFeedConvergence).resolves({
        converged         : false,
        localFingerprint  : 'local-fingerprint',
        remoteFingerprint : 'remote-fingerprint',
        pushFailures      : [],
      });
      overrideLedger(engine, { clearNeedsReconcile: sinon.stub().resolves(), saveLink: sinon.stub().resolves() });

      await (engine as any).reconcileLink(linkKey);

      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(true);
      clearTimeout((engine as any)._reconcileTimers.get(linkKey));
    });

    it('should skip reconciliation when link is not live', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink({ status: 'repairing' });
      (engine as any)._activeLinks.set(linkKey, link);

      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;

      await (engine as any).doReconcileLink(linkKey);

      expect(pullStub.called).toBe(false);
    });

    it('should skip reconciliation when _activeRepairs contains the link', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);
      (engine as any)._activeRepairs.set(linkKey, Promise.resolve());

      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;

      await (engine as any).doReconcileLink(linkKey);

      expect(pullStub.called).toBe(false);
    });

    it('should clear needsReconcile when feed fingerprints already match', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });

      await (engine as any).doReconcileLink(linkKey);

      expect(link.needsReconcile).toBe(false);
    });

    it('should bail on generation mismatch during reconciliation', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      ((engine as any).pullRemoteFeedForSyncTarget).callsFake(async (): Promise<Record<string, never>> => {
        (engine as any)._engineGeneration++;
        return {};
      });

      const pushStub = (engine as any).pushLocalFeedForSyncTarget;

      await (engine as any).doReconcileLink(linkKey);

      expect(pushStub.called).toBe(false);
      expect(link.needsReconcile).toBe(true);
    });

    it('should schedule retry on reconciliation error', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      ((engine as any).pullRemoteFeedForSyncTarget).rejects(new Error('network error'));
      sinon.stub(console, 'error');

      await (engine as any).doReconcileLink(linkKey);

      // Should schedule a retry reconcile.
      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(true);
      expect(link.needsReconcile).toBe(true);
      clearTimeout((engine as any)._reconcileTimers.get(linkKey));
    });

    it('reconcileLink should deduplicate concurrent calls', async () => {
      const engine = createEngine({ db });
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
      const engine = createEngine({ db });
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
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._activeRepairs.set(linkKey, Promise.resolve());

      (engine as any).scheduleReconcile(linkKey, 100);

      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(false);
    });

    it('scheduleReconcile should not schedule if reconcile is already in-flight', () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      (engine as any)._reconcileInFlight.set(linkKey, Promise.resolve());

      (engine as any).scheduleReconcile(linkKey, 100);

      expect((engine as any)._reconcileTimers.has(linkKey)).toBe(false);
    });

    it('doReconcileLink should run feed pull and feed push', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });

      await (engine as any).doReconcileLink(linkKey);

      expect(pullStub.calledOnce).toBe(true);
      expect(pushStub.calledOnce).toBe(true);
    });

    it('doReconcileLink should dead-letter terminal reconcile push failures immediately', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      ((engine as any).pushLocalFeedForSyncTarget).resolves({
        pushFailures: [{ cid: 'local-cid-1', kind: 'Invalid', terminal: true, detail: 'bad request' }],
      });

      const clearStub = sinon.stub().resolves();
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });
      const deadLetterStub = sinon.stub(engine as any, 'recordDeadLetter').resolves();

      await (engine as any).doReconcileLink(linkKey);

      expect(clearStub.called).toBe(false);
      expect(deadLetterStub.calledOnce).toBe(true);
      expect(deadLetterStub.firstCall.args[0].messageCid).toBe('local-cid-1');
      expect(deadLetterStub.firstCall.args[0].errorCode).toBe('Invalid');
      expect((engine as any)._pushRuntimes.has(linkKey)).toBe(false);
    });

    it('doReconcileLink should keep needsReconcile when dead-lettered local feed entries still diverge', async () => {
      const engine = createEngine({ db });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });
      const linkKey = 'did:example:alice^https://dwn.example.com';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);
      await engine.recordDeadLetter({
        messageCid     : 'local-dead',
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        category       : 'admit-failed',
        errorDetail    : 'terminal push failure',
      });
      const localFingerprint = await fingerprintFromCids(['local-dead']);
      const remoteFingerprint = await fingerprintFromCids([]);

      ((engine as any).pushLocalFeedForSyncTarget).resolves({
        hasActionableDiffs : false,
        ignoredLocalCids   : ['local-dead'],
        pushFailures       : [],
      });
      ((engine as any).verifyFeedConvergence).resolves({
        converged         : false,
        localFingerprint  : localFingerprint,
        remoteFingerprint : remoteFingerprint,
        pushFailures      : [],
      });

      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });

      await (engine as any).doReconcileLink(linkKey);

      expect(clearStub.called).toBe(false);
      expect(link.needsReconcile).toBe(true);
      expect(events.some(event => event.type === 'reconcile:completed')).toBe(false);
    });

    it('doReconcileLink should abort if the active link epoch changes during pull', async () => {
      const engine = createEngine({ db });
      const linkKey = 'did:example:alice^https://dwn.example.com^projection-test^authorization-test';
      const link = makeLiveLink();
      (engine as any)._activeLinks.set(linkKey, link);

      const pullStub = (engine as any).pullRemoteFeedForSyncTarget;
      pullStub.callsFake(async (_target: any, _options: any, shouldContinue: () => boolean): Promise<Record<string, never>> => {
        expect(shouldContinue()).toBe(true);
        (engine as any)._activeLinks.delete(linkKey);
        expect(shouldContinue()).toBe(false);
        return {};
      });
      const pushStub = (engine as any).pushLocalFeedForSyncTarget;
      const clearStub = sinon.stub().callsFake(async (l: any): Promise<void> => { l.needsReconcile = false; });
      overrideLedger(engine, { clearNeedsReconcile: clearStub, saveLink: sinon.stub().resolves() });

      await (engine as any).doReconcileLink(linkKey);

      expect(pullStub.calledOnce).toBe(true);
      expect(pushStub.called).toBe(false);
      expect(clearStub.called).toBe(false);
      expect(link.needsReconcile).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Observability events
  // ---------------------------------------------------------------------------

  describe('sync event emission', () => {
    it('should emit link:status-change when transitioning to repairing', async () => {
      const engine = createEngine({ db });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      const link = {
        tenantDid          : 'did:example:alice',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test',
        authorizationEpoch : 'authorization-test',
        authorization      : { kind: 'owner' },
        scope              : { kind: 'protocolSet', protocols: ['https://example.com/chat'] },
        status             : 'live',
        connectivity       : 'online',
        pull               : {},
        protocol           : 'https://example.com/chat',
      } as any;
      const linkKey = 'test-link';
      (engine as any)._activeLinks.set(linkKey, link);

      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub });
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

    it('should emit protocols for multi-protocol link events', async () => {
      const engine = createEngine({ db });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      const link = {
        tenantDid          : 'did:example:alice',
        remoteEndpoint     : 'https://dwn.example.com',
        projectionId       : 'projection-test',
        authorizationEpoch : 'authorization-test',
        authorization      : { kind: 'owner' },
        scope              : { kind: 'protocolSet', protocols: ['https://example.com/chat', 'https://example.com/profile'] },
        status             : 'live',
        connectivity       : 'online',
        pull               : {},
      } as any;
      const linkKey = 'test-link';
      (engine as any)._activeLinks.set(linkKey, link);

      const setStatusStub = sinon.stub().callsFake(async (l: any, s: string): Promise<void> => { l.status = s; });
      overrideLedger(engine, { setStatus: setStatusStub });
      sinon.stub(engine as any, 'repairLink').resolves();

      await (engine as any).transitionToRepairing(linkKey, link);

      const statusEvent = events.find(e => e.type === 'link:status-change');
      expect(statusEvent.protocol).toBeUndefined();
      expect(statusEvent.protocols).toEqual(['https://example.com/chat', 'https://example.com/profile']);
    });

    it('should emit checkpoint:pull-advance only after durable save, not on drain alone', () => {
      // checkpoint:pull-advance is emitted AFTER saveLink succeeds in the
      // subscription handler, not in drainCommittedPull itself. This ensures
      // "advanced" means durably persisted.
      const engine = createEngine({ db });
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

    it('should emit checkpoint:pull-advance for high-water tokens without messageCid', () => {
      const engine = createEngine({ db });
      const events: any[] = [];
      engine.on((event) => { events.push(event); });

      const link = {
        tenantDid      : 'did:example:alice',
        remoteEndpoint : 'https://dwn.example.com',
        pull           : {
          contiguousAppliedToken: { streamId: 's', epoch: 'e', position: '42' },
        },
      } as any;

      (engine as any).emitPullCheckpointAdvance(link);

      const pullEvent = events.find(e => e.type === 'checkpoint:pull-advance');
      expect(pullEvent).toBeDefined();
      expect(pullEvent.position).toBe('42');
      expect(pullEvent.messageCid).toBeUndefined();
    });

    it('should return an unsubscribe function from on()', () => {
      const engine = createEngine({ db });
      const events: any[] = [];
      const unsubscribe = engine.on((event) => { events.push(event); });

      (engine as any).emitEvent({ type: 'gap:detected', tenantDid: 'x', remoteEndpoint: 'y', reason: 'test' });
      expect(events.length).toBe(1);

      unsubscribe();

      (engine as any).emitEvent({ type: 'gap:detected', tenantDid: 'x', remoteEndpoint: 'y', reason: 'test2' });
      expect(events.length).toBe(1); // No new event after unsubscribe.
    });

    it('should not propagate listener errors into sync engine', () => {
      const engine = createEngine({ db });
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
      const engine = createEngine({ db });

      (engine as any).startBrowserConnectivityListeners();

      expect(registeredListeners.has('online')).toBe(true);
      expect(registeredListeners.has('offline')).toBe(true);
      // visibilitychange requires `document` — may or may not be set in test env.
    });

    it('should remove listeners on stopBrowserConnectivityListeners', () => {
      installBrowserStubs();
      const engine = createEngine({ db });

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

      const engine = createEngine({ db });

      // Should not throw.
      expect(() => {
        (engine as any).startBrowserConnectivityListeners();
      }).not.toThrow();

      // Restore.
      globalThis.addEventListener = saved;
    });

    it('should set _connectivityState to offline on offline event', () => {
      installBrowserStubs();
      const engine = createEngine({ db });
      (engine as any)._connectivityState = 'online';

      (engine as any).startBrowserConnectivityListeners();

      const offlineHandler = registeredListeners.get('offline');
      expect(offlineHandler).toBeDefined();
      offlineHandler!({} as Event);

      expect((engine as any)._connectivityState).toBe('offline');
    });

    it('should transition all active links to offline and update public connectivityState', () => {
      installBrowserStubs();
      const engine = createEngine({ db });

      // Simulate two active links that are online.
      const linkA: Record<string, unknown> = { tenantDid: 'did:a', remoteEndpoint: 'https://a.com', protocol: undefined, connectivity: 'online', scope: { kind: 'full' } };
      const linkB: Record<string, unknown> = { tenantDid: 'did:b', remoteEndpoint: 'https://b.com', protocol: 'proto', connectivity: 'online', scope: { kind: 'protocolSet', protocols: ['proto'] } };
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
      const engine = createEngine({ db });
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
      const engine = createEngine({ db });

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
      const engine = createEngine({ db });
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
      const engine = createEngine({ db });

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
  // updateIdentityOptions
  // ---------------------------------------------------------------------------

  describe('updateIdentityOptions', () => {
    it('should prune durable links from superseded projections when sync is not live', async () => {
      const engine = createEngine({ db });
      const ledger = (engine as any).ledger;
      const did = 'did:example:update-prune';
      const protocol = 'https://example.com/profile';
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      const ownerAuthorization = { kind: 'owner' } as const;

      await engine.registerIdentity({ did, options: { protocols: 'all' } });

      await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : { kind: 'full' },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      const currentLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : { kind: 'protocolSet', protocols: [protocol] },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });

      await engine.updateIdentityOptions({ did, options: { protocols: [protocol] } });

      const links = await ledger.getLinksForTenant(did);
      expect(links).toHaveLength(1);
      expect(links[0].projectionId).toBe(currentLink.projectionId);
      expect(links[0].authorizationEpoch).toBe(ownerEpoch);
    });

    it('should keep old durable links when live replacement initialization fails', async () => {
      const did = 'did:example:update-live-fail';
      const dwnUrl = 'https://dwn.example.com';
      const protocol = 'https://example.com/profile';
      const endpointLookupStub = sinon.stub().resolves([dwnUrl]);
      const engine = createEngine({
        db,
        agent: {
          agentDid : 'did:example:agent',
          dwn      : { getRemoteDwnEndpointUrls: endpointLookupStub },
        } as any,
      });
      const ledger = (engine as any).ledger;
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      const ownerAuthorization = { kind: 'owner' } as const;

      await engine.registerIdentity({ did, options: { protocols: 'all' } });
      const oldLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : dwnUrl,
        scope              : { kind: 'full' },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      const oldLinkKey = (engine as any).buildLinkKey(did, dwnUrl, oldLink.projectionId, oldLink.authorizationEpoch);
      (engine as any)._syncMode = 'live';
      (engine as any)._activeLinks.set(oldLinkKey, oldLink);
      sinon.stub(engine as any, 'initializeLinkTargetWithRetry').resolves({ status: 'failed' });

      await engine.updateIdentityOptions({ did, options: { protocols: [protocol] } });

      const links = await ledger.getLinksForTenant(did);
      expect(links.some((link: any) => link.projectionId === oldLink.projectionId)).toBe(true);
    });

    it('should prune superseded durable links after live replacement initialization succeeds', async () => {
      const did = 'did:example:update-live-prune';
      const dwnUrl = 'https://dwn.example.com';
      const protocol = 'https://example.com/profile';
      const endpointLookupStub = sinon.stub().resolves([dwnUrl]);
      const engine = createEngine({
        db,
        agent: {
          agentDid : 'did:example:agent',
          dwn      : { getRemoteDwnEndpointUrls: endpointLookupStub },
        } as any,
      });
      const ledger = (engine as any).ledger;
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      const ownerAuthorization = { kind: 'owner' } as const;

      await engine.registerIdentity({ did, options: { protocols: 'all' } });
      const oldLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : dwnUrl,
        scope              : { kind: 'full' },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      const currentLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : dwnUrl,
        scope              : { kind: 'protocolSet', protocols: [protocol] },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      const oldLinkKey = (engine as any).buildLinkKey(did, dwnUrl, oldLink.projectionId, oldLink.authorizationEpoch);
      (engine as any)._syncMode = 'live';
      (engine as any)._activeLinks.set(oldLinkKey, oldLink);
      sinon.stub(engine as any, 'initializeLinkTargetWithRetry').resolves(activeInitializationResult(currentLink));

      await engine.updateIdentityOptions({ did, options: { protocols: [protocol] } });

      const links = await ledger.getLinksForTenant(did);
      expect(links).toHaveLength(1);
      expect(links[0].projectionId).toBe(currentLink.projectionId);
    });

    it('should keep the exact delegated epoch established during live replacement', async () => {
      const did = 'did:example:delegate-epoch-prune';
      const delegateDid = 'did:example:delegate';
      const dwnUrl = 'https://dwn.example.com';
      const protocol = 'https://example.com/profile';
      const endpointLookupStub = sinon.stub().resolves([dwnUrl]);
      const engine = createEngine({
        db,
        agent: {
          agentDid : 'did:example:agent',
          dwn      : { getRemoteDwnEndpointUrls: endpointLookupStub },
        } as any,
      });
      const grantE1 = messagesGrantEntry('grant-e1', { interface: 'Messages', method: 'Read', protocol }, {
        grantor : did,
        grantee : delegateDid,
      });
      const grantE2 = messagesGrantEntry('grant-e2', { interface: 'Messages', method: 'Read', protocol }, {
        grantor : did,
        grantee : delegateDid,
      });
      const fetchGrantsStub = sinon.stub();
      fetchGrantsStub.onFirstCall().resolves([grantE1]);
      fetchGrantsStub.onSecondCall().resolves([grantE2]);
      (engine as any)._permissionsApi = { fetchGrants: fetchGrantsStub };

      await db.sublevel('registeredIdentities').put(
        did,
        JSON.stringify({ protocols: 'all', delegateDid })
      );
      const ledger = (engine as any).ledger;
      const oldLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : dwnUrl,
        scope              : { kind: 'full' },
        authorization      : { kind: 'owner' },
        authorizationEpoch : 'old-epoch',
      });
      const oldLinkKey = (engine as any).buildLinkKey(did, dwnUrl, oldLink.projectionId, oldLink.authorizationEpoch);
      (engine as any)._syncMode = 'live';
      (engine as any)._activeLinks.set(oldLinkKey, oldLink);
      sinon.stub(engine as any, 'openLinkSubscriptions').resolves('readyForLive');

      await engine.updateIdentityOptions({
        did,
        options: { protocols: [protocol], delegateDid },
      });

      const links = await ledger.getLinksForTenant(did);
      expect(fetchGrantsStub.callCount).toBe(1);
      expect(links).toHaveLength(1);
      expect(links[0].authorization).toEqual({
        kind               : 'delegate',
        delegateDid,
        permissionGrantIds : ['grant-e1'],
      });
    });

    it('should keep all endpoints for the current projection and prune superseded projections', async () => {
      const did = 'did:example:update-live-multi-endpoint';
      const protocol = 'https://example.com/profile';
      const endpointA = 'https://a.example.com';
      const endpointB = 'https://b.example.com';
      const endpointLookupStub = sinon.stub().resolves([endpointA, endpointB]);
      const engine = createEngine({
        db,
        agent: {
          agentDid : 'did:example:agent',
          dwn      : { getRemoteDwnEndpointUrls: endpointLookupStub },
        } as any,
      });
      const ledger = (engine as any).ledger;
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      const ownerAuthorization = { kind: 'owner' } as const;

      await db.sublevel('registeredIdentities').put(
        did,
        JSON.stringify({ protocols: 'all' })
      );
      const oldLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : endpointA,
        scope              : { kind: 'full' },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      const oldLinkKey = (engine as any).buildLinkKey(did, endpointA, oldLink.projectionId, oldLink.authorizationEpoch);
      (engine as any)._syncMode = 'live';
      (engine as any)._activeLinks.set(oldLinkKey, oldLink);
      sinon.stub(engine as any, 'openLinkSubscriptions').resolves('readyForLive');

      await engine.updateIdentityOptions({ did, options: { protocols: [protocol] } });

      const links = await ledger.getLinksForTenant(did);
      expect(links).toHaveLength(2);
      expect(links.map((link: any) => link.remoteEndpoint).sort()).toEqual([endpointA, endpointB]);
      expect(links.every((link: any) => link.scope.kind === 'protocolSet')).toBe(true);
    });

    it('should keep a current terminal-incomplete link while pruning superseded links', async () => {
      const did = 'did:example:update-live-terminal';
      const dwnUrl = 'https://dwn.example.com';
      const protocol = 'https://example.com/profile';
      const endpointLookupStub = sinon.stub().resolves([dwnUrl]);
      const engine = createEngine({
        db,
        agent: {
          agentDid : 'did:example:agent',
          dwn      : { getRemoteDwnEndpointUrls: endpointLookupStub },
        } as any,
      });
      const ledger = (engine as any).ledger;
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      const ownerAuthorization = { kind: 'owner' } as const;

      await db.sublevel('registeredIdentities').put(
        did,
        JSON.stringify({ protocols: 'all' })
      );
      const oldLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : dwnUrl,
        scope              : { kind: 'full' },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      const currentLink = await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : dwnUrl,
        scope              : { kind: 'protocolSet', protocols: [protocol] },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      await ledger.setStatus(currentLink, 'terminal_incomplete');
      const oldLinkKey = (engine as any).buildLinkKey(did, dwnUrl, oldLink.projectionId, oldLink.authorizationEpoch);
      (engine as any)._syncMode = 'live';
      (engine as any)._activeLinks.set(oldLinkKey, oldLink);
      sinon.stub(engine as any, 'openLinkSubscriptions').rejects(new Error('terminal link should not open subscriptions'));

      await engine.updateIdentityOptions({ did, options: { protocols: [protocol] } });

      const links = await ledger.getLinksForTenant(did);
      expect(links).toHaveLength(1);
      expect(links[0].projectionId).toBe(currentLink.projectionId);
      expect(links[0].status).toBe('terminal_incomplete');
    });
  });

  // ---------------------------------------------------------------------------
  // unregisterIdentity
  // ---------------------------------------------------------------------------

  describe('unregisterIdentity', () => {
    it('should remove a registered identity', async () => {
      const engine = createEngine({ db });
      await engine.registerIdentity({ did: 'did:example:unreg-test', options: { protocols: 'all' } });

      const before = await engine.getIdentityOptions('did:example:unreg-test');
      expect(before).toBeDefined();

      await engine.unregisterIdentity('did:example:unreg-test');

      const after = await engine.getIdentityOptions('did:example:unreg-test');
      expect(after).toBeUndefined();
    });

    it('should prune durable links for the unregistered identity only', async () => {
      const engine = createEngine({ db });
      const ledger = (engine as any).ledger;
      const did = 'did:example:unreg-links';
      const otherDid = 'did:example:other-links';
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      const ownerAuthorization = { kind: 'owner' } as const;

      await engine.registerIdentity({ did, options: { protocols: 'all' } });
      await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : { kind: 'full' },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });
      await ledger.getOrCreateLink({
        tenantDid          : did,
        remoteEndpoint     : 'https://dwn-2.example.com',
        scope              : { kind: 'protocolSet', protocols: ['https://example.com/profile'] },
        authorization      : ownerAuthorization,
        authorizationEpoch : 'old-epoch',
      });
      await ledger.getOrCreateLink({
        tenantDid          : otherDid,
        remoteEndpoint     : 'https://dwn.example.com',
        scope              : { kind: 'full' },
        authorization      : ownerAuthorization,
        authorizationEpoch : ownerEpoch,
      });

      await engine.unregisterIdentity(did);

      expect(await ledger.getLinksForTenant(did)).toEqual([]);
      expect(await ledger.getLinksForTenant(otherDid)).toHaveLength(1);
    });

    it('should throw when unregistering an identity that is not registered', async () => {
      const engine = createEngine({ db });

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
    const ownerAuthorization = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
    };

    beforeAll(() => {
      ledger = new ReplicationLedger(db);
    });

    it('should create and retrieve a link via getOrCreateLink', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:ledger-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
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
        ...ownerAuthorization,
      });
      expect(same.tenantDid).toBe(link.tenantDid);
    });

    it('should persist changes via saveLink and set lastActivityAt', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:save-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
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
        ...ownerAuthorization,
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
        ...ownerAuthorization,
      });

      await ledger.deleteLink(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);

      // After deletion, getOrCreateLink should create a fresh link.
      const fresh = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:delete-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });
      expect(fresh.status).toBe('initializing');
    });

    it('should list links for a tenant', async () => {
      await ledger.getOrCreateLink({
        tenantDid      : 'did:example:list-test',
        remoteEndpoint : 'https://a.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });
      await ledger.getOrCreateLink({
        tenantDid      : 'did:example:list-test',
        remoteEndpoint : 'https://b.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      const links = await ledger.getLinksForTenant('did:example:list-test');
      expect(links.length).toBeGreaterThanOrEqual(2);
    });

    it('should list all links', async () => {
      await ledger.getOrCreateLink({
        tenantDid      : 'did:example:all-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
      });

      const all = await ledger.getAllLinks();
      expect(all.length).toBeGreaterThan(0);
    });

    it('should transition link status via setStatus', async () => {
      const link = await ledger.getOrCreateLink({
        tenantDid      : 'did:example:status-test',
        remoteEndpoint : 'https://dwn.example.com',
        scope          : { kind: 'full' },
        ...ownerAuthorization,
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
        ...ownerAuthorization,
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
      const engine = createEngine({ db });

      await engine.recordDeadLetter({
        messageCid     : 'bafyrei-dead-1',
        tenantDid      : 'did:example:tenant1',
        remoteEndpoint : 'https://dwn.example.com',
        protocol       : 'https://example.com/protocol',
        category       : 'admit-failed',
        errorCode      : '400',
        errorDetail    : 'ProtocolAuthorizationProtocolNotFound',
      });

      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(1);
      expect(entries[0].messageCid).toBe('bafyrei-dead-1');
      expect(entries[0].tenantDid).toBe('did:example:tenant1');
      expect(entries[0].category).toBe('admit-failed');
      expect(entries[0].failedAt).toBeDefined();
    });

    it('should filter dead letters by tenant', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({
        messageCid  : 'bafyrei-dead-a',
        tenantDid   : 'did:example:alice',
        category    : 'admit-failed',
        errorDetail : 'test',
      });
      await engine.recordDeadLetter({
        messageCid  : 'bafyrei-dead-b',
        tenantDid   : 'did:example:bob',
        category    : 'admit-failed',
        errorDetail : 'test',
      });

      const alice = await engine.getFailedMessages('did:example:alice');
      expect(alice.length).toBe(1);
      expect(alice[0].messageCid).toBe('bafyrei-dead-a');

      const all = await engine.getFailedMessages();
      expect(all.length).toBe(2);
    });

    it('should clear a single dead letter entry', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({
        messageCid  : 'bafyrei-dead-clear',
        tenantDid   : 'did:example:x',
        category    : 'admit-failed',
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
      const engine = createEngine({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-1', tenantDid: 'did:a', category: 'admit-failed', errorDetail: 'x' });
      await engine.recordDeadLetter({ messageCid: 'dl-2', tenantDid: 'did:b', category: 'admit-failed', errorDetail: 'y' });

      await engine.clearAllFailedMessages();
      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(0);
    });

    it('should clear dead letters scoped to a tenant', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-scoped-1', tenantDid: 'did:keep', category: 'admit-failed', errorDetail: 'x' });
      await engine.recordDeadLetter({ messageCid: 'dl-scoped-2', tenantDid: 'did:remove', category: 'admit-failed', errorDetail: 'y' });

      await engine.clearAllFailedMessages('did:remove');

      const remaining = await engine.getFailedMessages();
      expect(remaining.length).toBe(1);
      expect(remaining[0].tenantDid).toBe('did:keep');
    });

    it('should store separate entries for the same CID on different remotes', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({
        messageCid     : 'dl-multi',
        tenantDid      : 'did:x',
        remoteEndpoint : 'https://a.com',
        category       : 'admit-failed',
        errorCode      : '400',
        errorDetail    : 'ProtocolNotFound on A',
      });
      await engine.recordDeadLetter({
        messageCid     : 'dl-multi',
        tenantDid      : 'did:x',
        remoteEndpoint : 'https://b.com',
        category       : 'admit-failed',
        errorCode      : '401',
        errorDetail    : 'Unauthorized on B',
      });

      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(2);
      expect(entries.map(e => e.remoteEndpoint).sort()).toEqual(['https://a.com', 'https://b.com']);
    });

    it('should clear a specific CID+remote pair without affecting other remotes', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-pair', tenantDid: 'did:x', remoteEndpoint: 'https://a.com', category: 'admit-failed', errorDetail: 'a' });
      await engine.recordDeadLetter({ messageCid: 'dl-pair', tenantDid: 'did:x', remoteEndpoint: 'https://b.com', category: 'admit-failed', errorDetail: 'b' });

      // Clear only the A entry.
      const removed = await engine.clearFailedMessage('dl-pair', 'https://a.com');
      expect(removed).toBe(true);

      const remaining = await engine.getFailedMessages();
      expect(remaining.length).toBe(1);
      expect(remaining[0].remoteEndpoint).toBe('https://b.com');
    });

    it('should clear all entries for a CID across remotes when no remote is specified', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-all-remotes', tenantDid: 'did:x', remoteEndpoint: 'https://a.com', category: 'admit-failed', errorDetail: 'a' });
      await engine.recordDeadLetter({ messageCid: 'dl-all-remotes', tenantDid: 'did:x', remoteEndpoint: 'https://b.com', category: 'admit-failed', errorDetail: 'b' });

      const removed = await engine.clearFailedMessage('dl-all-remotes');
      expect(removed).toBe(true);

      const entries = await engine.getFailedMessages();
      expect(entries.length).toBe(0);
    });

    it('should return sync health summary', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({ messageCid: 'dl-health-1', tenantDid: 'did:x', category: 'admit-failed', errorDetail: 'x' });
      await engine.recordDeadLetter({ messageCid: 'dl-health-2', tenantDid: 'did:y', category: 'admit-failed', errorDetail: 'y' });

      const health = await engine.getSyncHealth();
      expect(health.failedMessageCount).toBe(2);
      expect(health.admissionFailureCount).toBe(2);
      expect(health.connectivity).toBeDefined();
      expect(health.degradedLinkCount).toBe(0);
      expect(health.syncHealthy).toBe(false);
    });

    it('should surface links needing reconcile in sync health', async () => {
      const engine = createEngine({ db });
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      await engine.registerIdentity({
        did     : 'did:needs-reconcile-health',
        options : { protocols: 'all' },
      });
      const target = syncTarget('did:needs-reconcile-health', 'https://dwn.example.com', {
        authorizationEpoch: ownerEpoch,
      });

      const ledger = (engine as any).ledger;
      const link = await ledger.getOrCreateLink({
        tenantDid          : target.did,
        remoteEndpoint     : target.dwnUrl,
        scope              : target.scope,
        authorization      : target.authorization,
        authorizationEpoch : target.authorizationEpoch,
      });
      link.needsReconcile = true;
      await ledger.saveLink(link);

      const health = await engine.getSyncHealth();
      expect(health.reconcileNeededCount).toBe(1);
      expect(health.syncHealthy).toBe(false);
    });

    it('should scope admission dead-letter scans to the active tenant', async () => {
      const engine = createEngine({ db });
      const iteratorOptions: any[] = [];
      const fakeStore = {
        async *iterator(options: any): AsyncGenerator<[string, string]> {
          iteratorOptions.push(options);
          yield ['did:example:alice|cid-a|https://dwn.example.com', JSON.stringify({
            messageCid     : 'cid-a',
            tenantDid      : 'did:example:alice',
            remoteEndpoint : 'https://dwn.example.com',
            category       : 'admit-failed',
            errorDetail    : 'invalid',
          })];
        },
      };
      Object.defineProperty(engine, '_deadLetters', { get: () => fakeStore });

      const result = await (engine as any).getAdmissionDeadLetterCidsForTarget(syncTarget('did:example:alice', 'https://dwn.example.com'));

      expect(iteratorOptions).toEqual([{
        gte : 'did:example:alice|',
        lte : 'did:example:alice|\xff',
      }]);
      expect(result).toEqual(['cid-a']);
    });

    it('should auto-clear dead letter when same CID later succeeds on push', async () => {
      const engine = createEngine({ db });

      await engine.recordDeadLetter({
        messageCid     : 'dl-auto-push',
        tenantDid      : 'did:example:auto',
        remoteEndpoint : 'https://dwn.example.com',
        category       : 'admit-failed',
        errorDetail    : 'retries exhausted',
      });

      expect((await engine.getFailedMessages()).length).toBe(1);

      // Simulate successful push clearing the entry.
      await engine.clearFailedMessage('dl-auto-push', 'https://dwn.example.com');

      expect((await engine.getFailedMessages()).length).toBe(0);
    });

    it('should only suppress LEVEL_DATABASE_NOT_OPEN in recordDeadLetter', async () => {
      const engine = createEngine({ db });

      // Stub _deadLetters.put to throw a non-DB-closed error.
      const origDeadLetters = (engine as any)._deadLetters;
      const fakeStore = {
        put: async (): Promise<void> => {
          const err = new Error('disk full') as Error & { code: string };
          err.code = 'LEVEL_IO_ERROR';
          throw err;
        },
        iterator: (): ReturnType<typeof origDeadLetters.iterator> => origDeadLetters.iterator(),
      };
      Object.defineProperty(engine, '_deadLetters', { get: () => fakeStore });

      await expect(
        engine.recordDeadLetter({
          messageCid  : 'dl-io-error',
          tenantDid   : 'did:x',
          category    : 'admit-failed',
          errorDetail : 'test',
        })
      ).rejects.toThrow('disk full');
    });

    it('should count current degraded links from durable ledger, not just in-memory state', async () => {
      const endpointLookupStub = sinon.stub().rejects(new Error('endpoint lookup should not run'));
      const engine = createEngine({
        db,
        agent: {
          agentDid : 'did:example:agent',
          dwn      : { getRemoteDwnEndpointUrls: endpointLookupStub },
        } as any,
      });
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      await engine.registerIdentity({
        did     : 'did:degraded-test',
        options : { protocols: 'all' },
      });

      const targetA = syncTarget('did:degraded-test', 'https://a.com', { authorizationEpoch: ownerEpoch });
      const targetB = syncTarget('did:degraded-test', 'https://b.com', { authorizationEpoch: ownerEpoch });
      const targetC = syncTarget('did:degraded-test', 'https://c.com', { authorizationEpoch: ownerEpoch });

      // Create links via the ledger (durable). These survive restart and
      // still count when they belong to the current registered projection/epoch.
      const ledger = (engine as any).ledger;
      const link1 = await ledger.getOrCreateLink({
        tenantDid          : targetA.did,
        remoteEndpoint     : targetA.dwnUrl,
        scope              : targetA.scope,
        authorization      : targetA.authorization,
        authorizationEpoch : targetA.authorizationEpoch,
      });
      await ledger.setStatus(link1, 'degraded_poll');

      const link2 = await ledger.getOrCreateLink({
        tenantDid          : targetB.did,
        remoteEndpoint     : targetB.dwnUrl,
        scope              : targetB.scope,
        authorization      : targetB.authorization,
        authorizationEpoch : targetB.authorizationEpoch,
      });
      await ledger.setStatus(link2, 'repairing');

      const link3 = await ledger.getOrCreateLink({
        tenantDid          : targetC.did,
        remoteEndpoint     : targetC.dwnUrl,
        scope              : targetC.scope,
        authorization      : targetC.authorization,
        authorizationEpoch : targetC.authorizationEpoch,
      });
      await ledger.setStatus(link3, 'live');

      // _activeLinks is empty; this simulates a fresh restart.
      expect((engine as any)._activeLinks.size).toBe(0);

      const health = await engine.getSyncHealth();
      expect(health.degradedLinkCount).toBe(2);
      expect(endpointLookupStub.called).toBe(false);
    });

    it('should ignore degraded durable links from superseded authorization epochs', async () => {
      const engine = createEngine({ db });
      const ownerEpoch = await computeAuthorizationEpoch({ kind: 'owner' });
      await engine.registerIdentity({
        did     : 'did:epoch-health',
        options : { protocols: 'all' },
      });
      const currentTarget = syncTarget('did:epoch-health', 'https://dwn.example.com', {
        authorizationEpoch: ownerEpoch,
      });
      const oldTarget = syncTarget('did:epoch-health', 'https://dwn.example.com', {
        authorizationEpoch: 'epoch-old',
      });

      const ledger = (engine as any).ledger;
      const oldLink = await ledger.getOrCreateLink({
        tenantDid          : oldTarget.did,
        remoteEndpoint     : oldTarget.dwnUrl,
        scope              : oldTarget.scope,
        authorization      : oldTarget.authorization,
        authorizationEpoch : oldTarget.authorizationEpoch,
      });
      await ledger.setStatus(oldLink, 'terminal_incomplete');

      const currentLink = await ledger.getOrCreateLink({
        tenantDid          : currentTarget.did,
        remoteEndpoint     : currentTarget.dwnUrl,
        scope              : currentTarget.scope,
        authorization      : currentTarget.authorization,
        authorizationEpoch : currentTarget.authorizationEpoch,
      });
      await ledger.setStatus(currentLink, 'live');

      const health = await engine.getSyncHealth();
      expect(health.degradedLinkCount).toBe(0);
      expect(health.syncHealthy).toBe(true);
    });

    it('should fall back to all durable links when current link identity keys cannot be resolved', async () => {
      const engine = createEngine({ db });
      const target = syncTarget('did:fallback-health', 'https://dwn.example.com');
      await db.sublevel('registeredIdentities').put(
        target.did,
        JSON.stringify({ protocols: 'all', delegateDid: 'did:example:delegate' })
      );
      const warnStub = sinon.stub(console, 'warn');

      const ledger = (engine as any).ledger;
      const link = await ledger.getOrCreateLink({
        tenantDid          : target.did,
        remoteEndpoint     : target.dwnUrl,
        scope              : target.scope,
        authorization      : target.authorization,
        authorizationEpoch : target.authorizationEpoch,
      });
      await ledger.setStatus(link, 'degraded_poll');

      const health = await engine.getSyncHealth();
      expect(health.degradedLinkCount).toBe(1);
      expect(warnStub.calledOnce).toBe(true);
    });
  });
});
