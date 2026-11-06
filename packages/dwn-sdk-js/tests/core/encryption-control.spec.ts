import type { MessageStore, RecordsReadMessage, RecordsWriteMessage, ValidationStateReader } from '../../src/index.js';

import { describe, expect, it } from 'bun:test';

import { ENCRYPTION_CONTROL_AUDIENCE_PATH } from '../../src/core/constants.js';
import { EncryptionControl } from '../../src/core/encryption-control.js';
import { DwnInterfaceName, DwnMethodName } from '../../src/index.js';

const tenant = 'did:example:tenant';

describe('EncryptionControl', () => {
  describe('canRead()', () => {
    it('returns true for non-control records', async () => {
      const result = await EncryptionControl.canRead({
        tenant,
        incomingMessage       : makeIncomingMessage(),
        requester             : 'did:example:alice',
        recordsWriteMessage   : makeRecordsWriteMessage({ modulePath: 'thread/message' }),
        validationStateReader : {} as ValidationStateReader,
      });

      expect(result).toBe(true);
    });

    it('returns true when the requester is the tenant', async () => {
      const result = await EncryptionControl.canRead({
        tenant,
        incomingMessage       : makeIncomingMessage(),
        requester             : tenant,
        recordsWriteMessage   : makeRecordsWriteMessage({ modulePath: ENCRYPTION_CONTROL_AUDIENCE_PATH }),
        validationStateReader : {} as ValidationStateReader,
      });

      expect(result).toBe(true);
    });
  });

  describe('projectCurrentAudienceRecords()', () => {
    it('should reuse current audience resolution results from a caller-provided cache', async () => {
      const current = makeAudienceRecordsWriteMessage({
        dateCreated : '2026-01-01T00:00:00.000000Z',
        keyId       : 'current',
        recordId    : 'current-record',
      });
      const loser = makeAudienceRecordsWriteMessage({
        dateCreated : '2026-01-01T00:00:01.000000Z',
        keyId       : 'loser',
        recordId    : 'loser-record',
      });
      let queryCount = 0;
      const messageStore = {
        query: async (): Promise<{ messages: RecordsWriteMessage[] }> => {
          queryCount++;
          return { messages: [current, loser] };
        },
      } as unknown as MessageStore;
      const currentAudienceRecordIdCache = new Map<string, string | undefined>();

      const loserProjection = await EncryptionControl.projectCurrentAudienceRecords({
        currentAudienceRecordIdCache,
        messageStore,
        tenant,
        recordsWriteMessages: [loser],
      });
      expect(loserProjection).toEqual([]);

      const currentProjection = await EncryptionControl.projectCurrentAudienceRecords({
        currentAudienceRecordIdCache,
        messageStore,
        tenant,
        recordsWriteMessages: [current],
      });
      expect(currentProjection.map(record => record.recordId)).toEqual(['current-record']);
      expect(queryCount).toBe(1);
    });
  });
});

function makeIncomingMessage(): RecordsReadMessage {
  return {
    descriptor: {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
    },
  } as RecordsReadMessage;
}

function makeRecordsWriteMessage(options: { modulePath: string }): RecordsWriteMessage {
  return {
    descriptor: {
      modulePath: options.modulePath,
    },
  } as RecordsWriteMessage;
}

function makeAudienceRecordsWriteMessage(options: {
  dateCreated: string;
  keyId: string;
  recordId: string;
}): RecordsWriteMessage {
  return {
    descriptor: {
      interface   : DwnInterfaceName.Records,
      method      : DwnMethodName.Write,
      module      : 'http://example.com/module',
      modulePath  : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      dateCreated : options.dateCreated,
      tags        : {
        contextId : '',
        keyId     : options.keyId,
        module    : 'http://example.com/module',
        rolePath  : 'member',
      },
    },
    recordId: options.recordId,
  } as unknown as RecordsWriteMessage;
}
