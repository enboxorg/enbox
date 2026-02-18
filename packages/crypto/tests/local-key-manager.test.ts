import type { Jwk } from '../src/jose/jwk.js';
import type { KeyIdentifier } from '../src/types/identifier.js';

import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Convert, MemoryStore } from '@enbox/common';

import { EcdsaAlgorithm } from '../src/algorithms/ecdsa.js';
import { LocalKeyManager } from '../src/local-key-manager.js';

describe('LocalKeyManager', () => {
  let keyManager: LocalKeyManager;

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    keyManager = new LocalKeyManager();
  });

  describe('constructor', () => {
    it('initializes with default parameters', () => {
      const keyManager = new LocalKeyManager();
      expect(keyManager).toBeDefined();
      expect(keyManager).toBeInstanceOf(LocalKeyManager);
    });

    it('initializes with a custom in-memory key store', () => {
      const keyStore = new MemoryStore<KeyIdentifier, Jwk>();
      const keyManager = new LocalKeyManager({ keyStore });

      expect(keyManager).toBeDefined();
      expect(keyManager).toBeInstanceOf(LocalKeyManager);
    });
  });

  describe('digest()', () => {
    it('computes and returns a digest as a Uint8Array', async () => {
      // Setup.
      const data = new Uint8Array([0, 1, 2, 3, 4]);

      // Test the method.
      const digest = await keyManager.digest({ algorithm: 'SHA-256', data });

      // Validate the result.
      expect(digest).toBeDefined();
      expect(digest).toBeInstanceOf(Uint8Array);
    });

    it('supports SHA-256', async () => {
      // Setup.
      const data = Convert.string('abc').toUint8Array();
      const expectedOutput = Convert.hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad').toUint8Array();

      // Test the method.
      const digest = await keyManager.digest({ algorithm: 'SHA-256', data });

      // Validate the result.
      expect(digest).toBeDefined();
      expect(digest).toBeInstanceOf(Uint8Array);
      expect(digest).toHaveLength(32);
      expect(digest).toEqual(expectedOutput);
    });
  });

  describe('exportKey()', () => {
    it('exports a private key as a JWK', async () => {
      const keyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });

      const jwk = await keyManager.exportKey({ keyUri });

      expect(jwk).toBeDefined();
      expect(typeof jwk).toBe('object');
      expect(jwk).toHaveProperty('kty');
      expect(jwk).toHaveProperty('d');
    });

    it('throws an error if the key does not exist', async () => {
      const keyUri = 'urn:jwk:does-not-exist';

      try {
        await keyManager.exportKey({ keyUri });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Key not found');
      }
    });
  });

  describe('generateKey()', () => {
    it('generates a key and returns a key URI', async () => {
      const keyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });

      expect(keyUri).toBeDefined();
      expect(typeof keyUri).toBe('string');
      expect(keyUri.indexOf('urn:jwk:')).toBe(0);
    });

    it(`supports generating 'secp256k1' keys`, async () => {
      const keyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });

      expect(keyUri).toBeDefined();
      expect(typeof keyUri).toBe('string');
      expect(keyUri.indexOf('urn:jwk:')).toBe(0);
    });

    it(`supports generating 'Ed25519' keys`, async () => {
      const keyUri = await keyManager.generateKey({ algorithm: 'Ed25519' });

      expect(keyUri).toBeDefined();
      expect(typeof keyUri).toBe('string');
      expect(keyUri.indexOf('urn:jwk:')).toBe(0);
    });

    it('throws an error if the algorithm is not supported', async () => {
      // Setup.
      const algorithm = 'unsupported-algorithm';

      // Test the method.
      try {
        // @ts-expect-error because an unsupported algorithm is being tested.
        await keyManager.generateKey({ algorithm });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain(`Algorithm not supported: ${algorithm}`);
      }
    });

    it('throws an error if the generated key does not have a kid property', async () => {
      // Setup.
      const mockKeyGenerator = { generateKey: spyOn({ generateKey: () => {} }, 'generateKey').mockResolvedValue(undefined as any) };
      // @ts-expect-error because we're accessing a private property.
      keyManager._algorithmInstances.set(EcdsaAlgorithm, mockKeyGenerator); // Replace the algorithm instance with the mock.

      // Test the method.
      try {
        await keyManager.generateKey({ algorithm: 'secp256k1' });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('key is missing a required property');
      } finally {
        // Cleanup.
        mock.restore();
      }
    });
  });

  describe('getKeyUri()', () => {
    it('returns a string with the expected prefix', async () => {
      // Setup.
      const key: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        x   : '1SRPl0oKoKPFJ5FLSWnvftE13QD9GtYKldOj7GNKe8o',
        y   : 'EuCLyOvrsp10-rdi1PEiKSCF9DJIN-2PzR7zP14AqIw'
      };

      // Test the method.
      const keyUri = await keyManager.getKeyUri({ key });

      // Validate the result.
      expect(keyUri).toBeDefined();
      expect(typeof keyUri).toBe('string');
      expect(keyUri.indexOf('urn:jwk:')).toBe(0);
    });

    it('computes the key URI correctly for a valid JWK', async () => {
      // Setup.
      const key: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        x   : '1SRPl0oKoKPFJ5FLSWnvftE13QD9GtYKldOj7GNKe8o',
        y   : 'EuCLyOvrsp10-rdi1PEiKSCF9DJIN-2PzR7zP14AqIw'
      };
      const expectedThumbprint = 'vO8jHDKD8dynDvVp8Ea2szjIRz2V-hCMhtmJYOxO4oY';
      const expectedKeyUri = 'urn:jwk:' + expectedThumbprint;

      // Test the method.
      const keyUri = await keyManager.getKeyUri({ key });

      expect(keyUri).toBe(expectedKeyUri);
    });
  });

  describe('getPublicKey()', () => {
    it('computes the public key and returns a JWK', async () => {
      const keyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });

      const publicKey = await keyManager.getPublicKey({ keyUri });

      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('object');
      expect(publicKey).toHaveProperty('kty');
    });

    it('supports ECDSA using secp256k1 curve and SHA-256', async () => {
      const keyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });

      const publicKey = await keyManager.getPublicKey({ keyUri });

      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('object');
      expect(publicKey).toHaveProperty('kty', 'EC');
      expect(publicKey).toHaveProperty('alg', 'ES256K');
      expect(publicKey).toHaveProperty('crv', 'secp256k1');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).toHaveProperty('y');
      expect(publicKey).not.toHaveProperty('d');
    });

    it('supports EdDSA using Ed25519 curve', async () => {
      // Setup.
      const keyUri = await keyManager.generateKey({ algorithm: 'Ed25519' });

      // Test the method.
      const publicKey = await keyManager.getPublicKey({ keyUri });

      expect(publicKey).toBeDefined();
      expect(typeof publicKey).toBe('object');
      expect(publicKey).toHaveProperty('kty', 'OKP');
      expect(publicKey).toHaveProperty('alg', 'EdDSA');
      expect(publicKey).toHaveProperty('crv', 'Ed25519');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).not.toHaveProperty('y');
      expect(publicKey).not.toHaveProperty('d');
    });
  });

  describe('importKey()', () => {
    it('imports a private key and return a key URI', async () => {
      // Setup.
      const memoryStore = new MemoryStore<KeyIdentifier, Jwk>();
      const keyManager = new LocalKeyManager({ keyStore: memoryStore });
      const privateKey: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        kid : 'vO8jHDKD8dynDvVp8Ea2szjIRz2V-hCMhtmJYOxO4oY',
        x   : '1SRPl0oKoKPFJ5FLSWnvftE13QD9GtYKldOj7GNKe8o',
        y   : 'EuCLyOvrsp10-rdi1PEiKSCF9DJIN-2PzR7zP14AqIw',
        d   : 'v5YrWhgfoSpXvE7Oqz9WfLavsFzvMuHBPL2kDLRuWoI'
      };
      const expectedThumbprint = 'vO8jHDKD8dynDvVp8Ea2szjIRz2V-hCMhtmJYOxO4oY';
      const expectedKeyUri = 'urn:jwk:' + expectedThumbprint;

      // Test the method.
      const keyUri = await keyManager.importKey({ key: privateKey });

      // Validate the result.
      expect(keyUri).toBe(expectedKeyUri);
      const storedKey = await memoryStore.get(keyUri);
      expect(storedKey).toEqual(privateKey);
    });

    it('does not modify the kid property, if provided', async () => {
      // Setup.
      const memoryStore = new MemoryStore<KeyIdentifier, Jwk>();
      const keyManager = new LocalKeyManager({ keyStore: memoryStore });
      const privateKey: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        kid : 'custom-kid',
        x   : '1SRPl0oKoKPFJ5FLSWnvftE13QD9GtYKldOj7GNKe8o',
        y   : 'EuCLyOvrsp10-rdi1PEiKSCF9DJIN-2PzR7zP14AqIw',
        d   : 'v5YrWhgfoSpXvE7Oqz9WfLavsFzvMuHBPL2kDLRuWoI'
      };

      // Test the method.
      const keyUri = await keyManager.importKey({ key: privateKey });

      // Validate the result.
      const storedKey = await memoryStore.get(keyUri);
      expect(storedKey).toHaveProperty('kid', 'custom-kid');
    });

    it('adds the kid property, if missing', async () => {
      // Setup.
      const memoryStore = new MemoryStore<KeyIdentifier, Jwk>();
      const keyManager = new LocalKeyManager({ keyStore: memoryStore });
      const privateKey: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        x   : '1SRPl0oKoKPFJ5FLSWnvftE13QD9GtYKldOj7GNKe8o',
        y   : 'EuCLyOvrsp10-rdi1PEiKSCF9DJIN-2PzR7zP14AqIw',
        d   : 'v5YrWhgfoSpXvE7Oqz9WfLavsFzvMuHBPL2kDLRuWoI'
      };

      // Test the method.
      const keyUri = await keyManager.importKey({ key: privateKey });

      // Validate the result.
      const storedKey = await memoryStore.get(keyUri);
      expect(storedKey).toHaveProperty('kid');
    });

    it('does not mutate the provided key', async () => {
      // Setup.
      const privateKey: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        x   : '1SRPl0oKoKPFJ5FLSWnvftE13QD9GtYKldOj7GNKe8o',
        y   : 'EuCLyOvrsp10-rdi1PEiKSCF9DJIN-2PzR7zP14AqIw',
        d   : 'v5YrWhgfoSpXvE7Oqz9WfLavsFzvMuHBPL2kDLRuWoI'
      };
      const privateKeyCopy = structuredClone(privateKey);

      // Test the method.
      await keyManager.importKey({ key: privateKey });

      // Validate the result.
      expect(privateKey).toEqual(privateKeyCopy);
    });

    it('throws an error if the key is invalid', async () => {
      // Setup.
      // @ts-expect-error because an invalid JWK is being used to trigger the error.
      const invalidJwk: Jwk = {};

      // Test the method.
      try {
        await keyManager.importKey({ key: invalidJwk });
        throw new Error('Should have thrown an error');

      } catch (error: any) {
        // Validate the result.
        expect(error.message).toContain('Invalid key provided');
      }
    });

    it('throws an error if a public key is provided', async () => {
      // Setup.
      const publicKey: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        x   : '1SRPl0oKoKPFJ5FLSWnvftE13QD9GtYKldOj7GNKe8o',
        y   : 'EuCLyOvrsp10-rdi1PEiKSCF9DJIN-2PzR7zP14AqIw'
      };

      // Test the method.
      try {
        await keyManager.importKey({ key: publicKey });
        throw new Error('Should have thrown an error');

      } catch (error: any) {
        // Validate the result.
        expect(error.message).toContain('Invalid key provided');
      }
    });
  });

  describe('sign()', () => {
    it('generates signatures as Uint8Array', async () => {
      // Setup.
      const privateKeyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });
      const data = new Uint8Array([0, 1, 2, 3, 4]);

      // Test the method.
      const signature = await keyManager.sign({ keyUri: privateKeyUri, data });

      // Validate the result.
      expect(signature).toBeInstanceOf(Uint8Array);
    });
  });

  describe('verify()', () => {
    it('returns true for a valid signature', async () => {
      // Setup.
      const privateKeyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });
      const publicKey = await keyManager.getPublicKey({ keyUri: privateKeyUri });
      const data = new Uint8Array([0, 1, 2, 3, 4]);
      const signature = await keyManager.sign({ keyUri: privateKeyUri, data });

      // Test the method.
      const isValid = await keyManager.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(true);
    });

    it('returns false for an invalid signature', async () => {
      // Setup.
      const privateKeyUri = await keyManager.generateKey({ algorithm: 'secp256k1' });
      const publicKey = await keyManager.getPublicKey({ keyUri: privateKeyUri });
      const data = new Uint8Array([0, 1, 2, 3, 4]);
      const signature = new Uint8Array(64);

      // Test the method.
      const isValid = await keyManager.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(false);
    });


    it('throws an error when public key algorithm and curve are unsupported', async () => {
      // Setup.
      const key: Jwk = { kty: 'EC', alg: 'unsupported-algorithm', crv: 'unsupported-curve', x: 'x', y: 'y' };
      const signature = new Uint8Array(64);
      const data = new Uint8Array(0);

      // Test the method.
      try {
        await keyManager.verify({ key, signature, data });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Unable to determine algorithm based on provided input');
      }
    });
  });
});
