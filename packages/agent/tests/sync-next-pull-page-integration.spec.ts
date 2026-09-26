import type { Dwn, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, Message } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { SyncNextPullPage } from '../src/sync-next/pull-page.js';
import { TestAgent } from './utils/test-agent.js';
import { computeAuthorizationEpoch, computeProjectionId } from '../src/types/sync.js';

const remoteEndpoint = 'http://localhost:9999/dwn';
const protocol: ProtocolDefinition = {
  protocol  : 'https://sync-next.example/notes',
  published : true,
  types     : {
    note: {
      dataFormats : ['text/plain'],
      schema      : 'https://sync-next.example/schemas/note',
    },
  },
  structure: { note: {} },
};

describe('SyncNextPullPage integration', () => {
  let db: Level<string, string>;
  let harness: PlatformAgentTestHarness;
  let ledger: SyncNextLedgerStore;
  let remoteDwn: Dwn;
  let tenantDid: string;

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/sync-next-pull-page-integration/local',
    });
    await harness.clearStorage();
    const gatewayUri = process.env.DID_DHT_GATEWAY_URI;
    process.env.DID_DHT_GATEWAY_URI = 'https://example.com';
    try {
      await harness.createAgentDid({ publish: false });
      const identity = await harness.createIdentity({
        name        : 'Sync Next Pull Alice',
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
    sinon.stub(harness.agent.vault, 'encryptData').callsFake(
      async ({ plaintext }: { plaintext: Uint8Array }): Promise<string> =>
        Buffer.from(plaintext).toString('base64url')
    );

    remoteDwn = await AgentDwnApi.createDwn({
      dataPath    : `__TESTDATA__/sync-next-pull-page-integration/remote-${crypto.randomUUID()}`,
      didResolver : harness.agent.did,
    });
    harness.agent.rpc = createLocalDwnRpc(remoteDwn);
    db = new Level<string, string>('__TESTDATA__/sync-next-pull-page-integration/ledger');
    ledger = new SyncNextLedgerStore(db, 'sync-next-pull-page-integration');
    await ledger.clear();
  });

  afterAll(async () => {
    sinon.restore();
    await ledger?.clear();
    await db?.close();
    await remoteDwn?.close();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('should advance past a real non-inline body and apply a later record with one query', async () => {
    const configured = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocol },
    });
    expect(configured.reply.status.code).toBe(202);

    const large = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : protocol.protocol,
        protocolPath : 'note',
        schema       : protocol.types.note.schema,
      },
      dataStream: new Blob([new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1)]),
    });
    expect(large.reply.status.code).toBe(202);
    const largeCid = await Message.getCid(large.message!);

    const smallText = 'later independent note';
    const small = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : protocol.protocol,
        protocolPath : 'note',
        schema       : protocol.types.note.schema,
      },
      dataStream: new Blob([smallText]),
    });
    expect(small.reply.status.code).toBe(202);
    const smallCid = await Message.getCid(small.message!);

    const { reply: localBefore } = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { protocol: protocol.protocol } },
    });
    expect(localBefore.entries ?? []).toHaveLength(0);

    const scope = { kind: 'protocolSet' as const, protocols: [protocol.protocol] as [string] };
    const syncTarget: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
      did                : tenantDid,
      dwnUrl             : remoteEndpoint,
      projectionId       : await computeProjectionId(tenantDid, scope),
      scope,
    };
    const link = await ledger.getOrCreateLink({
      authorization      : syncTarget.authorization,
      authorizationEpoch : syncTarget.authorizationEpoch,
      projectionId       : syncTarget.projectionId,
      remoteEndpoint     : syncTarget.dwnUrl,
      scope,
      tenantDid          : tenantDid,
    });

    const send = sinon.spy(harness.agent.rpc, 'sendDwnRequest');
    const apply = sinon.spy(harness.agent.dwn, 'applyReplicatedMessage');
    const result = await new SyncNextPullPage(harness.agent, ledger).consume(syncTarget);

    expect(result).toMatchObject({ kind: 'committed', hasMore: false, quarantined: 1 });
    if (result.kind !== 'committed') {
      throw new Error('expected the real pull page to commit');
    }
    expect(result.materializedCids).toContain(smallCid);
    expect(send.calledOnce).toBe(true);
    expect(apply.callCount).toBe(2);
    expect(await ledger.getQuarantineForLink(link)).toMatchObject([{
      messageCid: largeCid,
    }]);
    expect((await ledger.getLink(link))?.pullHandledThrough?.position).toBe('3');

    const { reply: largeLocal } = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { recordId: large.message!.recordId } },
    });
    expect(largeLocal.entries ?? []).toHaveLength(0);

    const { reply: smallLocal } = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: small.message!.recordId } },
    });
    expect(smallLocal.status.code).toBe(200);
    expect(new TextDecoder().decode(await DataStream.toBytes(smallLocal.entry!.data!))).toBe(smallText);
  });
});
