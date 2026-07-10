import type { Jwk } from '../../src/jose/jwk.js';
import type { JweAlg, JweEnc, JweHeaderParams } from '../../src/jose/jwe/header.js';
import type { JweEcdhEsDecryptKey, JweEcdhEsEncryptKey } from '../../src/jose/jwe/key-management.js';

import { Convert } from '@enbox/common';
import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import JweVectorsV2 from '../fixtures/jwe-vectors-v2.json' with { type: 'json' };

import { AesGcm } from '../../src/primitives/aes-gcm.js';
import { CompactJwe } from '../../src/jose/jwe/compact.js';
import { CryptoUtils } from '../../src/utils.js';
import { X25519 } from '../../src/primitives/x25519.js';

type JweVector = {
  id: string;
  description: string;
  protectedHeader: JweHeaderParams;
  plaintextUtf8: string;
  jweCompact: string;
  pin?: string;
  key?: Jwk;
  passphraseUtf8?: string;
  cekJwk?: Jwk;
  ivBase64Url?: string;
  nonceBase64Url?: string;
  recipientPrivateKeyJwk?: Jwk;
  recipientPublicKeyJwk?: Jwk;
  ephemeralPrivateKeyJwk?: Jwk;
};

type JweTamperCase = {
  id: string;
  description: string;
  vectorId: string;
  jweCompact: string;
  wrongPin?: string;
};

const vectors = JweVectorsV2.vectors as JweVector[];
const tamperCases = JweVectorsV2.tamperCases as JweTamperCase[];

/** Returns the vector with the given id, throwing if it is missing from the fixture. */
function getVector(id: string): JweVector {
  const vector = vectors.find((candidate): boolean => candidate.id === id);
  if (vector === undefined) { throw new Error(`Vector not found in fixture: ${id}`); }
  return vector;
}

/** Builds the encrypt-side key management input for the given vector. */
function encryptKeyFor(vector: JweVector): Jwk | Uint8Array | JweEcdhEsEncryptKey {
  if (vector.recipientPublicKeyJwk !== undefined) {
    return { mode: 'ecdh-es', peerPublicKey: vector.recipientPublicKeyJwk, pin: vector.pin };
  }
  if (vector.passphraseUtf8 !== undefined) {
    return Convert.string(vector.passphraseUtf8).toUint8Array();
  }
  return vector.key!;
}

/** Builds the decrypt-side key management input for the given vector. */
function decryptKeyFor(vector: JweVector, pinOverride?: string): Jwk | Uint8Array | JweEcdhEsDecryptKey {
  if (vector.recipientPrivateKeyJwk !== undefined) {
    return { mode: 'ecdh-es', privateKey: vector.recipientPrivateKeyJwk, pin: pinOverride ?? vector.pin };
  }
  if (vector.passphraseUtf8 !== undefined) {
    return Convert.string(vector.passphraseUtf8).toUint8Array();
  }
  return vector.key!;
}

/** Builds the decrypt allow-list options matching the vector's declared profile. */
function optionsFor(vector: JweVector): { allowedAlgs: JweAlg[]; allowedEncs: JweEnc[] } {
  return {
    allowedAlgs : [vector.protectedHeader.alg as JweAlg],
    allowedEncs : [vector.protectedHeader.enc as JweEnc],
  };
}

/**
 * Stubs all sources of randomness that the engine draws on during encryption so that the
 * produced JWE is byte-for-byte deterministic:
 * - `CryptoUtils.randomBytes` returns the vector's fixed IV / nonce.
 * - `X25519.generateKey` returns the vector's fixed ephemeral private key (ECDH-ES only).
 * - `AesGcm.generateKey` returns the vector's fixed CEK (PBES2 only).
 */
