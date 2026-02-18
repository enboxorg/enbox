import type { Jwk, JwkParamsOkpPrivate } from '../../src/jose/jwk.js';

import { Convert } from '@enbox/common';
import { beforeAll, describe, expect, it } from 'bun:test';

import x25519BytesToPrivateKey from '../fixtures/test-vectors/x25519/bytes-to-private-key.json' with { type: 'json' };
import x25519BytesToPublicKey from '../fixtures/test-vectors/x25519/bytes-to-public-key.json' with { type: 'json' };
import x25519PrivateKeyToBytes from '../fixtures/test-vectors/x25519/private-key-to-bytes.json' with { type: 'json' };
import x25519PublicKeyToBytes from '../fixtures/test-vectors/x25519/public-key-to-bytes.json' with { type: 'json' };

import { X25519 } from '../../src/primitives/x25519.js';

describe('X25519', () => {
  let privateKey: Jwk;
  let publicKey: Jwk;

  beforeAll(async () => {
    privateKey = await X25519.generateKey();
    publicKey = await X25519.computePublicKey({ key: privateKey });
  });

  describe('bytesToPrivateKey()', () => {
    it('returns a private key in JWK format', async () => {
      const privateKeyBytes = Convert.hex('c8a9d5a91091ad851c668b0736c1c9a02936c0d3ad62670858088047ba057475').toUint8Array();
      const privateKey = await X25519.bytesToPrivateKey({ privateKeyBytes });

      expect(privateKey).toHaveProperty('crv', 'X25519');
      expect(privateKey).toHaveProperty('d');
      expect(privateKey).toHaveProperty('kid');
      expect(privateKey).toHaveProperty('kty', 'OKP');
      expect(privateKey).toHaveProperty('x');
    });

    for (const vector of x25519BytesToPrivateKey.vectors) {
      it(vector.description, async () => {
        const privateKey = await X25519.bytesToPrivateKey({
          privateKeyBytes: Convert.hex(vector.input.privateKeyBytes).toUint8Array()
        });

        expect(privateKey).toEqual(vector.output);
      });
    }
  });

  describe('bytesToPublicKey()', () => {
    it('returns a public key in JWK format', async () => {
      const publicKeyBytes = Convert.hex('504a36999f489cd2fdbc08baff3d88fa00569ba986cba22548ffde80f9806829').toUint8Array();
      const publicKey = await X25519.bytesToPublicKey({ publicKeyBytes });

      expect(publicKey).toHaveProperty('crv', 'X25519');
      expect(publicKey).toHaveProperty('kid');
      expect(publicKey).toHaveProperty('kty', 'OKP');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).not.toHaveProperty('d');
    });

    for (const vector of x25519BytesToPublicKey.vectors) {
      it(vector.description, async () => {
        const publicKey = await X25519.bytesToPublicKey({
          publicKeyBytes: Convert.hex(vector.input.publicKeyBytes).toUint8Array()
        });

        expect(publicKey).toEqual(vector.output);
      });
    }
  });

  describe('computePublicKey()', () => {
    it('returns a public key in JWK format', async () => {
      const publicKey = await X25519.computePublicKey({ key: privateKey });

      expect(publicKey).toHaveProperty('kty', 'OKP');
      expect(publicKey).toHaveProperty('crv', 'X25519');
      expect(publicKey).toHaveProperty('kid');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).not.toHaveProperty('d');
    });

    it('computes and adds a kid property, if missing', async () => {
      const { kid, ...privateKeyWithoutKid } = privateKey;
      const publicKey = await X25519.computePublicKey({ key: privateKeyWithoutKid });

      expect(publicKey).toHaveProperty('kid', kid);
    });
  });

  describe('generateKey()', () => {
    it('returns a private key in JWK format', async () => {
      const privateKey = await X25519.generateKey();

      expect(privateKey).toHaveProperty('crv', 'X25519');
      expect(privateKey).toHaveProperty('d');
      expect(privateKey).toHaveProperty('kid');
      expect(privateKey).toHaveProperty('kty', 'OKP');
      expect(privateKey).toHaveProperty('x');
    });

    it('returns a 32-byte private key', async () => {
      const privateKey = await X25519.generateKey() as JwkParamsOkpPrivate;

      const privateKeyBytes = Convert.base64Url(privateKey.d).toUint8Array();
      expect(privateKeyBytes.byteLength).toBe(32);
    });
  });

  describe('getPublicKey()', () => {
    it('returns a public key in JWK format', async () => {
      const publicKey = await X25519.getPublicKey({ key: privateKey });

      expect(publicKey).toHaveProperty('kty', 'OKP');
      expect(publicKey).toHaveProperty('crv', 'X25519');
      expect(publicKey).toHaveProperty('x');
      expect(publicKey).not.toHaveProperty('d');
    });

    it('computes and adds a kid property, if missing', async () => {
      const { kid, ...privateKeyWithoutKid } = privateKey;
      const publicKey = await X25519.getPublicKey({ key: privateKeyWithoutKid });

      expect(publicKey).toHaveProperty('kid', kid);
    });

    it('returns the same output as computePublicKey()', async () => {
      const publicKey = await X25519.getPublicKey({ key: privateKey });
      expect(publicKey).toEqual(await X25519.computePublicKey({ key: privateKey }));
    });

    it('throws an error when provided an X25519 public key', async () => {
      await expect(
        X25519.getPublicKey({ key: publicKey })
      ).rejects.toThrow('key is not an X25519 private JWK');
    });

    it('throws an error when provided an Ed25519 private key', async () => {
      const ed25519PrivateKey: Jwk = {
        crv : 'Ed25519',
        d   : 'TM0Imyj_ltqdtsNG7BFOD1uKMZ81q6Yk2oz27U-4pvs',
        kty : 'OKP',
        x   : 'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw',
        kid : 'FtIu-VbGrfe_KB6CH7GNwODB72MNxj_ml11dEvO-7kk'
      };

      await expect(
        X25519.getPublicKey({ key: ed25519PrivateKey })
      ).rejects.toThrow('key is not an X25519 private JWK');
    });

    it('throws an error when provided an secp256k1 private key', async () => {
      const secp256k1PrivateKey: Jwk = {
        kty : 'EC',
        crv : 'secp256k1',
        x   : 'N1KVEnQCMpbIp0sP_kL4L_S01LukMmR3QicD92H1klg',
        y   : 'wmp0ZbmnesDD8c7bE5xCiwsfu1UWhntSdjbzKG9wVVM',
        kid : 'iwwOeCqgvREo5xGeBS-obWW9ZGjv0o1M65gUYN6SYh4'
      };

      await expect(
        X25519.getPublicKey({ key: secp256k1PrivateKey })
      ).rejects.toThrow('key is not an X25519 private JWK');
    });
  });

  describe('privateKeyToBytes()', () => {
    it('returns a private key as a byte array', async () => {
      const privateKey: Jwk = {
        kty : 'OKP',
        crv : 'X25519',
        d   : 'jxSSX_aM49m6E4MaSd-hcizIM33rXzLltuev9oBw1V8',
        x   : 'U2kX2FckTAoTAjMBUadwOpftdXk-Kx8pZMeyG3QZsy8',
        kid : 'PPgSyqA-j9sc9vmsvpSCpy2uLg_CUfGoKHhPzQ5Gkog'
      };
      const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey });

      expect(privateKeyBytes).toBeInstanceOf(Uint8Array);
      const expectedOutput = Convert.hex('8f14925ff68ce3d9ba13831a49dfa1722cc8337deb5f32e5b6e7aff68070d55f').toUint8Array();
      expect(privateKeyBytes).toEqual(expectedOutput);
    });

    it('throws an error when provided an X25519 public key', async () => {
      const publicKey: Jwk = {
        kty : 'OKP',
        crv : 'X25519',
        x   : 'U2kX2FckTAoTAjMBUadwOpftdXk-Kx8pZMeyG3QZsy8',
        kid : 'PPgSyqA-j9sc9vmsvpSCpy2uLg_CUfGoKHhPzQ5Gkog'
      };

      await expect(
        X25519.privateKeyToBytes({ privateKey: publicKey })
      ).rejects.toThrow('provided key is not a valid OKP private key');
    });

    for (const vector of x25519PrivateKeyToBytes.vectors) {
      it(vector.description, async () => {
        const privateKeyBytes = await X25519.privateKeyToBytes({
          privateKey: vector.input.privateKey as Jwk
        });
        expect(privateKeyBytes).toEqual(Convert.hex(vector.output).toUint8Array());
      });
    }
  });

  describe('publicKeyToBytes()', () => {
    it('returns a public key in JWK format', async () => {
      const publicKey: Jwk = {
        kty : 'OKP',
        crv : 'X25519',
        x   : 'U2kX2FckTAoTAjMBUadwOpftdXk-Kx8pZMeyG3QZsy8',
        kid : 'PPgSyqA-j9sc9vmsvpSCpy2uLg_CUfGoKHhPzQ5Gkog'
      };

      const publicKeyBytes = await X25519.publicKeyToBytes({ publicKey });

      expect(publicKeyBytes).toBeInstanceOf(Uint8Array);
      const expectedOutput = Convert.hex('536917d857244c0a1302330151a7703a97ed75793e2b1f2964c7b21b7419b32f').toUint8Array();
      expect(publicKeyBytes).toEqual(expectedOutput);
    });

    it('throws an error when provided an X25519 private key', async () => {
      const privateKey: Jwk = {
        kty : 'OKP',
        crv : 'X25519',
        d   : 'jxSSX_aM49m6E4MaSd-hcizIM33rXzLltuev9oBw1V8',
        x   : 'U2kX2FckTAoTAjMBUadwOpftdXk-Kx8pZMeyG3QZsy8',
        kid : 'PPgSyqA-j9sc9vmsvpSCpy2uLg_CUfGoKHhPzQ5Gkog'
      };

      await expect(
        X25519.publicKeyToBytes({ publicKey: privateKey })
      ).rejects.toThrow('provided key is not a valid OKP public key');
    });

    for (const vector of x25519PublicKeyToBytes.vectors) {
      it(vector.description, async () => {
        const publicKeyBytes = await X25519.publicKeyToBytes({
          publicKey: vector.input.publicKey as Jwk
        });
        expect(publicKeyBytes).toEqual(Convert.hex(vector.output).toUint8Array());
      });
    }
  });

  describe('sharedSecret()', () => {
    let ownPrivateKey: Jwk;
    let ownPublicKey: Jwk;
    let otherPartyPrivateKey: Jwk;
    let otherPartyPublicKey: Jwk;

    beforeAll(async () => {
      ownPrivateKey = privateKey;
      ownPublicKey = publicKey;
      otherPartyPrivateKey = await X25519.generateKey();
      otherPartyPublicKey = await X25519.computePublicKey({ key: otherPartyPrivateKey });
    });

    it('generates a 32-byte compressed secret', async () => {
      const sharedSecret = await X25519.sharedSecret({
        privateKeyA : ownPrivateKey,
        publicKeyB  : otherPartyPublicKey
      });
      expect(sharedSecret).toBeInstanceOf(Uint8Array);
      expect(sharedSecret.byteLength).toBe(32);
    });

    it('is commutative', async () => {
      const sharedSecretOwnOther = await X25519.sharedSecret({
        privateKeyA : ownPrivateKey,
        publicKeyB  : otherPartyPublicKey
      });

      const sharedSecretOtherOwn = await X25519.sharedSecret({
        privateKeyA : otherPartyPrivateKey,
        publicKeyB  : ownPublicKey
      });

      expect(sharedSecretOwnOther).toEqual(sharedSecretOtherOwn);
    });

    it('throws an error if the public/private keys from the same key pair are specified', async () => {
      await expect(
        X25519.sharedSecret({
          privateKeyA : ownPrivateKey,
          publicKeyB  : ownPublicKey
        })
      ).rejects.toThrow('shared secret cannot be computed from a single key pair');
    });
  });
});
