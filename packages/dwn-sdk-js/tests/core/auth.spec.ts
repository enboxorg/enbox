import { authenticate } from '../../src/core/auth.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { describe, expect, it } from 'bun:test';
import { DidDht, UniversalResolver } from '@enbox/dids';

describe('Auth', () => {
  describe('authenticate()', () => {
    it('should throw if given JWS is `undefined`', async () => {
      const jws = undefined;
      await expect(authenticate(jws, new UniversalResolver({ didResolvers: [DidDht] }))).rejects.toThrow(DwnErrorCode.AuthenticateJwsMissing);
    });
  });
});