function stubDeterminism(vector: JweVector): void {
  const ivBase64Url = vector.nonceBase64Url ?? vector.ivBase64Url;
  if (ivBase64Url !== undefined) {
    const iv = Convert.base64Url(ivBase64Url).toUint8Array();
    sinon.stub(CryptoUtils, 'randomBytes').callsFake((length: number): Uint8Array => {
      expect(length).toBe(iv.length);
      return iv.slice();
    });
  }
  if (vector.ephemeralPrivateKeyJwk !== undefined) {
    sinon.stub(X25519, 'generateKey').resolves(structuredClone(vector.ephemeralPrivateKeyJwk));
  }
  if (vector.cekJwk !== undefined) {
    sinon.stub(AesGcm, 'generateKey').resolves(structuredClone(vector.cekJwk));
  }
}

describe('JWE conformance vectors (jwe-vectors-v2.json)', () => {
  afterEach(() => {
    sinon.restore();
  });

  for (const vector of vectors) {
    describe(vector.id, () => {
      it('should encrypt to the exact golden JWE with stubbed randomness', async () => {
        stubDeterminism(vector);

        const jwe = await CompactJwe.encrypt({
          plaintext       : Convert.string(vector.plaintextUtf8).toUint8Array(),
          protectedHeader : vector.protectedHeader,
          key             : encryptKeyFor(vector),
        });

        expect(jwe).toBe(vector.jweCompact);
      });

      it('should decrypt the golden JWE to the expected plaintext', async () => {
        const { plaintext, protectedHeader } = await CompactJwe.decrypt({
          jwe     : vector.jweCompact,
          key     : decryptKeyFor(vector),
          options : optionsFor(vector),
        });

        expect(Convert.uint8Array(plaintext).toString()).toBe(vector.plaintextUtf8);
        expect(protectedHeader.alg).toBe(vector.protectedHeader.alg);
        expect(protectedHeader.enc).toBe(vector.protectedHeader.enc);
      });
    });
  }

  describe('tamper cases', () => {
    for (const tamperCase of tamperCases) {
      it(`should fail to decrypt: ${tamperCase.id}`, async () => {
        const vector = getVector(tamperCase.vectorId);

        await expect(CompactJwe.decrypt({
          jwe     : tamperCase.jweCompact,
          key     : decryptKeyFor(vector, tamperCase.wrongPin),
          options : optionsFor(vector),
        })).rejects.toThrow();
      });
    }
  });

  describe('fixture integrity', () => {
    it('should include all profile vectors and tamper cases', () => {
      const vectorIds = vectors.map((vector): string => vector.id);
      expect(vectorIds).toContain('dir-xc20p');
      expect(vectorIds).toContain('ecdh-es-xc20p');
      expect(vectorIds).toContain('ecdh-es-xc20p-pin');
      expect(vectorIds).toContain('ecdh-es-xc20p-apu-apv');
      expect(vectorIds).toContain('pbes2-hs512-a256kw-a256gcm');

      const tamperIds = tamperCases.map((tamperCase): string => tamperCase.id);
      expect(tamperIds).toContain('tamper-flipped-tag-byte');
      expect(tamperIds).toContain('tamper-altered-apv');
      expect(tamperIds).toContain('tamper-wrong-pin');
    });

    it('should use a 24-byte nonce for every XC20P vector', () => {
      for (const vector of vectors.filter((candidate): boolean => candidate.protectedHeader.enc === 'XC20P')) {
        const [, , iv] = vector.jweCompact.split('.');
        expect(Convert.base64Url(iv).toUint8Array().length).toBe(24);
      }
    });

    it('should leave the encrypted_key empty for dir and ECDH-ES vectors', () => {
      for (const vector of vectors.filter((candidate): boolean => candidate.protectedHeader.alg !== 'PBES2-HS512+A256KW')) {
        const [, encryptedKey] = vector.jweCompact.split('.');
        expect(encryptedKey).toBe('');
      }
    });

    it('should carry the integrity-protected epk on every ECDH-ES vector', () => {
      for (const vector of vectors.filter((candidate): boolean => candidate.protectedHeader.alg === 'ECDH-ES')) {
        const [protectedHeader] = vector.jweCompact.split('.');
        const header = Convert.base64Url(protectedHeader).toObject() as JweHeaderParams;
        expect(header.epk).toEqual({
          kty : 'OKP',
          crv : 'X25519',
          x   : vector.ephemeralPrivateKeyJwk!.x,
        });
      }
    });
  });
});
