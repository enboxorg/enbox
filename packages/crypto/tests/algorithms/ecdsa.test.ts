import type { Jwk } from '../../src/jose/jwk.js';

import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EcdsaAlgorithm } from '../../src/algorithms/ecdsa.js';

describe('EcdsaAlgorithm', () => {
  let ecdsa: EcdsaAlgorithm;
  let privateKey: Jwk;
  let publicKey: Jwk;

  beforeAll(() => {
    ecdsa = new EcdsaAlgorithm();
  });

  beforeEach(async () => {
    privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });
    publicKey = await ecdsa.getPublicKey({ key: privateKey });
  });

  describe('computePublicKey()', () => {
    it('returns a public key in JWK format', async () => {
      // Test the method.
      const publicKey = await ecdsa.computePublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).not.toHaveProperty('d');
      expect(publicKey).toHaveProperty('kid');
      expect(publicKey).toHaveProperty('kty');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).toHaveProperty('y');
    });

    it('computes and adds a kid property, if missing', async () => {
      // Setup.
      const { kid, ...privateKeyWithoutKid } = privateKey;

      // Test the method.
      const publicKey = await ecdsa.computePublicKey({ key: privateKeyWithoutKid });

      // Validate the result.
      expect(publicKey).toHaveProperty('kid', kid);
    });

    it.each([
      ['ECDSA using secp256k1 curve and SHA-256', 'ES256K', 'ES256K', 'secp256k1'],
      ['secp256k1 as an alias for the ES256K algorithm identifier', 'secp256k1', 'ES256K', 'secp256k1'],
      ['ECDSA using secp256r1 curve and SHA-256', 'ES256', 'ES256', 'P-256'],
      ['secp256r1 as an alias for the ES256 algorithm identifier', 'secp256r1', 'ES256', 'P-256'],
    ] as const)('supports %s', async (_name, algorithm, expectedAlg, expectedCrv) => {
      // Setup.
      const privateKey = await ecdsa.generateKey({ algorithm });

      // Test the method.
      const publicKey = await ecdsa.computePublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).toHaveProperty('kty', 'EC');
      expect(publicKey).toHaveProperty('alg', expectedAlg);
      expect(publicKey).toHaveProperty('crv', expectedCrv);
    });

    it('throws an error if the key provided is not an EC private key', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'Ed25519',
        d   : 'd',
        kty : 'OKP',
        x   : 'x',
      };

      // Test the method.
      try {
        await ecdsa.computePublicKey({ key: privateKey });
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
        kty : 'EC',
        x   : 'x',
        y   : 'y',
      };

      // Test the method.
      try {
        await ecdsa.computePublicKey({ key: privateKey });
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
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });

      // Validate the result.
      expect(privateKey).toHaveProperty('kty', 'EC');
      expect(privateKey).toHaveProperty('kid');
    });

    it('supports ECDSA using secp256k1 curve and SHA-256', async () => {
      // Test the method.
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });

      expect(privateKey).toHaveProperty('alg', 'ES256K');
      expect(privateKey).toHaveProperty('crv', 'secp256k1');
    });

    it('accepts secp256k1 as an alias for the ES256K algorithm identifier', async () => {
      // Test the method.
      const privateKey = await ecdsa.generateKey({ algorithm: 'secp256k1' });

      expect(privateKey).toHaveProperty('alg', 'ES256K');
      expect(privateKey).toHaveProperty('crv', 'secp256k1');
    });

    it('supports ECDSA using secp256r1 curve and SHA-256', async () => {
      // Test the method.
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });

      expect(privateKey).toHaveProperty('alg', 'ES256');
      expect(privateKey).toHaveProperty('crv', 'P-256');
    });

    it('accepts secp256r1 as an alias for the ES256 algorithm identifier', async () => {
      // Test the method.
      const privateKey = await ecdsa.generateKey({ algorithm: 'secp256r1' });

      expect(privateKey).toHaveProperty('alg', 'ES256');
      expect(privateKey).toHaveProperty('crv', 'P-256');
    });
  });

  describe('getPublicKey()', () => {
    it('returns a public key in JWK format', async () => {
      // Test the method.
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).not.toHaveProperty('d');
      expect(publicKey).toHaveProperty('kid');
      expect(publicKey).toHaveProperty('kty');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).toHaveProperty('y');
    });

    it('computes and adds a kid property, if missing', async () => {
      // Setup.
      const { kid, ...privateKeyWithoutKid } = privateKey;

      // Test the method.
      const publicKey = await ecdsa.getPublicKey({ key: privateKeyWithoutKid });

      // Validate the result.
      expect(publicKey).toHaveProperty('kid', kid);
    });

    it('supports ECDSA using secp256k1 curve and SHA-256', async () => {
      // Setup.
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });

      // Test the method.
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).toHaveProperty('kty', 'EC');
      expect(publicKey).toHaveProperty('alg', 'ES256K');
      expect(publicKey).toHaveProperty('crv', 'secp256k1');
    });

    it('supports ECDSA using secp256r1 curve and SHA-256', async () => {
      // Setup.
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });

      // Test the method.
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });

      // Validate the result.
      expect(publicKey).toHaveProperty('kty', 'EC');
      expect(publicKey).toHaveProperty('alg', 'ES256');
      expect(publicKey).toHaveProperty('crv', 'P-256');
    });

    it('throws an error if the key provided is not an EC private key', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'Ed25519',
        d   : 'd',
        kty : 'OKP',
        x   : 'x',
      };

      // Test the method.
      try {
        await ecdsa.getPublicKey({ key: privateKey });
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
        kty : 'EC',
        x   : 'x',
        y   : 'y',
      };

      // Test the method.
      try {
        await ecdsa.getPublicKey({ key: privateKey });
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
      const signature = await ecdsa.sign({ key: privateKey, data });

      // Validate the result.
      expect(signature).toBeDefined();
      expect(signature).toBeInstanceOf(Uint8Array);
    });

    it('generates signatures in compact R+S format', async () => {
      // Test the method.
      const signature = await ecdsa.sign({ key: privateKey, data });

      // Validate the result.
      expect(signature).toHaveLength(64);
    });

    it('supports ECDSA using secp256k1 curve and SHA-256', async () => {
      // Setup.
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });

      // Test the method.
      const signature = await ecdsa.sign({ key: privateKey, data });

      // Validate the result.
      expect(signature).toHaveLength(64);
    });

    it('supports ECDSA using secp256r1 curve and SHA-256', async () => {
      // Setup.
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });

      // Test the method.
      const signature = await ecdsa.sign({ key: privateKey, data });

      // Validate the result.
      expect(signature).toHaveLength(64);
    });

    it('throws an error if the key provided is not an EC private key', async () => {
      // Setup.
      const privateKey: Jwk = {
        crv : 'Ed25519',
        d   : 'd',
        kty : 'OKP',
        x   : 'x',
      };

      // Test the method.
      try {
        await ecdsa.sign({ key: privateKey, data });
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
        kty : 'EC',
        x   : 'x',
        y   : 'y',
      };

      // Test the method.
      try {
      // Test the method.
        await ecdsa.sign({ key: privateKey, data });
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
      signature = await ecdsa.sign({ key: privateKey, data });
    });

    it(`returns a boolean verification result`, async () => {
      const isValid = await ecdsa.verify({
        key: publicKey,
        signature,
        data
      });

      expect(typeof isValid).toBe('boolean');
    });

    it('returns true for a valid signature', async () => {
      // Test the method.
      const isValid = await ecdsa.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(true);
    });

    it('returns false for an invalid signature', async () => {
      // Setup.
      const signature = new Uint8Array(64);

      // Test the method.
      const isValid = await ecdsa.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(false);
    });

    it('supports ECDSA using secp256k1 curve and SHA-256', async () => {
      // Setup.
      privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });
      publicKey = await ecdsa.getPublicKey({ key: privateKey });
      signature = await ecdsa.sign({ key: privateKey, data });

      // Test the method.
      const isValid = await ecdsa.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(true);
    });

    it('supports ECDSA using secp256r1 curve and SHA-256', async () => {
      // Setup.
      privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });
      publicKey = await ecdsa.getPublicKey({ key: privateKey });
      signature = await ecdsa.sign({ key: privateKey, data });

      // Test the method.
      const isValid = await ecdsa.verify({ key: publicKey, signature, data });

      // Validate the result.
      expect(isValid).toBe(true);
    });

    it('throws an error if the key provided is not an EC public key', async () => {
      // Setup.
      const publicKey: Jwk = {
        crv : 'Ed25519',
        kty : 'OKP',
        x   : 'x',
      };

      // Test the method.
      try {
        await ecdsa.verify({ key: publicKey, signature, data });
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
        kty : 'EC',
        x   : 'x',
        y   : 'y',
      };

      // Test the method.
      try {
      // Test the method.
        await ecdsa.verify({ key: publicKey, signature, data });
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
    it('returns a private key in JWK format with correct alg for ES256K', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });
      const privateKeyBytes = await ecdsa.privateKeyToBytes({ privateKey });
      const recoveredKey = await ecdsa.bytesToPrivateKey({ algorithm: 'ES256K', privateKeyBytes });

      expect(recoveredKey).toHaveProperty('kty', 'EC');
      expect(recoveredKey).toHaveProperty('crv', 'secp256k1');
      expect(recoveredKey).toHaveProperty('alg', 'ES256K');
      expect(recoveredKey).toHaveProperty('d');
    });

    it('returns a private key with correct alg for ES256', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });
      const privateKeyBytes = await ecdsa.privateKeyToBytes({ privateKey });
      const recoveredKey = await ecdsa.bytesToPrivateKey({ algorithm: 'ES256', privateKeyBytes });

      expect(recoveredKey).toHaveProperty('kty', 'EC');
      expect(recoveredKey).toHaveProperty('crv', 'P-256');
      expect(recoveredKey).toHaveProperty('alg', 'ES256');
    });

    it('supports the secp256k1 alias', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'secp256k1' });
      const privateKeyBytes = await ecdsa.privateKeyToBytes({ privateKey });
      const recoveredKey = await ecdsa.bytesToPrivateKey({ algorithm: 'secp256k1', privateKeyBytes });

      expect(recoveredKey).toHaveProperty('alg', 'ES256K');
    });

    it('supports the secp256r1 alias', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'secp256r1' });
      const privateKeyBytes = await ecdsa.privateKeyToBytes({ privateKey });
      const recoveredKey = await ecdsa.bytesToPrivateKey({ algorithm: 'secp256r1', privateKeyBytes });

      expect(recoveredKey).toHaveProperty('alg', 'ES256');
    });

    it('throws for unsupported algorithm', async () => {
      const privateKeyBytes = new Uint8Array(32);
      await expect(
        ecdsa.bytesToPrivateKey({ algorithm: 'unsupported' as any, privateKeyBytes })
      ).rejects.toThrow('Algorithm not supported');
    });
  });

  describe('bytesToPublicKey()', () => {
    it('returns a public key in JWK format with correct alg for ES256K', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await ecdsa.publicKeyToBytes({ publicKey });
      const recoveredKey = await ecdsa.bytesToPublicKey({ algorithm: 'ES256K', publicKeyBytes });

      expect(recoveredKey).toHaveProperty('kty', 'EC');
      expect(recoveredKey).toHaveProperty('crv', 'secp256k1');
      expect(recoveredKey).toHaveProperty('alg', 'ES256K');
      expect(recoveredKey).not.toHaveProperty('d');
    });

    it('returns a public key with correct alg for ES256', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await ecdsa.publicKeyToBytes({ publicKey });
      const recoveredKey = await ecdsa.bytesToPublicKey({ algorithm: 'ES256', publicKeyBytes });

      expect(recoveredKey).toHaveProperty('kty', 'EC');
      expect(recoveredKey).toHaveProperty('crv', 'P-256');
      expect(recoveredKey).toHaveProperty('alg', 'ES256');
    });

    it('throws for unsupported algorithm', async () => {
      const publicKeyBytes = new Uint8Array(33);
      await expect(
        ecdsa.bytesToPublicKey({ algorithm: 'unsupported' as any, publicKeyBytes })
      ).rejects.toThrow('Algorithm not supported');
    });
  });

  describe('privateKeyToBytes()', () => {
    it('returns a byte array for secp256k1 keys', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });
      const privateKeyBytes = await ecdsa.privateKeyToBytes({ privateKey });

      expect(privateKeyBytes).toBeInstanceOf(Uint8Array);
      expect(privateKeyBytes.byteLength).toBe(32);
    });

    it('returns a byte array for secp256r1 keys', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });
      const privateKeyBytes = await ecdsa.privateKeyToBytes({ privateKey });

      expect(privateKeyBytes).toBeInstanceOf(Uint8Array);
      expect(privateKeyBytes.byteLength).toBe(32);
    });

    it('round-trips with bytesToPrivateKey for secp256k1', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });
      const privateKeyBytes = await ecdsa.privateKeyToBytes({ privateKey });
      const recoveredKey = await ecdsa.bytesToPrivateKey({ algorithm: 'ES256K', privateKeyBytes });
      expect(recoveredKey.d).toBe(privateKey.d);
    });

    it('throws for unsupported curve', async () => {
      const invalidKey = { kty: 'EC' as const, crv: 'P-521', d: 'abc', x: 'def', y: 'ghi' };
      await expect(
        ecdsa.privateKeyToBytes({ privateKey: invalidKey })
      ).rejects.toThrow('Curve not supported');
    });
  });

  describe('publicKeyToBytes()', () => {
    it('returns a byte array for secp256k1 keys', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256K' });
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await ecdsa.publicKeyToBytes({ publicKey });

      expect(publicKeyBytes).toBeInstanceOf(Uint8Array);
      expect(publicKeyBytes.byteLength).toBe(65); // Uncompressed public key
    });

    it('returns a byte array for secp256r1 keys', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await ecdsa.publicKeyToBytes({ publicKey });

      expect(publicKeyBytes).toBeInstanceOf(Uint8Array);
      expect(publicKeyBytes.byteLength).toBe(65); // Uncompressed public key
    });

    it('round-trips with bytesToPublicKey for ES256', async () => {
      const privateKey = await ecdsa.generateKey({ algorithm: 'ES256' });
      const publicKey = await ecdsa.getPublicKey({ key: privateKey });
      const publicKeyBytes = await ecdsa.publicKeyToBytes({ publicKey });
      const recoveredKey = await ecdsa.bytesToPublicKey({ algorithm: 'ES256', publicKeyBytes });
      expect(recoveredKey.x).toBe(publicKey.x);
      expect(recoveredKey.y).toBe(publicKey.y);
    });

    it('throws for unsupported curve', async () => {
      const invalidKey = { kty: 'EC' as const, crv: 'P-521', x: 'def', y: 'ghi' };
      await expect(
        ecdsa.publicKeyToBytes({ publicKey: invalidKey })
      ).rejects.toThrow('Curve not supported');
    });
  });
});
