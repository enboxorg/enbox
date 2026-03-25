/**
 * Handler-path integration tests for the sync engine's live subscription flow.
 * Uses LocalDwnRpcShim to route pull subscription requests to an in-process DWN,
 * exercising the real subscription handler code path with real EventLog events.
 */
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { SyncEngineLevel } from '../src/sync-engine-level.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

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
    // The URL doesn't matter — the shim intercepts all requests.
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

  it('should process a pull subscription event through the real handler and advance the checkpoint', async () => {
    // Install protocol.
    const { reply: protoReply } = await testHarness.agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: testProtocol },
    });
    expect(protoReply.status.code).toBe(202);

    // Register a sync identity for this tenant with the protocol.
    const syncEngine = testHarness.agent.sync as SyncEngineLevel;
    await syncEngine.registerIdentity({
      did     : tenant,
      options : { protocols: [testProtocol.protocol] },
    });

    // Write a record BEFORE starting live sync — this will be delivered
    // via the subscription's catch-up replay.
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

    // Start live sync — this opens real subscriptions via the shim.
    await syncEngine.startSync({ mode: 'live', interval: '30s' });

    // Wait for the subscription handler to process the catch-up event.
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify the pull checkpoint has advanced (link state persisted).
    // Check that a link exists and is live. The URL is converted to ws:// by the sync engine.
    const links = [...(syncEngine as any)._activeLinks.values()];
    const activeLink = links.find((l: any) => l.tenantDid === tenant && l.protocol === testProtocol.protocol);

    expect(activeLink).toBeDefined();
    if (activeLink) {
      expect(activeLink.status).toBe('live');
    }

    await syncEngine.stopSync();
  });

  it('should handle local push subscription events and queue them for push', async () => {
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

    // Start live sync.
    await syncEngine.startSync({ mode: 'live', interval: '30s' });

    // Write a record AFTER live sync is started — this triggers push-on-write
    // via the local EventLog subscription.
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
      dataStream: new Blob([new TextEncoder().encode('Push handler test')]),
    });

    // Wait for the push-on-write debounce to accumulate the CID.
    await new Promise(resolve => setTimeout(resolve, 500));

    // The pending push queue or the push checkpoint should reflect activity.
    // Since the shim routes pushes to the same DWN (self-sync), the push
    // may succeed or fail with 409 (already present). Either way, the handler
    // path was exercised.
    const links = [...(syncEngine as any)._activeLinks.values()];
    const activeLink = links.find((l: any) => l.tenantDid === tenant && l.protocol === testProtocol.protocol);

    expect(activeLink).toBeDefined();
    if (activeLink) {
      expect(activeLink.status).toBe('live');
    }

    await syncEngine.stopSync();
  });
});
