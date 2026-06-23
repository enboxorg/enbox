import type { PermissionScope, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';

import type { BearerIdentity } from '../src/bearer-identity.js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Polls the target agent's local DWN until a record matching `recordId`
 * appears or `timeoutMs` is exceeded.  Used to verify live-sync delivery.
 */
async function waitForRecord(
  agent: PlatformAgentTestHarness['agent'],
  { did, protocol, recordId, timeoutMs = 5_000, intervalMs = 100, delegateDid, delegatedGrant }: {
    did: string;
    protocol: string;
    recordId: string;
    timeoutMs?: number;
    intervalMs?: number;
    delegateDid?: string;
    delegatedGrant?: any;
  }
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await agent.dwn.processRequest({
      author        : did,
      target        : did,
      granteeDid    : delegateDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol, recordId },
        ...(delegatedGrant ? { delegatedGrant } : {}),
      },
    });
    if (result.reply.status.code === 200 && result.reply.entries && result.reply.entries.length > 0) {
      return result.reply.entries[0];
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForRecord: record ${recordId} not found within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Protocol definitions
// ---------------------------------------------------------------------------

const protocolNotes: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/notes',
  types     : {
    note: {
      schema      : 'https://schemas.xyz/note',
      dataFormats : ['text/plain', 'application/json'],
    },
  },
  structure: { note: {} },
};

const protocolProfile: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/profile',
  types     : {
    entry: {
      schema      : 'https://schemas.xyz/profile-entry',
      dataFormats : ['application/json'],
    },
  },
  structure: { entry: {} },
};

// ---------------------------------------------------------------------------
// Grant helper — creates and distributes a grant from `grantor` to `grantee`
// on both the grantee's local DWN and the remote DWN.
// ---------------------------------------------------------------------------

