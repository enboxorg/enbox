/**
 * E2E: Live sync push + pull convergence.
 *
 * Creates an agent, writes a record locally, and verifies it appears on
 * the remote DWN via live sync push. Then writes directly to the remote
 * and verifies the live pull subscription applies the record locally.
 * Proves the full pipeline:
 *   local write -> EventLog -> live push subscription -> remote DWN
 *   remote DWN -> live pull subscription -> local DWN
 *
 * Requires: DWN server running on localhost:3000 (or TEST_DWN_URL),
 *           Pkarr relay on localhost:7527 (or DID_DHT_GATEWAY_URI).
 */
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { DwnInterface } from '../../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../../src/test-harness.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';

const testDwnUrls = [testDwnUrl];

const chatProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://e2e-convergence.xyz/chat',
  types     : {
    message: {
      schema      : 'https://e2e-convergence.xyz/schemas/message',
      dataFormats : ['text/plain'],
    },
  },
  structure: { message: {} },
};

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('E2E: live sync convergence', () => {
  let harness: PlatformAgentTestHarness;
  let aliceDid: string;
  let recordId: string;

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-convergence',
    });
    await harness.createAgentDid();

    const alice = await harness.createIdentity({
      name: 'E2E-Convergence-Alice',
      testDwnUrls,
    });
    aliceDid = alice.did.uri;

    // Install protocol locally and on remote.
    await harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
    });
    await harness.agent.dwn.sendRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
    });

    // Register for sync and start live mode.
    await harness.agent.sync.registerIdentity({
      did     : aliceDid,
      options : { protocols: [chatProtocol.protocol] },
    });
    await harness.agent.sync.startSync({ mode: 'live', interval: '30s' });
    expect(harness.agent.sync.hasActiveSubscriptions).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await harness?.agent.sync.stopSync();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('should push a locally written record to the remote DWN via live sync', async () => {
    // Write a record locally.
    const dataBytes = Convert.string('e2e convergence test').toUint8Array();
    const writeResult = await harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'message',
        schema       : chatProtocol.types.message.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([dataBytes]),
    });
    expect(writeResult.reply.status.code).toBe(202);
    recordId = writeResult.message!.recordId;

    await waitFor(async () => {
      const remoteResult = await harness.agent.dwn.sendRequest({
        author        : aliceDid,
        target        : aliceDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: { protocol: chatProtocol.protocol, recordId },
        },
      });
      return remoteResult.reply.status.code === 200 && (remoteResult.reply.entries?.length ?? 0) > 0;
    }, 10_000);
  }, 20_000);

  it('should pull a remote-only record to local via live sync', async () => {
    const pullTestData = Convert.string('pull convergence test').toUint8Array();
    const remoteWrite = await harness.agent.dwn.sendRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'message',
        schema       : chatProtocol.types.message.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([pullTestData]),
    });
    expect(remoteWrite.reply.status.code).toBe(202);
    const pullRecordId = remoteWrite.message!.recordId;

    const beforePull = await harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: chatProtocol.protocol, recordId: pullRecordId },
      },
    });
    expect(beforePull.reply.entries?.length ?? 0).toBe(0);

    await waitFor(async () => {
      const afterPull = await harness.agent.dwn.processRequest({
        author        : aliceDid,
        target        : aliceDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: { protocol: chatProtocol.protocol, recordId: pullRecordId },
        },
      });
      return afterPull.reply.status.code === 200 && afterPull.reply.entries?.length === 1;
    }, 10_000);
  }, 20_000);

  it('should report healthy sync with zero failed messages', async () => {
    const health = await harness.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
  });
});
