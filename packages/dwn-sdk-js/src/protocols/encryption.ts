import type { CoreProtocol } from '../core/core-protocol.js';
import type { Filter } from '../types/query-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { PermissionGrant } from './permission-grant.js';
import type { PermissionScope } from '../types/permission-types.js';
import type { ProtocolDefinition } from '../types/protocols-types.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

import { ENCRYPTION_PROTOCOL_URI } from '../core/constants.js';
import { FilterUtility } from '../utils/filter.js';
import { Message } from '../core/message.js';
import { Records } from '../utils/records.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { grantKeyScopeCoversDeliveredScope, isGrantKeyEligibleRecordsScope, isGrantKeyRecordsScope } from '../utils/grant-key-coverage.js';

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

  public async preProcessWrite(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    if (message.descriptor.protocolPath === EncryptionProtocol.grantKeyPath) {
      await EncryptionProtocol.preProcessGrantKey(tenant, message, validationStateReader);
    }
  }

  public async validateRecord(message: RecordsWriteMessage, _dataBytes: Uint8Array): Promise<void> {
    if (message.descriptor.protocolPath === EncryptionProtocol.grantKeyPath) {
      EncryptionProtocol.verifyEncryptedDelivery(message);
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionProtocolValidateSchemaUnexpectedRecord,
      `Unexpected encryption record: ${message.descriptor.protocolPath}`
    );
  }

  private static async preProcessGrantKey(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    EncryptionProtocol.verifyEncryptedDelivery(message);

    const grantId = EncryptionProtocol.getRequiredStringTag(message, 'grantId');
    const protocol = EncryptionProtocol.getRequiredStringTag(message, 'protocol');
    const protocolPath = EncryptionProtocol.getOptionalStringTag(message, 'protocolPath');
    EncryptionProtocol.getRequiredStringTag(message, 'keyId');

    const grant = await validationStateReader.fetchGrant(tenant, grantId);
    await EncryptionProtocol.verifyGrantActive(tenant, message, grant, validationStateReader);
    EncryptionProtocol.verifyGrantKeyAuthor(message, grant);
    EncryptionProtocol.verifyGrantKeyRecipient(message, grant);
    await EncryptionProtocol.verifyGrantKeyScope({
      tenant,
      message,
      grantScope: grant.scope,
      protocol,
      protocolPath,
      validationStateReader,
    });
  }

  private static verifyEncryptedDelivery(message: RecordsWriteMessage): void {
    if (message.encryption === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateEncryptedDeliveryMissingEncryption,
        `${message.descriptor.protocolPath} records must be encrypted.`
      );
    }
  }

  private static getRequiredStringTag(message: RecordsWriteMessage, tag: string): string {
    const value = message.descriptor.tags?.[tag];
    if (typeof value !== 'string') {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyMissingRequiredTag,
        `grantKey records must include string tag '${tag}'.`
      );
    }

    return value;
  }

  private static getOptionalStringTag(message: RecordsWriteMessage, tag: string): string | undefined {
    const value = message.descriptor.tags?.[tag];
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyMissingRequiredTag,
        `grantKey tag '${tag}' must be a string.`
      );
    }

    return value;
  }

  private static async verifyGrantActive(
    tenant: string,
    message: RecordsWriteMessage,
    grant: PermissionGrant,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    const timestamp = message.descriptor.messageTimestamp;
    if (timestamp < grant.dateGranted) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantNotYetActive,
        'grantKey references a permission grant that is not active yet.'
      );
    }

    if (timestamp >= grant.dateExpires) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantExpired,
        'grantKey references an expired permission grant.'
      );
    }

    const oldestRevocation = await validationStateReader.fetchOldestGrantRevocation(tenant, grant.id);
    if (oldestRevocation !== undefined && oldestRevocation.descriptor.messageTimestamp <= timestamp) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantRevoked,
        `grantKey references revoked permission grant ${grant.id}.`
      );
    }
  }

  private static verifyGrantKeyAuthor(message: RecordsWriteMessage, grant: PermissionGrant): void {
    if (Message.getAuthor(message) === grant.grantor) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionProtocolValidateGrantKeyAuthorMismatch,
      `grantKey author must be permission grantor ${grant.grantor}.`
    );
  }

  private static verifyGrantKeyRecipient(message: RecordsWriteMessage, grant: PermissionGrant): void {
    if (message.descriptor.recipient === grant.grantee) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionProtocolValidateGrantKeyRecipientMismatch,
      `grantKey recipient must be permission grantee ${grant.grantee}.`
    );
  }

  private static async verifyGrantKeyScope(params: {
    tenant: string;
    message: RecordsWriteMessage;
    grantScope: PermissionScope;
    protocol: string;
    protocolPath: string | undefined;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const { grantScope, protocol, protocolPath } = params;

    if (!isGrantKeyRecordsScope(grantScope)) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
        'grantKey must reference a Records.Read or Records.Write permission grant.'
      );
    }

    if (!isGrantKeyEligibleRecordsScope(grantScope)) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
        'grantKey must not reference a context-scoped permission grant.'
      );
    }

    if (grantScope.protocol !== protocol) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
        `grantKey protocol ${protocol} is outside the permission grant scope.`
      );
    }

    const deliveredScope = { protocol, protocolPath };
    if (grantKeyScopeCoversDeliveredScope({ grantScope, deliveredScope })) {
      return;
    }

    if (protocolPath === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
        `grantKey protocolPath ${protocolPath ?? '<protocol>'} is outside the permission grant scope.`
      );
    }

    const protocolDefinition = await params.validationStateReader.fetchProtocolDefinition(
      params.tenant,
      params.protocol,
      params.message.descriptor.messageTimestamp,
    );
    if (grantKeyScopeCoversDeliveredScope({ grantScope, deliveredScope, protocolDefinition })) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
      `grantKey protocolPath ${protocolPath ?? '<protocol>'} is outside the permission grant scope.`
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
