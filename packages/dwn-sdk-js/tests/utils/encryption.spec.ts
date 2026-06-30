import type { KeyDecrypter } from '../../src/types/encryption-types.js';
import type { PrivateKeyJwk } from '../../src/types/jose-types.js';
import type { PublicKeyJwk } from '../../src/types/jose-types.js';
import type { RecordsWriteMessage } from '../../src/types/records-types.js';

import { ArrayUtility } from '../../src/utils/array.js';
import { Cid } from '../../src/utils/cid.js';
import { DataStream } from '../../src/index.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { Records } from '../../src/utils/records.js';
import { TestDataGenerator } from './test-data-generator.js';
import { X25519 } from '@enbox/crypto';
import { ContentEncryptionAlgorithm, Encryption, KeyAgreementAlgorithm } from '../../src/utils/encryption.js';
import { describe, expect, it } from 'bun:test';

const boundarySizes = [0, 1, 15, 16, 17, 32, 256];

type EncryptedRecordFixture = {
  cek: Uint8Array;
  ciphertext: Uint8Array;
  message: RecordsWriteMessage;
  plaintext: Uint8Array;
  recipientPrivateKey: PrivateKeyJwk;
  recipientPublicKey: PublicKeyJwk;
};

async function createEncryptedRecordFixture(plaintext = TestDataGenerator.randomBytes(64)): Promise<EncryptedRecordFixture> {
  const recipientPrivateKey = await X25519.generateKey() as PrivateKeyJwk;
  const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;
  const cek = TestDataGenerator.randomBytes(32);
  const iv = TestDataGenerator.randomBytes(16);
  const ciphertext = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, cek, iv, plaintext);
  const keyId = await Encryption.getKeyId(recipientPublicKey);
  const encryption = await Encryption.buildEncryptionProperty({
    initializationVector : iv,
    key                  : cek,
    keyEncryptionInputs  : [{
      derivationScheme : KeyDerivationScheme.ProtocolPath,
      keyId,
      publicKey        : recipientPublicKey,
    }],
  });
  const message = {
    descriptor: {
      dataCid          : await Cid.computeDagPbCidFromBytes(ciphertext),
      dataFormat       : 'application/octet-stream',
      dataSize         : ciphertext.byteLength,
      dateCreated      : '2024-01-01T00:00:00.000000Z',
      interface        : 'Records',
      messageTimestamp : '2024-01-01T00:00:00.000000Z',
      method           : 'Write',
      protocol         : 'https://example.com/protocol',
      protocolPath     : 'note',
    },
    encryption,
    recordId: 'test-record-id',
  } as unknown as RecordsWriteMessage;

  return {
    cek,
    ciphertext,
    message,
    plaintext,
    recipientPrivateKey,
    recipientPublicKey,
  };
}

