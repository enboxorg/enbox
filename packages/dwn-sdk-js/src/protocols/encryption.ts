import type { CoreProtocol } from '../core/core-protocol.js';
import type { Filter } from '../types/query-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { ProtocolDefinition } from '../types/protocols-types.js';
import type { RecordsWriteMessage } from '../types/records-types.js';

import { ENCRYPTION_PROTOCOL_URI } from '../core/constants.js';
import { FilterUtility } from '../utils/filter.js';
import { Records } from '../utils/records.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

export class EncryptionProtocol implements CoreProtocol {
  public static readonly uri = ENCRYPTION_PROTOCOL_URI;
  public static readonly grantKeyPath = 'grantKey';

  public static readonly definition: ProtocolDefinition = {
    published : true,
    protocol  : EncryptionProtocol.uri,
    types     : {
      grantKey: {
        dataFormats : ['application/json'],
        schema      : 'https://identity.foundation/dwn/json-schemas/encryption/grant-key.json',
      },
    },
    structure: {
      grantKey: {
        $actions: [
          { can: ['create'], who: 'anyone' },
          { can: ['read'], of: 'grantKey', who: 'recipient' },
        ],
        $immutable : true,
        $tags      : {
          $allowUndefinedTags : false,
          $requiredTags       : ['grantId', 'protocol', 'keyId'],
          grantId             : { type: 'string' },
          keyId               : { maxLength: 43, minLength: 43, pattern: '^[A-Za-z0-9_-]{43}$', type: 'string' },
          protocol            : { type: 'string' },
          protocolPath        : { type: 'string' },
        },
      },
    }
  };

  public get uri(): string {
    return EncryptionProtocol.uri;
  }

  public get definition(): ProtocolDefinition {
    return EncryptionProtocol.definition;
  }

  public async validateRecord(message: RecordsWriteMessage, dataBytes: Uint8Array): Promise<void> {
    void dataBytes;

    if (message.descriptor.protocolPath === EncryptionProtocol.grantKeyPath) {
      if (message.encryption === undefined) {
        throw new DwnError(
          DwnErrorCode.EncryptionProtocolValidateEncryptedDeliveryMissingEncryption,
          `${message.descriptor.protocolPath} records must be encrypted.`
        );
      }
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionProtocolValidateSchemaUnexpectedRecord,
      `Unexpected encryption record: ${message.descriptor.protocolPath}`
    );
  }

  public mapErrorToStatusCode(errorCode: string): number | undefined {
    if (errorCode.startsWith('EncryptionProtocolValidate')) {
      return 400;
    }
    return undefined;
  }

  public constructAdditionalMessageFilter(filter: MessagesFilter): Filter | undefined {
    const { protocol, messageTimestamp } = filter;
    if (protocol === undefined) {
      return undefined;
    }

    const taggedFilter = {
      protocol: EncryptionProtocol.uri,
      ...Records.convertTagsFilter({ protocol }),
    } as Filter;

    if (messageTimestamp !== undefined) {
      const messageTimestampFilter = FilterUtility.convertRangeCriterion(messageTimestamp);
      if (messageTimestampFilter) {
        taggedFilter.messageTimestamp = messageTimestampFilter;
      }
    }

    return taggedFilter;
  }
}
