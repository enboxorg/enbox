import type { SyncEvent } from '../src/types/sync.js';
import type { Dwn, GenericMessage, ProtocolDefinition, RecordsWriteMessage, ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { DwnReplicationApplyRequest, DwnRpcRequest, DwnRpcResponse } from '@enbox/dwn-clients';

import sinon from 'sinon';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '@enbox/dwn-sdk-js/stores/level';
import {
  DataStream,
  DurableEventLog,
  EventEmitterWakePublisher,
  Message,
  RecordsDelete,
  RecordsRead,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';

import { AgentDwnApi } from '../src/dwn-api.js';
import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { pushMessages, queryLocalMessageFeed, queryRemoteMessageFeed } from '../src/sync-messages.js';

const remoteEndpoint = 'http://localhost:9999/dwn';
const secondaryRemoteEndpoint = 'http://localhost:9998/dwn';

const notesProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://sync-feed-convergence.example/notes',
  types     : {
    note: {
      schema      : 'https://sync-feed-convergence.example/schemas/note',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    note: {},
  },
};

const feedHarnessProtocolV1: ProtocolDefinition = {
  published : true,
  protocol  : 'https://sync-feed-convergence.example/harness',
  types     : {
    note: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-note',
      dataFormats : ['text/plain'],
    },
    reply: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-reply',
      dataFormats : ['text/plain'],
    },
    thread: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-thread',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    note   : {},
    thread : {
      reply: {},
    },
  },
};

const feedHarnessProtocolV2: ProtocolDefinition = {
  ...feedHarnessProtocolV1,
  types: {
    ...feedHarnessProtocolV1.types,
    bookmark: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-bookmark',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    ...feedHarnessProtocolV1.structure,
    bookmark: {},
  },
};

type RemoteDwnStores = {
  dataStore: DataStoreLevel;
  dwn: Dwn;
  eventLog: DurableEventLog;
  messageStore: MessageStoreLevel;
  resumableTaskStore: ResumableTaskStoreLevel;
};

type RemoteApplyGate = {
  allow(): void;
  attempts(): number;
  rejectTerminally(): void;
};

type DataAwareRemoteApplyGate = {
  dataBearingAttempts(): number;
  datalessAttempts(): number;
};

type RoutedRemoteApplyGate = {
  allow(): void;
  primaryAttempts(): number;
  secondaryAttempts(): number;
};

