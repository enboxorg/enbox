import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { AgentCryptoApi } from '../../../../src/crypto-api.js';
import { JweKeyManagement } from '../../../../src/prototyping/crypto/jose/jwe.js';

describe('JweKeyManagement', () => {
  const crypto = new AgentCryptoApi();

  describe('decrypt', () => {
    describe('dir algorithm', () => {
      it('should throw when encrypted_key is provided with dir algorithm', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : { kty: 'oct', k: 'test' },
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'dir', enc: 'A256GCM' },
            crypto,
          })
        ).rejects.toThrow('encrypted_key');
      });

      it('should throw when key is Uint8Array with dir algorithm', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'dir', enc: 'A256GCM' },
            crypto,
          })
        ).rejects.toThrow('must be a Key URI or JWK');
      });

      it('should return the key directly for dir algorithm', async () => {
        const key = { kty: 'oct', k: 'test-key', alg: 'A256GCM' };
        const result = await JweKeyManagement.decrypt({
          key,
          joseHeader: { alg: 'dir', enc: 'A256GCM' },
          crypto,
        });
        expect(result).toBe(key);
      });
    });

    describe('PBES2 algorithm', () => {
      it('should throw when p2c is missing', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM' } as any,
            crypto,
          })
        ).rejects.toThrow('PBES2 Count');
      });

      it('should throw when p2c is below minimum', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 500, p2s: 'c29tZXNhbHQ' },
            crypto,
          })
        ).rejects.toThrow('below the minimum');
      });

      it('should throw when p2s is missing', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000 } as any,
            crypto,
          })
        ).rejects.toThrow('PBES2 salt');
      });

      it('should throw when key is not Uint8Array', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : { kty: 'oct', k: 'test' },
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: 'c29tZXNhbHQ' },
            crypto,
          })
        ).rejects.toThrow('must be a Uint8Array');
      });

      it('should throw when encrypted_key is missing', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: 'c29tZXNhbHQ' },
            crypto,
          })
        ).rejects.toThrow('encrypted_key');
      });

      it('should throw when p2s is not valid base64url', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key          : new Uint8Array(32),
            encryptedKey : new Uint8Array(32),
            joseHeader   : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: '!@#$%^&*()' },
            crypto,
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
          crypto,
        });

        expect(encResult.encryptedKey).toBeDefined();
        expect(encResult.cek).toBeDefined();

        // Now decrypt it.
        const decResult = await JweKeyManagement.decrypt({
          key          : passphrase,
          encryptedKey : encResult.encryptedKey!,
          joseHeader   : { alg: 'PBES2-HS512+A256KW', enc: 'A256GCM', p2c: 1, p2s },
          crypto,
        }, { minP2cCount: 1 });

        expect(decResult).toBeDefined();
      });
    });

    describe('unsupported algorithm', () => {
      it('should throw for unsupported algorithm', async () => {
        await expect(
          JweKeyManagement.decrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'RSA-OAEP', enc: 'A256GCM' },
            crypto,
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
          crypto,
        });
        expect(result.cek).toBe(key);
        expect(result.encryptedKey).toBeUndefined();
      });

      it('should throw when key is Uint8Array', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'dir', enc: 'A256GCM' },
            crypto,
          })
        ).rejects.toThrow('must be a Key URI or JWK');
      });
    });

    describe('PBES2 algorithm', () => {
      it('should throw when p2c is missing', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM' } as any,
            crypto,
          })
        ).rejects.toThrow('PBES2 Count');
      });

      it('should throw when p2s is missing', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000 } as any,
            crypto,
          })
        ).rejects.toThrow('PBES2 salt');
      });

      it('should throw when key is not Uint8Array', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : { kty: 'oct', k: 'test' },
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: 'c29tZXNhbHQ' },
            crypto,
          })
        ).rejects.toThrow('must be a Uint8Array');
      });

      it('should throw when p2s is not valid base64url', async () => {
        await expect(
          JweKeyManagement.encrypt({
            key        : new Uint8Array(32),
            joseHeader : { alg: 'PBES2-HS256+A128KW', enc: 'A128GCM', p2c: 1000, p2s: '!@#$%^&*()' },
            crypto,
          })
        ).rejects.toThrow();
      });

      it('should encrypt a key with PBES2', async () => {
        const passphrase = new TextEncoder().encode('test-password');
        const p2s = Convert.uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(16))).toBase64Url();

        const result = await JweKeyManagement.encrypt({
          key        : passphrase,
          joseHeader : { alg: 'PBES2-HS512+A256KW', enc: 'A256GCM', p2c: 1, p2s },
          crypto,
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
            crypto,
          })
        ).rejects.toThrow('Unsupported');
      });
    });
  });
});
