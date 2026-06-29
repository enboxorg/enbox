import type { Jwk } from '@enbox/crypto';
import type { PublicKeyJwk } from '../types/jose-types.js';

import { concatBytes } from '@noble/ciphers/utils';
import { AesCtr, AesKw, computeJwkThumbprint, Hkdf, X25519 } from '@enbox/crypto';

import { Encoder } from './encoder.js';
import { KeyDerivationScheme } from './hd-key.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

export enum ContentEncryptionAlgorithm {
  A256CTR = 'A256CTR',
}

export enum KeyAgreementAlgorithm {
  X25519HkdfSha256A256Kw = 'X25519-HKDF-SHA256+A256KW',
}

export const ROLE_AUDIENCE_DERIVATION_SCHEME = 'roleAudience';

const AES_256_KEY_LENGTH_BYTES = 32;
const AES_CTR_COUNTER_LENGTH_BYTES = 16;
const AES_CTR_COUNTER_LENGTH_BITS = 128;
const KEK_INFO_PREFIX = KeyAgreementAlgorithm.X25519HkdfSha256A256Kw;

export type ProtocolPathKeyEncryption = {
  algorithm: KeyAgreementAlgorithm.X25519HkdfSha256A256Kw;
  keyId: string;
  derivationScheme: KeyDerivationScheme.ProtocolPath;
  ephemeralPublicKey: PublicKeyJwk;
  encryptedKey: string;
};

export type RoleAudienceKeyEncryption = {
  algorithm: KeyAgreementAlgorithm.X25519HkdfSha256A256Kw;
  keyId: string;
  derivationScheme: typeof ROLE_AUDIENCE_DERIVATION_SCHEME;
  protocol: string;
  role: string;
  epoch: number;
  ephemeralPublicKey: PublicKeyJwk;
  encryptedKey: string;
};

export type KeyEncryption = ProtocolPathKeyEncryption | RoleAudienceKeyEncryption;

export type DwnEncryption = {
  algorithm: ContentEncryptionAlgorithm.A256CTR;
  initializationVector: string;
  keyEncryption: KeyEncryption[];
};

export type ProtocolPathKeyEncryptionInput = {
  keyId: string;
  publicKey: PublicKeyJwk;
  derivationScheme: KeyDerivationScheme.ProtocolPath;
};

export type RoleAudienceKeyEncryptionInput = {
  keyId: string;
  publicKey: PublicKeyJwk;
  derivationScheme: typeof ROLE_AUDIENCE_DERIVATION_SCHEME;
  protocol: string;
  role: string;
  epoch: number;
};

export type KeyEncryptionInput = ProtocolPathKeyEncryptionInput | RoleAudienceKeyEncryptionInput;

export type EncryptionInput = {
  algorithm?: ContentEncryptionAlgorithm;
  key: Uint8Array;
  initializationVector: Uint8Array;
  keyEncryptionInputs: KeyEncryptionInput[];
};

export type KeyUnwrapPayload = {
  encryptedKey: Uint8Array;
  ephemeralPublicKey: PublicKeyJwk;
  keyEncryption: KeyEncryption;
};

export class Encryption {
  public static async encrypt(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    initializationVector: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    Encryption.validateContentEncryptionParameters(algorithm, keyBytes, initializationVector);
    return AesCtr.encrypt({
      counter : initializationVector,
      data    : plaintext,
      key     : Encryption.toA256CtrJwk(keyBytes),
      length  : AES_CTR_COUNTER_LENGTH_BITS,
    });
  }

  public static async decrypt(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    initializationVector: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    Encryption.validateContentEncryptionParameters(algorithm, keyBytes, initializationVector);
    return AesCtr.decrypt({
      counter : initializationVector,
      data    : ciphertext,
      key     : Encryption.toA256CtrJwk(keyBytes),
      length  : AES_CTR_COUNTER_LENGTH_BITS,
    });
  }

