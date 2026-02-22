import type { Jwk } from '../../src/jose/jwk.js';

import { Convert } from '@enbox/common';
import { describe, expect, it } from 'bun:test';

import { CoseAlgorithm, CoseEllipticCurve, CoseKey, CoseKeyType } from '../../src/cose/cose-key.js';

describe('CoseKey', () => {
  // Test keys.
  const ed25519Jwk: Jwk = {
    kty : 'OKP',
    crv : 'Ed25519',
    x   : '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    d   : 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A',
    alg : 'EdDSA',
    kid : 'test-ed25519',
  };

  const p256Jwk: Jwk = {
    kty : 'EC',
    crv : 'P-256',
    x   : 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    y   : 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    d   : 'jpsQnnGQmL-YBIffS1BSyVKhrlmbvbzU_HP5_DW29TQ',
    alg : 'ES256',
    kid : 'test-p256',
  };

  const x25519Jwk: Jwk = {
    kty : 'OKP',
    crv : 'X25519',
    x   : '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  };

  describe('fromJwk()', () => {
    it('should convert an Ed25519 JWK to a COSE key Map', () => {
      const coseKey = CoseKey.fromJwk(ed25519Jwk);

      expect(coseKey).toBeInstanceOf(Map);
      expect(coseKey.get(1)).toBe(CoseKeyType.OKP); // kty
      expect(coseKey.get(-1)).toBe(CoseEllipticCurve.Ed25519); // crv
      expect(coseKey.get(-2)).toBeInstanceOf(Uint8Array); // x
      expect(coseKey.get(-4)).toBeInstanceOf(Uint8Array); // d
      expect(coseKey.get(2)).toBeInstanceOf(Uint8Array); // kid
      expect(coseKey.get(3)).toBe(CoseAlgorithm.EdDSA); // alg
    });

    it('should convert a P-256 JWK to a COSE key Map', () => {
      const coseKey = CoseKey.fromJwk(p256Jwk);

      expect(coseKey).toBeInstanceOf(Map);
      expect(coseKey.get(1)).toBe(CoseKeyType.EC2);
      expect(coseKey.get(-1)).toBe(CoseEllipticCurve.P256);
      expect(coseKey.get(-2)).toBeInstanceOf(Uint8Array); // x
      expect(coseKey.get(-3)).toBeInstanceOf(Uint8Array); // y
      expect(coseKey.get(-4)).toBeInstanceOf(Uint8Array); // d
      expect(coseKey.get(3)).toBe(CoseAlgorithm.ES256);
    });

    it('should convert a public-only OKP JWK (no d)', () => {
      const publicOnlyJwk: Jwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      };

      const coseKey = CoseKey.fromJwk(publicOnlyJwk);
      expect(coseKey.get(-2)).toBeInstanceOf(Uint8Array); // x
      expect(coseKey.has(-4)).toBe(false); // no d
    });

    it('should convert an X25519 JWK', () => {
      const coseKey = CoseKey.fromJwk(x25519Jwk);

      expect(coseKey.get(1)).toBe(CoseKeyType.OKP);
      expect(coseKey.get(-1)).toBe(CoseEllipticCurve.X25519);
    });

    it('should throw for unsupported key type', () => {
      const unsupported: Jwk = { kty: 'oct' } as Jwk;
      expect(() => CoseKey.fromJwk(unsupported)).toThrow('unsupported key type');
    });

    it('should throw for OKP with unsupported curve', () => {
      const badCrv: Jwk = { kty: 'OKP', crv: 'FancyCurve' } as Jwk;
      expect(() => CoseKey.fromJwk(badCrv)).toThrow('unsupported OKP curve');
    });

    it('should throw for EC with unsupported curve', () => {
      const badCrv: Jwk = { kty: 'EC', crv: 'FancyCurve' } as Jwk;
      expect(() => CoseKey.fromJwk(badCrv)).toThrow('unsupported EC curve');
    });

    it('should omit kid and alg when not present in JWK', () => {
      const minimalJwk: Jwk = {
        kty : 'OKP',
        crv : 'Ed25519',
        x   : '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      };
      const coseKey = CoseKey.fromJwk(minimalJwk);
      expect(coseKey.has(2)).toBe(false); // kid
      expect(coseKey.has(3)).toBe(false); // alg
    });
  });

  describe('toJwk()', () => {
    it('should round-trip an Ed25519 JWK through COSE', () => {
      const coseKey = CoseKey.fromJwk(ed25519Jwk);
      const roundTripped = CoseKey.toJwk(coseKey);

      expect(roundTripped.kty).toBe('OKP');
      expect(roundTripped.crv).toBe('Ed25519');
      expect(roundTripped.x).toBe(ed25519Jwk.x);
      expect(roundTripped.d).toBe(ed25519Jwk.d);
      expect(roundTripped.alg).toBe('EdDSA');
      expect(roundTripped.kid).toBe(ed25519Jwk.kid);
    });

    it('should round-trip a P-256 JWK through COSE', () => {
      const coseKey = CoseKey.fromJwk(p256Jwk);
      const roundTripped = CoseKey.toJwk(coseKey);

      expect(roundTripped.kty).toBe('EC');
      expect(roundTripped.crv).toBe('P-256');
      expect(roundTripped.x).toBe(p256Jwk.x);
      expect(roundTripped.y).toBe(p256Jwk.y);
      expect(roundTripped.d).toBe(p256Jwk.d);
      expect(roundTripped.alg).toBe('ES256');
    });

    it('should convert an OKP COSE key without d to a public-only JWK', () => {
      const coseKey = new Map<number, unknown>([
        [1, CoseKeyType.OKP],
        [-1, CoseEllipticCurve.Ed25519],
        [-2, Convert.base64Url('11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo').toUint8Array()],
      ]);
      const jwk = CoseKey.toJwk(coseKey);
      expect(jwk.kty).toBe('OKP');
      expect(jwk.crv).toBe('Ed25519');
      expect(jwk.x).toBeDefined();
      expect(jwk.d).toBeUndefined();
    });

    it('should throw for unsupported COSE key type', () => {
      const badKey = new Map<number, unknown>([[1, 99]]);
      expect(() => CoseKey.toJwk(badKey)).toThrow('unsupported COSE key type');
    });

    it('should throw for unsupported COSE OKP curve', () => {
      const badKey = new Map<number, unknown>([
        [1, CoseKeyType.OKP],
        [-1, 99],
      ]);
      expect(() => CoseKey.toJwk(badKey)).toThrow('unsupported COSE OKP curve');
    });

    it('should throw for unsupported COSE EC2 curve', () => {
      const badKey = new Map<number, unknown>([
        [1, CoseKeyType.EC2],
        [-1, 99],
      ]);
      expect(() => CoseKey.toJwk(badKey)).toThrow('unsupported COSE EC2 curve');
    });
  });

  describe('algorithmFromJwk()', () => {
    it('should return EdDSA for an Ed25519 JWK with alg set', () => {
      expect(CoseKey.algorithmFromJwk(ed25519Jwk)).toBe(CoseAlgorithm.EdDSA);
    });

    it('should return ES256 for a P-256 JWK with alg set', () => {
      expect(CoseKey.algorithmFromJwk(p256Jwk)).toBe(CoseAlgorithm.ES256);
    });

    it('should infer EdDSA from an Ed25519 JWK without alg', () => {
      const jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', x: 'abc' };
      expect(CoseKey.algorithmFromJwk(jwk)).toBe(CoseAlgorithm.EdDSA);
    });

    it('should infer ES256 from a P-256 JWK without alg', () => {
      const jwk: Jwk = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
      expect(CoseKey.algorithmFromJwk(jwk)).toBe(CoseAlgorithm.ES256);
    });

    it('should infer ES384 from a P-384 JWK without alg', () => {
      const jwk: Jwk = { kty: 'EC', crv: 'P-384', x: 'abc', y: 'def' };
      expect(CoseKey.algorithmFromJwk(jwk)).toBe(CoseAlgorithm.ES384);
    });

    it('should infer ES256K from a secp256k1 JWK without alg', () => {
      const jwk: Jwk = { kty: 'EC', crv: 'secp256k1', x: 'abc', y: 'def' };
      expect(CoseKey.algorithmFromJwk(jwk)).toBe(CoseAlgorithm.ES256K);
    });

    it('should throw for a JWK with unknown key type and no alg', () => {
      const jwk: Jwk = { kty: 'oct' } as Jwk;
      expect(() => CoseKey.algorithmFromJwk(jwk)).toThrow('cannot determine COSE algorithm');
    });

    it('should throw for X25519 (not a signing curve)', () => {
      expect(() => CoseKey.algorithmFromJwk(x25519Jwk)).toThrow('cannot determine COSE algorithm');
    });
  });

  describe('algorithmToJwk()', () => {
    it('should map EdDSA to "EdDSA"', () => {
      expect(CoseKey.algorithmToJwk(CoseAlgorithm.EdDSA)).toBe('EdDSA');
    });

    it('should map ES256 to "ES256"', () => {
      expect(CoseKey.algorithmToJwk(CoseAlgorithm.ES256)).toBe('ES256');
    });

    it('should map ES384 to "ES384"', () => {
      expect(CoseKey.algorithmToJwk(CoseAlgorithm.ES384)).toBe('ES384');
    });

    it('should throw for unsupported algorithm', () => {
      expect(() => CoseKey.algorithmToJwk(999 as CoseAlgorithm)).toThrow('unsupported COSE algorithm');
    });
  });
});