async function createAndDistributeGrant(
  primaryHarness: PlatformAgentTestHarness,
  deviceHarness: PlatformAgentTestHarness,
  {
    grantor,
    grantee,
    scope,
    delegated,
  }: {
    grantor: BearerIdentity;
    grantee: BearerIdentity;
    scope: PermissionScope;
    delegated?: boolean;
  }
): Promise<{ grant: any; message: any }> {
  const grant = await primaryHarness.agent.permissions.createGrant({
    store       : true,
    author      : grantor.did.uri,
    grantedTo   : grantee.did.uri,
    dateExpires : Time.createOffsetTimestamp({ seconds: 600 }),
    delegated   : delegated ?? false,
    scope,
  });

  const { encodedData, ...grantMessage } = grant.message;
  const dataBlob = (): Blob => new Blob([Convert.base64Url(encodedData).toUint8Array()]);

  // 1. Store on the device agent's own tenant (signed as owner) so
  //    getPermissionForRequest() can find it via RecordsQuery.
  const ownerResult = await deviceHarness.agent.processDwnRequest({
    author      : grantee.did.uri,
    target      : grantee.did.uri,
    messageType : DwnInterface.RecordsWrite,
    rawMessage  : grantMessage,
    dataStream  : dataBlob(),
    signAsOwner : true,
  });
  expect(ownerResult.reply.status.code).toBe(202);

  // 2. Store on Alice's tenant in the device's LOCAL DWN so the DWN's
  //    authorization layer can find the grant when processing messages
  //    (e.g., MessagesSubscribe) for Alice's tenant.
  const tenantResult = await deviceHarness.agent.processDwnRequest({
    author      : grantee.did.uri,
    target      : grantor.did.uri,
    messageType : DwnInterface.RecordsWrite,
    rawMessage  : grantMessage,
    dataStream  : dataBlob(),
  });
  expect(tenantResult.reply.status.code).toBe(202);

  // 3. Store on the remote DWN so the server accepts delegate-signed requests.
  const remoteResult = await primaryHarness.agent.sendDwnRequest({
    author      : grantor.did.uri,
    target      : grantor.did.uri,
    messageType : DwnInterface.RecordsWrite,
    rawMessage  : grantMessage,
    dataStream  : dataBlob(),
  });
  expect(remoteResult.reply.status.code).toBe(202);

  return { grant, message: grantMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// NOTE — Remote DWN state isolation:
// The external DWN server at localhost:3000 accumulates state across all
// tests (there is no API to clear a tenant). Tests compensate by asserting
// record presence via recordId containment rather than exact counts. If
// more isolated fixtures are needed in the future, each describe block
// could create a fresh Alice identity (unique DID = clean remote tenant),
// at the cost of a DID:DHT publish round-trip per block.

describe('E2E Multi-Agent Sync', () => {
  /** Primary harness — the "canonical" agent that owns Alice's keys directly. */
  let primaryHarness: PlatformAgentTestHarness;

  /** Device harness — a separate agent process (Alice's second device). */
  let deviceHarness: PlatformAgentTestHarness;

  /** Alice's identity — created by the primary agent. */
  let alice: BearerIdentity;

  /** The device's connected identity (delegates of Alice). */
  let aliceDevice: BearerIdentity;

  /** Grants from Alice → aliceDevice. */
  let messagesReadGrant: { grant: any; message: any };
  let messagesQueryGrant: { grant: any; message: any };
  let recordsQueryGrant: { grant: any; message: any };
  let recordsWriteGrant: { grant: any; message: any };

  beforeAll(async () => {
    // -----------------------------------------------------------------------
    // Set up TWO independent agent instances.
    // -----------------------------------------------------------------------
    primaryHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-multi-agent-primary',
    });
    await primaryHarness.clearStorage();
    await primaryHarness.createAgentDid();

    deviceHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/e2e-multi-agent-device',
    });
    await deviceHarness.clearStorage();
    await deviceHarness.createAgentDid();

    // -----------------------------------------------------------------------
    // Create Alice's identity on the primary agent with DWN endpoints.
    // -----------------------------------------------------------------------
    alice = await primaryHarness.createIdentity({ name: 'Alice', testDwnUrls });

    // -----------------------------------------------------------------------
    // Create a connected identity on the device agent (delegates of Alice).
    // -----------------------------------------------------------------------
    aliceDevice = await deviceHarness.agent.identity.create({
      store     : true,
      didMethod : 'jwk',
      metadata  : { name: 'Alice Device', connectedDid: alice.did.uri },
    });

    // -----------------------------------------------------------------------
    // Install protocols on Alice's remote DWN.
    // -----------------------------------------------------------------------
    for (const def of [protocolNotes, protocolProfile]) {
      // Install locally on primary agent.
      await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: def },
      });
      // Install on remote DWN.
      await primaryHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: def },
      });
    }

    // -----------------------------------------------------------------------
    // Create and distribute grants from Alice → aliceDevice.
    // -----------------------------------------------------------------------

    // MessagesRead grant (covers MessagesSubscribe too via unified scope).
    messagesReadGrant = await createAndDistributeGrant(primaryHarness, deviceHarness, {
      grantor : alice,
      grantee : aliceDevice,
      scope   : { protocol: protocolNotes.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
    });

    // MessagesQuery grant.
    messagesQueryGrant = await createAndDistributeGrant(primaryHarness, deviceHarness, {
      grantor : alice,
      grantee : aliceDevice,
      scope   : { protocol: protocolNotes.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
    });

    // Records.Read grant authorizes RecordsQuery verification requests.
    recordsQueryGrant = await createAndDistributeGrant(primaryHarness, deviceHarness, {
      grantor   : alice,
      grantee   : aliceDevice,
      scope     : { protocol: protocolNotes.protocol, interface: DwnInterfaceName.Records, method: DwnMethodName.Read },
      delegated : true,
    });

    recordsWriteGrant = await createAndDistributeGrant(primaryHarness, deviceHarness, {
      grantor   : alice,
      grantee   : aliceDevice,
      scope     : { protocol: protocolNotes.protocol, interface: DwnInterfaceName.Records, method: DwnMethodName.Write },
      delegated : true,
    });
  });

  afterAll(async () => {
    // Stop any running sync engines before closing storage.
    try { await primaryHarness.agent.sync.stopSync(); } catch { /* best effort */ }
    try { await deviceHarness.agent.sync.stopSync(); } catch { /* best effort */ }

    await primaryHarness.clearStorage();
    await primaryHarness.closeStorage();
    await deviceHarness.clearStorage();
    await deviceHarness.closeStorage();
  });

  // =========================================================================
  // Poll-mode multi-agent sync
  // =========================================================================

  describe('poll-mode multi-agent sync', () => {
    beforeEach(async () => {
      await primaryHarness.agent.sync.stopSync();
      await deviceHarness.agent.sync.stopSync();

      // Clear only sync state on primary (preserve key material and protocols).
      await primaryHarness.syncStore.clear();
      await primaryHarness.agent.permissions.clear();

      // Clear device DWN stores fully — it uses memory stores so keys survive.
      await deviceHarness.dwnDataStore.clear();
      await deviceHarness.dwnMessageStore.clear();
      await deviceHarness.dwnResumableTaskStore.clear();
      await deviceHarness.syncStore.clear();
      await deviceHarness.agent.permissions.clear();
      deviceHarness.dwnStores.clear();

      // Re-distribute grants to device agent after its store clear.
      // Each grant must be stored on BOTH the device's own tenant (for
      // getPermissionForRequest) AND Alice's tenant (for DWN authorization).
      for (const g of [messagesReadGrant, messagesQueryGrant, recordsQueryGrant, recordsWriteGrant]) {
        const data = g.grant.message.encodedData;
        const dataBlob = (): Blob => new Blob([Convert.base64Url(data).toUint8Array()]);
        await deviceHarness.agent.processDwnRequest({
          author      : aliceDevice.did.uri,
          target      : aliceDevice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : g.message,
          dataStream  : dataBlob(),
          signAsOwner : true,
        });
        await deviceHarness.agent.processDwnRequest({
          author      : aliceDevice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : g.message,
          dataStream  : dataBlob(),
        });
      }
    });

    it('should push from primary agent and pull on device agent', async () => {
      // Primary agent writes a note locally.
      const writeResult = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'text/plain',
          protocol     : protocolNotes.protocol,
          protocolPath : 'note',
          schema       : protocolNotes.types.note.schema,
        },
        dataStream: new Blob(['Hello from primary agent']),
      });
      expect(writeResult.reply.status.code).toBe(202);
      const recordId = writeResult.message!.recordId;

      // Primary agent registers Alice and syncs (push to remote).
      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await primaryHarness.agent.sync.sync('push');

      // Verify record is on the remote DWN.
      const remoteQuery = await primaryHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: protocolNotes.protocol } },
      });
      expect(remoteQuery.reply.status.code).toBe(200);
      const remoteRecordIds = remoteQuery.reply.entries?.map(e => e.recordId);
      expect(remoteRecordIds).toContain(recordId);

      // Device agent registers Alice with protocol-scoped delegate sync.
      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [protocolNotes.protocol],
          delegateDid : aliceDevice.did.uri,
        },
      });
      await deviceHarness.agent.sync.sync('pull');

      // Verify record arrived on the device agent's local DWN.
      const localQuery = await deviceHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        granteeDid    : aliceDevice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          delegatedGrant : recordsQueryGrant.grant.message,
          filter         : { protocol: protocolNotes.protocol },
        },
      });
      expect(localQuery.reply.status.code).toBe(200);
      expect(localQuery.reply.entries).toHaveLength(1);
      expect(localQuery.reply.entries![0].recordId).toBe(recordId);
    });

    it('should only pull records matching the scoped protocol', async () => {
      // Primary writes to both notes and profile protocols.
      const noteWrite = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'text/plain',
          protocol     : protocolNotes.protocol,
          protocolPath : 'note',
          schema       : protocolNotes.types.note.schema,
        },
        dataStream: new Blob(['A note']),
      });
      expect(noteWrite.reply.status.code).toBe(202);

      const profileWrite = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'application/json',
          protocol     : protocolProfile.protocol,
          protocolPath : 'entry',
          schema       : protocolProfile.types.entry.schema,
        },
        dataStream: new Blob([JSON.stringify({ name: 'Alice' })]),
      });
      expect(profileWrite.reply.status.code).toBe(202);

      // Push both to remote.
      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await primaryHarness.agent.sync.sync('push');

      // Device agent has grants ONLY for notes protocol.
      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [protocolNotes.protocol],
          delegateDid : aliceDevice.did.uri,
        },
      });
      await deviceHarness.agent.sync.sync('pull');

      // Notes record should be present.
      const notesQuery = await deviceHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        granteeDid    : aliceDevice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          delegatedGrant : recordsQueryGrant.grant.message,
          filter         : { protocol: protocolNotes.protocol },
        },
      });
      expect(notesQuery.reply.status.code).toBe(200);
      const notesRecordIds = notesQuery.reply.entries!.map(e => e.recordId);
      expect(notesRecordIds).toContain(noteWrite.message!.recordId);

      // Profile records should NOT be present (no grant, no sync scope).
      // Construct the query on the primary harness (which has Alice's signing
      // keys) and execute the raw message on the device's local DWN.
      const profileQueryConstructed = await primaryHarness.agent.dwn.processRequest({
        store         : false,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: protocolProfile.protocol } },
      });
      const profileQuery = await deviceHarness.agent.dwn.processRequest({
        author      : alice.did.uri,
        target      : alice.did.uri,
        messageType : DwnInterface.RecordsQuery,
        rawMessage  : profileQueryConstructed.message,
      });
      // The specific profile record from this test should not have been synced.
      const profileRecordIds = profileQuery.reply.entries?.map(e => e.recordId) ?? [];
      expect(profileRecordIds).not.toContain(profileWrite.message!.recordId);
    });

    it('pushes delegated local writes without the owner signing key', async () => {
      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [protocolNotes.protocol],
          delegateDid : aliceDevice.did.uri,
        },
      });

      const writeResult = await deviceHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        granteeDid    : aliceDevice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat     : 'text/plain',
          delegatedGrant : recordsWriteGrant.grant.message,
          protocol       : protocolNotes.protocol,
          protocolPath   : 'note',
          schema         : protocolNotes.types.note.schema,
        },
        dataStream: new Blob(['Delegate-authored note']),
      });
      expect(writeResult.reply.status.code).toBe(202);

      await deviceHarness.agent.sync.sync('push');

      const remoteQuery = await primaryHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { recordId: writeResult.message!.recordId } },
      });
      expect(remoteQuery.reply.status.code).toBe(200);
      expect(remoteQuery.reply.entries?.map(e => e.recordId)).toContain(writeResult.message!.recordId);
    });
  });

  // =========================================================================
  // Live-mode multi-agent sync
  // =========================================================================

  describe('live-mode multi-agent sync', () => {
    beforeEach(async () => {
      await primaryHarness.agent.sync.stopSync();
      await deviceHarness.agent.sync.stopSync();

      // Clear only sync state on primary (preserve key material and protocols).
      await primaryHarness.syncStore.clear();
      await primaryHarness.agent.permissions.clear();

      // Clear device DWN stores fully — it uses memory stores so keys survive.
      await deviceHarness.dwnDataStore.clear();
      await deviceHarness.dwnMessageStore.clear();
      await deviceHarness.dwnResumableTaskStore.clear();
      await deviceHarness.syncStore.clear();
      await deviceHarness.agent.permissions.clear();
      deviceHarness.dwnStores.clear();

      // Re-distribute grants to device agent after its store clear.
      // Each grant must be stored on BOTH the device's own tenant (for
      // getPermissionForRequest) AND Alice's tenant (for DWN authorization).
      for (const g of [messagesReadGrant, messagesQueryGrant, recordsQueryGrant, recordsWriteGrant]) {
        const data = g.grant.message.encodedData;
        const dataBlob = (): Blob => new Blob([Convert.base64Url(data).toUint8Array()]);
        await deviceHarness.agent.processDwnRequest({
          author      : aliceDevice.did.uri,
          target      : aliceDevice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : g.message,
          dataStream  : dataBlob(),
          signAsOwner : true,
        });
        await deviceHarness.agent.processDwnRequest({
          author      : aliceDevice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          rawMessage  : g.message,
          dataStream  : dataBlob(),
        });
      }
    });

    it('should deliver a record in real-time from primary to device via remote DWN', async () => {
      // Register identities on both agents.
      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [protocolNotes.protocol],
          delegateDid : aliceDevice.did.uri,
        },
      });

      // Start live sync on BOTH agents.
      await primaryHarness.agent.sync.startSync({ mode: 'live', interval: '60s' });
      await deviceHarness.agent.sync.startSync({ mode: 'live', interval: '60s' });

      // Give subscriptions a moment to establish.
      await new Promise(r => setTimeout(r, 500));

      // Primary agent writes a note locally.
      const writeResult = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'text/plain',
          protocol     : protocolNotes.protocol,
          protocolPath : 'note',
          schema       : protocolNotes.types.note.schema,
        },
        dataStream: new Blob(['Live sync note']),
      });
      expect(writeResult.reply.status.code).toBe(202);
      const recordId = writeResult.message!.recordId;

      // Wait for the record to appear on the device agent's local DWN.
      // Path: local write → push subscription → debounce → HTTP push to remote
      // → remote EventLog emits → WebSocket delivers to device → processRawMessage.
      const received = await waitForRecord(deviceHarness.agent, {
        did            : alice.did.uri,
        protocol       : protocolNotes.protocol,
        recordId,
        delegateDid    : aliceDevice.did.uri,
        delegatedGrant : recordsQueryGrant.grant.message,
        timeoutMs      : 10_000,
      });
      expect(received.recordId).toBe(recordId);

      // Clean up.
      await primaryHarness.agent.sync.stopSync();
      await deviceHarness.agent.sync.stopSync();
    });

    it('should handle multiple sequential writes in live mode', async () => {
      // Register and start live sync.
      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [protocolNotes.protocol],
          delegateDid : aliceDevice.did.uri,
        },
      });
      await primaryHarness.agent.sync.startSync({ mode: 'live', interval: '60s' });
      await deviceHarness.agent.sync.startSync({ mode: 'live', interval: '60s' });
      await new Promise(r => setTimeout(r, 500));

      // Write 3 records in quick succession.
      const recordIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await primaryHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocolNotes.protocol,
            protocolPath : 'note',
            schema       : protocolNotes.types.note.schema,
          },
          dataStream: new Blob([`Note ${i}`]),
        });
        expect(result.reply.status.code).toBe(202);
        recordIds.push(result.message!.recordId);
      }

      // Wait for all 3 records to appear on device.
      for (const recordId of recordIds) {
        await waitForRecord(deviceHarness.agent, {
          did            : alice.did.uri,
          protocol       : protocolNotes.protocol,
          recordId,
          delegateDid    : aliceDevice.did.uri,
          delegatedGrant : recordsQueryGrant.grant.message,
          timeoutMs      : 8_000,
        });
      }

      // Verify all 3 are present.
      const queryResult = await deviceHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        granteeDid    : aliceDevice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          delegatedGrant : recordsQueryGrant.grant.message,
          filter         : { protocol: protocolNotes.protocol },
        },
      });
      expect(queryResult.reply.status.code).toBe(200);
      const foundIds = queryResult.reply.entries!.map(e => e.recordId);
      // Verify all 3 record IDs from this test are present (remote DWN
      // may also contain records from prior tests).
      for (const rid of recordIds) {
        expect(foundIds).toContain(rid);
      }

      await primaryHarness.agent.sync.stopSync();
      await deviceHarness.agent.sync.stopSync();
    });

    it('should only deliver protocol-scoped records in live mode', async () => {
      // Register primary with full sync, device with only notes protocol.
      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [protocolNotes.protocol],
          delegateDid : aliceDevice.did.uri,
        },
      });
      await primaryHarness.agent.sync.startSync({ mode: 'live', interval: '60s' });
      await deviceHarness.agent.sync.startSync({ mode: 'live', interval: '60s' });
      await new Promise(r => setTimeout(r, 500));

      // Write to notes protocol.
      const noteResult = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'text/plain',
          protocol     : protocolNotes.protocol,
          protocolPath : 'note',
          schema       : protocolNotes.types.note.schema,
        },
        dataStream: new Blob(['Scoped note']),
      });
      expect(noteResult.reply.status.code).toBe(202);

      // Write to profile protocol.
      const profileResult = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'application/json',
          protocol     : protocolProfile.protocol,
          protocolPath : 'entry',
          schema       : protocolProfile.types.entry.schema,
        },
        dataStream: new Blob([JSON.stringify({ name: 'Alice' })]),
      });
      expect(profileResult.reply.status.code).toBe(202);

      // Wait for the note to arrive on device.
      await waitForRecord(deviceHarness.agent, {
        did            : alice.did.uri,
        protocol       : protocolNotes.protocol,
        recordId       : noteResult.message!.recordId,
        delegateDid    : aliceDevice.did.uri,
        delegatedGrant : recordsQueryGrant.grant.message,
        timeoutMs      : 5_000,
      });

      // Wait a bit extra to ensure profile record does NOT arrive.
      await new Promise(r => setTimeout(r, 1_500));

      // Profile query — should find nothing on device.
      // Construct query on primary (has Alice's keys), execute on device DWN.
      const profileQueryConstructed = await primaryHarness.agent.dwn.processRequest({
        store         : false,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: protocolProfile.protocol } },
      });
      const profileQuery = await deviceHarness.agent.dwn.processRequest({
        author      : alice.did.uri,
        target      : alice.did.uri,
        messageType : DwnInterface.RecordsQuery,
        rawMessage  : profileQueryConstructed.message,
      });
      expect(profileQuery.reply.entries?.length ?? 0).toBe(0);

      await primaryHarness.agent.sync.stopSync();
      await deviceHarness.agent.sync.stopSync();
    });
  });
});