  public static async encryptStream(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    initializationVector: Uint8Array,
    plaintextStream: ReadableStream<Uint8Array>,
  ): Promise<ReadableStream<Uint8Array>> {
    const plaintext = await Encryption.readStream(plaintextStream);
    const ciphertext = await Encryption.encrypt(algorithm, keyBytes, initializationVector, plaintext);
    return Encryption.toStream(ciphertext);
  }

  public static async decryptStream(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    initializationVector: Uint8Array,
    ciphertextStream: ReadableStream<Uint8Array>,
  ): Promise<ReadableStream<Uint8Array>> {
    const ciphertext = await Encryption.readStream(ciphertextStream);
    const plaintext = await Encryption.decrypt(algorithm, keyBytes, initializationVector, ciphertext);
    return Encryption.toStream(plaintext);
  }

  public static async wrapKey(
    recipientPublicKey: PublicKeyJwk,
    cek: Uint8Array,
    keyInput: KeyEncryptionInput,
    ephemeralPrivateKey?: Jwk,
  ): Promise<{ encryptedKey: Uint8Array; ephemeralPublicKey: PublicKeyJwk }> {
    Encryption.validateContentEncryptionKey(cek);

    const privateKey = ephemeralPrivateKey ?? await X25519.generateKey();
    const publicKey = await X25519.getPublicKey({ key: privateKey }) as PublicKeyJwk;
    const sharedSecret = await X25519.sharedSecret({
      privateKeyA : privateKey,
      publicKeyB  : recipientPublicKey as Jwk,
    });
    const kek = await Encryption.deriveKek(sharedSecret, keyInput);
    const cekJwk = Encryption.toA256CtrJwk(cek);
    const kekJwk: Jwk = { alg: 'A256KW', k: Encoder.bytesToBase64Url(kek), kty: 'oct' };
    const encryptedKey = await AesKw.wrapKey({ encryptionKey: kekJwk, unwrappedKey: cekJwk });

    return { encryptedKey, ephemeralPublicKey: publicKey };
  }

  public static async unwrapKey(
    recipientPrivateKey: Jwk,
    keyEncryption: KeyEncryption,
  ): Promise<Uint8Array> {
    const sharedSecret = await X25519.sharedSecret({
      privateKeyA : recipientPrivateKey,
      publicKeyB  : keyEncryption.ephemeralPublicKey as Jwk,
    });
    const kek = await Encryption.deriveKek(sharedSecret, keyEncryption);
    const kekJwk: Jwk = { alg: 'A256KW', k: Encoder.bytesToBase64Url(kek), kty: 'oct' };
    const unwrappedJwk = await AesKw.unwrapKey({
      decryptionKey       : kekJwk,
      wrappedKeyAlgorithm : ContentEncryptionAlgorithm.A256CTR,
      wrappedKeyBytes     : Encoder.base64UrlToBytes(keyEncryption.encryptedKey),
    });

    return Encoder.base64UrlToBytes(unwrappedJwk.k!);
  }

  public static async buildEncryptionProperty(
    encryptionInput: EncryptionInput,
  ): Promise<DwnEncryption> {
    const algorithm = encryptionInput.algorithm ?? ContentEncryptionAlgorithm.A256CTR;
    Encryption.validateContentEncryptionParameters(algorithm, encryptionInput.key, encryptionInput.initializationVector);

    const keyEncryption: KeyEncryption[] = [];
    for (const keyInput of encryptionInput.keyEncryptionInputs) {
      const { encryptedKey, ephemeralPublicKey } = await Encryption.wrapKey(
        keyInput.publicKey,
        encryptionInput.key,
        keyInput,
      );
      const common = {
        algorithm    : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        encryptedKey : Encoder.bytesToBase64Url(encryptedKey),
        ephemeralPublicKey,
        keyId        : keyInput.keyId,
      };
      if (keyInput.derivationScheme === KeyDerivationScheme.ProtocolPath) {
        keyEncryption.push({
          ...common,
          derivationScheme: KeyDerivationScheme.ProtocolPath,
        });
      } else {
        keyEncryption.push({
          ...common,
          derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
          epoch            : keyInput.epoch,
          protocol         : keyInput.protocol,
          role             : keyInput.role,
        });
      }
    }

    return {
      algorithm,
      initializationVector: Encoder.bytesToBase64Url(encryptionInput.initializationVector),
      keyEncryption,
    };
  }

