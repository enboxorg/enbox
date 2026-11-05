import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { getActionsSeekingARuleMatch } from '../../src/core/module-authorization-action.js';
import { MessageStoreLevel } from '../../src/store/level.js';
import { ModuleAuthorization } from '../../src/core/module-authorization.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { beforeEach, describe, expect, it } from 'bun:test';

import sinon from 'sinon';

describe('ModuleAuthorization', () => {
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

      await expect(ModuleAuthorization.authorizeWrite(alice.did, recordsWrite, validationStateReader)).rejects.toThrow(
        DwnErrorCode.ModuleAuthorizationParentNotFoundConstructingRecordChain
      );
    });
  });

  describe('getActionsSeekingARuleMatch()', () => {
    it('should fail closed for an initial RecordsWrite without action rules', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const validationStateReader = createTestValidationStateReader({ messageStore: messageStoreStub });

      await expect(
        getActionsSeekingARuleMatch(alice.did, recordsWrite, validationStateReader)
      ).rejects.toThrow(DwnErrorCode.ModuleAuthorizationActionRulesNotFound);
    });

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
