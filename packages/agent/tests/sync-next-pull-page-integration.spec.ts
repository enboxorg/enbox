import type { Dwn, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, Message, RecordsWrite } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { retryOneQuarantinedRoot } from '../src/sync-next/quarantine-retry.js';
import { syncNextLinkIdentity } from '../src/sync-next/progress-key.js';
import { SyncNextProgressStore } from '../src/sync-next/progress-store.js';
import { SyncNextPullPage } from '../src/sync-next/pull-page.js';
import { SyncNextRunner } from '../src/sync-next/runner.js';
import { TestAgent } from './utils/test-agent.js';
import { computeAuthorizationEpoch, computeProjectionId } from '../src/types/sync.js';

const progressStorePath = '__TESTDATA__/sync-next-pull-page-integration/progress-store';
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

describe('SyncNext pull and quarantine retry integration', () => {
  let db: Level<string, string>;
  let harness: PlatformAgentTestHarness;
  let progressStore: SyncNextProgressStore;
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
    remoteDwn = await AgentDwnApi.createDwn({
      dataPath    : `__TESTDATA__/sync-next-pull-page-integration/remote-${crypto.randomUUID()}`,
      didResolver : harness.agent.did,
    });
    harness.agent.rpc = createLocalDwnRpc(remoteDwn);
    db = new Level<string, string>(progressStorePath);
    progressStore = new SyncNextProgressStore(db, 'sync-next-pull-page-integration');
    await progressStore.clear();
  });

  afterAll(async () => {
    await progressStore?.clear();
    await db?.close();
    await remoteDwn?.close();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should advance past a non-inline body and recover it after a progress-store restart', async () => {
    const configured = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocol },
    });
    expect(configured.reply.status.code).toBe(202);

    const largeBytes = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
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
      dataStream: new Blob([largeBytes]),
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
    const link = await progressStore.getOrCreateLink({
      authorization      : syncTarget.authorization,
      authorizationEpoch : syncTarget.authorizationEpoch,
      projectionId       : syncTarget.projectionId,
      remoteEndpoint     : syncTarget.dwnUrl,
      scope,
      tenantDid          : tenantDid,
    });

    const send = sinon.spy(harness.agent.rpc, 'sendDwnRequest');
    const apply = sinon.spy(harness.agent.dwn, 'applyReplicatedMessage');
    const result = await new SyncNextPullPage(harness.agent, progressStore).run(syncTarget);

    expect(result).toMatchObject({ kind: 'committed', feedDrained: true, quarantined: 1 });
    if (result.kind !== 'committed') {
      throw new Error('expected the real pull page to commit');
    }
    expect(result.handledCids).toContain(smallCid);
    expect(send.calledOnce).toBe(true);
    expect(apply.callCount).toBe(2);
    expect(await progressStore.getQuarantineForLink(link)).toMatchObject([{
      messageCid: largeCid,
    }]);
    expect((await progressStore.getLink(link))?.pullCheckpoint?.position).toBe('3');

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

    const checkpoint = (await progressStore.getLink(link))?.pullCheckpoint;
    await db.close();
    db = new Level<string, string>(progressStorePath);
    progressStore = new SyncNextProgressStore(db, 'sync-next-pull-page-integration');

    expect(await retryOneQuarantinedRoot({ agent: harness.agent, progressStore, target: syncTarget }))
      .toMatchObject({ kind: 'settled' });
    expect(send.callCount).toBe(2);
    expect(apply.callCount).toBe(4);
    expect(apply.thirdCall.args[2]).toEqual({ includeMaterializationConfirmation: true });
    expect(await apply.thirdCall.returnValue).toMatchObject({ ancestryOnly: true, kind: 'Applied' });
    expect(await progressStore.getQuarantineForLink(link)).toEqual([]);
    expect((await progressStore.getLink(link))?.pullCheckpoint).toEqual(checkpoint);

    const { reply: recovered } = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: large.message!.recordId } },
    });
    expect(recovered.status.code).toBe(200);
    expect(await DataStream.toBytes(recovered.entry!.data!)).toEqual(largeBytes);

    expect(await retryOneQuarantinedRoot({ agent: harness.agent, progressStore, target: syncTarget }))
      .toEqual({ kind: 'empty' });
    expect(send.callCount).toBe(2);
  });

  it('settles an older quarantined write after a newer write materializes', async () => {
    const supersessionProtocol = { ...protocol, protocol: 'https://sync-next.example/pull-supersession' };
    expect((await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: supersessionProtocol },
    })).reply.status.code).toBe(202);
    const initialData = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(3);
    const initial = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : supersessionProtocol.protocol,
        protocolPath : 'note',
        schema       : supersessionProtocol.types.note.schema,
      },
      dataStream: new Blob([initialData]),
    });
    expect(initial.reply.status.code).toBe(202);

    const scope = { kind: 'protocolSet' as const, protocols: [supersessionProtocol.protocol] as [string] };
    const syncTarget: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
      did                : tenantDid,
      dwnUrl             : remoteEndpoint,
      projectionId       : await computeProjectionId(tenantDid, scope),
      scope,
    };
    const link = await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization: syncTarget.authorization,
      scope,
    });
    const pullPage = new SyncNextPullPage(harness.agent, progressStore);
    expect(await pullPage.run(syncTarget)).toMatchObject({ kind: 'committed', quarantined: 1 });
    expect(await harness.agent.dwn.applyReplicatedMessage(tenantDid, initial.message!))
      .toMatchObject({ ancestryOnly: true, kind: 'Applied' });

    const updateData = new TextEncoder().encode('newer complete data');
    const update = await RecordsWrite.createFrom({
      recordsWriteMessage : initial.message! as RecordsWriteMessage,
      data                : updateData,
      signer              : await (harness.agent.dwn as any).getSigner(tenantDid),
    });
    expect((await remoteDwn.processMessage(tenantDid, update.message, {
      dataStream: DataStream.fromBytes(updateData),
    })).status.code).toBe(202);
    expect(await pullPage.run(syncTarget)).toMatchObject({ kind: 'committed', quarantined: 0 });

    expect(await progressStore.getQuarantineForLink(link)).toHaveLength(1);
    const sourceRead = sinon.stub(harness.agent.rpc, 'sendDwnRequest').rejects(new Error('source offline'));
    expect(await retryOneQuarantinedRoot({ agent: harness.agent, progressStore, target: syncTarget }))
      .toEqual({ kind: 'settled', appliedEntries: [] });
    expect(sourceRead.notCalled).toBe(true);
    expect(await progressStore.getQuarantineForLink(link)).toEqual([]);

    const { reply } = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: initial.message!.recordId } },
    });
    expect(reply.status.code).toBe(200);
    expect(await DataStream.toBytes(reply.entry!.data!)).toEqual(updateData);
  });

  it('settles a locally completed write after failed settlement and progress-store restart without the source', async () => {
    const crashProtocol = { ...protocol, protocol: 'https://sync-next.example/crash-retry' };
    expect((await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: crashProtocol },
    })).reply.status.code).toBe(202);
    expect((await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: crashProtocol },
    })).reply.status.code).toBe(202);
    const data = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(7);
    const sent = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : crashProtocol.protocol,
        protocolPath : 'note',
        schema       : crashProtocol.types.note.schema,
      },
      dataStream: new Blob([data]),
    });
    expect(sent.reply.status.code).toBe(202);
    const message = sent.message!;
    const messageCid = await Message.getCid(message);
    const scope = { kind: 'full' as const };
    const target: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
      did                : tenantDid,
      dwnUrl             : remoteEndpoint,
      projectionId       : await computeProjectionId(tenantDid, scope),
      scope,
    };
    const link = await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(target),
      authorization: target.authorization,
      scope,
    });
    const source = { epoch: 'remote-epoch', position: '1', streamId: 'remote-stream', messageCid };
    const entry = { isLatestBaseState: true, message, messageCid, seq: '1' };
    await progressStore.commitPullPage(link, {
      checkpoint   : source,
      pageReceipts : [{ messageCid, source }],
      quarantine   : [{ entry, messageCid, source }],
      settled      : [],
    });
    const settle = sinon.stub(progressStore, 'settleQuarantineForProjection');
    settle.onFirstCall().rejects(new Error('injected settlement failure'));
    settle.callThrough();

    await expect(retryOneQuarantinedRoot({ agent: harness.agent, progressStore, target }))
      .rejects.toThrow('injected settlement failure');
    expect(await progressStore.getQuarantineForLink(link)).toHaveLength(1);
    const { reply: local } = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: message.recordId } },
    });
    expect(local.status.code).toBe(200);
    expect(await DataStream.toBytes(local.entry!.data!)).toEqual(data);

    const send = sinon.stub(harness.agent.rpc, 'sendDwnRequest').rejects(new Error('source offline'));
    await db.close();
    db = new Level<string, string>(progressStorePath);
    progressStore = new SyncNextProgressStore(db, 'sync-next-pull-page-integration');
    expect(await progressStore.getQuarantineForLink(link)).toHaveLength(1);

    const resumed = await new SyncNextRunner(harness.agent, progressStore).run([target], 'pull');
    expect(resumed.failures).toEqual([{
      message : 'source offline',
      target  : syncNextLinkIdentity(target),
      work    : 'pullPage',
    }]);
    expect(resumed.workRemaining).toBe(true);
    expect(send.calledOnce).toBe(true);
    expect(await progressStore.getQuarantineForLink(link)).toEqual([]);
  });

  it('should recover missing data while an independent record progresses', async () => {
    const runnerProtocol = { ...protocol, protocol: 'https://sync-next.example/runner' };
    expect((await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: runnerProtocol },
    })).reply.status.code).toBe(202);

    const largeBytes = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(5);
    const large = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : runnerProtocol.protocol,
        protocolPath : 'note',
        schema       : runnerProtocol.types.note.schema,
      },
      dataStream: new Blob([largeBytes]),
    });
    expect(large.reply.status.code).toBe(202);
    const small = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : runnerProtocol.protocol,
        protocolPath : 'note',
        schema       : runnerProtocol.types.note.schema,
      },
      dataStream: new Blob(['independent']),
    });
    expect(small.reply.status.code).toBe(202);

    const scope = { kind: 'protocolSet' as const, protocols: [runnerProtocol.protocol] as [string] };
    const syncTarget: SyncTarget = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
      did                : tenantDid,
      dwnUrl             : remoteEndpoint,
      projectionId       : await computeProjectionId(tenantDid, scope),
      scope,
    };
    const result = await new SyncNextRunner(harness.agent, progressStore).run([syncTarget], 'pull');

    expect(result).toMatchObject({ remoteRequests: 2, workRemaining: false });
    for (const recordId of [large.message!.recordId, small.message!.recordId]) {
      const { reply } = await harness.agent.dwn.processRequest({
        author        : tenantDid,
        target        : tenantDid,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId } },
      });
      expect(reply.status.code).toBe(200);
    }
    expect(await progressStore.getQuarantineForProjection(tenantDid, syncTarget.projectionId)).toEqual([]);
  });
});
