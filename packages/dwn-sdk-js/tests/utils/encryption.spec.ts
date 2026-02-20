import type { KeyDecrypter } from '../../src/types/encryption-types.js';
import type { PublicKeyJwk } from '../../src/types/jose-types.js';
import type { RecordsWriteMessage } from '../../src/types/records-types.js';

import { ArrayUtility } from '../../src/utils/array.js';
import { DataStream } from '../../src/index.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { Records } from '../../src/utils/records.js';
import { TestDataGenerator } from './test-data-generator.js';
import { X25519 } from '@enbox/crypto';
import { ContentEncryptionAlgorithm, Encryption } from '../../src/utils/encryption.js';
import { describe, expect, it } from 'bun:test';

/** Boundary sizes that exercise edge cases in AEAD ciphers. */
const boundarySizes = [0, 1, 15, 16, 17, 32, 256];

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

    it('should handle boundary plaintext sizes via byte API', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);

      for (const size of boundarySizes) {
        const inputBytes = size === 0 ? new Uint8Array(0) : TestDataGenerator.randomBytes(size);

        const { ciphertext, tag } = await Encryption.aeadEncrypt(
          ContentEncryptionAlgorithm.A256GCM, key, iv, inputBytes
        );

        const plaintext = await Encryption.aeadDecrypt(
          ContentEncryptionAlgorithm.A256GCM, key, iv, ciphertext, tag
        );

        expect(plaintext.length).toBe(size);
        expect(ArrayUtility.byteArraysEqual(inputBytes, plaintext)).toBe(true);
      }
    });

    it('should handle boundary plaintext sizes via stream API', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);

      for (const size of boundarySizes) {
        const inputBytes = size === 0 ? new Uint8Array(0) : TestDataGenerator.randomBytes(size);
        const inputStream = DataStream.fromBytes(inputBytes);

        const { ciphertextStream, tag } = await Encryption.aeadEncryptStream(
          ContentEncryptionAlgorithm.A256GCM, key, iv, inputStream
        );

        const plaintextStream = await Encryption.aeadDecryptStream(
          ContentEncryptionAlgorithm.A256GCM, key, iv, ciphertextStream, tag
        );
        const plaintextBytes = await DataStream.toBytes(plaintextStream);

        expect(plaintextBytes.length).toBe(size);
        expect(ArrayUtility.byteArraysEqual(inputBytes, plaintextBytes)).toBe(true);
      }
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

    it('should handle boundary plaintext sizes via byte API', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const nonce = TestDataGenerator.randomBytes(24);

      for (const size of boundarySizes) {
        const inputBytes = size === 0 ? new Uint8Array(0) : TestDataGenerator.randomBytes(size);

        const { ciphertext, tag } = await Encryption.aeadEncrypt(
          ContentEncryptionAlgorithm.XC20P, key, nonce, inputBytes
        );

        const plaintext = await Encryption.aeadDecrypt(
          ContentEncryptionAlgorithm.XC20P, key, nonce, ciphertext, tag
        );

        expect(plaintext.length).toBe(size);
        expect(ArrayUtility.byteArraysEqual(inputBytes, plaintext)).toBe(true);
      }
    });

    it('should handle boundary plaintext sizes via stream API', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const nonce = TestDataGenerator.randomBytes(24);

      for (const size of boundarySizes) {
        const inputBytes = size === 0 ? new Uint8Array(0) : TestDataGenerator.randomBytes(size);
        const inputStream = DataStream.fromBytes(inputBytes);

        const { ciphertextStream, tag } = await Encryption.aeadEncryptStream(
          ContentEncryptionAlgorithm.XC20P, key, nonce, inputStream
        );

        const plaintextStream = await Encryption.aeadDecryptStream(
          ContentEncryptionAlgorithm.XC20P, key, nonce, ciphertextStream, tag
        );
        const plaintextBytes = await DataStream.toBytes(plaintextStream);

        expect(plaintextBytes.length).toBe(size);
        expect(ArrayUtility.byteArraysEqual(inputBytes, plaintextBytes)).toBe(true);
      }
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

    it('should produce different wrapped keys for the same CEK and recipient', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey });
      const cek = TestDataGenerator.randomBytes(32);

      // Wrap the same CEK twice with different ephemeral keys
      const ephemeralKey1 = await X25519.generateKey();
      const ephemeralKey2 = await X25519.generateKey();

      const wrappedKey1 = await Encryption.ecdhEsWrapKey(ephemeralKey1, recipientPublicKey, cek);
      const wrappedKey2 = await Encryption.ecdhEsWrapKey(ephemeralKey2, recipientPublicKey, cek);

      // Different ephemeral keys must produce different wrapped keys
      expect(ArrayUtility.byteArraysEqual(wrappedKey1, wrappedKey2)).toBe(false);

      // Both must still unwrap to the same CEK
      const epk1 = await X25519.getPublicKey({ key: ephemeralKey1 });
      const epk2 = await X25519.getPublicKey({ key: ephemeralKey2 });
      const unwrapped1 = await Encryption.ecdhEsUnwrapKey(recipientPrivateKey, epk1, wrappedKey1);
      const unwrapped2 = await Encryption.ecdhEsUnwrapKey(recipientPrivateKey, epk2, wrappedKey2);

      expect(ArrayUtility.byteArraysEqual(unwrapped1, cek)).toBe(true);
      expect(ArrayUtility.byteArraysEqual(unwrapped2, cek)).toBe(true);
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

    it('should produce different ephemeral keys and wrapped CEKs for identical inputs', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;

      const cek = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const tag = TestDataGenerator.randomBytes(16);

      const encryptionInput = {
        key                  : cek,
        initializationVector : iv,
        authenticationTag    : tag,
        keyEncryptionInputs  : [{
          publicKeyId      : 'did:example:alice#enc',
          publicKey        : recipientPublicKey,
          derivationScheme : 'protocolPath' as any,
        }],
      };

      const jwe1 = await Encryption.buildJwe(encryptionInput, tag);
      const jwe2 = await Encryption.buildJwe(encryptionInput, tag);

      // Each call generates a fresh ephemeral key pair — epk values must differ
      const epk1 = jwe1.recipients[0].header.epk;
      const epk2 = jwe2.recipients[0].header.epk;
      expect(JSON.stringify(epk1)).not.toBe(JSON.stringify(epk2));

      // Different ephemeral keys produce different wrapped CEKs
      expect(jwe1.recipients[0].encrypted_key).not.toBe(jwe2.recipients[0].encrypted_key);

      // Both wrapped CEKs must still unwrap to the same original CEK
      const unwrapped1 = await Encryption.ecdhEsUnwrapKey(
        recipientPrivateKey,
        epk1 as PublicKeyJwk,
        Encoder.base64UrlToBytes(jwe1.recipients[0].encrypted_key),
      );
      const unwrapped2 = await Encryption.ecdhEsUnwrapKey(
        recipientPrivateKey,
        epk2 as PublicKeyJwk,
        Encoder.base64UrlToBytes(jwe2.recipients[0].encrypted_key),
      );

      expect(ArrayUtility.byteArraysEqual(unwrapped1, cek)).toBe(true);
      expect(ArrayUtility.byteArraysEqual(unwrapped2, cek)).toBe(true);
    });

    it('should attach derivedPublicKey for ProtocolContext scheme', async () => {
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
            derivationScheme : KeyDerivationScheme.ProtocolContext,
          }],
        },
        tag,
      );

      // ProtocolContext recipients should have derivedPublicKey set to the input public key
      expect(jwe.recipients).toHaveLength(1);
      expect(jwe.recipients[0].header.derivedPublicKey).toBeDefined();
      expect(jwe.recipients[0].header.derivedPublicKey!.kty).toBe(recipientPublicKey.kty);
    });

    it('should not attach derivedPublicKey for non-ProtocolContext schemes', async () => {
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
            derivationScheme : KeyDerivationScheme.ProtocolPath,
          }],
        },
        tag,
      );

      // Non-ProtocolContext recipients should NOT have derivedPublicKey
      expect(jwe.recipients).toHaveLength(1);
      expect(jwe.recipients[0].header.derivedPublicKey).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should throw on corrupted ciphertext (wrong tag)', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const plaintext = TestDataGenerator.randomBytes(64);

      const { ciphertext } = await Encryption.aeadEncrypt(ContentEncryptionAlgorithm.A256GCM, key, iv, plaintext);

      // Use a wrong tag
      const wrongTag = TestDataGenerator.randomBytes(16);

      await expect(
        Encryption.aeadDecrypt(ContentEncryptionAlgorithm.A256GCM, key, iv, ciphertext, wrongTag)
      ).rejects.toThrow();
    });

    it('should throw on corrupted ciphertext stream (wrong tag)', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const plaintext = TestDataGenerator.randomBytes(64);
      const plaintextStream = DataStream.fromBytes(plaintext);

      const { ciphertextStream } = await Encryption.aeadEncryptStream(
        ContentEncryptionAlgorithm.A256GCM, key, iv, plaintextStream
      );

      // Use a wrong tag to trigger decryption error
      const wrongTag = TestDataGenerator.randomBytes(16);

      await expect(
        Encryption.aeadDecryptStream(ContentEncryptionAlgorithm.A256GCM, key, iv, ciphertextStream, wrongTag)
      ).rejects.toThrow();
    });

    it('should throw on decryption with wrong key', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const wrongKey = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const plaintext = TestDataGenerator.randomBytes(64);

      const { ciphertext, tag } = await Encryption.aeadEncrypt(ContentEncryptionAlgorithm.A256GCM, key, iv, plaintext);

      await expect(
        Encryption.aeadDecrypt(ContentEncryptionAlgorithm.A256GCM, wrongKey, iv, ciphertext, tag)
      ).rejects.toThrow();
    });

    it('should throw for unsupported algorithm in aeadEncrypt', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const plaintext = TestDataGenerator.randomBytes(64);

      await expect(
        Encryption.aeadEncrypt('INVALID_ALG' as ContentEncryptionAlgorithm, key, iv, plaintext)
      ).rejects.toThrow('Unsupported content encryption algorithm');
    });

    it('should throw for unsupported algorithm in aeadDecrypt', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const ciphertext = TestDataGenerator.randomBytes(64);
      const tag = TestDataGenerator.randomBytes(16);

      await expect(
        Encryption.aeadDecrypt('INVALID_ALG' as ContentEncryptionAlgorithm, key, iv, ciphertext, tag)
      ).rejects.toThrow('Unsupported content encryption algorithm');
    });
  });

  describe('Records.decrypt', () => {
    it('should throw when message has no encryption property', async () => {
      // Create a minimal RecordsWriteMessage without encryption
      const messageWithoutEncryption = {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          dataCid          : 'bafyreib3e4uj32nq5ql3q',
          dataSize         : 100,
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          dataFormat       : 'application/json',
        },
        // no encryption property
      } as unknown as RecordsWriteMessage;

      const dummyKey = await X25519.generateKey();
      const cipherStream = DataStream.fromBytes(TestDataGenerator.randomBytes(32));

      await expect(
        Records.decrypt(messageWithoutEncryption, {
          rootKeyId         : 'did:example:alice#enc',
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          derivedPrivateKey : dummyKey,
        } as any, cipherStream)
      ).rejects.toThrow(DwnErrorCode.RecordsDecryptNoMatchingKeyEncryptedFound);
    });

    it('should propagate errors thrown by KeyDecrypter.decrypt()', async () => {
      // Build a minimal encrypted message that has enough structure to reach the callback path
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;

      const cek = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(12);
      const plaintext = TestDataGenerator.randomBytes(64);

      const { tag } = await Encryption.aeadEncrypt(ContentEncryptionAlgorithm.A256GCM, cek, iv, plaintext);
      const jwe = await Encryption.buildJwe(
        {
          key                  : cek,
          initializationVector : iv,
          authenticationTag    : tag,
          keyEncryptionInputs  : [{
            publicKeyId      : 'did:example:alice#enc',
            publicKey        : recipientPublicKey,
            derivationScheme : KeyDerivationScheme.ProtocolPath,
          }],
        },
        tag,
      );

      // Construct a minimal RecordsWriteMessage with the JWE encryption property
      const message = {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          dataCid          : 'bafyreib3e4uj32nq5ql3q',
          dataSize         : 100,
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          dataFormat       : 'application/json',
          protocol         : 'https://example.com/protocol',
          protocolPath     : 'foo',
        },
        encryption : jwe,
        recordId   : 'test-record-id',
      } as unknown as RecordsWriteMessage;

      // Create a KeyDecrypter that throws an error
      const failingDecrypter: KeyDecrypter = {
        rootKeyId        : 'did:example:alice#enc',
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        decrypt          : async (): Promise<Uint8Array> => {
          throw new Error('KeyDecrypter: key derivation failed');
        },
      };

      const cipherStream = DataStream.fromBytes(TestDataGenerator.randomBytes(64));

      // The error from KeyDecrypter.decrypt() should propagate directly
      await expect(
        Records.decrypt(message, failingDecrypter, cipherStream)
      ).rejects.toThrow('KeyDecrypter: key derivation failed');
    });
  });
});
