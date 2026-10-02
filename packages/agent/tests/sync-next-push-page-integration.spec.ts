import type { Dwn, ProtocolDefinition, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, DwnInterfaceName, DwnMethodName, Message, Time } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { retryOneDeliveryObligation } from '../src/sync-next/delivery-retry.js';
import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { syncNextLinkIdentity } from '../src/sync-next/ledger-key.js';
import { SyncNextPushPage } from '../src/sync-next/push-page.js';
import { SyncNextWorkPump } from '../src/sync-next/work-pump.js';
import { TestAgent } from './utils/test-agent.js';
import { computeAuthorizationEpoch, computeProjectionId } from '../src/types/sync.js';

const ledgerPath = '__TESTDATA__/sync-next-push-page-integration/ledger';
const remoteEndpoint = 'http://localhost:9998/dwn';
const protocol: ProtocolDefinition = {
  protocol  : 'https://sync-next-push.example/notes',
  published : true,
  types     : {
    note: {
      dataFormats : ['application/octet-stream'],
      schema      : 'https://sync-next-push.example/schemas/note',
    },
  },
  structure: { note: {} },
};

async function createSyncTarget(tenantDid: string, protocolUri = protocol.protocol): Promise<SyncTarget> {
  const scope = { kind: 'protocolSet' as const, protocols: [protocolUri] as [string] };
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
    did                : tenantDid,
    dwnUrl             : remoteEndpoint,
    projectionId       : await computeProjectionId(tenantDid, scope),
    scope,
  };
}