  public static async getKeyId(publicKeyJwk: PublicKeyJwk): Promise<string> {
    return computeJwkThumbprint({ jwk: publicKeyJwk });
  }

  public static validateEncryptionProperty(encryption: DwnEncryption): void {
    const initializationVector = Encoder.base64UrlToBytes(encryption.initializationVector);
    if (initializationVector.byteLength !== AES_CTR_COUNTER_LENGTH_BYTES) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteValidateIntegrityEncryptionInitializationVectorInvalid,
        `A256CTR initializationVector must decode to ${AES_CTR_COUNTER_LENGTH_BYTES} bytes.`
      );
    }

    for (const entry of encryption.keyEncryption) {
      if (entry.ephemeralPublicKey.kty !== 'OKP' || entry.ephemeralPublicKey.crv !== 'X25519') {
        throw new DwnError(
          DwnErrorCode.RecordsWriteValidateIntegrityEncryptionEphemeralPublicKeyInvalid,
          'ephemeralPublicKey must be an OKP X25519 public key.'
        );
      }
    }
  }

  private static async deriveKek(
    sharedSecret: Uint8Array,
    keyEncryption: KeyEncryptionInput | KeyEncryption,
  ): Promise<Uint8Array> {
    Encryption.validateSharedSecret(sharedSecret);
    const info = Encryption.getKekInfo(keyEncryption);
    return Hkdf.deriveKeyBytes({
      baseKeyBytes : sharedSecret,
      hash         : 'SHA-256',
      info,
      length       : 256,
      salt         : new Uint8Array(),
    });
  }

  private static getKekInfo(keyEncryption: KeyEncryptionInput | KeyEncryption): string {
    if (keyEncryption.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME) {
      return `${KEK_INFO_PREFIX}|roleAudience|${keyEncryption.protocol}|${keyEncryption.role}|${keyEncryption.epoch}|${keyEncryption.keyId}`;
    }

    return `${KEK_INFO_PREFIX}|protocolPath|${keyEncryption.keyId}`;
  }

  private static validateContentEncryptionParameters(
    algorithm: ContentEncryptionAlgorithm,
    keyBytes: Uint8Array,
    initializationVector: Uint8Array,
  ): void {
    if (algorithm !== ContentEncryptionAlgorithm.A256CTR) {
      throw new Error(`Unsupported content encryption algorithm: ${algorithm as string}`);
    }

    Encryption.validateContentEncryptionKey(keyBytes);

    if (initializationVector.byteLength !== AES_CTR_COUNTER_LENGTH_BYTES) {
      throw new Error(`A256CTR initializationVector must be ${AES_CTR_COUNTER_LENGTH_BYTES} bytes.`);
    }
  }

  private static validateContentEncryptionKey(keyBytes: Uint8Array): void {
    if (keyBytes.byteLength !== AES_256_KEY_LENGTH_BYTES) {
      throw new Error(`A256CTR content encryption key must be ${AES_256_KEY_LENGTH_BYTES} bytes.`);
    }
  }

  private static validateSharedSecret(sharedSecret: Uint8Array): void {
    if (sharedSecret.every((byte): boolean => byte === 0)) {
      throw new Error('X25519 shared secret MUST NOT be all zeros.');
    }
  }

  private static toA256CtrJwk(keyBytes: Uint8Array): Jwk {
    return { alg: ContentEncryptionAlgorithm.A256CTR, k: Encoder.bytesToBase64Url(keyBytes), kty: 'oct' };
  }

  private static async readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    return concatBytes(...chunks);
  }

  private static toStream(data: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(data);
        controller.close();
      }
    });
  }
}
