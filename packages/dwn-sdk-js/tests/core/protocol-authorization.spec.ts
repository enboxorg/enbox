import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { getActionsSeekingARuleMatch } from '../../src/core/protocol-authorization-action.js';
import { MessageStoreLevel } from '../../src/index.js';
import { ProtocolAuthorization } from '../../src/core/protocol-authorization.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { beforeEach, describe, expect, it } from 'bun:test';

import sinon from 'sinon';

describe('ProtocolAuthorization', () => {
  beforeEach(() => {
    sinon.restore();
  });

  describe('authorizeWrite()', () => {
    it('should throw if message references non-existent parent', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        parentContextId : 'nonExistentParent',
      });

      // stub the message store
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      messageStoreStub.query.resolves({ messages: [] }); // simulate parent not in message store
      const validationStateReader = createTestValidationStateReader({ messageStore: messageStoreStub });

      await expect(ProtocolAuthorization.authorizeWrite(alice.did, recordsWrite, validationStateReader, 'live')).rejects.toThrow(
        DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain
      );
    });
  });

  describe('getActionsSeekingARuleMatch()', () => {
    it('should return empty array if unknown message method type is given', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const deliberatelyCraftedInvalidMessage = {
        message: {
          descriptor: {
            method: 'invalid-method'
          },
        }
      } as any;

      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const validationStateReader = createTestValidationStateReader({ messageStore: messageStoreStub });
      expect(await getActionsSeekingARuleMatch(alice.did, deliberatelyCraftedInvalidMessage, validationStateReader)).toHaveLength(0);
    });
  });
});
