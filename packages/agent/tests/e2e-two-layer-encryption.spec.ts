import type { Jwk } from '@enbox/crypto';

import { expect } from 'chai';

import { DwnInterface } from '../src/types/dwn.js';
import { JwkProtocolDefinition } from '../src/store-data-protocols.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { Web5UserAgent } from '../src/web5-user-agent.js';

/**
 * End-to-end test for two-layer encryption and recovery from seed phrase.
 *
 * Layer 1 (Vault): The agent's PortableDid is encrypted as a CompactJWE using
 * AES-256-GCM with a key derived via PBKDF2 from the user's password. The
 * underlying key material is deterministically derived from a BIP-39 seed phrase.
 *
 * Layer 2 (DWN record-level): Private keys stored in the DWN via DwnKeyStore are
 * encrypted using ECIES with the agent DID's secp256k1 `#enc` key. The protocol
 * definition for JWK storage has `encryptionRequired: true`, which triggers
 * `$encryption` key injection at protocol install time.
 *
 * Recovery path: seed phrase → deterministic agent DID → secp256k1 `#enc` key →
 * decrypt DWN key records.
 */
describe('e2e: two-layer encryption recovery', function () {
  this.timeout(30_000);

  const testDataLocation = '__TESTDATA__/e2e-two-layer-encryption';
  const password = 'test-password-e2e';
  const newPassword = 'new-password-after-recovery';

  let recoveryPhrase: string;
  let originalAgentDidUri: string;
  let originalKeyUris: string[];
  let originalKeys: Jwk[];

  after(async () => {
    // Final cleanup: remove all test data by setting up and tearing down a harness.
    const cleanupHarness = await PlatformAgentTestHarness.setup({
      agentClass  : Web5UserAgent,
      agentStores : 'dwn',
      testDataLocation,
    });
    await cleanupHarness.clearStorage();
    await cleanupHarness.closeStorage();
  });

  describe('Phase 1: initialize agent and generate encrypted keys', () => {
    let harness: PlatformAgentTestHarness;

    it('should initialize the agent, returning a recovery phrase', async () => {
      harness = await PlatformAgentTestHarness.setup({
        agentClass  : Web5UserAgent,
        agentStores : 'dwn',
        testDataLocation,
      });

      // Initialize the vault — this creates the agent DID (did:dht with Ed25519 +
      // secp256k1) deterministically from a generated seed phrase, and encrypts
      // the PortableDid with the password (Layer 1).
      recoveryPhrase = await (harness.agent as Web5UserAgent).initialize({ password });
      expect(recoveryPhrase).to.be.a('string');
      expect(recoveryPhrase.split(' ')).to.have.length(12);

      // Start the agent (unlocks the vault).
      await (harness.agent as Web5UserAgent).start({ password });
      originalAgentDidUri = harness.agent.agentDid.uri;
      expect(originalAgentDidUri).to.match(/^did:dht:/);
    });

    it('should generate keys that are encrypted at the DWN level (Layer 2)', async () => {
      // Generate multiple keys through the key manager — each is stored via
      // DwnKeyStore which encrypts them using the protocol's $encryption keys.
      const keyUri1 = await harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
      const keyUri2 = await harness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
      const keyUri3 = await harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
      originalKeyUris = [keyUri1, keyUri2, keyUri3];

      // Read the keys back through the store API (transparent decryption).
      originalKeys = [];
      for (const keyUri of originalKeyUris) {
        const key = await harness.agent.keyManager.exportKey({ keyUri });
        expect(key).to.exist;
        expect(key).to.have.property('d'); // private key material present
        originalKeys.push(key);
      }
    });

    it('should have encryption metadata on raw DWN records', async () => {
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

      expect(reply.status.code).to.equal(200);
      expect(reply.entries).to.have.length(3);

      for (const entry of reply.entries!) {
        expect(entry.encryption).to.exist;
        expect(entry.encryption!.algorithm).to.equal('A256CTR');
      }
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
        agentClass  : Web5UserAgent,
        agentStores : 'dwn',
        testDataLocation,
      });
    });

    it('should recover the agent DID using the seed phrase (Layer 1)', async () => {
      // Re-initialize with the original recovery phrase but a NEW password.
      // The seed phrase deterministically re-derives the same agent DID, and the
      // new password re-encrypts the vault.
      const returnedPhrase = await (harness.agent as Web5UserAgent).initialize({
        password: newPassword,
        recoveryPhrase,
      });
      expect(returnedPhrase).to.equal(recoveryPhrase);

      // Start the agent with the new password.
      await (harness.agent as Web5UserAgent).start({ password: newPassword });

      // The recovered agent DID should be identical to the original.
      expect(harness.agent.agentDid.uri).to.equal(originalAgentDidUri);
    });

    it('should read back all encrypted keys with exact match (Layer 2)', async () => {
      // Read each key back — the DwnKeyStore transparently decrypts using the
      // recovered agent DID's secp256k1 `#enc` key.
      for (let i = 0; i < originalKeyUris.length; i++) {
        const recovered = await harness.agent.keyManager.exportKey({
          keyUri: originalKeyUris[i]
        });

        expect(recovered).to.exist;
        expect(recovered.kid).to.equal(originalKeys[i].kid);
        expect(recovered.kty).to.equal(originalKeys[i].kty);
        expect(recovered.crv).to.equal(originalKeys[i].crv);
        expect(recovered.d).to.equal(originalKeys[i].d);
        expect(recovered.x).to.equal(originalKeys[i].x);
      }
    });

    it('should verify the vault is usable with the new password', async () => {
      // Generate an additional key to prove the recovered agent is fully operational.
      const newKeyUri = await harness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });
      const newKey = await harness.agent.keyManager.exportKey({ keyUri: newKeyUri });
      expect(newKey).to.exist;
      expect(newKey).to.have.property('d');
    });

    it('should clean up', async () => {
      await harness.clearStorage();
      await harness.closeStorage();
    });
  });
});
