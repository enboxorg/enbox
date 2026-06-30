import type { BearerIdentity } from '../src/bearer-identity.js';
import type { PublicKeyJwk } from '@enbox/crypto';
import type { GenericMessage, ProtocolDefinition, RecordsWriteMessage, RoleAudienceKeyEncryption } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  ContentEncryptionAlgorithm,
  DataStream,
  Encoder,
  EncryptionProtocol,
  KeyDerivationScheme,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { EnboxUserAgent } from '../src/enbox-user-agent.js';
import { JwkProtocolDefinition } from '../src/store-data-protocols.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { requireDwnServer } from './utils/require-dwn-server.js';
import { retryFreshDidResolution } from './utils/remote-dwn-retry.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { createAudienceKeyRecord, getCachedAudienceDecryptionKey } from '../src/dwn-encryption.js';

const testDwnUrls: string[] = [testDwnUrl];
const syncConvergenceRetryDelaysMs = [500, 1_000, 2_000, 4_000, 8_000, 16_000];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * End-to-end tests for encrypted data through sync, agent lifecycle with
 * encrypted stores, and encrypted role-audience protocol boundaries.
 *
 * These tests require:
 * - A Pkarr gateway (for did:dht publishing via createIdentity)
 * - A remote DWN server at localhost:3000 (for sync and sendRequest)
 *
 * They will fail locally without these services (~66 DHT-dependent tests also
 * fail locally). CI has both services configured.
 */

