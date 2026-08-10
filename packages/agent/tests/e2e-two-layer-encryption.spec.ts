import type { Jwk } from '@enbox/crypto';
import type { ProtocolDefinition, RecordsWriteMessage, SourceRoleAudienceKeyEncryption } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { afterAll, describe, expect, it } from 'bun:test';
import {
  ContentEncryptionAlgorithm,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  KeyDerivationScheme,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { EnboxUserAgent } from '../src/enbox-user-agent.js';
import { JwkProtocolDefinition } from '../src/store-data-protocols.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { resolveAudienceDecryptionKey } from '../src/dwn-encryption.js';

/**
 * End-to-end test for two-layer encryption and recovery from seed phrase.
 *
 * Layer 1 (Vault): The agent's PortableDid is encrypted as a CompactJWE using
 * AES-256-GCM with a key derived via PBKDF2 from the user's password. The
 * underlying key material is deterministically derived from a BIP-39 seed phrase.
 *
 * Layer 2 (DWN record-level): Private keys stored in the DWN via DwnKeyStore are
 * encrypted using DWN protocol-path key agreement. The protocol definition for
 * JWK storage has `encryptionRequired: true`, which triggers `$keyAgreement`
 * key injection at protocol install time.
 *
 * Recovery path: seed phrase → deterministic agent DID → X25519 `#enc` key →
 * decrypt DWN key records.
 */
describe('e2e: two-layer encryption recovery', () => {
  const testDataLocation = '__TESTDATA__/e2e-two-layer-encryption';
  const password = 'test-password-e2e';
  const newPassword = 'new-password-after-recovery';

  let recoveryPhrase: string;
  let originalAgentDidUri: string;
  let originalKeyUris: string[];
  let originalKeys: Jwk[];
  let audienceRecoveryKeyId: string;
  const audienceRecoveryProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/two-layer-audience-recovery',
    types     : {
      admin : { dataFormats: ['application/json'] },
      note  : { dataFormats: ['text/plain'], encryptionRequired: true },
    },
    structure: {
      admin : { $role: true },
      note  : { $actions: [{ role: 'admin', can: ['read'] }] },
    },
  };

  afterAll(async () => {
    // Final cleanup: remove all test data by setting up and tearing down a harness.
    // Wrapped in try/catch to avoid masking test failures if cleanup itself fails
    // (e.g., when the entire suite was skipped due to DHT publish failures).
    try {
      const cleanupHarness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'dwn',
        testDataLocation,
      });
      await cleanupHarness.clearStorage();
      await cleanupHarness.closeStorage();
    } catch {
      // Cleanup failure is non-fatal; test data may remain on disk.
    }
  });

  describe('Phase 1: initialize agent and generate encrypted keys', () => {
    let harness: PlatformAgentTestHarness;

    it('should initialize the agent, returning a recovery phrase', async () => {
      harness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'dwn',
        testDataLocation,
      });

      // Initialize the vault — this creates the agent DID (did:dht with Ed25519 +
      // X25519) deterministically from a generated seed phrase, and encrypts
      // the PortableDid with the password (Layer 1).
      recoveryPhrase = await (harness.agent as EnboxUserAgent).initialize({
        password,
        dwnEndpoints: ['https://dwn.example.com'],
      });
      expect(typeof recoveryPhrase).toBe('string');
      expect(recoveryPhrase.split(' ')).toHaveLength(12);

      // Start the agent (unlocks the vault).
      await (harness.agent as EnboxUserAgent).start({ password });
      originalAgentDidUri = harness.agent.agentDid.uri;
      expect(originalAgentDidUri).toMatch(/^did:dht:/);
    });

    it('should have Ed25519 (#sig) and X25519 (#enc) verification methods', async () => {
      // The agent DID must have both verification methods for the two-layer
      // encryption to function. Ed25519 #sig is for signing; X25519 #enc is
      // the keyAgreement key used by Layer 2 (JWE encryption of DWN records).
      const doc = harness.agent.agentDid.document;

      // Verify #sig (Ed25519) exists and is in authentication.
      const sigKey = doc.verificationMethod?.find(
        (vm: any): boolean => vm.id.endsWith('#sig')
      );
      expect(sigKey).toBeDefined();
      expect(sigKey?.publicKeyJwk).toHaveProperty('kty', 'OKP');
      expect(sigKey?.publicKeyJwk).toHaveProperty('crv', 'Ed25519');
      expect(
        (doc.authentication as string[]).some((r: string): boolean => r.endsWith('#sig'))
      ).toBe(true);

      // Verify #enc (X25519) exists and is in keyAgreement.
      const encKey = doc.verificationMethod?.find(
        (vm: any): boolean => vm.id.endsWith('#enc')
      );
      expect(encKey).toBeDefined();
      expect(encKey?.publicKeyJwk).toHaveProperty('kty', 'OKP');
      expect(encKey?.publicKeyJwk).toHaveProperty('crv', 'X25519');
      expect(encKey?.publicKeyJwk).toHaveProperty('x');
      expect(encKey?.publicKeyJwk).not.toHaveProperty('d'); // public only in document
      expect(
        (doc.keyAgreement as string[]).some((r: string): boolean => r.endsWith('#enc'))
      ).toBe(true);

      // Verify #enc is NOT in authentication (it's only for keyAgreement).
      expect(
        (doc.authentication ?? []).some((r: string): boolean => r.endsWith('#enc'))
      ).toBe(false);
    });

    it('should generate keys that are encrypted at the DWN level (Layer 2)', async () => {
      // Generate multiple keys through the key manager — each is stored via
      // DwnKeyStore which encrypts them using the protocol's $keyAgreement keys.
      const keyUri1 = await harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
      const keyUri2 = await harness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
      const keyUri3 = await harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
      originalKeyUris = [keyUri1, keyUri2, keyUri3];

      // Read the keys back through the store API (transparent decryption).
      originalKeys = [];
      for (const keyUri of originalKeyUris) {
        const key = await harness.agent.keyManager.exportKey({ keyUri });
        expect(key).toBeDefined();
        expect(key).toHaveProperty('d'); // private key material present
        originalKeys.push(key);
      }
    });

    it('should have $keyAgreement injected into the installed JWK protocol', async () => {
      // The JwkProtocolDefinition has `encryptionRequired: true` on the privateJwk
      // type. When installed, DwnDataStore.installProtocol() derives and injects
      // `$keyAgreement` keys into the protocol structure. Verify this happened.
      const { reply } = await harness.agent.dwn.processRequest({
        author        : originalAgentDidUri,
        target        : originalAgentDidUri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: JwkProtocolDefinition.protocol }
        },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entries).toHaveLength(1);

      // Verify $keyAgreement was injected into the protocol root and privateJwk rule set.
      const installedDefinition = reply.entries![0].descriptor.definition;
      const privateJwkRuleSet = installedDefinition.structure.privateJwk;
      expect(installedDefinition).toHaveProperty('$keyAgreement');
      expect(installedDefinition.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
      expect(privateJwkRuleSet).toHaveProperty('$keyAgreement');
      expect(privateJwkRuleSet.$keyAgreement.publicKeyJwk).toHaveProperty('crv', 'X25519');
    });

    it('should have encryption metadata on raw DWN records with ciphertext', async () => {
      // Query the raw DWN records to verify they carry encryption metadata,
      // proving data is not stored in plaintext.
      const { reply } = await harness.agent.dwn.processRequest({
        author        : originalAgentDidUri,
        target        : originalAgentDidUri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : JwkProtocolDefinition.protocol,
            protocolPath : 'privateJwk',
          }
        },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entries).toHaveLength(3);

      for (const entry of reply.entries!) {
        // Verify encryption metadata is present.
        expect(entry.encryption).toBeDefined();
        expect(entry.encryption!.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
        expect(entry.encryption!.keyEncryption).toHaveLength(1);
        expect(entry.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

        // Verify the raw data is ciphertext, not readable JSON. Encrypted records
        // may have encodedData (base64url ciphertext) — if present, decoding it
        // should NOT produce valid JSON with key material.
        if (entry.encodedData) {
          const rawBytes = Convert.base64Url(entry.encodedData).toUint8Array();
          let parsedAsJson: any;
          try {
            parsedAsJson = JSON.parse(new TextDecoder().decode(rawBytes));
          } catch {
            // Expected: ciphertext is not valid JSON. This is correct.
            parsedAsJson = null;
          }
          // If by chance the ciphertext decodes as JSON, it must NOT contain
          // private key material (the 'd' field).
          if (parsedAsJson !== null) {
            expect(parsedAsJson).not.toHaveProperty('d');
          }
        }
      }
    });

    it('should write a sealed audience key for seed-recovery verification', async () => {
      const protocolConfigure = await harness.agent.dwn.processRequest({
        author        : originalAgentDidUri,
        target        : originalAgentDidUri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: audienceRecoveryProtocol },
      });
      expect(protocolConfigure.reply.status.code).toBe(202);

      const { reply, message } = await harness.agent.dwn.processRequest({
        author        : originalAgentDidUri,
        target        : originalAgentDidUri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : audienceRecoveryProtocol.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          data         : new TextEncoder().encode('sealed audience recovery note'),
        },
      });
      expect(reply.status.code).toBe(202);

      const roleAudienceEntry = (message as RecordsWriteMessage).encryption?.keyEncryption.find(
        (entry): entry is SourceRoleAudienceKeyEncryption => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME
      );
      expect(roleAudienceEntry).toBeDefined();
      audienceRecoveryKeyId = roleAudienceEntry!.keyId;

      const audienceQuery = await harness.agent.dwn.processRequest({
        author        : originalAgentDidUri,
        target        : originalAgentDidUri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : audienceRecoveryProtocol.protocol,
            protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
            tags         : {
              protocol  : audienceRecoveryProtocol.protocol,
              rolePath  : 'admin',
              contextId : '',
              keyId     : audienceRecoveryKeyId,
            },
          },
        },
      });
      expect(audienceQuery.reply.status.code).toBe(200);
      expect(audienceQuery.reply.entries).toHaveLength(1);
      const audiencePayload = Encoder.base64UrlToObject(audienceQuery.reply.entries![0].encodedData!) as any;
      expect(audiencePayload.sealedPrivateKey.derivationScheme).toBe('seal');
    });

    it('should close the agent cleanly', async () => {
      await harness.closeStorage();
    });
  });

  describe('Phase 2: recover agent from seed phrase and read encrypted keys', () => {
    let harness: PlatformAgentTestHarness;

    it('should create a new agent instance with the same storage paths', async () => {
      // Create a fresh agent pointed at the same LevelDB paths. The DWN data is
      // still on disk; we need to unlock the vault and verify we can read it.
      harness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'dwn',
        testDataLocation,
      });

      // The vault should be locked since we just created a fresh agent instance.
      expect((harness.agent as EnboxUserAgent).vault.isLocked()).toBe(true);
    });

    it('should recover the agent DID using the seed phrase (Layer 1)', async () => {
      // Clear the vault store to simulate the recovery scenario: the vault data
      // is gone (e.g., app reinstalled) but DWN records persist on disk.
      // This is required because HdIdentityVault.initialize() rejects if the
      // vault is already initialized.
      await harness.vaultStore.clear();

      // Re-initialize with the original recovery phrase but a NEW password.
      // The seed phrase deterministically re-derives the same agent DID, and the
      // new password re-encrypts the vault.
      const returnedPhrase = await (harness.agent as EnboxUserAgent).initialize({
        password: newPassword,
        recoveryPhrase,
      });
      expect(returnedPhrase).toBe(recoveryPhrase);

      // Verify the vault reports as initialized after recovery.
      expect(await (harness.agent as EnboxUserAgent).vault.isInitialized()).toBe(true);

      // Start the agent with the new password.
      await (harness.agent as EnboxUserAgent).start({ password: newPassword });

      // The recovered agent DID should be identical to the original.
      expect(harness.agent.agentDid.uri).toBe(originalAgentDidUri);
    });

    it('should reject the old password after recovery (Layer 1 re-encryption)', async () => {
      // After recovery with a new password, the vault CEK was re-encrypted.
      // Attempting to start with the old password must fail, proving Layer 1
      // re-encryption was effective.

      // Lock the vault first to simulate a fresh start attempt.
      await (harness.agent as EnboxUserAgent).vault.lock();

      try {
        await (harness.agent as EnboxUserAgent).start({ password });
        throw new Error('Expected an error when using the old password');
      } catch (error: any) {
        // Re-throw Error from throw new Error() so it isn't swallowed.
        if (error.message === 'Expected an error when using the old password') { throw error; }
        expect(error.message).toContain('incorrect password');
      }

      // Re-unlock with the correct (new) password to continue the test.
      await (harness.agent as EnboxUserAgent).start({ password: newPassword });
    });

    it('should read back all encrypted keys with exact match (Layer 2)', async () => {
      // Read each key back — the DwnKeyStore transparently decrypts using the
      // recovered agent DID's X25519 `#enc` key.
      for (let i = 0; i < originalKeyUris.length; i++) {
        const recovered = await harness.agent.keyManager.exportKey({
          keyUri: originalKeyUris[i]
        });

        expect(recovered).toBeDefined();
        expect(recovered.kid).toBe(originalKeys[i].kid);
        expect(recovered.kty).toBe(originalKeys[i].kty);
        expect(recovered.crv).toBe(originalKeys[i].crv);
        expect(recovered.d).toBe(originalKeys[i].d);
        expect(recovered.x).toBe(originalKeys[i].x);
        // secp256k1 keys have a `y` coordinate; Ed25519 keys do not.
        if (originalKeys[i].y !== undefined) {
          expect(recovered.y).toBe(originalKeys[i].y);
        }
      }
    });

    it('should recover a role-audience key from the stored seal using only the seed-derived owner key', async () => {
      const recoveredAudienceKey = await resolveAudienceDecryptionKey({
        agent        : harness.agent,
        sourceDid    : originalAgentDidUri,
        recipientDid : originalAgentDidUri,
        protocol     : audienceRecoveryProtocol.protocol,
        contextId    : '',
        rolePath     : 'admin',
        keyId        : audienceRecoveryKeyId,
      });

      expect(recoveredAudienceKey?.keyMaterial.keyId).toBe(audienceRecoveryKeyId);
      expect(recoveredAudienceKey?.keyMaterial.privateKeyJwk.d).toBeDefined();
    });

    it('should verify the vault is usable with the new password', async () => {
      // Generate an additional key to prove the recovered agent is fully operational.
      const newKeyUri = await harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
      const newKey = await harness.agent.keyManager.exportKey({ keyUri: newKeyUri });
      expect(newKey).toBeDefined();
      expect(newKey).toHaveProperty('d');
    });

    it('should clean up', async () => {
      await harness.clearStorage();
      await harness.closeStorage();
    });
  });
});