describe('Encryption', () => {
  describe('A256CTR', () => {
    it('should encrypt and decrypt bytes correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(16);
      const inputBytes = TestDataGenerator.randomBytes(1_000_000);

      const ciphertext = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, inputBytes);
      const plaintext = await Encryption.decrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, ciphertext);

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintext)).toBe(true);
    });

    it('should encrypt and decrypt streams correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(16);
      const inputBytes = TestDataGenerator.randomBytes(1_000_000);

      const ciphertextStream = await Encryption.encryptStream(
        ContentEncryptionAlgorithm.A256CTR, key, iv, DataStream.fromBytes(inputBytes)
      );
      const plaintextStream = await Encryption.decryptStream(
        ContentEncryptionAlgorithm.A256CTR, key, iv, ciphertextStream
      );
      const plaintextBytes = await DataStream.toBytes(plaintextStream);

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintextBytes)).toBe(true);
    });

    it('should handle boundary plaintext sizes', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(16);

      for (const size of boundarySizes) {
        const inputBytes = size === 0 ? new Uint8Array(0) : TestDataGenerator.randomBytes(size);
        const ciphertext = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, inputBytes);
        const plaintext = await Encryption.decrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, ciphertext);

        expect(plaintext.length).toBe(size);
        expect(ArrayUtility.byteArraysEqual(inputBytes, plaintext)).toBe(true);
      }
    });
  });

  describe('X25519-HKDF-SHA256+A256KW', () => {
    it('should wrap and unwrap a CEK correctly', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;
      const cek = TestDataGenerator.randomBytes(32);
      const keyId = await Encryption.getKeyId(recipientPublicKey);

      const { encryptedKey, ephemeralPublicKey } = await Encryption.wrapKey(
        recipientPublicKey,
        cek,
        { derivationScheme: KeyDerivationScheme.ProtocolPath, keyId, publicKey: recipientPublicKey },
      );

      const unwrappedCek = await Encryption.unwrapKey(recipientPrivateKey, {
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        encryptedKey     : Encoder.bytesToBase64Url(encryptedKey),
        ephemeralPublicKey,
        keyId,
      });

      expect(ArrayUtility.byteArraysEqual(cek, unwrappedCek)).toBe(true);
    });

    it('should produce different wrapped keys for the same CEK and recipient', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;
      const cek = TestDataGenerator.randomBytes(32);
      const keyId = await Encryption.getKeyId(recipientPublicKey);
      const keyInput = { derivationScheme: KeyDerivationScheme.ProtocolPath, keyId, publicKey: recipientPublicKey } as const;

      const wrappedKey1 = await Encryption.wrapKey(recipientPublicKey, cek, keyInput);
      const wrappedKey2 = await Encryption.wrapKey(recipientPublicKey, cek, keyInput);

      expect(ArrayUtility.byteArraysEqual(wrappedKey1.encryptedKey, wrappedKey2.encryptedKey)).toBe(false);

      const unwrapped1 = await Encryption.unwrapKey(recipientPrivateKey, {
        algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme   : KeyDerivationScheme.ProtocolPath,
        encryptedKey       : Encoder.bytesToBase64Url(wrappedKey1.encryptedKey),
        ephemeralPublicKey : wrappedKey1.ephemeralPublicKey,
        keyId,
      });
      const unwrapped2 = await Encryption.unwrapKey(recipientPrivateKey, {
        algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme   : KeyDerivationScheme.ProtocolPath,
        encryptedKey       : Encoder.bytesToBase64Url(wrappedKey2.encryptedKey),
        ephemeralPublicKey : wrappedKey2.ephemeralPublicKey,
        keyId,
      });

      expect(ArrayUtility.byteArraysEqual(unwrapped1, cek)).toBe(true);
      expect(ArrayUtility.byteArraysEqual(unwrapped2, cek)).toBe(true);
    });
  });

  describe('buildEncryptionProperty', () => {
    it('should build a valid RecordsWrite encryption object', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;
      const cek = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(16);
      const keyId = await Encryption.getKeyId(recipientPublicKey);

      const encryption = await Encryption.buildEncryptionProperty({
        initializationVector : iv,
        key                  : cek,
        keyEncryptionInputs  : [{
          derivationScheme : KeyDerivationScheme.ProtocolPath,
          keyId,
          publicKey        : recipientPublicKey,
        }],
      });

      expect(encryption.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
      expect(encryption.initializationVector).toBe(Encoder.bytesToBase64Url(iv));
      expect(encryption.keyEncryption).toHaveLength(1);
      expect(encryption.keyEncryption[0].keyId).toBe(keyId);
      expect(encryption.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

      const unwrappedCek = await Encryption.unwrapKey(recipientPrivateKey, encryption.keyEncryption[0]);
      expect(ArrayUtility.byteArraysEqual(unwrappedCek, cek)).toBe(true);
    });
  });

  describe('Records.decrypt', () => {
    it('should throw when message has no encryption property', async () => {
      const messageWithoutEncryption = {
        descriptor: {
          dataCid          : 'bafyreib3e4uj32nq5ql3q',
          dataFormat       : 'application/json',
          dataSize         : 100,
          dateCreated      : '2024-01-01T00:00:00.000000Z',
          interface        : 'Records',
          messageTimestamp : '2024-01-01T00:00:00.000000Z',
          method           : 'Write',
          protocol         : 'https://example.com/protocol',
          protocolPath     : 'note',
        },
      } as unknown as RecordsWriteMessage;
      const dummyKey = await X25519.generateKey() as PrivateKeyJwk;

      await expect(
        Records.decrypt(messageWithoutEncryption, {
          derivedPrivateKey : dummyKey,
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          rootKeyId         : 'did:example:alice#enc',
        }, DataStream.fromBytes(TestDataGenerator.randomBytes(32)))
      ).rejects.toThrow(DwnErrorCode.RecordsDecryptNoMatchingKeyEncryptedFound);
    });

    it('should validate encrypted data CID before returning plaintext', async () => {
      const {
        ciphertext,
        message,
        recipientPrivateKey,
      } = await createEncryptedRecordFixture(Encoder.stringToBytes('secret'));
      const wrongCiphertext = TestDataGenerator.randomBytes(ciphertext.length);

      await expect(
        Records.decrypt(message, {
          derivedPrivateKey : recipientPrivateKey,
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          rootKeyId         : 'did:example:alice#enc',
        }, DataStream.fromBytes(wrongCiphertext))
      ).rejects.toThrow(DwnErrorCode.RecordsWriteDataCidMismatch);
    });

    it('should propagate errors thrown by KeyDecrypter.decrypt()', async () => {
      const {
        ciphertext,
        message,
        recipientPublicKey,
      } = await createEncryptedRecordFixture();
      const failingDecrypter: KeyDecrypter = {
        decrypt: async (): Promise<Uint8Array> => {
          throw new Error('KeyDecrypter: key derivation failed');
        },
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        derivePublicKey  : async (): Promise<PublicKeyJwk> => recipientPublicKey,
        rootKeyId        : 'did:example:alice#enc',
      };

      await expect(
        Records.decrypt(message, failingDecrypter, DataStream.fromBytes(ciphertext))
      ).rejects.toThrow('KeyDecrypter: key derivation failed');
    });

    it('should allow KeyDecrypter to select a matching key-encryption entry directly', async () => {
      const {
        cek,
        ciphertext,
        message,
        plaintext,
      } = await createEncryptedRecordFixture();
      let selectedPath: string[] | undefined;
      const directMatchingDecrypter: KeyDecrypter = {
        decrypt           : async (): Promise<Uint8Array> => cek,
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        findKeyEncryption : async ({ fullDerivationPath, keyEncryptions }): Promise<typeof keyEncryptions[number] | undefined> => {
          selectedPath = fullDerivationPath;
          return keyEncryptions[0];
        },
        rootKeyId: 'direct-matcher',
      };

      const decryptedStream = await Records.decrypt(message, directMatchingDecrypter, DataStream.fromBytes(ciphertext));
      const decryptedBytes = await DataStream.toBytes(decryptedStream);

      expect(ArrayUtility.byteArraysEqual(decryptedBytes, plaintext)).toBe(true);
      expect(selectedPath).toEqual([KeyDerivationScheme.ProtocolPath, 'https://example.com/protocol', 'note']);
    });

    it('should reject a KeyDecrypter that cannot select a key-encryption entry', async () => {
      const {
        cek,
        ciphertext,
        message,
      } = await createEncryptedRecordFixture();
      const invalidDecrypter: KeyDecrypter = {
        decrypt          : async (): Promise<Uint8Array> => cek,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        rootKeyId        : 'invalid-decrypter',
      };

      await expect(
        Records.decrypt(message, invalidDecrypter, DataStream.fromBytes(ciphertext))
      ).rejects.toThrow('must provide findKeyEncryption or derivePublicKey');
    });
  });
});