// -------------------------------------------------------------------
// Test 1: Encrypted data survives sync round-trip
// -------------------------------------------------------------------
describe('e2e: encrypted data survives sync round-trip', () => {
  beforeAll(async () => {
    await requireDwnServer();
  });


  let testHarness: PlatformAgentTestHarness;
  let syncEngine: SyncEngineLevel;
  let alice: BearerIdentity;

  // A protocol with encryptionRequired for end-to-end encrypted records.
  const encryptedNoteProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/encrypted-notes',
    types     : {
      note: {
        schema             : 'https://schemas.xyz/note',
        dataFormats        : ['text/plain'],
        encryptionRequired : true,
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
      testDataLocation : '__TESTDATA__/e2e-encrypted-sync',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Wire up a fresh sync engine.
    const syncStore = testHarness.syncStore;
    syncEngine = new SyncEngineLevel({ db: syncStore, agent: testHarness.agent });
    testHarness.agent.sync = syncEngine;

    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  async function queryRemoteEncryptedNotes(): Promise<RecordsQueryReply> {
    const { reply } = await retryFreshDidResolution(() => testHarness.agent.dwn.sendRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
        }
      },
    }));

    return reply;
  }

  async function queryLocalEncryptedNotes(): Promise<RecordsQueryReply> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
        }
      },
    });

    return reply;
  }

  async function syncPushUntilRemoteRecordCount(expectedCount: number): Promise<RecordsQueryReply> {
    let lastReply: RecordsQueryReply | undefined;
    let lastSyncError: unknown;

    for (let attempt = 0; attempt <= syncConvergenceRetryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        await sleep(syncConvergenceRetryDelaysMs[attempt - 1]);
      }

      try {
        await syncEngine.sync('push');
        lastSyncError = undefined;
      } catch (error) {
        lastSyncError = error;
      }

      lastReply = await queryRemoteEncryptedNotes();
      if (lastReply.status.code === 200 && (lastReply.entries?.length ?? 0) === expectedCount) {
        return lastReply;
      }
    }

    throw new Error(
      `Remote encrypted notes did not converge: ${lastReply?.status.code ?? 'no status'} `
      + `${lastReply?.status.detail ?? ''}; entries=${lastReply?.entries?.length ?? 0}; `
      + `lastSyncError=${lastSyncError instanceof Error ? lastSyncError.message : 'none'}`
    );
  }

  async function syncPullUntilLocalRecordCount(expectedCount: number): Promise<RecordsQueryReply> {
    let lastReply: RecordsQueryReply | undefined;
    let lastSyncError: unknown;

    for (let attempt = 0; attempt <= syncConvergenceRetryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        await sleep(syncConvergenceRetryDelaysMs[attempt - 1]);
      }

      try {
        await syncEngine.sync('pull');
        lastSyncError = undefined;
      } catch (error) {
        lastSyncError = error;
      }

      lastReply = await queryLocalEncryptedNotes();
      if (lastReply.status.code === 200 && (lastReply.entries?.length ?? 0) === expectedCount) {
        return lastReply;
      }
    }

    throw new Error(
      `Local encrypted notes did not converge after pull: ${lastReply?.status.code ?? 'no status'} `
      + `${lastReply?.status.detail ?? ''}; entries=${lastReply?.entries?.length ?? 0}; `
      + `lastSyncError=${lastSyncError instanceof Error ? lastSyncError.message : 'none'}`
    );
  }

  it('should install the encrypted protocol locally with $keyAgreement keys', async () => {
    // Configure the protocol locally with encryption enabled.
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: encryptedNoteProtocol },
      encryption    : true,
    });
    expect(reply.status.code).toBe(202);

    // Verify $keyAgreement was injected.
    const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: encryptedNoteProtocol.protocol } },
    });
    expect(queryReply.entries).toHaveLength(1);
    const definition = queryReply.entries![0].descriptor.definition;
    const noteRuleSet = definition.structure.note;
    expect(definition).toHaveProperty('$keyAgreement');
    expect(definition.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
    expect(noteRuleSet).toHaveProperty('$keyAgreement');
    expect(noteRuleSet.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
  }, 30_000);

  it('should write encrypted records locally', async () => {
    const notes = ['Secret note 1', 'Secret note 2', 'Secret note 3'];

    for (const text of notes) {
      const { reply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedNoteProtocol.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
        },
        dataStream : new Blob([new TextEncoder().encode(text)]),
        encryption : true,
      });
      expect(reply.status.code).toBe(202);
    }

    // Verify records exist locally with encryption metadata.
    const queryReply = await queryLocalEncryptedNotes();
    expect(queryReply.entries).toHaveLength(3);
    for (const entry of queryReply.entries!) {
      expect(entry.encryption).toBeDefined();
      expect(entry.encryption!.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
      expect(entry.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    }
  }, 30_000);

  it('should push encrypted records to the remote DWN', async () => {
    // Register identity and push to remote.
    await testHarness.agent.sync.registerIdentity({ did: alice.did.uri, options: { protocols: 'all' } });

    // Verify records exist on the remote DWN.
    const remoteQueryReply = await syncPushUntilRemoteRecordCount(3);
    expect(remoteQueryReply.status.code).toBe(200);
    expect(remoteQueryReply.entries).toHaveLength(3);

    // Remote records should also have encryption metadata.
    for (const entry of remoteQueryReply.entries!) {
      expect(entry.encryption).toBeDefined();
      expect(entry.encryption!.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
      expect(entry.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    }
  }, 60_000);

  it('should clear local DWN data and pull back encrypted records', async () => {
    // Clear local DWN stores (simulating a fresh device), but keep the agent
    // DID and sync registration intact.
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    testHarness.dwnStores.clear();

    // Verify local is now empty.
    const localBefore = await queryLocalEncryptedNotes();
    expect(localBefore.entries).toHaveLength(0);

    // Verify the encrypted records were pulled back.
    const localAfter = await syncPullUntilLocalRecordCount(3);
    expect(localAfter.entries).toHaveLength(3);
    for (const entry of localAfter.entries!) {
      expect(entry.encryption).toBeDefined();
    }
  }, 60_000);

  it('should decrypt pulled records with the original encryption key', async () => {
    // Read each record individually with auto-decryption.
    const queryReply = await queryLocalEncryptedNotes();

    const decryptedTexts: string[] = [];
    for (const entry of queryReply.entries!) {
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: entry.recordId } },
        encryption    : true,
      });
      const bytes = await DataStream.toBytes(readReply.entry!.data!);
      decryptedTexts.push(new TextDecoder().decode(bytes));
    }

    expect(decryptedTexts).toEqual(expect.arrayContaining([
      'Secret note 1',
      'Secret note 2',
      'Secret note 3',
    ]));
  }, 30_000);
});

