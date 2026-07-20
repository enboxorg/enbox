import type { BearerDid } from '@enbox/dids';
import type { Jwk } from '@enbox/crypto';
import type { AgentDataStore, DwnDataStore } from '../src/store-data.js';

import { DwnInterface } from '../src/types/dwn.js';
import { JwkProtocolDefinition } from '../src/store-data-protocols.js';
import { LocalKeyManager } from '../src/local-key-manager.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ContentEncryptionAlgorithm, DwnConstant, KeyDerivationScheme } from '@enbox/dwn-sdk-js';
import { DidDht, DidJwk } from '@enbox/dids';
import { DwnKeyStore, InMemoryKeyStore } from '../src/store-key.js';

describe('KeyStore', () => {
  describe('InMemoryKeyStore', () => {
    let testHarness: PlatformAgentTestHarness;
    let keyStore: AgentDataStore<Jwk>;

    beforeAll(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass  : TestAgent,
        agentStores : 'memory'
      });

      await testHarness.clearStorage();
      await testHarness.createAgentDid();
    });

    beforeEach(async () => {
      await testHarness.clearDwnStores();
      keyStore = new InMemoryKeyStore();
      const keyManager = new LocalKeyManager({ agent: testHarness.agent, keyStore });
      testHarness.agent.keyManager = keyManager;
    });

    afterAll(async () => {
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    describe('constructor', () => {
      it('creates a InMemoryKeyStore', () => {
        const store = new InMemoryKeyStore();
        expect(store).toBeInstanceOf(InMemoryKeyStore);
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
        expect(deleteResult).toBe(true);

        const storedKey = await keyStore.get({
          id    : keyUri,
          agent : testHarness.agent
        });
        expect(storedKey).toBeUndefined();
      });

      it('should return false if Private Key does not exist', async () => {
        const deleteResult = await keyStore.delete({ id: 'non-existent', agent: testHarness.agent });
        expect(deleteResult).toBe(false);
      });
    });

    describe('get()', () => {
      it('should return a Private Key by URI if it exists', async () => {
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        const storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).toBeDefined();
        expect(keyUri).toContain(storedKey!.kid);
      });

      it('should return undefined when attempting to get a non-existent DID', async () => {
        const storedKey = await keyStore.get({ id: 'non-existent', agent: testHarness.agent });
        expect(storedKey).toBeUndefined();
      });
    });

    describe('list()', () => {
      it('should return an array of all Private Keys in the store', async () => {
        const keyUri1 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri2 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri3 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).toHaveLength(3);
        const importedKeys = [keyUri1, keyUri2, keyUri3];
        for (const storedKey of storedKeys) {
          expect(importedKeys).toContain(`urn:jwk:${storedKey.kid}`);
        }
      });

      it('returns an empty array if there are no Private Keys in the store', async () => {
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).toHaveLength(0);
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
        expect(storedKey).toBeDefined();
        expect(storedKey!.kid).toBe('test-key');
      });
    });
  });

  describe('DwnKeyStore', () => {
    let testHarness: PlatformAgentTestHarness;
    let keyStore: AgentDataStore<Jwk>;
    // Cache the X25519 DID across tests to avoid expensive key generation
    // on every beforeEach. The DID object is self-contained and can be reused.
    let x25519Did: BearerDid;

    beforeAll(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass       : TestAgent,
        agentStores      : 'memory',
        testDataLocation : '__TESTDATA__/dwn-key-store'
      });
      x25519Did = await DidDht.create({
        options: {
          publish             : true,
          gatewayUri          : process.env.DID_DHT_GATEWAY_URI ?? 'http://localhost:7527',
          verificationMethods : [
            {
              algorithm : 'Ed25519',
              id        : 'sig',
              purposes  : ['assertionMethod', 'authentication']
            },
            {
              algorithm : 'X25519',
              id        : 'enc',
              purposes  : ['keyAgreement']
            }
          ]
        }
      });
    });

    beforeEach(async () => {
      await testHarness.clearDwnStores();
      // Use X25519 for the agent DID so that DWN record-level encryption
      // (which requires an X25519 keyAgreement key) works correctly.
      testHarness.agent.agentDid = x25519Did;
      keyStore = new DwnKeyStore();
      const keyManager = new LocalKeyManager({ agent: testHarness.agent, keyStore });
      testHarness.agent.keyManager = keyManager;
    });

    afterAll(async () => {
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    describe('constructor', () => {
      it('creates a DwnKeyStore', () => {
        const store = new DwnKeyStore();
        expect(store).toBeInstanceOf(DwnKeyStore);
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
        expect(deleteResult).toBe(true);

        const storedKey = await keyStore.get({
          id    : keyUri,
          agent : testHarness.agent
        });
        expect(storedKey).toBeUndefined();
      });

      it('should return false if Private Key does not exist', async () => {
        const deleteResult = await keyStore.delete({ id: 'non-existent', agent: testHarness.agent });
        expect(deleteResult).toBe(false);
      });
    });

    describe('get()', () => {
      it('should return a Private Key by URI if it exists', async () => {
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        const storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).toBeDefined();
        expect(keyUri).toContain(storedKey!.kid);
      });

      it('should return undefined when attempting to get a non-existent DID', async () => {
        const storedKey = await keyStore.get({ id: 'non-existent', agent: testHarness.agent });
        expect(storedKey).toBeUndefined();
      });
    });

    describe('list()', () => {
      it('should return an array of all Private Keys in the store', async () => {
        const keyUri1 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri2 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri3 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).toHaveLength(3);
        const importedKeys = [keyUri1, keyUri2, keyUri3];
        for (const storedKey of storedKeys) {
          expect(importedKeys).toContain(`urn:jwk:${storedKey.kid}`);
        }
      });

      it('returns an empty array if there are no Private Keys in the store', async () => {
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).toHaveLength(0);
      });

      it('reads encrypted key data that is too large for query inlining', async () => {
        const largeKey: Jwk = {
          alg : 'EdDSA',
          crv : 'Ed25519',
          d   : 'test-private-value',
          kid : 'large-encrypted-key',
          kty : 'OKP',
          x   : 'A'.repeat(DwnConstant.maxDataSizeAllowedToBeEncoded + 1),
        };
        await keyStore.set({
          agent : testHarness.agent,
          data  : largeKey,
          id    : 'urn:jwk:large-encrypted-key',
        });
        const processRequestSpy = spyOn(testHarness.agent.dwn, 'processRequest');

        const storedKeys = await keyStore.list({ agent: testHarness.agent });

        expect(storedKeys).toEqual([largeKey]);
        expect(processRequestSpy.mock.calls.some(
          (args: any[]): boolean => args[0]?.messageType === DwnInterface.RecordsRead
        )).toBe(true);
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
        expect(storedKey).toBeDefined();
        expect(storedKey!.kid).toBe('test-key');
      });
    });

    describe('encryption at rest', () => {
      it('installs the JWK protocol with $keyAgreement keys', async () => {
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

        expect(reply.status.code).toBe(200);
        expect(reply.entries).toHaveLength(1);

        // Verify $keyAgreement was injected into the protocol definition.
        const installedDefinition = reply.entries![0].descriptor.definition;
        const privateJwkRuleSet = installedDefinition.structure.privateJwk;
        expect(installedDefinition).toHaveProperty('$keyAgreement');
        expect(installedDefinition.$keyAgreement.publicKeyJwk.crv).toBe('X25519');
        expect(privateJwkRuleSet).toHaveProperty('$keyAgreement');
        expect(privateJwkRuleSet.$keyAgreement.publicKeyJwk.crv).toBe('X25519');
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

        expect(queryReply.entries).toHaveLength(1);

        // The raw query entry should have encryption metadata, indicating the
        // record is encrypted at the DWN level.
        const rawRecord = queryReply.entries![0];
        expect(rawRecord.encryption).toBeDefined();
        expect(rawRecord.encryption!.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
        expect(rawRecord.encryption!.initializationVector).toBeDefined();
        expect(rawRecord.encryption!.keyEncryption).toHaveLength(1);
        expect(rawRecord.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

        // Read back through the store API — should be decrypted transparently.
        const storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).toBeDefined();
        expect(keyUri).toContain(storedKey!.kid);
        // Verify key properties survive the encrypt/decrypt round-trip.
        expect(storedKey!.kty).toBe('OKP');
        expect(storedKey!.crv).toBe('Ed25519');
        expect(storedKey).toHaveProperty('d'); // private key material present
      });

      it('list() decrypts all encrypted key records', async () => {
        // Generate multiple keys.
        const keyUri1 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const keyUri2 = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
        const keyUri3 = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        // List all keys — should return all three, decrypted.
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys).toHaveLength(3);

        const storedKids = storedKeys.map((k: Jwk): string => `urn:jwk:${k.kid}`);
        expect(storedKids).toContain(keyUri1);
        expect(storedKids).toContain(keyUri2);
        expect(storedKids).toContain(keyUri3);

        // Every returned key should have private key material.
        for (const key of storedKeys) {
          expect(key).toHaveProperty('d');
        }
      });

      it('encrypted key survives delete and re-create cycle', async () => {
        // Create a key.
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Verify it exists.
        let storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).toBeDefined();

        // Delete it.
        const deleted = await keyStore.delete({ id: keyUri, agent: testHarness.agent });
        expect(deleted).toBe(true);

        // Verify it's gone.
        storedKey = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKey).toBeUndefined();

        // Create a new key with the same algorithm.
        const keyUri2 = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Verify the new key exists and is different.
        const storedKey2 = await keyStore.get({ id: keyUri2, agent: testHarness.agent });
        expect(storedKey2).toBeDefined();
        expect(keyUri2).not.toBe(keyUri);
      });
    });

    describe('encryption required — Ed25519-only agent DID rejection', () => {
      // These tests verify that DwnKeyStore (whose protocol definition has
      // encryptionRequired: true) refuses to operate when the agent DID lacks an
      // X25519 keyAgreement key. No plaintext fallback is allowed.
      let ed25519Harness: PlatformAgentTestHarness;
      let ed25519KeyStore: AgentDataStore<Jwk>;

      beforeAll(async () => {
        ed25519Harness = await PlatformAgentTestHarness.setup({
          agentClass       : TestAgent,
          agentStores      : 'memory',
          testDataLocation : '__TESTDATA__/plaintext-fallback'
        });
      });

      beforeEach(async () => {
        await ed25519Harness.clearDwnStores();
        // Explicitly create an Ed25519-only did:jwk (no secp256k1 keyAgreement).
        ed25519Harness.agent.agentDid = await DidJwk.create({
          options: { algorithm: 'Ed25519' }
        });
        ed25519KeyStore = new DwnKeyStore();
        const keyManager = new LocalKeyManager({ agent: ed25519Harness.agent, keyStore: ed25519KeyStore });
        ed25519Harness.agent.keyManager = keyManager;
      });

      afterAll(async () => {
        await ed25519Harness.clearStorage();
        await ed25519Harness.closeStorage();
      });

      it('should throw when generating a key with an Ed25519-only agent DID', async () => {
        // DwnKeyStore requires encryption. An Ed25519-only agent DID cannot
        // derive encryption keys (the converted X25519 key is not in the KMS),
        // so generateKey() must throw — not silently store the key in plaintext.
        try {
          await ed25519Harness.agent.keyManager.generateKey({
            algorithm: 'Ed25519'
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          // getEncryptionKeyInfo() now auto-converts Ed25519→X25519, but the
          // converted key is not in the KMS. Error is "Key not found" rather
          // than the original "DWN encryption requires 'X25519'".
          expect(error.message).toContain('Key not found');
        }
      });

      it('should throw during protocol installation for Ed25519-only agent DID', async () => {
        // Directly calling initialize() should throw because installProtocol()
        // no longer catches encryption key derivation failures.
        try {
          await (ed25519KeyStore as DwnDataStore<Jwk>)['initialize']({ agent: ed25519Harness.agent });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          // Same as above: Ed25519→X25519 conversion succeeds but the
          // converted key is not in the KMS.
          expect(error.message).toContain('Key not found');
        }
      });
    });

    describe('protocol re-initialization', () => {
      it('should derive $keyAgreement when configuring an encrypted protocol', async () => {
        const tenantDid = testHarness.agent.agentDid.uri;

        const { message, reply } = await testHarness.agent.dwn.processRequest({
          author        : tenantDid,
          target        : tenantDid,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : { definition: JwkProtocolDefinition },
        });

        expect(reply.status.code).toBe(202);
        expect(message.descriptor.definition.structure.privateJwk.$keyAgreement).toBeDefined();
      });

      it('should still decrypt old records after re-initialization', async () => {
        // Write an encrypted key record.
        const keyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Read it back to verify it decrypts successfully.
        const storedKeyBefore = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKeyBefore).toBeDefined();
        expect(storedKeyBefore!.kty).toBe('OKP');

        // Clear the protocol initialization cache (simulating agent restart).
        (keyStore as DwnDataStore<Jwk>)['_protocolInitializedCache']?.clear();

        // Re-initialize — should recognize the existing protocol, not re-install.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // The previously written encrypted record should still be readable.
        const storedKeyAfter = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKeyAfter).toBeDefined();
        expect(storedKeyAfter!.kty).toBe(storedKeyBefore!.kty);
        expect(storedKeyAfter!.kid).toBe(storedKeyBefore!.kid);
      });

      it('should re-query protocol after the initialization cache expires', async () => {
        const { TtlCache } = await import('@enbox/common');

        // First call installs the protocol and caches initialization.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        const tenantDid = testHarness.agent.agentDid.uri;
        const shortInitCache = new TtlCache<string, boolean>({ ttl: 1, max: 100 });
        shortInitCache.set(tenantDid, true);
        (keyStore as DwnDataStore<Jwk>)['_protocolInitializedCache'] = shortInitCache;

        // Let the cache expire, then verify initialization checks the DWN again.
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        expect(shortInitCache.has(tenantDid)).toBe(false);

        const processRequestSpy = spyOn(testHarness.agent.dwn, 'processRequest');

        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        const protocolsQueryCall = processRequestSpy.mock.calls.find(
          (args: any[]) => args[0]?.messageType === DwnInterface.ProtocolsQuery
        );
        expect(protocolsQueryCall).toBeDefined();

        processRequestSpy.mockRestore();
      });
    });

    describe('getAllRecords() error handling', () => {
      afterEach(() => {
        mock.restore();
      });

      it('should throw when neither a query entry nor its backing read supplies stored data', async () => {
        await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        const originalProcessRequest = testHarness.agent.dwn.processRequest.bind(testHarness.agent.dwn);
        spyOn(testHarness.agent.dwn, 'processRequest').mockImplementation(async (request: any): Promise<any> => {
          if (request.messageType === DwnInterface.RecordsQuery) {
            const result = await originalProcessRequest(request);
            return {
              ...result,
              reply: {
                ...result.reply,
                entries: result.reply.entries.map((entry: any): any => ({ ...entry, encodedData: undefined })),
              },
            };
          }
          if (request.messageType === DwnInterface.RecordsRead) {
            return {
              messageCid : 'test-cid',
              message    : {},
              reply      : {
                entry  : { data: undefined, recordsWrite: {} },
                status : { code: 200, detail: 'OK' },
              },
            };
          }
          return originalProcessRequest(request);
        });

        (keyStore as any)._index.clear();
        await expect(keyStore.list({ agent: testHarness.agent }))
          .rejects.toThrow('Failed to read stored key record');
      });

      it('should decrypt inline encrypted keys without additional RecordsRead requests', async () => {
        await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
        const processRequestSpy = spyOn(testHarness.agent.dwn, 'processRequest');

        (keyStore as any)._index.clear();
        const storedKeys = await keyStore.list({ agent: testHarness.agent });

        expect(storedKeys).toHaveLength(2);
        expect(processRequestSpy.mock.calls.some(
          (args: any[]): boolean => args[0]?.messageType === DwnInterface.RecordsRead
        )).toBe(false);
      });
    });
  });
});
