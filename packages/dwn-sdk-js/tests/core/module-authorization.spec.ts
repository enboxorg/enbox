import { createTestValidationStateReader } from '../utils/test-validation-state-reader.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { getActionsSeekingARuleMatch } from '../../src/core/module-authorization-action.js';
import { MessageStoreLevel } from '../../src/store/level.js';
import { ModuleAction } from '../../src/types/modules-types.js';
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
    it('should require create for initial writes and squash exclusively for squash writes', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
      const validationStateReader = createTestValidationStateReader({ messageStore: messageStoreStub });

      const { recordsWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice });
      expect(await getActionsSeekingARuleMatch(alice.did, recordsWrite, validationStateReader))
        .toEqual([ModuleAction.Create]);

      const { recordsWrite: squashWrite } = await TestDataGenerator.generateRecordsWrite({ author: alice, squash: true });
      expect(await getActionsSeekingARuleMatch(alice.did, squashWrite, validationStateReader))
        .toEqual([ModuleAction.Squash]);
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