// -------------------------------------------------------------------
// Test 2: Agent lifecycle with encrypted stores
// -------------------------------------------------------------------
describe('e2e: agent lifecycle with encrypted stores', () => {

  const testDataLocation = '__TESTDATA__/e2e-agent-lifecycle';
  const password = 'lifecycle-test-password';

  let recoveryPhrase: string;
  let agentDidUri: string;
  let generatedKeyUri: string;
  let identityDidUri: string;

  afterAll(async () => {
    try {
      const cleanup = await PlatformAgentTestHarness.setup({
        agentClass  : TestAgent,
        agentStores : 'dwn',
        testDataLocation,
      });
      await cleanup.clearStorage();
      await cleanup.closeStorage();
    } catch {
      // Non-fatal cleanup failure.
    }
  });

  describe('Phase 1: initialize and populate', () => {
    let harness: PlatformAgentTestHarness;

    it('should initialize the agent with a vault and encrypted key store', async () => {
      harness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'dwn',
        testDataLocation,
      });

      recoveryPhrase = await (harness.agent as EnboxUserAgent).initialize({ password });
      expect(recoveryPhrase.split(' ')).toHaveLength(12);

      await (harness.agent as EnboxUserAgent).start({ password });
      agentDidUri = harness.agent.agentDid.uri;
      expect(agentDidUri).toMatch(/^did:dht:/);
    }, 30_000);

    it('should generate an encrypted private key', async () => {
      generatedKeyUri = await harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
      const key = await harness.agent.keyManager.exportKey({ keyUri: generatedKeyUri });
      expect(key).toHaveProperty('d');

      // Verify the key record is encrypted in the DWN.
      const { reply } = await harness.agent.dwn.processRequest({
        author        : agentDidUri,
        target        : agentDidUri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : JwkProtocolDefinition.protocol,
            protocolPath : 'privateJwk',
          }
        },
      });
      expect(reply.entries).toHaveLength(1);
      expect(reply.entries![0].encryption).toBeDefined();
    }, 30_000);

    it('should create an identity', async () => {
      const identity = await harness.agent.identity.create({
        didMethod : 'jwk',
        metadata  : { name: 'Lifecycle Test Identity' },
      });
      identityDidUri = identity.did.uri;
      expect(identityDidUri).toMatch(/^did:jwk:/);

      // Verify identity is listed.
      const identities = await harness.agent.identity.list();
      expect(identities).toHaveLength(1);
      expect(identities[0].did.uri).toBe(identityDidUri);
    }, 30_000);

    it('should close the agent', async () => {
      await harness.closeStorage();
    }, 30_000);
  });

  describe('Phase 2: restart and verify all data intact', () => {
    let harness: PlatformAgentTestHarness;

    it('should restart the agent with the same password', async () => {
      harness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'dwn',
        testDataLocation,
      });

      // The vault is already initialized — just start with the password.
      await (harness.agent as EnboxUserAgent).start({ password });
      expect(harness.agent.agentDid.uri).toBe(agentDidUri);
    }, 30_000);

    it('should read back the encrypted private key', async () => {
      const key = await harness.agent.keyManager.exportKey({ keyUri: generatedKeyUri });
      expect(key).toBeDefined();
      expect(key).toHaveProperty('d');
      expect(key.crv).toBe('Ed25519');
    }, 30_000);

    it('should list the identity created in Phase 1', async () => {
      const identities = await harness.agent.identity.list();
      expect(identities).toHaveLength(1);
      expect(identities[0].did.uri).toBe(identityDidUri);
      expect(identities[0].metadata.name).toBe('Lifecycle Test Identity');
    }, 30_000);

    it('should generate new keys proving the agent is fully operational', async () => {
      const newKeyUri = await harness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
      const newKey = await harness.agent.keyManager.exportKey({ keyUri: newKeyUri });
      expect(newKey).toHaveProperty('d');
      expect(newKey.crv).toBe('secp256k1');
    }, 30_000);

    it('should clean up', async () => {
      await harness.clearStorage();
      await harness.closeStorage();
    }, 30_000);
  });
});

