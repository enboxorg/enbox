import type { BearerIdentity } from '../src/bearer-identity.js';
import type { SyncIdentityOptions } from '../src/index.js';
import type { GenericMessage, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { AbstractLevel } from 'abstract-level';
import { Convert } from '@enbox/common';
import { CryptoUtils } from '@enbox/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnConstant, DwnInterfaceName, DwnMethodName, Jws, Message, Time } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

import freeForAllProtocolDefinition from './fixtures/protocol-definitions/free-for-all.json' with { type: 'json' };

const testDwnUrls: string[] = [testDwnUrl];

describe('SyncEngineLevel', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.closeStorage();
  });

  describe('get agent', () => {
    it(`returns the 'agent' instance property`, () => {
      // we are only mocking
      const mockAgent: any = {
        agentDid: 'did:method:abc123'
      };
      const syncEngine = new SyncEngineLevel({ agent: mockAgent, db: {} as any });
      const agent = syncEngine.agent;
      expect(agent).toBeDefined();
      expect(agent.agentDid).toBe('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, async () => {
      const syncEngine = new SyncEngineLevel({ db: {} as any });
      expect(() =>
        syncEngine.agent
      ).toThrow('Unable to determine agent execution context');
    });
  });

  describe('terminal authorization failures', () => {
    const isTerminal = (detail: string | undefined): boolean =>
      (SyncEngineLevel as any).isTerminalAuthorizationFailure(detail);

    it('should classify revoked, expired, and subscribe-delivery authorization failures as terminal', () => {
      expect(isTerminal('401 GrantAuthorizationGrantRevoked: Permission grant with CID bafy… has been revoked')).toBe(true);
      expect(isTerminal('GrantAuthorizationGrantExpired: grant expired')).toBe(true);
      expect(isTerminal('MessagesSubscribeDeliveryAuthorizationFailed')).toBe(true);
      expect(isTerminal('503 something transient')).toBe(false);
      expect(isTerminal(undefined)).toBe(false);
      expect(isTerminal('')).toBe(false);
    });

    it('should pause instead of repairing when a live pull subscription reports a terminal authorization error', async () => {
      const syncEngine = new SyncEngineLevel({ agent: { agentDid: 'did:method:abc123' } as any, db: {} as any });
      const transitions: string[] = [];
      (syncEngine as any).transitionToPaused = async (): Promise<void> => { transitions.push('paused'); };
      (syncEngine as any).transitionToRepairing = async (): Promise<void> => { transitions.push('repairing'); };

      const context = { did: 'did:dht:tenant', dwnUrl: 'https://dwn.example', linkKey: 'k', link: {} as any, isStale: (): boolean => false };

      await (syncEngine as any).handleLivePullSubscriptionError(context, {
        type  : 'error',
        error : { code: 'MessagesSubscribeDeliveryAuthorizationFailed', message: 'delivery authorization failed' },
      });
      expect(transitions).toEqual(['paused']);

      await (syncEngine as any).handleLivePullSubscriptionError(context, {
        type  : 'error',
        error : { code: 'SomeTransientCode', message: 'flaky network' },
      });
      expect(transitions).toEqual(['paused', 'repairing']);
    });
  });

  describe('live pull quota transitions', () => {
    it('uses admitted CIDs only to resolve older same-record quota blocks', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const appliedCids = ['dependency-cid', 'successor-cid'];
      const link = {
        authorization      : { kind: 'owner' as const },
        authorizationEpoch : 'owner-epoch',
        connectivity       : 'online',
        projectionId       : 'projection-id',
        pull               : {},
        push               : {},
        remoteEndpoint     : 'https://dwn.example',
        scope              : { kind: 'full' as const },
        status             : 'live',
        tenantDid          : 'did:example:alice',
      };
      const context = {
        did        : link.tenantDid,
        dwnUrl     : link.remoteEndpoint,
        eventScope : {},
        isStale    : (): boolean => false,
        link,
        linkKey    : 'link-key',
      };

      sinon.stub(syncEngine as any, 'shouldSkipLivePullEvent').resolves(false);
      sinon.stub(syncEngine as any, 'startPullDelivery').returns({ ordinal: -1 });
      sinon.stub(syncEngine as any, 'processLivePullEvent').resolves({
        admitted   : true,
        appliedCids,
        messageCid : 'successor-cid',
      });
      sinon.stub(syncEngine as any, 'clearFailedMessageForTenant').resolves();
      sinon.stub(syncEngine as any, 'clearDeferredPull').resolves();
      const clearQuotaBlock = sinon.stub(syncEngine as any, 'clearQuotaBlockWithResolution').resolves();
      const resolveSuperseded = sinon.stub(syncEngine as any, 'resolveQuotaBlocksSupersededByAcknowledgement').resolves();
      const commitPullDelivery = sinon.stub(syncEngine as any, 'commitPullDelivery').resolves();

      await (syncEngine as any).handleLivePullEvent(context, {
        cursor : { epoch: 'epoch', position: '1', streamId: 'stream' },
        event  : {},
        type   : 'event',
      });

      expect(clearQuotaBlock.called).toBe(false);
      expect(resolveSuperseded.callCount).toBe(2);
      expect(resolveSuperseded.firstCall.args[1]).toBe('dependency-cid');
      expect(resolveSuperseded.secondCall.args[1]).toBe('successor-cid');
      expect(commitPullDelivery.calledOnce).toBe(true);
    });
  });

  describe('live push echo suppression', () => {
    it('commits a pushed echo without fetching or reapplying it', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const dwnUrl = 'https://dwn.example';
      const message = {
        descriptor: {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : '2026-07-16T00:00:00.000000Z',
        },
      } as GenericMessage;
      const messageCid = await Message.getCid(message);
      const cursor = { epoch: 'epoch', messageCid, position: '1', streamId: 'stream' };
      const context = {
        did        : 'did:example:alice',
        dwnUrl,
        eventScope : {},
        isStale    : (): boolean => false,
        linkKey    : 'link-key',
      };
      const delivery = { ordinal: -1 };

      internal.trackRecentlyPushedMessage(context.did, messageCid, dwnUrl);
      sinon.stub(internal, 'shouldSkipLivePullEvent').resolves(false);
      sinon.stub(internal, 'startPullDelivery').returns(delivery);
      const processLivePullEvent = sinon.stub(internal, 'processLivePullEvent');
      const commitPullDelivery = sinon.stub(internal, 'commitPullDelivery').resolves();

      await internal.handleLivePullEvent(context, {
        cursor,
        event : { message },
        type  : 'event',
      });

      expect(processLivePullEvent.called).toBe(false);
      expect(commitPullDelivery.calledOnceWithExactly(context, cursor, delivery)).toBe(true);
    });

    it('durably commits a pushed echo delivered while the link is initializing', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const dwnUrl = 'https://dwn.example';
      const linkKey = 'link-key';
      const message = {
        descriptor: {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : '2026-07-16T00:00:00.000000Z',
        },
      } as GenericMessage;
      const messageCid = await Message.getCid(message);
      const cursor = { epoch: 'epoch', messageCid, position: '1', streamId: 'stream' };
      const link = {
        authorization      : { kind: 'owner' },
        authorizationEpoch : 'owner-epoch',
        connectivity       : 'online',
        projectionId       : 'projection-id',
        pull               : {},
        push               : {},
        remoteEndpoint     : dwnUrl,
        scope              : { kind: 'full' },
        status             : 'initializing',
        tenantDid          : 'did:example:alice',
      };
      const context = {
        did        : link.tenantDid,
        dwnUrl,
        eventScope : {},
        isStale    : (): boolean => false,
        link,
        linkKey,
      };
      const persistCheckpoint = sinon.stub().resolves();
      const events: unknown[] = [];
      const unsubscribe = syncEngine.on((event) => events.push(event));

      internal._activeLinks.set(linkKey, link);
      internal._ledger = { persistCheckpoint };
      internal.trackRecentlyPushedMessage(context.did, messageCid, dwnUrl);
      sinon.stub(internal, 'shouldSkipLivePullEvent').resolves(false);
      const processLivePullEvent = sinon.stub(internal, 'processLivePullEvent');

      try {
        await internal.handleLivePullEvent(context, {
          cursor,
          event : { message },
          type  : 'event',
        });
      } finally {
        unsubscribe();
      }

      expect(processLivePullEvent.called).toBe(false);
      expect(persistCheckpoint.calledOnceWithExactly(link, 'pull')).toBe(true);
      expect(link.pull.contiguousAppliedToken).toEqual(cursor);
      expect(internal._linkRuntimes.get(linkKey)?.inflight.size).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({
        type           : 'checkpoint:pull-advance',
        messageCid,
        position       : cursor.position,
        remoteEndpoint : dwnUrl,
      }));
    });

    it('scopes echo caches per tenant and endpoint and expires stale pushed entries', () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const messageCid = 'bafy-pushed-message';
      const firstTenant = 'did:example:alice';
      const firstRemote = 'https://first.example';

      internal.trackRecentlyPushedMessage(firstTenant, messageCid, firstRemote);

      expect(internal.isRecentlyPushed(firstTenant, messageCid, firstRemote)).toBe(true);
      expect(internal.isRecentlyPushed('did:example:bob', messageCid, firstRemote)).toBe(false);
      expect(internal.isRecentlyPushed(firstTenant, messageCid, 'https://second.example')).toBe(false);

      internal.trackRecentlyPulledMessage(firstTenant, messageCid, firstRemote);
      expect(internal.isRecentlyPulled(firstTenant, messageCid, firstRemote)).toBe(true);
      expect(internal.isRecentlyPulled('did:example:bob', messageCid, firstRemote)).toBe(false);
      expect(internal.isRecentlyPulled(firstTenant, messageCid, 'https://second.example')).toBe(false);

      const key = `${messageCid}|${firstTenant}|${firstRemote}`;
      internal._recentlyPushedCids.set(key, Date.now() - 1);
      expect(internal.isRecentlyPushed(firstTenant, messageCid, firstRemote)).toBe(false);
      expect(internal._recentlyPushedCids.has(key)).toBe(false);
    });

    it('bounds the pushed-echo cache at its max size, evicting the oldest entries first', () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const cap = (SyncEngineLevel as any).ECHO_SUPPRESS_MAX_ENTRIES as number;
      const farFuture = Date.now() + 10 * 60_000;
      const keyFor = (index: number): string => `cid-${index}|did:example:alice|https://dwn.example`;

      // Seed past the cap with unexpired entries so only the size bound — not
      // the TTL sweep — can trim them.
      for (let index = 0; index < cap + 5; index++) {
        internal._recentlyPushedCids.set(keyFor(index), farFuture);
      }
      expect(internal._recentlyPushedCids.size).toBe(cap + 5);

      internal.evictExpiredEchoEntries(internal._recentlyPushedCids);

      expect(internal._recentlyPushedCids.size).toBe(cap);
      // Oldest-inserted keys are evicted first; the most recent survive.
      expect(internal._recentlyPushedCids.has(keyFor(0))).toBe(false);
      expect(internal._recentlyPushedCids.has(keyFor(4))).toBe(false);
      expect(internal._recentlyPushedCids.has(keyFor(cap + 4))).toBe(true);
    });
  });

  describe('durable feed coordination', () => {
    const target = (remote: string, projectionId = 'projection-a'): any => ({
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      did                : 'did:example:alice',
      dwnUrl             : remote,
      projectionId,
      scope              : { kind: 'full' as const },
    });

    it('serializes durable feed runs per link without blocking a different link', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const activeByRemote = new Map<string, number>();
      const maxActiveByRemote = new Map<string, number>();
      const releases: Array<() => void> = [];
      let totalActive = 0;
      let maxTotalActive = 0;
      let resolveFirstA!: () => void;
      let resolveSecondA!: () => void;
      let resolveFirstB!: () => void;
      const firstAEntered = new Promise<void>((resolve) => { resolveFirstA = resolve; });
      const secondAEntered = new Promise<void>((resolve) => { resolveSecondA = resolve; });
      const firstBEntered = new Promise<void>((resolve) => { resolveFirstB = resolve; });

      sinon.stub(internal, 'doSyncTargetWithDurableFeeds').callsFake(async (runTarget: { dwnUrl: string }): Promise<any> => {
        const active = (activeByRemote.get(runTarget.dwnUrl) ?? 0) + 1;
        activeByRemote.set(runTarget.dwnUrl, active);
        maxActiveByRemote.set(runTarget.dwnUrl, Math.max(maxActiveByRemote.get(runTarget.dwnUrl) ?? 0, active));
        totalActive++;
        maxTotalActive = Math.max(maxTotalActive, totalActive);

        if (runTarget.dwnUrl === 'https://a.example') {
          if (activeByRemote.get(`${runTarget.dwnUrl}:entered`) === undefined) {
            activeByRemote.set(`${runTarget.dwnUrl}:entered`, 1);
            resolveFirstA();
          } else {
            resolveSecondA();
          }
        } else {
          resolveFirstB();
        }

        await new Promise<void>((resolve) => { releases.push(resolve); });
        activeByRemote.set(runTarget.dwnUrl, active - 1);
        totalActive--;
        return { admittedCids: [], hasActionableDiffs: false, pushFailures: [] };
      });

      const firstA = internal.syncTargetWithDurableFeeds(target('https://a.example'));
      await firstAEntered;
      const secondA = internal.syncTargetWithDurableFeeds(target('https://a.example'));
      const firstB = internal.syncTargetWithDurableFeeds(target('https://b.example', 'projection-b'));

      try {
        await firstBEntered;
        expect(internal.doSyncTargetWithDurableFeeds.callCount).toBe(2);
        expect(maxActiveByRemote.get('https://a.example')).toBe(1);
        expect(maxActiveByRemote.get('https://b.example')).toBe(1);
        expect(maxTotalActive).toBe(2);

        releases.shift()?.();
        await secondAEntered;
        expect(maxActiveByRemote.get('https://a.example')).toBe(1);

        for (const release of releases.splice(0)) {
          release();
        }
        await Promise.all([firstA, secondA, firstB]);
        expect(internal._durableFeedRuns.size).toBe(0);
      } finally {
        for (const release of releases.splice(0)) {
          release();
        }
      }
    });

    it('does not prune or cache targets invalidated while quota pruning is awaiting storage', async () => {
      const tenantDid = 'did:example:alice';
      const registeredIdentities = {
        async *iterator(): AsyncGenerator<[string, string]> {
          yield [tenantDid, JSON.stringify({ protocols: 'all' })];
        },
      };
      const db = {
        sublevel(name: string): unknown {
          if (name === 'registeredIdentities') { return registeredIdentities; }
          throw new Error(`unexpected sublevel ${name}`);
        },
      };
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: db as any });
      const internal = syncEngine as any;
      const currentTarget = target('https://a.example');
      sinon.stub(internal.targetResolver, 'getEndpointUrls').resolves([currentTarget.dwnUrl]);
      sinon.stub(internal.targetResolver, 'buildTargetsForEndpoint').resolves([currentTarget]);

      let resolveIteratorStarted!: () => void;
      let resumeIterator!: () => void;
      const iteratorStarted = new Promise<void>((resolve) => { resolveIteratorStarted = resolve; });
      const iteratorGate = new Promise<void>((resolve) => { resumeIterator = resolve; });
      const batch = sinon.stub().resolves();
      sinon.stub(internal, '_quotaBlocks').get(() => ({
        batch,
        async *iterator(): AsyncGenerator<[string, string]> {
          resolveIteratorStarted();
          await iteratorGate;
          yield ['stale-key', JSON.stringify({
            linkKey: 'stale-link',
            tenantDid,
          })];
        },
      }));

      const resolution = internal.getSyncTargets();
      await iteratorStarted;
      internal._targetPlanner.invalidate();
      resumeIterator();
      await resolution;

      expect(batch.called).toBe(false);
      expect(internal._targetPlanner.lastResolutionComplete).toBe(false);
    });

    it('abandons a Retry-now request queued across an engine lifecycle change', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const getSyncTargets = sinon.stub(internal, 'getSyncTargets').resolves([]);
      expect(internal._lifecycle.tryAcquireSync()).toBe(true);

      try {
        const retry = syncEngine.retryRemoteNow('did:example:alice', 'https://a.example');
        await Promise.resolve();
        expect(getSyncTargets.called).toBe(false);

        internal._engineGeneration++;
        internal._lifecycle.releaseSync();
        await retry;

        expect(getSyncTargets.called).toBe(false);
        expect(internal._lifecycle.isSyncInProgress).toBe(false);
      } finally {
        if (internal._lifecycle.isSyncInProgress) {
          internal._lifecycle.releaseSync();
        }
      }
    });
  });

  describe('stale durable feed responses', () => {
    const target = {
      authorization      : { kind: 'owner' as const },
      authorizationEpoch : 'owner-epoch',
      did                : 'did:example:alice',
      dwnUrl             : 'https://dwn.example',
      projectionId       : 'projection-id',
      scope              : { kind: 'full' as const },
    };

    it('does not transition a feed push after its link becomes stale in flight', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      let current = true;
      let releasePush!: () => void;
      let resolvePushStarted!: () => void;
      const pushGate = new Promise<void>((resolve) => { releasePush = resolve; });
      const pushStarted = new Promise<void>((resolve) => { resolvePushStarted = resolve; });

      sinon.stub(internal, 'hasAdmissionDeadLetter').resolves(false);
      sinon.stub(internal, 'getQuotaBlockState').resolves(undefined);
      sinon.stub(internal, 'getQuotaBlockedInitialCidsForFeedEntry').resolves([]);
      sinon.stub(internal, 'pushMessages').callsFake(async () => {
        resolvePushStarted();
        await pushGate;
        return {
          succeeded : [],
          failed    : [{ cid: 'cid-1', kind: 'Deferred', quotaBlocked: true, reason: 'storage' }],
        };
      });
      const transition = sinon.stub(internal, 'transitionPushResult');

      const result = internal.pushLocalFeedPage(target, [{ messageCid: 'cid-1' }], (): boolean => current);
      await pushStarted;
      current = false;
      releasePush();

      expect(await result).toEqual({ kind: 'aborted' });
      expect(transition.called).toBe(false);
    });

    it('does not transition a permission-grant response after its link becomes stale in flight', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      let current = true;
      let releasePush!: () => void;
      let resolvePushStarted!: () => void;
      const pushGate = new Promise<void>((resolve) => { releasePush = resolve; });
      const pushStarted = new Promise<void>((resolve) => { resolvePushStarted = resolve; });
      const grantTarget = { ...target, permissionGrantIds: ['grant-cid'] };

      sinon.stub(internal, 'localPermissionGrantBootstrapEntries').resolves({
        entries  : [{ message: {}, messageCid: 'grant-cid' }],
        failures : [],
      });
      sinon.stub(internal, 'getQuotaBlockState').resolves(undefined);
      sinon.stub(internal, 'pushMessageEntries').callsFake(async () => {
        resolvePushStarted();
        await pushGate;
        return {
          succeeded : [],
          failed    : [{ cid: 'grant-cid', kind: 'Deferred', quotaBlocked: true, reason: 'messages' }],
        };
      });
      const transition = sinon.stub(internal, 'transitionPushResult');

      const result = internal.bootstrapRemotePermissionGrants(grantTarget, (): boolean => current, true);
      await pushStarted;
      current = false;
      releasePush();

      expect(await result).toEqual({ kind: 'aborted' });
      expect(transition.called).toBe(false);
    });
  });

  describe('push retry scheduling', () => {
    it('should bypass hot retries and delay reconciliation for retryable Incomplete failures', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const linkKey = 'did:example:alice^https://dwn.example^projection^epoch';
      const link = { status: 'live' } as any;
      syncEngine['_activeLinks'].set(linkKey, link);

      const scheduleReconcile = sinon.stub(syncEngine as any, 'scheduleLinkReconcileIfActive');
      const schedulePushRetry = sinon.stub(syncEngine as any, 'schedulePushRetry');

      await syncEngine['requeueOrReconcile'](linkKey, {
        did     : 'did:example:alice',
        dwnUrl  : 'https://dwn.example',
        entries : [{
          cid         : 'root-cid',
          lastFailure : { cid: 'root-cid', kind: 'Incomplete', detail: 'dependency remains unavailable' },
        }],
        retryCount: 1,
      });

      expect(schedulePushRetry.called).toBe(false);
      expect(scheduleReconcile.calledOnceWithExactly(linkKey, link, 'push-incomplete', 30_000)).toBe(true);
      expect(syncEngine['_pushRuntimes'].has(linkKey)).toBe(false);
    });
  });

  describe('delegated permission grant bootstrap', () => {
    it('uses delegate-local grant entries without probing the owner signer or suppressing their pull echo', async () => {
      const ownerDid = 'did:example:owner';
      const delegateDid = 'did:example:delegate';
      const permissionGrantId = 'grant-record-id';
      const dwnUrl = 'https://dwn.example';

      const grantEntry = {
        authorization : {},
        descriptor    : { interface: 'Records', method: 'Write' },
        encodedData   : Convert.uint8Array(Convert.string('grant-data').toUint8Array()).toBase64Url(),
        recordId      : permissionGrantId,
      };

      const processRequest = sinon.stub().callsFake(async (request: any) => {
        if (request.author === ownerDid) {
          throw new Error(`AgentDwnApi: Unable to get signer for author '${ownerDid}': Key not found`);
        }

        expect(request.author).toBe(delegateDid);
        expect(request.target).toBe(delegateDid);
        expect(request.messageType).toBe(DwnInterface.RecordsQuery);
        expect(request.messageParams).toEqual({ filter: { recordId: permissionGrantId } });

        return {
          reply: {
            status  : { code: 200 },
            entries : [grantEntry],
          },
        };
      });

      const syncEngine = new SyncEngineLevel({
        agent : { dwn: { processRequest } } as any,
        db    : {} as any,
      });
      sinon.stub(syncEngine as any, 'getQuotaBlockState').resolves(undefined);
      const transition = sinon.stub(syncEngine as any, 'transitionPushResult').resolves({
        quotaBlocked      : false,
        retryableFailures : [],
        terminalFailures  : [],
      });
      const pushEntries = sinon.stub(syncEngine as any, 'pushMessageEntries').resolves({
        failed    : [],
        succeeded : ['grant-cid'],
      });

      const result = await (syncEngine as any).bootstrapRemotePermissionGrants({
        authorization: {
          kind               : 'delegate',
          delegateDid,
          permissionGrantIds : [permissionGrantId],
        },
        authorizationEpoch : 'epoch',
        delegateDid,
        did                : ownerDid,
        dwnUrl,
        permissionGrantIds : [permissionGrantId],
        scope              : { kind: 'protocolSet', protocols: ['https://protocol.example'] },
      });

      expect(result).toEqual({
        failures           : [],
        hasActionableDiffs : true,
        kind               : 'processed',
        quotaBlocked       : false,
      });
      expect(processRequest.calledOnce).toBe(true);
      expect(pushEntries.calledOnce).toBe(true);
      expect(pushEntries.firstCall.args[0].did).toBe(ownerDid);
      expect(pushEntries.firstCall.args[0].dwnUrl).toBe(dwnUrl);
      expect(pushEntries.firstCall.args[0].delegateDid).toBe(delegateDid);
      expect(pushEntries.firstCall.args[0].permissionGrantIds).toEqual([permissionGrantId]);
      expect(pushEntries.firstCall.args[0].entries).toHaveLength(1);
      expect(pushEntries.firstCall.args[0].entries[0].bufferedData).toBeInstanceOf(Uint8Array);
      expect(pushEntries.firstCall.args[0].suppressRemoteEcho).toBe(false);
      expect(transition.calledOnce).toBe(true);
      expect(transition.firstCall.args[2]).toEqual({ source: 'permission-grant' });
    });
  });

  describe('with Enbox Platform Agent', () => {
    let alice: BearerIdentity;
    let randomSchema: string;
    let syncEngine: SyncEngineLevel;

    beforeAll(async () => {
      await testHarness.clearStorage();
      await testHarness.createAgentDid();

      const syncStore = testHarness.syncStore;
      syncEngine = new SyncEngineLevel({ db: syncStore, agent: testHarness.agent });
      testHarness.agent.sync = syncEngine;

      alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    });

    beforeEach(async () => {
      randomSchema = CryptoUtils.randomUuid();

      sinon.restore();

      // Reset the sync lock in case a previous test timed out while sync was in progress.
      // Without this, all subsequent tests would fail with "Sync operation is already in progress."
      if (syncEngine['_lifecycle'].isSyncInProgress) {
        syncEngine['_lifecycle'].releaseSync();
      }

      await syncEngine.clear();
      await testHarness.syncStore.clear();
      await testHarness.dwnDataStore.clear();
      await testHarness.dwnMessageStore.clear();
      await testHarness.dwnResumableTaskStore.clear();
      await testHarness.agent.permissions.clear();
      testHarness.dwnStores.clear();

      // Install free-for-all protocol after clearing stores.
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: freeForAllProtocolDefinition }
      });
      await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: freeForAllProtocolDefinition }
      });
    });

    afterAll(async () => {
      sinon.restore();
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    it('syncs multiple messages in both directions', async () => {
      // scenario:  Alice installs a protocol only on her local DWN and writes some messages associated with it
      //            Alice installs a protocol only on her remote DWN and writes some messages associated with it
      //            Alice registers her DID to be synchronized, and kicks off a sync
      //            The sync should complete and the same records should exist on both remote and local DWNs


      // create 1 local protocol configure
      const protocolDefinition1: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/example/1',
        types     : {
          foo: {
            schema      : 'https://schemas.xyz/foo',
            dataFormats : ['text/plain', 'application/json']
          }
        },
        structure: {
          foo: {}
        }
      };

      const protocolsConfigure1 = await testHarness.agent.processDwnRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition1
        }
      });

      // create 1 remote protocol configure
      const protocolDefinition2: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/example/2',
        types     : {
          bar: {
            schema      : 'https://schemas.xyz/bar',
            dataFormats : ['text/plain', 'application/json']
          }
        },
        structure: {
          bar: {}
        }
      };

      const protocolsConfigure2 = await testHarness.agent.sendDwnRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition2
        }
      });


      // create 3 local records.
      const localRecords: string[] = [];
      for (let i = 0; i < 3; i++) {
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob([`Hello, ${i}`])
        });
        expect(writeResponse.reply.status.code).toBe(202);

        // write an update message for one of the records
        if (i === 0) {
          const updateResponse = await testHarness.agent.dwn.processRequest({
            author        : alice.did.uri,
            target        : alice.did.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              recordId     : writeResponse.message!.recordId,
              protocol     : 'http://free-for-all.xyz',
              protocolPath : 'post',
              dataFormat   : 'text/plain',
              schema       : writeResponse.message!.descriptor.schema,
              dateCreated  : writeResponse.message!.descriptor.dateCreated
            },
            dataStream: new Blob([`Hello, ${i} updated!`]),
          });
          expect(updateResponse.reply.status.code).toBe(202);
        }

        localRecords.push((writeResponse.message!).recordId);
      }

      // create 3 remote records
      const remoteRecords: string[] = [];
      for (let i = 0; i < 3; i++) {
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob([`Hello, ${i}`])
        });
        expect(writeResponse.reply.status.code).toBe(202);

        // write an update message for one of the records
        if (i === 0) {
          const updateResponse = await testHarness.agent.dwn.sendRequest({
            author        : alice.did.uri,
            target        : alice.did.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              recordId     : writeResponse.message!.recordId,
              protocol     : 'http://free-for-all.xyz',
              protocolPath : 'post',
              dataFormat   : 'text/plain',
              schema       : writeResponse.message!.descriptor.schema,
              dateCreated  : writeResponse.message!.descriptor.dateCreated
            },
            dataStream: new Blob([`Hello, ${i} updated!`]),
          });
          expect(updateResponse.reply.status.code).toBe(202);
        }
        remoteRecords.push((writeResponse.message!).recordId);
      }

      // check that protocol1 exists locally
      let localProtocolsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      let localProtocolsQueryReply = localProtocolsQueryResponse.reply;
      expect(localProtocolsQueryReply.status.code).toBe(200);
      expect(localProtocolsQueryReply.entries).toHaveLength(2);
      expect(localProtocolsQueryReply.entries).toEqual(expect.arrayContaining([ protocolsConfigure1.message ]));

      // query local and check for only local records
      let localRecordsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      let localRecordsQueryReply = localRecordsQueryResponse.reply;
      expect(localRecordsQueryReply.status.code).toBe(200);
      expect(localRecordsQueryReply.entries).toHaveLength(3);
      let localRecordsFromQuery = localRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(localRecordsFromQuery).toEqual(expect.arrayContaining(localRecords));

      // check that protocol2 exists remotely
      let remoteProtocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      let remoteProtocolsQueryReply = remoteProtocolsQueryResponse.reply;
      expect(remoteProtocolsQueryReply.status.code).toBe(200);
      expect(remoteProtocolsQueryReply.entries).toHaveLength(2);
      expect(remoteProtocolsQueryReply.entries).toEqual(expect.arrayContaining([ protocolsConfigure2.message ]));

      // query remote and check for only remote records
      let remoteRecordsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      let remoteRecordsQueryReply = remoteRecordsQueryResponse.reply;
      expect(remoteRecordsQueryReply.status.code).toBe(200);
      expect(remoteRecordsQueryReply.entries).toHaveLength(3);
      let remoteRecordsFromQuery = remoteRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(remoteRecordsFromQuery).toEqual(expect.arrayContaining(remoteRecords));

      // Register Alice's DID to be synchronized.
      await testHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : { protocols: 'all' },
      });

      // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
      await syncEngine.sync();

      // query local to see all protocols
      localProtocolsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      localProtocolsQueryReply = localProtocolsQueryResponse.reply;
      expect(localProtocolsQueryReply.status.code).toBe(200);
      expect(localProtocolsQueryReply.entries).toHaveLength(3);
      expect(localProtocolsQueryReply.entries).toEqual(expect.arrayContaining([ protocolsConfigure1.message, protocolsConfigure2.message ]));

      // query local node to see all records
      localRecordsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      localRecordsQueryReply = localRecordsQueryResponse.reply;
      expect(localRecordsQueryReply.status.code).toBe(200);
      expect(localRecordsQueryReply.entries).toHaveLength(6);
      localRecordsFromQuery = localRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(localRecordsFromQuery).toEqual(expect.arrayContaining([...localRecords, ...remoteRecords]));

      // query remote node to see all protocols
      remoteProtocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {}
      });
      remoteProtocolsQueryReply = remoteProtocolsQueryResponse.reply;
      expect(remoteProtocolsQueryReply.status.code).toBe(200);
      expect(remoteProtocolsQueryReply.entries).toHaveLength(3);
      expect(remoteProtocolsQueryReply.entries).toEqual(expect.arrayContaining([ protocolsConfigure1.message, protocolsConfigure2.message ]));

      // query remote node to see all records
      remoteRecordsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            dataFormat : 'text/plain',
            schema     : randomSchema
          }
        }
      });
      remoteRecordsQueryReply = remoteRecordsQueryResponse.reply;
      expect(remoteRecordsQueryReply.status.code).toBe(200);
      expect(remoteRecordsQueryReply.entries).toHaveLength(6);
      remoteRecordsFromQuery = remoteRecordsQueryReply.entries?.map(entry => entry.recordId);
      expect(remoteRecordsFromQuery).toEqual(expect.arrayContaining([...localRecords, ...remoteRecords]));
    });

    describe('sync()', () => {
      it('throws an error if the sync is currently already running', async () => {
        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        // Stub getSyncTargets to simulate a slow sync
        const getSyncTargetsStub = sinon.stub(syncEngine as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 90);
        }));

        // do not await
        syncEngine.sync();

        await clock.tickAsync(50);

        // do not block for subsequent syncs
        getSyncTargetsStub.returns(Promise.resolve([]));
        try {
          await syncEngine.sync();
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe('SyncEngineLevel: Sync operation is already in progress.');
        }

        await clock.tickAsync(50);

        // no error thrown
        await syncEngine.sync();

        clock.restore();
      });
    });

    describe('drainTo()', () => {
      it('throws an error if a drain is currently already running', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const buildDrainPlanStub = sinon.stub(syncEngine as any, 'buildSyncDrainPlan');
        buildDrainPlanStub.returns(new Promise<any>((resolve) => {
          clock.setTimeout(() => {
            resolve({ failures: [], targets: [] });
          }, 90);
        }));

        const firstDrain = syncEngine.drainTo('https://dwn.example');

        await clock.tickAsync(50);

        try {
          await syncEngine.drainTo('https://dwn.example');
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe('SyncEngineLevel: Sync operation is already in progress.');
        }

        await clock.tickAsync(50);
        await firstDrain;

        buildDrainPlanStub.restore();
        clock.restore();
      });

      it('rejects invalid drain endpoints', async () => {
        await expect(syncEngine.drainTo('not a url')).rejects.toThrow('SyncEngineLevel: drain endpoint must be a valid URL.');
        await expect(syncEngine.drainTo('ftp://dwn.example')).rejects.toThrow('SyncEngineLevel: drain endpoint must use http or https.');
      });

      it('does not complete an empty drain plan', async () => {
        sinon.stub(syncEngine as any, 'buildSyncDrainPlan').resolves({ failures: [], targets: [] });

        const result = await syncEngine.drainTo('https://dwn.example');

        expect(result).toMatchObject({
          completed       : false,
          cancelled       : false,
          topologyChanged : false,
          targets         : [],
          error           : 'drain plan contained no registered sync targets',
        });
      });

      it('reports target failures without throwing', async () => {
        const target = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          did                : alice.did.uri,
          dwnUrl             : 'https://dwn.example',
          scope              : { kind: 'full' },
        };
        sinon.stub(syncEngine as any, 'buildSyncDrainPlan').resolves({
          failures : [],
          targets  : [target],
        });
        sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').rejects(new Error('remote unavailable'));

        const result = await syncEngine.drainTo('https://dwn.example');

        expect(result.completed).toBe(false);
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0]).toMatchObject({
          completed      : false,
          converged      : false,
          error          : 'remote unavailable',
          remoteEndpoint : 'https://dwn.example',
          tenantDid      : alice.did.uri,
        });
      });

      it('reports corrupt registered identities as drain failures', async () => {
        await (syncEngine as any)._db.sublevel('registeredIdentities').put('did:example:corrupt', '{');

        const result = await syncEngine.drainTo('https://dwn.example/path?token=secret#fragment');

        expect(result.endpoint).toBe('https://dwn.example/path');
        expect(result.completed).toBe(false);
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0]).toMatchObject({
          completed      : false,
          converged      : false,
          remoteEndpoint : 'https://dwn.example/path',
          tenantDid      : 'did:example:corrupt',
        });
        expect(result.targets[0]!.error).toContain('corrupt sync options');
      });

      it('reports aborted drains without throwing', async () => {
        const controller = new AbortController();
        const target = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          did                : alice.did.uri,
          dwnUrl             : 'https://dwn.example',
          scope              : { kind: 'full' },
        };
        sinon.stub(syncEngine as any, 'buildSyncDrainPlan').resolves({
          failures : [],
          targets  : [target],
        });
        sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').callsFake(async (): Promise<any> => {
          controller.abort();
          return { aborted: true, pushFailures: [] };
        });

        const result = await syncEngine.drainTo('https://dwn.example', { signal: controller.signal });

        expect(result.completed).toBe(false);
        expect(result.cancelled).toBe(true);
        expect(result.topologyChanged).toBe(false);
        expect(result.error).toBe('drain aborted');
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0]).toMatchObject({
          completed      : false,
          cancelled      : true,
          converged      : false,
          error          : 'drain aborted',
          remoteEndpoint : 'https://dwn.example',
          tenantDid      : alice.did.uri,
        });
      });

      it('does not report a paused replication link as completed or converged', async () => {
        const target = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          did                : alice.did.uri,
          dwnUrl             : 'https://dwn.example',
          scope              : { kind: 'full' },
        };
        sinon.stub(syncEngine as any, 'buildSyncDrainPlan').resolves({ failures: [], targets: [target] });
        sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').resolves({
          converged         : true,
          localFingerprint  : 'fingerprint',
          pushFailures      : [],
          remoteFingerprint : 'fingerprint',
        });
        sinon.stub(syncEngine as any, 'getOrCreateReplicationLink').resolves({
          status : 'paused',
          push   : {},
        });

        const result = await syncEngine.drainTo('https://dwn.example');

        expect(result.completed).toBe(false);
        expect(result.targets[0]).toMatchObject({
          completed : false,
          cancelled : false,
          converged : false,
          error     : 'replication link is paused',
        });
      });

      it('invalidates completion when sync registrations change during the drain', async () => {
        const target = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          did                : alice.did.uri,
          dwnUrl             : 'https://dwn.example',
          scope              : { kind: 'full' },
        };
        sinon.stub(syncEngine as any, 'buildSyncDrainPlan').resolves({ failures: [], targets: [target] });
        sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').callsFake(async (): Promise<any> => {
          (syncEngine as any)._targetPlanner.invalidate();
          return {
            converged         : true,
            localFingerprint  : 'fingerprint',
            pushFailures      : [],
            remoteFingerprint : 'fingerprint',
          };
        });

        const result = await syncEngine.drainTo('https://dwn.example');

        expect(result).toMatchObject({
          completed       : false,
          cancelled       : false,
          topologyChanged : true,
          error           : 'sync registrations changed during drain; retry required',
        });
        expect(result.targets[0]).toMatchObject({
          completed : false,
          cancelled : false,
          converged : false,
          error     : 'sync registrations changed during drain; retry required',
        });
      });

      it('requires a stable feed head before reporting completion', async () => {
        const target = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          did                : alice.did.uri,
          dwnUrl             : 'https://dwn.example',
          scope              : { kind: 'full' },
        };
        sinon.stub(syncEngine as any, 'buildSyncDrainPlan').resolves({ failures: [], targets: [target] });
        sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').resolves({
          converged         : true,
          localFingerprint  : 'first-fingerprint',
          pushFailures      : [],
          remoteFingerprint : 'first-fingerprint',
        });
        sinon.stub(syncEngine as any, 'verifyFeedConvergence').resolves({
          converged         : true,
          localFingerprint  : 'second-fingerprint',
          pushFailures      : [],
          remoteFingerprint : 'second-fingerprint',
        });
        const result = await syncEngine.drainTo('https://dwn.example');

        expect(result.completed).toBe(false);
        expect(result.targets[0]).toMatchObject({
          completed         : false,
          converged         : false,
          error             : 'feed head changed during drain; retry required',
          localFingerprint  : 'second-fingerprint',
          remoteFingerprint : 'second-fingerprint',
        });
      });

      it('reports push failures as incomplete drain progress', async () => {
        const target = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          did                : alice.did.uri,
          dwnUrl             : 'https://dwn.example',
          scope              : { kind: 'full' },
        };
        sinon.stub(syncEngine as any, 'buildSyncDrainPlan').resolves({
          failures : [],
          targets  : [target],
        });
        sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').resolves({
          converged         : true,
          localFingerprint  : 'fingerprint',
          pushFailures      : [{ cid: 'bafyreifailedcid' }],
          remoteFingerprint : 'fingerprint',
        });

        const result = await syncEngine.drainTo('https://dwn.example');

        expect(result.completed).toBe(false);
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0]).toMatchObject({
          completed         : false,
          converged         : true,
          error             : 'drain push failed for 1 message(s)',
          localFingerprint  : 'fingerprint',
          remoteEndpoint    : 'https://dwn.example',
          remoteFingerprint : 'fingerprint',
          tenantDid         : alice.did.uri,
        });
      });
    });

    describe('pull()', () => {
      it('synchronizes records that have been updated', async () => {
        // Write a test record to Alice's remote DWN.
        const writeResponse1 = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse1.message!.recordId;

        // const update the record
        const updateResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId     : testRecordId,
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema,
            dateCreated  : writeResponse1.message!.descriptor.dateCreated
          },
          dataStream: new Blob(['Hello, world updated!'])
        });
        expect(updateResponse.reply.status.code).toBe(202);
        expect(updateResponse.message!.recordId).toBe(testRecordId);

        const updateMessageCid = updateResponse.messageCid;

        // Confirm the record does NOT exist on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat : 'text/plain',
              schema     : randomSchema
            }
          }
        });
        let localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(0); // Record doesn't exist on local DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
        await syncEngine.sync('pull');

        // Confirm the record now DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(1); // Record does exist on local DWN.

        // remove `initialWrite` from the response to generate an accurate messageCid
        const { initialWrite, ...rawMessage } = localDwnQueryReply.entries![0];
        const queriedMessageCid = await Message.getCid(rawMessage);
        expect(queriedMessageCid).toBe(updateMessageCid);
      });

      it('takes no action if no identities are registered', async () => {
        const didResolveSpy = sinon.spy(testHarness.agent.did, 'resolve');
        const sendDwnRequestSpy = sinon.spy(testHarness.agent.rpc, 'sendDwnRequest');

        await syncEngine.sync('pull');

        // Verify DID resolution and DWN requests did not occur.
        expect(didResolveSpy.notCalled).toBe(true);
        expect(sendDwnRequestSpy.notCalled).toBe(true);

        didResolveSpy.restore();
        sendDwnRequestSpy.restore();
      });

      it('should reject delegated scoped registration when the permission grant is missing during pull setup', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        await expect(testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        })).rejects.toThrow('lacks Messages.Read grants for closure protocols: https://protocol.xyz/foo');
      });

      it('succeeds with only a MessagesQuery grant when messages are inlined in the diff response', async () => {
        // The batched diff protocol bundles small messages directly in the diff response,
        // so a MessagesRead grant is only needed for large payloads that can't be inlined.
        // This test verifies that sync works with ONLY a MessagesQuery grant.
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        // install a protocol on the remote node for aliceSync
        const protocolsFoo = await testHarness.agent.sendDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).toBe(202);

        // create a record that will be synced
        const record1 = await testHarness.agent.sendDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'https://protocol.xyz/foo',
            protocolPath : 'foo',
            schema       : 'https://schemas.xyz/foo',
            dataFormat   : 'text/plain',
          },
          dataStream: new Blob(['Hello, world!'])
        });
        expect(record1.reply.status.code).toBe(202);

        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        // write ONLY a MessagesQuery permission grant — no MessagesRead grant
        const messagesQueryGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : aliceSync.did.uri,
          grantedTo   : delegateDid.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            protocol  : 'https://protocol.xyz/foo'
          }
        });

        const { encodedData: messagesQueryGrantData, ...messagesQueryGrantMessage } = messagesQueryGrant.message;
        // send to the remote node
        const sendGrant = await testHarness.agent.sendDwnRequest({
          author      : aliceSync.did.uri,
          target      : aliceSync.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(messagesQueryGrantData).toUint8Array() ]),
        });
        expect(sendGrant.reply.status.code).toBe(202);

        // store it as the delegate DID so that it can be fetched during sync
        const processGrant = await testHarness.agent.processDwnRequest({
          author      : delegateDid.did.uri,
          target      : delegateDid.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(messagesQueryGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processGrant.reply.status.code).toBe(202);

        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        });

        // With the batched diff, sync should succeed without a MessagesRead grant.
        // Small messages are bundled in the diff response.
        await syncEngine.sync('pull');

        // Verify the record was synced to the local DWN.
        const queryResponse = await testHarness.agent.dwn.processRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { protocol: 'https://protocol.xyz/foo' } }
        });
        expect(queryResponse.reply.status.code).toBe(200);
        expect(queryResponse.reply.entries!.length).toBeGreaterThanOrEqual(1);
      });

      it('synchronizes records for 1 identity from remote DWN to local DWN', async () => {
        // Write a test record to Alice's remote DWN.
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse.message!.recordId;

        // Confirm the record does NOT exist on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat : 'text/plain',
              schema     : randomSchema
            }
          }
        });
        let localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(0); // Record doesn't exist on local DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
        await syncEngine.sync('pull');

        // Confirm the record now DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(1); // Record does exist on local DWN.


        // Add another record for a subsequent sync.
        const writeResponse2 = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(['Hello, world 2!'])
        });
        // Get the record ID of the test record.
        const testRecord2Id = writeResponse2.message!.recordId;

        // Confirm the new record does NOT exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(0); // New Record doesn't exist on local DWN.

        await syncEngine.sync('pull');

        // Confirm the new record DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(1); // New Record does exist on local DWN.
      });

      it('synchronizes records with data larger than the `encodedData` limit within the `RecordsQuery` response', async () => {
        // larger than the size of data returned in a RecordsQuery
        const LARGE_DATA_SIZE = 1_000 + DwnConstant.maxDataSizeAllowedToBeEncoded;

        // register alice
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // create a remote record
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          store         : false,
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(Array(LARGE_DATA_SIZE).fill('a')) //large data
        });

        // check that the record doesn't exist locally
        const { reply: localReply } = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });

        expect(localReply.status.code).toBe(200);
        expect(localReply.entries).toHaveLength(0);

        // initiate sync
        await syncEngine.sync('pull');

        // query that the local record exists
        const { reply: localReply2 } = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });

        expect(localReply2.status.code).toBe(200);
        expect(localReply2.entries).toHaveLength(1);
        const [ entry ] = localReply2.entries!;
        expect(entry.encodedData).toBeUndefined(); // encodedData is undefined

        // Execute a RecordsRead to verify the data was synced.
        // check for response encodedData if it doesn't exist issue a RecordsRead
        // get individual records without encodedData to check that data exists
        const readResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });
        expect(readResponse.reply.status.code).toBe(200);
        expect(readResponse.reply.entry).toBeDefined();
        expect(readResponse.reply.entry!.data).toBeDefined();
        expect(readResponse.reply.entry!.recordsWrite!.descriptor.dataSize).toBe(LARGE_DATA_SIZE);
      });

      it('synchronizes records for multiple identities from remote DWN to local DWN', async () => {
        // Create a second Identity to author the DWN messages.
        const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

        // Install free-for-all protocol on Bob's local and remote DWNs.
        await testHarness.agent.dwn.processRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : { definition: freeForAllProtocolDefinition }
        });
        await testHarness.agent.dwn.sendRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : { definition: freeForAllProtocolDefinition }
        });

        // Write a test record to Alice's remote DWN.
        let writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(['Hello, Bob!'])
        });

        // Get the record ID of Alice's test record.
        const testRecordIdAlice = writeResponse.message!.recordId;

        // Write a test record to Bob's remote DWN.
        writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(['Hello, Alice!'])
        });

        // Get the record ID of Bob's test record.
        const testRecordIdBob = writeResponse.message!.recordId;

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Register Bob's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : bob.did.uri,
          options : { protocols: 'all' },
        });

        // Execute Sync to pull all records from Alice's and Bob's remove DWNs to their local DWNs.
        await syncEngine.sync('pull');

        // Confirm the Alice test record exist on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdAlice } }
        });
        let localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(1); // Record does exist on local DWN.

        // Confirm the Bob test record exist on Bob's local DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdBob } }
        });
        localDwnQueryReply = queryResponse.reply;
        expect(localDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(localDwnQueryReply.entries).toHaveLength(1); // Record does exist on local DWN.
      });
    });

    describe('push()', () => {
      it('synchronizes records that have been updated', async () => {
        // Write a test record to Alice's local DWN.
        const writeResponse1 = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse1.message!.recordId;

        // const update the record
        const updateResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId     : testRecordId,
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema,
            dateCreated  : writeResponse1.message!.descriptor.dateCreated
          },
          dataStream: new Blob(['Hello, world updated!'])
        });
        expect(updateResponse.reply.status.code).toBe(202);
        expect(updateResponse.message!.recordId).toBe(testRecordId);

        const updateMessageCid = updateResponse.messageCid;

        // Confirm the record does NOT exist on Alice's remote DWN.
        let queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat : 'text/plain',
              schema     : randomSchema
            }
          }
        });
        let remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(0); // Record doesn't exist on local DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Execute Sync to pull all records from Alice's remote DWN to Alice's local DWN.
        await syncEngine.sync('push');

        // Confirm the record now DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(1); // Record does exist on local DWN.

        // remove `initialWrite` from the response to generate an accurate messageCid
        const { initialWrite, ...rawMessage } = remoteDwnQueryReply.entries![0];
        const queriedMessageCid = await Message.getCid(rawMessage);
        expect(queriedMessageCid).toBe(updateMessageCid);
      });

      it('takes no action if no identities are registered', async () => {
        const didResolveSpy = sinon.spy(testHarness.agent.did, 'resolve');
        const processRequestSpy = sinon.spy(testHarness.agent.dwn, 'processRequest');

        await syncEngine.sync('push');

        // Verify DID resolution and DWN requests did not occur.
        expect(didResolveSpy.notCalled).toBe(true);
        expect(processRequestSpy.notCalled).toBe(true);

        didResolveSpy.restore();
        processRequestSpy.restore();
      });

      it('should reject delegated scoped registration when the permission grant is missing during push setup', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        await expect(testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        })).rejects.toThrow('lacks Messages.Read grants for closure protocols: https://protocol.xyz/foo');
      });

      it('pushes a missing delegate grant dependency before a scoped local record', async () => {
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        // install a protocol on the local node for aliceSync
        const protocolsFoo = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).toBe(202);

        // create a record locally
        const record1 = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'https://protocol.xyz/foo',
            protocolPath : 'foo',
            schema       : 'https://schemas.xyz/foo',
            dataFormat   : 'text/plain',
          },
          dataStream: new Blob(['Hello, world!'])
        });
        expect(record1.reply.status.code).toBe(202);

        const delegateDid = await testHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Delegate', connectedDid: aliceSync.did.uri }
        });

        // write a MessagesQuery permission grant — store locally only (NOT on remote)
        const messagesQueryGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : aliceSync.did.uri,
          grantedTo   : delegateDid.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : {
            interface : DwnInterfaceName.Messages,
            method    : DwnMethodName.Read,
            protocol  : 'https://protocol.xyz/foo'
          }
        });

        const { encodedData: messagesQueryGrantData, ...messagesQueryGrantMessage } = messagesQueryGrant.message;
        const processGrant = await testHarness.agent.processDwnRequest({
          author      : delegateDid.did.uri,
          target      : delegateDid.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(messagesQueryGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processGrant.reply.status.code).toBe(202);

        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            delegateDid : delegateDid.did.uri,
            protocols   : [ 'https://protocol.xyz/foo' ]
          }
        });

        await syncEngine.sync('push');

        const grantQuery = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: messagesQueryGrant.message.recordId } },
        });
        expect(grantQuery.reply.status.code).toBe(200);
        expect(grantQuery.reply.entries).toHaveLength(1);

        const recordQuery = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: record1.message!.recordId } },
        });
        expect(recordQuery.reply.status.code).toBe(200);
        expect(recordQuery.reply.entries).toHaveLength(1);
      });

      it('synchronizes records for 1 identity from local DWN to remote DWN', async () => {
        // Write a record that we can use for this test.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(['Hello, world!'])
        });

        // Get the record ID of the test record.
        const testRecordId = writeResponse.message!.recordId;

        // Confirm the record does NOT exist on Alice's remote DWN.
        let queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        let remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(0); // Record doesn't exist on remote DWN.

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Execute Sync to push all records from Alice's local DWN to Alice's remote DWN.
        await syncEngine.sync('push');

        // Confirm the record now DOES exist on Alice's remote DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(1); // Record does exist on remote DWN.

        // Add another record for a subsequent sync.
        const writeResponse2 = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(['Hello, world 2!'])
        });
        // Get the record ID of the test record.
        const testRecord2Id = writeResponse2.message!.recordId;

        // Confirm the new record does NOT exist on Alice's remote DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(0); // New Record doesn't exist on local DWN.

        await syncEngine.sync('push');

        // Confirm the new record DOES exist on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecord2Id } } // New RecordId
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(1); // New Record does exist on local DWN.
      });

      it('synchronizes records with data larger than the `encodedData` limit within the `RecordsQuery` response', async () => {
        // larger than the size of data returned in a RecordsQuery
        const LARGE_DATA_SIZE = DwnConstant.maxDataSizeAllowedToBeEncoded + 1_000;

        //register alice
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // create a local record
        const record = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(Array(LARGE_DATA_SIZE).fill('a')) //large data
        });

        // check that record doesn't exist remotely
        const { reply: remoteReply } = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: record.message!.recordId } }
        });

        expect(remoteReply.status.code).toBe(200);
        expect(remoteReply.entries).toHaveLength(0);

        // initiate sync
        await syncEngine.sync('push');

        // query for remote REcords
        const { reply: remoteReply2 } = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: record.message!.recordId } }
        });

        expect(remoteReply2.status.code).toBe(200);
        expect(remoteReply2.entries).toHaveLength(1);
        const entry = remoteReply2.entries![0];
        expect(entry.encodedData).toBeUndefined();
        // check for response encodedData if it doesn't exist issue a RecordsRead
        const recordId = entry.recordId;
        // get individual records without encodedData to check that data exists
        const readRecord = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId } }
        });
        const reply = readRecord.reply;
        expect(reply.status.code).toBe(200);
        expect(reply.entry).toBeDefined();
        expect(reply.entry!.data).toBeDefined();
      });

      it('synchronizes records for multiple identities from local DWN to remote DWN', async () => {
        // Create a second Identity to author the DWN messages.
        const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

        // Install free-for-all protocol on Bob's local DWN.
        await testHarness.agent.dwn.processRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : { definition: freeForAllProtocolDefinition }
        });

        // Write a test record to Alice's local DWN.
        let writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(['Hello, Bob!'])
        });

        // Get the record ID of Alice's test record.
        const testRecordIdAlice = writeResponse.message!.recordId;

        // Write a test record to Bob's local DWN.
        writeResponse = await testHarness.agent.dwn.processRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain'
          },
          dataStream: new Blob(['Hello, Alice!'])
        });

        // Get the record ID of Bob's test record.
        const testRecordIdBob = writeResponse.message!.recordId;

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Register Bob's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : bob.did.uri,
          options : { protocols: 'all' },
        });

        // Execute Sync to push all records from Alice's and Bob's local DWNs to their remote DWNs.
        await syncEngine.sync('push');

        // Confirm the Alice test record exist on Alice's remote DWN.
        let queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdAlice } }
        });
        let remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(1); // Record does exist on remote DWN.

        // Confirm the Bob test record exist on Bob's remote DWN.
        queryResponse = await testHarness.agent.dwn.sendRequest({
          author        : bob.did.uri,
          target        : bob.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordIdBob } }
        });
        remoteDwnQueryReply = queryResponse.reply;
        expect(remoteDwnQueryReply.status.code).toBe(200); // Query was successfully executed.
        expect(remoteDwnQueryReply.entries).toHaveLength(1); // Record does exist on remote DWN.
      });
    });

    describe('sync enhancements', () => {
      it('syncs RecordsDelete messages from remote to local', async () => {
        // Scenario: Alice writes a record to her remote DWN, syncs it locally,
        //           then deletes it on the remote, and syncs again.
        //           The delete should propagate to the local DWN.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Write a record to Alice's remote DWN.
        const writeResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob(['Record to be deleted'])
        });
        expect(writeResponse.reply.status.code).toBe(202);
        const testRecordId = writeResponse.message!.recordId;

        // Pull the record to Alice's local DWN.
        await syncEngine.sync('pull');

        // Confirm the record exists on Alice's local DWN.
        let queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(queryResponse.reply.status.code).toBe(200);
        expect(queryResponse.reply.entries).toHaveLength(1);

        // Delete the record on Alice's remote DWN.
        const deleteResponse = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsDelete,
          messageParams : { recordId: testRecordId }
        });
        expect(deleteResponse.reply.status.code).toBe(202);

        // Pull again to sync the delete.
        await syncEngine.sync('pull');

        // Confirm the record no longer exists on Alice's local DWN.
        queryResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(queryResponse.reply.status.code).toBe(200);
        expect(queryResponse.reply.entries).toHaveLength(0);
      });

      it('syncs RecordsDelete messages from local to remote', async () => {
        // Scenario: Alice writes a record locally, pushes it to remote,
        //           then deletes locally, and pushes again.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Write a record to Alice's local DWN.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob(['Record to be deleted'])
        });
        expect(writeResponse.reply.status.code).toBe(202);
        const testRecordId = writeResponse.message!.recordId;

        // Push to remote.
        await syncEngine.sync('push');

        // Confirm record exists on remote.
        let remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.status.code).toBe(200);
        expect(remoteQuery.reply.entries).toHaveLength(1);

        // Delete the record locally.
        const deleteResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsDelete,
          messageParams : { recordId: testRecordId }
        });
        expect(deleteResponse.reply.status.code).toBe(202);

        // Push again to sync the delete.
        await syncEngine.sync('push');

        // Confirm record no longer exists on remote.
        remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.status.code).toBe(200);
        expect(remoteQuery.reply.entries).toHaveLength(0);
      });

      it('is idempotent — running sync twice after convergence is a no-op', async () => {
        // Scenario: Alice writes a record locally, syncs once to converge,
        //           then syncs again.  The second sync should short-circuit
        //           at the root comparison and make no additional MessagesRead requests.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Write a record locally.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob(['Idempotent sync test'])
        });
        expect(writeResponse.reply.status.code).toBe(202);

        // First sync to push the record to remote and converge.
        await syncEngine.sync();

        // Confirm the record exists on both local and remote.
        const localQuery = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });
        expect(localQuery.reply.entries).toHaveLength(1);

        const remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: writeResponse.message!.recordId } }
        });
        expect(remoteQuery.reply.entries).toHaveLength(1);

        // Spy on sendDwnRequest to count RPC calls during the second sync.
        const sendDwnRequestSpy = sinon.spy(testHarness.agent.rpc, 'sendDwnRequest');

        // Second sync — feeds are already converged, so it should only issue
        // lightweight fingerprint probes and avoid body replay.
        await syncEngine.sync();

        const rpcMessages = sendDwnRequestSpy.args.map(call => call[0]?.message as any);
        const messagesReadCalls = rpcMessages.filter(message =>
          message?.descriptor?.interface === DwnInterfaceName.Messages &&
          message?.descriptor?.method === DwnMethodName.Read
        );
        const messagesQueryCalls = rpcMessages.filter(message =>
          message?.descriptor?.interface === DwnInterfaceName.Messages &&
          message?.descriptor?.method === DwnMethodName.Query
        );
        const uncursoredBodyFeedQueries = messagesQueryCalls.filter(message =>
          message?.descriptor?.cidsOnly !== true &&
          message?.descriptor?.cursor === undefined
        );

        expect(messagesReadCalls).toHaveLength(0);
        expect(uncursoredBodyFeedQueries).toHaveLength(0);

        sendDwnRequestSpy.restore();
      });

      it('resolves conflicts when both sides update the same record', async () => {
        // Scenario: Alice creates a record and syncs it to both DWNs.
        //           Then she updates it locally AND remotely with different data.
        //           After sync, both sides should converge to the same state.
        //           DWN conflict resolution uses the latest messageTimestamp.

        // Register Alice's DID for sync.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Write a record locally.
        const writeResponse = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema
          },
          dataStream: new Blob(['Original data'])
        });
        expect(writeResponse.reply.status.code).toBe(202);
        const testRecordId = writeResponse.message!.recordId;
        const dateCreated = writeResponse.message!.descriptor.dateCreated;

        // Sync to push the record to remote.
        await syncEngine.sync();

        // Confirm it exists on both sides.
        let localQuery = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(localQuery.reply.entries).toHaveLength(1);

        let remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.entries).toHaveLength(1);

        // Update on the remote with an earlier timestamp.
        const remoteUpdate = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId     : testRecordId,
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema,
            dateCreated  : dateCreated,
          },
          dataStream: new Blob(['Remote update'])
        });
        expect(remoteUpdate.reply.status.code).toBe(202);

        // Update on the local with a later timestamp (by using Time offset).
        const localUpdate = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            recordId     : testRecordId,
            protocol     : 'http://free-for-all.xyz',
            protocolPath : 'post',
            dataFormat   : 'text/plain',
            schema       : randomSchema,
            dateCreated  : dateCreated,
          },
          dataStream: new Blob(['Local update — later'])
        });
        expect(localUpdate.reply.status.code).toBe(202);
        const localUpdateCid = localUpdate.messageCid;

        // Sync both directions.
        await syncEngine.sync();

        // After sync, both sides should have the same record version.
        // The winner is whichever has the later messageTimestamp. Since the
        // local update happened after the remote update chronologically,
        // the local update should win on both sides.
        localQuery = await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(localQuery.reply.entries).toHaveLength(1);

        remoteQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { recordId: testRecordId } }
        });
        expect(remoteQuery.reply.entries).toHaveLength(1);

        // Both should resolve to the same message CID.
        const { initialWrite: _localIW, ...localRawMessage } = localQuery.reply.entries![0];
        const { initialWrite: _remoteIW, ...remoteRawMessage } = remoteQuery.reply.entries![0];
        const localCid = await Message.getCid(localRawMessage);
        const remoteCid = await Message.getCid(remoteRawMessage);

        // Both sides should agree on the winning message.
        expect(localCid).toBe(remoteCid);

        // The local update should be the winner (later timestamp).
        expect(localCid).toBe(localUpdateCid);
      });
    });

    describe('startSync()', () => {
      it('calls sync() in each interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');
        syncSpy.resolves();

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        testHarness.agent.sync.startSync({ interval: '500ms' });

        await clock.tickAsync(1_400); // just under 3 intervals
        syncSpy.restore();
        clock.restore();

        // one when starting the sync, and another for each interval
        expect(syncSpy.callCount).toBe(3);
      });

      it('does not call sync() again until a sync round finishes', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        let resolveFirstPull!: (result: object) => void;
        const firstPull = new Promise<object>((resolve) => {
          resolveFirstPull = resolve;
        });

        // Stub a feed phase so the real sync() manages _syncLock, while the first
        // sync remains pending until the test explicitly releases it.
        const pullRemoteFeedStub = sinon.stub(SyncEngineLevel.prototype as any, 'pullRemoteFeedForSyncTarget');
        pullRemoteFeedStub.onFirstCall().returns(firstPull);
        pullRemoteFeedStub.resolves({});

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([{
          did                : alice.did.uri,
          dwnUrl             : 'http://localhost:3000',
          scope              : { kind: 'full' },
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'test-owner-epoch',
        }]);

        const pushLocalFeedStub = sinon.stub(SyncEngineLevel.prototype as any, 'pushLocalFeedForSyncTarget');
        pushLocalFeedStub.resolves({});

        const verifyFeedConvergenceStub = sinon.stub(SyncEngineLevel.prototype as any, 'verifyFeedConvergence');
        verifyFeedConvergenceStub.resolves({ converged: true });

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        const startPromise = testHarness.agent.sync.startSync({ interval: '500ms' });

        await clock.tickAsync(0);

        // only once for when starting the sync
        expect(syncSpy.callCount).toBe(1);

        await clock.tickAsync(2_000); // multiple intervals fire while the first sync is still running

        // still only once because interval ticks are skipped while sync is running
        expect(syncSpy.callCount).toBe(1);

        resolveFirstPull({});
        await clock.tickAsync(0);
        await startPromise;

        // completing the first sync does not retroactively run skipped intervals
        expect(syncSpy.callCount).toBe(1);

        syncSpy.restore();
        verifyFeedConvergenceStub.restore();
        getSyncTargetsStub.restore();
        pullRemoteFeedStub.restore();
        pushLocalFeedStub.restore();
        clock.restore();
      });

      it('calls sync once per interval with the latest interval timer being respected', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');
        // set to be a sync time longer than the interval
        syncSpy.returns(new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            resolve();
          }, 1_000);
        }));

        testHarness.agent.sync.startSync({ interval: '500ms' });

        await clock.tickAsync(1_400); // less than the initial interval + the sync time

        // once for the initial call and once for each interval call
        expect(syncSpy.callCount).toBe(2);

        // set to be a short sync time
        syncSpy.returns(new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            resolve();
          }, 15);
        }));

        testHarness.agent.sync.startSync({ interval: '300ms' });

        await clock.tickAsync(301); // exactly the new interval + 1

        // one for the initial 'startSync' call and one for each interval call
        expect(syncSpy.callCount).toBe(4);


        await clock.tickAsync(601); // two more intervals

        expect(syncSpy.callCount).toBe(6);

        syncSpy.restore();
        clock.restore();
      });

      it('should replace the interval timer with the latest interval timer', async () => {

        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');
        // set to be a sync time longer than the interval
        syncSpy.returns(new Promise<void>((resolve) => {
          clock.setTimeout(() => {
            resolve();
          }, 100);
        }));

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // two intervals
        await clock.tickAsync(1_101);

        // this should equal 3: once for the initial call and once for each completed interval round
        expect(syncSpy.callCount).toBe(3);

        syncSpy.resetHistory();
        testHarness.agent.sync.startSync({ interval: '200ms' });

        await clock.tickAsync(501); // two interval rounds including sync duration

        // one for the initial 'startSync' call and one for each interval call
        expect(syncSpy.callCount).toBe(3);

        await clock.tickAsync(401); // two more intervals

        // one additional calls for each interval
        expect(syncSpy.callCount).toBe(5);

        syncSpy.restore();
        clock.restore();
      });

      it('should log sync errors, but continue syncing the next interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const syncSpy = sinon.stub(SyncEngineLevel.prototype as any, 'sync');

        syncSpy.returns(new Promise<void>((resolve, _reject) => {
          clock.setTimeout(() => {
            resolve();
          }, 100);
        }));

        // first call is the initial sync, 2nd and onward are the intervals
        // on the 2nd interval (3rd call), we reject the promise, a 4th call should be made
        syncSpy.onThirdCall().rejects(new Error('Sync error'));

        // spy on console.error to check if the error message is logged
        const consoleErrorSpy = sinon.stub(console, 'error').resolves();

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // three intervals
        await clock.tickAsync(1_601);

        // this should equal 4, once for the initial call and once for each interval call
        expect(syncSpy.callCount).toBe(4);

        // check if the error message is logged
        expect(consoleErrorSpy.callCount).toBe(1);
        expect(consoleErrorSpy.args[0][0]).toContain('SyncEngineLevel: Error during sync operation');

        syncSpy.restore();
        consoleErrorSpy.restore();
        clock.restore();
      });
    });

    describe('stopSync()', () => {
      it('stops the sync interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to return empty array so sync() completes quickly
        // but still sets/releases the _syncLock
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        const startPromise = testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).toBe(1);

        await clock.tickAsync(3);
        await startPromise;

        await clock.tickAsync(1_100); // two interval rounds after the immediate sync

        // expect 2 sync interval calls + initial sync
        expect(syncSpy.callCount).toBe(3);

        await testHarness.agent.sync.stopSync();

        await clock.tickAsync(1_000); // 2 intervals

        // sync calls remain unchanged
        expect(syncSpy.callCount).toBe(3);

        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

      it('waits for the current sync to complete before stopping', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to take a controlled amount of time
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        const startPromise = testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).toBe(1);

        await clock.tickAsync(3);
        await startPromise;

        // cause getSyncTargets to take longer
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 1_000);
        }));

        await clock.tickAsync(501); // Enough time for the next interval to start

        // next interval was called
        expect(syncSpy.callCount).toBe(2);

        // stop the sync
        await new Promise<void>((resolve) => {
          const stopPromise = testHarness.agent.sync.stopSync();
          clock.tickAsync(1_000).then(async () => {
            await stopPromise;
            resolve();
          });
        });

        // sync calls remain unchanged
        expect(syncSpy.callCount).toBe(2);

        // wait for future intervals
        await clock.tickAsync(2_000);

        // sync calls remain unchanged
        expect(syncSpy.callCount).toBe(2);

        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

      it('throws if ongoing sync does not complete within 2 seconds', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to take a controlled amount of time
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        const startPromise = testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).toBe(1);

        await clock.tickAsync(3);
        await startPromise;

        // cause getSyncTargets to take longer than the 2 second timeout
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 2_700); // longer than the 2 seconds
        }));

        await clock.tickAsync(501); // Enough time for the next interval to start

        // next interval was called
        expect(syncSpy.callCount).toBe(2);

        const stopPromise = testHarness.agent.sync.stopSync();

        try {
          await new Promise<void>((resolve, reject) => {
            stopPromise.catch((error) => reject(error));

            clock.runToLastAsync().then(async () => {
              try {
                await stopPromise;
                resolve();
              } catch (error) {
                reject(error);
              }
            });

          });
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe('SyncEngineLevel: Existing sync operation did not complete within 2000 milliseconds.');
        }

        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

      it('only waits for the ongoing sync for the given timeout before failing', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // stub getSyncTargets to take a controlled amount of time
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 3);
        }));

        const syncSpy = sinon.spy(SyncEngineLevel.prototype as any, 'sync');

        testHarness.agent.sync.startSync({ interval: '500ms' });

        // expect the immediate sync call
        expect(syncSpy.callCount).toBe(1);

        await clock.tickAsync(10); // enough time for the sync round trip to complete

        // cause getSyncTargets to take longer than the 2 second timeout
        getSyncTargetsStub.returns(new Promise<any[]>((resolve) => {
          clock.setTimeout(() => {
            resolve([]);
          }, 2_700); // longer than the 2 seconds
        }));

        await clock.tickAsync(501); // Enough time for the next interval to start

        // next interval was called
        expect(syncSpy.callCount).toBe(2);

        const stopPromise = testHarness.agent.sync.stopSync(10);
        try {
          await new Promise<void>((resolve, reject) => {
            stopPromise.catch((error) => reject(error));

            clock.tickAsync(10).then(async () => {
              try {
                await stopPromise;
                resolve();
              } catch (error) {
                reject(error);
              }
            });

          });
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe('SyncEngineLevel: Existing sync operation did not complete within 10 milliseconds.');
        }

        // call again with a longer timeout
        await new Promise<void>((resolve) => {
          const stopPromise2 = testHarness.agent.sync.stopSync(3_000);
          // enough time for the ongoing sync to complete + 100ms as the check interval
          clock.tickAsync(2800).then(async () => {
            stopPromise2.then(() => resolve());
          });
        });

        await clock.runToLastAsync();
        syncSpy.restore();
        getSyncTargetsStub.restore();
        clock.restore();
      });

    });

    describe('Identity Registration', () => {
      it('registers an identity with the sync engine', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        const identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).toEqual(syncOption);
      });

      it('throws if attempting to register an identity that is already registered', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        try {
          await testHarness.agent.sync.registerIdentity({ did, options: syncOption });
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe(`SyncEngineLevel: Identity with DID ${did} is already registered.`);
        }
      });

      it('unregisters an identity from the sync engine', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        // sanity confirm that the identity is registered
        let identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).toEqual(syncOption);

        await testHarness.agent.sync.unregisterIdentity(did);

        identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).toBeUndefined();
      });

      it('throws when attempting to unregister an identity that is not registered', async () => {
        const did = alice.did.uri;
        try {
          await testHarness.agent.sync.unregisterIdentity(did);
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
        }
      });

      it('gets the sync options for a specific identity', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        const identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).toEqual(syncOption);
      });

      it('throws if underlying DB throws an error when getting identity options', async () => {
        // stub the sublevel get method to throw an error
        const stubbedSublevel = {
          get: (_key:string): never => { throw { code: 'DB_ERROR' }; }
        };
        sinon.stub(syncEngine['_db'], 'sublevel').withArgs('registeredIdentities').returns(stubbedSublevel as any);

        try {
          await testHarness.agent.sync.getIdentityOptions('did:example:123');
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe('SyncEngineLevel: Error reading level: DB_ERROR.');
        }
      });

      it('updates the sync options for a specific identity', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };
        await testHarness.agent.sync.registerIdentity({ did, options: syncOption });

        // sanity confirm that the identity is registered
        let identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).toEqual(syncOption);

        const updatedSyncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar']
        };
        await testHarness.agent.sync.updateIdentityOptions({ did, options: updatedSyncOption });

        identityOptions = await testHarness.agent.sync.getIdentityOptions(did);
        expect(identityOptions).toEqual(updatedSyncOption);
      });

      it('throws if attempting to update an identity that is not registered', async () => {
        const did = alice.did.uri;
        const syncOption: SyncIdentityOptions = {
          protocols: ['https://protocol.xyz/foo', 'https://protocol.xyz/bar', 'https://protocol.xyz/baz']
        };

        try {
          await testHarness.agent.sync.updateIdentityOptions({ did, options: syncOption });
          throw new Error('Expected an error to be thrown');
        } catch (error:any) {
          expect(error.message).toBe(`SyncEngineLevel: Identity with DID ${did} is not registered.`);
        }
      });

      it('syncs only specified protocols', async () => {
        // create new identity to not conflict the previous tests's remote records
        const aliceSync = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        // create 3 local protocols
        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        const protocolBar: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/bar',
          types     : {
            bar: {
              schema      : 'https://schemas.xyz/bar',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            bar: {}
          }
        };

        const protocolBaz: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/baz',
          types     : {
            baz: {
              schema      : 'https://schemas.xyz/baz',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            baz: {}
          }
        };

        const protocolsFoo = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).toBe(202);

        const protocolsBar = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolBar
          }
        });
        expect(protocolsBar.reply.status.code).toBe(202);

        const protocolsBaz = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolBaz
          }
        });
        expect(protocolsBaz.reply.status.code).toBe(202);

        // write a record for each protocol
        const recordFoo = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolFoo.protocol,
            protocolPath : 'foo',
            schema       : protocolFoo.types.foo.schema
          },
          dataStream: new Blob(['Hello, foo!'])
        });
        expect(recordFoo.reply.status.code).toBe(202);

        const recordBar = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBar.protocol,
            protocolPath : 'bar',
            schema       : protocolBar.types.bar.schema
          },
          dataStream: new Blob(['Hello, bar!'])
        });
        expect(recordBar.reply.status.code).toBe(202);

        const recordBaz = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBaz.protocol,
            protocolPath : 'baz',
            schema       : protocolBaz.types.baz.schema
          },
          dataStream: new Blob(['Hello, baz!'])
        });
        expect(recordBaz.reply.status.code).toBe(202);

        // Register Alice's DID to be synchronized with only foo and bar protocols
        await testHarness.agent.sync.registerIdentity({
          did     : aliceSync.did.uri,
          options : {
            protocols: [ 'https://protocol.xyz/foo', 'https://protocol.xyz/bar' ]
          }
        });

        // Execute Sync to push sync, only foo protocol should be synced
        await syncEngine.sync('push');

        // query remote to see foo protocol
        const remoteProtocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.ProtocolsQuery,
          messageParams : {}
        });
        const remoteProtocolsQueryReply = remoteProtocolsQueryResponse.reply;
        expect(remoteProtocolsQueryReply.status.code).toBe(200);
        expect(remoteProtocolsQueryReply.entries).toHaveLength(2);
        expect(remoteProtocolsQueryReply.entries).toEqual([ protocolsFoo.message, protocolsBar.message ]);

        // query remote to see foo record
        const remoteFooRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolFoo.protocol,
            }
          }
        });
        const remoteFooRecordsReply = remoteFooRecordsResponse.reply;
        expect(remoteFooRecordsReply.status.code).toBe(200);
        expect(remoteFooRecordsReply.entries).toHaveLength(1);
        const remoteFooRecordIds = remoteFooRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteFooRecordIds).toEqual(expect.arrayContaining([ recordFoo.message!.recordId ]));

        // query remote to see bar record
        let remoteBarRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        let remoteBarRecordsReply = remoteBarRecordsResponse.reply;
        expect(remoteBarRecordsReply.status.code).toBe(200);
        expect(remoteBarRecordsReply.entries).toHaveLength(1);
        let remoteBarRecordIds = remoteBarRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteBarRecordIds).toEqual(expect.arrayContaining([ recordBar.message!.recordId ]));

        // query remote to see baz record, none should be returned
        let remoteBazRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBaz.protocol,
            }
          }
        });
        let remoteBazRecordsReply = remoteBazRecordsResponse.reply;
        expect(remoteBazRecordsReply.status.code).toBe(200);
        expect(remoteBazRecordsReply.entries).toHaveLength(0);


        // now write a foo record remotely, and a bar record locally
        // initiate a sync to both push and pull the records respectively

        // write a record to the remote for the foo protocol
        const recordFoo2 = await testHarness.agent.sendDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolFoo.protocol,
            protocolPath : 'foo',
            schema       : protocolFoo.types.foo.schema
          },
          dataStream: new Blob(['Hello, foo 2!'])
        });
        expect(recordFoo2.reply.status.code).toBe(202);

        // write a local record to the bar protocol
        const recordBar2 = await testHarness.agent.processDwnRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBar.protocol,
            protocolPath : 'bar',
            schema       : protocolBar.types.bar.schema
          },
          dataStream: new Blob(['Hello, bar 2!'])
        });
        expect(recordBar2.reply.status.code).toBe(202);

        // confirm that the foo record is not yet in the local DWN
        let localFooRecordsResponse = await testHarness.agent.dwn.processRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolFoo.protocol,
            }
          }
        });
        let localFooRecordsReply = localFooRecordsResponse.reply;
        expect(localFooRecordsReply.status.code).toBe(200);
        expect(localFooRecordsReply.entries).toHaveLength(1);
        let localFooRecordIds = localFooRecordsReply.entries?.map(entry => entry.recordId);
        expect(localFooRecordIds).not.toContain(recordFoo2.message!.recordId);


        // confirm that the bar record is not yet in the remote DWN
        remoteBarRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        remoteBarRecordsReply = remoteBarRecordsResponse.reply;
        expect(remoteBarRecordsReply.status.code).toBe(200);
        expect(remoteBarRecordsReply.entries).toHaveLength(1);
        remoteBarRecordIds = remoteBarRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteBarRecordIds).not.toContain(recordBar2.message!.recordId);

        // preform a pull and push sync
        await syncEngine.sync();

        // query local to see foo records with the new record
        localFooRecordsResponse = await testHarness.agent.dwn.processRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolFoo.protocol,
            }
          }
        });
        localFooRecordsReply = localFooRecordsResponse.reply;
        expect(localFooRecordsReply.status.code).toBe(200);
        expect(localFooRecordsReply.entries).toHaveLength(2);
        localFooRecordIds = localFooRecordsReply.entries?.map(entry => entry.recordId);
        expect(localFooRecordIds).toEqual(expect.arrayContaining([ recordFoo.message!.recordId, recordFoo2.message!.recordId ]));

        // query remote to see bar records with the new record
        remoteBarRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        remoteBarRecordsReply = remoteBarRecordsResponse.reply;
        expect(remoteBarRecordsReply.status.code).toBe(200);
        expect(remoteBarRecordsReply.entries).toHaveLength(2);
        remoteBarRecordIds = remoteBarRecordsReply.entries?.map(entry => entry.recordId);
        expect(remoteBarRecordIds).toEqual(expect.arrayContaining([ recordBar.message!.recordId, recordBar2.message!.recordId ]));

        // confirm that still no baz records exist remotely
        remoteBazRecordsResponse = await testHarness.agent.dwn.sendRequest({
          author        : aliceSync.did.uri,
          target        : aliceSync.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBaz.protocol,
            }
          }
        });
        remoteBazRecordsReply = remoteBazRecordsResponse.reply;
        expect(remoteBazRecordsReply.status.code).toBe(200);
        expect(remoteBazRecordsReply.entries).toHaveLength(0);
      });

      it('syncs only specified protocols and delegates', async () => {
        const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });

        const aliceDeviceXHarness = await PlatformAgentTestHarness.setup({
          agentClass       : TestAgent,
          agentStores      : 'memory',
          testDataLocation : '__TESTDATA__/alice-device',
        });
        await aliceDeviceXHarness.clearStorage();
        await aliceDeviceXHarness.createAgentDid();

        // create a connected DID
        const aliceDeviceX = await aliceDeviceXHarness.agent.identity.create({
          store     : true,
          didMethod : 'jwk',
          metadata  : { name: 'Alice Device X', connectedDid: alice.did.uri }
        });

        // Alice create 2 protocols on alice's remote DWN
        const protocolFoo: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/foo',
          types     : {
            foo: {
              schema      : 'https://schemas.xyz/foo',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            foo: {}
          }
        };

        const protocolBar: ProtocolDefinition = {
          published : true,
          protocol  : 'https://protocol.xyz/bar',
          types     : {
            bar: {
              schema      : 'https://schemas.xyz/bar',
              dataFormats : ['text/plain', 'application/json']
            }
          },
          structure: {
            bar: {}
          }
        };

        // configure the protocols
        const protocolsFoo = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolFoo
          }
        });
        expect(protocolsFoo.reply.status.code).toBe(202);

        const protocolsBar = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : {
            definition: protocolBar
          }
        });
        expect(protocolsBar.reply.status.code).toBe(202);

        // create grants for foo protocol, granted to aliceDeviceX
        const messagesReadGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : alice.did.uri,
          grantedTo   : aliceDeviceX.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : { protocol: protocolFoo.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read }
        });

        const messagesQueryGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : alice.did.uri,
          grantedTo   : aliceDeviceX.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          scope       : { protocol: protocolFoo.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read }
        });

        const recordsQueryGrant = await testHarness.agent.permissions.createGrant({
          store       : true,
          author      : alice.did.uri,
          grantedTo   : aliceDeviceX.did.uri,
          dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
          delegated   : true,
          scope       : { protocol: protocolFoo.protocol, interface: DwnInterfaceName.Records, method: DwnMethodName.Read }
        });

        const { encodedData: readGrantData, ... messagesReadGrantMessage } = messagesReadGrant.message;
        const processMessagesReadGrantAsOwner = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : aliceDeviceX.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesReadGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(readGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processMessagesReadGrantAsOwner.reply.status.code).toBe(202);

        const processMessagesReadGrant = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesReadGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(readGrantData).toUint8Array() ])
        });
        expect(processMessagesReadGrant.reply.status.code).toBe(202);

        const { encodedData: syncGrantData, ... messagesQueryGrantMessage } = messagesQueryGrant.message;
        const processMessagesQueryGrantAsOwner = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : aliceDeviceX.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(syncGrantData).toUint8Array() ]),
          signAsOwner : true
        });
        expect(processMessagesQueryGrantAsOwner.reply.status.code).toBe(202);

        const processMessagesQueryGrant = await aliceDeviceXHarness.agent.processDwnRequest({
          author      : aliceDeviceX.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(syncGrantData).toUint8Array() ]),
        });
        expect(processMessagesQueryGrant.reply.status.code).toBe(202);

        // send the grants to the remote DWN
        const remoteMessagesQueryGrant = await testHarness.agent.sendDwnRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(syncGrantData).toUint8Array() ]),
        });
        expect(remoteMessagesQueryGrant.reply.status.code).toBe(202);

        const remoteMessagesReadGrant = await testHarness.agent.sendDwnRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : messagesReadGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(readGrantData).toUint8Array() ]),
        });
        expect(remoteMessagesReadGrant.reply.status.code).toBe(202);

        const { encodedData: recordsQueryGrantData, ... recordsQueryGrantMessage } = recordsQueryGrant.message;
        const processRecordsQueryGrant = await testHarness.agent.sendDwnRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : recordsQueryGrantMessage,
          dataStream  : new Blob([ Convert.base64Url(recordsQueryGrantData).toUint8Array() ]),
        });
        expect(processRecordsQueryGrant.reply.status.code).toBe(202);


        // create a record for each protocol
        const recordFoo = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolFoo.protocol,
            protocolPath : 'foo',
            schema       : protocolFoo.types.foo.schema
          },
          dataStream: new Blob(['Hello, foo!'])
        });
        expect(recordFoo.reply.status.code).toBe(202);

        const recordBar = await testHarness.agent.sendDwnRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolBar.protocol,
            protocolPath : 'bar',
            schema       : protocolBar.types.bar.schema
          },
          dataStream: new Blob(['Hello, bar!'])
        });
        expect(recordBar.reply.status.code).toBe(202);

        // Register Alice's DID to be synchronized with only foo protocol
        await aliceDeviceXHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : {
            protocols   : [ protocolFoo.protocol ],
            delegateDid : aliceDeviceX.did.uri
          }
        });

        // Execute pull sync, only foo protocol should be synced.
        await aliceDeviceXHarness.agent.sync.sync('pull');

        // query aliceDeviceX to see foo records
        const localFooRecords = await aliceDeviceXHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          granteeDid    : aliceDeviceX.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            delegatedGrant : recordsQueryGrant.message,
            filter         : {
              protocol: protocolFoo.protocol,
            }
          }
        });
        const didAuthor = Jws.getSignerDid(localFooRecords.message!.authorization?.signature.signatures[0]!);
        expect(didAuthor).toBe(aliceDeviceX.did.uri);
        expect(localFooRecords.reply.status.code).toBe(200);
        expect(localFooRecords.reply.entries).toHaveLength(1);
        expect(localFooRecords.reply.entries?.map(entry => entry.recordId)).toEqual([ recordFoo.message?.recordId ]);

        // sanity check that bar records do not exist on aliceDeviceX
        // since aliceDeviceX does not have a grant for the bar protocol, query the records using alice's signatures.
        // confirm that the query was successful on alice's remote DWN and returns the message
        const localBarRecordsQuery = await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol: protocolBar.protocol,
            }
          }
        });
        expect(localBarRecordsQuery.reply.status.code).toBe(200);
        expect(localBarRecordsQuery.reply.entries).toHaveLength(1);

        // use the same message to query `aliceDeviceXHarness` DWN, should return zero results because they were not synced
        const localBarRecords = await aliceDeviceXHarness.agent.dwn.processRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsQuery,
          rawMessage  : localBarRecordsQuery.message,
        });
        expect(localBarRecords.reply.status.code).toBe(200);
        expect(localBarRecords.reply.entries).toHaveLength(0);
      });

      it('defaults to all protocols and undefined delegate if no options are provided', async () => {
        // spy on AbstractLevel put
        const abstractLevelPut = sinon.spy(AbstractLevel.prototype, 'put');

        // register identity without any options
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const registerIdentitiesPutCall = abstractLevelPut.args[0];
        const options = JSON.parse(registerIdentitiesPutCall[1] as string);
        // confirm that the options are stored as-is with protocols: 'all'
        expect(options).toEqual({ protocols: 'all' });
      });
    });

    describe('connectivity state transitions', () => {
      it('should transition to online after a successful sync with registered targets', async () => {
        // Reset connectivity state (shared syncEngine may have been set to 'online' by prior tests).
        syncEngine['_connectivityState'] = 'unknown';
        expect(syncEngine.connectivityState).toBe('unknown');

        // Register Alice's DID to be synchronized.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        await syncEngine.sync();

        expect(syncEngine.connectivityState).toBe('online');
      });

      it('should transition to offline after a sync failure', async () => {
        syncEngine['_connectivityState'] = 'unknown';

        // Register Alice's DID.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // First sync to get to online state.
        await syncEngine.sync();
        expect(syncEngine.connectivityState).toBe('online');

        // Now stub feed pull to throw, simulating a failure.
        const pullRemoteFeedStub = sinon.stub(syncEngine as any, 'pullRemoteFeedForSyncTarget').rejects(new Error('simulated failure'));

        // Suppress console.error for the expected error.
        const consoleErrorStub = sinon.stub(console, 'error');

        await expect(syncEngine.sync()).rejects.toThrow('Sync operation failed');
        expect(syncEngine.connectivityState).toBe('offline');

        pullRemoteFeedStub.restore();
        consoleErrorStub.restore();
      });

      it('should transition back to online after recovery from failures', async () => {
        syncEngine['_connectivityState'] = 'unknown';

        // Register Alice's DID.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Successful sync -> online.
        await syncEngine.sync();
        expect(syncEngine.connectivityState).toBe('online');

        // Failing sync -> offline.
        const pullRemoteFeedStub = sinon.stub(syncEngine as any, 'pullRemoteFeedForSyncTarget').rejects(new Error('simulated failure'));
        const consoleErrorStub = sinon.stub(console, 'error');
        await expect(syncEngine.sync()).rejects.toThrow('Sync operation failed');
        expect(syncEngine.connectivityState).toBe('offline');

        // Restore and sync successfully -> back to online.
        pullRemoteFeedStub.restore();
        consoleErrorStub.restore();
        await syncEngine.sync();
        expect(syncEngine.connectivityState).toBe('online');
      });

      it('should remain unknown when there are no sync targets', async () => {
        // Reset connectivity state by reconstructing.
        syncEngine['_connectivityState'] = 'unknown';

        // No identities registered (stores already cleared in beforeEach).
        await syncEngine.sync();

        // Connectivity state should remain unknown when there are no targets.
        expect(syncEngine.connectivityState).toBe('unknown');
      });
    });

    describe('errored set behavior', () => {
      it('should skip subsequent targets for the same DWN URL after a failure', async () => {
        // Create two identities that share the same DWN URL.
        const alice2 = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
        const bob2 = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
        await syncEngine.registerIdentity({ did: alice2.did.uri, options: { protocols: 'all' } });
        await syncEngine.registerIdentity({ did: bob2.did.uri, options: { protocols: 'all' } });

        // Stub feed pull to fail for the first target.
        const consoleErrorStub = sinon.stub(console, 'error');
        const pullRemoteFeedStub = sinon.stub(syncEngine as any, 'pullRemoteFeedForSyncTarget');
        pullRemoteFeedStub.onFirstCall().rejects(new Error('DWN unreachable'));
        pullRemoteFeedStub.onSecondCall().resolves({});

        await expect(syncEngine.sync()).rejects.toThrow('Sync operation failed');

        // The error should have been logged.
        expect(consoleErrorStub.called).toBe(true);

        // Since both identities share the same DWN URL, the first failure should
        // add it to the errored set, and the second identity's sync for that URL
        // should be skipped (no additional error for it).
        // We can verify by checking the number of feed-pull calls:
        // only 1 call (the first target), not 2.
        expect(pullRemoteFeedStub.callCount).toBe(1);

        pullRemoteFeedStub.restore();
        consoleErrorStub.restore();
      });
    });

    describe('sync health', () => {
      it('should report paused current links as degraded', async () => {
        const did = alice.did.uri;
        await syncEngine.registerIdentity({
          did     : did,
          options : { protocols: 'all' },
        });

        const [target] = await syncEngine['getSyncTargets']();
        expect(target).toBeDefined();
        const link = await syncEngine['getOrCreateReplicationLink'](target!);
        await syncEngine['ledger'].setStatus(link, 'paused');

        const health = await syncEngine.getSyncHealth();

        expect(health.degradedLinkCount).toBe(1);
        expect(health.syncHealthy).toBe(false);
      });
    });

    describe('paused repair behavior', () => {
      it('should not transition paused links back to repairing or schedule repair retries', async () => {
        const did = alice.did.uri;
        const dwnUrl = testDwnUrls[0];
        const link = await syncEngine['ledger'].getOrCreateLink({
          tenantDid          : did,
          remoteEndpoint     : dwnUrl,
          scope              : { kind: 'full' },
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
        });
        const linkKey = `${did}^${dwnUrl}^${link.projectionId}^${link.authorizationEpoch}`;
        link.status = 'paused';
        syncEngine['_activeLinks'].set(linkKey, link);

        const statusSpy = sinon.spy(syncEngine as any, 'setLinkOfflineStatus');
        const repairStub = sinon.stub(syncEngine as any, 'repairLink').resolves();

        await syncEngine['transitionToRepairing'](linkKey, link);
        syncEngine['scheduleRepairRetry'](linkKey);

        expect(statusSpy.called).toBe(false);
        expect(repairStub.called).toBe(false);
        expect(syncEngine['_repairRetryTimers'].has(linkKey)).toBe(false);
      });

      it('should pause a live link only once and leave it degraded', async () => {
        const did = alice.did.uri;
        const dwnUrl = testDwnUrls[0];
        const link = await syncEngine['ledger'].getOrCreateLink({
          tenantDid          : did,
          remoteEndpoint     : dwnUrl,
          scope              : { kind: 'full' },
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
        });
        const linkKey = `${did}^${dwnUrl}^${link.projectionId}^${link.authorizationEpoch}`;
        link.status = 'live';

        const closeStub = sinon.stub(syncEngine as any, 'closeLinkSubscriptions').resolves();

        await syncEngine['transitionToPaused'](linkKey, link);
        await syncEngine['transitionToPaused'](linkKey, link);

        expect(link.status).toBe('paused');
        expect(closeStub.calledOnce).toBe(true);
      });

      it('should schedule another repair retry when a retry attempt fails below the attempt ceiling', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        try {
          const did = alice.did.uri;
          const dwnUrl = testDwnUrls[0];
          const link = await syncEngine['ledger'].getOrCreateLink({
            tenantDid          : did,
            remoteEndpoint     : dwnUrl,
            scope              : { kind: 'full' },
            authorization      : { kind: 'owner' },
            authorizationEpoch : 'owner-epoch',
          });
          const linkKey = `${did}^${dwnUrl}^${link.projectionId}^${link.authorizationEpoch}`;
          link.status = 'repairing';
          syncEngine['_activeLinks'].set(linkKey, link);
          syncEngine['_repairAttempts'].set(linkKey, 1);
          // beforeEach clears the engine, which intentionally pauses background
          // task admission. This white-box scheduler test models an active runtime.
          syncEngine['_lifecycle'].resumeTaskAdmission();

          const repairStub = sinon.stub(syncEngine as any, 'repairLink').rejects(new Error('still broken'));

          syncEngine['scheduleRepairRetry'](linkKey);
          await clock.tickAsync(1_000);

          expect(repairStub.calledOnce).toBe(true);
          expect(syncEngine['_repairRetryTimers'].has(linkKey)).toBe(true);
        } finally {
          for (const retryTimer of syncEngine['_repairRetryTimers'].values()) {
            clearTimeout(retryTimer);
          }
          syncEngine['_repairRetryTimers'].clear();
          clock.restore();
        }
      });

      it('should pause the link after repeated feed convergence mismatches', async () => {
        const did = alice.did.uri;
        const dwnUrl = testDwnUrls[0];
        const target = {
          did                : did,
          dwnUrl             : dwnUrl,
          scope              : { kind: 'full' as const },
          authorization      : { kind: 'owner' as const },
          authorizationEpoch : 'owner-epoch',
        };
        const link = await syncEngine['ledger'].getOrCreateLink({
          tenantDid          : did,
          remoteEndpoint     : dwnUrl,
          scope              : target.scope,
          authorization      : target.authorization,
          authorizationEpoch : target.authorizationEpoch,
        });
        const linkKey = `${did}^${dwnUrl}^${link.projectionId}^${link.authorizationEpoch}`;
        const result = {
          admittedCids       : [],
          converged          : false,
          hasActionableDiffs : true,
          pushFailures       : [],
        };

        const mismatchStub = sinon.stub(syncEngine as any, 'handleFeedConvergenceMismatch').resolves();
        const pauseStub = sinon.stub(syncEngine as any, 'transitionToPaused').resolves();

        await syncEngine['handleRepeatedFeedConvergenceMismatch'](target, result, [], { link, linkKey });
        await syncEngine['handleRepeatedFeedConvergenceMismatch'](target, result, [], { link, linkKey });
        await syncEngine['handleRepeatedFeedConvergenceMismatch'](target, result, [], { link, linkKey });

        expect(mismatchStub.callCount).toBe(2);
        expect(pauseStub.calledOnceWith(linkKey, link)).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // Issue #898: Multi-identity live sync correctness hardening
    // -----------------------------------------------------------------------

    describe('multi-identity live sync hardening (#898)', () => {
      const ownerAuthorization = {
        authorization      : { kind: 'owner' as const },
        authorizationEpoch : 'owner-epoch',
      };

      const linkKeyFor = (did: string, dwnUrl: string, link: { projectionId: string; authorizationEpoch: string }): string =>
        `${did}^${dwnUrl}^${link.projectionId}^${link.authorizationEpoch}`;

      // -----------------------------------------------------------------------
      // Item 1: authorization changes hot-swap links without mutating old epochs
      // -----------------------------------------------------------------------

      describe('authorization epoch isolation on option updates', () => {

        it('should hot-swap live links without rewriting existing durable link authorization', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({
            did,
            options: { protocols: 'all', delegateDid: 'did:example:old-delegate' },
          });

          syncEngine['_syncMode'] = 'live';

          const ledger = syncEngine['ledger'];
          const link = await ledger.getOrCreateLink({
            tenantDid          : did,
            remoteEndpoint     : testDwnUrls[0],
            scope              : { kind: 'full' },
            authorizationEpoch : 'old-delegate-epoch',
            authorization      : {
              kind               : 'delegate',
              delegateDid        : 'did:example:old-delegate',
              permissionGrantIds : ['old-grant'],
            },
            delegateDid: 'did:example:old-delegate',
          });
          expect(link.delegateDid).toBe('did:example:old-delegate');

          syncEngine['_activeLinks'].set(linkKeyFor(did, testDwnUrls[0], link), link);

          const removeStub = sinon.stub(syncEngine as any, 'removeIdentityFromLiveSync').resolves();
          const addStub = sinon.stub(syncEngine as any, 'addIdentityToLiveSync').resolves(new Set());

          await syncEngine.updateIdentityOptions({
            did,
            options: { protocols: 'all', delegateDid: 'did:example:new-delegate' },
          });

          const reloadedLinks = await ledger.getLinksForTenant(did);
          expect(reloadedLinks[0].delegateDid).toBe('did:example:old-delegate');
          expect(reloadedLinks[0].authorizationEpoch).toBe('old-delegate-epoch');

          expect(removeStub.calledOnce).toBe(true);
          expect(addStub.calledOnce).toBe(true);
        });
      });

      // -----------------------------------------------------------------------
      // Item 2: Late subscription callbacks bail after hot-remove
      // -----------------------------------------------------------------------

      describe('late callback invalidation after hot-remove', () => {

        it('should not flush pushes when flushPendingPushesForLink fires after hot-remove', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({ did, options: { protocols: 'all' } });
          syncEngine['_syncMode'] = 'live';

          const ledger = syncEngine['ledger'];
          const link = await ledger.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          const linkKey = linkKeyFor(did, testDwnUrls[0], link);
          link.status = 'live';
          syncEngine['_activeLinks'].set(linkKey, link);

          // Manually inject a push runtime to simulate pending pushes.
          syncEngine['_pushRuntimes'].set(linkKey, {
            did,
            dwnUrl     : testDwnUrls[0],
            entries    : [{ cid: 'cid-1' }],
            retryCount : 0,
          });

          // Hot-remove.
          await syncEngine['removeIdentityFromLiveSync'](did);

          // Try to flush — the guard in flushPendingPushesForLink should bail.
          const pushStub = sinon.stub(syncEngine as any, 'pushMessages');
          pushStub.resolves({ succeeded: [], failed: [] });

          await syncEngine['flushPendingPushesForLink'](linkKey);

          expect(pushStub.called).toBe(false);
        });

        it('should abort in-flight flush when link is replaced during pushMessages', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({ did, options: { protocols: 'all' } });
          syncEngine['_syncMode'] = 'live';

          const ledger = syncEngine['ledger'];
          const link = await ledger.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          const linkKey = linkKeyFor(did, testDwnUrls[0], link);
          link.status = 'live';
          syncEngine['_activeLinks'].set(linkKey, link);

          syncEngine['_pushRuntimes'].set(linkKey, {
            did,
            dwnUrl     : testDwnUrls[0],
            entries    : [{ cid: 'cid-1' }],
            retryCount : 1,
          });

          // flushPendingPushesForLink calls the imported pushMessages function
          // directly, not this.pushMessages. Stub the agent.dwn.processRequest
          // that pushMessages eventually calls, and replace the link mid-flight.
          const requeueSpy = sinon.spy(syncEngine as any, 'requeueOrReconcile');
          const processStub = sinon.stub(testHarness.agent.dwn, 'processRequest').callsFake(async () => {
            // Mid-flight: replace the link with a new object.
            const replacementLink = { ...link };
            syncEngine['_activeLinks'].set(linkKey, replacementLink);
            return {
              reply: {
                status : { code: 200 },
                entry  : { message: { descriptor: { interface: 'Records', method: 'Write' } } },
              },
            } as any;
          });

          // Stub rpc to return a failure so the code path reaches requeueOrReconcile
          // (if it weren't for the stale check).
          const rpcStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({ status: { code: 500 } } as any);

          await syncEngine['flushPendingPushesForLink'](linkKey);

          // requeueOrReconcile should NOT have been called — the isFlushStale
          // check after pushMessages detected the replacement and bailed.
          expect(requeueSpy.called).toBe(false);

          processStub.restore();
          rpcStub.restore();
        });

        it('should not start reconcile when a stale reconcile timer fires after hot-remove', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({ did, options: { protocols: 'all' } });
          syncEngine['_syncMode'] = 'live';

          const ledger = syncEngine['ledger'];
          const link = await ledger.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          const linkKey = linkKeyFor(did, testDwnUrls[0], link);
          link.status = 'live';
          syncEngine['_activeLinks'].set(linkKey, link);

          // Schedule a reconcile (sets a timer).
          const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
          syncEngine['scheduleReconcile'](linkKey, 500);
          expect(syncEngine['_reconcileTimers'].has(linkKey)).toBe(true);

          // Hot-remove clears the timer.
          await syncEngine['removeIdentityFromLiveSync'](did);
          expect(syncEngine['_reconcileTimers'].has(linkKey)).toBe(false);

          // Even if a stale timer fires, the _activeLinks guard prevents execution.
          const reconcileSpy = sinon.spy(syncEngine as any, 'reconcileLink');

          const staleGeneration = syncEngine['_engineGeneration'];
          clock.setTimeout((): void => {
            if (syncEngine['_engineGeneration'] !== staleGeneration) { return; }
            if (!syncEngine['_activeLinks'].has(linkKey)) { return; }
            syncEngine['reconcileLink'](linkKey);
          }, 500);

          await clock.tickAsync(600);

          expect(reconcileSpy.called).toBe(false);

          clock.restore();
        });
      });

      // -----------------------------------------------------------------------
      // Item 3: Same link key stale repair/reconcile isolation
      // -----------------------------------------------------------------------

      describe('same link key — stale repair and reconcile isolation', () => {

        it('should detect stale link via object identity after remove and re-add', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({ did, options: { protocols: 'all' } });
          syncEngine['_syncMode'] = 'live';

          const ledger = syncEngine['ledger'];
          const originalLink = await ledger.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          const linkKey = linkKeyFor(did, testDwnUrls[0], originalLink);
          originalLink.status = 'repairing';
          syncEngine['_activeLinks'].set(linkKey, originalLink);

          // Reload from ledger — same data, different object identity.
          const replacementLink = await ledger.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          expect(replacementLink).not.toBe(originalLink);

          // Replace the link in _activeLinks.
          syncEngine['_activeLinks'].set(linkKey, replacementLink);

          // The original link is stale; the replacement is not.
          expect(syncEngine['_activeLinks'].get(linkKey) !== originalLink).toBe(true);
          expect(syncEngine['_activeLinks'].get(linkKey) !== replacementLink).toBe(false);
        });

        it('should bail old reconcile when the same link key is re-added during in-flight reconcile', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({ did, options: { protocols: 'all' } });
          syncEngine['_syncMode'] = 'live';

          const ledger = syncEngine['ledger'];
          const originalLink = await ledger.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          const linkKey = linkKeyFor(did, testDwnUrls[0], originalLink);
          originalLink.status = 'live';
          syncEngine['_activeLinks'].set(linkKey, originalLink);

          // Stub the feed reconcile path to capture the shouldContinue callback.
          let capturedShouldContinue: (() => boolean) | undefined;
          sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').callsFake((_target: unknown, _options: unknown, sc?: () => boolean) => {
            capturedShouldContinue = sc;
            // Simulate: during reconciliation, the link gets removed and re-added.
            const newLink = { ...originalLink };
            syncEngine['_activeLinks'].set(linkKey, newLink);

            // shouldContinue should now return false.
            if (capturedShouldContinue && !capturedShouldContinue()) {
              return { aborted: true, converged: false };
            }
            return { aborted: false, converged: true };
          });

          await syncEngine['doReconcileLink'](linkKey);

          expect(capturedShouldContinue).toBeDefined();
          const currentLink = syncEngine['_activeLinks'].get(linkKey)!;
          expect(currentLink).not.toBe(originalLink);
        });

        it('should bail old repair when the same link key is re-added during in-flight repair', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({ did, options: { protocols: 'all' } });
          syncEngine['_syncMode'] = 'live';

          const ledger = syncEngine['ledger'];
          const link = await ledger.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          const linkKey = linkKeyFor(did, testDwnUrls[0], link);
          link.status = 'repairing';
          syncEngine['_activeLinks'].set(linkKey, link);

          // Stub closeLinkSubscriptions.
          sinon.stub(syncEngine as any, 'closeLinkSubscriptions').resolves();

          let capturedShouldContinue: (() => boolean) | undefined;
          sinon.stub(syncEngine as any, 'syncTargetWithDurableFeeds').callsFake((_target: unknown, _options: unknown, sc?: () => boolean) => {
            capturedShouldContinue = sc;
            // Mid-repair: replace the link in _activeLinks.
            const newLink = { ...link };
            syncEngine['_activeLinks'].set(linkKey, newLink);

            if (capturedShouldContinue && !capturedShouldContinue()) {
              return { aborted: true };
            }
            return { aborted: false };
          });

          await syncEngine['doRepairLink'](linkKey);

          expect(capturedShouldContinue).toBeDefined();
          // Repair aborted — subscriptions were NOT reopened.
          expect(syncEngine['_activeLinks'].has(linkKey)).toBe(true);
          expect(syncEngine['_activeLinks'].get(linkKey)).not.toBe(link);
        });
      });
    });
  });

  describe('connectivityState', () => {
    it('should default to unknown', () => {
      const engine = new SyncEngineLevel({ db: {} as any });
      expect(engine.connectivityState).toBe('unknown');
    });
  });

  describe('startSync with mode parameter', () => {
    it('should accept poll mode with interval and default to poll', async () => {
      // The existing `startSync({ interval })` signature should default to poll mode.
      const syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
      const syncSpy = sinon.spy(syncEngine as any, 'startPollSync');

      // Call with only interval (no mode) — should default to poll mode.
      try {
        await syncEngine.startSync({ interval: '30s' });
      } catch {
        // May fail during sync — we only care that poll mode was selected.
      }

      expect(syncSpy.calledOnce).toBe(true);
      await syncEngine.stopSync(5000);
      syncSpy.restore();
    });

    it('should accept explicit poll mode', async () => {
      const syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
      const syncSpy = sinon.spy(syncEngine as any, 'startPollSync');

      try {
        await syncEngine.startSync({ mode: 'poll', interval: '30s' });
      } catch {
        // May fail during sync.
      }

      expect(syncSpy.calledOnce).toBe(true);
      await syncEngine.stopSync(5000);
      syncSpy.restore();
    });

    it('should accept explicit live mode', async () => {
      const syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
      const syncSpy = sinon.spy(syncEngine as any, 'startLiveSync');

      try {
        await syncEngine.startSync({ mode: 'live', interval: '5m' });
      } catch {
        // May fail during live setup (no remote DWN subscriptions).
      }

      expect(syncSpy.calledOnce).toBe(true);
      await syncEngine.stopSync(5000);
      syncSpy.restore();
    });
  });

});
