/**
 * Handler-path integration tests for the sync engine's live subscription flow.
 * Uses LocalDwnRpcShim to route pull subscription requests to an in-process DWN,
 * exercising the real subscription handler code path with real EventLog events.
 *
 * These tests assert actual behavioral outcomes (checkpoint advancement,
 * echo-suppression entries), not just "link is live."
 */
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { SyncEngineLevel } from '../src/sync-engine-level.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
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

  it('should advance pull checkpoint after processing a live event through the real handler', async () => {
    // Install protocol.
    const { reply: protoReply } = await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: testProtocol },
    });
    expect(protoReply.status.code).toBe(202);

    const syncEngine = testHarness.agent.sync as SyncEngineLevel;
    await syncEngine.registerIdentity({
      did     : tenant,
      options : { protocols: [testProtocol.protocol] },
    });

    // Start live sync FIRST — this opens real subscriptions via the shim.
    // Without a prior cursor, the subscription is live-only (no catch-up).
    await syncEngine.startSync({ mode: 'live', interval: '30s' });

    // Write a record AFTER sync starts — this triggers a live event
    // through the EventLog subscription, delivered to the pull handler.
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

    // Poll until the pull checkpoint has advanced — proves the handler
    // actually processed the live event via processRawMessage.
    const links = (): any[] => [...(syncEngine as any)._activeLinks.values()];
    const getLink = (): any => links().find((l: any) => l.tenantDid === tenant && l.protocol === testProtocol.protocol);

    await waitFor(() => {
      const link = getLink();
      return link?.pull?.contiguousAppliedToken?.position !== undefined;
    });

    const activeLink = getLink();
    expect(activeLink).toBeDefined();
    expect(activeLink.status).toBe('live');
    // The pull checkpoint MUST have advanced — this proves processRawMessage ran
    // and the ordinal drain committed the token.
    expect(activeLink.pull.contiguousAppliedToken).toBeDefined();
    expect(activeLink.pull.contiguousAppliedToken.position).toBeDefined();
    expect(activeLink.pull.contiguousAppliedToken.messageCid).toBeDefined();

    // receivedToken should also be set (for observability).
    expect(activeLink.pull.receivedToken).toBeDefined();

    await syncEngine.stopSync();
  });

  it('should populate echo-suppression cache after pull handler processes an event', async () => {
    // Install protocol.
    await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: testProtocol },
    });

    const syncEngine = testHarness.agent.sync as SyncEngineLevel;
    await syncEngine.registerIdentity({
      did     : tenant,
      options : { protocols: [testProtocol.protocol] },
    });

    // Start sync first, then write — so the event fires as a live event.
    await syncEngine.startSync({ mode: 'live', interval: '30s' });

    await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : testProtocol.protocol,
        protocolPath : 'note',
        dataFormat   : 'text/plain',
        schema       : 'https://schemas.example.com/note',
      },
      dataStream: new Blob([new TextEncoder().encode('Echo test')]),
    });

    // Poll until echo-suppression cache has at least one entry — proves
    // the pull handler ran and recorded the CID for echo-loop prevention.
    const echoCache = (syncEngine as any)._recentlyPulledCids as Map<string, number>;

    await waitFor(() => echoCache.size > 0);

    expect(echoCache.size).toBeGreaterThan(0);

    // The echo entry should be keyed by cid|dwnUrl.
    const firstKey = [...echoCache.keys()][0];
    expect(firstKey).toContain('|');

    await syncEngine.stopSync();
  });
});
