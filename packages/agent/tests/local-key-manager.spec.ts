import type { BearerDid } from '@enbox/dids';
import type { Jwk, JwkParamsOkpPublic } from '@enbox/crypto';
import type { PrivateKeyJwk, PublicKeyJwk } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { CryptoErrorCode, CryptoUtils, Ed25519, X25519 } from '@enbox/crypto';
import { Encryption, HdKey, KeyAgreementAlgorithm, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';

import { isChrome } from './utils/runtimes.js';
import { LocalKeyManager } from '../src/local-key-manager.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

describe('LocalKeyManager', () => {
  describe('get agent', () => {
    it(`returns the 'agent' instance property`, async () => {
      // @ts-expect-error because we are only mocking a single property.
      const mockAgent: EnboxPlatformAgent = {
        agentDid: { uri: 'did:method:abc123' } as BearerDid
      };
      const keyManager = new LocalKeyManager({ agent: mockAgent });
      const agent = keyManager.agent;
      expect(agent).toBeDefined();
      expect(agent.agentDid.uri).toBe('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, () => {
      const keyManager = new LocalKeyManager({});
      expect(() =>
        keyManager.agent
      ).toThrow('Unable to determine agent execution context');
    });
  });

  // Run tests for each supported data store type.
  const agentStoreTypes = ['dwn', 'memory'] as const;
  agentStoreTypes.forEach((agentStoreType) => {

    describe(`with ${agentStoreType} key store`, () => {
      let testHarness: PlatformAgentTestHarness;

      beforeAll(async () => {
        testHarness = await PlatformAgentTestHarness.setup({
          agentClass  : TestAgent,
          agentStores : agentStoreType
        });
      });

      beforeEach(async () => {
        await testHarness.clearStorage();
        await testHarness.createAgentDid();
      });

      afterAll(async () => {
        await testHarness.clearStorage();
        await testHarness.closeStorage();
      });

      describe('decrypt()', () => {
        it('returns plaintext as a Uint8Array', async () => {
          // Setup.
          const privateKey: Jwk = {
            alg : 'A128GCM',
            k   : '3k6i3iaSl7-_S-NH3N1GMQ',
            kty : 'oct',
            kid : 'HLYc5oFZYs3OfBfOa-dWL5md__xFUIpx1BJ6ueCPQQQ'
          };
          const ciphertext = Convert.hex('f27e81aa63c315a5cd03e2abcbc62a5665').toUint8Array();
          const decryptionKeyUri = await testHarness.agent.keyManager.importKey({ key: privateKey });

          // Test the method.
          const plaintext = await testHarness.agent.keyManager.decrypt({
            keyUri : decryptionKeyUri,
            data   : ciphertext,
            iv     : new Uint8Array(12)
          });

          // Validate the results.
          expect(plaintext).toBeInstanceOf(Uint8Array);
          const expectedPlaintext = Convert.hex('01').toUint8Array();
          expect(plaintext).toEqual(expectedPlaintext);
        });
      });

      describe('encrypt()', () => {
        it('returns ciphertext as a Uint8Array', async () => {
          // Setup.
          const encryptionKeyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A128GCM' });
          const plaintext = new Uint8Array([1, 2, 3, 4]);
          const iv = CryptoUtils.randomBytes(12); // Initialization vector.
          const tagLength = 128; // Size in bits of the authentication tag.

          // Test the method.
          const ciphertext = await testHarness.agent.keyManager.encrypt({
            keyUri : encryptionKeyUri,
            data   : plaintext,
            iv,
            tagLength
          });

          // Validate the results.
          expect(ciphertext).toBeInstanceOf(Uint8Array);
          expect(ciphertext.byteLength).toBe(plaintext.byteLength + tagLength / 8);
        });
      });

      describe('importKey()', () => {
        it('imports a key and returns a key URI', async () => {
          // generate a key and import it
          const key = await Ed25519.generateKey();
          const keyUri = await testHarness.agent.keyManager.importKey({ key });

          // fetch the key using the keyUri
          const importedKey = await testHarness.agent.keyManager.exportKey({ keyUri });

          // validate the key
          expect(importedKey).toBeDefined();
          expect(importedKey).toEqual(key);
        });
      });

      describe('exportKey()', () => {
        it('exports a private key as a JWK', async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          const jwk = await testHarness.agent.keyManager.exportKey({ keyUri });

          expect(jwk).toBeDefined();
          expect(typeof jwk).toBe('object');
          expect(jwk).toHaveProperty('kty');
          expect(jwk).toHaveProperty('d');
        });

        it('throws an error if the key does not exist', async () => {
          const keyUri = 'urn:jwk:does-not-exist';

          try {
            await testHarness.agent.keyManager.exportKey({ keyUri });
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
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          expect(keyUri).toBeDefined();
          expect(typeof keyUri).toBe('string');
          expect(keyUri.indexOf('urn:jwk:')).toBe(0);
        });

        it(`supports generating 'secp256k1' keys`, async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
          expect(typeof keyUri).toBe('string');
        });

        it(`supports generating 'Ed25519' keys`, async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

          expect(keyUri).toBeDefined();
          expect(typeof keyUri).toBe('string');
          expect(keyUri.indexOf('urn:jwk:')).toBe(0);
        });

        it(`supports generating 'X25519' keys`, async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          expect(keyUri).toBeDefined();
          expect(typeof keyUri).toBe('string');
          expect(keyUri.indexOf('urn:jwk:')).toBe(0);
        });

        it(`supports generating 'AES-KW' keys`, async () => {
          let keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A128KW' });
          expect(typeof keyUri).toBe('string');

          // Skip this test in Chrome browser because it does not support AES with 192-bit keys.
          if (!isChrome) {
            keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A192KW' });
            expect(typeof keyUri).toBe('string');
          }

          keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A256KW' });
          expect(typeof keyUri).toBe('string');
        });

        it(`supports generating 'AES-GCM' keys`, async () => {
          let keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A128GCM' });
          expect(typeof keyUri).toBe('string');

          // Skip this test in Chrome browser because it does not support AES with 192-bit keys.
          if (!isChrome) {
            keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A192GCM' });
            expect(typeof keyUri).toBe('string');
          }

          keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A256GCM' });
          expect(typeof keyUri).toBe('string');
        });

        it('throws an error if the algorithm is not supported', async () => {
          // Setup.
          const algorithm = 'unsupported-algorithm';

          // Test the method.
          try {
            // @ts-expect-error because an unsupported algorithm is being tested.
            await testHarness.agent.keyManager.generateKey({ algorithm });
            throw new Error('Expected an error to be thrown.');

          } catch (error: any) {
            // Validate the result.
            expect(error).toBeDefined();
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toContain(`Algorithm not supported`);
            expect(error.code).toBe(CryptoErrorCode.AlgorithmNotSupported);
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
          const keyUri = await testHarness.agent.keyManager.getKeyUri({ key });

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
          const keyUri = await testHarness.agent.keyManager.getKeyUri({ key });

          expect(keyUri).toBe(expectedKeyUri);
        });
      });

      describe('unwrapKey()', () => {
        it('returns an unwrapped key as a JWK', async () => {
          const unwrappedKeyInput: Jwk = {
            kty : 'oct',
            k   : 'hX-1yAAU6aZCwGqViYfAhIiaTyu1PURMswoI4IQmiY4',
            alg : 'A256GCM',
            kid : '-TssSnJNgh10-YTwuBtyZTnv0LY6sdT-TQl9WFTSetI',
          };

          const encryptionKeyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A256KW' });

          const wrappedKeyBytes = await testHarness.agent.keyManager.wrapKey({ encryptionKeyUri, unwrappedKey: unwrappedKeyInput });

          const unwrappedKey = await testHarness.agent.keyManager.unwrapKey({ wrappedKeyBytes, wrappedKeyAlgorithm: 'A256GCM', decryptionKeyUri: encryptionKeyUri });

          expect(unwrappedKey).toHaveProperty('k');
          expect(unwrappedKey).toHaveProperty('kty', 'oct');
          expect(unwrappedKey).toHaveProperty('kid');
          expect(unwrappedKey).toHaveProperty('alg', 'A256GCM');
        });

        it('returns the expected wrapped key for given input', async () => {
          const wrappedKeyBytes = Convert.hex('8c55fb6fc4c7bb0b6b483df65ba52bee7ed6e0f861ac8097b2394f61067d1157901295aba72c514b').toUint8Array(); // raw format

          const decryptionKey: Jwk = {
            kty : 'oct',
            k   : '47Fn3ZXGbmntoAKErKN5-d7yuwMejCJtOqgAeq_Ojk0',
            alg : 'A256KW',
            kid : 'izA6N7g3xmPWStB6Qe6BbGgfrXvrptzuH2eJ1wmdrtk',
          };

          const decryptionKeyUri = await testHarness.agent.keyManager.importKey({ key: decryptionKey });

          const unwrappedKey = await testHarness.agent.keyManager.unwrapKey({ wrappedKeyBytes, wrappedKeyAlgorithm: 'A256GCM', decryptionKeyUri });

          const expectedPrivateKey: Jwk = {
            kty : 'oct',
            k   : 'hX-1yAAU6aZCwGqViYfAhIiaTyu1PURMswoI4IQmiY4',
            alg : 'A256GCM',
            kid : '-TssSnJNgh10-YTwuBtyZTnv0LY6sdT-TQl9WFTSetI',
          };

          expect(unwrappedKey).toEqual(expectedPrivateKey);
        });
      });

      describe('verify()', () => {
        it('returns true for a valid signature', async () => {
          // Setup.
          const privateKeyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
          const publicKey = await testHarness.agent.keyManager.getPublicKey({ keyUri: privateKeyUri });
          const data = new Uint8Array([0, 1, 2, 3, 4]);
          const signature = await testHarness.agent.keyManager.sign({ keyUri: privateKeyUri, data });

          // Test the method.
          const isValid = await testHarness.agent.keyManager.verify({ key: publicKey, signature, data });

          // Validate the result.
          expect(isValid).toBe(true);
        });

        it('returns false for an invalid signature', async () => {
          // Setup.
          const privateKeyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
          const publicKey = await testHarness.agent.keyManager.getPublicKey({ keyUri: privateKeyUri });
          const data = new Uint8Array([0, 1, 2, 3, 4]);
          const signature = new Uint8Array(64);

          // Test the method.
          const isValid = await testHarness.agent.keyManager.verify({ key: publicKey, signature, data });

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
            await testHarness.agent.keyManager.verify({ key, signature, data });
            throw new Error('Expected an error to be thrown.');

          } catch (error: any) {
            // Validate the result.
            expect(error).toBeDefined();
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toContain('Algorithm not supported');
          }
        });
      });

      describe('wrapKey()', () => {
        it('returns a wrapped key as a byte array', async () => {
          const unwrappedKey: Jwk = {
            kty : 'oct',
            k   : 'hX-1yAAU6aZCwGqViYfAhIiaTyu1PURMswoI4IQmiY4',
            alg : 'A256GCM',
            kid : '-TssSnJNgh10-YTwuBtyZTnv0LY6sdT-TQl9WFTSetI',
          };
          const encryptionKeyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A256KW' });

          const wrappedKeyBytes = await testHarness.agent.keyManager.wrapKey({ unwrappedKey, encryptionKeyUri });

          expect(wrappedKeyBytes).toBeInstanceOf(Uint8Array);
          expect(wrappedKeyBytes.byteLength).toBe(32 + 8); // 32 bytes for the wrapped private key, 8 bytes for the initialization vector
        });

        it('returns the expected wrapped key for given input', async () => {
          const unwrappedKey: Jwk = {
            kty : 'oct',
            k   : 'hX-1yAAU6aZCwGqViYfAhIiaTyu1PURMswoI4IQmiY4',
            alg : 'A256GCM',
            kid : '-TssSnJNgh10-YTwuBtyZTnv0LY6sdT-TQl9WFTSetI',
          };

          const encryptionKey: Jwk = {
            kty : 'oct',
            k   : '47Fn3ZXGbmntoAKErKN5-d7yuwMejCJtOqgAeq_Ojk0',
            alg : 'A256KW',
            kid : 'izA6N7g3xmPWStB6Qe6BbGgfrXvrptzuH2eJ1wmdrtk',
          };

          const encryptionKeyUri = await testHarness.agent.keyManager.importKey({ key: encryptionKey });

          const wrappedKeyBytes = await testHarness.agent.keyManager.wrapKey({ encryptionKeyUri, unwrappedKey });

          const expectedOutput = Convert.hex('8c55fb6fc4c7bb0b6b483df65ba52bee7ed6e0f861ac8097b2394f61067d1157901295aba72c514b').toUint8Array(); // raw format
          expect(wrappedKeyBytes).toEqual(expectedOutput);
        });
      });

      describe('deleteKey()', () => {
        it('deletes a key', async () => {
          // create key that will be stored in the keyStore
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // verify that you can get the key
          let key = await testHarness.agent.keyManager.getPublicKey({ keyUri });
          const computedKeyUri = await testHarness.agent.keyManager.getKeyUri({ key });
          expect(computedKeyUri).toBe(keyUri);

          // delete the key
          await testHarness.agent.keyManager.deleteKey({ keyUri });

          try {
            // verify that the key is no longer in the keyStore
            key = await testHarness.agent.keyManager.getPublicKey({ keyUri });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('Key not found');
          }
        });

        it('errors if key is not found', async () => {
          const keyUri = 'urn:jwk:does-not-exist';

          try {
            await testHarness.agent.keyManager.deleteKey({ keyUri });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error.message).toContain('Key not found');
          }
        });
      });

      describe('derivePublicKey()', () => {
        it('should derive a public key from a stored X25519 private key', async () => {
          // Generate an X25519 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Derive a child public key
          const derivedPublicKey = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['test', 'path']
          });

          // Verify the derived public key is X25519 (OKP)
          expect(derivedPublicKey).toHaveProperty('kty', 'OKP');
          expect(derivedPublicKey).toHaveProperty('crv', 'X25519');
          expect(derivedPublicKey).toHaveProperty('x');
          expect(derivedPublicKey).not.toHaveProperty('d'); // Should be public only
        });

        it('should derive different keys for different derivation paths', async () => {
          // Generate an X25519 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Derive two different child public keys
          const derivedKey1 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['path1']
          }) as JwkParamsOkpPublic;

          const derivedKey2 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['path2']
          }) as JwkParamsOkpPublic;

          // Verify they are different
          expect(derivedKey1.x).not.toBe(derivedKey2.x);
        });

        it('should derive the same key for the same derivation path', async () => {
          // Generate an X25519 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Derive the same child public key twice
          const derivedKey1 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['consistent', 'path']
          }) as JwkParamsOkpPublic;

          const derivedKey2 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['consistent', 'path']
          }) as JwkParamsOkpPublic;

          // Verify they are identical
          expect(derivedKey1.x).toBe(derivedKey2.x);
        });

        it('should throw an error when keyUri does not exist', async () => {
          const nonExistentKeyUri = 'urn:jwk:nonexistent';

          try {
            await testHarness.agent.keyManager.derivePublicKey({
              keyUri         : nonExistentKeyUri,
              derivationPath : ['test']
            });
            throw new Error('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error).toBeDefined();
            expect(error.message).toContain('Key not found');
          }
        });

        it('should handle empty derivation path', async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Empty derivation path should return the root key's public key
          const derivedKey = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: []
          });

          expect(derivedKey).toHaveProperty('kty', 'OKP');
          expect(derivedKey).toHaveProperty('crv', 'X25519');
        });
      });

      describe('unwrapContentKey()', () => {
        it('should unwrap a DWN key using a derived X25519 key', async () => {
          // Generate an X25519 key pair
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Get the private key bytes for test setup
          const storedPrivateKey = await testHarness.agent.keyManager['getPrivateKey']({ keyUri }) as PrivateKeyJwk;
          const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: storedPrivateKey });

          // Derive the same leaf key that will be used for unwrapping
          const derivationPath = ['test', 'unwrap'];
          const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, derivationPath);
          const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
          const leafPublicKeyJwk = await X25519.getPublicKey({ key: leafPrivateKeyJwk }) as PublicKeyJwk;

          const plaintext = CryptoUtils.randomBytes(32); // Simulated CEK
          const wrapped = await Encryption.wrapKey({
            cek      : plaintext,
            keyInput : {
              algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
              derivationScheme : KeyDerivationScheme.ProtocolPath,
              keyId            : await Encryption.getKeyId(leafPublicKeyJwk),
              publicKey        : leafPublicKeyJwk,
            },
          });

          // Unwrap using the key manager method
          const unwrapped = await testHarness.agent.keyManager.unwrapContentKey({
            keyUri,
            derivationPath,
            encryptedKey       : wrapped.encryptedKey,
            ephemeralPublicKey : wrapped.ephemeralPublicKey,
          });

          // Verify unwrapping succeeded — the unwrapped bytes should match the original CEK
          expect(unwrapped).toBeInstanceOf(Uint8Array);
          expect(unwrapped.length).toBe(32);
          expect(Convert.uint8Array(unwrapped).toHex()).toBe(
            Convert.uint8Array(plaintext).toHex()
          );
        });

        it('should fail to unwrap with wrong derivation path', async () => {
          // Generate an X25519 key pair
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Get the private key bytes for test setup
          const storedPrivateKey = await testHarness.agent.keyManager['getPrivateKey']({ keyUri }) as PrivateKeyJwk;
          const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: storedPrivateKey });

          // Derive a key for wrapping
          const correctPath = ['correct', 'path'];
          const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, correctPath);
          const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
          const leafPublicKeyJwk = await X25519.getPublicKey({ key: leafPrivateKeyJwk }) as PublicKeyJwk;

          const plaintext = CryptoUtils.randomBytes(32);
          const wrapped = await Encryption.wrapKey({
            cek      : plaintext,
            keyInput : {
              algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
              derivationScheme : KeyDerivationScheme.ProtocolPath,
              keyId            : await Encryption.getKeyId(leafPublicKeyJwk),
              publicKey        : leafPublicKeyJwk,
            },
          });

          // Attempt to unwrap with wrong derivation path
          const wrongPath = ['wrong', 'path'];

          try {
            await testHarness.agent.keyManager.unwrapContentKey({
              keyUri,
              derivationPath     : wrongPath,
              encryptedKey       : wrapped.encryptedKey,
              ephemeralPublicKey : wrapped.ephemeralPublicKey,
            });
            throw new Error('Expected unwrap to fail with wrong derivation path');
          } catch (error: any) {
            expect(error).toBeDefined();
          }
        });
      });

      describe('derivePrivateKeyBytes()', () => {
        it('should derive private key bytes from a stored X25519 private key', async () => {
          // Generate an X25519 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Derive child private key bytes
          const derivedKeyBytes = await testHarness.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath: ['test', 'private']
          });

          // Verify the result
          expect(derivedKeyBytes).toBeInstanceOf(Uint8Array);
          expect(derivedKeyBytes.length).toBe(32); // X25519 private keys are 32 bytes
        });

        it('should derive different keys for different derivation paths', async () => {
          // Generate an X25519 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Derive two different child private keys
          const derivedKey1 = await testHarness.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath: ['path1']
          });

          const derivedKey2 = await testHarness.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath: ['path2']
          });

          // Verify they are different
          expect(Convert.uint8Array(derivedKey1).toHex()).not.toBe(
            Convert.uint8Array(derivedKey2).toHex()
          );
        });

        it('should derive the same key for the same derivation path', async () => {
          // Generate an X25519 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          // Derive the same child private key twice
          const derivedKey1 = await testHarness.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath: ['consistent']
          });

          const derivedKey2 = await testHarness.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath: ['consistent']
          });

          // Verify they are identical
          expect(Convert.uint8Array(derivedKey1).toHex()).toBe(
            Convert.uint8Array(derivedKey2).toHex()
          );
        });

        it('should match the private key bytes used by derivePublicKey', async () => {
          // Generate an X25519 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'X25519' });

          const derivationPath = ['matching', 'test'];

          // Derive private key bytes
          const privateKeyBytes = await testHarness.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath
          });

          // Derive public key using derivePublicKey
          const publicKey = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath
          }) as JwkParamsOkpPublic;

          // Compute public key from private key bytes and verify they match
          const derivedPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes });
          const publicKeyFromBytes = await X25519.getPublicKey({ key: derivedPrivateKeyJwk }) as JwkParamsOkpPublic;

          expect(publicKeyFromBytes.x).toBe(publicKey.x);
        });
      });
    });
  });

  describe('getPrivateKey() agent DID keyManager fallback', () => {
    let testHarness: PlatformAgentTestHarness;

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
    });

    afterAll(async () => {
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    it('should return a key from the agent DID keyManager when present there', async () => {
      // The agent DID's own keyManager (BearerDid.keyManager) holds the DID's
      // private keys in memory. getPrivateKey() should find them without
      // hitting the key store — this prevents infinite recursion when the
      // DwnKeyStore is encrypted.
      const agentDid = testHarness.agent.agentDid;
      const vm = agentDid.document.verificationMethod?.[0];
      expect(vm?.publicKeyJwk).toBeDefined();

      // Compute the keyUri for the agent DID's key.
      const keyUri = await testHarness.agent.keyManager.getKeyUri({
        key: vm!.publicKeyJwk!
      });

      // getPrivateKey() should succeed via the agent DID keyManager fallback,
      // even though the key was never explicitly stored in the key store.
      const privateKey = await testHarness.agent.keyManager['getPrivateKey']({ keyUri });
      expect(privateKey).toBeDefined();
      expect(privateKey).toHaveProperty('d');
      expect(privateKey.kid).toBeDefined();
    });

    it('should fall through to the key store when agent DID keyManager throws', async () => {
      // Generate a key that lives in the key store, NOT in the agent DID keyManager.
      const keyUri = await testHarness.agent.keyManager.generateKey({
        algorithm: 'Ed25519'
      });

      // The agent DID keyManager will throw "Key not found" for this keyUri
      // since it only holds the agent DID's own key. getPrivateKey() should
      // catch the error and fall through to the key store where it will find it.
      const privateKey = await testHarness.agent.keyManager['getPrivateKey']({ keyUri });
      expect(privateKey).toBeDefined();
      expect(privateKey).toHaveProperty('d');
    });

    it('should skip the fallback when agent DID keyManager lacks exportKey', async () => {
      // Generate a key into the store.
      const keyUri = await testHarness.agent.keyManager.generateKey({
        algorithm: 'Ed25519'
      });

      // Replace the agent DID's keyManager with one that lacks exportKey.
      const savedKeyManager = testHarness.agent.agentDid.keyManager;
      testHarness.agent.agentDid.keyManager = {
        generateKey  : async (): Promise<string> => '',
        getKeyUri    : async (): Promise<string> => '',
        getPublicKey : async (): Promise<Jwk> => ({} as Jwk),
        sign         : async (): Promise<Uint8Array> => new Uint8Array(),
        verify       : async (): Promise<boolean> => false,
        digest       : async (): Promise<Uint8Array> => new Uint8Array(),
      } as any;

      try {
        // getPrivateKey() should skip the fallback (no exportKey) and use the store.
        const privateKey = await testHarness.agent.keyManager['getPrivateKey']({ keyUri });
        expect(privateKey).toBeDefined();
        expect(privateKey).toHaveProperty('d');
      } finally {
        testHarness.agent.agentDid.keyManager = savedKeyManager;
      }
    });

    it('should throw "Key not found" when key is in neither agent keyManager nor store', async () => {
      try {
        await testHarness.agent.keyManager['getPrivateKey']({
          keyUri: 'urn:jwk:nonexistent-key'
        });
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('Key not found');
      }
    });
  });
});
