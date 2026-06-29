import type { CoreProtocol } from '../core/core-protocol.js';
import type { Filter } from '../types/query-types.js';
import type { GenericSignaturePayload } from '../types/message-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { PermissionGrant } from './permission-grant.js';
import type { PermissionScope } from '../types/permission-types.js';
import type { PublicKeyJwk } from '../types/jose-types.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';

import { checkActor } from '../core/protocol-authorization-action.js';
import { Encoder } from '../utils/encoder.js';
import { Encryption } from '../utils/encryption.js';
import { ENCRYPTION_PROTOCOL_URI } from '../core/constants.js';
import { FilterUtility } from '../utils/filter.js';
import { Jws } from '../utils/jws.js';
import { Message } from '../core/message.js';
import { Records } from '../utils/records.js';
import { validateJsonSchema } from '../schema-validator.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRuleSetAtPath, isCrossProtocolRef, parseCrossProtocolRef } from '../utils/protocols.js';
import { ProtocolAction, ProtocolActor } from '../types/protocols-types.js';

type AudienceTags = {
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
};

type AudienceEpochData = AudienceTags & {
  publicKeyJwk: PublicKeyJwk;
};

export class EncryptionProtocol implements CoreProtocol {
  public static readonly uri = ENCRYPTION_PROTOCOL_URI;
  public static readonly audienceEpochPath = 'audienceEpoch';
  public static readonly audienceKeyPath = 'audienceKey';
  public static readonly grantKeyPath = 'grantKey';

  public static readonly definition: ProtocolDefinition = {
    published : true,
    protocol  : EncryptionProtocol.uri,
    types     : {
      audienceEpoch: {
        dataFormats : ['application/json'],
        schema      : 'https://identity.foundation/dwn/json-schemas/encryption/audience-epoch.json',
      },
      audienceKey: {
        dataFormats : ['application/json'],
        schema      : 'https://identity.foundation/dwn/json-schemas/encryption/audience-key.json',
      },
      grantKey: {
        dataFormats : ['application/json'],
        schema      : 'https://identity.foundation/dwn/json-schemas/encryption/grant-key.json',
      },
    },
    structure: {
      audienceEpoch: {
        $actions: [
          { can: ['create', 'read'], who: 'anyone' },
        ],
        $immutable : true,
        $tags      : {
          $allowUndefinedTags : false,
          $requiredTags       : ['protocol', 'contextId', 'role', 'epoch', 'keyId'],
          contextId           : { type: 'string' },
          epoch               : { minimum: 1, type: 'integer' },
          keyId               : { pattern: '^[A-Za-z0-9_-]{43}$', type: 'string' },
          protocol            : { type: 'string' },
          role                : { type: 'string' },
        },
      },
      audienceKey: {
        $actions: [
          { can: ['create'], who: 'anyone' },
          { can: ['read'], of: 'audienceKey', who: 'recipient' },
        ],
        $immutable : true,
        $tags      : {
          $allowUndefinedTags : false,
          $requiredTags       : ['protocol', 'contextId', 'role', 'epoch', 'keyId'],
          contextId           : { type: 'string' },
          epoch               : { minimum: 1, type: 'integer' },
          keyId               : { pattern: '^[A-Za-z0-9_-]{43}$', type: 'string' },
          protocol            : { type: 'string' },
          role                : { type: 'string' },
        },
      },
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
    switch (message.descriptor.protocolPath) {
    case EncryptionProtocol.audienceEpochPath:
      await EncryptionProtocol.preProcessAudienceEpoch(tenant, message, validationStateReader);
      return;
    case EncryptionProtocol.audienceKeyPath:
      await EncryptionProtocol.preProcessAudienceKey(tenant, message, validationStateReader);
      return;
    case EncryptionProtocol.grantKeyPath:
      await EncryptionProtocol.preProcessGrantKey(tenant, message, validationStateReader);
      return;
    default:
      return;
    }
  }

  public async validateRecord(message: RecordsWriteMessage, dataBytes: Uint8Array): Promise<void> {
    switch (message.descriptor.protocolPath) {
    case EncryptionProtocol.audienceEpochPath:
      await EncryptionProtocol.validateAudienceEpoch(message, dataBytes);
      return;
    case EncryptionProtocol.audienceKeyPath:
    case EncryptionProtocol.grantKeyPath:
      EncryptionProtocol.verifyEncryptedDelivery(message);
      return;
    default:
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateSchemaUnexpectedRecord,
        `Unexpected encryption record: ${message.descriptor.protocolPath}`
      );
    }
  }

