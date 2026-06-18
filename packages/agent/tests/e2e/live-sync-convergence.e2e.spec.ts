/**
 * E2E: Live sync push + pull convergence.
 *
 * Creates an agent, writes a record locally, and verifies it appears on
 * the remote DWN via live sync push. Then pulls from the remote to verify
 * the round-trip. Proves the full pipeline:
 *   local write -> EventLog -> live push subscription -> remote DWN
 *   remote DWN -> durable feed pull -> local DWN
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
    harness.agent.sync.startSync({ mode: 'live', interval: '30s' });

    // Wait for initial sync to settle.
    await new Promise(r => setTimeout(r, 2_000));
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

    // Wait for live sync to push to the remote (up to 10s).
    const deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline) {
      const remoteResult = await harness.agent.dwn.sendRequest({
        author        : aliceDid,
        target        : aliceDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: { protocol: chatProtocol.protocol, recordId },
        },
      });
      if (remoteResult.reply.status.code === 200 && remoteResult.reply.entries?.length) {
        found = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    expect(found).toBe(true);
  }, 20_000);

  it('should pull a remote-only record to local via durable feed sync', async () => {
    // Stop sync so we can create a record on the remote that the local
    // agent doesn't know about — then verify pull brings it down.
    await harness.agent.sync.stopSync();

    // Write a new record directly to the remote (bypassing local DWN).
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

    // Verify it does NOT exist locally yet.
    const beforePull = await harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: chatProtocol.protocol, recordId: pullRecordId },
      },
    });
    expect(beforePull.reply.entries?.length ?? 0).toBe(0);

    // Pull from the remote via durable feed sync.
    await harness.agent.sync.sync('pull');

    // The record should now exist locally.
    const afterPull = await harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: chatProtocol.protocol, recordId: pullRecordId },
      },
    });
    expect(afterPull.reply.status.code).toBe(200);
    expect(afterPull.reply.entries?.length).toBe(1);
  }, 20_000);

  it('should report healthy sync with zero failed messages', async () => {
    const health = await harness.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
  });
});
