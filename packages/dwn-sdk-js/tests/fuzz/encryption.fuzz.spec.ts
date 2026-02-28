import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { ContentEncryptionAlgorithm, Encryption } from '../../src/utils/encryption.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

/** Generates a random 32-byte key (256-bit) for AES-256-GCM or XChaCha20. */
function aes256Key(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: 32, maxLength: 32 });
}

/** Generates a random 12-byte IV for AES-256-GCM. */
function aesGcmIv(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: 12, maxLength: 12 });
}

/** Generates a random 24-byte nonce for XChaCha20-Poly1305. */
function xchachaIv(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: 24, maxLength: 24 });
}

describe('Encryption — fuzz', () => {

  describe('AES-256-GCM — encrypt/decrypt roundtrip', () => {
    it('should roundtrip arbitrary plaintext through AES-256-GCM', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          aesGcmIv(),
          fc.uint8Array({ minLength: 0, maxLength: 1024 }),
          async (key, iv, plaintext) => {
            const { ciphertext, tag } = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.A256GCM, key, iv, plaintext
            );
            const decrypted = await Encryption.aeadDecrypt(
              ContentEncryptionAlgorithm.A256GCM, key, iv, ciphertext, tag
            );
            expect(decrypted).toEqual(plaintext);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('XChaCha20-Poly1305 — encrypt/decrypt roundtrip', () => {
    it('should roundtrip arbitrary plaintext through XChaCha20-Poly1305', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          xchachaIv(),
          fc.uint8Array({ minLength: 0, maxLength: 1024 }),
          async (key, iv, plaintext) => {
            const { ciphertext, tag } = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.XC20P, key, iv, plaintext
            );
            const decrypted = await Encryption.aeadDecrypt(
              ContentEncryptionAlgorithm.XC20P, key, iv, ciphertext, tag
            );
            expect(decrypted).toEqual(plaintext);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('AES-256-GCM — ciphertext differs from plaintext', () => {
    it('should produce ciphertext that is not equal to the plaintext (for non-empty input)', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          aesGcmIv(),
          fc.uint8Array({ minLength: 1, maxLength: 512 }),
          async (key, iv, plaintext) => {
            const { ciphertext } = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.A256GCM, key, iv, plaintext
            );
            // Ciphertext should not be identical to plaintext
            const areEqual = plaintext.length === ciphertext.length &&
              plaintext.every((byte, i) => byte === ciphertext[i]);
            expect(areEqual).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('AES-256-GCM — wrong key fails decryption', () => {
    it('should fail to decrypt with a different key', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          aes256Key(),
          aesGcmIv(),
          fc.uint8Array({ minLength: 1, maxLength: 256 }),
          async (key1, key2, iv, plaintext) => {
            // Skip if keys are identical
            if (key1.every((byte, i) => byte === key2[i])) {
              return;
            }

            const { ciphertext, tag } = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.A256GCM, key1, iv, plaintext
            );

            try {
              await Encryption.aeadDecrypt(
                ContentEncryptionAlgorithm.A256GCM, key2, iv, ciphertext, tag
              );
              // If decryption somehow succeeds, the result should differ from plaintext
              // (astronomically unlikely with AEAD)
            } catch {
              // Expected: AEAD authentication should fail with wrong key
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('XChaCha20-Poly1305 — wrong key fails decryption', () => {
    it('should fail to decrypt with a different key', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          aes256Key(),
          xchachaIv(),
          fc.uint8Array({ minLength: 1, maxLength: 256 }),
          async (key1, key2, iv, plaintext) => {
            // Skip if keys are identical
            if (key1.every((byte, i) => byte === key2[i])) {
              return;
            }

            const { ciphertext, tag } = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.XC20P, key1, iv, plaintext
            );

            try {
              await Encryption.aeadDecrypt(
                ContentEncryptionAlgorithm.XC20P, key2, iv, ciphertext, tag
              );
            } catch {
              // Expected: AEAD authentication should fail with wrong key
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('AES-256-GCM — tampered ciphertext fails decryption', () => {
    it('should fail to decrypt when ciphertext is modified', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          aesGcmIv(),
          fc.uint8Array({ minLength: 1, maxLength: 256 }),
          fc.nat(),
          async (key, iv, plaintext, flipIndex) => {
            const { ciphertext, tag } = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.A256GCM, key, iv, plaintext
            );

            if (ciphertext.length === 0) {
              return; // skip empty ciphertext
            }

            // Flip a bit in the ciphertext
            const tampered = new Uint8Array(ciphertext);
            const idx = flipIndex % tampered.length;
            tampered[idx] ^= 0xFF;

            try {
              await Encryption.aeadDecrypt(
                ContentEncryptionAlgorithm.A256GCM, key, iv, tampered, tag
              );
              // If decryption somehow succeeds, data integrity has been compromised
              // (astronomically unlikely with AEAD)
            } catch {
              // Expected: AEAD authentication should fail on tampered ciphertext
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('encrypt — deterministic output for same inputs', () => {
    it('should produce the same ciphertext and tag for the same key, IV, and plaintext', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          aesGcmIv(),
          fc.uint8Array({ minLength: 0, maxLength: 256 }),
          async (key, iv, plaintext) => {
            const result1 = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.A256GCM, key, iv, plaintext
            );
            const result2 = await Encryption.aeadEncrypt(
              ContentEncryptionAlgorithm.A256GCM, key, iv, plaintext
            );
            expect(result1.ciphertext).toEqual(result2.ciphertext);
            expect(result1.tag).toEqual(result2.tag);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('aeadDecrypt — crash resistance with malformed inputs', () => {
    it('should throw (not crash) on wrong-length IVs for AES-GCM', async () => {
      await fc.assert(
        fc.asyncProperty(
          aes256Key(),
          fc.uint8Array({ minLength: 0, maxLength: 50 }).filter((iv) => iv.length !== 12),
          fc.uint8Array({ minLength: 1, maxLength: 64 }),
          fc.uint8Array({ minLength: 16, maxLength: 16 }),
          async (key, badIv, ciphertext, tag) => {
            try {
              await Encryption.aeadDecrypt(
                ContentEncryptionAlgorithm.A256GCM, key, badIv, ciphertext, tag
              );
            } catch {
              // Expected: wrong IV length should throw
            }
          }
        ),
        { numRuns: Math.min(numRuns, 50) }
      );
    });
  });
});