  private static async preProcessAudienceEpoch(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    if (message.encryption !== undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceEpochEncrypted,
        'audienceEpoch records must be plaintext.'
      );
    }

    const tags = EncryptionProtocol.getAudienceTags(message, 'audienceEpoch');
    const { ruleSet, protocolDefinition } = await EncryptionProtocol.verifyRoleAudienceDefinition(tenant, tags, message, validationStateReader);
    await EncryptionProtocol.verifyWriterCanCreateRole({
      tenant,
      message,
      tags,
      ruleSet,
      protocolDefinition,
      validationStateReader,
    });

    const existingEpochs = await validationStateReader.queryAudienceEpochs({
      tenant,
      protocol  : tags.protocol,
      contextId : tags.contextId,
      role      : tags.role,
      epoch     : tags.epoch,
    });

    if (existingEpochs.some((epoch): boolean => epoch.descriptor.tags?.keyId !== tags.keyId)) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceEpochConflict,
        'audienceEpoch conflicts with an accepted epoch for the same role audience.'
      );
    }
  }

  private static async preProcessAudienceKey(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    EncryptionProtocol.verifyEncryptedDelivery(message);

    const recipient = message.descriptor.recipient;
    if (recipient === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceKeyRecipientMissing,
        'audienceKey records must have a recipient.'
      );
    }

    const tags = EncryptionProtocol.getAudienceTags(message, 'audienceKey');
    const { ruleSet, protocolDefinition } = await EncryptionProtocol.verifyRoleAudienceDefinition(tenant, tags, message, validationStateReader);
    await EncryptionProtocol.verifyWriterCanCreateRole({
      tenant,
      message,
      tags,
      ruleSet,
      protocolDefinition,
      validationStateReader,
    });

    const matchingEpochs = await validationStateReader.queryAudienceEpochs({
      tenant,
      protocol  : tags.protocol,
      contextId : tags.contextId,
      role      : tags.role,
      epoch     : tags.epoch,
      keyId     : tags.keyId,
    });

    if (matchingEpochs.length === 0) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceEpochMissing,
        'audienceKey references a missing audienceEpoch.'
      );
    }

    const hasRoleRecord = await validationStateReader.hasMatchingRoleRecord({
      tenant,
      protocol        : tags.protocol,
      protocolPath    : tags.role,
      recipient,
      contextIdPrefix : tags.contextId === '' ? undefined : tags.contextId,
    });

    if (!hasRoleRecord) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceKeyRoleRecordMissing,
        'audienceKey recipient is not an active holder of the referenced role.'
      );
    }
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
    EncryptionProtocol.verifyGrantKeyScope(grant.scope, protocol, protocolPath);
  }

  private static verifyEncryptedDelivery(message: RecordsWriteMessage): void {
    if (message.encryption === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateEncryptedDeliveryMissingEncryption,
        `${message.descriptor.protocolPath} records must be encrypted.`
      );
    }
  }

  private static async validateAudienceEpoch(message: RecordsWriteMessage, dataBytes: Uint8Array): Promise<void> {
    if (message.encryption !== undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceEpochEncrypted,
        'audienceEpoch records must be plaintext.'
      );
    }

    const dataObject = JSON.parse(Encoder.bytesToString(dataBytes)) as AudienceEpochData;
    validateJsonSchema('AudienceEpoch', dataObject);

    const tags = EncryptionProtocol.getAudienceTags(message, 'audienceEpoch');
    EncryptionProtocol.verifyAudiencePayloadMatchesTags(dataObject, tags);

    const keyId = await Encryption.getKeyId(dataObject.publicKeyJwk);
    if (keyId !== dataObject.keyId) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceEpochKeyIdMismatch,
        'audienceEpoch keyId must match publicKeyJwk thumbprint.'
      );
    }
  }

  private static verifyAudiencePayloadMatchesTags(payload: AudienceTags, tags: AudienceTags): void {
    if (payload.protocol !== tags.protocol ||
        payload.contextId !== tags.contextId ||
        payload.role !== tags.role ||
        payload.epoch !== tags.epoch ||
        payload.keyId !== tags.keyId) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceTagsMismatch,
        'audienceEpoch tags must match payload fields.'
      );
    }
  }

  private static getRequiredStringTag(message: RecordsWriteMessage, tag: string, recordType = 'grantKey'): string {
    const value = message.descriptor.tags?.[tag];
    if (typeof value !== 'string') {
      const errorCode = recordType === 'grantKey'
        ? DwnErrorCode.EncryptionProtocolValidateGrantKeyMissingRequiredTag
        : DwnErrorCode.EncryptionProtocolValidateAudienceMissingRequiredTag;
      throw new DwnError(
        errorCode,
        `${recordType} records must include string tag '${tag}'.`
      );
    }

    return value;
  }

  private static getRequiredIntegerTag(message: RecordsWriteMessage, tag: string, recordType: string): number {
    const value = message.descriptor.tags?.[tag];
    if (!Number.isInteger(value)) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceMissingRequiredTag,
        `${recordType} records must include integer tag '${tag}'.`
      );
    }

    return value as number;
  }

  private static getAudienceTags(message: RecordsWriteMessage, recordType: string): AudienceTags {
    return {
      protocol  : EncryptionProtocol.getRequiredStringTag(message, 'protocol', recordType),
      contextId : EncryptionProtocol.getRequiredStringTag(message, 'contextId', recordType),
      role      : EncryptionProtocol.getRequiredStringTag(message, 'role', recordType),
      epoch     : EncryptionProtocol.getRequiredIntegerTag(message, 'epoch', recordType),
      keyId     : EncryptionProtocol.getRequiredStringTag(message, 'keyId', recordType),
    };
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

  private static verifyGrantKeyScope(grantScope: PermissionScope, protocol: string, protocolPath: string | undefined): void {
    if (!EncryptionProtocol.isReadScope(grantScope)) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
        'grantKey must reference a read permission grant.'
      );
    }

    if ('protocol' in grantScope && grantScope.protocol !== undefined && grantScope.protocol !== protocol) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
        `grantKey protocol ${protocol} is outside the permission grant scope.`
      );
    }

    if (!('protocolPath' in grantScope) || grantScope.protocolPath === undefined) {
      return;
    }

    if (protocolPath === undefined || !EncryptionProtocol.isBoundaryAwareSubtree(grantScope.protocolPath, protocolPath)) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateGrantKeyGrantScopeMismatch,
        `grantKey protocolPath ${protocolPath ?? '<protocol>'} is outside the permission grant scope.`
      );
    }
  }

  private static isReadScope(scope: PermissionScope): boolean {
    return (scope.interface === DwnInterfaceName.Records || scope.interface === DwnInterfaceName.Messages) &&
      scope.method === DwnMethodName.Read;
  }

  private static isBoundaryAwareSubtree(scopePath: string, candidatePath: string): boolean {
    return candidatePath === scopePath || candidatePath.startsWith(scopePath + '/');
  }

  private static async verifyRoleAudienceDefinition(
    tenant: string,
    tags: AudienceTags,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<{ protocolDefinition: ProtocolDefinition; ruleSet: ProtocolRuleSet }> {
    EncryptionProtocol.verifyRoleAudienceContext(tags.role, tags.contextId);

    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      tags.protocol,
      message.descriptor.messageTimestamp,
    );
    const ruleSet = getRuleSetAtPath(tags.role, protocolDefinition.structure);

    if (ruleSet?.$role !== true || ruleSet.$keyAgreement === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateRoleAudienceInvalid,
        `role audience path '${tags.role}' must be a role path with $keyAgreement.`
      );
    }

    return { protocolDefinition, ruleSet };
  }

  private static verifyRoleAudienceContext(rolePath: string, contextId: string): void {
    const parentDepth = rolePath.split('/').length - 1;
    if ((parentDepth === 0 && contextId !== '') || (parentDepth > 0 && contextId === '')) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateRoleAudienceContextInvalid,
        'role audience contextId is inconsistent with role path depth.'
      );
    }
  }

  private static async verifyWriterCanCreateRole(input: {
    tenant: string;
    message: RecordsWriteMessage;
    tags: AudienceTags;
    ruleSet: ProtocolRuleSet;
    protocolDefinition: ProtocolDefinition;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const author = Message.getAuthor(input.message);
    if (author === input.tenant) {
      return;
    }

    if (author === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionProtocolValidateAudienceWriterUnauthorized,
        'audience key records must be authored by a DID authorized to create role records.'
      );
    }

    const actionRules = input.ruleSet.$actions ?? [];
    const recordChain = await EncryptionProtocol.constructRoleParentChain(input.tenant, input.tags, input.validationStateReader);
    const signaturePayload = Jws.decodePlainObjectPayload(input.message.authorization.signature) as GenericSignaturePayload;

    for (const actionRule of actionRules) {
      if (!actionRule.can.includes(ProtocolAction.Create)) {
        continue;
      }

      if (actionRule.who === ProtocolActor.Anyone) {
        return;
      }

      if (await EncryptionProtocol.roleRuleAllowsAuthor(
        input.tenant,
        author,
        actionRule,
        input.tags,
        input.protocolDefinition,
        input.validationStateReader,
        signaturePayload.protocolRole,
      )) {
        return;
      }

      if (await checkActor(author, actionRule, recordChain, input.protocolDefinition)) {
        return;
      }
    }

    throw new DwnError(
      DwnErrorCode.EncryptionProtocolValidateAudienceWriterUnauthorized,
      'audience key records must be authored by a DID authorized to create role records.'
    );
  }

  private static async constructRoleParentChain(
    tenant: string,
    tags: AudienceTags,
    validationStateReader: ValidationStateReader,
  ): Promise<RecordsWriteMessage[]> {
    if (tags.contextId === '') {
      return [];
    }

    const parentRecordId = tags.contextId.split('/').pop();
    if (parentRecordId === undefined || parentRecordId === '') {
      return [];
    }

    return validationStateReader.constructRecordChain(tenant, parentRecordId);
  }

  private static async roleRuleAllowsAuthor(
    tenant: string,
    author: string,
    actionRule: ProtocolActionRule,
    tags: AudienceTags,
    protocolDefinition: ProtocolDefinition,
    validationStateReader: ValidationStateReader,
    invokedRole: string | undefined,
  ): Promise<boolean> {
    if (actionRule.role === undefined || invokedRole !== actionRule.role) {
      return false;
    }

    const roleRef = actionRule.role;
    return EncryptionProtocol.hasInvokedRole(tenant, author, roleRef, tags, protocolDefinition, validationStateReader);
  }

  private static async hasInvokedRole(
    tenant: string,
    author: string,
    roleRef: string,
    tags: AudienceTags,
    protocolDefinition: ProtocolDefinition,
    validationStateReader: ValidationStateReader,
  ): Promise<boolean> {
    const resolved = EncryptionProtocol.resolveRoleReference(roleRef, tags.protocol, protocolDefinition);
    if (resolved === undefined) {
      return false;
    }

    const ancestorDepth = resolved.protocolPath.split('/').length - 1;
    let contextIdPrefix: string | undefined;
    if (ancestorDepth > 0) {
      contextIdPrefix = tags.contextId.split('/').slice(0, ancestorDepth).join('/');
      if (contextIdPrefix === '') {
        return false;
      }
    }

    return validationStateReader.hasMatchingRoleRecord({
      tenant,
      protocol     : resolved.protocol,
      protocolPath : resolved.protocolPath,
      recipient    : author,
      contextIdPrefix,
    });
  }

  private static resolveRoleReference(
    roleRef: string,
    currentProtocol: string,
    protocolDefinition: ProtocolDefinition,
  ): { protocol: string; protocolPath: string } | undefined {
    if (!isCrossProtocolRef(roleRef)) {
      return { protocol: currentProtocol, protocolPath: roleRef };
    }

    const parsed = parseCrossProtocolRef(roleRef);
    if (parsed === undefined) {
      return undefined;
    }

    const protocol = protocolDefinition.uses?.[parsed.alias];
    if (protocol === undefined) {
      return undefined;
    }

    return { protocol, protocolPath: parsed.protocolPath };
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