describe('SyncNext push-page integration', () => {
  let db: Level<string, string>;
  let harness: PlatformAgentTestHarness;
  let ledger: SyncNextLedgerStore;
  let remoteDwn: Dwn;
  let tenantDid: string;

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/sync-next-push-page-integration/local',
    });
    await harness.clearStorage();
    const gatewayUri = process.env.DID_DHT_GATEWAY_URI;
    process.env.DID_DHT_GATEWAY_URI = 'https://example.com';
    try {
      await harness.createAgentDid({ publish: false });
      const identity = await harness.createIdentity({
        name        : 'Sync Next Push Alice',
        publish     : false,
        testDwnUrls : [remoteEndpoint],
      });
      tenantDid = identity.did.uri;
    } finally {
      if (gatewayUri === undefined) {
        delete process.env.DID_DHT_GATEWAY_URI;
      } else {
        process.env.DID_DHT_GATEWAY_URI = gatewayUri;
      }
    }
    remoteDwn = await AgentDwnApi.createDwn({
      dataPath    : `__TESTDATA__/sync-next-push-page-integration/remote-${crypto.randomUUID()}`,
      didResolver : harness.agent.did,
    });
    harness.agent.rpc = createLocalDwnRpc(remoteDwn);
    db = new Level<string, string>(ledgerPath);
    ledger = new SyncNextLedgerStore(db, 'sync-next-push-page-integration');
    await ledger.clear();
  });

  afterAll(async () => {
    await ledger?.clear();
    await db?.close();
    await remoteDwn?.close();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('should resume an outbound obligation after its ledger reopens', async () => {
    const restartProtocol = { ...protocol, protocol: 'https://sync-next-push.example/work-pump-restart' };
    expect((await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: restartProtocol },
    })).reply.status.code).toBe(202);
    const data = new TextEncoder().encode('restart delivery');
    const write = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/octet-stream',
        protocol     : restartProtocol.protocol,
        protocolPath : 'note',
        schema       : restartProtocol.types.note.schema,
      },
      dataStream: new Blob([data]),
    });
    expect(write.reply.status.code).toBe(202);
    const writeCid = await Message.getCid(write.message!);
    const syncTarget = await createSyncTarget(tenantDid, restartProtocol.protocol);

    const originalApply = harness.agent.rpc.applyReplicatedMessage.bind(harness.agent.rpc);
    let failed = false;
    harness.agent.rpc.applyReplicatedMessage = async (request): Promise<ReplicationApplyResult> => {
      if (!failed && await Message.getCid(request.message) === writeCid) {
        failed = true;
        throw new TypeError('temporary endpoint failure');
      }
      return originalApply(request);
    };
    try {
      const first = await new SyncNextWorkPump(harness.agent, ledger).run([syncTarget], 'push');
      expect(first.remoteRequests).toBe(2);
      expect(first.targets[0].push).toEqual({ enabled: true, feedCovered: true, pendingDelivery: 1 });
      expect(first.nextRunAt).toBeDefined();
    } finally {
      harness.agent.rpc.applyReplicatedMessage = originalApply;
    }

    await db.close();
    db = new Level<string, string>(ledgerPath);
    ledger = new SyncNextLedgerStore(db, 'sync-next-push-page-integration');
    const resumed = await new SyncNextWorkPump(harness.agent, ledger).run([syncTarget], 'push');

    expect(resumed.remoteRequests).toBe(1);
    expect(resumed.targets[0].push).toEqual({ enabled: true, feedCovered: true, pendingDelivery: 0 });
    const remoteRead = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: write.message!.recordId } },
    });
    expect(remoteRead.reply.status.code).toBe(200);
    expect(await DataStream.toBytes(remoteRead.reply.entry!.data!)).toEqual(data);
  });

  it('should hydrate a new empty remote with a protocol and detached record body', async () => {
    expect((await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocol },
    })).reply.status.code).toBe(202);

    const data = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(7);
    const write = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/octet-stream',
        protocol     : protocol.protocol,
        protocolPath : 'note',
        schema       : protocol.types.note.schema,
      },
      dataStream: new Blob([data]),
    });
    expect(write.reply.status.code).toBe(202);

    const before = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: write.message!.recordId } },
    });
    expect(before.reply.status.code).toBe(404);

    const syncTarget = await createSyncTarget(tenantDid);
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });

    expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget)).toMatchObject({
      hasMore  : false,
      kind     : 'committed',
      retained : 0,
    });
    expect((await ledger.getLink(link))?.pushHandledThrough).toBeDefined();
    expect(await ledger.getDeliveryForLink(link)).toEqual([]);

    const after = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: write.message!.recordId } },
    });
    expect(after.reply.status.code).toBe(200);
    expect(await DataStream.toBytes(after.reply.entry!.data!)).toEqual(data);
  });

  it('should retain an in-process remote write whose indexed body is unavailable', async () => {
    const configure = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocol },
    });
    expect(configure.reply.status.code).toBe(202);
    expect(await remoteDwn.applyReplicatedMessage(tenantDid, configure.message!))
      .toEqual(expect.objectContaining({ kind: 'Applied' }));

    const data = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(8);
    const write = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/octet-stream',
        protocol     : protocol.protocol,
        protocolPath : 'note',
        schema       : protocol.types.note.schema,
      },
      dataStream: new Blob([data]),
    });
    expect(write.reply.status.code).toBe(202);
    expect(await remoteDwn.applyReplicatedMessage(tenantDid, write.message!, {
      dataStream: DataStream.fromBytes(data),
    })).toEqual(expect.objectContaining({ kind: 'Applied' }));

    await remoteDwn.storage.dataStore.delete(
      tenantDid,
      write.message!.recordId,
      write.message!.descriptor.dataCid,
    );

    const syncTarget = await createSyncTarget(tenantDid);
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget)).toMatchObject({
      acknowledged : 1,
      hasMore      : false,
      kind         : 'committed',
      retained     : 1,
    });
    expect(await ledger.getDeliveryForLink(link)).toMatchObject([{
      messageCid : await Message.getCid(write.message!),
      outcome    : { reason: 'remote-incomplete' },
    }]);

    const remoteRead = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: write.message!.recordId } },
    });
    expect(remoteRead.reply.status.code).toBe(410);
    expect(await retryOneDeliveryObligation({ agent: harness.agent, ledger, target: syncTarget }))
      .toEqual({ kind: 'pending', outcome: { reason: 'remote-incomplete' } });
    expect(await ledger.getDeliveryForLink(link)).toHaveLength(1);
  });

  it('should deliver a retained detached body after a transient remote failure', async () => {
    const retryProtocol = { ...protocol, protocol: 'https://sync-next-push.example/retry' };
    expect((await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: retryProtocol },
    })).reply.status.code).toBe(202);

    const data = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(9);
    const write = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/octet-stream',
        protocol     : retryProtocol.protocol,
        protocolPath : 'note',
        schema       : retryProtocol.types.note.schema,
      },
      dataStream: new Blob([data]),
    });
    expect(write.reply.status.code).toBe(202);

    const syncTarget = await createSyncTarget(tenantDid, retryProtocol.protocol);
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const originalApply = harness.agent.rpc.applyReplicatedMessage.bind(harness.agent.rpc);
    let attempts = 0;
    harness.agent.rpc.applyReplicatedMessage = async (request): Promise<ReplicationApplyResult> => {
      attempts++;
      if (attempts === 2) {
        throw new TypeError('temporary remote disconnect');
      }
      return originalApply(request);
    };
    try {
      expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget)).toMatchObject({
        acknowledged : 1,
        kind         : 'committed',
        retained     : 1,
      });
      expect(await ledger.getDeliveryForLink(link)).toMatchObject([{
        messageCid         : await Message.getCid(write.message!),
        wasLatestBaseState : true,
      }]);
      expect(await retryOneDeliveryObligation({ agent: harness.agent, ledger, target: syncTarget }))
        .toEqual({ kind: 'settled' });
      expect(await ledger.getDeliveryForLink(link)).toEqual([]);
      const remoteRead = await harness.agent.dwn.sendRequest({
        author        : tenantDid,
        target        : tenantDid,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: write.message!.recordId } },
      });
      expect(remoteRead.reply.status.code).toBe(200);
      expect(await DataStream.toBytes(remoteRead.reply.entry!.data!)).toEqual(data);
    } finally {
      harness.agent.rpc.applyReplicatedMessage = originalApply;
    }
  });

  it('should settle a pruned update receipt when a newer current update delivers', async () => {
    const updateProtocol = { ...protocol, protocol: 'https://sync-next-push.example/supersession' };
    expect((await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: updateProtocol },
    })).reply.status.code).toBe(202);

    const initial = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/octet-stream',
        protocol     : updateProtocol.protocol,
        protocolPath : 'note',
        schema       : updateProtocol.types.note.schema,
      },
      dataStream: new Blob(['initial note']),
    });
    expect(initial.reply.status.code).toBe(202);

    const syncTarget = await createSyncTarget(tenantDid, updateProtocol.protocol);
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget))
      .toMatchObject({ kind: 'committed', retained: 0 });

    const updateParams = {
      dataFormat   : 'application/octet-stream',
      dateCreated  : initial.message!.descriptor.dateCreated,
      protocol     : updateProtocol.protocol,
      protocolPath : 'note',
      recordId     : initial.message!.recordId,
      schema       : updateProtocol.types.note.schema,
    };
    const firstUpdate = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        ...updateParams,
        messageTimestamp: Time.createOffsetTimestamp({ seconds: 1 }, initial.message!.descriptor.messageTimestamp),
      },
      dataStream: new Blob(['draft one']),
    });
    expect(firstUpdate.reply.status.code).toBe(202);
    const firstUpdateCid = await Message.getCid(firstUpdate.message!);

    const originalApply = harness.agent.rpc.applyReplicatedMessage.bind(harness.agent.rpc);
    let failedOnce = false;
    harness.agent.rpc.applyReplicatedMessage = async (request): Promise<ReplicationApplyResult> => {
      if (!failedOnce && await Message.getCid(request.message) === firstUpdateCid) {
        failedOnce = true;
        throw new TypeError('temporary remote disconnect');
      }
      return originalApply(request);
    };
    try {
      expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget))
        .toMatchObject({ kind: 'committed', retained: 1 });
    } finally {
      harness.agent.rpc.applyReplicatedMessage = originalApply;
    }

    const latestData = new TextEncoder().encode('draft two');
    const secondUpdate = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        ...updateParams,
        messageTimestamp: Time.createOffsetTimestamp({ seconds: 1 }, firstUpdate.message!.descriptor.messageTimestamp),
      },
      dataStream: new Blob([latestData]),
    });
    expect(secondUpdate.reply.status.code).toBe(202);
    const oldLocalRead = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.MessagesRead,
      messageParams : { messageCid: firstUpdateCid },
    });
    expect(oldLocalRead.reply.status.code).toBe(404);

    expect(await retryOneDeliveryObligation({ agent: harness.agent, ledger, target: syncTarget }))
      .toEqual({ kind: 'pending', outcome: { reason: 'dependency' } });
    expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget))
      .toMatchObject({ kind: 'committed', retained: 0 });
    const remoteRead = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: initial.message!.recordId } },
    });
    expect(remoteRead.reply.status.code).toBe(200);
    expect(await DataStream.toBytes(remoteRead.reply.entry!.data!)).toEqual(latestData);
    expect(await ledger.getDeliveryForLink(link)).toEqual([]);
  });

  it('should retain a pre-delete write that the remote tombstone still needs', async () => {
    const deleteProtocol = { ...protocol, protocol: 'https://sync-next-push.example/delete-visibility' };
    expect((await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: deleteProtocol },
    })).reply.status.code).toBe(202);

    const data = new TextEncoder().encode('same note body');
    const initial = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/octet-stream',
        protocol     : deleteProtocol.protocol,
        protocolPath : 'note',
        schema       : deleteProtocol.types.note.schema,
        tags         : { team: 'red' },
      },
      dataStream: new Blob([data]),
    });
    expect(initial.reply.status.code).toBe(202);

    const syncTarget = await createSyncTarget(tenantDid, deleteProtocol.protocol);
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget))
      .toMatchObject({ kind: 'committed', retained: 0 });

    await Time.minimalSleep();
    const update = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'application/octet-stream',
        dateCreated  : initial.message!.descriptor.dateCreated,
        protocol     : deleteProtocol.protocol,
        protocolPath : 'note',
        recordId     : initial.message!.recordId,
        schema       : deleteProtocol.types.note.schema,
        tags         : { team: 'blue' },
      },
      dataStream: new Blob([data]),
    });
    expect(update.reply.status.code).toBe(202);
    const updateCid = await Message.getCid(update.message!);

    const originalApply = harness.agent.rpc.applyReplicatedMessage.bind(harness.agent.rpc);
    harness.agent.rpc.applyReplicatedMessage = async (request): Promise<ReplicationApplyResult> => {
      if (await Message.getCid(request.message) === updateCid) {
        throw new TypeError('temporary update delivery failure');
      }
      return originalApply(request);
    };
    try {
      expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget))
        .toMatchObject({ kind: 'committed', retained: 1 });
    } finally {
      harness.agent.rpc.applyReplicatedMessage = originalApply;
    }

    await Time.minimalSleep();
    const recordsDelete = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: initial.message!.recordId },
    });
    expect(recordsDelete.reply.status.code).toBe(202);
    expect(await new SyncNextPushPage(harness.agent, ledger).consume(syncTarget))
      .toMatchObject({ acknowledged: 1, kind: 'committed', retained: 0 });
    expect(await ledger.getDeliveryForLink(link)).toMatchObject([{ messageCid: updateCid }]);

    const blueTombstoneFilter = {
      'interface' : DwnInterfaceName.Records,
      'method'    : DwnMethodName.Delete,
      'tag.team'  : 'blue',
    };
    expect((await remoteDwn.storage.messageStore.query(tenantDid, [blueTombstoneFilter])).messages)
      .toEqual([]);

    expect(await retryOneDeliveryObligation({ agent: harness.agent, ledger, target: syncTarget }))
      .toEqual({ kind: 'pending', outcome: { reason: 'dependency' } });
    expect(await ledger.getDeliveryForLink(link)).toHaveLength(1);
  });
});
