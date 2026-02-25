import type { Jwk } from '../../src/jose/jwk.js';

import { beforeAll, describe, expect, it } from 'bun:test';

import { Cbor } from '../../src/cose/cbor.js';
import { CoseAlgorithm } from '../../src/cose/cose-key.js';
import { CoseSign1 } from '../../src/cose/cose-sign1.js';
import { Ed25519 } from '../../src/primitives/ed25519.js';
import { Eat, EatClaimKey, EatDebugStatus } from '../../src/cose/eat.js';

describe('Eat', () => {
  let privateKey: Jwk;
  let publicKey: Jwk;

  beforeAll(async () => {
    privateKey = await Ed25519.generateKey();
    publicKey = await Ed25519.computePublicKey({ key: privateKey });
  });

  /**
   * Helper: creates a COSE_Sign1-wrapped EAT token from a claims map.
   */
  async function createEatToken(
    claims: Map<number, unknown>,
    signingKey: Jwk = privateKey,
  ): Promise<Uint8Array> {
    const payload = Cbor.encode(claims);
    return CoseSign1.create({
      key             : signingKey,
      payload,
      protectedHeader : { alg: CoseAlgorithm.EdDSA },
    });
  }

  describe('decode()', () => {
    it('should decode an EAT token with standard CWT claims', async () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = new Map<number, unknown>([
        [EatClaimKey.Iss, 'https://attestation.example.com'],
        [EatClaimKey.Sub, 'compute-module-001'],
        [EatClaimKey.Iat, now],
        [EatClaimKey.Exp, now + 3600],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.iss).toBe('https://attestation.example.com');
      expect(result.claims.sub).toBe('compute-module-001');
      expect(result.claims.iat).toBe(now);
      expect(result.claims.exp).toBe(now + 3600);
      expect(result.protectedHeader.alg).toBe(CoseAlgorithm.EdDSA);
    });

    it('should decode an EAT token with attestation-specific claims', async () => {
      const nonce = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      const ueid = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
      const hwmodel = new Uint8Array([0x41, 0x52, 0x4D]); // "ARM" in ASCII bytes

      const claims = new Map<number, unknown>([
        [EatClaimKey.Nonce, nonce],
        [EatClaimKey.Ueid, ueid],
        [EatClaimKey.Hwmodel, hwmodel],
        [EatClaimKey.Dbgstat, EatDebugStatus.DisabledPermanently],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.nonce).toEqual(nonce);
      expect(result.claims.ueid).toEqual(ueid);
      expect(result.claims.hwmodel).toEqual(hwmodel);
      expect(result.claims.dbgstat).toBe(EatDebugStatus.DisabledPermanently);
    });

    it('should provide raw claims map for non-standard claims', async () => {
      const customClaimKey = 9999;
      const claims = new Map<number, unknown>([
        [EatClaimKey.Iss, 'test-issuer'],
        [customClaimKey, 'custom-value'],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.rawClaims.get(customClaimKey)).toBe('custom-value');
    });

    it('should decode submods claim', async () => {
      const submods = new Map<string, unknown>([
        ['platform', new Map<number, unknown>([
          [EatClaimKey.Iss, 'platform-issuer'],
        ])],
      ]);

      const claims = new Map<number, unknown>([
        [EatClaimKey.Submods, submods],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.submods).toBeDefined();
    });

    it('should decode a token with nonce array', async () => {
      const nonces = [
        new Uint8Array([0x01, 0x02]),
        new Uint8Array([0x03, 0x04]),
      ];
      const claims = new Map<number, unknown>([
        [EatClaimKey.Nonce, nonces],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.nonce).toEqual(nonces);
    });

    it('should throw for a token with detached payload', async () => {
      const claims = new Map<number, unknown>([
        [EatClaimKey.Iss, 'test'],
      ]);
      const payload = Cbor.encode(claims);
      const token = await CoseSign1.create({
        key             : privateKey,
        payload,
        detachedPayload : true,
      });

      expect(() => Eat.decode({ token })).toThrow('detached payload');
    });

    it('should throw for a token with non-map payload', async () => {
      // Create a COSE_Sign1 with a string payload instead of a CBOR map.
      const payload = Cbor.encode('not a map');
      const token = await CoseSign1.create({
        key: privateKey,
        payload,
      });

      expect(() => Eat.decode({ token })).toThrow('not a valid CBOR map');
    });

    it('should decode an EAT token with aud claim', async () => {
      const claims = new Map<number, unknown>([
        [EatClaimKey.Aud, 'https://verifier.example.com'],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.aud).toBe('https://verifier.example.com');
    });

    it('should decode an EAT token with nbf claim', async () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = new Map<number, unknown>([
        [EatClaimKey.Nbf, now - 60],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.nbf).toBe(now - 60);
    });

    it('should decode an EAT token with cti claim', async () => {
      const tokenId = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
      const claims = new Map<number, unknown>([
        [EatClaimKey.Cti, tokenId],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.cti).toEqual(tokenId);
    });

    it('should decode an EAT token with hwversion claim', async () => {
      const claims = new Map<number, unknown>([
        [EatClaimKey.Hwversion, [1, 0, 2]],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.hwversion).toEqual([1, 0, 2]);
    });

    // NOTE: The original version of this test only asserted `toBeDefined()` on the
    // decoded measres claim, which would pass even if the value was garbage. Rewritten
    // to verify the CBOR map round-trips correctly: checks instance type, entry count,
    // and individual key/value pairs.
    it('should decode an EAT token with measres claim and preserve its structure', async () => {
      const measurementResults = new Map<number, unknown>([
        [1, new Uint8Array([0x01, 0x02])],
        [2, 'sha-256'],
      ]);
      const claims = new Map<number, unknown>([
        [EatClaimKey.Measres, measurementResults],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      // measres is a CBOR map — after round-trip it should be a Map with the same keys.
      expect(result.claims.measres).toBeInstanceOf(Map);
      const decoded = result.claims.measres as Map<number, unknown>;
      expect(decoded.size).toBe(2);
      expect(decoded.has(1)).toBe(true);
      expect(decoded.get(2)).toBe('sha-256');
    });

    it('should decode an EAT token with all untested claims together', async () => {
      const now = Math.floor(Date.now() / 1000);
      const tokenId = new Uint8Array([0x01, 0x02, 0x03]);
      const claims = new Map<number, unknown>([
        [EatClaimKey.Aud, 'audience-value'],
        [EatClaimKey.Nbf, now],
        [EatClaimKey.Cti, tokenId],
        [EatClaimKey.Hwversion, '2.0.0'],
        [EatClaimKey.Measres, [1, 2, 3]],
      ]);

      const token = await createEatToken(claims);
      const result = Eat.decode({ token });

      expect(result.claims.aud).toBe('audience-value');
      expect(result.claims.nbf).toBe(now);
      expect(result.claims.cti).toEqual(tokenId);
      expect(result.claims.hwversion).toBe('2.0.0');
      expect(result.claims.measres).toEqual([1, 2, 3]);
    });
  });

  describe('verifyAndDecode()', () => {
    it('should verify and decode a valid EAT token', async () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = new Map<number, unknown>([
        [EatClaimKey.Iss, 'https://attestation.example.com'],
        [EatClaimKey.Iat, now],
        [EatClaimKey.Nonce, new Uint8Array([0xCA, 0xFE])],
      ]);

      const token = await createEatToken(claims);
      const result = await Eat.verifyAndDecode({ token, key: publicKey });

      expect(result.claims.iss).toBe('https://attestation.example.com');
      expect(result.claims.iat).toBe(now);
      expect(result.claims.nonce).toEqual(new Uint8Array([0xCA, 0xFE]));
    });

    it('should throw when signature verification fails', async () => {
      const claims = new Map<number, unknown>([
        [EatClaimKey.Iss, 'test'],
      ]);

      const token = await createEatToken(claims);

      // Verify with a different key.
      const otherKey = await Ed25519.generateKey();
      const otherPublicKey = await Ed25519.computePublicKey({ key: otherKey });

      await expect(
        Eat.verifyAndDecode({ token, key: otherPublicKey })
      ).rejects.toThrow('signature verification failed');
    });

    it('should verify with external AAD when provided', async () => {
      const externalAad = new TextEncoder().encode('request-binding-data');
      const claims = new Map<number, unknown>([
        [EatClaimKey.Iss, 'test'],
      ]);
      const payload = Cbor.encode(claims);

      const token = await CoseSign1.create({
        key: privateKey,
        payload,
        externalAad,
      });

      // Verification with matching AAD should succeed.
      const result = await Eat.verifyAndDecode({
        token,
        key: publicKey,
        externalAad,
      });
      expect(result.claims.iss).toBe('test');

      // Verification without AAD should fail.
      await expect(
        Eat.verifyAndDecode({ token, key: publicKey })
      ).rejects.toThrow('signature verification failed');
    });
  });

  describe('claim key enums', () => {
    it('should have correct CWT claim key values', () => {
      expect(EatClaimKey.Iss).toBe(1);
      expect(EatClaimKey.Sub).toBe(2);
      expect(EatClaimKey.Aud).toBe(3);
      expect(EatClaimKey.Exp).toBe(4);
      expect(EatClaimKey.Nbf).toBe(5);
      expect(EatClaimKey.Iat).toBe(6);
      expect(EatClaimKey.Cti).toBe(7);
    });

    it('should have correct EAT-specific claim key values', () => {
      expect(EatClaimKey.Nonce).toBe(10);
      expect(EatClaimKey.Ueid).toBe(256);
      expect(EatClaimKey.Hwmodel).toBe(259);
      expect(EatClaimKey.Dbgstat).toBe(263);
      expect(EatClaimKey.Submods).toBe(266);
    });
  });

  describe('debug status enum', () => {
    it('should have correct debug status values', () => {
      expect(EatDebugStatus.Enabled).toBe(0);
      expect(EatDebugStatus.Disabled).toBe(1);
      expect(EatDebugStatus.DisabledSinceBoot).toBe(2);
      expect(EatDebugStatus.DisabledPermanently).toBe(3);
      expect(EatDebugStatus.DisabledFullyAndPermanently).toBe(4);
    });
  });
});
