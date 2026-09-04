import { describe, expect, it } from 'bun:test';

import { DidResolutionErrorCause } from '@enbox/dids';
import { DwnErrorCode } from '@enbox/dwn-sdk-js';

import { DwnDataStoreReadError } from '../src/store-data.js';
import { isDidResolutionUnavailableError } from '../src/did-resolution-error.js';

describe('isDidResolutionUnavailableError', () => {
  it('should recognize the structured cause through store and signer wrappers', () => {
    const storeError = new DwnDataStoreReadError('DwnKeyStore', 'record-id', {
      code      : 401,
      detail    : 'signature verification failed',
      errorCode : DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound,
      info      : { errorCause: DidResolutionErrorCause.NetworkUnavailable },
    });
    const signerError = new Error('Unable to get signer', { cause: storeError });

    expect(isDidResolutionUnavailableError(signerError)).toBe(true);
  });

  it('should not classify prose or unrelated DWN failures as DID resolution unavailability', () => {
    expect(isDidResolutionUnavailableError(new Error('networkUnavailable'))).toBe(false);
    expect(isDidResolutionUnavailableError({
      status: {
        code   : 404,
        detail : 'Not Found',
      },
    })).toBe(false);
  });

  it('should safely ignore cyclic error wrappers', () => {
    const wrapper: { cause?: unknown } = {};
    wrapper.cause = wrapper;

    expect(isDidResolutionUnavailableError(wrapper)).toBe(false);
  });
});
