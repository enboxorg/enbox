import type { BearerIdentity } from '../src/bearer-identity.js';
import type { DwnDataEncodedRecordsWriteMessage } from '../src/types/dwn.js';
import type { EnboxConnectResponse } from '../src/enbox-connect-protocol.js';
import type { PrivateKeyJwk } from '@enbox/crypto';
import type { GenericMessage, MessagesQueryReplyEntry, PermissionScope, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { createGrantKeyRecordsForGrants } from '../src/dwn-encryption.js';
import { DidJwk } from '@enbox/dids';
import { DwnInterface } from '../src/types/dwn.js';
import { DwnPermissionGrant } from '../src/types/dwn.js';
import { Ed25519 } from '@enbox/crypto';
import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { requireDwnServer } from './utils/require-dwn-server.js';
import { retryFreshDidResolution } from './utils/remote-dwn-retry.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, DwnInterfaceName, DwnMethodName, EncryptionProtocol, Time } from '@enbox/dwn-sdk-js';

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

async function importConnectGrants(
  harness: PlatformAgentTestHarness,
  connectedDid: string,
  delegateDid: string,
  grants: DwnDataEncodedRecordsWriteMessage[],
): Promise<void> {
  for (const grant of grants) {
    const { encodedData, ...rawMessage } = grant;
    const grantBytes = Convert.base64Url(encodedData).toUint8Array();
    const delegateResult = await harness.agent.processDwnRequest({
      author      : delegateDid,
      target      : delegateDid,
      messageType : DwnInterface.RecordsWrite,
      rawMessage,
      dataStream  : new Blob([grantBytes as BlobPart]),
      signAsOwner : true,
    });
    expect([202, 409]).toContain(delegateResult.reply.status.code);

    const connectedResult = await harness.agent.dwn.processRawMessage(
      connectedDid,
      rawMessage as GenericMessage,
      { dataStream: DataStream.fromBytes(grantBytes) },
    );
    expect([202, 409]).toContain(connectedResult.status.code);
  }
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
  beforeAll(async () => {
    await requireDwnServer();
  });

  /** Primary harness — the "canonical" agent that owns Alice's keys directly. */
  let primaryHarness: PlatformAgentTestHarness;

  /** Device harness — a separate agent process (Alice's second device). */
  let deviceHarness: PlatformAgentTestHarness;

  /** Alice's identity — created by the primary agent. */
  let alice: BearerIdentity;

  /** The device's connected identity (delegates of Alice). */
  let aliceDevice: BearerIdentity;
  let aliceDeviceX25519PrivateKey: PrivateKeyJwk;

  /** Grants from Alice → aliceDevice. */
  let messagesReadGrant: { grant: any; message: any };
  let messagesQueryGrant: { grant: any; message: any };
  let recordsQueryGrant: { grant: any; message: any };
  let recordsWriteGrant: { grant: any; message: any };

  /** Alice-authored notes-protocol configuration, mirrored onto the device. */
  let notesProtocolConfigure: GenericMessage;

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
    // Role-audience provisioning persists generated audience private keys through the agent secret store.
    await primaryHarness.agent.vault.initialize({ password: 'e2e-multi-agent-sync-primary' });

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
    const aliceDevicePortableDid = await aliceDevice.did.export();
    aliceDeviceX25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
      privateKey: aliceDevicePortableDid.privateKeys![0],
    }) as PrivateKeyJwk;
    await deviceHarness.agent.keyManager.importKey({ key: aliceDeviceX25519PrivateKey });

    // -----------------------------------------------------------------------
    // Install protocols on Alice's remote DWN.
    // -----------------------------------------------------------------------
    for (const def of [protocolNotes, protocolProfile]) {
      // Install locally on primary agent.
      const { message } = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: def },
      });
      if (def.protocol === protocolNotes.protocol) {
        notesProtocolConfigure = message as GenericMessage;
      }
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

      // Mirror Alice's notes protocol into the device's copy of Alice's tenant
      // (signed as owner) so the delegate can author notes records locally —
      // exactly as the connect flow seeds protocols on a wallet-connected dapp.
      await deviceHarness.agent.dwn.processRequest({
        author      : alice.did.uri,
        target      : alice.did.uri,
        messageType : DwnInterface.ProtocolsConfigure,
        rawMessage  : notesProtocolConfigure,
        signAsOwner : true,
      });
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

    it('pulls durable grantKey records and decrypts encrypted records without owner keys', async () => {
      const encryptedProtocol: ProtocolDefinition = {
        published : true,
        protocol  : `https://protocol.xyz/encrypted-sync-notes/${crypto.randomUUID()}`,
        types     : {
          note: {
            schema             : 'https://schemas.xyz/encrypted-sync-note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };

      const localProtocolConfigure = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedProtocol },
        encryption    : true,
      });
      expect(localProtocolConfigure.reply.status.code).toBe(202);

      const remoteProtocolConfigure = await primaryHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: encryptedProtocol },
        encryption    : true,
      });
      expect([202, 409]).toContain(remoteProtocolConfigure.reply.status.code);

      const deviceProtocolConfigure = await deviceHarness.agent.dwn.processRawMessage(
        alice.did.uri,
        localProtocolConfigure.message as GenericMessage,
      );
      expect([202, 409]).toContain(deviceProtocolConfigure.status.code);

      await createAndDistributeGrant(primaryHarness, deviceHarness, {
        grantor : alice,
        grantee : aliceDevice,
        scope   : { protocol: encryptedProtocol.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
      });
      const recordsReadGrant = await createAndDistributeGrant(primaryHarness, deviceHarness, {
        grantor   : alice,
        grantee   : aliceDevice,
        scope     : { protocol: encryptedProtocol.protocol, interface: DwnInterfaceName.Records, method: DwnMethodName.Read },
        delegated : true,
      });
      const recordsReadGrantId = recordsReadGrant.grant.grant.id;
      expect(recordsReadGrantId).toBe(recordsReadGrant.message.recordId);

      const grantKeyRecords = await createGrantKeyRecordsForGrants({
        agent                 : primaryHarness.agent,
        ownerDid              : alice.did.uri,
        granteeDid            : aliceDevice.did.uri,
        granteeRootPrivateKey : aliceDeviceX25519PrivateKey,
        grantMessages         : [recordsReadGrant.grant.message],
      });
      expect(grantKeyRecords).toHaveLength(1);

      const noteText = 'encrypted sync note decrypted from durable grantKey';
      const writeResult = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'text/plain',
          protocol     : encryptedProtocol.protocol,
          protocolPath : 'note',
          schema       : encryptedProtocol.types.note.schema,
        },
        dataStream : new Blob([noteText]),
        encryption : true,
      });
      expect(writeResult.reply.status.code).toBe(202);
      const recordId = writeResult.message!.recordId;

      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await primaryHarness.agent.sync.sync('push');

      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [encryptedProtocol.protocol],
          delegateDid : aliceDevice.did.uri,
        },
      });
      await deviceHarness.agent.sync.sync('pull');

      const grantKeyQuery = await deviceHarness.agent.dwn.processRequest({
        author        : aliceDevice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recipient    : aliceDevice.did.uri,
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.grantKeyPath,
            tags         : { protocol: encryptedProtocol.protocol },
          },
        },
      });
      expect(grantKeyQuery.reply.status.code).toBe(200);
      expect(grantKeyQuery.reply.entries?.map(entry => entry.recordId)).toContain(grantKeyRecords[0].recordId);

      deviceHarness.agent.dwn.clearDelegateDecryptionKeys(aliceDevice.did.uri);
      expect(await deviceHarness.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();

      const readResult = await deviceHarness.agent.dwn.processRequest({
        author        : aliceDevice.did.uri,
        target        : alice.did.uri,
        granteeDid    : aliceDevice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter            : { recordId },
          permissionGrantId : recordsReadGrantId,
        },
        encryption: true,
      });
      expect(readResult.reply.status.code).toBe(200);
      expect(readResult.reply.entry?.data).toBeDefined();

      const decryptedBytes = await DataStream.toBytes(readResult.reply.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(noteText);
    }, 60_000);

    it('uses connect-created grantKey records after sync without importing in-band decryption keys', async () => {
      const encryptedProtocol: ProtocolDefinition = {
        published : true,
        protocol  : `https://protocol.xyz/connect-encrypted-sync-notes/${crypto.randomUUID()}`,
        types     : {
          note: {
            schema             : 'https://schemas.xyz/connect-encrypted-sync-note',
            dataFormats        : ['text/plain'],
            encryptionRequired : true,
          },
        },
        structure: { note: {} },
      };
      const readScopes: PermissionScope[] = [
        { protocol: encryptedProtocol.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
        { protocol: encryptedProtocol.protocol, interface: DwnInterfaceName.Records, method: DwnMethodName.Read },
      ];
      const clientDid = await DidJwk.create();
      const callbackUrl = 'http://localhost:3000/connect-callback';
      const connectRequest = await EnboxConnectProtocol.createConnectRequest({
        appName            : 'Encrypted Sync E2E',
        clientDid          : clientDid.uri,
        permissionRequests : [{ protocolDefinition: encryptedProtocol, permissionScopes: readScopes }],
        callbackUrl,
      });
      const remoteReadiness = await retryFreshDidResolution(() => primaryHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: encryptedProtocol.protocol } },
      }));
      expect(remoteReadiness.reply.status.code).toBe(200);
      const ownerDwnEndpoints = await primaryHarness.agent.dwn.getDwnEndpointUrlsForTarget(alice.did.uri);
      expect(ownerDwnEndpoints).toContain(testDwnUrl);

      let idToken: string | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input) !== callbackUrl) {
          return originalFetch(input, init);
        }
        const body = new URLSearchParams(init?.body as string);
        idToken = body.get('id_token') ?? undefined;
        expect(body.get('state')).toBe(connectRequest.state);
        return new Response();
      }) as typeof fetch;
      try {
        await EnboxConnectProtocol.submitConnectResponse(
          alice.did.uri,
          connectRequest,
          '2468',
          primaryHarness.agent,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(idToken).toBeDefined();

      const responseJwt = await EnboxConnectProtocol.decryptResponse(clientDid, idToken!, '2468');
      const connectResponse = await EnboxConnectProtocol.verifyJwt({
        jwt: responseJwt,
      }) as EnboxConnectResponse;
      expect(connectResponse.providerDid).toBe(alice.did.uri);
      expect(connectResponse.delegatePortableDid.uri).toBe(connectResponse.delegateDid);
      expect(connectResponse.delegateDecryptionKeys?.length).toBeGreaterThan(0);

      const recordsReadGrant = connectResponse.delegateGrants.find((grant) => {
        const parsedGrant = DwnPermissionGrant.parse(grant);
        return parsedGrant.scope.interface === DwnInterfaceName.Records &&
          parsedGrant.scope.method === DwnMethodName.Read &&
          parsedGrant.scope.protocol === encryptedProtocol.protocol;
      });
      expect(recordsReadGrant).toBeDefined();

      await deviceHarness.agent.did.import({
        portableDid : connectResponse.delegatePortableDid,
        tenant      : deviceHarness.agent.agentDid.uri,
      });
      await importConnectGrants(
        deviceHarness,
        alice.did.uri,
        connectResponse.delegateDid,
        connectResponse.delegateGrants,
      );

      const installedProtocol = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: encryptedProtocol.protocol } },
      });
      expect(installedProtocol.reply.status.code).toBe(200);
      expect(installedProtocol.reply.entries).toHaveLength(1);
      const localProtocolConfigure = await deviceHarness.agent.dwn.processRawMessage(
        alice.did.uri,
        installedProtocol.reply.entries![0] as GenericMessage,
      );
      expect([202, 409]).toContain(localProtocolConfigure.status.code);

      const remoteGrantKeyQuery = await deviceHarness.agent.dwn.sendRequest({
        author        : connectResponse.delegateDid,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recipient    : connectResponse.delegateDid,
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.grantKeyPath,
            tags         : { protocol: encryptedProtocol.protocol },
          },
        },
      });
      expect(remoteGrantKeyQuery.reply.status.code).toBe(200);
      expect(remoteGrantKeyQuery.reply.entries?.length).toBe(1);

      const noteText = 'encrypted sync note decrypted from connect-created grantKey';
      const writeResult = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'text/plain',
          protocol     : encryptedProtocol.protocol,
          protocolPath : 'note',
          schema       : encryptedProtocol.types.note.schema,
        },
        dataStream : new Blob([noteText]),
        encryption : true,
      });
      expect(writeResult.reply.status.code).toBe(202);
      const recordId = writeResult.message!.recordId;

      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await primaryHarness.agent.sync.sync('push');

      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [encryptedProtocol.protocol],
          delegateDid : connectResponse.delegateDid,
        },
      });
      await deviceHarness.agent.sync.sync('pull');
      expect(await deviceHarness.agent.sync.getFailedMessages(alice.did.uri)).toEqual([]);

      const localGrantKeyQuery = await deviceHarness.agent.dwn.processRequest({
        author        : connectResponse.delegateDid,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recipient    : connectResponse.delegateDid,
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.grantKeyPath,
            tags         : { protocol: encryptedProtocol.protocol },
          },
        },
      });
      expect(localGrantKeyQuery.reply.status.code).toBe(200);
      expect(localGrantKeyQuery.reply.entries?.length).toBe(1);

      deviceHarness.agent.dwn.clearDelegateDecryptionKeys(connectResponse.delegateDid);
      expect(await deviceHarness.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();

      const readResult = await deviceHarness.agent.dwn.processRequest({
        author        : connectResponse.delegateDid,
        target        : alice.did.uri,
        granteeDid    : connectResponse.delegateDid,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter            : { recordId },
          permissionGrantId : recordsReadGrant!.recordId,
        },
        encryption: true,
      });
      expect(readResult.reply.status.code).toBe(200);
      expect(readResult.reply.entry?.data).toBeDefined();

      const decryptedBytes = await DataStream.toBytes(readResult.reply.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(noteText);
    }, 90_000);

    it('pulls role-audience key material and decrypts as a role member', async () => {
      const bobParticipant = await deviceHarness.createIdentity({ name: 'Role Sync Bob', testDwnUrls });
      const chatProtocol: ProtocolDefinition = {
        published : true,
        protocol  : `https://protocol.xyz/encrypted-sync-chat/${crypto.randomUUID()}`,
        types     : {
          thread      : { schema: 'https://schemas.xyz/sync-thread', dataFormats: ['application/json'] },
          participant : { schema: 'https://schemas.xyz/sync-participant', dataFormats: ['application/json'] },
          chat        : { schema: 'https://schemas.xyz/sync-chat', dataFormats: ['text/plain'], encryptionRequired: true },
        },
        structure: {
          thread: {
            participant : { $role: true },
            chat        : {
              $actions: [
                { role: 'thread/participant', can: ['read'] },
              ],
            },
          },
        },
      };

      const aliceProtocolConfigure = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });
      expect(aliceProtocolConfigure.reply.status.code).toBe(202);

      const aliceRemoteProtocolConfigure = await primaryHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });
      expect([202, 409]).toContain(aliceRemoteProtocolConfigure.reply.status.code);

      const bobProtocolConfigure = await deviceHarness.agent.dwn.processRequest({
        author        : bobParticipant.did.uri,
        target        : bobParticipant.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });
      expect(bobProtocolConfigure.reply.status.code).toBe(202);

      const bobRemoteProtocolConfigure = await deviceHarness.agent.dwn.sendRequest({
        author        : bobParticipant.did.uri,
        target        : bobParticipant.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });
      expect([202, 409]).toContain(bobRemoteProtocolConfigure.reply.status.code);

      const localAliceProtocolConfigure = await deviceHarness.agent.dwn.processRawMessage(
        alice.did.uri,
        aliceProtocolConfigure.message as GenericMessage,
      );
      expect([202, 409]).toContain(localAliceProtocolConfigure.status.code);

      const localBobProtocolForAlice = await primaryHarness.agent.dwn.processRawMessage(
        bobParticipant.did.uri,
        bobProtocolConfigure.message as GenericMessage,
      );
      expect([202, 409]).toContain(localBobProtocolForAlice.status.code);
      const bobProtocolQueryFromAlice = await retryFreshDidResolution(() => primaryHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : bobParticipant.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : { filter: { protocol: chatProtocol.protocol } },
      }));
      expect(bobProtocolQueryFromAlice.reply.status.code).toBe(200);
      expect(bobProtocolQueryFromAlice.reply.entries?.length).toBe(1);

      const bobMessagesReadGrant = await createAndDistributeGrant(primaryHarness, deviceHarness, {
        grantor : alice,
        grantee : bobParticipant,
        scope   : { protocol: chatProtocol.protocol, interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
      });
      const bobMessagesReadGrantId = bobMessagesReadGrant.grant.grant.id;

      const threadWrite = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'application/json',
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : chatProtocol.types.thread.schema,
        },
        dataStream: new Blob([JSON.stringify({ title: 'Synced encrypted chat' })]),
      });
      expect(threadWrite.reply.status.code).toBe(202);
      const threadContextId = (threadWrite.message as RecordsWriteMessage).contextId!;
      const isThreadAudienceKeyFeedEntry = (entry: MessagesQueryReplyEntry): boolean => {
        const descriptor = entry.message?.descriptor as RecordsWriteMessage['descriptor'] | undefined;
        const tags = descriptor?.tags;
        return descriptor?.protocol === EncryptionProtocol.uri &&
          descriptor.protocolPath === EncryptionProtocol.audienceKeyPath &&
          tags?.contextId === threadContextId &&
          tags.protocol === chatProtocol.protocol &&
          tags.role === 'thread/participant';
      };

      const roleWrite = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
          protocol        : chatProtocol.protocol,
          protocolPath    : 'thread/participant',
          recipient       : bobParticipant.did.uri,
          schema          : chatProtocol.types.participant.schema,
        },
        dataStream: new Blob([JSON.stringify({ role: 'participant' })]),
      });
      expect(roleWrite.reply.status.code).toBe(202);

      const sourceAudienceEpochQuery = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.audienceEpochPath,
            tags         : {
              contextId : threadContextId,
              protocol  : chatProtocol.protocol,
              role      : 'thread/participant',
            },
          },
        },
      });
      expect(sourceAudienceEpochQuery.reply.status.code).toBe(200);
      expect(sourceAudienceEpochQuery.reply.entries?.length).toBe(1);

      const chatText = 'role-audience encrypted message from sync';
      const chatWrite = await primaryHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat      : 'text/plain',
          parentContextId : threadContextId,
          protocol        : chatProtocol.protocol,
          protocolPath    : 'thread/chat',
          schema          : chatProtocol.types.chat.schema,
        },
        dataStream : new Blob([chatText]),
        encryption : true,
      });
      expect(chatWrite.reply.status.code).toBe(202);

      await primaryHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });
      await primaryHarness.agent.sync.sync('push');

      const remoteAudienceKeyQuery = await deviceHarness.agent.dwn.sendRequest({
        author        : bobParticipant.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recipient    : bobParticipant.did.uri,
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.audienceKeyPath,
            tags         : {
              contextId : threadContextId,
              protocol  : chatProtocol.protocol,
              role      : 'thread/participant',
            },
          },
        },
      });
      expect(remoteAudienceKeyQuery.reply.status.code).toBe(200);
      expect(remoteAudienceKeyQuery.reply.entries?.length).toBe(1);

      const remoteFeedQuery = await deviceHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        granteeDid    : bobParticipant.did.uri,
        messageType   : DwnInterface.MessagesQuery,
        messageParams : {
          filters            : [{ protocol: chatProtocol.protocol }],
          permissionGrantIds : [bobMessagesReadGrantId],
        },
      });
      expect(remoteFeedQuery.reply.status.code).toBe(200);
      expect(remoteFeedQuery.reply.entries?.some(isThreadAudienceKeyFeedEntry)).toBe(true);

      await deviceHarness.agent.sync.registerIdentity({
        did     : alice.did.uri,
        options : {
          protocols   : [chatProtocol.protocol],
          delegateDid : bobParticipant.did.uri,
        },
      });
      await deviceHarness.agent.sync.sync('pull');
      expect(await deviceHarness.agent.sync.getFailedMessages(alice.did.uri)).toEqual([]);

      const localFeedQuery = await deviceHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        granteeDid    : bobParticipant.did.uri,
        messageType   : DwnInterface.MessagesQuery,
        messageParams : {
          filters            : [{ protocol: chatProtocol.protocol }],
          permissionGrantIds : [bobMessagesReadGrantId],
        },
      });
      expect(localFeedQuery.reply.status.code).toBe(200);
      expect(localFeedQuery.reply.entries?.some(isThreadAudienceKeyFeedEntry)).toBe(true);

      const localAudienceEpochQuery = await deviceHarness.agent.dwn.processRequest({
        author        : bobParticipant.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.audienceEpochPath,
            tags         : {
              contextId : threadContextId,
              protocol  : chatProtocol.protocol,
              role      : 'thread/participant',
            },
          },
        },
      });
      expect(localAudienceEpochQuery.reply.status.code).toBe(200);
      expect(localAudienceEpochQuery.reply.entries?.map(entry => entry.recordId)).toContain(
        sourceAudienceEpochQuery.reply.entries![0].recordId,
      );

      const audienceKeyQuery = await deviceHarness.agent.dwn.processRequest({
        author        : bobParticipant.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recipient    : bobParticipant.did.uri,
            protocol     : EncryptionProtocol.uri,
            protocolPath : EncryptionProtocol.audienceKeyPath,
            tags         : {
              contextId : threadContextId,
              protocol  : chatProtocol.protocol,
              role      : 'thread/participant',
            },
          },
        },
      });
      expect(audienceKeyQuery.reply.status.code).toBe(200);
      expect(audienceKeyQuery.reply.entries?.length).toBe(1);
      expect(await deviceHarness.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();

      const readResult = await deviceHarness.agent.dwn.processRequest({
        author        : bobParticipant.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter       : { recordId: (chatWrite.message as RecordsWriteMessage).recordId },
          protocolRole : 'thread/participant',
        },
        encryption: true,
      });
      expect(readResult.reply.status.code).toBe(200);
      expect(readResult.reply.entry?.data).toBeDefined();

      const decryptedBytes = await DataStream.toBytes(readResult.reply.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(chatText);
    }, 90_000);
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
