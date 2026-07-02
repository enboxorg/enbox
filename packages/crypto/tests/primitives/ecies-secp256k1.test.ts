import { describe, expect, it } from 'bun:test';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import { EciesSecp256k1 } from '../../src/primitives/ecies-secp256k1.js';

describe('EciesSecp256k1', () => {
  /**
   * Helper: generates a secp256k1 key pair and returns the private key bytes
   * and the compressed public key bytes.
   */
  function generateKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const privateKey = secp256k1.utils.randomSecretKey();
    const publicKey = secp256k1.getPublicKey(privateKey, true);
    return { privateKey, publicKey };
  }

  describe('encrypt() and decrypt() — round-trip', () => {
    it('should encrypt and decrypt a small message', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('hello world');

      const encrypted = EciesSecp256k1.encrypt(publicKey, plaintext);
      const decrypted = EciesSecp256k1.decrypt({
        privateKey,
        ephemeralPublicKey        : encrypted.ephemeralPublicKey,
        initializationVector      : encrypted.initializationVector,
        messageAuthenticationCode : encrypted.messageAuthenticationCode,
        ciphertext                : encrypted.ciphertext,
      });

      expect(decrypted).toEqual(plaintext);
    });

    it('should encrypt and decrypt an empty message', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const plaintext = new Uint8Array(0);

      const encrypted = EciesSecp256k1.encrypt(publicKey, plaintext);
      const decrypted = EciesSecp256k1.decrypt({
        privateKey,
        ephemeralPublicKey        : encrypted.ephemeralPublicKey,
        initializationVector      : encrypted.initializationVector,
        messageAuthenticationCode : encrypted.messageAuthenticationCode,
        ciphertext                : encrypted.ciphertext,
      });

      expect(decrypted).toEqual(plaintext);
    });

    it('should encrypt and decrypt a large message (64KB)', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const plaintext = new Uint8Array(65536);
      for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256;
      }

      const encrypted = EciesSecp256k1.encrypt(publicKey, plaintext);
      const decrypted = EciesSecp256k1.decrypt({
        privateKey,
        ephemeralPublicKey        : encrypted.ephemeralPublicKey,
        initializationVector      : encrypted.initializationVector,
        messageAuthenticationCode : encrypted.messageAuthenticationCode,
        ciphertext                : encrypted.ciphertext,
      });

      expect(decrypted).toEqual(plaintext);
    });

    it('should work with an uncompressed public key (65 bytes)', () => {
      const privateKey = secp256k1.utils.randomSecretKey();
      const publicKeyUncompressed = secp256k1.getPublicKey(privateKey, false);

      expect(publicKeyUncompressed).toHaveLength(65);

      const plaintext = new TextEncoder().encode('uncompressed key test');
      const encrypted = EciesSecp256k1.encrypt(publicKeyUncompressed, plaintext);
      const decrypted = EciesSecp256k1.decrypt({
        privateKey,
        ephemeralPublicKey        : encrypted.ephemeralPublicKey,
        initializationVector      : encrypted.initializationVector,
        messageAuthenticationCode : encrypted.messageAuthenticationCode,
        ciphertext                : encrypted.ciphertext,
      });

      expect(decrypted).toEqual(plaintext);
    });
  });

  describe('encrypt()', () => {
    it('should return an object with the expected properties', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('test');

      const result = EciesSecp256k1.encrypt(publicKey, plaintext);

      expect(result).toHaveProperty('ephemeralPublicKey');
      expect(result).toHaveProperty('initializationVector');
      expect(result).toHaveProperty('messageAuthenticationCode');
      expect(result).toHaveProperty('ciphertext');
    });

    it('should return a compressed ephemeral public key (33 bytes)', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('test');

      const result = EciesSecp256k1.encrypt(publicKey, plaintext);

      expect(result.ephemeralPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.ephemeralPublicKey).toHaveLength(33);
    });

    it('should return a 16-byte initialization vector', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('test');

      const result = EciesSecp256k1.encrypt(publicKey, plaintext);

      expect(result.initializationVector).toBeInstanceOf(Uint8Array);
      expect(result.initializationVector).toHaveLength(16);
    });

    it('should return a 16-byte message authentication code', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('test');

      const result = EciesSecp256k1.encrypt(publicKey, plaintext);

      expect(result.messageAuthenticationCode).toBeInstanceOf(Uint8Array);
      expect(result.messageAuthenticationCode).toHaveLength(16);
    });

    it('should produce different ciphertext on successive encryptions of the same plaintext', () => {
      const { publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('same plaintext');

      const first = EciesSecp256k1.encrypt(publicKey, plaintext);
      const second = EciesSecp256k1.encrypt(publicKey, plaintext);

      // Ephemeral keys should differ (randomized encryption).
      expect(first.ephemeralPublicKey).not.toEqual(second.ephemeralPublicKey);
    });
  });

  describe('decrypt()', () => {
    it('should fail to decrypt with the wrong private key', () => {
      const { publicKey } = generateKeyPair();
      const { privateKey: wrongPrivateKey } = generateKeyPair();

      const plaintext = new TextEncoder().encode('secret');
      const encrypted = EciesSecp256k1.encrypt(publicKey, plaintext);

      expect(() => EciesSecp256k1.decrypt({
        privateKey                : wrongPrivateKey,
        ephemeralPublicKey        : encrypted.ephemeralPublicKey,
        initializationVector      : encrypted.initializationVector,
        messageAuthenticationCode : encrypted.messageAuthenticationCode,
        ciphertext                : encrypted.ciphertext,
      })).toThrow();
    });

    it('should fail to decrypt with tampered ciphertext', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('do not tamper');
      const encrypted = EciesSecp256k1.encrypt(publicKey, plaintext);

      // Flip a bit in the ciphertext.
      const tampered = new Uint8Array(encrypted.ciphertext);
      tampered[0] ^= 0xFF;

      expect(() => EciesSecp256k1.decrypt({
        privateKey,
        ephemeralPublicKey        : encrypted.ephemeralPublicKey,
        initializationVector      : encrypted.initializationVector,
        messageAuthenticationCode : encrypted.messageAuthenticationCode,
        ciphertext                : tampered,
      })).toThrow();
    });

    it('should fail to decrypt with tampered MAC', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const plaintext = new TextEncoder().encode('mac tamper test');
      const encrypted = EciesSecp256k1.encrypt(publicKey, plaintext);

      // Flip a bit in the MAC.
      const tamperedMac = new Uint8Array(encrypted.messageAuthenticationCode);
      tamperedMac[0] ^= 0xFF;

      expect(() => EciesSecp256k1.decrypt({
        privateKey,
        ephemeralPublicKey        : encrypted.ephemeralPublicKey,
        initializationVector      : encrypted.initializationVector,
        messageAuthenticationCode : tamperedMac,
        ciphertext                : encrypted.ciphertext,
      })).toThrow();
    });
  });

  describe('isEphemeralKeyCompressed', () => {
    it('should return true', () => {
      expect(EciesSecp256k1.isEphemeralKeyCompressed).toBe(true);
    });
  });
});
