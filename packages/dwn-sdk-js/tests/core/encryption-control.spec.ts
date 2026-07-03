import type { RecordsReadMessage, RecordsWriteMessage, ValidationStateReader } from '../../src/index.js';

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
        recordsWriteMessage   : makeRecordsWriteMessage({ protocolPath: 'thread/message' }),
        validationStateReader : {} as ValidationStateReader,
      });

      expect(result).toBe(true);
    });

    it('returns true when the requester is the tenant', async () => {
      const result = await EncryptionControl.canRead({
        tenant,
        incomingMessage       : makeIncomingMessage(),
        requester             : tenant,
        recordsWriteMessage   : makeRecordsWriteMessage({ protocolPath: ENCRYPTION_CONTROL_AUDIENCE_PATH }),
        validationStateReader : {} as ValidationStateReader,
      });

      expect(result).toBe(true);
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

function makeRecordsWriteMessage(options: { protocolPath: string }): RecordsWriteMessage {
  return {
    descriptor: {
      protocolPath: options.protocolPath,
    },
  } as RecordsWriteMessage;
}
