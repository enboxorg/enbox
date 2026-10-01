import type { Dwn, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, Message } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { syncNextLinkIdentity } from '../src/sync-next/ledger-key.js';
import { SyncNextPushPage } from '../src/sync-next/push-page.js';
import { TestAgent } from './utils/test-agent.js';
import { computeAuthorizationEpoch, computeProjectionId } from '../src/types/sync.js';

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

async function createSyncTarget(tenantDid: string): Promise<SyncTarget> {
  const scope = { kind: 'protocolSet' as const, protocols: [protocol.protocol] as [string] };
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
    db = new Level<string, string>('__TESTDATA__/sync-next-push-page-integration/ledger');
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
  });
});
