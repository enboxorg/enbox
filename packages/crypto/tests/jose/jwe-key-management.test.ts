import type { Jwk } from '../../src/jose/jwk.js';

import { Convert } from '@enbox/common';
import sinon from 'sinon';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { JweKeyManagement } from '../../src/jose/jwe/key-management.js';
import { X25519 } from '../../src/primitives/x25519.js';

describe('JweKeyManagement', () => {
  let recipientPrivateKey: Jwk;
  let recipientPublicKey: Jwk;

  beforeAll(async () => {
    recipientPrivateKey = await X25519.generateKey();
    recipientPublicKey = await X25519.getPublicKey({ key: recipientPrivateKey });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('decrypt', () => {
    describe('dir algorithm', () => {
      it('should throw when encrypted_key is provided with dir algorithm', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : { kty: 'oct', k: 'test' },
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'dir', enc: 'A256GCM' },
          })
        ).rejects.toThrow('encrypted_key');
      });

      it('should throw when key is Uint8Array with dir algorithm', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'dir', enc: 'A256GCM' },
          })
        ).rejects.toThrow('must be a Key URI or JWK');
      });

      it('should throw when key is an ECDH-ES input with dir algorithm', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
            joseHeader : { alg: 'dir', enc: 'A256GCM' },
          })
        ).rejects.toThrow('must be a Key URI or JWK');
      });

      it('should return the key directly for dir algorithm', async () => {
        const key = { kty: 'oct', k: 'test-key', alg: 'A256GCM' };
        const result = await JweKeyManagement.decrypt({
          key,
          joseHeader: { alg: 'dir', enc: 'A256GCM' },
        });
        expect(result).toBe(key);
      });
    });

    describe('ECDH-ES algorithm', () => {
      it('should throw when encrypted_key is provided', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'ECDH-ES', enc: 'XC20P' },
          })
        ).rejects.toThrow('encrypted_key');
      });

      it('should throw when key is not an ECDH-ES input', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
          })
        ).rejects.toThrow('"mode": "ecdh-es"');
      });

      it('should throw when the private key is not on the X25519 curve', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : { mode: 'ecdh-es', privateKey: { kty: 'OKP', crv: 'Ed25519', d: 'test', x: 'test' } },
            joseHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
          })
        ).rejects.toThrow('Unsupported ECDH-ES private key curve');
      });

      it('should throw when the epk header parameter is missing', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
            joseHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
          })
        ).rejects.toThrow('"epk"');
      });

      it('should throw when the epk is not on the X25519 curve', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
            joseHeader : { alg: 'ECDH-ES', enc: 'XC20P', epk: { kty: 'OKP', crv: 'Ed25519', x: 'test' } },
          })
        ).rejects.toThrow('Unsupported JOSE Header "epk"');
      });

      it('should throw when the shared secret is all zeros', async () => {
        const ephemeralPrivateKey = await X25519.generateKey();
        sinon.stub(X25519, 'sharedSecret').resolves(new Uint8Array(32));

        await expect(
          JweKeyManagement.decrypt({
            key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
            joseHeader : {
              alg : 'ECDH-ES',
              enc : 'XC20P',
              epk : { kty: 'OKP', crv: 'X25519', x: ephemeralPrivateKey.x },
            },
          })
        ).rejects.toThrow('must not be all zeros');
      });

      it('should derive the same CEK on encrypt and decrypt', async () => {
        const joseHeader = { alg: 'ECDH-ES', enc: 'XC20P' } as const;

        const { cek: encryptCek, encryptedKey, headerParams } = await JweKeyManagement.encrypt({
          key: { mode: 'ecdh-es', peerPublicKey: recipientPublicKey },
          joseHeader,
        });

        expect(encryptedKey).toBeUndefined();
        expect(headerParams?.epk).toBeDefined();

        const decryptCek = await JweKeyManagement.decrypt({
          key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
          joseHeader : { ...joseHeader, ...headerParams },
        });

        expect((decryptCek as Jwk).k).toBe((encryptCek as Jwk).k);
      });

      it('should derive matching CEKs with a PIN and different CEKs with the wrong PIN', async () => {
        const joseHeader = { alg: 'ECDH-ES', enc: 'XC20P' } as const;

        const { cek: encryptCek, headerParams } = await JweKeyManagement.encrypt({
          key: { mode: 'ecdh-es', peerPublicKey: recipientPublicKey, pin: '123456' },
          joseHeader,
        });

        const correctPinCek = await JweKeyManagement.decrypt({
          key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey, pin: '123456' },
          joseHeader : { ...joseHeader, ...headerParams },
        });
        expect((correctPinCek as Jwk).k).toBe((encryptCek as Jwk).k);

        const wrongPinCek = await JweKeyManagement.decrypt({
          key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey, pin: '654321' },
          joseHeader : { ...joseHeader, ...headerParams },
        });
        expect((wrongPinCek as Jwk).k).not.toBe((encryptCek as Jwk).k);
      });

      it('should bind apu and apv into the derived CEK', async () => {
        const apu = Convert.string('alice').toBase64Url();
        const apv = Convert.string('bob').toBase64Url();

        const { cek: encryptCek, headerParams } = await JweKeyManagement.encrypt({
          key        : { mode: 'ecdh-es', peerPublicKey: recipientPublicKey },
          joseHeader : { alg: 'ECDH-ES', enc: 'XC20P', apu, apv },
        });

        const matchingCek = await JweKeyManagement.decrypt({
          key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
          joseHeader : { alg: 'ECDH-ES', enc: 'XC20P', apu, apv, ...headerParams },
        });
        expect((matchingCek as Jwk).k).toBe((encryptCek as Jwk).k);

        const alteredApvCek = await JweKeyManagement.decrypt({
          key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
          joseHeader : { alg: 'ECDH-ES', enc: 'XC20P', apu, apv: Convert.string('mallory').toBase64Url(), ...headerParams },
        });
        expect((alteredApvCek as Jwk).k).not.toBe((encryptCek as Jwk).k);
      });

      it('should throw when apu or apv is not valid base64url', async () => {
        const ephemeralPrivateKey = await X25519.generateKey();

        await expect(
          JweKeyManagement.decrypt({
            key        : { mode: 'ecdh-es', privateKey: recipientPrivateKey },
            joseHeader : {
              alg : 'ECDH-ES',
              enc : 'XC20P',
              apu : '!@#$%^&*()',
              epk : { kty: 'OKP', crv: 'X25519', x: ephemeralPrivateKey.x },
            },
          })
        ).rejects.toThrow('Failed to decode');
      });
    });

    describe('PBES2 algorithm', () => {
      it('should throw when p2c is missing', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM' } as any,
          })
        ).rejects.toThrow('PBES2 Count');
      });

      it('should throw when p2c is below minimum', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 500, p2s: 'c29tZXNhbHQ' },
          })
        ).rejects.toThrow('below the minimum');
      });

      it('should throw when p2s is missing', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000 } as any,
          })
        ).rejects.toThrow('PBES2 salt');
      });

      it('should throw when key is not Uint8Array', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : { kty: 'oct', k: 'test' },
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: 'c29tZXNhbHQ' },
          })
        ).rejects.toThrow('must be a Uint8Array');
      });

      it('should throw when encrypted_key is missing', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: 'c29tZXNhbHQ' },
          })
        ).rejects.toThrow('encrypted_key');
      });

      it('should throw when p2s is not valid base64url', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: '!@#$%^&*()' },
          }, { minP2cCount: 1 })
        ).rejects.toThrow();
      });

      it('should successfully decrypt a PBES2 encrypted key', async () => {
        const passphrase = new TextEncoder().encode('test-password');
        const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
        const p2s = Convert.uint8Array(saltBytes).toBase64Url();

        // First encrypt a key with PBES2.
        const encResult = await JweKeyManagement.encrypt({
          key        : passphrase,
          joseHeader : { alg: 'PBES2-HS512+A256KW', enc: 'A256GCM', p2c: 1, p2s },
        });

        expect(encResult.encryptedKey).toBeDefined();
        expect(encResult.cek).toBeDefined();

        // Now decrypt it.
        const decResult = await JweKeyManagement.decrypt({
          key          : passphrase,
          encryptedKey : encResult.encryptedKey!,
          joseHeader   : { alg: 'PBES2-HS512+A256KW', enc: 'A256GCM', p2c: 1, p2s },
        }, { minP2cCount: 1 });

        expect(decResult).toBeDefined();
        expect((decResult as Jwk).k).toBe((encResult.cek as Jwk).k);
      });
    });

    describe('unsupported algorithm', () => {
      it('should throw for unsupported algorithm', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'RSA-OAEP', enc: 'A256GCM' },
          })
        ).rejects.toThrow('Unsupported');
      });
    });
  });

  describe('encrypt', () => {
    describe('dir algorithm', () => {
      it('should return the key as CEK with no encrypted key', async () => {
        const key = { kty: 'oct', k: 'test-key', alg: 'A256GCM' };
        const result = await JweKeyManagement.encrypt({
          key,
          joseHeader: { alg: 'dir', enc: 'A256GCM' },
        });
        expect(result.cek).toBe(key);
        expect(result.encryptedKey).toBeUndefined();
      });

      it('should throw when key is Uint8Array', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'dir', enc: 'A256GCM' },
          })
        ).rejects.toThrow('must be a Key URI or JWK');
      });
    });

    describe('ECDH-ES algorithm', () => {
      it('should throw when key is not an ECDH-ES input', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
          })
        ).rejects.toThrow('"mode": "ecdh-es"');
      });

      it('should throw when the peer public key is not on the X25519 curve', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : { mode: 'ecdh-es', peerPublicKey: { kty: 'OKP', crv: 'Ed25519', x: 'test' } },
            joseHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
          })
        ).rejects.toThrow('Unsupported ECDH-ES peer public key');
      });

      it('should generate a fresh ephemeral key pair on every encrypt', async () => {
        const joseHeader = { alg: 'ECDH-ES', enc: 'XC20P' } as const;
        const key = { mode: 'ecdh-es', peerPublicKey: recipientPublicKey } as const;

        const first = await JweKeyManagement.encrypt({ key, joseHeader });
        const second = await JweKeyManagement.encrypt({ key, joseHeader });

        expect(first.headerParams?.epk?.x).toBeDefined();
        expect(first.headerParams?.epk?.x).not.toBe(second.headerParams?.epk?.x);
        expect((first.cek as Jwk).k).not.toBe((second.cek as Jwk).k);
      });

      it('should return a public-only epk header parameter', async () => {
        const { headerParams } = await JweKeyManagement.encrypt({
          key        : { mode: 'ecdh-es', peerPublicKey: recipientPublicKey },
          joseHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
        });

        expect(headerParams?.epk).toEqual({
          kty : 'OKP',
          crv : 'X25519',
          x   : headerParams!.epk!.x,
        });
        expect(headerParams!.epk!.d).toBeUndefined();
      });

      it('should throw when the shared secret is all zeros', async () => {
        sinon.stub(X25519, 'sharedSecret').resolves(new Uint8Array(32));

        await expect(
          JweKeyManagement.encrypt({
            key        : { mode: 'ecdh-es', peerPublicKey: recipientPublicKey },
            joseHeader : { alg: 'ECDH-ES', enc: 'XC20P' },
          })
        ).rejects.toThrow('must not be all zeros');
      });
    });

    describe('PBES2 algorithm', () => {
      it('should throw when p2c is missing', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM' } as any,
          })
        ).rejects.toThrow('PBES2 Count');
      });

      it('should throw when p2s is missing', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000 } as any,
          })
        ).rejects.toThrow('PBES2 salt');
      });

      it('should throw when key is not Uint8Array', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : { kty: 'oct', k: 'test' },
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: 'c29tZXNhbHQ' },
          })
        ).rejects.toThrow('must be a Uint8Array');
      });

      it('should throw when p2s is not valid base64url', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: '!@#$%^&*()' },
          })
        ).rejects.toThrow();
      });

      it('should encrypt a key with PBES2', async () => {
        const passphrase = new TextEncoder().encode('test-password');
        const p2s = Convert.uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(16))).toBase64Url();

        const result = await JweKeyManagement.encrypt({
          key        : passphrase,
          joseHeader : { alg: 'PBES2-HS512+A256KW', enc: 'A256GCM', p2c: 1, p2s },
        });

        expect(result.cek).toBeDefined();
        expect(result.encryptedKey).toBeInstanceOf(Uint8Array);
      });
    });

    describe('unsupported algorithm', () => {
      it('should throw for unsupported algorithm', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'RSA-OAEP', enc: 'A256GCM' },
          })
        ).rejects.toThrow('Unsupported');
      });
    });
  });
});
