/**
 * E2E: Sync recovery after WebSocket connection drop.
 *
 * Simulates a network interruption by force-closing the underlying
 * WebSocket while sync remains logically live. Verifies:
 *   - JsonRpcSocket reconnect fires
 *   - Live subscriptions re-establish
 *   - Records written during the outage are pushed via SMT reconciliation
 *   - getSyncHealth() reports healthy state after recovery
 *
 * This exercises the real reconnection path, not just stop/start catch-up.
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
    // Access the underlying WebSocket on JsonRpcSocket and close it
    // WITHOUT setting closedByUser — this triggers the reconnect path.
    const ws = conn.socket['socket'] as WebSocket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }
}

describe('E2E: sync recovery after WebSocket drop', () => {
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

    // Start live sync and let it settle.
    harness.agent.sync.startSync({ mode: 'live', interval: '30s' });
    await new Promise(r => setTimeout(r, 2_000));
  }, 30_000);

  afterAll(async () => {
    try { await harness?.agent.sync.stopSync(); } catch { /* may already be stopped */ }
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('should recover from a dropped WebSocket and push outage records', async () => {
    // Phase 1: Verify sync is working — write a record and confirm it pushes.
    const data1 = Convert.string('before drop').toUint8Array();
    const write1 = await harness.agent.dwn.processRequest({
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
    expect(write1.reply.status.code).toBe(202);

    let deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline) {
      const q = await harness.agent.dwn.sendRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: todoProtocol.protocol, recordId: write1.message!.recordId } },
      });
      if (q.reply.entries?.length) { found = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(found).toBe(true);

    // Phase 2: Kill the WebSocket while sync stays logically live.
    killAllWebSockets();

    // Write a record during the outage — the local push subscription is
    // dead, but the record is in the EventLog.
    const data2 = Convert.string('during drop').toUint8Array();
    const write2 = await harness.agent.dwn.processRequest({
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
    expect(write2.reply.status.code).toBe(202);
    const outageRecordId = write2.message!.recordId;

    // Phase 3: Wait for auto-reconnect + SMT reconciliation to push
    // the outage record. JsonRpcSocket reconnect fires after ~1s
    // (exponential backoff), then the re-subscription triggers or the
    // integrity check reconciles.
    deadline = Date.now() + 15_000;
    found = false;
    while (Date.now() < deadline) {
      const q = await harness.agent.dwn.sendRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: todoProtocol.protocol, recordId: outageRecordId } },
      });
      if (q.reply.entries?.length) { found = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(found).toBe(true);
  }, 40_000);

  it('should report healthy sync after reconnection recovery', async () => {
    const health = await harness.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
  });
});
