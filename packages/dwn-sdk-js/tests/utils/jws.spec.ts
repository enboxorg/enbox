import { expect } from 'chai';

import type { GeneralJws } from '../../src/types/jws-types.js';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';

describe('Jws', () => {
  describe('verifySignature', () => {
    it('throws an error for unsupported crv', async () => {
      const jwkPublic = { kty: 'EC', crv: 'P-384', x: 'abc', y: 'def' } as any;
      const signatureEntry = { protected: '', signature: '' };

      try {
        await Jws.verifySignature('payload', signatureEntry, jwkPublic);
        expect.fail('Expected an error');
      } catch (e: any) {
        expect(e.code).to.equal(DwnErrorCode.JwsVerifySignatureUnsupportedCrv);
      }
    });
  });

  describe('decodePlainObjectPayload', () => {
    it('throws an error for invalid base64url payload', () => {
      const jws: GeneralJws = {
        payload    : '!!!invalid-base64url!!!',
        signatures : [],
      };

      try {
        Jws.decodePlainObjectPayload(jws);
        expect.fail('Expected an error');
      } catch (e: any) {
        expect(e.code).to.equal(DwnErrorCode.JwsDecodePlainObjectPayloadInvalid);
      }
    });

    it('throws an error when decoded payload is not a plain object', () => {
      // Encode a JSON array as the payload — valid JSON but not a plain object
      const arrayPayload = Encoder.stringToBase64Url(JSON.stringify([1, 2, 3]));
      const jws: GeneralJws = {
        payload    : arrayPayload,
        signatures : [],
      };

      try {
        Jws.decodePlainObjectPayload(jws);
        expect.fail('Expected an error');
      } catch (e: any) {
        expect(e.code).to.equal(DwnErrorCode.JwsDecodePlainObjectPayloadInvalid);
      }
    });
  });
});
