import type { Jwk } from '@enbox/crypto';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { expect } from 'chai';

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

    before(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass  : TestAgent,
        agentStores : 'memory'
      });
    });

    beforeEach(async () => {
      await testHarness.clearStorage();
      // Use secp256k1 for the agent DID so that DWN record-level encryption
      // (which requires a secp256k1 keyAgreement key) works correctly.
      testHarness.agent.agentDid = await DidJwk.create({
        options: { algorithm: 'secp256k1' }
      });
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
  });
});
