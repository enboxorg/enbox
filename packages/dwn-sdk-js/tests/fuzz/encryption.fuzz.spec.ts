import type { PublicKeyJwk } from '../../src/types/jose-types.js';

import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { ArrayUtility } from '../../src/utils/array.js';
import { Encoder } from '../../src/utils/encoder.js';
import { KeyDerivationScheme } from '../../src/utils/hd-key.js';
import { X25519 } from '@enbox/crypto';
import { ContentEncryptionAlgorithm, Encryption, KeyAgreementAlgorithm } from '../../src/utils/encryption.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

function aes256Key(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: 32, maxLength: 32 });
}

function aesCtrIv(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: 16, maxLength: 16 });
}

describe('Encryption — fuzz', () => {
  it('should roundtrip arbitrary plaintext through A256CTR', async () => {
    await fc.assert(
      fc.asyncProperty(
        aes256Key(),
        aesCtrIv(),
        fc.uint8Array({ minLength: 0, maxLength: 1024 }),
        async (key, iv, plaintext): Promise<void> => {
          const ciphertext = await Encryption.encrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, plaintext);
          const decrypted = await Encryption.decrypt(ContentEncryptionAlgorithm.A256CTR, key, iv, ciphertext);
          expect(decrypted).toEqual(plaintext);
        }
      ),
      { numRuns }
    );
  });

  it('should wrap and unwrap arbitrary CEKs', async () => {
    const recipientPrivateKey = await X25519.generateKey();
    const recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey }) as PublicKeyJwk;
    const keyId = await Encryption.getKeyId(recipientPublicKey);

    await fc.assert(
      fc.asyncProperty(
        aes256Key(),
        async (cek): Promise<void> => {
          const wrapped = await Encryption.wrapKey(
            recipientPublicKey,
            cek,
            { derivationScheme: KeyDerivationScheme.ProtocolPath, keyId, publicKey: recipientPublicKey },
          );
          const unwrapped = await Encryption.unwrapKey(recipientPrivateKey, {
            algorithm          : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
            derivationScheme   : KeyDerivationScheme.ProtocolPath,
            encryptedKey       : Encoder.bytesToBase64Url(wrapped.encryptedKey),
            ephemeralPublicKey : wrapped.ephemeralPublicKey,
            keyId,
          });

          expect(ArrayUtility.byteArraysEqual(unwrapped, cek)).toBe(true);
        }
      ),
      { numRuns }
    );
  });
});
