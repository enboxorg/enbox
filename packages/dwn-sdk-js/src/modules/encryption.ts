import type { CoreModule } from '../core/core-module.js';
import type { Filter } from '../types/query-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { ModuleDefinition } from '../types/modules-types.js';
import type { PermissionGrant } from './permission-grant.js';
import type { PermissionScope } from '../types/permission-types.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ContentEncryptionAlgorithm, X25519KeyEncryptionBase } from '../utils/encryption.js';

import { DwnConstant } from '../core/dwn-constant.js';
import { Encoder } from '../utils/encoder.js';
import { FilterUtility } from '../utils/filter.js';
import { Message } from '../core/message.js';
import { Records } from '../utils/records.js';
import { validateJsonSchema } from '../schema-validator.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import {
  ENCRYPTION_MODULE_GRANT_KEY_PATH,
  ENCRYPTION_MODULE_URI,
  ENCRYPTION_MODULE_WRAPPED_GRANT_KEY_PATH,
} from '../core/constants.js';
import { grantKeyScopeCoversDeliveredScope, isGrantKeyEligibleRecordsScope, isGrantKeyRecordsScope } from '../utils/grant-key-coverage.js';

export const WRAPPED_GRANT_KEY_FORMAT = 'enbox/wrapped-grant-key@1';

export type WrappedGrantKeyEnvelope = {
  format: typeof WRAPPED_GRANT_KEY_FORMAT;
  keyEncryption: X25519KeyEncryptionBase;
  contentEncryption: {
    algorithm: typeof ContentEncryptionAlgorithm.A256CTR;
    initializationVector: string;
  };
  ciphertext: string;
};

export function assertWrappedGrantKeyEnvelope(envelope: unknown): asserts envelope is WrappedGrantKeyEnvelope {
  try {
    validateJsonSchema('WrappedGrantKeyEnvelope', envelope);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DwnError(
      DwnErrorCode.EncryptionModuleValidateGrantKeyWrappedDeliveryInvalid,
      `wrapped grantKey envelope is invalid: ${detail}`
    );
  }
}

export class EncryptionModule implements CoreModule {
  public static readonly uri = ENCRYPTION_MODULE_URI;
  public static readonly grantKeyPath = ENCRYPTION_MODULE_GRANT_KEY_PATH;
  public static readonly wrappedGrantKeyPath = ENCRYPTION_MODULE_WRAPPED_GRANT_KEY_PATH;

