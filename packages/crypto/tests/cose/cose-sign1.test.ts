import type { Jwk } from '../../src/jose/jwk.js';

import { beforeAll, describe, expect, it } from 'bun:test';

import { Cbor } from '../../src/cose/cbor.js';
import { CoseAlgorithm } from '../../src/cose/cose-key.js';
import { CoseSign1 } from '../../src/cose/cose-sign1.js';
import { Ed25519 } from '../../src/primitives/ed25519.js';
import { Secp256r1 } from '../../src/primitives/secp256r1.js';

describe('CoseSign1', () => {
  let ed25519PrivateKey: Jwk;
  let ed25519PublicKey: Jwk;
  let p256PrivateKey: Jwk;
  let p256PublicKey: Jwk;

  const testPayload = new TextEncoder().encode('This is a test payload for COSE_Sign1.');

  beforeAll(async () => {
    ed25519PrivateKey = await Ed25519.generateKey();
    ed25519PublicKey = await Ed25519.computePublicKey({ key: ed25519PrivateKey });
    p256PrivateKey = await Secp256r1.generateKey();
    p256PublicKey = await Secp256r1.computePublicKey({ key: p256PrivateKey });
  });

  describe('create()', () => {
    it('should create a COSE_Sign1 message with Ed25519', async () => {
      const coseSign1 = await CoseSign1.create({
        key     : ed25519PrivateKey,
        payload : testPayload,
      });

      expect(coseSign1).toBeInstanceOf(Uint8Array);
      expect(coseSign1.length).toBeGreaterThan(0);
    });

    it('should create a COSE_Sign1 message with P-256 (ES256)', async () => {
      const coseSign1 = await CoseSign1.create({
        key     : p256PrivateKey,
        payload : testPayload,
      });

      expect(coseSign1).toBeInstanceOf(Uint8Array);
      expect(coseSign1.length).toBeGreaterThan(0);
    });

    it('should create a COSE_Sign1 message with explicit protected header', async () => {
      const coseSign1 = await CoseSign1.create({
        key             : ed25519PrivateKey,
        payload         : testPayload,
        protectedHeader : { alg: CoseAlgorithm.EdDSA },
      });

      expect(coseSign1).toBeInstanceOf(Uint8Array);
    });

    it('should create a COSE_Sign1 with detached payload', async () => {
      const coseSign1 = await CoseSign1.create({
        key             : ed25519PrivateKey,
        payload         : testPayload,
        detachedPayload : true,
      });

      // Decode and verify payload is null.
      const decoded = CoseSign1.decode(coseSign1);
      expect(decoded.payload).toBeNull();
    });

    it('should create a COSE_Sign1 with external AAD', async () => {
      const externalAad = new TextEncoder().encode('additional-data');
      const coseSign1 = await CoseSign1.create({
        key     : ed25519PrivateKey,
        payload : testPayload,
        externalAad,
      });

      expect(coseSign1).toBeInstanceOf(Uint8Array);
    });

    it('should create a COSE_Sign1 with kid in unprotected header', async () => {
      const kid = new TextEncoder().encode('my-key-id');
      const coseSign1 = await CoseSign1.create({
        key               : ed25519PrivateKey,
        payload           : testPayload,
        unprotectedHeader : { kid },
      });

      const decoded = CoseSign1.decode(coseSign1);
      expect(decoded.unprotectedHeader.get(4)).toEqual(kid);
    });
  });

  describe('verify()', () => {
    it('should verify a valid COSE_Sign1 message with Ed25519', async () => {
      const coseSign1 = await CoseSign1.create({
        key     : ed25519PrivateKey,
        payload : testPayload,
      });

      const isValid = await CoseSign1.verify({
        coseSign1,
        key: ed25519PublicKey,
      });

      expect(isValid).toBe(true);
    });

    it('should verify a valid COSE_Sign1 message with P-256 (ES256)', async () => {
      const coseSign1 = await CoseSign1.create({
        key     : p256PrivateKey,
        payload : testPayload,
      });

      const isValid = await CoseSign1.verify({
        coseSign1,
        key: p256PublicKey,
      });

      expect(isValid).toBe(true);
    });

    it('should return false for a tampered payload', async () => {
      const coseSign1 = await CoseSign1.create({
        key     : ed25519PrivateKey,
        payload : testPayload,
      });

      // Decode, tamper with payload, re-encode.
      const decoded = Cbor.decode<[Uint8Array, Map<number, unknown>, Uint8Array, Uint8Array]>(coseSign1);
      decoded[2] = new TextEncoder().encode('TAMPERED PAYLOAD');
      const tampered = Cbor.encode(decoded);

      const isValid = await CoseSign1.verify({
        coseSign1 : tampered,
        key       : ed25519PublicKey,
      });

      expect(isValid).toBe(false);
    });

    it('should return false when verified with the wrong key', async () => {
      const coseSign1 = await CoseSign1.create({
        key     : ed25519PrivateKey,
        payload : testPayload,
      });

      // Generate a different key pair.
      const otherKey = await Ed25519.generateKey();
      const otherPublicKey = await Ed25519.computePublicKey({ key: otherKey });

      const isValid = await CoseSign1.verify({
        coseSign1,
        key: otherPublicKey,
      });

      expect(isValid).toBe(false);
    });

    it('should verify a COSE_Sign1 with external AAD', async () => {
      const externalAad = new TextEncoder().encode('additional-data');

      const coseSign1 = await CoseSign1.create({
        key     : ed25519PrivateKey,
        payload : testPayload,
        externalAad,
      });

      // Verification with matching external AAD should succeed.
      const isValid = await CoseSign1.verify({
        coseSign1,
        key: ed25519PublicKey,
        externalAad,
      });
      expect(isValid).toBe(true);

      // Verification with different external AAD should fail.
      const isInvalid = await CoseSign1.verify({
        coseSign1,
        key         : ed25519PublicKey,
        externalAad : new TextEncoder().encode('wrong-data'),
      });
      expect(isInvalid).toBe(false);
    });

    it('should verify a COSE_Sign1 with detached payload', async () => {
      const coseSign1 = await CoseSign1.create({
        key             : ed25519PrivateKey,
        payload         : testPayload,
        detachedPayload : true,
      });

      const isValid = await CoseSign1.verify({
        coseSign1,
        key     : ed25519PublicKey,
        payload : testPayload,
      });
      expect(isValid).toBe(true);
    });

    it('should throw when verifying a detached-payload message without providing payload', async () => {
      const coseSign1 = await CoseSign1.create({
        key             : ed25519PrivateKey,
        payload         : testPayload,
        detachedPayload : true,
      });

      await expect(CoseSign1.verify({
        coseSign1,
        key: ed25519PublicKey,
      })).rejects.toThrow('payload is detached');
    });
  });

  describe('decode()', () => {
    it('should decode a COSE_Sign1 message into its components', async () => {
      const coseSign1 = await CoseSign1.create({
        key     : ed25519PrivateKey,
        payload : testPayload,
      });

      const decoded = CoseSign1.decode(coseSign1);

      expect(decoded.protectedHeader.alg).toBe(CoseAlgorithm.EdDSA);
      expect(decoded.protectedHeaderBytes).toBeInstanceOf(Uint8Array);
      expect(decoded.protectedHeaderBytes.length).toBeGreaterThan(0);
      expect(decoded.unprotectedHeader).toBeInstanceOf(Map);
      expect(decoded.payload).toEqual(testPayload);
      expect(decoded.signature).toBeInstanceOf(Uint8Array);
      expect(decoded.signature.length).toBeGreaterThan(0);
    });

    it('should decode a COSE_Sign1 with detached payload', async () => {
      const coseSign1 = await CoseSign1.create({
        key             : ed25519PrivateKey,
        payload         : testPayload,
        detachedPayload : true,
      });

      const decoded = CoseSign1.decode(coseSign1);
      expect(decoded.payload).toBeNull();
    });

    it('should throw for invalid CBOR input', () => {
      const invalidCbor = new Uint8Array([0xFF, 0xFF, 0xFF]);
      expect(() => CoseSign1.decode(invalidCbor)).toThrow('failed to decode CBOR');
    });

    it('should throw for a CBOR value that is not a 4-element array', () => {
      const notAnArray = Cbor.encode('not an array');
      expect(() => CoseSign1.decode(notAnArray)).toThrow('expected a CBOR array of 4 elements');

      const tooFew = Cbor.encode([new Uint8Array(0), new Map()]);
      expect(() => CoseSign1.decode(tooFew)).toThrow('expected a CBOR array of 4 elements');
    });

    it('should throw when protected header has no algorithm', () => {
      // Create a COSE_Sign1-like array with an empty protected header.
      const emptyProtected = Cbor.encode(new Map<number, unknown>());
      const fakeSign1 = Cbor.encode([
        emptyProtected,
        new Map(),
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
      ]);

      expect(() => CoseSign1.decode(fakeSign1)).toThrow('must contain an algorithm identifier');
    });

    it('should throw when protected header bytes is not a byte string', () => {
      // Create a COSE_Sign1-like array where protected header is a string instead of bytes.
      const fakeSign1 = Cbor.encode([
        'not-bytes',
        new Map(),
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
      ]);

      expect(() => CoseSign1.decode(fakeSign1)).toThrow('protected header must be a byte string');
    });

    it('should throw when signature is not a byte string', () => {
      const validProtected = Cbor.encode(new Map<number, unknown>([[1, -8]]));
      const fakeSign1 = Cbor.encode([
        validProtected,
        new Map(),
        new Uint8Array([1, 2, 3]),
        'not-bytes-signature',
      ]);

      expect(() => CoseSign1.decode(fakeSign1)).toThrow('signature must be a byte string');
    });

    it('should throw when protected header contains invalid CBOR', () => {
      // Create a COSE_Sign1-like array with garbled protected header bytes.
      const invalidProtectedBytes = new Uint8Array([0xFF, 0xFE, 0xFD]);
      const fakeSign1 = Cbor.encode([
        invalidProtectedBytes,
        new Map(),
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
      ]);

      expect(() => CoseSign1.decode(fakeSign1)).toThrow('failed to decode protected header CBOR');
    });

    it('should throw when protected header algorithm is not a number', () => {
      // Create a protected header where alg (label 1) is a string instead of a number.
      const badAlgProtected = Cbor.encode(new Map<number, unknown>([[1, 'EdDSA']]));
      const fakeSign1 = Cbor.encode([
        badAlgProtected,
        new Map(),
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
      ]);

      expect(() => CoseSign1.decode(fakeSign1)).toThrow('must contain an algorithm identifier');
    });

    it('should extract kid from protected header', async () => {
      const kid = new TextEncoder().encode('key-id-in-protected');
      const coseSign1 = await CoseSign1.create({
        key             : ed25519PrivateKey,
        payload         : testPayload,
        protectedHeader : {
          alg: CoseAlgorithm.EdDSA,
          kid,
        },
      });

      const result = CoseSign1.decode(coseSign1);
      expect(result.protectedHeader.kid).toEqual(kid);
    });

    it('should extract content type from protected header', async () => {
      const coseSign1 = await CoseSign1.create({
        key             : ed25519PrivateKey,
        payload         : testPayload,
        protectedHeader : {
          alg         : CoseAlgorithm.EdDSA,
          contentType : 'application/eat+cwt',
        },
      });

      const decoded = CoseSign1.decode(coseSign1);
      expect(decoded.protectedHeader.contentType).toBe('application/eat+cwt');
    });
  });

  describe('round-trip', () => {
    it('should create and verify with the same key pair (Ed25519)', async () => {
      const payload = new TextEncoder().encode('round-trip test');
      const coseSign1 = await CoseSign1.create({
        key: ed25519PrivateKey,
        payload,
      });

      const isValid = await CoseSign1.verify({
        coseSign1,
        key: ed25519PublicKey,
      });
      expect(isValid).toBe(true);

      const decoded = CoseSign1.decode(coseSign1);
      expect(decoded.payload).toEqual(payload);
    });

    it('should create and verify with the same key pair (P-256)', async () => {
      const payload = new TextEncoder().encode('round-trip test P-256');
      const coseSign1 = await CoseSign1.create({
        key: p256PrivateKey,
        payload,
      });

      const isValid = await CoseSign1.verify({
        coseSign1,
        key: p256PublicKey,
      });
      expect(isValid).toBe(true);

      const decoded = CoseSign1.decode(coseSign1);
      expect(decoded.payload).toEqual(payload);
    });
  });
});
