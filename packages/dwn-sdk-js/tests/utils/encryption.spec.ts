import type { PublicKeyJwk } from '../../src/types/jose-types.js';

import { ArrayUtility } from '../../src/utils/array.js';
import { DataStream } from '../../src/index.js';
import { TestDataGenerator } from './test-data-generator.js';
import { X25519 } from '@enbox/crypto';
import { ContentEncryptionAlgorithm, Encryption } from '../../src/utils/encryption.js';
import { describe, expect, it } from 'bun:test';

describe('Encryption', () => {
  describe('AEAD A256GCM', () => {
    it('should be able to encrypt and decrypt data correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12); // 96-bit nonce for AES-GCM

      const inputBytes = TestDataGenerator.randomBytes(1_000_000);

      const { ciphertext, tag } = await Encryption.aeadEncrypt(
        ContentEncryptionAlgorithm.A256GCM, key, iv, inputBytes
      );

      const plaintext = await Encryption.aeadDecrypt(
        ContentEncryptionAlgorithm.A256GCM, key, iv, ciphertext, tag
      );

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintext)).toBe(true);
    });

    it('should be able to encrypt and decrypt a data stream correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);

      const inputBytes = TestDataGenerator.randomBytes(1_000_000);
      const inputStream = DataStream.fromBytes(inputBytes);

      const { ciphertextStream, tag } = await Encryption.aeadEncryptStream(
        ContentEncryptionAlgorithm.A256GCM, key, iv, inputStream
      );

      const plaintextStream = await Encryption.aeadDecryptStream(
        ContentEncryptionAlgorithm.A256GCM, key, iv, ciphertextStream, tag
      );
      const plaintextBytes = await DataStream.toBytes(plaintextStream);

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintextBytes)).toBe(true);
    });
  });

  describe('AEAD XC20P', () => {
    it('should be able to encrypt and decrypt data correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const nonce = TestDataGenerator.randomBytes(24); // 192-bit nonce for XChaCha20-Poly1305

      const inputBytes = TestDataGenerator.randomBytes(1_000_000);

      const { ciphertext, tag } = await Encryption.aeadEncrypt(
        ContentEncryptionAlgorithm.XC20P, key, nonce, inputBytes
      );

      const plaintext = await Encryption.aeadDecrypt(
        ContentEncryptionAlgorithm.XC20P, key, nonce, ciphertext, tag
      );

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintext)).toBe(true);
    });

    it('should be able to encrypt and decrypt a data stream correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const nonce = TestDataGenerator.randomBytes(24);

      const inputBytes = TestDataGenerator.randomBytes(1_000_000);
      const inputStream = DataStream.fromBytes(inputBytes);

      const { ciphertextStream, tag } = await Encryption.aeadEncryptStream(
        ContentEncryptionAlgorithm.XC20P, key, nonce, inputStream
      );

      const plaintextStream = await Encryption.aeadDecryptStream(
        ContentEncryptionAlgorithm.XC20P, key, nonce, ciphertextStream, tag
      );
      const plaintextBytes = await DataStream.toBytes(plaintextStream);

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintextBytes)).toBe(true);
    });
  });

  describe('ECDH-ES+A256KW', () => {
    it('should be able to wrap and unwrap a CEK correctly', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey });
      const ephemeralPrivateKey = await X25519.generateKey();

      const cek = TestDataGenerator.randomBytes(32);

      const wrappedKey = await Encryption.ecdhEsWrapKey(
        ephemeralPrivateKey, recipientPublicKey, cek
      );

      const ephemeralPublicKey = await X25519.getPublicKey({ key: ephemeralPrivateKey });
      const unwrappedCek = await Encryption.ecdhEsUnwrapKey(
        recipientPrivateKey, ephemeralPublicKey, wrappedKey
      );

      expect(ArrayUtility.byteArraysEqual(cek, unwrappedCek)).toBe(true);
    });
  });

  describe('buildJwe', () => {
    it('should build a valid JWE structure with recipients', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;

      const cek = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const tag = TestDataGenerator.randomBytes(16);

      const jwe = await Encryption.buildJwe(
        {
          key                  : cek,
          initializationVector : iv,
          authenticationTag    : tag,
          keyEncryptionInputs  : [{
            publicKeyId      : 'did:example:alice#enc',
            publicKey        : recipientPublicKey,
            derivationScheme : 'protocolPath' as any,
          }],
        },
        tag,
      );

      expect(jwe.protected).toBeDefined();
      expect(jwe.iv).toBeDefined();
      expect(jwe.tag).toBeDefined();
      expect(jwe.recipients).toHaveLength(1);
      expect(jwe.recipients[0].header.kid).toBe('did:example:alice#enc');
      expect(jwe.recipients[0].header.epk).toBeDefined();
      expect(jwe.recipients[0].encrypted_key).toBeDefined();

      // Verify protected header
      const protectedHeader = Encryption.parseProtectedHeader(jwe.protected);
      expect(protectedHeader.alg).toBe('ECDH-ES+A256KW');
      expect(protectedHeader.enc).toBe('A256GCM');
    });
  });
});
