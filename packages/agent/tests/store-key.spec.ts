import type { BearerDid } from '@enbox/dids';
import type { Jwk } from '@enbox/crypto';
import type { AgentDataStore, DwnDataStore } from '../src/store-data.js';

import { Convert } from '@enbox/common';
import { DwnInterface } from '../src/types/dwn.js';
import { JwkProtocolDefinition } from '../src/store-data-protocols.js';
import { LocalKeyManager } from '../src/local-key-manager.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ContentEncryptionAlgorithm, Encoder, KeyDerivationScheme, PrivateKeySigner, RecordsWrite } from '@enbox/dwn-sdk-js';
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

      it('throws an error if legacy unencrypted records exceed DWN max data size for query results', async () => {
        // Inject an oversized unencrypted record directly into the message store
        // (bypassing the handler which now enforces encryptionRequired) to simulate
        // a legacy record whose encodedData is missing from query results.
        const keyBytes = Convert.string(new Array(102400 + 1).join('0')).toUint8Array();

        // Initialize the storage protocol (which now includes $encryption keys).
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // Build an unencrypted RecordsWrite and inject it directly into the
        // message store to simulate a pre-existing legacy record. The oversized
        // payload means encodedData will be absent from query results.
        const tenant = testHarness.agent.agentDid.uri;
        const portableDid = await testHarness.agent.agentDid.export();
        const signer = new PrivateKeySigner({
          privateJwk : portableDid.privateKeys![0] as any,
          keyId      : portableDid.document.verificationMethod![0].id,
        });
        const recordsWrite = await RecordsWrite.create({
          dataFormat   : 'application/json',
          protocol     : JwkProtocolDefinition.protocol,
          protocolPath : 'privateJwk',
          schema       : JwkProtocolDefinition.types.privateJwk.schema,
          signer,
          data         : keyBytes,
        });
        const { messageStore } = testHarness.agent.dwn.node.storage;
        const indexes = await recordsWrite.constructIndexes(true);
        await messageStore.put(tenant, recordsWrite.message, indexes);

        try {
          await keyStore.list({ agent: testHarness.agent });
          throw new Error('Expected an error to be thrown');

        } catch (error: any) {
          expect(error.message).toContain(`Expected 'encodedData' to be present in the DWN query result entry`);
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
      it('should detect $keyAgreement from an already-installed protocol after cache clear', async () => {
        // First call — installs the protocol with $keyAgreement.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // Verify encryption is active.
        const tenantDid = testHarness.agent.agentDid.uri;
        expect((keyStore as any).isEncryptionActive(tenantDid)).toBe(true);

        // Clear the protocol initialization cache (simulating agent restart).
        (keyStore as DwnDataStore<Jwk>)['_protocolInitializedCache']?.clear();
        // Also clear the encryption active cache so it must be re-detected.
        (keyStore as any)._tenantEncryptionActive?.clear();

        // Second call — protocol is already installed, should detect $keyAgreement.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // Encryption should still be detected as active.
        expect((keyStore as any).isEncryptionActive(tenantDid)).toBe(true);
      });

      it('should reject an encrypted protocol without $keyAgreement', async () => {
        const tenantDid = testHarness.agent.agentDid.uri;

        await expect(testHarness.agent.dwn.processRequest({
          author        : tenantDid,
          target        : tenantDid,
          messageType   : DwnInterface.ProtocolsConfigure,
          messageParams : { definition: JwkProtocolDefinition },
        })).rejects.toThrow('ProtocolsConfigureMissingTopLevelKeyAgreement');
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
        (keyStore as any)._tenantEncryptionActive?.clear();

        // Re-initialize — should detect the existing protocol, not re-install.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // The previously written encrypted record should still be readable.
        const storedKeyAfter = await keyStore.get({ id: keyUri, agent: testHarness.agent });
        expect(storedKeyAfter).toBeDefined();
        expect(storedKeyAfter!.kty).toBe(storedKeyBefore!.kty);
        expect(storedKeyAfter!.kid).toBe(storedKeyBefore!.kid);
      });

      it('should re-derive encryption state after natural TTL expiry', async () => {
        const { TtlCache } = await import('@enbox/common');

        // First call — installs the protocol with $encryption.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        const tenantDid = testHarness.agent.agentDid.uri;
        expect((keyStore as any).isEncryptionActive(tenantDid)).toBe(true);

        // Replace both caches with short-TTL versions. Use staggered
        // TTLs (1ms vs 50ms) to simulate the real-world scenario where
        // the encryption cache and protocol-init cache are populated at
        // slightly different times during initialize(), so one expires
        // before the other. This is the actual failure mode: the init
        // cache survives while the encryption cache has already expired,
        // causing initialize() to short-circuit without re-deriving
        // encryption state.
        const shortEncCache = new TtlCache<string, boolean>({ ttl: 1, max: 100 });
        const shortInitCache = new TtlCache<string, boolean>({ ttl: 50, max: 100 });
        shortEncCache.set(tenantDid, true);
        shortInitCache.set(tenantDid, true);
        (keyStore as any)._tenantEncryptionActive = shortEncCache;
        (keyStore as DwnDataStore<Jwk>)['_protocolInitializedCache'] = shortInitCache;

        // Wait for the encryption cache to expire but not the init cache.
        await new Promise<void>(resolve => setTimeout(resolve, 10));

        // Encryption cache expired, but init cache still alive.
        expect(shortEncCache.has(tenantDid)).toBe(false);
        expect(shortInitCache.has(tenantDid)).toBe(true);

        // Re-initialize — the init cache still has the entry, so
        // initialize() will return early. But because both caches are
        // set atomically at the end of initialize() (not staggered),
        // the only way the encryption cache can be missing while the
        // init cache is present is if they were populated at different
        // times — which is what this test simulates.
        //
        // The production fix ensures both caches are always set at the
        // same instant, so if one expires, the other does too.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        // With the fix in place, the init cache short-circuits, and
        // encryption state was set at the same time as the init cache,
        // so it's still valid. Verify via isEncryptionActive:
        // If both caches expired together (the fixed behavior), this
        // would re-derive. If only encryption expired (the bug), this
        // would return false.
        expect((keyStore as any).isEncryptionActive(tenantDid)).toBe(true);
      });

      it('should re-query protocol after both caches expire together', async () => {
        const { TtlCache } = await import('@enbox/common');

        // First call — installs the protocol with $encryption.
        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        const tenantDid = testHarness.agent.agentDid.uri;
        expect((keyStore as any).isEncryptionActive(tenantDid)).toBe(true);

        // Replace both caches with 1ms-TTL versions — same TTL so they
        // expire together (the production behavior after the fix).
        const shortInitCache = new TtlCache<string, boolean>({ ttl: 1, max: 100 });
        const shortEncCache = new TtlCache<string, boolean>({ ttl: 1, max: 100 });
        shortInitCache.set(tenantDid, true);
        shortEncCache.set(tenantDid, true);
        (keyStore as DwnDataStore<Jwk>)['_protocolInitializedCache'] = shortInitCache;
        (keyStore as any)._tenantEncryptionActive = shortEncCache;

        // Wait for both to expire.
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        expect(shortInitCache.has(tenantDid)).toBe(false);
        expect(shortEncCache.has(tenantDid)).toBe(false);

        // Spy to verify a ProtocolsQuery is issued (not short-circuited).
        const processRequestSpy = spyOn(testHarness.agent.dwn, 'processRequest');

        await (keyStore as DwnDataStore<Jwk>)['initialize']({ agent: testHarness.agent });

        const protocolsQueryCall = processRequestSpy.mock.calls.find(
          (args: any[]) => args[0]?.messageType === DwnInterface.ProtocolsQuery
        );
        expect(protocolsQueryCall).toBeDefined();
        expect((keyStore as any).isEncryptionActive(tenantDid)).toBe(true);

        processRequestSpy.mockRestore();
      });
    });

    describe('getAllRecords() error handling', () => {
      afterEach(() => {
        mock.restore();
      });

      it('should throw when an encrypted record read returns no data', async () => {
        // Store an encrypted key first.
        await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

        // Stub processRequest to return a successful query (with encryption
        // metadata) followed by a RecordsRead that returns no data.
        const originalProcessRequest = testHarness.agent.dwn.processRequest.bind(testHarness.agent.dwn);
        let queryCallCount = 0;
        spyOn(testHarness.agent.dwn, 'processRequest').mockImplementation(async (request: any): Promise<any> => {
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
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain('Failed to read encrypted key record');
        }

        expect(queryCallCount).toBeGreaterThan(0);
      });

      it('should handle mixed encrypted and unencrypted records', async () => {
        // Step 1: Inject an unencrypted record directly into the message store
        // (bypassing the handler which now enforces encryptionRequired) to
        // simulate a pre-existing legacy record.
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
        const tenant = testHarness.agent.agentDid.uri;
        const portableDid = await testHarness.agent.agentDid.export();
        const signer = new PrivateKeySigner({
          privateJwk : portableDid.privateKeys![0] as any,
          keyId      : portableDid.document.verificationMethod![0].id,
        });
        const legacyWrite = await RecordsWrite.create({
          dataFormat   : 'application/json',
          protocol     : JwkProtocolDefinition.protocol,
          protocolPath : 'privateJwk',
          schema       : JwkProtocolDefinition.types.privateJwk.schema,
          signer,
          data         : legacyBytes,
        });
        const { messageStore } = testHarness.agent.dwn.node.storage;
        const legacyIndexes = await legacyWrite.constructIndexes(true);
        // Inline encodedData so the record is returned with data in query results.
        const legacyMessage = legacyWrite.message as any;
        legacyMessage.encodedData = Encoder.bytesToBase64Url(legacyBytes);
        await messageStore.put(tenant, legacyMessage, legacyIndexes);

        // Step 2: Write an encrypted record through the store API.
        const encryptedKeyUri = await testHarness.agent.keyManager.generateKey({
          algorithm: 'Ed25519'
        });

        // Step 3: List all records — should include both legacy (unencrypted)
        // and new (encrypted) records.
        const storedKeys = await keyStore.list({ agent: testHarness.agent });
        expect(storedKeys.length).toBeGreaterThanOrEqual(2);

        const kids = storedKeys.map((k: Jwk): string | undefined => k.kid);
        expect(kids).toContain('legacy-key-1');

        // Verify the encrypted key is also present.
        const encryptedKey = storedKeys.find(
          (k: Jwk): boolean => `urn:jwk:${k.kid}` === encryptedKeyUri
        );
        expect(encryptedKey).toBeDefined();
        expect(encryptedKey).toHaveProperty('d');
      });
    });
  });
});
