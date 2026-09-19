import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../../src/test-harness.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';
import { queryLocalMessageFeed, queryRemoteMessageFeed } from '../../src/sync-messages.js';

const protocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://e2e-sync-catchup.example/notes',
  types     : { note: { dataFormats: ['text/plain'] } },
  structure : { note: {} },
};

describe('E2E: populated catch-up HTTP request budget', () => {
  let harness: PlatformAgentTestHarness;

  beforeAll(async () => {
    await requireDwnServer();
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-sync-catchup-traffic',
    });
    await harness.clearStorage();
    await harness.createAgentDid();
  });

  afterAll(async () => {
    sinon.restore();
    await harness?.agent.sync.stopSync();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('catches up 579 retained messages within 10 HTTP requests, including streamed data and deletes', async () => {
    const identity = await harness.createIdentity({ name: 'Catch-up traffic', testDwnUrls: [testDwnUrl] });
    const did = identity.did.uri;
    const config = await harness.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocol },
    });
    expect(config.reply.status.code).toBe(202);
    const remoteConfig = await harness.agent.dwn.sendRequest({
      author      : did,
      target      : did,
      messageType : DwnInterface.ProtocolsConfigure,
      rawMessage  : config.message,
    });
    expect(remoteConfig.reply.status.code).toBe(202);

    // Match the reported inventory size: config + 489 writes + 89 deletes.
    // The local protocol makes this the populated-inventory catch-up path.
    const writes: RecordsWriteMessage[] = [];
    const largeText = 'x'.repeat(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
    for (let index = 0; index < 489; index++) {
      const write = await harness.agent.dwn.sendRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : { protocol: protocol.protocol, protocolPath: 'note', dataFormat: 'text/plain' },
        dataStream    : new Blob([index === 488 ? largeText : `record-${index}`]),
      });
      expect(write.reply.status.code).toBe(202);
      writes.push(write.message!);
    }
    for (const write of writes.slice(0, 89)) {
      const deletion = await harness.agent.dwn.sendRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsDelete,
        messageParams : { recordId: write.recordId },
      });
      expect(deletion.reply.status.code).toBe(202);
    }

    await harness.agent.sync.setIdentityOptions({ did, options: { protocols: [protocol.protocol] } });
    // Observe actual fetch calls, including transport retries. No RPC stubs.
    const http = sinon.spy(globalThis, 'fetch');
    const rpc = sinon.spy(harness.agent.rpc, 'sendDwnRequest');
    const countDwnPosts = (): number => http.args.filter(([input, init]) =>
      new URL(String(input)).origin === new URL(testDwnUrl).origin && init?.method === 'POST',
    ).length;
    const countReads = (): number => rpc.args.filter(([request]) => request.message.descriptor?.method === 'Read').length;

    await harness.agent.sync.sync('pull');

    expect(countDwnPosts()).toBeGreaterThan(0);
    expect(countDwnPosts()).toBeLessThanOrEqual(10);
    expect(countReads()).toBe(1);
    for (const [recordId, expected] of [
      [writes[487].recordId, 'record-487'],
      [writes[488].recordId, largeText],
    ]) {
      const result = await harness.agent.dwn.processRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId } },
      });
      expect(result.reply.status.code).toBe(200);
      expect(await DataStream.toBytes(result.reply.entry!.data)).toEqual(new TextEncoder().encode(expected));
    }
    const deleted = await harness.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: writes[0].recordId } },
    });
    expect(deleted.reply.status.code).toBe(404);
    const local = await queryLocalMessageFeed({ did, agent: harness.agent, limit: 1 });
    const remote = await queryRemoteMessageFeed({ did, dwnUrl: testDwnUrl, agent: harness.agent, limit: 1 });
    expect(local.fingerprint).toBe(remote.fingerprint);

    http.resetHistory();
    rpc.resetHistory();
    await harness.agent.sync.sync('pull');
    expect(countDwnPosts()).toBeLessThanOrEqual(2);
    expect(countReads()).toBe(0);
  }, 120_000);
});
