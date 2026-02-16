import type { Jwk, JwkParamsEcPublic } from '@enbox/crypto';
import type { BearerDid } from '@enbox/dids';

import sinon from 'sinon';
import { expect } from 'chai';
import { Convert } from '@enbox/common';
import { CryptoUtils, Ed25519 } from '@enbox/crypto';
import type { PrivateJwk } from '@enbox/dwn-sdk-js';

import { Encryption, HdKey, Secp256k1 } from '@enbox/dwn-sdk-js';

import type { Web5PlatformAgent } from '../src/types/agent.js';

import { isChrome } from './utils/runtimes.js';
import { TestAgent } from './utils/test-agent.js';
import { LocalKeyManager } from '../src/local-key-manager.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { CryptoErrorCode } from '../src/prototyping/crypto/crypto-error.js';

describe('LocalKeyManager', () => {
  describe('get agent', () => {
    it(`returns the 'agent' instance property`, async () => {
      // @ts-expect-error because we are only mocking a single property.
      const mockAgent: Web5PlatformAgent = {
        agentDid: { uri: 'did:method:abc123' } as BearerDid
      };
      const keyManager = new LocalKeyManager({ agent: mockAgent });
      const agent = keyManager.agent;
      expect(agent).to.exist;
      expect(agent.agentDid.uri).to.equal('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, () => {
      const keyManager = new LocalKeyManager({});
      expect(() =>
        keyManager.agent
      ).to.throw(Error, 'Unable to determine agent execution context');
    });
  });

  // Run tests for each supported data store type.
  const agentStoreTypes = ['dwn', 'memory'] as const;
  agentStoreTypes.forEach((agentStoreType) => {

    describe(`with ${agentStoreType} key store`, () => {
      let testHarness: PlatformAgentTestHarness;

      before(async () => {
        testHarness = await PlatformAgentTestHarness.setup({
          agentClass  : TestAgent,
          agentStores : agentStoreType
        });
      });

      beforeEach(async () => {
        await testHarness.clearStorage();
        await testHarness.createAgentDid();
      });

      after(async () => {
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
          expect(plaintext).to.be.instanceOf(Uint8Array);
          const expectedPlaintext = Convert.hex('01').toUint8Array();
          expect(plaintext).to.deep.equal(expectedPlaintext);
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
          expect(ciphertext).to.be.instanceOf(Uint8Array);
          expect(ciphertext.byteLength).to.equal(plaintext.byteLength + tagLength / 8);
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
          expect(importedKey).to.exist;
          expect(importedKey).to.deep.equal(key);
        });
      });

      describe('exportKey()', () => {
        it('exports a private key as a JWK', async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          const jwk = await testHarness.agent.keyManager.exportKey({ keyUri });

          expect(jwk).to.exist;
          expect(jwk).to.be.an('object');
          expect(jwk).to.have.property('kty');
          expect(jwk).to.have.property('d');
        });

        it('throws an error if the key does not exist', async () => {
          const keyUri = 'urn:jwk:does-not-exist';

          try {
            await testHarness.agent.keyManager.exportKey({ keyUri });
            expect.fail('Expected an error to be thrown.');

          } catch (error: any) {
            expect(error).to.exist;
            expect(error).to.be.an.instanceOf(Error);
            expect(error.message).to.include('Key not found');
          }
        });
      });

      describe('generateKey()', () => {
        it('generates a key and returns a key URI', async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          expect(keyUri).to.exist;
          expect(keyUri).to.be.a.string;
          expect(keyUri.indexOf('urn:jwk:')).to.equal(0);
        });

        it(`supports generating 'secp256k1' keys`, async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });
          expect(keyUri).to.be.a.string;
        });

        it(`supports generating 'Ed25519' keys`, async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'Ed25519' });

          expect(keyUri).to.exist;
          expect(keyUri).to.be.a.string;
          expect(keyUri.indexOf('urn:jwk:')).to.equal(0);
        });

        it(`supports generating 'AES-KW' keys`, async () => {
          let keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A128KW' });
          expect(keyUri).to.be.a.string;

          // Skip this test in Chrome browser because it does not support AES with 192-bit keys.
          if (!isChrome) {
            keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A192KW' });
            expect(keyUri).to.be.a.string;
          }

          keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A256KW' });
          expect(keyUri).to.be.a.string;
        });

        it(`supports generating 'AES-GCM' keys`, async () => {
          let keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A128GCM' });
          expect(keyUri).to.be.a.string;

          // Skip this test in Chrome browser because it does not support AES with 192-bit keys.
          if (!isChrome) {
            keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A192GCM' });
            expect(keyUri).to.be.a.string;
          }

          keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'A256GCM' });
          expect(keyUri).to.be.a.string;
        });

        it('throws an error if the algorithm is not supported', async () => {
          // Setup.
          const algorithm = 'unsupported-algorithm';

          // Test the method.
          try {
            // @ts-expect-error because an unsupported algorithm is being tested.
            await testHarness.agent.keyManager.generateKey({ algorithm });
            expect.fail('Expected an error to be thrown.');

          } catch (error: any) {
            // Validate the result.
            expect(error).to.exist;
            expect(error).to.be.an.instanceOf(Error);
            expect(error.message).to.include(`Algorithm not supported`);
            expect(error.code).to.equal(CryptoErrorCode.AlgorithmNotSupported);
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
          expect(keyUri).to.exist;
          expect(keyUri).to.be.a.string;
          expect(keyUri.indexOf('urn:jwk:')).to.equal(0);
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

          expect(keyUri).to.equal(expectedKeyUri);
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

          expect(unwrappedKey).to.have.property('k');
          expect(unwrappedKey).to.have.property('kty', 'oct');
          expect(unwrappedKey).to.have.property('kid');
          expect(unwrappedKey).to.have.property('alg', 'A256GCM');
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

          expect(unwrappedKey).to.deep.equal(expectedPrivateKey);
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
          expect(isValid).to.be.true;
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
          expect(isValid).to.be.false;
        });


        it('throws an error when public key algorithm and curve are unsupported', async () => {
          // Setup.
          const key: Jwk = { kty: 'EC', alg: 'unsupported-algorithm', crv: 'unsupported-curve', x: 'x', y: 'y' };
          const signature = new Uint8Array(64);
          const data = new Uint8Array(0);

          // Test the method.
          try {
            await testHarness.agent.keyManager.verify({ key, signature, data });
            expect.fail('Expected an error to be thrown.');

          } catch (error: any) {
            // Validate the result.
            expect(error).to.exist;
            expect(error).to.be.an.instanceOf(Error);
            expect(error.message).to.include('Algorithm not supported');
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

          expect(wrappedKeyBytes).to.be.an.instanceOf(Uint8Array);
          expect(wrappedKeyBytes.byteLength).to.equal(32 + 8); // 32 bytes for the wrapped private key, 8 bytes for the initialization vector
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
          expect(wrappedKeyBytes).to.deep.equal(expectedOutput);
        });
      });

      describe('deleteKey()', () => {
        it('deletes a key', async () => {
          // create key that will be stored in the keyStore
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // verify that you can get the key
          let key = await testHarness.agent.keyManager.getPublicKey({ keyUri });
          const computedKeyUri = await testHarness.agent.keyManager.getKeyUri({ key });
          expect(computedKeyUri).to.equal(keyUri);

          // delete the key
          await testHarness.agent.keyManager.deleteKey({ keyUri });

          try {
            // verify that the key is no longer in the keyStore
            key = await testHarness.agent.keyManager.getPublicKey({ keyUri });
            expect.fail('Expected an error to be thrown.');
          } catch(error: any) {
            expect(error.message).to.include('Key not found');
          }
        });

        it('errors if key is not found', async () => {
          const keyUri = 'urn:jwk:does-not-exist';

          try {
            await testHarness.agent.keyManager.deleteKey({ keyUri });
            expect.fail('Expected an error to be thrown.');
          } catch(error: any) {
            expect(error.message).to.include('Key not found');
          }
        });
      });

      describe('derivePublicKey()', () => {
        it('should derive a public key from a stored secp256k1 private key', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // Derive a child public key
          const derivedPublicKey = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['test', 'path']
          });

          // Verify the derived public key
          expect(derivedPublicKey).to.have.property('kty', 'EC');
          expect(derivedPublicKey).to.have.property('crv', 'secp256k1');
          expect(derivedPublicKey).to.have.property('x');
          expect(derivedPublicKey).to.have.property('y');
          expect(derivedPublicKey).to.not.have.property('d'); // Should be public only
        });

        it('should derive different keys for different derivation paths', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // Derive two different child public keys
          const derivedKey1 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['path1']
          }) as JwkParamsEcPublic;

          const derivedKey2 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['path2']
          }) as JwkParamsEcPublic;

          // Verify they are different
          expect(derivedKey1.x).to.not.equal(derivedKey2.x);
          expect(derivedKey1.y).to.not.equal(derivedKey2.y);
        });

        it('should derive the same key for the same derivation path', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // Derive the same child public key twice
          const derivedKey1 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['consistent', 'path']
          }) as JwkParamsEcPublic;

          const derivedKey2 = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: ['consistent', 'path']
          }) as JwkParamsEcPublic;

          // Verify they are identical
          expect(derivedKey1.x).to.equal(derivedKey2.x);
          expect(derivedKey1.y).to.equal(derivedKey2.y);
        });

        it('should throw an error when keyUri does not exist', async () => {
          const nonExistentKeyUri = 'urn:jwk:nonexistent';

          try {
            await testHarness.agent.keyManager.derivePublicKey({
              keyUri         : nonExistentKeyUri,
              derivationPath : ['test']
            });
            expect.fail('Expected an error to be thrown.');
          } catch (error: any) {
            expect(error).to.exist;
            expect(error.message).to.include('Key not found');
          }
        });

        it('should handle empty derivation path', async () => {
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // Empty derivation path should return the root key's public key
          const derivedKey = await testHarness.agent.keyManager.derivePublicKey({
            keyUri,
            derivationPath: []
          });

          expect(derivedKey).to.have.property('kty', 'EC');
          expect(derivedKey).to.have.property('crv', 'secp256k1');
        });
      });

      describe('eciesSecp256k1Decrypt()', () => {
        it('should decrypt an ECIES-encrypted payload using a derived key', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // Get the private key for encryption setup
          const storedPrivateKey = await testHarness.agent.keyManager['getPrivateKey']({ keyUri }) as PrivateJwk;
          const privateKeyBytes = Secp256k1.privateJwkToBytes(storedPrivateKey);

          // Derive the same key that will be used for decryption
          const derivationPath = ['test', 'decryption'];
          const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, derivationPath);
          const leafPublicKeyBytes = await Secp256k1.getPublicKey(leafPrivateKeyBytes);

          // Encrypt a message using ECIES
          const plaintext = Convert.string('Hello, ECIES!').toUint8Array();
          const encryptedData = await Encryption.eciesSecp256k1Encrypt(leafPublicKeyBytes, plaintext);

          // Decrypt using the key manager method
          const decrypted = await testHarness.agent.keyManager.eciesSecp256k1Decrypt({
            keyUri,
            derivationPath,
            ciphertext                : encryptedData.ciphertext,
            ephemeralPublicKey        : encryptedData.ephemeralPublicKey,
            initializationVector      : encryptedData.initializationVector,
            messageAuthenticationCode : encryptedData.messageAuthenticationCode
          });

          // Verify decryption succeeded
          expect(Convert.uint8Array(decrypted).toString()).to.equal('Hello, ECIES!');
        });

        it('should fail to decrypt with wrong derivation path', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // Get the private key for encryption setup
          const storedPrivateKey = await testHarness.agent.keyManager['getPrivateKey']({ keyUri }) as PrivateJwk;
          const privateKeyBytes = Secp256k1.privateJwkToBytes(storedPrivateKey);

          // Derive a key for encryption
          const correctPath = ['correct', 'path'];
          const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, correctPath);
          const leafPublicKeyBytes = await Secp256k1.getPublicKey(leafPrivateKeyBytes);

          // Encrypt a message
          const plaintext = Convert.string('Secret message').toUint8Array();
          const encryptedData = await Encryption.eciesSecp256k1Encrypt(leafPublicKeyBytes, plaintext);

          // Attempt to decrypt with wrong derivation path
          const wrongPath = ['wrong', 'path'];

          try {
            await testHarness.agent.keyManager.eciesSecp256k1Decrypt({
              keyUri,
              derivationPath            : wrongPath,
              ciphertext                : encryptedData.ciphertext,
              ephemeralPublicKey        : encryptedData.ephemeralPublicKey,
              initializationVector      : encryptedData.initializationVector,
              messageAuthenticationCode : encryptedData.messageAuthenticationCode
            });
            expect.fail('Expected decryption to fail with wrong derivation path');
          } catch (error: any) {
            expect(error).to.exist;
          }
        });
      });

      describe('derivePrivateKeyBytes()', () => {
        it('should derive private key bytes from a stored secp256k1 private key', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

          // Derive child private key bytes
          const derivedKeyBytes = await testHarness.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath: ['test', 'private']
          });

          // Verify the result
          expect(derivedKeyBytes).to.be.instanceOf(Uint8Array);
          expect(derivedKeyBytes.length).to.equal(32); // secp256k1 private keys are 32 bytes
        });

        it('should derive different keys for different derivation paths', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

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
          expect(Convert.uint8Array(derivedKey1).toHex()).to.not.equal(
            Convert.uint8Array(derivedKey2).toHex()
          );
        });

        it('should derive the same key for the same derivation path', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

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
          expect(Convert.uint8Array(derivedKey1).toHex()).to.equal(
            Convert.uint8Array(derivedKey2).toHex()
          );
        });

        it('should match the private key bytes used by derivePublicKey', async () => {
          // Generate a secp256k1 key
          const keyUri = await testHarness.agent.keyManager.generateKey({ algorithm: 'secp256k1' });

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
          }) as JwkParamsEcPublic;

          // Compute public key from private key bytes and verify they match
          const publicKeyBytesFromPrivate = await Secp256k1.getPublicKey(privateKeyBytes);
          const publicKeyFromBytes = await Secp256k1.publicKeyToJwk(publicKeyBytesFromPrivate);

          expect(publicKeyFromBytes.x).to.equal(publicKey.x);
          expect(publicKeyFromBytes.y).to.equal(publicKey.y);
        });
      });
    });
  });
});
