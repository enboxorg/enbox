import type { BearerDid } from '@enbox/dids';
import type { Jwk } from '@enbox/crypto';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { expect } from 'chai';
import sinon from 'sinon';

import type { AgentDataStore, DwnDataStore } from '../src/store-data.js';

import { DwnInterface } from '../src/types/dwn.js';
import { JwkProtocolDefinition } from '../src/store-data-protocols.js';
import { LocalKeyManager } from '../src/local-key-manager.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { DwnKeyStore, InMemoryKeyStore } from '../src/store-key.js';

describe('KeyStore', () => {
  describe('InMemoryKeyStore', () => {
    let testHarness: PlatformAgentTestHarness;
    let keyStore: AgentDataStore<Jwk>;

    before(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass  : TestAgent,
        agentStores : 'memory'
      });
    });

    beforeEach(async () => {
      await testHarness.clearStorage();
      await testHarness.createAgentDid();
      keyStore = new InMemoryKeyStore();
      const keyManager = new LocalKeyManager({ agent: testHarness.agent, keyStore });
      testHarness.agent.keyManager = keyManager;
    });

    after(async () => {
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    describe('constructor', () => {
      it('creates a InMemoryKeyStore', () => {
        const store = new InMemoryKeyStore();
        expect(store).to.be.instanceOf(InMemoryKeyStore);
      });
    });

    describe('delete()', () => {
      it('should delete Private Key and return true if Private Key exists', async () => {
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        const deleteResult = await keyStore.delete({
          id    : keyUri,
          agent : testHarness.agent
        });
        expect(deleteResult).to.be.true;

        const storedKey = await keyStore.get({
          id    : keyUri,
          agent : testHarness.agent
        });
        expect(storedKey).to.be.undefined;
      });

      it('should return false if Private Key does not exist', async () => {
        const deleteResult = await keyStore.delete({ id: 'non-existent', agent: testHarness.agent });
        expect(deleteResult).to.be.false;
      });
    });

    describe('get()', () => {
      it('should return a Private Key by URI if it exists', async () => {
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        const storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).to.exist;
        expect(keyUri).to.include(storedKey!.kid);
      });

      it('should return undefined when attempting to get a non-existent DID', async () => {
        const storedKey = await keyStore.get({ id: 'non-existent', agent: testHarness.agent });
        expect(storedKey).to.be.undefined;
      });
    });

    describe('list()', () => {
      it('should return an array of all Private Keys in the store', async () => {
        const keyUri1 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri2 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri3 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).to.have.length(3);
        const importedKeys = [keyUri1, keyUri2, keyUri3];
        for (const storedKey of storedKeys) {
          expect(importedKeys).to.include(`urn:jwk:${storedKey.kid}`);
        }
      });

      it('returns an empty array if there are no Private Keys in the store', async () => {
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).to.have.length(0);
      });
    });

    describe('set()', () => {
      it('stores a Private Key', async () => {
        await keyStore.set({
          id   : 'urn:jwk:test-key',
          data : {
            kid : 'test-key',
            kty : 'OKP',
            crv : 'Ed25519',
            alg : 'EdDSA',
            x   : 'x'
          },
          agent: testHarness.agent
        });

        const storedKey = await keyStore.get({ id: 'urn:jwk:test-key', agent: testHarness.agent });
        expect(storedKey).to.exist;
        expect(storedKey!.kid).to.equal('test-key');
      });
    });
  });

  describe('DwnKeyStore', () => {
    let testHarness: PlatformAgentTestHarness;
    let keyStore: AgentDataStore<Jwk>;
    // Cache the secp256k1 DID across tests to avoid expensive key generation
    // on every beforeEach. The DID object is self-contained and can be reused.
    let secp256k1Did: BearerDid;

    before(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass  : TestAgent,
        agentStores : 'memory'
      });
      secp256k1Did = await DidJwk.create({
        options: { algorithm: 'secp256k1' }
      });
    });

    beforeEach(async () => {
      await testHarness.clearStorage();
      // Use secp256k1 for the agent DID so that DWN record-level encryption
      // (which requires a secp256k1 keyAgreement key) works correctly.
      testHarness.agent.agentDid = secp256k1Did;
      keyStore = new DwnKeyStore();
      const keyManager = new LocalKeyManager({ agent: testHarness.agent, keyStore });
      testHarness.agent.keyManager = keyManager;
    });

    after(async () => {
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    describe('constructor', () => {
      it('creates a DwnKeyStore', () => {
        const store = new DwnKeyStore();
        expect(store).to.be.instanceOf(DwnKeyStore);
      });
    });

    describe('delete()', () => {
      it('should delete Private Key and return true if Private Key exists', async () => {
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        const deleteResult = await keyStore.delete({
          id    : keyUri,
          agent : testHarness.agent
        });
        expect(deleteResult).to.be.true;

        const storedKey = await keyStore.get({
          id    : keyUri,
          agent : testHarness.agent
        });
        expect(storedKey).to.be.undefined;
      });

      it('should return false if Private Key does not exist', async () => {
        const deleteResult = await keyStore.delete({ id: 'non-existent', agent: testHarness.agent });
        expect(deleteResult).to.be.false;
      });
    });

    describe('get()', () => {
      it('should return a Private Key by URI if it exists', async () => {
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        const storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).to.exist;
        expect(keyUri).to.include(storedKey!.kid);
      });

      it('should return undefined when attempting to get a non-existent DID', async () => {
        const storedKey = await keyStore.get({ id: 'non-existent', agent: testHarness.agent });
        expect(storedKey).to.be.undefined;
      });
    });

    describe('list()', () => {
      it('should return an array of all Private Keys in the store', async () => {
        const keyUri1 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri2 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri3 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).to.have.length(3);
        const importedKeys = [keyUri1, keyUri2, keyUri3];
        for (const storedKey of storedKeys) {
          expect(importedKeys).to.include(`urn:jwk:${storedKey.kid}`);
        }
      });

      it('returns an empty array if there are no Private Keys in the store', async () => {
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).to.have.length(0);
      });

      it('throws an error if legacy unencrypted records exceed DWN max data size for query results', async () => {
        // Write an oversized unencrypted record directly to the DWN (bypassing
        // the encrypted store path) to simulate a legacy record whose encodedData
        // is missing from query results.
        const keyBytes = Convert.string(new Array(102400 + 1).join('0')).toUint8Array();

        // Initialize the storage protocol (which now includes $encryption keys).
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // Write directly without encryption: true — the record is unencrypted.
        const response = await testHarness.agent.dwn.processRequest({
          author        : testHarness.agent.agentDid.uri,
          target        : testHarness.agent.agentDid.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'application/json',
            protocol     : JwkProtocolDefinition.protocol,
            protocolPath : 'privateJwk',
            schema       : JwkProtocolDefinition.types.privateJwk.schema,
          },
          dataStream: new Blob([keyBytes], { type: 'application/json' })
        });

        expect(response.reply.status.code).to.equal(202);

        try {
          await keyStore.list({ agent: testHarness.agent });
          expect.fail('Expected an error to be thrown');

        } catch (error: any) {
          expect(error.message).to.include(`Expected 'encodedData' to be present in the DWN query result entry`);
        }
      });
    });

    describe('set()', () => {
      it('stores a Private Key', async () => {
        await keyStore.set({
          id   : 'urn:jwk:test-key',
          data : {
            kid : 'test-key',
            kty : 'OKP',
            crv : 'Ed25519',
            alg : 'EdDSA',
            x   : 'x'
          },
          agent: testHarness.agent
        });

        const storedKey = await keyStore.get({ id: 'urn:jwk:test-key', agent: testHarness.agent });
        expect(storedKey).to.exist;
        expect(storedKey!.kid).to.equal('test-key');
      });
    });

    describe('encryption at rest', () => {
      it('installs the JWK protocol with $encryption keys', async () => {
        // Trigger protocol installation by initializing the store.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // Query the installed protocol.
        const { reply } = await testHarness.agent.dwn.processRequest({
          author        : testHarness.agent.agentDid.uri,
          target        : testHarness.agent.agentDid.uri,
          messageType   : DwnInterface.ProtocolsQuery,
          messageParams : {
            filter: { protocol: JwkProtocolDefinition.protocol }
          }
        });

        expect(reply.status.code).to.equal(200);
        expect(reply.entries).to.have.length(1);

        // Verify $encryption was injected into the protocol definition.
        const installedDefinition = reply.entries![0].descriptor.definition;
        const privateJwkRuleSet = installedDefinition.structure.privateJwk;
        expect(privateJwkRuleSet).to.have.property('$encryption');
        expect(privateJwkRuleSet.$encryption).to.have.property('rootKeyId');
        expect(privateJwkRuleSet.$encryption).to.have.property('publicKeyJwk');
      });

      it('encrypts key records in the DWN and decrypts them on read', async () => {
        // Generate a key — this stores it via DwnKeyStore.set() with encryption.
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Query the raw DWN record to verify it has encryption metadata.
        const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
          author        : testHarness.agent.agentDid.uri,
          target        : testHarness.agent.agentDid.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat   : 'application/json',
              protocol     : JwkProtocolDefinition.protocol,
              protocolPath : 'privateJwk',
              schema       : JwkProtocolDefinition.types.privateJwk.schema,
            }
          },
        });

        expect(queryReply.entries).to.have.length(1);

        // The raw query entry should have encryption metadata, indicating the
        // record is encrypted at the DWN level.
        const rawRecord = queryReply.entries![0];
        expect(rawRecord.encryption).to.exist;
        expect(rawRecord.encryption!.algorithm).to.equal('A256CTR');

        // Read back through the store API — should be decrypted transparently.
        const storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).to.exist;
        expect(keyUri).to.include(storedKey!.kid);
        // Verify key properties survive the encrypt/decrypt round-trip.
        expect(storedKey!.kty).to.equal('OKP');
        expect(storedKey!.crv).to.equal('Ed25519');
        expect(storedKey).to.have.property('d'); // private key material present
      });

      it('list() decrypts all encrypted key records', async () => {
        // Generate multiple keys.
        const keyUri1 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri2 = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
        const keyUri3 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        // List all keys — should return all three, decrypted.
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).to.have.length(3);

        const storedKids = storedKeys.map((k: Jwk): string => `urn:jwk:${k.kid}`);
        expect(storedKids).to.include(keyUri1);
        expect(storedKids).to.include(keyUri2);
        expect(storedKids).to.include(keyUri3);

        // Every returned key should have private key material.
        for (const key of storedKeys) {
          expect(key).to.have.property('d');
        }
      });

      it('encrypted key survives delete and re-create cycle', async () => {
        // Create a key.
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Verify it exists.
        let storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).to.exist;

        // Delete it.
        const deleted = await keyStore.delete({ id: keyUri, agent: testHarness.agent });
        expect(deleted).to.be.true;

        // Verify it's gone.
        storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).to.be.undefined;

        // Create a new key with the same algorithm.
        const keyUri2 = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Verify the new key exists and is different.
        const storedKey2 = await keyStore.get({ id: keyUri2, agent: testHarness.agent });
        expect(storedKey2).to.exist;
        expect(keyUri2).to.not.equal(keyUri);
      });
    });

    describe('plaintext fallback', () => {
      // These tests use an Ed25519 agent DID which lacks a secp256k1
      // keyAgreement key, so encryption cannot be activated.
      let ed25519Harness: PlatformAgentTestHarness;
      let ed25519KeyStore: AgentDataStore<Jwk>;

      before(async () => {
        ed25519Harness = await PlatformAgentTestHarness.setup({
          agentClass       : TestAgent,
          agentStores      : 'memory',
          testDataLocation : '__TESTDATA__/plaintext-fallback'
        });
      });

      beforeEach(async () => {
        await ed25519Harness.clearStorage();
        await ed25519Harness.createAgentDid(); // Ed25519 did:jwk — no secp256k1
        ed25519KeyStore = new DwnKeyStore();
        const keyManager = new LocalKeyManager({ agent: ed25519Harness.agent, keyStore: ed25519KeyStore });
        ed25519Harness.agent.keyManager = keyManager;
      });

      after(async () => {
        await ed25519Harness.clearStorage();
        await ed25519Harness.closeStorage();
      });

      it('should store and retrieve keys in plaintext when agent DID lacks secp256k1', async () => {
        // Generate a key — DwnKeyStore should gracefully fall back to plaintext
        // because the Ed25519 agent DID has no secp256k1 keyAgreement key.
        const keyUri = await ed25519Harness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Verify the key can be read back.
        const storedKey = await ed25519KeyStore.get({ id: keyUri, agent: ed25519Harness.agent });
        expect(storedKey).to.exist;
        expect(keyUri).to.include(storedKey!.kid);
        expect(storedKey).to.have.property('d');

        // Query the raw DWN record — should NOT have encryption metadata.
        const { reply: queryReply } = await ed25519Harness.agent.dwn.processRequest({
          author        : ed25519Harness.agent.agentDid.uri,
          target        : ed25519Harness.agent.agentDid.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              dataFormat   : 'application/json',
              protocol     : JwkProtocolDefinition.protocol,
              protocolPath : 'privateJwk',
              schema       : JwkProtocolDefinition.types.privateJwk.schema,
            }
          },
        });

        expect(queryReply.entries).to.have.length(1);
        expect(queryReply.entries![0].encryption).to.not.exist;
      });

      it('should install protocol WITHOUT $encryption keys for Ed25519 agent DID', async () => {
        // Initialize the store (triggers protocol installation).
        await (ed25519KeyStore as DwnDataStore<Jwk>)['initialize']({ agent: ed25519Harness.agent });

        // Query the installed protocol.
        const { reply } = await ed25519Harness.agent.dwn.processRequest({
          author        : ed25519Harness.agent.agentDid.uri,
          target        : ed25519Harness.agent.agentDid.uri,
          messageType   : DwnInterface.ProtocolsQuery,
          messageParams : {
            filter: { protocol: JwkProtocolDefinition.protocol }
          }
        });

        expect(reply.status.code).to.equal(200);
        expect(reply.entries).to.have.length(1);

        // The protocol should NOT have $encryption since the agent DID cannot
        // derive encryption keys.
        const installedDefinition = reply.entries![0].descriptor.definition;
        const privateJwkRuleSet = installedDefinition.structure.privateJwk;
        expect(privateJwkRuleSet).to.not.have.property('$encryption');
      });

      it('should list keys in plaintext mode', async () => {
        const keyUri1 = await ed25519Harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri2 = await ed25519Harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        const storedKeys = await ed25519KeyStore.list({ agent: ed25519Harness.agent });
        expect(storedKeys).to.have.length(2);
        const storedKids = storedKeys.map((k: Jwk): string => `urn:jwk:${k.kid}`);
        expect(storedKids).to.include(keyUri1);
        expect(storedKids).to.include(keyUri2);
      });
    });

    describe('protocol re-initialization', () => {
      it('should detect $encryption from an already-installed protocol after cache clear', async () => {
        // First call — installs the protocol with $encryption (secp256k1 agent DID).
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // Verify encryption is active.
        const tenantDid = testHarness.agent.agentDid.uri;
        expect((keyStore as any).isEncryptionActive(tenantDid)).to.be.true;

        // Clear the protocol initialization cache (simulating agent restart).
        (keyStore as DwnDataStore<Jwk>)['_protocolInitializedCache']?.clear();
        // Also clear the encryption active cache so it must be re-detected.
        (keyStore as any)._tenantEncryptionActive?.clear();

        // Second call — protocol is already installed, should detect $encryption.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // Encryption should still be detected as active.
        expect((keyStore as any).isEncryptionActive(tenantDid)).to.be.true;
      });

      it('should detect no encryption from a legacy protocol without $encryption', async () => {
        const tenantDid = testHarness.agent.agentDid.uri;

        // Install the protocol WITHOUT $encryption (bypass the encrypted installProtocol).
        await testHarness.agent.dwn.processRequest({
          author        : tenantDid,
          target        : tenantDid,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : { definition: JwkProtocolDefinition },
        });

        // Create a new DwnKeyStore (no caches populated).
        const freshKeyStore = new DwnKeyStore();

        // Initialize — should find the existing protocol and detect no $encryption.
        await (freshKeyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        expect((freshKeyStore as any).isEncryptionActive(tenantDid)).to.be.false;
      });
    });

    describe('getAllRecords() error handling', () => {
      afterEach(() => {
        sinon.restore();
      });

      it('should throw when an encrypted record read returns no data', async () => {
        // Store an encrypted key first.
        await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        // Stub processRequest to return a successful query (with encryption
        // metadata) followed by a RecordsRead that returns no data.
        const originalProcessRequest = testHarness.agent.dwn.processRequest.bind(testHarness.agent.dwn);
        let queryCallCount = 0;
        sinon.stub(testHarness.agent.dwn, 'processRequest').callsFake(async (request: any): Promise<any> => {
          // Let the RecordsQuery pass through normally.
          if (request.messageType === DwnInterface.RecordsQuery) {
            queryCallCount++;
            return originalProcessRequest(request);
          }

          // For RecordsRead with encryption, return a reply with no data.
          if (request.messageType === DwnInterface.RecordsRead && request.encryption) {
            return {
              messageCid : 'test-cid',
              message    : {},
              reply      : {
                status : { code: 200, detail: 'OK' },
                entry  : { recordsWrite: {}, data: undefined }
              }
            };
          }

          // Everything else passes through.
          return originalProcessRequest(request);
        });

        // Clear the index so getAllRecords() is called on the next list().
        (keyStore as any)._index.clear();

        try {
          await keyStore.list({ agent: testHarness.agent });
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).to.include('Failed to read encrypted key record');
        }

        expect(queryCallCount).to.be.greaterThan(0);
      });

      it('should handle mixed encrypted and unencrypted records', async () => {
        // Step 1: Write an unencrypted record directly (simulating a legacy record).
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });
        const legacyKey: Jwk = {
          kid : 'legacy-key-1',
          kty : 'OKP',
          crv : 'Ed25519',
          alg : 'EdDSA',
          x   : 'testx',
          d   : 'testd',
        };
        const legacyBytes = Convert.object(legacyKey).toUint8Array();
        await testHarness.agent.dwn.processRequest({
          author        : testHarness.agent.agentDid.uri,
          target        : testHarness.agent.agentDid.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            dataFormat   : 'application/json',
            protocol     : JwkProtocolDefinition.protocol,
            protocolPath : 'privateJwk',
            schema       : JwkProtocolDefinition.types.privateJwk.schema,
          },
          dataStream: new Blob([legacyBytes], { type: 'application/json' })
        });

        // Step 2: Write an encrypted record through the store API.
        const encryptedKeyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Step 3: List all records — should include both legacy (unencrypted)
        // and new (encrypted) records.
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys.length).to.be.at.least(2);

        const kids = storedKeys.map((k: Jwk): string | undefined => k.kid);
        expect(kids).to.include('legacy-key-1');

        // Verify the encrypted key is also present.
        const encryptedKey = storedKeys.find(
          (k: Jwk): boolean => `urn:jwk:${k.kid}` === encryptedKeyUri
        );
        expect(encryptedKey).to.exist;
        expect(encryptedKey).to.have.property('d');
      });
    });
  });
});
