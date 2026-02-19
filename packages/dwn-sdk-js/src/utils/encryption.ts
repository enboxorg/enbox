import { concatBytes } from '@noble/ciphers/utils';
import { ctr } from '@noble/ciphers/aes';
import { EciesSecp256k1 } from '@enbox/crypto';

/**
 * Utility class for performing common, non-DWN specific encryption operations.
 * Uses `@noble/ciphers` for AES-256-CTR and `@enbox/crypto` for ECIES-SECP256K1
 * (browser-compatible, no Node `crypto` dependency).
 */
export class Encryption {
  /**
   * Encrypts the given plaintext stream using AES-256-CTR algorithm.
   */
  public static async aes256CtrEncrypt(
    key: Uint8Array, initializationVector: Uint8Array, plaintextStream: ReadableStream<Uint8Array>
  ): Promise<ReadableStream<Uint8Array>> {
    return Encryption.processStream(key, initializationVector, plaintextStream, 'encrypt');
  }

  /**
   * Decrypts the given cipher stream using AES-256-CTR algorithm.
   */
  public static async aes256CtrDecrypt(
    key: Uint8Array, initializationVector: Uint8Array, cipherStream: ReadableStream<Uint8Array>
  ): Promise<ReadableStream<Uint8Array>> {
    return Encryption.processStream(key, initializationVector, cipherStream, 'decrypt');
  }

  /**
   * Encrypts the given plaintext using ECIES (Elliptic Curve Integrated Encryption Scheme)
   * with SECP256K1 for the asymmetric calculations, HKDF as the key-derivation function,
   * and AES-GCM for the symmetric encryption and MAC algorithms.
   */
  public static async eciesSecp256k1Encrypt(publicKeyBytes: Uint8Array, plaintext: Uint8Array): Promise<EciesEncryptionOutput> {
    return EciesSecp256k1.encrypt(publicKeyBytes, plaintext);
  }

  /**
   * Decrypt the given ciphertext using ECIES (Elliptic Curve Integrated Encryption Scheme)
   * with SECP256K1 for the asymmetric calculations, HKDF as the key-derivation function,
   * and AES-GCM for the symmetric encryption and MAC algorithms.
   */
  public static async eciesSecp256k1Decrypt(input: EciesEncryptionInput): Promise<Uint8Array> {
    return EciesSecp256k1.decrypt(input);
  }

  /**
   * Whether the ephemeral public key is compressed (always true).
   */
  static get isEphemeralKeyCompressed(): boolean {
    return EciesSecp256k1.isEphemeralKeyCompressed;
  }

  /**
   * Reads the input stream, applies AES-256-CTR, and returns a new stream.
   * Errors from the source stream are forwarded to the returned stream.
   */
  private static processStream(
    key: Uint8Array, iv: Uint8Array, source: ReadableStream<Uint8Array>, op: 'encrypt' | 'decrypt'
  ): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        const reader = source.getReader();
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) { break; }
            chunks.push(value);
          }
          const data = concatBytes(...chunks);
          const result = op === 'encrypt'
            ? ctr(key, iv).encrypt(data)
            : ctr(key, iv).decrypt(data);
          controller.enqueue(result);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });
  }
}

export type EciesEncryptionOutput = {
  initializationVector: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  ciphertext: Uint8Array;
  messageAuthenticationCode: Uint8Array;
};

export type EciesEncryptionInput = EciesEncryptionOutput & {
  privateKey: Uint8Array;
};

export enum EncryptionAlgorithm {
  Aes256Ctr = 'A256CTR',
  EciesSecp256k1 = 'ECIES-ES256K'
}
