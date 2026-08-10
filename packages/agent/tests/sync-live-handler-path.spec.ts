/**
 * Handler-path integration tests for the sync engine's live subscription flow.
 * Uses LocalDwnRpcShim to route pull subscription requests to an in-process DWN,
 * exercising the real subscription handler code path with real EventLog events.
 *
 * These tests assert actual durable-feed behavior, not just "link is live."
 */
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { SyncEngineLevel } from '../src/sync-engine-level.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { queryRemoteMessageFeed } from '../src/sync-messages.js';
import { TestAgent } from './utils/test-agent.js';

/**
 * Poll a condition until it becomes true or timeout expires.
 * Avoids fixed sleeps that are brittle on slow/fast CI runners.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 3000,
  intervalMs: number = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) { return; }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('sync live handler path — real subscriptions via LocalDwnRpcShim', () => {
  let testHarness: PlatformAgentTestHarness;
  let tenant: string;

  const testProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://example.com/handler-test',
    types     : {
      note: {
        schema      : 'https://schemas.example.com/note',
        dataFormats : ['text/plain'],
      },
    },
    structure: {
      note: {},
    },
  };

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/sync-live-handler-path',
    });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an identity with DWN endpoint URLs so getSyncTargets can resolve them.
    const alice = await testHarness.createIdentity({
      name        : 'Alice',
      testDwnUrls : ['http://localhost:9999'],
    });
    tenant = alice.did.uri;

    // Wire the local DWN RPC shim so pull subscriptions route to the in-process DWN.
    const localRpc = createLocalDwnRpc(testHarness.dwn);
    (testHarness.agent as any).rpc = localRpc;
  });

  beforeEach(async () => {
    await testHarness.clearDwnStores();
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('should query the durable feed through the local RPC shim', async () => {
    const { reply: protoReply } = await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: testProtocol },
    });
    expect(protoReply.status.code).toBe(202);

    const { messageCid: writeMessageCid, reply: writeReply } = await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : testProtocol.protocol,
        protocolPath : 'note',
        dataFormat   : 'text/plain',
        schema       : 'https://schemas.example.com/note',
      },
      dataStream: new Blob([new TextEncoder().encode('feed query through shim')]),
    });
    expect(writeReply.status.code).toBe(202);

    const reply = await queryRemoteMessageFeed({
      did      : tenant,
      dwnUrl   : 'http://localhost:9999',
      filters  : [{ protocol: testProtocol.protocol }],
      limit    : 10,
      cidsOnly : true,
      agent    : testHarness.agent,
    });

    expect(reply.status.code).toBe(200);
    expect(reply.entries?.some(entry => entry.messageCid === writeMessageCid)).toBe(true);
    expect(reply.entries?.every(entry => entry.message === undefined)).toBe(true);
    expect(reply.cursor?.position).toBeDefined();
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
  });

  it('should advance the durable pull checkpoint after a live event wakes reconciliation', async () => {
    const syncEngine = testHarness.agent.sync as SyncEngineLevel;
    await syncEngine.setIdentityOptions({
      did     : tenant,
      options : { protocols: 'all' },
    });

    // Start live sync FIRST — this opens real cursorless wake subscriptions
    // via the shim. Durable queries, not subscription replay, own catch-up.
    await syncEngine.startSync({ interval: '30s' });

    const { reply: protoReply } = await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: testProtocol },
    });
    expect(protoReply.status.code).toBe(202);

    // Write a record AFTER sync starts — this triggers a live event
    // through the EventLog subscription and wakes a durable pull pass.
    const { reply: writeReply } = await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : testProtocol.protocol,
        protocolPath : 'note',
        dataFormat   : 'text/plain',
        schema       : 'https://schemas.example.com/note',
      },
      dataStream: new Blob([new TextEncoder().encode('Handler path test')]),
    });
    expect(writeReply.status.code).toBe(202);

    // Poll until the durable pull query advances its checkpoint. The
    // subscription event itself carries no progress authority.
    const links = (): any[] => [...(syncEngine as any)._linkControllers.values()]
      .map((controller: any): any => controller.link);
    const getLink = (): any => links().find((link: any) =>
      link.tenantDid === tenant &&
      link.scope?.kind === 'full'
    );

    await waitFor(() => {
      const link = getLink();
      return link?.pull?.contiguousAppliedToken?.messageCid !== undefined && link.status === 'live';
    }, 5000);

    const activeLink = getLink();
    expect(activeLink).toBeDefined();
    expect(activeLink.status).toBe('live');
    // The checkpoint came from MessagesQuery after durable admission, not from
    // the subscription event cursor.
    expect(activeLink.pull.contiguousAppliedToken).toBeDefined();
    expect(activeLink.pull.contiguousAppliedToken.position).toBeDefined();
    expect(activeLink.pull.contiguousAppliedToken.messageCid).toBeDefined();

    await syncEngine.stopSync();
  });

});
