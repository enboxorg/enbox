import { describe, expect, it } from 'bun:test';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Jws } from '../../src/utils/jws.js';
import { MessagesQuery } from '../../src/interfaces/messages-query.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';

describe('MessagesQuery', () => {
  describe('create()', () => {
    it('should reject a filter with exact and prefix protocol paths', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      await expect(MessagesQuery.create({
        signer  : Jws.createSigner(alice),
        filters : [{
          protocol           : 'http://example.com/protocol',
          protocolPath       : 'post/attachment',
          protocolPathPrefix : 'post',
        }],
      })).rejects.toThrow(DwnErrorCode.SchemaValidatorFailure);
    });
  });
});
