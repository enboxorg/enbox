import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { ReplicationLinkState } from '../src/types/sync.js';
import type { SyncDurableFeedReconcileResult } from '../src/sync-durable-feed-reconciler.js';
import type { SyncIdentityOptions } from '../src/index.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { AbstractLevel } from 'abstract-level';
import { Convert } from '@enbox/common';
import { CryptoUtils } from '@enbox/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnConstant, DwnInterfaceName, DwnMethodName, Jws, Message, Time } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { SyncRuntime } from '../src/sync-runtime.js';
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

  describe('durable subscription wakes', () => {
    it('holds a pull wake until the paired replication baseline is ready', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const dwnUrl = 'https://dwn.example';
      const linkKey = 'link-key';
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
        controller : undefined as any,
        did        : link.tenantDid,
        dwnUrl,
        eventScope : {},
        isStale    : (): boolean => false,
        link,
        linkKey,
      };
      const controller = internal.activateLink(linkKey, link);
      context.controller = controller;
      internal._replicationLinkStore = {
        setStatus: sinon.stub().callsFake(async (state: ReplicationLinkState, status: string): Promise<void> => {
          state.status = status as ReplicationLinkState['status'];
        }),
      };
      sinon.stub(internal, 'getNextQuotaProbeAtForTarget').resolves(undefined);
      const pull = sinon.stub(internal._linkRecoveryCoordinator, 'pull').resolves();

      await internal.handleLivePullMessage(context, {
        cursor : { epoch: 'event-epoch', position: '99', streamId: 'event-stream' },
        event  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
        type   : 'event',
      });

      expect(controller.isPassRequested('pull')).toBe(true);
      expect(pull.notCalled).toBe(true);
      expect(link.pull.contiguousAppliedToken).toBeUndefined();

      await internal.markLinkLive({ did: link.tenantDid, dwnUrl, scope: link.scope }, controller, controller.replicationGeneration);
      await Promise.resolve();

      expect(pull.calledOnceWithExactly(controller)).toBe(true);
    });

    it('clears pulled and pushed echo state when live sync stops', async () => {
      const syncEngine = new SyncEngineLevel({ agent: {} as any, db: {} as any });
      const internal = syncEngine as any;
      const tenantDid = 'did:example:alice';
      const messageCid = 'bafy-message';
      const remoteEndpoint = 'https://dwn.example';
      internal._echoSuppressor.trackPulled(tenantDid, messageCid, remoteEndpoint);
      internal._echoSuppressor.trackPushed(tenantDid, messageCid, remoteEndpoint);

      await internal.stopLiveSync();

      expect(internal._echoSuppressor.hasRecentlyPulled(tenantDid, messageCid, remoteEndpoint)).toBe(false);
      expect(internal._echoSuppressor.hasRecentlyPushed(tenantDid, messageCid, remoteEndpoint)).toBe(false);
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
      const prune = sinon.stub().callsFake(async (_targets: unknown[], isCurrent: () => boolean): Promise<void> => {
        resolveIteratorStarted();
        await iteratorGate;
        if (isCurrent()) {
          throw new Error('stale target resolution was pruned');
        }
      });
      sinon.stub(internal._quotaManager, 'pruneStaleLinkBlocks').callsFake(prune);

      const resolution = internal.getSyncTargets();
      await iteratorStarted;
      internal._targetPlanner.invalidate();
      resumeIterator();
      await resolution;

      expect(prune.calledOnce).toBe(true);
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

        internal._runtime.dispose();
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

      sinon.stub(internal, 'hasDeadLetter').resolves(false);
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
      const transition = sinon.stub(internal, 'applyPushResult');

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
      const transition = sinon.stub(internal, 'applyPushResult');

      const result = internal.bootstrapRemotePermissionGrants(grantTarget, (): boolean => current, true);
      await pushStarted;
      current = false;
      releasePush();

      expect(await result).toEqual({ kind: 'aborted' });
      expect(transition.called).toBe(false);
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
      const transition = sinon.stub(syncEngine as any, 'applyPushResult').resolves({
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
      it('coalesces a sync() issued while another is already running', async () => {
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

        const first = syncEngine.sync();

        await clock.tickAsync(50);

        // A sync issued mid-run queues a coalesced follow-up instead of
        // throwing; it resolves once the follow-up completes.
        getSyncTargetsStub.returns(Promise.resolve([]));
        const queued = syncEngine.sync();

        await clock.tickAsync(50);
        await first;
        await queued;

        // The lock is free again — a fresh sync runs immediately.
        await syncEngine.sync();

        clock.restore();
      });

      it('delegates the requested run while holding the sync lock', async () => {
        const run = sinon.stub(syncEngine['_runCoordinator'], 'run').callsFake(async (): Promise<void> => {
          expect(syncEngine['_lifecycle'].isSyncInProgress).toBe(true);
        });

        await syncEngine.sync('pull', { verifyConvergence: true });

        expect(run.calledOnceWithExactly('pull', { verifyConvergence: true })).toBe(true);
        expect(syncEngine['_lifecycle'].isSyncInProgress).toBe(false);
      });
    });

    describe('drainTo()', () => {
      it('throws an error if a drain is currently already running', async () => {
        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const drainStub = sinon.stub((syncEngine as any)._drainCoordinator, 'drain');
        drainStub.returns(new Promise<any>((resolve) => {
          clock.setTimeout(() => {
            resolve({
              endpoint        : 'https://dwn.example',
              completed       : false,
              cancelled       : false,
              topologyChanged : false,
              targets         : [],
            });
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

        drainStub.restore();
        clock.restore();
      });

      it('rejects invalid drain endpoints', async () => {
        await expect(syncEngine.drainTo('not a url')).rejects.toThrow('SyncEngineLevel: drain endpoint must be a valid URL.');
        await expect(syncEngine.drainTo('ftp://dwn.example')).rejects.toThrow('SyncEngineLevel: drain endpoint must use http or https.');
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

      it('normalizes the endpoint and delegates the drain while holding the sync lock', async () => {
        const controller = new AbortController();
        const expected = {
          endpoint        : 'https://dwn.example/path',
          completed       : false,
          cancelled       : false,
          topologyChanged : false,
          targets         : [],
        };
        const drainStub = sinon.stub((syncEngine as any)._drainCoordinator, 'drain').callsFake(async (): Promise<any> => {
          expect((syncEngine as any)._lifecycle.isSyncInProgress).toBe(true);
          return expected;
        });

        const result = await syncEngine.drainTo(
          'https://dwn.example/path?token=secret#fragment',
          { signal: controller.signal },
        );

        expect(result).toBe(expected);
        expect(drainStub.calledOnceWithExactly(
          'https://dwn.example/path',
          { signal: controller.signal },
        )).toBe(true);
        expect((syncEngine as any)._lifecycle.isSyncInProgress).toBe(false);
      });

      it('returns a pre-aborted result without invoking the coordinator', async () => {
        const controller = new AbortController();
        controller.abort();
        const drainStub = sinon.stub((syncEngine as any)._drainCoordinator, 'drain');

        const result = await syncEngine.drainTo('https://dwn.example/path?token=secret', {
          signal: controller.signal,
        });

        expect(result).toEqual({
          endpoint        : 'https://dwn.example/path',
          completed       : false,
          cancelled       : true,
          topologyChanged : false,
          targets         : [],
          error           : 'drain aborted',
        });
        expect(drainStub.notCalled).toBe(true);
      });

      it('prepares only missing live links for a durable handoff', async () => {
        const target = {
          did                : alice.did.uri,
          dwnUrl             : 'https://dwn.example',
          scope              : { kind: 'full' },
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          projectionId       : 'projection-id',
        };
        const getLink = sinon.stub(syncEngine as any, 'getOrCreateReplicationLink').resolves({});
        sinon.stub(syncEngine as any, 'getReplicationLinkKey').returns('link-key');
        const initialize = sinon.stub(syncEngine as any, 'initializeLinkTargetWithRetry').resolves();

        syncEngine['_runtime'] = new SyncRuntime();
        await (syncEngine as any).prepareDrainLiveTarget(target);
        expect(getLink.notCalled).toBe(true);

        syncEngine['_runtime'] = new SyncRuntime(true);
        await (syncEngine as any).prepareDrainLiveTarget(target);
        expect(initialize.calledOnceWithExactly(target)).toBe(true);

        syncEngine['_linkControllers'].set('link-key', {} as any);
        await (syncEngine as any).prepareDrainLiveTarget(target);
        syncEngine['_linkControllers'].delete('link-key');
        expect(initialize.calledOnce).toBe(true);
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
      it('runs the durable feed settle check at each interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Live link initialization is not under test — resolve no targets.
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').resolves();

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        await testHarness.agent.sync.startSync({ interval: '1s' });

        await clock.tickAsync(2_800); // just under 3 intervals
        const settleCalls = settleStub.callCount;
        await testHarness.agent.sync.stopSync();
        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        // Startup establishes its baseline through link initialization; the
        // periodic coordinator runs once at each elapsed interval.
        expect(settleCalls).toBe(2);
      });

      it('arms the settle check and resolves startSync when startup target discovery fails', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const initStub = sinon.stub(SyncEngineLevel.prototype as any, 'initializeLinkTarget');
        initStub.resolves({ status: 'active', durableLinkIdentityKey: 'key' });
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').resolves();

        // DID endpoint discovery is transiently unavailable at startup: the
        // settle timer is still armed (in the finally after planning fails)
        // and startSync must resolve — planning is best-effort and the
        // settle pass is the recovery path.
        const recoveredTarget = { did: alice.did.uri } as never;
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.onFirstCall().rejects(new Error('endpoint discovery unavailable'));
        getSyncTargetsStub.resolves([recoveredTarget]);

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        await testHarness.agent.sync.startSync({ interval: '1s' });

        const settleCallsAfterStart = settleStub.callCount;
        const initCallsAfterStart = initStub.callCount;
        await clock.tickAsync(1_000);
        const settleCallsAfterInterval = settleStub.callCount;
        await testHarness.agent.sync.stopSync();
        settleStub.restore();
        initStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        // Startup planning failed before a baseline could run, and the
        // periodic settle coordinator still fired afterwards.
        expect(settleCallsAfterStart).toBe(0);
        expect(settleCallsAfterInterval).toBe(1);

        // Startup planning failed before reaching link initialization; the
        // settle pass re-initialized the orphaned target.
        expect(initCallsAfterStart).toBe(0);
        expect(initStub.calledOnce).toBe(true);
        expect(initStub.firstCall.args[0]).toBe(recoveredTarget);
      });

      it('does not start a settle pass while startup initialization is still open', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').resolves();
        let releaseInit!: () => void;
        const initGate = new Promise<void>((resolve) => { releaseInit = resolve; });
        const initStub = sinon.stub(SyncEngineLevel.prototype as any, 'initializeLinkTarget');
        initStub.callsFake(async () => {
          await initGate;
          return { status: 'active', durableLinkIdentityKey: 'key' };
        });
        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([{} as never]);

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // Subscription opening outlives several intervals (a 15s cadence is
        // shorter than the WebSocket response timeout): no settle pass may
        // start a second reconciliation wave while startup is in flight.
        const starting = testHarness.agent.sync.startSync({ interval: '1s' });
        await clock.tickAsync(2_400);
        const settleCallsDuringInitialization = settleStub.callCount;

        releaseInit();
        await starting;
        await clock.tickAsync(1_000);
        const settleCallsAfterInitialization = settleStub.callCount;
        await testHarness.agent.sync.stopSync();
        settleStub.restore();
        initStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        // The settle check begins only after initialization finished.
        expect(settleCallsDuringInitialization).toBe(0);
        expect(settleCallsAfterInitialization).toBe(1);
      });

      it('skips settle checks while sync work is already in progress', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        let resolveSettle!: () => void;
        const settle = new Promise<void>((resolve) => {
          resolveSettle = resolve;
        });

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').returns(settle);

        const startPromise = testHarness.agent.sync.startSync({ interval: '1s' });

        await clock.tickAsync(0);
        await startPromise;

        await clock.tickAsync(1_000); // the first settle check starts and stays pending
        const callsAfterFirstInterval = settleStub.callCount;

        await clock.tickAsync(2_000); // further intervals fire while it holds the lock
        const callsWhileBusy = settleStub.callCount;

        resolveSettle();
        await clock.tickAsync(0);
        const callsAfterCompletion = settleStub.callCount;
        await testHarness.agent.sync.stopSync();
        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        expect(callsAfterFirstInterval).toBe(1);
        expect(callsWhileBusy).toBe(1);
        // Completing the settle check does not retroactively run skipped intervals.
        expect(callsAfterCompletion).toBe(1);
      });

      it('should replace the settle-check interval when startSync is called again', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').resolves();

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        await testHarness.agent.sync.startSync({ interval: '2s' });

        const callsAfterFirstStart = settleStub.callCount;

        await clock.tickAsync(4_001); // two settle intervals
        const callsAtFirstCadence = settleStub.callCount;

        await testHarness.agent.sync.startSync({ interval: '1s' });
        const callsAfterRestart = settleStub.callCount;

        await clock.tickAsync(2_001); // two intervals at the new cadence
        const callsAtReplacementCadence = settleStub.callCount;

        // only the 1s timer remains: one more tick, not a stale 2s one
        await clock.tickAsync(1_000);
        const callsAfterFinalInterval = settleStub.callCount;

        await testHarness.agent.sync.stopSync();
        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        expect(callsAfterFirstStart).toBe(0);
        expect(callsAtFirstCadence).toBe(2);
        expect(callsAfterRestart).toBe(2);
        expect(callsAtReplacementCadence).toBe(4);
        expect(callsAfterFinalInterval).toBe(5);
      });

      it('should log settle check errors, but continue at the next interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle');
        settleStub.resolves();
        settleStub.onSecondCall().rejects(new Error('Sync error'));

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);

        // spy on console.error to check if the error message is logged
        const consoleErrorSpy = sinon.stub(console, 'error').resolves();

        await testHarness.agent.sync.startSync({ interval: '1s' });

        // three intervals
        await clock.tickAsync(3_201);
        const settleCalls = settleStub.callCount;
        const errorCalls = consoleErrorSpy.callCount;
        const errorMessage = consoleErrorSpy.args[0]?.[0];

        await testHarness.agent.sync.stopSync();
        settleStub.restore();
        getSyncTargetsStub.restore();
        consoleErrorSpy.restore();
        clock.restore();

        expect(settleCalls).toBe(3);
        expect(errorCalls).toBe(1);
        expect(errorMessage).toContain('SyncEngineLevel: Error during durable feed settle check');
      });

      it('returns the owned link from re-initialization without reopening subscriptions', async () => {
        const link = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          connectivity       : 'online',
          projectionId       : 'projection-id',
          pull               : {},
          push               : {},
          remoteEndpoint     : 'https://dwn.example.com',
          scope              : { kind: 'full' },
          status             : 'live',
          tenantDid          : alice.did.uri,
        } as any;

        syncEngine['_runtime'] = new SyncRuntime(true);
        const controller = (syncEngine as any).activateLink('owned-link-key', link);
        expect(controller.isActive).toBe(true);

        sinon.stub(syncEngine as any, 'getOrCreateReplicationLink').resolves({ ...link });
        sinon.stub(syncEngine as any, 'getReplicationLinkKey').returns('owned-link-key');
        const openSubscriptions = sinon.stub(syncEngine as any, 'openLinkSubscriptions');

        const result = await (syncEngine as any).initializeLinkTarget({
          did    : alice.did.uri,
          dwnUrl : 'https://dwn.example.com',
        });

        // An ACTIVE controller means live/repair/pause ownership already
        // exists: the settle-pass re-init returns its current state instead
        // of clobbering the owned link.
        expect(result.status).toBe('active');
        expect(openSubscriptions.notCalled).toBe(true);
        expect((syncEngine as any).getLinkController('owned-link-key')).toBe(controller);

        (syncEngine as any).removeLinkController('owned-link-key', controller);
      });

      it('clamps a sub-second settle-check interval to the one-second floor', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').resolves();

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        // '0s' parses to 0ms, which would tick every macrotask — the engine
        // clamps the settle-check cadence to the one-second floor instead.
        await testHarness.agent.sync.startSync({ interval: '0s' });

        await clock.tickAsync(999);
        const callsBeforeFloor = settleStub.callCount;

        await clock.tickAsync(1);
        const callsAtFloor = settleStub.callCount;
        await testHarness.agent.sync.stopSync();
        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        expect(callsBeforeFloor).toBe(0);
        expect(callsAtFloor).toBe(1);
      });
    });

    describe('stopSync()', () => {
      it('stops the sync interval', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').resolves();

        await testHarness.agent.sync.startSync({ interval: '1s' });

        await clock.tickAsync(2_100); // two settle intervals
        const callsBeforeStop = settleStub.callCount;

        await testHarness.agent.sync.stopSync();

        await clock.tickAsync(2_000); // 2 intervals
        const callsAfterStop = settleStub.callCount;

        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        expect(callsBeforeStop).toBe(2);
        expect(callsAfterStop).toBe(2);
      });

      it('waits for the current sync to complete before stopping', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        let releaseSettle!: () => void;
        const settle = new Promise<void>((resolve) => { releaseSettle = resolve; });
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').returns(settle);

        await testHarness.agent.sync.startSync({ interval: '1s' });
        await clock.tickAsync(1_000);

        let stopped = false;
        const stopPromise = testHarness.agent.sync.stopSync().then((): void => { stopped = true; });
        await clock.tickAsync(1);
        const stoppedWhileSettlePending = stopped;

        releaseSettle();
        await clock.tickAsync(0);
        await stopPromise;
        const callsAtStop = settleStub.callCount;

        // wait for future intervals
        await clock.tickAsync(2_000);
        const callsAfterStop = settleStub.callCount;

        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        expect(stoppedWhileSettlePending).toBe(false);
        expect(callsAtStop).toBe(1);
        expect(callsAfterStop).toBe(1);
      });

      it('throws if ongoing sync does not complete within 2 seconds', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        let releaseSettle!: () => void;
        const settle = new Promise<void>((resolve) => { releaseSettle = resolve; });
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').returns(settle);

        await testHarness.agent.sync.startSync({ interval: '1s' });
        await clock.tickAsync(1_000);
        const stopPromise = testHarness.agent.sync.stopSync();
        let stopError: unknown;
        const observedStop = stopPromise.catch((error: unknown): void => { stopError = error; });
        await clock.tickAsync(2_000);
        await observedStop;

        releaseSettle();
        await clock.tickAsync(0);
        await testHarness.agent.sync.stopSync(3_000);

        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        expect((stopError as Error).message).toBe(
          'SyncEngineLevel: Existing sync operation did not complete within 2000 milliseconds.'
        );
      });

      it('only waits for the ongoing sync for the given timeout before failing', async () => {
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

        const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
        getSyncTargetsStub.resolves([]);
        let releaseSettle!: () => void;
        const settle = new Promise<void>((resolve) => { releaseSettle = resolve; });
        const settleStub = sinon.stub((testHarness.agent.sync as any)._runCoordinator, 'settle').returns(settle);

        await testHarness.agent.sync.startSync({ interval: '1s' });
        await clock.tickAsync(1_000);
        const stopPromise = testHarness.agent.sync.stopSync(10);
        let stopError: unknown;
        const observedStop = stopPromise.catch((error: unknown): void => { stopError = error; });
        await clock.tickAsync(10);
        await observedStop;

        releaseSettle();
        await clock.tickAsync(0);
        await testHarness.agent.sync.stopSync(3_000);

        settleStub.restore();
        getSyncTargetsStub.restore();
        clock.restore();

        expect((stopError as Error).message).toBe(
          'SyncEngineLevel: Existing sync operation did not complete within 10 milliseconds.'
        );
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
        syncEngine['_connectivityManager'].setState('unknown');
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
        syncEngine['_connectivityManager'].setState('unknown');

        // Register Alice's DID.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // First sync to get to online state.
        await syncEngine.sync();
        expect(syncEngine.connectivityState).toBe('online');

        // Now stub feed pull to throw, simulating a failure.
        const pullRemoteFeedStub = sinon.stub(syncEngine['_durableFeedReconciler'], 'pull').rejects(new Error('simulated failure'));

        // Suppress console.error for the expected error.
        const consoleErrorStub = sinon.stub(console, 'error');

        await expect(syncEngine.sync()).rejects.toThrow('Sync operation failed');
        expect(syncEngine.connectivityState).toBe('offline');

        pullRemoteFeedStub.restore();
        consoleErrorStub.restore();
      });

      it('should transition back to online after recovery from failures', async () => {
        syncEngine['_connectivityManager'].setState('unknown');

        // Register Alice's DID.
        await testHarness.agent.sync.registerIdentity({
          did     : alice.did.uri,
          options : { protocols: 'all' },
        });

        // Successful sync -> online.
        await syncEngine.sync();
        expect(syncEngine.connectivityState).toBe('online');

        // Failing sync -> offline.
        const pullRemoteFeedStub = sinon.stub(syncEngine['_durableFeedReconciler'], 'pull').rejects(new Error('simulated failure'));
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
        syncEngine['_connectivityManager'].setState('unknown');

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
        const pullRemoteFeedStub = sinon.stub(syncEngine['_durableFeedReconciler'], 'pull');
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
        await syncEngine['replicationLinkStore'].setStatus(link, 'paused');

        const health = await syncEngine.getSyncHealth();

        expect(health.degradedLinkCount).toBe(1);
        expect(health.syncHealthy).toBe(false);
      });
    });

    describe('feed convergence wiring', () => {
      const feedDivergence = (
        localFingerprint = 'local-fingerprint',
        remoteFingerprint = 'remote-fingerprint',
      ): SyncDurableFeedReconcileResult => ({
        converged          : false,
        hasActionableDiffs : true,
        localFingerprint,
        pushFailures       : [],
        remoteFingerprint,
      });

      const createConvergenceTarget = async (did: string): Promise<{
        link: ReplicationLinkState;
        linkKey: string;
        target: SyncTarget;
      }> => {
        const dwnUrl = testDwnUrls[0];
        const link = await syncEngine['replicationLinkStore'].getOrCreateLink({
          tenantDid          : did,
          remoteEndpoint     : dwnUrl,
          scope              : { kind: 'full' },
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
        });
        const linkKey = `${did}^${dwnUrl}^${link.projectionId}^${link.authorizationEpoch}`;
        const target: SyncTarget = {
          authorization      : { kind: 'owner' },
          authorizationEpoch : 'owner-epoch',
          did,
          dwnUrl,
          projectionId       : link.projectionId,
          scope              : { kind: 'full' },
        };
        return { link, linkKey, target };
      };

      it('should schedule the next quota probe on the live link when verified divergence is quota-explained', async () => {
        const { link, linkKey, target } = await createConvergenceTarget(alice.did.uri);
        link.status = 'live';
        syncEngine['activateLink'](linkKey, link);

        sinon.stub(syncEngine as any, 'isFeedDivergenceExplainedByQuotaBlocks').resolves(true);
        sinon.stub(syncEngine as any, 'getNextQuotaProbeAtForTarget').resolves('2026-01-01T00:01:00.000Z');
        const probeStub = sinon.stub(syncEngine as any, 'scheduleQuotaProbeForActiveLink');

        const explained = await syncEngine['_feedConvergenceManager'].handleVerifiedDivergence(target, feedDivergence());

        expect(explained).toBe(true);
        expect(probeStub.calledOnceWithExactly(linkKey, link, '2026-01-01T00:01:00.000Z')).toBe(true);
      });

      it('should reset durable checkpoints and reconcile the live link until identical mismatches pause it', async () => {
        const { link, linkKey, target } = await createConvergenceTarget(alice.did.uri);
        link.status = 'live';
        link.pull.contiguousAppliedToken = { epoch: 'epoch-1', messageCid: 'bafy-checkpoint', position: '5', streamId: 'pull-stream' };
        await syncEngine['replicationLinkStore'].persistCheckpoint(link, 'pull');
        syncEngine['activateLink'](linkKey, link);

        sinon.stub(syncEngine as any, 'isFeedDivergenceExplainedByQuotaBlocks').resolves(false);
        const reconcileStub = sinon.stub(syncEngine as any, 'scheduleLinkReconcileByKey');
        const pauseStub = sinon.stub(syncEngine as any, 'transitionToPaused').resolves();
        await syncEngine['_deadLetterStore'].put({
          errorDetail    : 'admission failed',
          failedAt       : '2026-01-01T00:00:00.000Z',
          messageCid     : 'bafy-admit-failed',
          remoteEndpoint : target.dwnUrl,
          tenantDid      : target.did,
        });

        await syncEngine['_feedConvergenceManager'].handleVerifiedDivergence(target, feedDivergence());
        await syncEngine['_feedConvergenceManager'].handleVerifiedDivergence(target, feedDivergence());

        const persisted = await createConvergenceTarget(alice.did.uri);
        expect(link.pull.contiguousAppliedToken).toBeUndefined();
        expect(persisted.link.pull.contiguousAppliedToken).toBeUndefined();
        expect(reconcileStub.calledTwice).toBe(true);
        expect(reconcileStub.alwaysCalledWithExactly(linkKey, link, 'feed-fingerprint-mismatch', 0)).toBe(true);
        expect(pauseStub.notCalled).toBe(true);

        // A new admission dead letter for this remote changes the failure
        // signature, so the attempt count restarts instead of pausing.
        await syncEngine['_deadLetterStore'].put({
          errorDetail    : 'admission failed',
          failedAt       : '2026-01-01T00:02:00.000Z',
          messageCid     : 'bafy-admit-failed-2',
          remoteEndpoint : target.dwnUrl,
          tenantDid      : target.did,
        });
        await syncEngine['_feedConvergenceManager'].handleVerifiedDivergence(target, feedDivergence());
        await syncEngine['_feedConvergenceManager'].handleVerifiedDivergence(target, feedDivergence());
        expect(pauseStub.notCalled).toBe(true);

        await syncEngine['_feedConvergenceManager'].handleVerifiedDivergence(target, feedDivergence());
        expect(pauseStub.calledOnceWithExactly(linkKey, link)).toBe(true);
        expect(reconcileStub.callCount).toBe(4);
      });

      it('should scope cleared mismatch state to the removed identity through engine link keys', async () => {
        const aliceContext = await createConvergenceTarget(alice.did.uri);
        const bobContext = await createConvergenceTarget('did:example:bob');
        const manager = syncEngine['_feedConvergenceManager'];

        sinon.stub(syncEngine as any, 'isFeedDivergenceExplainedByQuotaBlocks').resolves(false);
        const pauseStub = sinon.stub(syncEngine as any, 'transitionToPaused').resolves();

        await manager.handleVerifiedDivergence(aliceContext.target, feedDivergence());
        await manager.handleVerifiedDivergence(aliceContext.target, feedDivergence());
        await manager.handleVerifiedDivergence(bobContext.target, feedDivergence());
        await manager.handleVerifiedDivergence(bobContext.target, feedDivergence());

        syncEngine['discardIdentityLinkState'](alice.did.uri);

        // Alice's attempt count restarted after identity removal; Bob's did not.
        await manager.handleVerifiedDivergence(aliceContext.target, feedDivergence());
        expect(pauseStub.notCalled).toBe(true);

        await manager.handleVerifiedDivergence(bobContext.target, feedDivergence());
        expect(pauseStub.calledOnce).toBe(true);
        expect(pauseStub.firstCall.args[0]).toBe(bobContext.linkKey);

        manager.clearLink(bobContext.linkKey);
        await manager.handleVerifiedDivergence(bobContext.target, feedDivergence());
        expect(pauseStub.calledOnce).toBe(true);
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

          syncEngine['_runtime'] = new SyncRuntime(true);

          const replicationLinkStore = syncEngine['replicationLinkStore'];
          const link = await replicationLinkStore.getOrCreateLink({
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

          syncEngine['activateLink'](linkKeyFor(did, testDwnUrls[0], link), link);

          const removeStub = sinon.stub(syncEngine as any, 'removeIdentityFromLiveSync').resolves();
          const addStub = sinon.stub(syncEngine as any, 'addIdentityToLiveSync').resolves(new Set());

          await syncEngine.updateIdentityOptions({
            did,
            options: { protocols: 'all', delegateDid: 'did:example:new-delegate' },
          });

          const reloadedLinks = await replicationLinkStore.getLinksForTenant(did);
          expect(reloadedLinks[0].delegateDid).toBe('did:example:old-delegate');
          expect(reloadedLinks[0].authorizationEpoch).toBe('old-delegate-epoch');

          expect(removeStub.calledOnce).toBe(true);
          expect(addStub.calledOnce).toBe(true);
        });
      });

      // -----------------------------------------------------------------------
      // Item 2: Same link key stale repair/reconcile isolation
      // -----------------------------------------------------------------------

      describe('same link key — stale repair and reconcile isolation', () => {

        it('should detect stale link via object identity after remove and re-add', async () => {
          const did = alice.did.uri;

          await syncEngine.registerIdentity({ did, options: { protocols: 'all' } });
          syncEngine['_runtime'] = new SyncRuntime(true);

          const replicationLinkStore = syncEngine['replicationLinkStore'];
          const originalLink = await replicationLinkStore.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          const linkKey = linkKeyFor(did, testDwnUrls[0], originalLink);
          originalLink.status = 'repairing';
          const originalController = syncEngine['activateLink'](linkKey, originalLink);

          // Reload from the replication-link store — same data, different object identity.
          const replacementLink = await replicationLinkStore.getOrCreateLink({
            tenantDid      : did,
            remoteEndpoint : testDwnUrls[0],
            scope          : { kind: 'full' },
            ...ownerAuthorization,
          });
          expect(replacementLink).not.toBe(originalLink);

          const replacementController = syncEngine['activateLink'](linkKey, replacementLink);

          expect(originalController.isActive).toBe(false);
          expect(replacementController.isActive).toBe(true);
          expect(syncEngine['getActiveLink'](linkKey)).toBe(replacementLink);
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

  describe('startSync parameters', () => {
    it('should start the live runtime', async () => {
      const syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
      const syncSpy = sinon.spy(syncEngine as any, 'startLiveSync');

      try {
        await syncEngine.startSync({ interval: '5m' });
      } catch {
        // May fail during live setup (no remote DWN subscriptions).
      }

      expect(syncSpy.calledOnce).toBe(true);
      await syncEngine.stopSync(5000);
      syncSpy.restore();
    });

    it('should default the settle-check interval when none is given', async () => {
      const syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
      const syncSpy = sinon.spy(syncEngine as any, 'startLiveSync');

      try {
        await syncEngine.startSync();
      } catch {
        // May fail during live setup (no remote DWN subscriptions).
      }

      expect(syncSpy.calledOnceWithExactly(300_000)).toBe(true);
      await syncEngine.stopSync(5000);
      syncSpy.restore();
    });

    it('should reject an invalid interval before starting any runtime', async () => {
      const syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
      const liveSpy = sinon.spy(syncEngine as any, 'startLiveSync');

      await expect(syncEngine.startSync({ interval: 'not-a-duration' })).rejects.toThrow(
        `Invalid duration: 'not-a-duration'`
      );

      expect(liveSpy.notCalled).toBe(true);
      expect(syncEngine.hasActiveSubscriptions).toBe(false);
      liveSpy.restore();
    });

    it('should leave a running runtime untouched when a reconfiguration passes an invalid interval', async () => {
      const syncEngine = new SyncEngineLevel({ db: testHarness.syncStore, agent: testHarness.agent });
      const getSyncTargetsStub = sinon.stub(SyncEngineLevel.prototype as any, 'getSyncTargets');
      getSyncTargetsStub.resolves([]);
      const settleStub = sinon.stub((syncEngine as any)._runCoordinator, 'settle').resolves();
      const clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });

      await syncEngine.startSync({ interval: '1s' });

      const callsAfterStart = settleStub.callCount;

      let startError: unknown;
      try {
        await syncEngine.startSync({ interval: 'not-a-duration' });
      } catch (error: unknown) {
        startError = error;
      }

      // the running runtime's settle-check timer persists and keeps firing
      await clock.tickAsync(2_800); // just under 3 intervals
      const callsAfterIntervals = settleStub.callCount;

      await syncEngine.stopSync(5000);
      clock.restore();
      settleStub.restore();
      getSyncTargetsStub.restore();

      expect((startError as Error).message).toBe(`Invalid duration: 'not-a-duration'`);
      expect(callsAfterStart).toBe(0);
      expect(callsAfterIntervals).toBe(2);
    });
  });

});
