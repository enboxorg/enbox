/**
 * E2E: Pull subscription recovery after WebSocket drop.
 *
 * Verifies the real reconnection path for the PULL side of live sync:
 *   1. Agent has a live pull subscription via WebSocket
 *   2. WebSocket is force-closed (simulating network interruption)
 *   3. A record is written directly to the REMOTE DWN (bypassing this agent)
 *   4. JsonRpcSocket auto-reconnect fires, pull subscription re-establishes
 *   5. The remote-only record appears in the local DWN via the recovered
 *      pull subscription (or the durable feed settle check that follows)
 *
 * This isolates the pull reconnection path — the push path uses HTTP and
 * is unaffected by WebSocket drops.
 *
 * Requires: DWN server running on localhost:3000 (or TEST_DWN_URL),
 *           Pkarr relay on localhost:7527 (or DID_DHT_GATEWAY_URI).
 */
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { WebSocketDwnRpcClient } from '@enbox/dwn-clients';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { DwnInterface } from '../../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../../src/test-harness.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';

const testDwnUrls = [testDwnUrl];

const todoProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://e2e-reconnect.xyz/todo',
  types     : {
    task: {
      schema      : 'https://e2e-reconnect.xyz/schemas/task',
      dataFormats : ['text/plain'],
    },
  },
  structure: { task: {} },
};

/**
 * Force-close ALL WebSocket connections in the RPC client's static pool.
 * This simulates a network disruption — the JsonRpcSocket auto-reconnect
 * should detect the closure and re-establish the connection.
 */
function killAllWebSockets(): void {
  const connections = (WebSocketDwnRpcClient as any).connections as Map<string, { socket: any }>;
  for (const [, conn] of connections) {
    const ws = conn.socket['socket'] as WebSocket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
}

describe('E2E: pull subscription recovery after WebSocket drop', () => {
  beforeAll(async () => {
    await requireDwnServer();
  });

  let harness: PlatformAgentTestHarness;
  let did: string;

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-reconnection',
    });
    await harness.createAgentDid();

    const identity = await harness.createIdentity({
      name: 'E2E-Reconnect',
      testDwnUrls,
    });
    did = identity.did.uri;

    // Install protocol locally and on remote.
    await harness.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: todoProtocol },
    });
    await harness.agent.dwn.sendRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: todoProtocol },
    });

    await harness.agent.sync.registerIdentity({
      did,
      options: { protocols: [todoProtocol.protocol] },
    });

    // Start live sync and establish the pull WebSocket subscription.
    await harness.agent.sync.startSync({ interval: '30s' });
    expect(harness.agent.sync.hasActiveSubscriptions).toBe(true);
  }, 30_000);

  afterAll(async () => {
    try { await harness?.agent.sync.stopSync(); } catch { /* may already be stopped */ }
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('should recover the pull subscription and deliver a remote-only record locally', async () => {
    // Phase 1: Verify pull subscription is working — write directly to
    // the remote and confirm it arrives locally via the live subscription.
    const data1 = Convert.string('before drop').toUint8Array();
    const remoteWrite1 = await harness.agent.dwn.sendRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : todoProtocol.protocol,
        protocolPath : 'task',
        schema       : todoProtocol.types.task.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([data1]),
    });
    expect(remoteWrite1.reply.status.code).toBe(202);
    const preDropRecordId = remoteWrite1.message!.recordId;

    // Poll LOCAL DWN for the record (delivered via pull subscription).
    let deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline) {
      const local = await harness.agent.dwn.processRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: todoProtocol.protocol, recordId: preDropRecordId } },
      });
      if (local.reply.entries?.length) { found = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    expect(found).toBe(true);

    // Phase 2: Kill the WebSocket — the pull subscription is now dead.
    // Write the post-drop record IMMEDIATELY (no pause) so it lands on
    // the remote while the subscription is definitively unavailable.
    // The reconnect backoff floor is ~500ms, so writing immediately
    // guarantees the record exists on the remote before any reconnect.
    killAllWebSockets();

    const data2 = Convert.string('after drop').toUint8Array();
    const remoteWrite2 = await harness.agent.dwn.sendRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : todoProtocol.protocol,
        protocolPath : 'task',
        schema       : todoProtocol.types.task.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([data2]),
    });
    expect(remoteWrite2.reply.status.code).toBe(202);
    const postDropRecordId = remoteWrite2.message!.recordId;

    // Verify the record does NOT exist locally — the subscription was
    // dead when the record was written to the remote. Poll for 300ms
    // to confirm it stays absent (not just a point-in-time check).
    for (let i = 0; i < 3; i++) {
      const local = await harness.agent.dwn.processRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: todoProtocol.protocol, recordId: postDropRecordId } },
      });
      expect(local.reply.entries?.length ?? 0).toBe(0);
      await new Promise(r => setTimeout(r, 100));
    }

    // Phase 3: Wait for auto-reconnect to re-establish the pull
    // subscription and deliver the post-drop record locally.
    // JsonRpcSocket reconnect fires after ~500-1000ms (backoff + jitter),
    // then re-subscription replays from the cursor and delivers the record.
    deadline = Date.now() + 20_000;
    found = false;
    while (Date.now() < deadline) {
      const local = await harness.agent.dwn.processRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: todoProtocol.protocol, recordId: postDropRecordId } },
      });
      if (local.reply.entries?.length) { found = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(found).toBe(true);
  }, 45_000);

  it('should report healthy sync after pull subscription recovery', async () => {
    const health = await harness.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
  });
});
