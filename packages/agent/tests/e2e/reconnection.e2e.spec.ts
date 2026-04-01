/**
 * E2E: Sync recovery after disruption.
 *
 * Simulates a sync disruption by stopping and restarting live sync.
 * Records written during the outage should be pushed to the remote
 * when sync resumes — proving the SMT reconciliation catch-up works.
 *
 * Also verifies that getSyncHealth() reports healthy state after
 * recovery, including zero dead letters and no degraded links.
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

describe('E2E: sync recovery after disruption', () => {
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
  }, 30_000);

  afterAll(async () => {
    try { await harness?.agent.sync.stopSync(); } catch { /* may already be stopped */ }
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  it('should push records written during outage after sync resumes', async () => {
    // Phase 1: Start sync and verify initial push works.
    harness.agent.sync.startSync({ mode: 'live', interval: '30s' });
    await new Promise(r => setTimeout(r, 2_000));

    const dataBytes1 = Convert.string('task before outage').toUint8Array();
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
      dataStream: new Blob([dataBytes1]),
    });
    expect(write1.reply.status.code).toBe(202);

    // Wait for live push to deliver it.
    const deadline1 = Date.now() + 10_000;
    let found1 = false;
    while (Date.now() < deadline1) {
      const remote = await harness.agent.dwn.sendRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: todoProtocol.protocol, recordId: write1.message!.recordId } },
      });
      if (remote.reply.entries?.length) { found1 = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(found1).toBe(true);

    // Phase 2: Stop sync (simulates network disruption).
    await harness.agent.sync.stopSync();

    // Write a record while sync is stopped.
    const dataBytes2 = Convert.string('task during outage').toUint8Array();
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
      dataStream: new Blob([dataBytes2]),
    });
    expect(write2.reply.status.code).toBe(202);
    const outageRecordId = write2.message!.recordId;

    // Verify it does NOT exist on the remote yet.
    const beforeResume = await harness.agent.dwn.sendRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { protocol: todoProtocol.protocol, recordId: outageRecordId } },
    });
    expect(beforeResume.reply.entries?.length ?? 0).toBe(0);

    // Phase 3: Resume sync — the initial SMT reconciliation should push
    // the outage record.
    harness.agent.sync.startSync({ mode: 'live', interval: '30s' });

    const deadline2 = Date.now() + 10_000;
    let found2 = false;
    while (Date.now() < deadline2) {
      const remote = await harness.agent.dwn.sendRequest({
        author        : did,
        target        : did,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: todoProtocol.protocol, recordId: outageRecordId } },
      });
      if (remote.reply.entries?.length) { found2 = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(found2).toBe(true);
  }, 40_000);

  it('should report healthy sync after recovery', async () => {
    const health = await harness.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
    expect(health.degradedLinkCount).toBe(0);
  });
});