describe('SyncEngineLevel durable feed convergence', () => {
  let remoteStores: RemoteDwnStores;
  let syncEngine: SyncEngineLevel;
  let tenantDid: string;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/sync-feed-convergence/local',
    });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const identity = await testHarness.createIdentity({
      name        : 'Feed Convergence Alice',
      testDwnUrls : [remoteEndpoint],
    });
    tenantDid = identity.did.uri;

    syncEngine = testHarness.agent.sync as SyncEngineLevel;
    remoteStores = await createRemoteDwnStores('__TESTDATA__/sync-feed-convergence/remote', testHarness);
    testHarness.agent.rpc = createLocalDwnRpc(remoteStores.dwn);
  });

  beforeEach(async () => {
    sinon.restore();
    await syncEngine.clear();
    await testHarness.clearDwnStores();
    await clearRemoteDwnStores(remoteStores);
    testHarness.agent.rpc = createLocalDwnRpc(remoteStores.dwn);
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness?.clearStorage();
    await testHarness?.closeStorage();
    await closeRemoteDwnStores(remoteStores);
  });

  it('pulls remote feed entries through real MessagesQuery and applyReplicatedMessage', async () => {
    const remoteConfig = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: notesProtocol },
    });
    expect(remoteConfig.reply.status.code).toBe(202);

    const remoteText = 'remote feed pull body';
    const remoteWrite = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([remoteText]),
    });
    expect(remoteWrite.reply.status.code).toBe(202);
    const recordId = remoteWrite.message!.recordId;

    await expectLocalRecordCount(recordId, 0);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [notesProtocol.protocol] } });

    await syncEngine.sync('pull');

    expect(await readLocalRecordText(recordId)).toBe(remoteText);
    expect(await localFingerprint()).toBe(await remoteFingerprint());
  });

  it('pushes local feed entries through real MessagesQuery and remote replicated apply', async () => {
    const localConfig = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: notesProtocol },
    });
    expect(localConfig.reply.status.code).toBe(202);

    const localText = 'local feed push body';
    const localWrite = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([localText]),
    });
    expect(localWrite.reply.status.code).toBe(202);
    const recordId = localWrite.message!.recordId;

    await expectRemoteRecordCount(recordId, 0);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [notesProtocol.protocol] } });

    await syncEngine.sync('push');

    expect(await readRemoteRecordText(recordId)).toBe(localText);
    expect(await remoteFingerprint()).toBe(await localFingerprint());
  });

  it('executes real local queries when an update push must discover its protocol and initial-write dependencies', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const initial = await writeLocalRecord({
      data         : 'initial local value',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const update = await updateLocalRecord(initial.message, 'updated local value');
    const updateCid = await Message.getCid(update.message);

    const result = await pushMessages({
      did         : tenantDid,
      dwnUrl      : remoteEndpoint,
      messageCids : [updateCid],
      agent       : testHarness.agent,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.succeeded).toEqual([updateCid]);
    expect(await readRemoteRecordText(initial.message.recordId)).toBe('updated local value');
  });

  it('advances past one quota-blocked record without pausing and retryRemoteNow re-probes only that record', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'record rejected while remote quota is exhausted',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync(undefined, { verifyConvergence: true });

    expect(gate.attempts()).toBe(1);
    expect(await expectQuotaBlockedStatus()).toMatchObject({
      quotaBlockedMessageCount : 1,
      state                    : 'quota-blocked',
    });

    // The feed head remains intentionally divergent, but the durable quota
    // omission explains it. Repeated exact verification must neither hot-loop
    // the blocked CID nor trip the normal three-strike pause path.
    for (let cycle = 0; cycle < 4; cycle++) {
      await syncEngine.sync(undefined, { verifyConvergence: true });
    }
    expect(gate.attempts()).toBe(1);
    expect((await syncEngine.getSyncHealth()).degradedLinkCount).toBe(0);

    // A later unrelated entry must progress through the same per-link feed
    // checkpoint even though the older record remains omitted remotely.
    const laterWrite = await writeLocalRecord({
      data         : 'smaller unrelated record still progresses',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    await syncEngine.sync(undefined, { verifyConvergence: true });

    expect(await readRemoteRecordText(laterWrite.message.recordId)).toBe('smaller unrelated record still progresses');
    expect(gate.attempts()).toBe(1);
    expect((await syncEngine.getSyncHealth()).degradedLinkCount).toBe(0);

    // Simulate newly purchased quota. The public retry API must perform a
    // targeted RPC despite the feed checkpoint having advanced past the CID.
    // Concurrent UI/poll callers share that same in-engine probe.
    gate.allow();
    await Promise.all([
      syncEngine.retryRemoteNow(tenantDid, remoteEndpoint),
      syncEngine.retryRemoteNow(tenantDid, remoteEndpoint),
    ]);

    expect(gate.attempts()).toBe(2);
    expect(await readRemoteRecordText(blockedWrite.message.recordId)).toBe('record rejected while remote quota is exhausted');
    expect(await remoteHarnessFingerprint()).toBe(await harnessFingerprint());
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status.quotaBlockedMessageCount).toBe(0);
    expect(status.state).toBe('healthy');
  });

  it('does not clear a data quota block from an ancestry-only remote CID', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'current data must not be confused with remote ancestry metadata',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');
    expect(gate.attempts()).toBe(1);

    const ancestry = await remoteStores.dwn.applyReplicatedMessage(tenantDid, blockedWrite.message);
    expect(ancestry).toEqual(expect.objectContaining({ kind: 'Applied', ancestryOnly: true }));
    await expectRemoteRecordCount(blockedWrite.message.recordId, 0);
    expect(await remoteHarnessFingerprint()).toBe(await harnessFingerprint());

    // Pull admission sees this exact CID as Duplicate because the local DWN
    // already has the full write. That still proves only that the signed
    // message exists remotely, not that its payload does, so the durable block
    // must remain active.
    await syncEngine.sync('pull');

    expect(gate.attempts()).toBe(1);
    expect(await expectQuotaBlockedStatus()).toMatchObject({
      quotaBlockedMessageCount : 1,
      state                    : 'quota-blocked',
    });

    // Inventory equality likewise proves only CID presence. The remote copy is
    // still non-latest and has no payload, so push verification must not clear
    // the block or report the link healthy.
    await syncEngine.sync('push', { verifyConvergence: true });

    expect(gate.attempts()).toBe(1);
    expect(await expectQuotaBlockedStatus()).toMatchObject({
      quotaBlockedMessageCount : 1,
      state                    : 'quota-blocked',
    });
  });

  it('supersedes an active quota block when pull admits a newer state for the same record', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'local state rejected while the remote is over quota',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');

    expect(gate.attempts()).toBe(1);
    expect((await expectQuotaBlockedStatus()).quotaBlockedMessageCount).toBe(1);

    // The remote retains the blocked write as ancestry-only metadata, then
    // independently accepts a newer data-bearing state for that record.
    const ancestry = await remoteStores.dwn.applyReplicatedMessage(tenantDid, blockedWrite.message);
    expect(ancestry).toEqual(expect.objectContaining({ kind: 'Applied', ancestryOnly: true }));
    await updateRemoteRecord(blockedWrite.message, 'newer state accepted at the remote');

    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => { events.push(event); });
    try {
      await syncEngine.sync('pull');
    } finally {
      unsubscribe();
    }

    expect(await readLocalRecordText(blockedWrite.message.recordId)).toBe('newer state accepted at the remote');
    expect(gate.attempts()).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type           : 'push:quota-cleared',
      messageCid     : blockedCid,
      remoteEndpoint : remoteEndpoint,
      resolution     : 'superseded',
    }));
    expect(await expectQuotaBlockedStatus()).toMatchObject({
      quotaBlockedMessageCount : 0,
      state                    : 'healthy',
    });
  });

  it('keeps a reachable quota-blocked drain online and completes after an explicit retry', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'drain target is reachable but over quota',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    const blockedDrain = await syncEngine.drainTo(remoteEndpoint);

    expect(blockedDrain.completed).toBe(false);
    expect(blockedDrain.targets).toHaveLength(1);
    expect(blockedDrain.targets[0]).toMatchObject({
      completed    : false,
      converged    : false,
      quotaBlocked : true,
    });
    expect(blockedDrain.targets[0].pushCheckpoint).toBeDefined();
    expect(syncEngine.connectivityState).toBe('online');
    expect((await syncEngine.getSyncHealth()).degradedLinkCount).toBe(0);
    expect(gate.attempts()).toBe(1);

    gate.allow();
    const recoveredDrain = await syncEngine.drainTo(remoteEndpoint);

    expect(recoveredDrain.completed).toBe(true);
    expect(recoveredDrain.targets[0].quotaBlocked).toBeUndefined();
    expect(syncEngine.connectivityState).toBe('online');
    expect(await readRemoteRecordText(blockedWrite.message.recordId)).toBe('drain target is reachable but over quota');
  });

  it('recovers a blocked initial write when an ordinary delete replays its retained dependency without data', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'initial data that exceeds the simulated remote quota'.repeat(32),
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installDataAwareRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');

    expect(gate.dataBearingAttempts()).toBe(1);
    expect(gate.datalessAttempts()).toBe(0);
    expect((await expectQuotaBlockedStatus()).quotaBlockedMessageCount).toBe(1);
    await expectRemoteRecordCount(blockedWrite.message.recordId, 0);

    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => { events.push(event); });
    try {
      await deleteLocalRecord(blockedWrite.message.recordId);
      await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);
    } finally {
      unsubscribe();
    }

    expect(gate.dataBearingAttempts()).toBe(1);
    expect(gate.datalessAttempts()).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type           : 'push:quota-cleared',
      messageCid     : blockedCid,
      remoteEndpoint : remoteEndpoint,
      resolution     : 'applied',
    }));
    await expectRemoteRecordCount(blockedWrite.message.recordId, 0);
    expect(await remoteHarnessFingerprint()).toBe(await harnessFingerprint());
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status.quotaBlockedMessageCount).toBe(0);
  });

  it('recovers a tombstone after quota advanced the feed cursor past both it and its initial ancestry', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'initial data rejected in both full and ancestry-only form',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');
    expect(gate.attempts()).toBe(1);

    await deleteLocalRecord(blockedWrite.message.recordId);
    await syncEngine.sync('push', { verifyConvergence: true });

    // The delete itself becomes a second durable omission when the remote also
    // rejects its dataless initial dependency. Both feed entries are now behind
    // the checkpoint, and an ordinary cycle must not hot-loop either one.
    expect(gate.attempts()).toBe(2);
    expect((await expectQuotaBlockedStatus()).quotaBlockedMessageCount).toBe(2);
    await syncEngine.sync('push', { verifyConvergence: true });
    expect(gate.attempts()).toBe(2);

    gate.allow();
    await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);

    // The direct initial probe is suppressed because its positive-size payload
    // is no longer materialized. Retrying the later tombstone fetches that
    // retained ancestry as a dependency and closes both omissions.
    expect(gate.attempts()).toBe(3);
    await expectRemoteRecordCount(blockedWrite.message.recordId, 0);
    expect(await remoteHarnessFingerprint()).toBe(await harnessFingerprint());
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status.quotaBlockedMessageCount).toBe(0);
  });

  it('recovers a blocked-then-deleted record through the cidsOnly diff push path after a checkpoint reset', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'initial data rejected while over quota, then deleted before recovery',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');
    expect(gate.attempts()).toBe(1);
    expect((await expectQuotaBlockedStatus()).quotaBlockedMessageCount).toBe(1);

    // Delete the blocked record so its initial write is retained locally as
    // dataless ancestry, then clear the push checkpoint to simulate a
    // 410/history-compaction progress-gap reset. The next push must re-enumerate
    // through the cidsOnly diff path (message-less feed entries) rather than the
    // incremental, message-bearing path exercised by the other recovery tests.
    await deleteLocalRecord(blockedWrite.message.recordId);
    const internal = syncEngine as unknown as {
      getSyncTargets(): Promise<any[]>;
      getOrCreateReplicationLink(target: any): Promise<any>;
      ledger: { persistCheckpoint(link: any, direction: 'push'): Promise<void> };
    };
    const [target] = await internal.getSyncTargets();
    const link = await internal.getOrCreateReplicationLink(target);
    link.push.contiguousAppliedToken = undefined;
    link.push.receivedToken = undefined;
    await internal.ledger.persistCheckpoint(link, 'push');

    // Quota is now available. Even though the diff enumeration omits the message,
    // the tombstone must still stage its retained dataless initial ancestor so
    // both entries apply together and the record converges — otherwise the page
    // halts on the tombstone's unresolvable missing-initial dependency and every
    // newer record behind it is head-of-line blocked forever.
    gate.allow();
    await syncEngine.sync('push', { verifyConvergence: true });

    await expectRemoteRecordCount(blockedWrite.message.recordId, 0);
    expect(await remoteHarnessFingerprint()).toBe(await harnessFingerprint());
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status).toMatchObject({ quotaBlockedMessageCount: 0, state: 'healthy' });
  });

  it('uses a blocked dependency CID to recover a tombstone when only the update root was persisted', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const initial = await writeLocalRecord({
      data         : 'initial payload later superseded by an update',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const initialCid = await Message.getCid(initial.message);
    const update = await updateLocalRecord(initial.message, 'updated payload');
    const updateCid = await Message.getCid(update.message);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    const internal = syncEngine as unknown as {
      getSyncTargets(): Promise<any[]>;
      getOrCreateReplicationLink(target: any): Promise<any>;
      getQuotaBlocksForTarget(target: any): Promise<Array<{ messageCid: string }>>;
      getQuotaStatesForTarget(target: any): Promise<Array<{ messageCid: string; state: { supersededAt?: string } }>>;
      ledger: { persistCheckpoint(link: any, direction: 'push'): Promise<void> };
      recordQuotaBlock(
        target: any,
        messageCid: string,
        protocol: string,
        detail: string,
        source: 'feed',
        blockedCid: string,
      ): Promise<unknown>;
    };
    const [target] = await internal.getSyncTargets();
    const localHead = await queryLocalMessageFeed({
      did      : tenantDid,
      filters  : [{ protocol: feedHarnessProtocolV1.protocol }],
      cidsOnly : true,
      limit    : 100,
      agent    : testHarness.agent,
    });
    expect(localHead.cursor).toBeDefined();
    const link = await internal.getOrCreateReplicationLink(target);
    link.push.receivedToken = localHead.cursor;
    link.push.contiguousAppliedToken = localHead.cursor;
    await internal.ledger.persistCheckpoint(link, 'push');
    await internal.recordQuotaBlock(
      target,
      updateCid,
      feedHarnessProtocolV1.protocol,
      'update was blocked because its initial dependency exceeded quota',
      'feed',
      initialCid,
    );

    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => { events.push(event); });
    try {
      await deleteLocalRecord(initial.message.recordId);
      await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);
    } finally {
      unsubscribe();
    }

    await expectRemoteRecordCount(initial.message.recordId, 0);
    const [localFeed, remoteFeed] = await Promise.all([
      queryLocalMessageFeed({
        did      : tenantDid,
        filters  : [{ protocol: feedHarnessProtocolV1.protocol }],
        cidsOnly : true,
        limit    : 100,
        agent    : testHarness.agent,
      }),
      queryRemoteMessageFeed({
        did      : tenantDid,
        dwnUrl   : remoteEndpoint,
        filters  : [{ protocol: feedHarnessProtocolV1.protocol }],
        cidsOnly : true,
        limit    : 100,
        agent    : testHarness.agent,
      }),
    ]);
    const localCids = new Set((localFeed.entries ?? []).map((entry) => entry.messageCid));
    const remoteCids = new Set((remoteFeed.entries ?? []).map((entry) => entry.messageCid));
    expect([...localCids].filter((cid) => !remoteCids.has(cid))).toEqual([updateCid]);
    expect([...remoteCids].filter((cid) => !localCids.has(cid))).toEqual([]);
    expect(remoteCids.has(initialCid)).toBe(true);
    expect(await remoteHarnessFingerprint()).not.toBe(await harnessFingerprint());
    expect(events).toContainEqual(expect.objectContaining({
      type           : 'push:quota-cleared',
      messageCid     : updateCid,
      remoteEndpoint : remoteEndpoint,
      resolution     : 'superseded',
    }));
    expect(await internal.getQuotaBlocksForTarget(target)).toHaveLength(0);
    expect(await internal.getQuotaStatesForTarget(target)).toEqual([
      expect.objectContaining({
        messageCid : updateCid,
        state      : expect.objectContaining({ supersededAt: expect.any(String) }),
      }),
    ]);
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status).toMatchObject({ quotaBlockedMessageCount: 0, state: 'healthy' });

    // The resolved omission remains durable enough to explain exact inventory
    // mismatch, but it is never probed or allowed to degrade/pause the link.
    const apply = sinon.spy(testHarness.agent.rpc, 'applyReplicatedMessage');
    for (let cycle = 0; cycle < 4; cycle++) {
      await syncEngine.sync('push', { verifyConvergence: true });
    }
    await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);
    const drain = await syncEngine.drainTo(remoteEndpoint);

    expect(apply.callCount).toBe(0);
    expect(drain).toMatchObject({
      completed : true,
      targets   : [expect.objectContaining({ completed: true, converged: true })],
    });
    expect((await syncEngine.getSyncHealth())).toMatchObject({
      degradedLinkCount        : 0,
      quotaBlockedMessageCount : 0,
      syncHealthy              : true,
    });
  });

  it('recovers a blocked initial write when a smaller update replays its retained dependency without data', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'initial data that exceeds the simulated remote quota'.repeat(32),
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installDataAwareRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');

    expect(gate.dataBearingAttempts()).toBe(1);
    expect(gate.datalessAttempts()).toBe(0);
    expect((await expectQuotaBlockedStatus()).quotaBlockedMessageCount).toBe(1);

    const smallerData = 'small replacement';
    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => { events.push(event); });
    try {
      await updateLocalRecord(blockedWrite.message, smallerData);
      await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);
    } finally {
      unsubscribe();
    }

    expect(gate.dataBearingAttempts()).toBe(1);
    expect(gate.datalessAttempts()).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type           : 'push:quota-cleared',
      messageCid     : blockedCid,
      remoteEndpoint : remoteEndpoint,
      resolution     : 'applied',
    }));
    expect(await readRemoteRecordText(blockedWrite.message.recordId)).toBe(smallerData);
    expect(await remoteHarnessFingerprint()).toBe(await harnessFingerprint());
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status.quotaBlockedMessageCount).toBe(0);
  });

  it('isolates quota state and manual retries to one remote while another remote advances', async () => {
    const secondaryStores = await createRemoteDwnStores(
      '__TESTDATA__/sync-feed-convergence/secondary',
      testHarness,
    );
    await clearRemoteDwnStores(secondaryStores);

    try {
      await configureLocalProtocol(feedHarnessProtocolV1);
      const blockedWrite = await writeLocalRecord({
        data         : 'record blocked only by the primary remote',
        protocolPath : 'note',
        schema       : feedHarnessProtocolV1.types.note.schema,
      });
      const blockedCid = await Message.getCid(blockedWrite.message);
      const gate = installRoutedRemoteApplyGate(blockedCid, secondaryStores.dwn);

      await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
      const drain = await syncEngine.drainTo(secondaryRemoteEndpoint);
      expect(drain.completed).toBe(true);
      expect(gate.primaryAttempts()).toBe(0);
      expect(await readRecordTextFromDwn(secondaryStores.dwn, blockedWrite.message.recordId))
        .toBe('record blocked only by the primary remote');

      await syncEngine.sync('push');

      expect(gate.primaryAttempts()).toBe(1);
      expect(await remoteHarnessFingerprint(secondaryRemoteEndpoint)).toBe(await harnessFingerprint());
      expect(await remoteHarnessFingerprint(remoteEndpoint)).not.toBe(await harnessFingerprint());
      const statuses = await syncEngine.getRemoteSyncStatus(tenantDid);
      expect(statuses.find((status) => status.remoteEndpoint === remoteEndpoint)).toMatchObject({
        quotaBlockedMessageCount : 1,
        state                    : 'quota-blocked',
      });
      expect(statuses.find((status) => status.remoteEndpoint === secondaryRemoteEndpoint)).toMatchObject({
        quotaBlockedMessageCount : 0,
        state                    : 'healthy',
      });

      const laterWrite = await writeLocalRecord({
        data         : 'later record reaches both remotes',
        protocolPath : 'note',
        schema       : feedHarnessProtocolV1.types.note.schema,
      });
      await syncEngine.sync('push');

      expect(await readRemoteRecordText(laterWrite.message.recordId)).toBe('later record reaches both remotes');
      expect(await readRecordTextFromDwn(secondaryStores.dwn, laterWrite.message.recordId)).toBe('later record reaches both remotes');
      expect(gate.primaryAttempts()).toBe(1);

      const secondaryAttemptsBeforeRetry = gate.secondaryAttempts();
      gate.allow();
      await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);

      expect(gate.primaryAttempts()).toBe(2);
      expect(gate.secondaryAttempts()).toBe(secondaryAttemptsBeforeRetry);
      expect(await readRemoteRecordText(blockedWrite.message.recordId)).toBe('record blocked only by the primary remote');
    } finally {
      testHarness.agent.rpc = createLocalDwnRpc(remoteStores.dwn);
      await closeRemoteDwnStores(secondaryStores);
    }
  });

  it('clears a quota block as superseded when local storage has definitively retired the blocked root', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'record retired before remote quota recovers',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');
    expect(gate.attempts()).toBe(1);
    expect((await expectQuotaBlockedStatus()).quotaBlockedMessageCount).toBe(1);

    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on((event) => { events.push(event); });
    try {
      // RecordsDelete intentionally retains the initial-write dependency, so
      // it is not a definitive retirement signal. Model storage compaction
      // explicitly by removing the exact CID and prove MessagesRead can no
      // longer fetch it before exercising the public retry path.
      expect(await testHarness.dwnMessageStore.get(tenantDid, blockedCid)).toBeDefined();
      await testHarness.dwnMessageStore.delete(tenantDid, blockedCid);
      expect(await testHarness.dwnMessageStore.get(tenantDid, blockedCid)).toBeUndefined();
      await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);
    } finally {
      unsubscribe();
    }

    // The retry resolves from a definitive local MessagesRead miss, so no
    // second remote RPC is made and the durable omission is retired explicitly.
    expect(gate.attempts()).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type           : 'push:quota-cleared',
      messageCid     : blockedCid,
      remoteEndpoint : remoteEndpoint,
      resolution     : 'superseded',
    }));
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status.quotaBlockedMessageCount).toBe(0);
    expect(await syncEngine.getFailedMessages(tenantDid)).toHaveLength(0);
  });

  it('retires a quota block when its targeted retry becomes terminal', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    const blockedWrite = await writeLocalRecord({
      data         : 'record whose retry becomes terminal',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const blockedCid = await Message.getCid(blockedWrite.message);
    const gate = installRemoteApplyGate(blockedCid);

    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');
    expect(gate.attempts()).toBe(1);
    expect((await expectQuotaBlockedStatus()).quotaBlockedMessageCount).toBe(1);

    const consoleError = sinon.stub(console, 'error');
    gate.rejectTerminally();
    await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);

    expect(gate.attempts()).toBe(2);
    expect(consoleError.calledOnce).toBe(true);
    const failed = await syncEngine.getFailedMessages(tenantDid);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      messageCid     : blockedCid,
      remoteEndpoint : remoteEndpoint,
      errorCode      : 'Invalid',
    });
    const [status] = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(status).toMatchObject({
      failedMessageCount       : 1,
      quotaBlockedMessageCount : 0,
      state                    : 'degraded',
    });

    // With the block retired, Retry now is a no-op instead of repeatedly
    // sending a message that has already been classified as terminal.
    await syncEngine.retryRemoteNow(tenantDid, remoteEndpoint);
    expect(gate.attempts()).toBe(2);
  });

  it('converges updates, deletes, prune cascades, config churn, and data bytes after a resumed feed cycle', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');

    const noteToUpdate = await writeLocalRecord({
      data         : 'note before remote update',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const noteToDelete = await writeLocalRecord({
      data         : 'note before local delete',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const thread = await writeLocalRecord({
      data         : 'thread before prune',
      protocolPath : 'thread',
      schema       : feedHarnessProtocolV1.types.thread.schema,
    });
    const reply = await writeLocalRecord({
      data            : 'reply before prune',
      parentContextId : thread.message!.contextId,
      protocolPath    : 'thread/reply',
      schema          : feedHarnessProtocolV1.types.reply.schema,
    });

    await syncEngine.sync();
    await expectRecordSnapshotsEqual([
      { data: 'note before remote update', protocolPath: 'note', recordId: noteToUpdate.message!.recordId },
      { data: 'note before local delete', protocolPath: 'note', recordId: noteToDelete.message!.recordId },
      { data: 'thread before prune', protocolPath: 'thread', recordId: thread.message!.recordId },
      { data: 'reply before prune', protocolPath: 'thread/reply', recordId: reply.message!.recordId },
    ]);

    await updateRemoteRecord(noteToUpdate.message!, 'note after remote update');
    await deleteRemoteRecord(thread.message!.recordId, true);
    await deleteLocalRecord(noteToDelete.message!.recordId);
    await configureLocalProtocol(feedHarnessProtocolV2);
    const bookmark = await writeLocalRecord({
      data         : 'bookmark after config churn',
      protocolPath : 'bookmark',
      schema       : feedHarnessProtocolV2.types.bookmark.schema,
    });

    await syncEngine.sync('pull');
    expect(await readLocalRecordText(noteToUpdate.message!.recordId)).toBe('note after remote update');
    await expectLocalRecordCount(thread.message!.recordId, 0);
    await expectLocalRecordCount(reply.message!.recordId, 0);

    const restartedSyncEngine = new SyncEngineLevel({
      agent : testHarness.agent,
      db    : testHarness.syncStore,
    });
    await restartedSyncEngine.sync('push');
    await restartedSyncEngine.sync();

    await expectRecordSnapshotsEqual([
      { data: 'bookmark after config churn', protocolPath: 'bookmark', recordId: bookmark.message!.recordId },
      { data: 'note after remote update', protocolPath: 'note', recordId: noteToUpdate.message!.recordId },
    ]);
    expect(await harnessFingerprint()).toBe(await remoteHarnessFingerprint());
    expect(await syncEngine.getFailedMessages(tenantDid)).toHaveLength(0);
  });

  async function expectLocalRecordCount(recordId: string, count: number): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entries ?? []).toHaveLength(count);
  }

  async function expectRemoteRecordCount(recordId: string, count: number): Promise<void> {
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entries ?? []).toHaveLength(count);
  }

  async function readLocalRecordText(recordId: string): Promise<string> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    return textFromDataStream(reply.entry!.data!);
  }

  async function readRemoteRecordText(recordId: string): Promise<string> {
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    return textFromDataStream(reply.entry!.data!);
  }

  async function readRecordTextFromDwn(dwn: Dwn, recordId: string): Promise<string> {
    const recordsRead = await RecordsRead.create({
      filter : { recordId },
      signer : await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await dwn.processMessage(tenantDid, recordsRead.message);
    expect(reply.status.code).toBe(200);
    return textFromDataStream(reply.entry!.data!);
  }

  async function configureLocalProtocol(definition: ProtocolDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });
    expect(reply.status.code).toBe(202);
  }

  function installRemoteApplyGate(messageCid: string): RemoteApplyGate {
    const rpc = createLocalDwnRpc(remoteStores.dwn);
    const applyReplicatedMessage = rpc.applyReplicatedMessage.bind(rpc);
    let attempts = 0;
    let mode: 'allow' | 'quota' | 'terminal' = 'quota';

    rpc.applyReplicatedMessage = async (request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> => {
      const requestCid = await Message.getCid(request.message as GenericMessage);
      if (requestCid === messageCid) {
        attempts++;
        if (mode === 'quota') {
          throw new DwnRpcError(
            JsonRpcErrorCodes.InvalidRequest,
            'TenantStorageQuotaExceeded: tenant would exceed storage limit of 1 byte',
            { code: 'TenantStorageQuotaExceeded' },
          );
        }
        if (mode === 'terminal') {
          throw new DwnRpcError(JsonRpcErrorCodes.InvalidParams, 'selected replicated message is invalid');
        }
      }

      return applyReplicatedMessage(request);
    };
    testHarness.agent.rpc = rpc;

    return {
      allow            : (): void => { mode = 'allow'; },
      attempts         : (): number => attempts,
      rejectTerminally : (): void => { mode = 'terminal'; },
    };
  }

  function installDataAwareRemoteApplyGate(messageCid: string): DataAwareRemoteApplyGate {
    const rpc = createLocalDwnRpc(remoteStores.dwn);
    const applyReplicatedMessage = rpc.applyReplicatedMessage.bind(rpc);
    let dataBearingAttempts = 0;
    let datalessAttempts = 0;

    rpc.applyReplicatedMessage = async (request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> => {
      const requestCid = await Message.getCid(request.message as GenericMessage);
      if (requestCid === messageCid) {
        if (request.data !== undefined) {
          dataBearingAttempts++;
          throw new DwnRpcError(
            JsonRpcErrorCodes.InvalidRequest,
            'TenantStorageQuotaExceeded: initial write data exceeds remote capacity',
            { code: 'TenantStorageQuotaExceeded' },
          );
        }
        datalessAttempts++;
        return applyReplicatedMessage(request);
      }

      return applyReplicatedMessage(request);
    };
    testHarness.agent.rpc = rpc;

    return {
      dataBearingAttempts : (): number => dataBearingAttempts,
      datalessAttempts    : (): number => datalessAttempts,
    };
  }

  function installRoutedRemoteApplyGate(messageCid: string, secondaryDwn: Dwn): RoutedRemoteApplyGate {
    const primaryRpc = createLocalDwnRpc(remoteStores.dwn);
    const secondaryRpc = createLocalDwnRpc(secondaryDwn);
    const applyPrimary = primaryRpc.applyReplicatedMessage.bind(primaryRpc);
    const sendPrimary = primaryRpc.sendDwnRequest.bind(primaryRpc);
    let mode: 'allow' | 'quota' = 'quota';
    let primaryAttempts = 0;
    let secondaryAttempts = 0;

    primaryRpc.sendDwnRequest = async (request: DwnRpcRequest): Promise<DwnRpcResponse> => {
      return request.dwnUrl === secondaryRemoteEndpoint
        ? secondaryRpc.sendDwnRequest(request)
        : sendPrimary(request);
    };
    primaryRpc.applyReplicatedMessage = async (
      request: DwnReplicationApplyRequest,
    ): Promise<ReplicationApplyResult> => {
      if (request.dwnUrl === secondaryRemoteEndpoint) {
        secondaryAttempts++;
        return secondaryRpc.applyReplicatedMessage(request);
      }

      const requestCid = await Message.getCid(request.message as GenericMessage);
      if (requestCid === messageCid) {
        primaryAttempts++;
        if (mode === 'quota') {
          throw new DwnRpcError(
            JsonRpcErrorCodes.InvalidRequest,
            'TenantStorageQuotaExceeded: primary remote has no capacity',
            { code: 'TenantStorageQuotaExceeded' },
          );
        }
      }

      return applyPrimary(request);
    };
    testHarness.agent.rpc = primaryRpc;

    return {
      allow             : (): void => { mode = 'allow'; },
      primaryAttempts   : (): number => primaryAttempts,
      secondaryAttempts : (): number => secondaryAttempts,
    };
  }

  async function expectQuotaBlockedStatus(): Promise<Awaited<ReturnType<SyncEngineLevel['getRemoteSyncStatus']>>[number]> {
    const statuses = await syncEngine.getRemoteSyncStatus(tenantDid);
    expect(statuses).toHaveLength(1);
    return statuses[0];
  }

  async function writeLocalRecord(params: {
    data: string;
    parentContextId?: string;
    protocolPath: string;
    schema?: string;
  }): Promise<{ message: RecordsWriteMessage }> {
    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : feedHarnessProtocolV1.protocol,
        protocolPath    : params.protocolPath,
        schema          : params.schema,
        parentContextId : params.parentContextId,
        dataFormat      : 'text/plain',
      },
      dataStream: new Blob([params.data]),
    });
    expect(reply.status.code).toBe(202);
    return { message: message! };
  }

  async function updateLocalRecord(
    recordsWriteMessage: RecordsWriteMessage,
    data: string,
  ): Promise<{ message: RecordsWriteMessage }> {
    const dataBytes = new TextEncoder().encode(data);
    const update = await RecordsWrite.createFrom({
      recordsWriteMessage,
      data   : dataBytes,
      signer : await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await testHarness.dwn.processMessage(
      tenantDid,
      update.message,
      { dataStream: DataStream.fromBytes(dataBytes) },
    );
    expect(reply.status.code).toBe(202);
    return { message: update.message };
  }

  async function updateRemoteRecord(recordsWriteMessage: RecordsWriteMessage, data: string): Promise<void> {
    const dataBytes = new TextEncoder().encode(data);
    const update = await RecordsWrite.createFrom({
      recordsWriteMessage,
      data   : dataBytes,
      signer : await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await remoteStores.dwn.processMessage(tenantDid, update.message, { dataStream: DataStream.fromBytes(dataBytes) });
    expect(reply.status.code).toBe(202);
  }

  async function deleteLocalRecord(recordId: string): Promise<void> {
    const deleteMessage = await RecordsDelete.create({
      recordId,
      signer: await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await testHarness.dwn.processMessage(tenantDid, deleteMessage.message);
    expect(reply.status.code).toBe(202);
  }

  async function deleteRemoteRecord(recordId: string, prune: boolean): Promise<void> {
    const deleteMessage = await RecordsDelete.create({
      recordId,
      prune,
      signer: await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await remoteStores.dwn.processMessage(tenantDid, deleteMessage.message);
    expect(reply.status.code).toBe(202);
  }

  async function expectRecordSnapshotsEqual(expected: { data: string; protocolPath: string; recordId: string }[]): Promise<void> {
    const [local, remote] = await Promise.all([
      readProtocolRecordSnapshot('local'),
      readProtocolRecordSnapshot('remote'),
    ]);
    const expectedSorted = [...expected].sort((a, b) => a.recordId.localeCompare(b.recordId));
    expect(local).toEqual(expectedSorted);
    expect(remote).toEqual(expectedSorted);
  }

  async function readProtocolRecordSnapshot(location: 'local' | 'remote'): Promise<{ data: string; protocolPath: string; recordId: string }[]> {
    const request = {
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { protocol: feedHarnessProtocolV1.protocol } },
    } as const;
    const { reply } = location === 'local'
      ? await testHarness.agent.dwn.processRequest(request)
      : await testHarness.agent.dwn.sendRequest(request);
    expect(reply.status.code).toBe(200);

    const snapshot = [];
    for (const entry of reply.entries ?? []) {
      const data = location === 'local'
        ? await readLocalRecordText(entry.recordId)
        : await readRemoteRecordText(entry.recordId);
      snapshot.push({
        data,
        protocolPath : entry.descriptor.protocolPath,
        recordId     : entry.recordId,
      });
    }

    return snapshot.sort((a, b) => a.recordId.localeCompare(b.recordId));
  }

  async function localFingerprint(): Promise<string | undefined> {
    const reply = await queryLocalMessageFeed({
      did      : tenantDid,
      filters  : [{ protocol: notesProtocol.protocol }],
      cidsOnly : true,
      limit    : 100,
      agent    : testHarness.agent,
    });
    expect(reply.status.code).toBe(200);
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
    return reply.fingerprint;
  }

  async function remoteFingerprint(): Promise<string | undefined> {
    const reply = await queryRemoteMessageFeed({
      did      : tenantDid,
      dwnUrl   : remoteEndpoint,
      filters  : [{ protocol: notesProtocol.protocol }],
      cidsOnly : true,
      limit    : 100,
      agent    : testHarness.agent,
    });
    expect(reply.status.code).toBe(200);
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
    return reply.fingerprint;
  }

  async function harnessFingerprint(): Promise<string | undefined> {
    return feedFingerprint('local', feedHarnessProtocolV1.protocol);
  }

  async function remoteHarnessFingerprint(dwnUrl = remoteEndpoint): Promise<string | undefined> {
    return feedFingerprint('remote', feedHarnessProtocolV1.protocol, dwnUrl);
  }

  async function feedFingerprint(
    location: 'local' | 'remote',
    protocol: string,
    dwnUrl = remoteEndpoint,
  ): Promise<string | undefined> {
    const params = {
      did      : tenantDid,
      filters  : [{ protocol }],
      cidsOnly : true,
      limit    : 100,
      agent    : testHarness.agent,
    };
    const reply = location === 'local'
      ? await queryLocalMessageFeed(params)
      : await queryRemoteMessageFeed({ ...params, dwnUrl });
    expect(reply.status.code).toBe(200);
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
    return reply.fingerprint;
  }
});

async function createRemoteDwnStores(
  testDataLocation: string,
  testHarness: PlatformAgentTestHarness,
): Promise<RemoteDwnStores> {
  const testDataPath = (path: string): string => `${testDataLocation}/${path}`;
  const dataStore = new DataStoreLevel({ blockstoreLocation: testDataPath('DWN_DATASTORE') });
  const wakePublisher = new EventEmitterWakePublisher();
  const messageStore = new MessageStoreLevel({
    location: testDataPath('DWN_MESSAGESTORE'),
    wakePublisher,
  });
  const eventLog = new DurableEventLog(messageStore, wakePublisher);
  const resumableTaskStore = new ResumableTaskStoreLevel({ location: testDataPath('DWN_RESUMABLETASKSTORE') });
  const dwn = await AgentDwnApi.createDwn({
    dataPath    : testDataLocation,
    dataStore,
    didResolver : testHarness.agent.did,
    messageLog  : { eventLog, messageStore },
    resumableTaskStore,
  });

  return { dataStore, dwn, eventLog, messageStore, resumableTaskStore };
}

async function clearRemoteDwnStores(stores: RemoteDwnStores): Promise<void> {
  await stores.dataStore.clear();
  await stores.messageStore.clear();
  await stores.resumableTaskStore.clear();
  await stores.eventLog.close();
  await stores.eventLog.open();
}

async function closeRemoteDwnStores(stores: RemoteDwnStores | undefined): Promise<void> {
  if (stores === undefined) {
    return;
  }

  await stores.eventLog.close();
  await stores.dataStore.close();
  await stores.messageStore.close();
  await stores.resumableTaskStore.close();
}

async function textFromDataStream(dataStream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await DataStream.toBytes(dataStream));
}
