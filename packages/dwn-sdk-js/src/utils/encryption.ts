import * as crypto from 'crypto';
import * as eciesjs from 'eciesjs';

// compress publicKey for message encryption
eciesjs.ECIES_CONFIG.isEphemeralKeyCompressed = true;

/**
 * Utility class for performing common, non-DWN specific encryption operations.
 */
export class Encryption {
  /**
   * Encrypts the given plaintext stream using AES-256-CTR algorithm.
   */
  public static async aes256CtrEncrypt(
    key: Uint8Array, initializationVector: Uint8Array, plaintextStream: ReadableStream<Uint8Array>
  ): Promise<ReadableStream<Uint8Array>> {
    const cipher = crypto.createCipheriv('aes-256-ctr', key, initializationVector);

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        controller.enqueue(new Uint8Array(cipher.update(chunk)));
      },
      flush(controller): void {
        const finalChunk = cipher.final();
        if (finalChunk.length > 0) { controller.enqueue(new Uint8Array(finalChunk)); }
      }
    });

    return plaintextStream.pipeThrough(transform);
  }

  /**
   * Decrypts the given cipher stream using AES-256-CTR algorithm.
   */
  public static async aes256CtrDecrypt(
    key: Uint8Array, initializationVector: Uint8Array, cipherStream: ReadableStream<Uint8Array>
  ): Promise<ReadableStream<Uint8Array>> {
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, initializationVector);

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        controller.enqueue(new Uint8Array(decipher.update(chunk)));
      },
      flush(controller): void {
        const finalChunk = decipher.final();
        if (finalChunk.length > 0) { controller.enqueue(new Uint8Array(finalChunk)); }
      }
    });

    return cipherStream.pipeThrough(transform);
  }

  /**
   * Encrypts the given plaintext using ECIES (Elliptic Curve Integrated Encryption Scheme)
   * with SECP256K1 for the asymmetric calculations, HKDF as the key-derivation function,
   * and AES-GCM for the symmetric encryption and MAC algorithms.
   */
  public static async eciesSecp256k1Encrypt(publicKeyBytes: Uint8Array, plaintext: Uint8Array): Promise<EciesEncryptionOutput> {
    // underlying library requires Buffer as input
    const publicKey = Buffer.from(publicKeyBytes);
    const plaintextBuffer = Buffer.from(plaintext);

    const cryptogram = eciesjs.encrypt(publicKey, plaintextBuffer);

    // split cryptogram returned into constituent parts
    let start = 0;
    let end = Encryption.isEphemeralKeyCompressed ? 33 : 65;
    const ephemeralPublicKey = cryptogram.subarray(start, end);

    start = end;
    end += eciesjs.ECIES_CONFIG.symmetricNonceLength;
    const initializationVector = cryptogram.subarray(start, end);

    start = end;
    end += 16; // eciesjs.consts.AEAD_TAG_LENGTH
    const messageAuthenticationCode = cryptogram.subarray(start, end);

    const ciphertext = cryptogram.subarray(end);

    return {
      ciphertext,
      ephemeralPublicKey,
      initializationVector,
      messageAuthenticationCode
    };
  }

  /**
   * Decrypt the given plaintext using ECIES (Elliptic Curve Integrated Encryption Scheme)
   * with SECP256K1 for the asymmetric calculations, HKDF as the key-derivation function,
   * and AES-GCM for the symmetric encryption and MAC algorithms.
   */
  public static async eciesSecp256k1Decrypt(input: EciesEncryptionInput): Promise<Uint8Array> {
    // underlying library requires Buffer as input
    const privateKeyBuffer = Buffer.from(input.privateKey);
    const eciesEncryptionOutput = Buffer.concat([
      input.ephemeralPublicKey,
      input.initializationVector,
      input.messageAuthenticationCode,
      input.ciphertext
    ]);

    const plaintext = eciesjs.decrypt(privateKeyBuffer, eciesEncryptionOutput);

    return plaintext;
  }

  /**
   * Expose eciesjs library configuration
   */
  static get isEphemeralKeyCompressed():boolean {
    return eciesjs.ECIES_CONFIG.isEphemeralKeyCompressed;
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