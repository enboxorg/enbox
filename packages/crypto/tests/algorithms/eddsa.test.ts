import type { Jwk } from '../../src/jose/jwk.js';

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EdDsaAlgorithm } from '../../src/algorithms/eddsa.js';

describe('EdDsaAlgorithm', () => {
  let eddsa: EdDsaAlgorithm;
  let privateKey: Jwk;
  let publicKey: Jwk;

  beforeAll(() => {
    eddsa = new EdDsaAlgorithm();
  });

  beforeEach(async () => {
    privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });
    publicKey = await eddsa.getPublicKey({ key: privateKey });
  });

  describe('computePublicKey()', () => {
    it('returns a public key in JWK format', async () => {
      // Test the method.
      const publicKey = await eddsa.computePublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).toHaveProperty('kid');
      expect(publicKey).toHaveProperty('kty');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).not.toHaveProperty('d');
      expect(publicKey).not.toHaveProperty('y');
    });

    it('computes and adds a kid property, if missing', async () => {
      // Setup.
      const { kid, ...privateKeyWithoutKid } = privateKey;

      // Test the method.
      const publicKey = await eddsa.computePublicKey({ key: privateKeyWithoutKid });

      // Validate the result.
      expect(publicKey).toHaveProperty('kid', kid);
    });

    it('supports EdDSA using Ed25519 curve', async () => {
      // Setup.
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });

      // Test the method.
      const publicKey = await eddsa.computePublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).toHaveProperty('kty', 'OKP');
      expect(publicKey).toHaveProperty('alg', 'EdDSA');
      expect(publicKey).toHaveProperty('crv', 'Ed25519');
    });

    it('throws an error if the key provided is not an OKP private key', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'secp256k1',
        d   : 'd',
        kty : 'EC',
        x   : 'x',
        y   : 'y'
      };

      // Test the method.
      try {
        await eddsa.computePublicKey({ key: privateKey });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Invalid key provided');
      }
    });

    it('throws an error for an unsupported curve', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'unsupported-curve',
        d   : 'd',
        kty : 'OKP',
        x   : 'x'
      };

      // Test the method.
      try {
        await eddsa.computePublicKey({ key: privateKey });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Unsupported curve');
      }
    });
  });

  describe('generateKey()', () => {
    it('returns a private key in JWK format', async () => {
      // Test the method.
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });

      // Validate the result.
      expect(privateKey).toHaveProperty('kty', 'OKP');
      expect(privateKey).toHaveProperty('kid');
    });

    it('supports EdDSA using Ed25519 curve', async () => {
      // Test the method.
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });

      expect(privateKey).toHaveProperty('alg', 'EdDSA');
      expect(privateKey).toHaveProperty('crv', 'Ed25519');
    });
  });

  describe('getPublicKey()', () => {
    it('returns a public key in JWK format', async () => {
      // Test the method.
      const publicKey = await eddsa.getPublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).not.toHaveProperty('d');
      expect(publicKey).toHaveProperty('kid');
      expect(publicKey).toHaveProperty('kty');
      expect(publicKey).toHaveProperty('x');
    });

    it('computes and adds a kid property, if missing', async () => {
      // Setup.
      const { kid, ...privateKeyWithoutKid } = privateKey;

      // Test the method.
      const publicKey = await eddsa.getPublicKey({ key: privateKeyWithoutKid });

      // Validate the result.
      expect(publicKey).toHaveProperty('kid', kid);
    });

    it('supports EdDSA using Ed25519 curve', async () => {
      // Setup.
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });

      // Test the method.
      const publicKey = await eddsa.getPublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).toHaveProperty('kty', 'OKP');
      expect(publicKey).toHaveProperty('alg', 'EdDSA');
      expect(publicKey).toHaveProperty('crv', 'Ed25519');
    });

    it('throws an error if the key provided is not an OKP private key', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'secp256k1',
        d   : 'd',
        kty : 'EC',
        x   : 'x',
        y   : 'y'
      };

      // Test the method.
      try {
        await eddsa.getPublicKey({ key: privateKey });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Invalid key provided');
      }
    });

    it('throws an error for an unsupported curve', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'unsupported-curve',
        d   : 'd',
        kty : 'OKP',
        x   : 'x'
      };

      // Test the method.
      try {
        await eddsa.getPublicKey({ key: privateKey });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Unsupported curve');
      }
    });
  });

  describe('sign()', () => {
    const data = new Uint8Array([0, 1, 2, 3, 4]);

    it('generates signatures as Uint8Array', async () => {
      // Test the method.
      const signature = await eddsa.sign({ key: privateKey, data });

      // Validate the result.
      expect(signature).toBeDefined();
      expect(signature).toBeInstanceOf(Uint8Array);
    });

    it('generates signatures in compact R+S format', async () => {
      // Test the method.
      const signature = await eddsa.sign({ key: privateKey, data });

      // Validate the result.
      expect(signature).toHaveLength(64);
    });

    it('throws an error if the key provided is not an OKP private key', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'secp256k1',
        d   : 'd',
        kty : 'EC',
        x   : 'x',
        y   : 'y'
      };

      // Test the method.
      try {
        await eddsa.sign({ key: privateKey, data });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Invalid key provided');
      }
    });

    it('throws an error for an unsupported curve', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'unsupported-curve',
        d   : 'd',
        kty : 'OKP',
        x   : 'x'
      };

      // Test the method.
      try {
      // Test the method.
        await eddsa.sign({ key: privateKey, data });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Unsupported curve');
      }
    });
  });

  describe('verify()', () => {
    const data = new Uint8Array([0, 1, 2, 3, 4]);
    let signature: Uint8Array;

    beforeEach(async () => {
      signature = await eddsa.sign({ key: privateKey, data });
    });

    it(`returns a boolean verification result`, async () => {
      const isValid = await eddsa.verify({
        key: publicKey,
        signature,
        data
      });

      expect(typeof isValid).toBe('boolean');
    });

    it('returns true for a valid signature', async () => {
      // Test the method.
      const isValid = await eddsa.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(true);
    });

    it('returns false for an invalid signature', async () => {
      // Setup.
      const signature = new Uint8Array(64);

      // Test the method.
      const isValid = await eddsa.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(false);
    });

    it('throws an error if the key provided is not an OKP public key', async () => {
      // Setup.
      const publicKey: Jwk = {
        crv : 'secp256k1',
        kty : 'EC',
        x   : 'x',
        y   : 'y'
      };

      // Test the method.
      try {
        await eddsa.verify({ key: publicKey, signature, data });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Invalid key provided');
      }
    });

    it('throws an error for an unsupported curve', async () => {
      // Setup.
      const publicKey: Jwk = {
        crv : 'unsupported-curve',
        kty : 'OKP',
        x   : 'x'
      };

      // Test the method.
      try {
      // Test the method.
        await eddsa.verify({ key: publicKey, signature, data });
        throw new Error('Expected an error to be thrown.');

      } catch (error: any) {
        // Validate the result.
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Unsupported curve');
      }
    });
  });

  describe('bytesToPrivateKey()', () => {
    it('returns a private key in JWK format with alg set to EdDSA', async () => {
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });
      const privateKeyBytes = await eddsa.privateKeyToBytes({ privateKey });
      const recoveredKey = await eddsa.bytesToPrivateKey({ algorithm: 'Ed25519', privateKeyBytes });

      expect(recoveredKey).toHaveProperty('kty', 'OKP');
      expect(recoveredKey).toHaveProperty('crv', 'Ed25519');
      expect(recoveredKey).toHaveProperty('alg', 'EdDSA');
      expect(recoveredKey).toHaveProperty('d');
    });

    it('throws for unsupported algorithm', async () => {
      const privateKeyBytes = new Uint8Array(32);
      await expect(
        eddsa.bytesToPrivateKey({ algorithm: 'unsupported' as any, privateKeyBytes })
      ).rejects.toThrow('Algorithm not supported');
    });
  });

  describe('bytesToPublicKey()', () => {
    it('returns a public key in JWK format with alg set to EdDSA', async () => {
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });
      const publicKey = await eddsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await eddsa.publicKeyToBytes({ publicKey });
      const recoveredKey = await eddsa.bytesToPublicKey({ algorithm: 'Ed25519', publicKeyBytes });

      expect(recoveredKey).toHaveProperty('kty', 'OKP');
      expect(recoveredKey).toHaveProperty('crv', 'Ed25519');
      expect(recoveredKey).toHaveProperty('alg', 'EdDSA');
      expect(recoveredKey).not.toHaveProperty('d');
    });

    it('throws for unsupported algorithm', async () => {
      const publicKeyBytes = new Uint8Array(32);
      await expect(
        eddsa.bytesToPublicKey({ algorithm: 'unsupported' as any, publicKeyBytes })
      ).rejects.toThrow('Algorithm not supported');
    });
  });

  describe('privateKeyToBytes()', () => {
    it('returns a byte array for Ed25519 keys', async () => {
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });
      const privateKeyBytes = await eddsa.privateKeyToBytes({ privateKey });

      expect(privateKeyBytes).toBeInstanceOf(Uint8Array);
      expect(privateKeyBytes.byteLength).toBe(32);
    });

    it('round-trips with bytesToPrivateKey', async () => {
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });
      const privateKeyBytes = await eddsa.privateKeyToBytes({ privateKey });
      const recoveredKey = await eddsa.bytesToPrivateKey({ algorithm: 'Ed25519', privateKeyBytes });
      expect(recoveredKey.d).toBe(privateKey.d);
    });

    it('throws for unsupported curve', async () => {
      const invalidKey = { kty: 'OKP' as const, crv: 'Ed448', d: 'abc', x: 'def' };
      await expect(
        eddsa.privateKeyToBytes({ privateKey: invalidKey })
      ).rejects.toThrow('Curve not supported');
    });
  });

  describe('publicKeyToBytes()', () => {
    it('returns a byte array for Ed25519 keys', async () => {
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });
      const publicKey = await eddsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await eddsa.publicKeyToBytes({ publicKey });

      expect(publicKeyBytes).toBeInstanceOf(Uint8Array);
      expect(publicKeyBytes.byteLength).toBe(32);
    });

    it('round-trips with bytesToPublicKey', async () => {
      const privateKey = await eddsa.generateKey({ algorithm: 'Ed25519' });
      const publicKey = await eddsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await eddsa.publicKeyToBytes({ publicKey });
      const recoveredKey = await eddsa.bytesToPublicKey({ algorithm: 'Ed25519', publicKeyBytes });
      expect(recoveredKey.x).toBe(publicKey.x);
    });

    it('throws for unsupported curve', async () => {
      const invalidKey = { kty: 'OKP' as const, crv: 'Ed448', x: 'def' };
      await expect(
        eddsa.publicKeyToBytes({ publicKey: invalidKey })
      ).rejects.toThrow('Curve not supported');
    });
  });
});
