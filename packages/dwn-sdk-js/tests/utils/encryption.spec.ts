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
import sinon from 'sinon';
import { TestDataGenerator } from './test-data-generator.js';
import { X25519 } from '@enbox/crypto';
import { afterEach, describe, expect, it } from 'bun:test';
import { ContentEncryptionAlgorithm, Encryption, KeyAgreementAlgorithm, ROLE_AUDIENCE_DERIVATION_SCHEME, SEAL_DERIVATION_SCHEME } from '../../src/utils/encryption.js';

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
      algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
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
  afterEach(() => {
    sinon.restore();
  });

  describe('A256CTR', () => {
    it('should encrypt and decrypt bytes correctly', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(16);
      const inputBytes = TestDataGenerator.randomBytes(1_000_000);

      const ciphertext = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, inputBytes);
      const plaintext = await Encryption.decrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, ciphertext);

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintext)).toBe(true);
    });

    it('should encrypt a stream into ciphertext that decrypts back to the plaintext', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(16);
      const inputBytes = TestDataGenerator.randomBytes(1_000_000);

      const ciphertextStream = await Encryption.encryptStream(
        ContentEncryptionAlgorithm.A256CTR, key, iv, DataStream.fromBytes(inputBytes)
      );
      const ciphertextBytes = await DataStream.toBytes(ciphertextStream);
      const plaintextBytes = await Encryption.decrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, ciphertextBytes);

      expect(ArrayUtility.byteArraysEqual(inputBytes, plaintextBytes)).toBe(true);
    });

    it('should handle boundary plaintext sizes', async () => {
      const key = TestDataGenerator.randomBytes(32);
      const iv = TestDataGenerator.randomBytes(16);

      for (const size of boundarySizes) {
        const inputBytes = size === 0 ? new Uint8Array(0) : TestDataGenerator.randomBytes(size);
        const ciphertext = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, inputBytes);
        const plaintext = await Encryption.decrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, ciphertext);

        expect(plaintext).toHaveLength(size);
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

      const { encryptedKey, ephemeralPublicKey } = await Encryption.wrapKey({
        cek,
        keyInput: {
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
          keyId,
          publicKey        : recipientPublicKey,
        },
      });

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
      const keyInput = {
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        keyId,
        publicKey        : recipientPublicKey,
      } as const;

      const wrappedKey1 = await Encryption.wrapKey({ cek, keyInput });
      const wrappedKey2 = await Encryption.wrapKey({ cek, keyInput });

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

    it('should domain-separate role-audience KEKs without delimiter ambiguity', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;
      const cek = TestDataGenerator.randomBytes(32);
      const keyId = await Encryption.getKeyId(recipientPublicKey);
      const baseKeyInput = {
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
        keyId,
        publicKey        : recipientPublicKey,
      } as const;

      const wrappedKey = await Encryption.wrapKey({
        cek,
        keyInput: {
          ...baseKeyInput,
          protocol : 'https://example.com/a|b',
          rolePath : 'c',
        },
      });

      // unwrapping with the exact (protocol, rolePath) pair used for wrapping round-trips the CEK
      const unwrapped = await Encryption.unwrapKey(recipientPrivateKey, {
        ...baseKeyInput,
        encryptedKey       : Encoder.bytesToBase64Url(wrappedKey.encryptedKey),
        ephemeralPublicKey : wrappedKey.ephemeralPublicKey,
        protocol           : 'https://example.com/a|b',
        rolePath           : 'c',
      });
      expect(ArrayUtility.byteArraysEqual(unwrapped, cek)).toBe(true);

      // a delimiter-shifted (protocol, rolePath) pair must derive a different KEK, so unwrapping must fail;
      // a naive delimiter-joined KEK info would make both pairs derive the same KEK and let this unwrap succeed
      await expect(Encryption.unwrapKey(recipientPrivateKey, {
        ...baseKeyInput,
        encryptedKey       : Encoder.bytesToBase64Url(wrappedKey.encryptedKey),
        ephemeralPublicKey : wrappedKey.ephemeralPublicKey,
        protocol           : 'https://example.com/a',
        rolePath           : 'b|c',
      })).rejects.toThrow();
    });

    it('should produce and open the sealed-audience-key fixture byte-for-byte', async () => {
      const protocol = 'https://example.org/protocols/seal-fixture';
      const rolePath = 'chat/member';
      const contextId = 'root/thread';
      const audienceKeyId = 'wGUj0R5Q0vED7B2EW4GFOCqJB1XXTPm6pIjixu2psL4';
      const sealingKeyId = 'qKpn4plbkMfU3yWDjgvuQc0qGzvQJn031umInc0PnAE';
      const sealingPrivateKey = {
        crv : 'X25519',
        d   : 'yFNS7zIsSPFOsaR5iTELRuAGRB7X0V_XaNE_XYU7yUY',
        kty : 'OKP',
        x   : '0Zf6pn0EvFNFTIoiZ8Krr36DkI3_dBrF5pBt2mC3CkM',
      } as PrivateKeyJwk;
      const sealingPublicKey = {
        crv : 'X25519',
        kty : 'OKP',
        x   : '0Zf6pn0EvFNFTIoiZ8Krr36DkI3_dBrF5pBt2mC3CkM',
      } as PublicKeyJwk;
      const audiencePrivateKey = {
        crv : 'X25519',
        d   : '6MxyxL2s6wN4BygLw9kQqGV_nbzJnK8nPdkH2aOKiVw',
        kty : 'OKP',
        x   : '7OUu7CaMaUI0bEoF4m2yDnltlSF0FYbKNrY1odGnOHg',
      } as PrivateKeyJwk;
      const ephemeralPrivateKey = {
        crv : 'X25519',
        d   : 'cD9R8nGxWVe0P55JXcNm7skbIcsUztLsDcyxkMhyaF0',
        kty : 'OKP',
        x   : '-6WJjols0E4zpawS9S2povLwkpYNUcwGEXD2YSvD7Bc',
      } as PrivateKeyJwk;
      const ephemeralPublicKey = {
        crv : 'X25519',
        kid : '9tOb183nLY8lW1KtH-g7ou7lWYt6HC2yU5BnI8NRofs',
        kty : 'OKP',
        x   : '-6WJjols0E4zpawS9S2povLwkpYNUcwGEXD2YSvD7Bc',
      } as PublicKeyJwk;
      const audiencePrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: audiencePrivateKey });

      // pin the ephemeral key pair generated inside `wrapSeal()` so the fixture stays byte-for-byte deterministic
      sinon.stub(X25519, 'generateKey').resolves(ephemeralPrivateKey);

      const seal = await Encryption.wrapSeal({
        privateKeyBytes : audiencePrivateKeyBytes,
        keyInput        : {
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          audienceKeyId,
          contextId,
          derivationScheme : SEAL_DERIVATION_SCHEME,
          keyId            : sealingKeyId,
          protocol,
          publicKey        : sealingPublicKey,
          rolePath,
        },
      });

      expect(seal).toEqual({
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : SEAL_DERIVATION_SCHEME,
        encryptedKey     : 'BNdM94UG2spUEF_dANHbBbfMHDqkq2-liqIion2nEGeKr87fQMnYLg',
        ephemeralPublicKey,
        keyId            : sealingKeyId,
      });

      const unwrappedPrivateKeyBytes = await Encryption.unwrapSeal({
        audienceKeyId,
        contextId,
        protocol,
        recipientPrivateKey: sealingPrivateKey,
        rolePath,
        seal,
      });

      expect(ArrayUtility.byteArraysEqual(unwrappedPrivateKeyBytes, audiencePrivateKeyBytes)).toBe(true);
    });

    it('should reject unsupported key agreement algorithms', async () => {
      const recipientPrivateKey = await X25519.generateKey();
      const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;
      const cek = TestDataGenerator.randomBytes(32);
      const keyId = await Encryption.getKeyId(recipientPublicKey);
      const unsupportedAlgorithm = 'unsupported-key-agreement';
      const unsupportedMessage = `Unsupported key agreement algorithm: ${unsupportedAlgorithm}`;
      const unsupportedKeyInput = {
        algorithm        : unsupportedAlgorithm,
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        keyId,
        publicKey        : recipientPublicKey,
      } as unknown as Parameters<typeof Encryption.wrapKey>[0]['keyInput'];

      await expect(Encryption.wrapKey({ cek, keyInput: unsupportedKeyInput })).rejects.toThrow(unsupportedMessage);

      const wrappedKey = await Encryption.wrapKey({
        cek,
        keyInput: {
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
          keyId,
          publicKey        : recipientPublicKey,
        },
      });
      const unsupportedKeyEncryption = {
        algorithm          : unsupportedAlgorithm,
        derivationScheme   : KeyDerivationScheme.ProtocolPath,
        encryptedKey       : Encoder.bytesToBase64Url(wrappedKey.encryptedKey),
        ephemeralPublicKey : wrappedKey.ephemeralPublicKey,
        keyId,
      } as unknown as Parameters<typeof Encryption.unwrapKey>[1];

      await expect(Encryption.unwrapKey(recipientPrivateKey, unsupportedKeyEncryption)).rejects.toThrow(unsupportedMessage);
      const unsupportedSealInput = {
        algorithm        : unsupportedAlgorithm,
        audienceKeyId    : keyId,
        contextId        : 'context',
        derivationScheme : SEAL_DERIVATION_SCHEME,
        keyId,
        protocol         : 'https://example.com/protocol',
        publicKey        : recipientPublicKey,
        rolePath         : 'member',
      } as unknown as Parameters<typeof Encryption.wrapSeal>[0]['keyInput'];
      await expect(Encryption.wrapSeal({ privateKeyBytes: cek, keyInput: unsupportedSealInput })).rejects.toThrow(unsupportedMessage);

      const unsupportedSeal = {
        algorithm          : unsupportedAlgorithm,
        derivationScheme   : SEAL_DERIVATION_SCHEME,
        encryptedKey       : Encoder.bytesToBase64Url(wrappedKey.encryptedKey),
        ephemeralPublicKey : wrappedKey.ephemeralPublicKey,
        keyId,
      } as unknown as Parameters<typeof Encryption.unwrapSeal>[0]['seal'];
      await expect(Encryption.unwrapSeal({
        audienceKeyId       : keyId,
        contextId           : 'context',
        protocol            : 'https://example.com/protocol',
        recipientPrivateKey : recipientPrivateKey,
        rolePath            : 'member',
        seal                : unsupportedSeal,
      })).rejects.toThrow(unsupportedMessage);
      expect(() => Encryption.validateEncryptionProperty({
        algorithm            : ContentEncryptionAlgorithm.A256CTR,
        initializationVector : Encoder.bytesToBase64Url(TestDataGenerator.randomBytes(16)),
        keyEncryption        : [unsupportedKeyEncryption],
      })).toThrow(unsupportedMessage);
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
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
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
      const keyDecrypter = TestDataGenerator.createKeyDecrypter({
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : dummyKey,
        rootKeyId         : 'did:example:alice#enc',
      });

      await expect(
        Records.decrypt(messageWithoutEncryption, keyDecrypter, DataStream.fromBytes(TestDataGenerator.randomBytes(32)))
      ).rejects.toThrow(DwnErrorCode.RecordsDecryptNoMatchingKeyEncryptedFound);
    });

    it('should validate encrypted data CID before returning plaintext', async () => {
      const {
        ciphertext,
        message,
        recipientPrivateKey,
      } = await createEncryptedRecordFixture(Encoder.stringToBytes('secret'));
      const wrongCiphertext = TestDataGenerator.randomBytes(ciphertext.length);
      const keyDecrypter = TestDataGenerator.createKeyDecrypter({
        derivationScheme  : KeyDerivationScheme.ProtocolPath,
        derivedPrivateKey : recipientPrivateKey,
        rootKeyId         : 'did:example:alice#enc',
      });

      await expect(
        Records.decrypt(message, keyDecrypter, DataStream.fromBytes(wrongCiphertext))
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

  });
});