// -------------------------------------------------------------------
// Test 3: encrypted role-audience records require delivered audience keys
// -------------------------------------------------------------------
describe('e2e: encrypted role-audience records require audience keys', () => {

  let testHarness: PlatformAgentTestHarness;
  let bobHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;
  let bob: BearerIdentity;
  let carol: BearerIdentity;
  let separateBob: BearerIdentity;
  const password = 'role-audience-cache-test-password';
  const bobPassword = 'role-audience-cache-test-bob-password';

  // Multi-party chat protocol with $role participants and encrypted data.
  const chatProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/e2e-chat',
    types     : {
      thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'] },
      participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'] },
      chat        : { schema: 'https://schemas.xyz/chat', dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      thread: {
        participant : { $role: true },
        chat        : {
          $actions: [
            { role: 'thread/participant', can: ['create', 'read'] },
          ],
        },
      },
    },
  };

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-multiparty-chat',
    });
    bobHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-multiparty-chat-bob',
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await bobHarness.clearStorage();
    await (testHarness.agent as EnboxUserAgent).initialize({ password });
    await (testHarness.agent as EnboxUserAgent).start({ password });
    await (bobHarness.agent as EnboxUserAgent).initialize({ password: bobPassword });
    await (bobHarness.agent as EnboxUserAgent).start({ password: bobPassword });
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    carol = await testHarness.createIdentity({ name: 'Carol', testDwnUrls });
    separateBob = await bobHarness.createIdentity({ name: 'Separate Bob', testDwnUrls });
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await bobHarness.clearStorage();
    await testHarness.closeStorage();
    await bobHarness.closeStorage();
  });

  async function installChatProtocol(harness: PlatformAgentTestHarness, did: string): Promise<void> {
    const { reply } = await harness.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });
    expect(reply.status.code).toBe(202);
  }

  async function copyProtocolToHarness(
    source: PlatformAgentTestHarness,
    destination: PlatformAgentTestHarness,
    tenantDid: string,
  ): Promise<void> {
    const { reply } = await source.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: chatProtocol.protocol } },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entries).toHaveLength(1);

    const applyReply = await destination.agent.dwn.processRawMessage(
      tenantDid,
      reply.entries![0] as GenericMessage,
    );
    expect([202, 409]).toContain(applyReply.status.code);
  }

  async function copyRecordToHarness(
    source: PlatformAgentTestHarness,
    destination: PlatformAgentTestHarness,
    tenantDid: string,
    recordId: string,
  ): Promise<void> {
    const { reply } = await source.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entry?.data).toBeDefined();
    expect(reply.entry?.recordsWrite).toBeDefined();

    const dataBytes = await DataStream.toBytes(reply.entry!.data!);
    const applyReply = await destination.agent.dwn.processRawMessage(
      tenantDid,
      reply.entry!.recordsWrite as GenericMessage,
      { dataStream: DataStream.fromBytes(dataBytes) },
    );
    expect([202, 409]).toContain(applyReply.status.code);
  }

  async function copyDataEncodedRecordToHarness(
    destination: PlatformAgentTestHarness,
    tenantDid: string,
    record: RecordsWriteMessage & { encodedData: string },
  ): Promise<void> {
    const { encodedData, ...rawMessage } = record;
    const applyReply = await destination.agent.dwn.processRawMessage(
      tenantDid,
      rawMessage as RecordsWriteMessage,
      { dataStream: DataStream.fromBytes(Encoder.base64UrlToBytes(encodedData)) },
    );
    expect([202, 409]).toContain(applyReply.status.code);
  }

  async function queryOneEncryptionRecord(params: {
    protocolPath: string;
    tags: Record<string, string | number>;
  }): Promise<RecordsWriteMessage & { encodedData: string }> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : EncryptionProtocol.uri,
          protocolPath : params.protocolPath,
        },
      },
    });
    expect(reply.status.code).toBe(200);
    const matchingEntries = (reply.entries ?? []).filter((entry): boolean =>
      Object.entries(params.tags).every(([tag, value]): boolean => String(entry.descriptor.tags?.[tag]) === String(value))
    );
    expect(matchingEntries).toHaveLength(1);
    expect(matchingEntries[0].encodedData).toBeDefined();
    return matchingEntries[0] as RecordsWriteMessage & { encodedData: string };
  }

  async function getRolePublicKeyFromInstalledProtocol(
    harness: PlatformAgentTestHarness,
    did: string,
  ): Promise<PublicKeyJwk> {
    const { reply } = await harness.agent.dwn.processRequest({
      author        : did,
      target        : did,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: chatProtocol.protocol } },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entries).toHaveLength(1);

    const definition = reply.entries![0].descriptor.definition;
    const publicKeyJwk = definition.structure.thread.participant?.$keyAgreement?.publicKeyJwk;
    expect(publicKeyJwk).toBeDefined();
    return publicKeyJwk!;
  }

  it('should install the chat protocol with encryption for Alice', async () => {
    await installChatProtocol(testHarness, alice.did.uri);
  }, 30_000);

  it('should deliver an audience key and allow a role holder to decrypt', async () => {
    await installChatProtocol(testHarness, alice.did.uri);
    await installChatProtocol(testHarness, bob.did.uri);
    await installChatProtocol(testHarness, carol.did.uri);

    // Alice creates a plaintext thread (root record).
    const { message: threadMsg } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'application/json',
        schema       : 'https://schemas.xyz/thread',
      },
      dataStream: new Blob([new TextEncoder().encode('{"title":"Secret Chat"}')]),
    });
    expect(threadMsg).toBeDefined();
    const threadContextId = (threadMsg as RecordsWriteMessage).contextId!;

    // Without a role audience epoch, the agent cannot produce a complete encrypted write.
    const chatText = 'Hello Bob, this is encrypted!';
    await expect(testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/chat',
        parentContextId : threadContextId,
        dataFormat      : 'text/plain',
        schema          : 'https://schemas.xyz/chat',
      },
      dataStream : new Blob([new TextEncoder().encode(chatText)]),
      encryption : true,
    })).rejects.toThrow('Missing audienceEpoch');

    const { reply: roleReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        recipient       : bob.did.uri,
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
      },
      dataStream: new Blob([new TextEncoder().encode('{"role":"participant"}')]),
    });
    expect(roleReply.status.code).toBe(202);

    const { reply: audienceKeyReply } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          recipient    : bob.did.uri,
          protocol     : EncryptionProtocol.uri,
          protocolPath : EncryptionProtocol.audienceKeyPath,
        },
      },
    });
    expect(audienceKeyReply.status.code).toBe(200);
    expect(audienceKeyReply.entries).toHaveLength(1);

    const { reply: chatReply, message: chatMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/chat',
        parentContextId : threadContextId,
        dataFormat      : 'text/plain',
        schema          : 'https://schemas.xyz/chat',
      },
      dataStream : new Blob([new TextEncoder().encode(chatText)]),
      encryption : true,
    });
    expect(chatReply.status.code).toBe(202);

    const roleAudienceEntry = (chatMessage as RecordsWriteMessage).encryption!.keyEncryption.find(
      (entry): entry is RoleAudienceKeyEncryption => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME
    );
    expect(roleAudienceEntry).toBeDefined();
    expect(roleAudienceEntry!.protocol).toBe(chatProtocol.protocol);
    expect(roleAudienceEntry!.role).toBe('thread/participant');

    const cachedBeforeRead = await getCachedAudienceDecryptionKey({
      agent        : testHarness.agent,
      sourceDid    : alice.did.uri,
      recipientDid : bob.did.uri,
      protocol     : chatProtocol.protocol,
      contextId    : threadContextId,
      role         : 'thread/participant',
      epoch        : roleAudienceEntry!.epoch,
      keyId        : roleAudienceEntry!.keyId,
    });
    expect(cachedBeforeRead).toBeUndefined();

    const { reply: bobReadReply } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter       : { recordId: (chatMessage as RecordsWriteMessage).recordId },
        protocolRole : 'thread/participant',
      },
      encryption: true,
    });
    expect(bobReadReply.status.code).toBe(200);
    const decryptedBytes = await DataStream.toBytes(bobReadReply.entry!.data!);
    expect(new TextDecoder().decode(decryptedBytes)).toBe(chatText);

    const cachedAfterRead = await getCachedAudienceDecryptionKey({
      agent        : testHarness.agent,
      sourceDid    : alice.did.uri,
      recipientDid : bob.did.uri,
      protocol     : chatProtocol.protocol,
      contextId    : threadContextId,
      role         : 'thread/participant',
      epoch        : roleAudienceEntry!.epoch,
      keyId        : roleAudienceEntry!.keyId,
    });
    expect(cachedAfterRead?.privateKeyJwk.d).toBeDefined();

    const { reply: carolReadReply } = await testHarness.agent.dwn.processRequest({
      author        : carol.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter       : { recordId: (chatMessage as RecordsWriteMessage).recordId },
        protocolRole : 'thread/participant',
      },
      encryption: true,
    });
    expect(carolReadReply.status.code).toBe(401);
  }, 30_000);

  it('should allow a role holder in a separate agent to decrypt with the delivered audience key', async () => {
    await installChatProtocol(testHarness, alice.did.uri);
    await installChatProtocol(bobHarness, separateBob.did.uri);

    await copyProtocolToHarness(bobHarness, testHarness, separateBob.did.uri);
    await copyProtocolToHarness(testHarness, bobHarness, alice.did.uri);

    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'application/json',
        schema       : 'https://schemas.xyz/thread',
      },
      dataStream: new Blob([new TextEncoder().encode('{"title":"Separate Agent Chat"}')]),
    });
    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

    const { reply: roleReply, message: roleMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        recipient       : separateBob.did.uri,
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
      },
      dataStream: new Blob([new TextEncoder().encode('{"role":"participant"}')]),
    });
    expect(roleReply.status.code).toBe(202);

    const audienceEpoch = await queryOneEncryptionRecord({
      protocolPath : EncryptionProtocol.audienceEpochPath,
      tags         : {
        protocol  : chatProtocol.protocol,
        contextId : threadContextId,
        role      : 'thread/participant',
        epoch     : 1,
      },
    });
    const epochPayload = Encoder.base64UrlToObject(audienceEpoch.encodedData) as {
      protocol: string;
      contextId: string;
      role: string;
      epoch: number;
      keyId: string;
      publicKeyJwk: PublicKeyJwk;
    };
    const audienceKey = await getCachedAudienceDecryptionKey({
      agent        : testHarness.agent,
      sourceDid    : alice.did.uri,
      recipientDid : alice.did.uri,
      protocol     : epochPayload.protocol,
      contextId    : epochPayload.contextId,
      role         : epochPayload.role,
      epoch        : epochPayload.epoch,
      keyId        : epochPayload.keyId,
    });
    expect(audienceKey).toBeDefined();
    const bobRolePublicKey = await getRolePublicKeyFromInstalledProtocol(bobHarness, separateBob.did.uri);
    const audienceKeyRecord = await createAudienceKeyRecord({
      agent                  : testHarness.agent,
      sourceDid              : alice.did.uri,
      authorDid              : alice.did.uri,
      recipientDid           : separateBob.did.uri,
      recipientRolePublicKey : bobRolePublicKey,
      audienceKey            : {
        protocol      : epochPayload.protocol,
        contextId     : epochPayload.contextId,
        role          : epochPayload.role,
        epoch         : epochPayload.epoch,
        keyId         : epochPayload.keyId,
        publicKeyJwk  : epochPayload.publicKeyJwk,
        privateKeyJwk : audienceKey!.privateKeyJwk,
      },
    });

    const chatText = 'Bob decrypts this without Alice keys';
    const { reply: chatReply, message: chatMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/chat',
        parentContextId : threadContextId,
        dataFormat      : 'text/plain',
        schema          : 'https://schemas.xyz/chat',
      },
      dataStream : new Blob([new TextEncoder().encode(chatText)]),
      encryption : true,
    });
    expect(chatReply.status.code).toBe(202);

    const roleAudienceEntry = (chatMessage as RecordsWriteMessage).encryption!.keyEncryption.find(
      (entry): entry is RoleAudienceKeyEncryption => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME
    );
    expect(roleAudienceEntry).toBeDefined();

    await copyRecordToHarness(testHarness, bobHarness, alice.did.uri, (threadMessage as RecordsWriteMessage).recordId);
    await copyRecordToHarness(testHarness, bobHarness, alice.did.uri, (roleMessage as RecordsWriteMessage).recordId);
    await copyDataEncodedRecordToHarness(bobHarness, alice.did.uri, audienceEpoch);
    await copyDataEncodedRecordToHarness(
      bobHarness,
      alice.did.uri,
      audienceKeyRecord as RecordsWriteMessage & { encodedData: string },
    );
    await copyRecordToHarness(testHarness, bobHarness, alice.did.uri, (chatMessage as RecordsWriteMessage).recordId);

    bobHarness.agent.dwn.clearDelegateDecryptionKeys(separateBob.did.uri);
    expect(await bobHarness.agent.did.get({ didUri: alice.did.uri })).toBeUndefined();
    const cachedBeforeRead = await getCachedAudienceDecryptionKey({
      agent        : bobHarness.agent,
      sourceDid    : alice.did.uri,
      recipientDid : separateBob.did.uri,
      protocol     : chatProtocol.protocol,
      contextId    : threadContextId,
      role         : 'thread/participant',
      epoch        : roleAudienceEntry!.epoch,
      keyId        : roleAudienceEntry!.keyId,
    });
    expect(cachedBeforeRead).toBeUndefined();

    const { reply: bobReadReply } = await bobHarness.agent.dwn.processRequest({
      author        : separateBob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter       : { recordId: (chatMessage as RecordsWriteMessage).recordId },
        protocolRole : 'thread/participant',
      },
      encryption: true,
    });
    expect(bobReadReply.status.code).toBe(200);
    const decryptedBytes = await DataStream.toBytes(bobReadReply.entry!.data!);
    expect(new TextDecoder().decode(decryptedBytes)).toBe(chatText);

    const cachedAfterRead = await getCachedAudienceDecryptionKey({
      agent        : bobHarness.agent,
      sourceDid    : alice.did.uri,
      recipientDid : separateBob.did.uri,
      protocol     : chatProtocol.protocol,
      contextId    : threadContextId,
      role         : 'thread/participant',
      epoch        : roleAudienceEntry!.epoch,
      keyId        : roleAudienceEntry!.keyId,
    });
    expect(cachedAfterRead?.privateKeyJwk.d).toBeDefined();
  }, 30_000);

});