  public static readonly definition: ModuleDefinition = {
    published : true,
    module    : EncryptionModule.uri,
    types     : {
      grantKey: {
        dataFormats        : ['application/json'],
        encryptionRequired : true,
        schema             : 'https://identity.foundation/dwn/json-schemas/encryption/grant-key.json',
      },
      wrappedGrantKey: {
        dataFormats : ['application/json'],
        schema      : 'https://identity.foundation/dwn/json-schemas/encryption/wrapped-grant-key-envelope.json',
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
          $requiredTags       : ['grantId', 'module', 'keyId'],
          grantId             : { type: 'string' },
          keyId               : { maxLength: 43, minLength: 43, pattern: '^[A-Za-z0-9_-]{43}$', type: 'string' },
          module              : { type: 'string' },
          modulePath          : { type: 'string' },
        },
      },
      wrappedGrantKey: {
        $actions: [
          { can: ['create'], who: 'anyone' },
          { can: ['read'], of: 'wrappedGrantKey', who: 'recipient' },
        ],
        $immutable : true,
        $tags      : {
          $allowUndefinedTags : false,
          $requiredTags       : ['grantId', 'module', 'keyId'],
          grantId             : { type: 'string' },
          keyId               : { maxLength: 43, minLength: 43, pattern: '^[A-Za-z0-9_-]{43}$', type: 'string' },
          module              : { type: 'string' },
          modulePath          : { type: 'string' },
        },
      },
    }
  };

  public get uri(): string {
    return EncryptionModule.uri;
  }

  public get definition(): ModuleDefinition {
    return EncryptionModule.definition;
  }

  public async preProcessWrite(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    if (EncryptionModule.isGrantKeyPath(message.descriptor.modulePath)) {
      await EncryptionModule.preProcessGrantKey(tenant, message, validationStateReader);
    }
  }

  public async validateRecord(message: RecordsWriteMessage, dataBytes: Uint8Array): Promise<void> {
    if (EncryptionModule.isGrantKeyPath(message.descriptor.modulePath)) {
      EncryptionModule.verifyGrantKeyDelivery(message, dataBytes);
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionModuleValidateSchemaUnexpectedRecord,
      `Unexpected encryption record: ${message.descriptor.modulePath}`
    );
  }

  private static async preProcessGrantKey(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    EncryptionModule.verifyGrantKeyRepresentation(message);

    const grantId = EncryptionModule.getRequiredStringTag(message, 'grantId');
    const module = EncryptionModule.getRequiredStringTag(message, 'module');
    const modulePath = EncryptionModule.getOptionalStringTag(message, 'modulePath');
    EncryptionModule.getRequiredStringTag(message, 'keyId');

    const grant = await validationStateReader.fetchGrant(tenant, grantId);
    await EncryptionModule.verifyGrantActive(tenant, message, grant, validationStateReader);
    EncryptionModule.verifyGrantKeyAuthor(message, grant);
    EncryptionModule.verifyGrantKeyRecipient(message, grant);
    await EncryptionModule.verifyGrantKeyScope({
      tenant,
      message,
      grantScope: grant.scope,
      module,
      modulePath,
      validationStateReader,
    });
  }

  private static verifyGrantKeyRepresentation(message: RecordsWriteMessage): void {
    if (message.descriptor.modulePath === EncryptionModule.grantKeyPath) {
      if (message.encryption === undefined) {
        throw new DwnError(
          DwnErrorCode.EncryptionModuleValidateEncryptedDeliveryMissingEncryption,
          'grantKey records must be encrypted.'
        );
      }
      return;
    }

    if (message.encryption !== undefined) {
      throw new DwnError(
        DwnErrorCode.ModuleAuthorizationEncryptionNotAllowed,
        'wrappedGrantKey records must be plaintext at the DWN record level.'
      );
    }

    if (message.descriptor.dataSize > DwnConstant.maxDataSizeAllowedToBeEncoded) {
      throw new DwnError(
        DwnErrorCode.EncryptionModuleValidateEncryptedDeliveryMissingEncryption,
        'wrappedGrantKey records must carry an inline wrapped grantKey envelope.'
      );
    }
  }

  private static verifyGrantKeyDelivery(message: RecordsWriteMessage, dataBytes: Uint8Array): void {
    if (message.descriptor.modulePath === EncryptionModule.grantKeyPath) {
      return;
    }

    try {
      const envelope = Encoder.bytesToObject(dataBytes);
      assertWrappedGrantKeyEnvelope(envelope);
    } catch (error) {
      if (error instanceof DwnError) {
        throw error;
      }

      const detail = error instanceof Error ? error.message : String(error);
      throw new DwnError(
        DwnErrorCode.EncryptionModuleValidateEncryptedDeliveryMissingEncryption,
        `${message.descriptor.modulePath} records must carry a valid wrapped grantKey envelope: ${detail}`
      );
    }
  }

  private static isGrantKeyPath(modulePath: string): boolean {
    return modulePath === EncryptionModule.grantKeyPath ||
      modulePath === EncryptionModule.wrappedGrantKeyPath;
  }

  private static getRequiredStringTag(message: RecordsWriteMessage, tag: string): string {
    const value = message.descriptor.tags?.[tag];
    if (typeof value !== 'string') {
      throw new DwnError(
        DwnErrorCode.EncryptionModuleValidateGrantKeyMissingRequiredTag,
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
        DwnErrorCode.EncryptionModuleValidateGrantKeyMissingRequiredTag,
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
      DwnErrorCode.EncryptionModuleValidateGrantKeyAuthorMismatch,
      `grantKey author must be permission grantor ${grant.grantor}.`
    );
  }

  private static verifyGrantKeyRecipient(message: RecordsWriteMessage, grant: PermissionGrant): void {
    if (message.descriptor.recipient === grant.grantee) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionModuleValidateGrantKeyRecipientMismatch,
      `grantKey recipient must be permission grantee ${grant.grantee}.`
    );
  }

  private static async verifyGrantKeyScope(params: {
    tenant: string;
    message: RecordsWriteMessage;
    grantScope: PermissionScope;
    module: string;
    modulePath: string | undefined;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const { grantScope, module, modulePath } = params;

    if (!isGrantKeyRecordsScope(grantScope)) {
      throw new DwnError(
        DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch,
        'grantKey must reference a Records.Read or Records.Write permission grant.'
      );
    }

    if (!isGrantKeyEligibleRecordsScope(grantScope)) {
      throw new DwnError(
        DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch,
        'grantKey must not reference a context-scoped permission grant.'
      );
    }

    if (grantScope.module !== module) {
      throw new DwnError(
        DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch,
        `grantKey module ${module} is outside the permission grant scope.`
      );
    }

    const deliveredScope = { module, modulePath };
    if (grantKeyScopeCoversDeliveredScope({ grantScope, deliveredScope })) {
      return;
    }

    if (modulePath === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch,
        `grantKey modulePath ${modulePath ?? '<module>'} is outside the permission grant scope.`
      );
    }

    const moduleDefinition = await params.validationStateReader.fetchModuleDefinition(
      params.tenant,
      params.module,
      params.message.descriptor.messageTimestamp,
    );
    if (grantKeyScopeCoversDeliveredScope({ grantScope, deliveredScope, moduleDefinition })) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionModuleValidateGrantKeyGrantScopeMismatch,
      `grantKey modulePath ${modulePath ?? '<module>'} is outside the permission grant scope.`
    );
  }

  public mapErrorToStatusCode(errorCode: string): number | undefined {
    if (errorCode.startsWith('EncryptionModuleValidate')) {
      return 400;
    }
    return undefined;
  }

  public constructAdditionalMessageFilter(filter: MessagesFilter): Filter | undefined {
    const { module, messageTimestamp } = filter;
    if (module === undefined) {
      return undefined;
    }

    const taggedFilter = {
      module: EncryptionModule.uri,
      ...Records.convertTagsFilter({ module }),
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
