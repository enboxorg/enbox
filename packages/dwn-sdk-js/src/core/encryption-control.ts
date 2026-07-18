import type { MessageStore } from '../types/message-store.js';
import type { RecordsPermissionScope } from '../types/permission-types.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { EncryptionControlAudiencePayload, EncryptionControlDeliveryTags, RoleAudienceKeyId } from '../types/encryption-types.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';
import type { RecordsCountMessage, RecordsFilter, RecordsQueryMessage, RecordsReadMessage, RecordsSubscribeMessage, RecordsWriteMessage } from '../types/records-types.js';

import { checkActor } from './protocol-authorization-action.js';
import { DwnConstant } from './dwn-constant.js';
import { Encoder } from '../utils/encoder.js';
import { Encryption } from '../utils/encryption.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../types/encryption-types.js';
import { GrantAuthorization } from './grant-authorization.js';
import { Jws } from '../utils/jws.js';
import { lexicographicalCompare } from '../utils/string.js';
import { Message } from './message.js';
import { PermissionConditionPublication } from '../types/permission-types.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { PermissionScopeMatcher } from '../utils/permission-scope.js';
import { Records } from '../utils/records.js';
import { selectOccupantRecordIds } from '../utils/record-limit-occupancy.js';
import { SortDirection } from '../types/query-types.js';
import { validateJsonSchema } from '../schema-validator.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH, isEncryptionControlPath } from './constants.js';
import { getRoleContextPrefix, getRuleSetAtPath, isCrossProtocolRef, parseCrossProtocolRef } from '../utils/protocols.js';
import { grantKeyScopeCoversDeliveredScope, isGrantKeyEligibleRecordsScope } from '../utils/grant-key-coverage.js';
import { ProtocolAction, ProtocolActor } from '../types/protocols-types.js';

type RoleAudienceDefinition = {
  protocolDefinition: ProtocolDefinition;
  ruleSet: ProtocolRuleSet;
};

type ValidatedAudiencePayload = {
  payload: EncryptionControlAudiencePayload;
  tags: RoleAudienceKeyId;
};

type EffectiveControlActor = {
  did: string | undefined;
  grant?: PermissionGrant;
};

type ExactAudienceFilterTuple = Omit<RoleAudienceKeyId, 'keyId'> & {
  keyId?: string;
};

type AudienceTuple = Omit<RoleAudienceKeyId, 'keyId'>;

type ControlReadMessage =
  | RecordsCountMessage
  | RecordsReadMessage
  | RecordsQueryMessage
  | RecordsSubscribeMessage;

type ControlFilterMessage =
  | RecordsCountMessage
  | RecordsQueryMessage
  | RecordsSubscribeMessage;

type ControlFilterInput<T extends RecordsWriteMessage> = {
  tenant: string;
  incomingMessage: ControlFilterMessage;
  requester: string | undefined;
  recordsWriteMessages: T[];
  validationStateReader: ValidationStateReader;
};

type ControlRecordVisibilityInput<T extends RecordsWriteMessage> = Omit<ControlFilterInput<T>, 'recordsWriteMessages'> & {
  recordsWriteMessage: T;
};

export class EncryptionControl {
  public static isControlMessage(message: RecordsWriteMessage): boolean {
    return isEncryptionControlPath(message.descriptor.protocolPath);
  }

  public static isAudienceControlMessage(message: RecordsWriteMessage): boolean {
    return message.descriptor.protocolPath === ENCRYPTION_CONTROL_AUDIENCE_PATH;
  }

  public static isExactAudienceFilter(filter: RecordsFilter): boolean {
    return EncryptionControl.getExactAudienceFilterTuple(filter) !== undefined;
  }

  public static filterTargetsOnlyControlRecords(filter: RecordsFilter): boolean {
    return typeof filter.protocolPath === 'string' && isEncryptionControlPath(filter.protocolPath);
  }

  public static async authorizeControlReadRequest(input: {
    tenant: string;
    incomingMessage: ControlReadMessage;
    requester: string | undefined;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    if (input.requester === undefined || input.requester === input.tenant) {
      return;
    }

    await EncryptionControl.getInvokedReadGrants({
      actorDid              : input.requester,
      incomingMessage       : input.incomingMessage,
      tenant                : input.tenant,
      validationStateReader : input.validationStateReader,
    });
  }

  public static buildAudienceRecordFilters(filters: Filter[]): Filter[] {
    const audienceFilters: Filter[] = [];
    for (const filter of filters) {
      const protocolPath = filter.protocolPath;
      if (protocolPath === undefined) {
        audienceFilters.push({ ...filter, protocolPath: ENCRYPTION_CONTROL_AUDIENCE_PATH });
        continue;
      }

      if (typeof protocolPath === 'string') {
        if (protocolPath === ENCRYPTION_CONTROL_AUDIENCE_PATH) {
          audienceFilters.push(filter);
        }
        continue;
      }

      if (Array.isArray(protocolPath) && protocolPath.includes(ENCRYPTION_CONTROL_AUDIENCE_PATH)) {
        audienceFilters.push({ ...filter, protocolPath: ENCRYPTION_CONTROL_AUDIENCE_PATH });
      }
    }

    return audienceFilters;
  }

  /**
   * Resolves the current audience record for a role-audience tuple.
   *
   * Current-key projection orders stored audience records by:
   * tenant-authored actual signer first, then oldest `dateCreated`, then `recordId` ascending.
   */
  public static async resolveCurrentAudienceRecord(input: {
    messageStore: MessageStore;
    tenant: string;
    protocol: string;
    rolePath: string;
    contextId: string;
  }): Promise<RecordsWriteMessage | undefined> {
    const records = await EncryptionControl.queryStoredAudienceRecordsForTuple(input);
    const currentRecordIds = selectOccupantRecordIds({
      records,
      max            : 1,
      getScopeKey    : (record): string => EncryptionControl.getAudienceTupleKey(EncryptionControl.getRoleAudienceKeyId(record, 'audience')),
      compareRecords : (left, right): number => EncryptionControl.compareAudienceProjectionCandidates(input.tenant, left, right),
    });
    const currentRecordId = currentRecordIds.values().next().value as string | undefined;
    return records.find((record): boolean => record.recordId === currentRecordId);
  }

  public static async projectCurrentAudienceRecords<T extends RecordsWriteMessage>(input: {
    messageStore: MessageStore;
    tenant: string;
    recordsWriteMessages: T[];
    bypassFilters?: Filter[];
    currentAudienceRecordIdCache?: Map<string, string | undefined>;
  }): Promise<T[]> {
    const currentRecordIds = new Set<string>();
    const tupleKeys = new Set<string>();

    for (const record of input.recordsWriteMessages) {
      if (!EncryptionControl.shouldProjectAudienceRecord(record, input.bypassFilters ?? [])) {
        continue;
      }

      const tags = EncryptionControl.getRoleAudienceKeyId(record, 'audience');
      tupleKeys.add(EncryptionControl.getAudienceTupleKey(tags));
    }

    for (const tupleKey of tupleKeys) {
      const tuple = EncryptionControl.parseAudienceTupleKey(tupleKey);
      const currentRecordId = await EncryptionControl.resolveCurrentAudienceRecordId({
        ...tuple,
        currentAudienceRecordIdCache : input.currentAudienceRecordIdCache,
        messageStore                 : input.messageStore,
        tenant                       : input.tenant,
      });
      if (currentRecordId !== undefined) {
        currentRecordIds.add(currentRecordId);
      }
    }

    return input.recordsWriteMessages.filter((record): boolean =>
      !EncryptionControl.shouldProjectAudienceRecord(record, input.bypassFilters ?? []) ||
      currentRecordIds.has(record.recordId)
    );
  }

  public static async projectCurrentAudienceRecordPage<T extends RecordsWriteMessage>(input: {
    messageStore: MessageStore;
    tenant: string;
    filters: Filter[];
    result: { messages: T[], cursor?: PaginationCursor };
    currentAudienceRecordIdCache?: Map<string, string | undefined>;
  }): Promise<{ messages: T[], cursor?: PaginationCursor }> {
    return {
      messages: await EncryptionControl.projectCurrentAudienceRecords({
        currentAudienceRecordIdCache : input.currentAudienceRecordIdCache,
        messageStore                 : input.messageStore,
        tenant                       : input.tenant,
        recordsWriteMessages         : input.result.messages,
        bypassFilters                : input.filters,
      }),
      cursor: input.result.cursor,
    };
  }

  public static async filterVisibleControlRecords<T extends RecordsWriteMessage>(input: ControlFilterInput<T>): Promise<T[]> {
    const visibleRecordsWrites: T[] = [];
    for (const recordsWrite of input.recordsWriteMessages) {
      const visible = await EncryptionControl.isVisibleControlRecord({
        incomingMessage       : input.incomingMessage,
        recordsWriteMessage   : recordsWrite,
        requester             : input.requester,
        tenant                : input.tenant,
        validationStateReader : input.validationStateReader,
      });

      if (visible) {
        visibleRecordsWrites.push(recordsWrite);
      }
    }

    return visibleRecordsWrites;
  }

  public static async authorizeRead(input: {
    tenant: string;
    incomingMessage: ControlReadMessage;
    requester: string | undefined;
    recordsWriteMessage: RecordsWriteMessage;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    if (await EncryptionControl.canRead(input)) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionControlReadUnauthorized,
      'requester is not authorized to read the encryption control record.'
    );
  }

  public static async canRead(input: {
    tenant: string;
    incomingMessage: ControlReadMessage;
    requester: string | undefined;
    recordsWriteMessage: RecordsWriteMessage;
    validationStateReader: ValidationStateReader;
  }): Promise<boolean> {
    const { requester, recordsWriteMessage, tenant } = input;
    if (!EncryptionControl.isControlMessage(recordsWriteMessage)) {
      return true;
    }

    if (requester === tenant) {
      return true;
    }

    if (requester === undefined) {
      return false;
    }

    const recordType = EncryptionControl.getRecordType(recordsWriteMessage);
    if (recordType === 'delivery') {
      if (requester === recordsWriteMessage.descriptor.recipient ||
          requester === Message.getAuthor(recordsWriteMessage)) {
        return true;
      }

      return EncryptionControl.canReadDeliveryByDelegatedGrant({
        tenant,
        incomingMessage       : input.incomingMessage,
        requester,
        recordsWriteMessage,
        tags                  : EncryptionControl.getDeliveryTags(recordsWriteMessage),
        validationStateReader : input.validationStateReader,
      });
    }

    const tags = EncryptionControl.getRoleAudienceKeyId(recordsWriteMessage, 'audience');
    if (EncryptionControl.exactAudienceRequestMatchesRecord(input.incomingMessage, tags, recordsWriteMessage.recordId)) {
      return true;
    }

    return EncryptionControl.canEnumerateAudience({
      tenant,
      actorDid              : requester,
      incomingMessage       : input.incomingMessage,
      tags,
      validationStateReader : input.validationStateReader,
    });
  }

  public static async authorizeWrite(
    tenant: string,
    recordsWrite: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    const recordType = EncryptionControl.getRecordType(recordsWrite.message);
    const tags = EncryptionControl.getRoleAudienceKeyId(recordsWrite.message, recordType);
    const { protocolDefinition, ruleSet } = await EncryptionControl.verifyRoleAudienceDefinition(
      tenant, tags, recordsWrite.message, validationStateReader, recordType
    );
    const actor = await EncryptionControl.resolveEffectiveControlActor(tenant, recordsWrite, validationStateReader);

    await EncryptionControl.verifyActorCanCreateRole({
      tenant,
      actor,
      tags,
      protocolDefinition,
      ruleSet,
      validationStateReader,
      message: recordsWrite.message,
    });
  }

  public static async validateReferentialIntegrity(
    tenant: string,
    recordsWrite: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    if (!await recordsWrite.isInitialWrite()) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        'encryption control records are immutable.'
      );
    }

    EncryptionControl.verifyInlineControlRecord(recordsWrite.message);

    const recordType = EncryptionControl.getRecordType(recordsWrite.message);
    if (recordType === 'audience') {
      const tags = EncryptionControl.getRoleAudienceKeyId(recordsWrite.message, 'audience');
      await EncryptionControl.verifyRoleAudienceDefinition(tenant, tags, recordsWrite.message, validationStateReader, 'audience');
      return;
    }

    const tags = EncryptionControl.getDeliveryTags(recordsWrite.message);
    await EncryptionControl.verifyRoleAudienceDefinition(tenant, tags, recordsWrite.message, validationStateReader, 'delivery');
    const audiences = await validationStateReader.queryAudienceRecords({
      tenant,
      protocol  : tags.protocol,
      rolePath  : tags.rolePath,
      contextId : tags.contextId,
      keyId     : tags.keyId,
    });
    if (audiences.length === 0) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateDeliveryAudienceMissing,
        'delivery control record references a missing audience.'
      );
    }
  }

  /**
   * Validates the config-owned invariants of a stored encryption control record.
   *
   * The definition governing the record timestamp is replayed first so a newly learned historical
   * config cannot leave a record that would have failed admission under the complete history. The
   * newest definition then decides whether the role still exists. Live dependency checks (audience
   * lookups, role records, parent chains) are deliberately excluded, and the newest definition does
   * not need `$keyAgreement`: a current definition missing it is recoverable and must not destroy
   * historically valid sealed key material.
   *
   * @returns The role rule set that governed the stored record's timestamp.
   */
  public static async validateStoredControlRecord(
    tenant: string,
    recordsWrite: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<ProtocolRuleSet> {
    const message = recordsWrite.message;
    const recordType = EncryptionControl.getRecordType(message);
    const tags = EncryptionControl.getRoleAudienceKeyId(message, recordType);

    const { ruleSet: governingRuleSet } = await EncryptionControl.verifyRoleAudienceDefinition(
      tenant, tags, message, validationStateReader, recordType
    );
    const encodedData = (message as RecordsWriteMessage & { encodedData?: string }).encodedData;
    if (recordType === 'audience' && encodedData !== undefined) {
      const { payload } = await EncryptionControl.validateAudiencePayload(
        message, Encoder.base64UrlToBytes(encodedData)
      );
      await EncryptionControl.verifyAudienceSealKey(payload, governingRuleSet);
    }

    const newestDefinition = await validationStateReader.fetchProtocolDefinition(tenant, tags.protocol);
    const newestRuleSet = getRuleSetAtPath(tags.rolePath, newestDefinition.structure);
    if (newestRuleSet?.$role !== true) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateAudienceRolePathInvalid,
        `role audience path '${tags.rolePath}' no longer exists as a role in protocol '${tags.protocol}'.`
      );
    }

    return governingRuleSet;
  }

  public static async preProcessWrite(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    EncryptionControl.verifyInlineControlRecord(message);

    switch (message.descriptor.protocolPath) {
    case ENCRYPTION_CONTROL_AUDIENCE_PATH:
      await EncryptionControl.preProcessAudience(tenant, message, validationStateReader);
      return;
    case ENCRYPTION_CONTROL_DELIVERY_PATH:
      await EncryptionControl.preProcessDelivery(tenant, message, validationStateReader);
      return;
    default:
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        `unexpected encryption control path '${message.descriptor.protocolPath}'.`
      );
    }
  }

  public static async validateRecord(input: {
    tenant: string;
    message: RecordsWriteMessage;
    dataBytes: Uint8Array;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const { tenant, message, dataBytes, validationStateReader } = input;

    switch (message.descriptor.protocolPath) {
    case ENCRYPTION_CONTROL_AUDIENCE_PATH:
      await EncryptionControl.validateAudience(tenant, message, dataBytes, validationStateReader);
      return;
    case ENCRYPTION_CONTROL_DELIVERY_PATH:
      EncryptionControl.verifyEncryptedDelivery(message);
      return;
    default:
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        `unexpected encryption control path '${message.descriptor.protocolPath}'.`
      );
    }
  }

  public static mapErrorToStatusCode(errorCode: string): number | undefined {
    if (errorCode.startsWith('EncryptionControlValidate')) {
      return 400;
    }

    return undefined;
  }

  private static async preProcessAudience(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    if (message.encryption !== undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        'audience control records must be plaintext.'
      );
    }

    const tags = EncryptionControl.getRoleAudienceKeyId(message, 'audience');
    await EncryptionControl.verifyRoleAudienceDefinition(tenant, tags, message, validationStateReader, 'audience');
  }

  private static async preProcessDelivery(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    EncryptionControl.verifyEncryptedDelivery(message);

    if (message.descriptor.recipient === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateDeliveryRecipientMissing,
        'delivery control records must have a recipient.'
      );
    }

    const tags = EncryptionControl.getDeliveryTags(message);
    await EncryptionControl.verifyRoleAudienceDefinition(tenant, tags, message, validationStateReader, 'delivery');
    const audiences = await validationStateReader.queryAudienceRecords({
      tenant,
      protocol  : tags.protocol,
      rolePath  : tags.rolePath,
      contextId : tags.contextId,
      keyId     : tags.keyId,
    });
    if (audiences.length === 0) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateDeliveryAudienceMissing,
        'delivery control record references a missing audience.'
      );
    }

    await EncryptionControl.verifyDeliveryRecipientAuthority({
      tenant,
      message,
      tags,
      validationStateReader,
    });
  }

  private static async validateAudience(
    tenant: string,
    message: RecordsWriteMessage,
    dataBytes: Uint8Array,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    const { payload, tags } = await EncryptionControl.validateAudiencePayload(message, dataBytes);
    const { ruleSet } = await EncryptionControl.verifyRoleAudienceDefinition(tenant, tags, message, validationStateReader, 'audience');
    await EncryptionControl.verifyAudienceSealKey(payload, ruleSet);
  }

  private static async validateAudiencePayload(
    message: RecordsWriteMessage,
    dataBytes: Uint8Array,
  ): Promise<ValidatedAudiencePayload> {
    if (message.encryption !== undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        'audience control records must be plaintext.'
      );
    }

    const dataObject = JSON.parse(Encoder.bytesToString(dataBytes)) as EncryptionControlAudiencePayload;
    validateJsonSchema('Audience', dataObject);

    const tags = EncryptionControl.getRoleAudienceKeyId(message, 'audience');
    EncryptionControl.verifyAudiencePayloadMatchesTags(dataObject, tags);

    const audienceKeyId = await Encryption.getKeyId(dataObject.publicKeyJwk);
    if (audienceKeyId !== dataObject.keyId) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateAudienceKeyIdMismatch,
        'audience keyId must match publicKeyJwk thumbprint.'
      );
    }

    return { payload: dataObject, tags };
  }

  private static async verifyAudienceSealKey(
    payload: EncryptionControlAudiencePayload,
    ruleSet: ProtocolRuleSet,
  ): Promise<void> {
    const sealingKeyId = await Encryption.getKeyId(ruleSet.$keyAgreement!.publicKeyJwk);
    if (Object.is(sealingKeyId, payload.sealedPrivateKey.keyId)) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionControlValidateAudienceSealKeyIdMismatch,
      'audience seal keyId must match the role path $keyAgreement public key thumbprint.'
    );
  }

  private static verifyEncryptedDelivery(message: RecordsWriteMessage): void {
    if (message.encryption === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        'delivery control records must be encrypted.'
      );
    }
  }

  private static verifyInlineControlRecord(message: RecordsWriteMessage): void {
    if (message.descriptor.published === true) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        'encryption control records must not be published.'
      );
    }

    if (message.descriptor.dataSize > DwnConstant.maxDataSizeAllowedToBeEncoded) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateUnexpectedRecord,
        'encryption control records must be small enough for inline validation.'
      );
    }
  }

  private static verifyAudiencePayloadMatchesTags(payload: RoleAudienceKeyId, tags: RoleAudienceKeyId): void {
    if (payload.protocol !== tags.protocol ||
        payload.rolePath !== tags.rolePath ||
        payload.contextId !== tags.contextId ||
        payload.keyId !== tags.keyId) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateAudienceTagsMismatch,
        'audience tags must match payload fields.'
      );
    }
  }

  private static async verifyRoleAudienceDefinition(
    tenant: string,
    tags: RoleAudienceKeyId,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
    recordType: 'audience' | 'delivery',
  ): Promise<RoleAudienceDefinition> {
    if (tags.protocol !== message.descriptor.protocol) {
      const errorCode = recordType === 'audience'
        ? DwnErrorCode.EncryptionControlValidateAudienceTagsMismatch
        : DwnErrorCode.EncryptionControlValidateDeliveryTagsMismatch;
      throw new DwnError(
        errorCode,
        'control record protocol tag must match descriptor protocol.'
      );
    }

    return EncryptionControl.resolveRoleAudienceDefinition({
      tenant,
      tags,
      messageTimestamp: message.descriptor.messageTimestamp,
      validationStateReader,
    });
  }

  private static verifyRoleAudienceContext(rolePath: string, contextId: string): void {
    const parentDepth = rolePath.split('/').length - 1;
    if ((parentDepth === 0 && contextId !== '') || (parentDepth > 0 && contextId === '')) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateAudienceContextIdInvalid,
        'role audience contextId is inconsistent with role path depth.'
      );
    }
  }

  private static async resolveEffectiveControlActor(
    tenant: string,
    recordsWrite: RecordsWrite,
    validationStateReader: ValidationStateReader,
  ): Promise<EffectiveControlActor> {
    if (recordsWrite.isSignedByAuthorDelegate) {
      const grant = PermissionGrant.parse(recordsWrite.message.authorization.authorDelegatedGrant!);
      await GrantAuthorization.performBaseValidation({
        incomingMessage : recordsWrite.message,
        expectedGrantor : recordsWrite.author!,
        expectedGrantee : recordsWrite.signer!,
        permissionGrant : grant,
        validationStateReader,
      });
      EncryptionControl.verifyGrantConditions(recordsWrite.message, grant);
      return { did: recordsWrite.signer, grant };
    }

    if (recordsWrite.isSignedByOwnerDelegate) {
      const grant = PermissionGrant.parse(recordsWrite.message.authorization.ownerDelegatedGrant!);
      await GrantAuthorization.performBaseValidation({
        incomingMessage : recordsWrite.message,
        expectedGrantor : recordsWrite.owner!,
        expectedGrantee : recordsWrite.ownerSignatureSigner!,
        permissionGrant : grant,
        validationStateReader,
      });
      EncryptionControl.verifyGrantConditions(recordsWrite.message, grant);
      return { did: recordsWrite.ownerSignatureSigner, grant };
    }

    if (recordsWrite.owner !== undefined) {
      return { did: recordsWrite.owner };
    }

    const directGrantId = recordsWrite.signaturePayload === undefined
      ? undefined
      : Message.getPermissionGrantId(recordsWrite.signaturePayload);
    if (directGrantId === undefined) {
      return { did: recordsWrite.author };
    }

    const grant = await validationStateReader.fetchGrant(tenant, directGrantId);
    await GrantAuthorization.performBaseValidation({
      incomingMessage : recordsWrite.message,
      expectedGrantor : tenant,
      expectedGrantee : recordsWrite.author!,
      permissionGrant : grant,
      validationStateReader,
    });
    EncryptionControl.verifyGrantConditions(recordsWrite.message, grant);
    return { did: recordsWrite.author, grant };
  }

  private static async verifyActorCanCreateRole(input: {
    tenant: string;
    actor: EffectiveControlActor;
    tags: RoleAudienceKeyId;
    protocolDefinition: ProtocolDefinition;
    ruleSet: ProtocolRuleSet;
    validationStateReader: ValidationStateReader;
    message: RecordsWriteMessage;
  }): Promise<void> {
    const { tenant, actor, tags, protocolDefinition, ruleSet, validationStateReader, message } = input;
    const signaturePayload = Jws.decodePlainObjectPayload(message.authorization.signature);
    if (await EncryptionControl.actorCanCreateRole({
      tenant,
      actor,
      tags,
      protocolDefinition,
      ruleSet,
      validationStateReader,
      invokedRole: signaturePayload.protocolRole,
    })) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.EncryptionControlValidateAudienceWriterUnauthorized,
      'control records must be written by a DID authorized to create the referenced role.'
    );
  }

  private static async actorCanCreateRole(input: {
    tenant: string;
    actor: EffectiveControlActor;
    tags: RoleAudienceKeyId;
    protocolDefinition: ProtocolDefinition;
    ruleSet: ProtocolRuleSet;
    validationStateReader: ValidationStateReader;
    invokedRole: string | undefined;
  }): Promise<boolean> {
    const { tenant, actor, tags, protocolDefinition, ruleSet, validationStateReader, invokedRole } = input;
    if (actor.did === tenant) {
      return true;
    }

    if (actor.did === undefined) {
      return false;
    }

    if (actor.grant !== undefined && EncryptionControl.grantCoversRoleCreate(actor.grant, tags)) {
      return true;
    }

    const recordChain = await EncryptionControl.constructRoleParentChain(tenant, tags, validationStateReader);
    for (const actionRule of ruleSet.$actions ?? []) {
      if (!actionRule.can.includes(ProtocolAction.Create)) {
        continue;
      }

      if (actionRule.who === ProtocolActor.Anyone) {
        return true;
      }

      if (await EncryptionControl.roleRuleAllowsActor(
        tenant,
        actor.did,
        actionRule,
        tags,
        protocolDefinition,
        validationStateReader,
        invokedRole,
      )) {
        return true;
      }

      if (await checkActor(actor.did, actionRule, recordChain, protocolDefinition)) {
        return true;
      }
    }

    return false;
  }

  private static async verifyDeliveryRecipientAuthority(input: {
    tenant: string;
    message: RecordsWriteMessage;
    tags: EncryptionControlDeliveryTags;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const { tags } = input;

    if (tags.recipientAuthority !== EncryptionControlDeliveryRecipientAuthority.RoleHolder) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateDeliveryRecipientAuthorityInvalid,
        `unsupported delivery recipient authority '${tags.recipientAuthority}'.`
      );
    }

    if (!await EncryptionControl.deliveryRecipientIsRoleHolder(input)) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateDeliveryRecipientRoleRecordMissing,
        'delivery recipient role record is missing.'
      );
    }
  }

  private static async deliveryRecipientIsRoleHolder(input: {
    tenant: string;
    message: RecordsWriteMessage;
    tags: EncryptionControlDeliveryTags;
    validationStateReader: ValidationStateReader;
  }): Promise<boolean> {
    return EncryptionControl.hasRoleRecord(
      input.tenant,
      input.message.descriptor.recipient!,
      input.tags.protocol,
      input.tags.rolePath,
      input.tags.contextId,
      input.validationStateReader,
    );
  }

  private static grantCoversRoleCreate(grant: PermissionGrant, tags: RoleAudienceKeyId): boolean {
    const scope = grant.scope as RecordsPermissionScope;
    if (scope.interface !== DwnInterfaceName.Records || scope.method !== DwnMethodName.Write) {
      return false;
    }

    return PermissionScopeMatcher.matches(scope, {
      protocol     : tags.protocol,
      protocolPath : tags.rolePath,
    });
  }

  private static async canEnumerateAudience(input: {
    tenant: string;
    actorDid: string;
    incomingMessage: ControlReadMessage;
    tags: RoleAudienceKeyId;
    validationStateReader: ValidationStateReader;
  }): Promise<boolean> {
    const {
      tenant, actorDid, incomingMessage, tags, validationStateReader
    } = input;
    const grants = await EncryptionControl.getInvokedReadGrants({
      tenant,
      actorDid,
      incomingMessage,
      validationStateReader,
    });
    if (grants.some(grant => EncryptionControl.grantCoversAudienceEnumeration(grant, tags))) {
      return true;
    }

    const { protocolDefinition, ruleSet } = await EncryptionControl.resolveRoleAudienceDefinition({
      tenant,
      tags,
      messageTimestamp: incomingMessage.descriptor.messageTimestamp,
      validationStateReader,
    });
    const invokedRole = incomingMessage.authorization === undefined
      ? undefined
      : Jws.decodePlainObjectPayload(incomingMessage.authorization.signature).protocolRole;

    return EncryptionControl.actorCanCreateRole({
      tenant,
      actor: { did: actorDid },
      tags,
      protocolDefinition,
      ruleSet,
      validationStateReader,
      invokedRole,
    });
  }

  private static async canReadDeliveryByDelegatedGrant(input: {
    tenant: string;
    incomingMessage: ControlReadMessage;
    requester: string;
    recordsWriteMessage: RecordsWriteMessage;
    tags: EncryptionControlDeliveryTags;
    validationStateReader: ValidationStateReader;
  }): Promise<boolean> {
    const { tenant, incomingMessage, requester, recordsWriteMessage, tags, validationStateReader } = input;
    const grants = await EncryptionControl.getInvokedReadGrants({
      tenant,
      actorDid: requester,
      incomingMessage,
      validationStateReader,
    });
    const recipient = recordsWriteMessage.descriptor.recipient;
    let protocolDefinition: ProtocolDefinition | undefined;

    for (const grant of grants) {
      if (recipient !== grant.grantor && recipient !== grant.grantee) {
        continue;
      }

      if (!isGrantKeyEligibleRecordsScope(grant.scope) || grant.scope.method !== DwnMethodName.Read) {
        continue;
      }

      const deliveredScope = {
        protocol     : tags.protocol,
        protocolPath : tags.rolePath,
      };

      if (grantKeyScopeCoversDeliveredScope({
        grantScope: grant.scope,
        deliveredScope,
      })) {
        return true;
      }

      protocolDefinition ??= await validationStateReader.fetchProtocolDefinition(
        tenant,
        tags.protocol,
        incomingMessage.descriptor.messageTimestamp,
      );
      if (grantKeyScopeCoversDeliveredScope({
        grantScope: grant.scope,
        deliveredScope,
        protocolDefinition,
      })) {
        return true;
      }
    }

    return false;
  }

  private static async getInvokedReadGrants(input: {
    tenant: string;
    actorDid: string;
    incomingMessage: ControlReadMessage;
    validationStateReader: ValidationStateReader;
  }): Promise<PermissionGrant[]> {
    if (Message.isSignedByAuthorDelegate(input.incomingMessage)) {
      const grant = PermissionGrant.parse(input.incomingMessage.authorization!.authorDelegatedGrant!);
      await GrantAuthorization.performBaseValidation({
        incomingMessage       : input.incomingMessage,
        expectedGrantor       : grant.grantor,
        expectedGrantee       : input.actorDid,
        permissionGrant       : grant,
        validationStateReader : input.validationStateReader,
      });
      return [grant];
    }

    const { descriptor } = input.incomingMessage;
    if (!('permissionGrantId' in descriptor)) {
      return [];
    }

    const grantId = descriptor.permissionGrantId;
    if (grantId === undefined) {
      return [];
    }

    const grant = await input.validationStateReader.fetchGrant(input.tenant, grantId);
    await GrantAuthorization.performBaseValidation({
      incomingMessage       : input.incomingMessage,
      expectedGrantor       : input.tenant,
      expectedGrantee       : input.actorDid,
      permissionGrant       : grant,
      validationStateReader : input.validationStateReader,
    });
    return [grant];
  }

  private static grantCoversAudienceEnumeration(grant: PermissionGrant, tags: RoleAudienceKeyId): boolean {
    const scope = grant.scope as RecordsPermissionScope;
    if (scope.interface !== DwnInterfaceName.Records || scope.method !== DwnMethodName.Read) {
      return false;
    }

    return PermissionScopeMatcher.matches(scope, {
      protocol     : tags.protocol,
      protocolPath : tags.rolePath,
    });
  }

  private static async resolveRoleAudienceDefinition(input: {
    tenant: string;
    tags: RoleAudienceKeyId;
    messageTimestamp: string;
    validationStateReader: ValidationStateReader;
  }): Promise<RoleAudienceDefinition> {
    const { tenant, tags, messageTimestamp, validationStateReader } = input;
    EncryptionControl.verifyRoleAudienceContext(tags.rolePath, tags.contextId);

    const protocolDefinition = await validationStateReader.fetchProtocolDefinition(
      tenant,
      tags.protocol,
      messageTimestamp,
    );
    const ruleSet = getRuleSetAtPath(tags.rolePath, protocolDefinition.structure);

    if (ruleSet?.$role !== true || ruleSet.$keyAgreement === undefined) {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateAudienceRolePathInvalid,
        `role audience path '${tags.rolePath}' must be a role path with $keyAgreement.`
      );
    }

    return { protocolDefinition, ruleSet };
  }

  private static verifyGrantConditions(message: RecordsWriteMessage, grant: PermissionGrant): void {
    if (grant.conditions?.publication === PermissionConditionPublication.Required && message.descriptor.published !== true) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationConditionPublicationRequired,
        'Permission grant requires message to be published'
      );
    }

    if (grant.conditions?.publication === PermissionConditionPublication.Prohibited && message.descriptor.published === true) {
      throw new DwnError(
        DwnErrorCode.RecordsGrantAuthorizationConditionPublicationProhibited,
        'Permission grant prohibits message from being published'
      );
    }
  }

  private static async constructRoleParentChain(
    tenant: string,
    tags: RoleAudienceKeyId,
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

  private static async roleRuleAllowsActor(
    tenant: string,
    actor: string,
    actionRule: ProtocolActionRule,
    tags: RoleAudienceKeyId,
    protocolDefinition: ProtocolDefinition,
    validationStateReader: ValidationStateReader,
    invokedRole: string | undefined,
  ): Promise<boolean> {
    if (actionRule.role === undefined || invokedRole !== actionRule.role) {
      return false;
    }

    const resolved = EncryptionControl.resolveRoleReference(actionRule.role, tags.protocol, protocolDefinition);
    if (resolved === undefined) {
      return false;
    }

    return EncryptionControl.hasRoleRecord(tenant, actor, resolved.protocol, resolved.protocolPath, tags.contextId, validationStateReader);
  }

  private static async hasRoleRecord(
    tenant: string,
    actor: string,
    protocol: string,
    rolePath: string,
    contextId: string,
    validationStateReader: ValidationStateReader,
  ): Promise<boolean> {
    const contextIdPrefix = getRoleContextPrefix(rolePath, contextId);
    if (contextIdPrefix === undefined && rolePath.includes('/')) {
      return false;
    }

    return validationStateReader.hasMatchingRoleRecord({
      tenant,
      protocol,
      protocolPath : rolePath,
      recipient    : actor,
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

  private static getRoleAudienceKeyId(message: RecordsWriteMessage, recordType: 'audience' | 'delivery'): RoleAudienceKeyId {
    return {
      protocol  : EncryptionControl.getRequiredStringTag(message, 'protocol', recordType),
      rolePath  : EncryptionControl.getRequiredStringTag(message, 'rolePath', recordType),
      contextId : EncryptionControl.getRequiredStringTag(message, 'contextId', recordType),
      keyId     : EncryptionControl.getRequiredStringTag(message, 'keyId', recordType),
    };
  }

  private static getDeliveryTags(message: RecordsWriteMessage): EncryptionControlDeliveryTags {
    const tags = EncryptionControl.getRoleAudienceKeyId(message, 'delivery');
    return {
      ...tags,
      recipientAuthority: EncryptionControl.getRequiredStringTag(message, 'recipientAuthority', 'delivery') as EncryptionControlDeliveryTags['recipientAuthority'],
    };
  }

  private static getRecordType(message: RecordsWriteMessage): 'audience' | 'delivery' {
    return message.descriptor.protocolPath === ENCRYPTION_CONTROL_DELIVERY_PATH ? 'delivery' : 'audience';
  }

  private static async isVisibleControlRecord<T extends RecordsWriteMessage>(input: ControlRecordVisibilityInput<T>): Promise<boolean> {
    if (!EncryptionControl.isControlMessage(input.recordsWriteMessage)) {
      return true;
    }

    try {
      return await EncryptionControl.canRead({
        tenant                : input.tenant,
        incomingMessage       : input.incomingMessage,
        requester             : input.requester,
        recordsWriteMessage   : input.recordsWriteMessage,
        validationStateReader : input.validationStateReader,
      });
    } catch (error) {
      if (error instanceof DwnError) {
        return false;
      }
      throw error;
    }
  }

  private static exactAudienceFilterMatchesRecord(filter: RecordsFilter, tags: RoleAudienceKeyId, recordId: string): boolean {
    if (filter.recordId === recordId) {
      return true;
    }

    const tuple = EncryptionControl.getExactAudienceFilterTuple(filter);
    if (tuple === undefined) {
      return false;
    }

    return tuple.protocol === tags.protocol &&
      tuple.rolePath === tags.rolePath &&
      tuple.contextId === tags.contextId &&
      (tuple.keyId === undefined || tuple.keyId === tags.keyId);
  }

  private static getExactAudienceFilterTuple(filter: RecordsFilter): ExactAudienceFilterTuple | undefined {
    if (filter.protocol === undefined || filter.protocolPath !== ENCRYPTION_CONTROL_AUDIENCE_PATH) {
      return undefined;
    }

    const protocol = EncryptionControl.getExactFilterTag(filter, 'protocol');
    const rolePath = EncryptionControl.getExactFilterTag(filter, 'rolePath');
    const contextId = EncryptionControl.getExactFilterTag(filter, 'contextId');
    if (protocol !== filter.protocol || rolePath === undefined || contextId === undefined) {
      return undefined;
    }

    const keyId = EncryptionControl.getExactFilterTag(filter, 'keyId');
    if (keyId === undefined) {
      return { protocol, rolePath, contextId };
    }

    return { protocol, rolePath, contextId, keyId };
  }

  private static exactAudienceRequestMatchesRecord(
    incomingMessage: ControlReadMessage,
    tags: RoleAudienceKeyId,
    recordId: string,
  ): boolean {
    const { descriptor } = incomingMessage;
    if ('filter' in descriptor) {
      return EncryptionControl.exactAudienceFilterMatchesRecord(descriptor.filter, tags, recordId);
    }

    return false;
  }

  private static getExactFilterTag(filter: RecordsFilter, tag: string): string | undefined {
    const value = filter.tags?.[tag];
    return typeof value === 'string' ? value : undefined;
  }

  private static async queryStoredAudienceRecordsForTuple(input: {
    messageStore: MessageStore;
    tenant: string;
    protocol: string;
    rolePath: string;
    contextId: string;
  }): Promise<RecordsWriteMessage[]> {
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      protocol          : input.protocol,
      protocolPath      : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      'tag.protocol'    : input.protocol,
      'tag.rolePath'    : input.rolePath,
      'tag.contextId'   : input.contextId,
    };
    const { messages } = await input.messageStore.query(input.tenant, [filter], { dateCreated: SortDirection.Ascending });
    return messages.filter(Records.isRecordsWrite);
  }

  private static async resolveCurrentAudienceRecordId(input: {
    messageStore: MessageStore;
    tenant: string;
    protocol: string;
    rolePath: string;
    contextId: string;
    currentAudienceRecordIdCache?: Map<string, string | undefined>;
  }): Promise<string | undefined> {
    const tupleKey = EncryptionControl.getAudienceTupleKey(input);
    if (input.currentAudienceRecordIdCache?.has(tupleKey) === true) {
      return input.currentAudienceRecordIdCache.get(tupleKey);
    }

    const current = await EncryptionControl.resolveCurrentAudienceRecord(input);
    const currentRecordId = current?.recordId;
    input.currentAudienceRecordIdCache?.set(tupleKey, currentRecordId);
    return currentRecordId;
  }

  private static shouldProjectAudienceRecord(message: RecordsWriteMessage, bypassFilters: Filter[]): boolean {
    return EncryptionControl.isAudienceControlMessage(message) &&
      !bypassFilters.some((filter): boolean => EncryptionControl.audienceProjectionBypassFilterMatchesRecord(filter, message));
  }

  private static audienceProjectionBypassFilterMatchesRecord(filter: Filter, message: RecordsWriteMessage): boolean {
    if (filter.recordId === message.recordId) {
      return true;
    }

    const tags = EncryptionControl.getRoleAudienceKeyId(message, 'audience');
    return filter.protocol === tags.protocol &&
      filter.protocolPath === ENCRYPTION_CONTROL_AUDIENCE_PATH &&
      filter['tag.protocol'] === tags.protocol &&
      filter['tag.rolePath'] === tags.rolePath &&
      filter['tag.contextId'] === tags.contextId &&
      filter['tag.keyId'] === tags.keyId;
  }

  private static getAudienceTupleKey(input: AudienceTuple): string {
    return JSON.stringify([input.protocol, input.rolePath, input.contextId]);
  }

  private static parseAudienceTupleKey(key: string): AudienceTuple {
    const [protocol, rolePath, contextId] = JSON.parse(key) as string[];
    return { protocol, rolePath, contextId };
  }

  public static compareAudienceProjectionCandidates(
    tenant: string,
    left: RecordsWriteMessage,
    right: RecordsWriteMessage,
  ): number {
    const leftIsTenantSigned = Message.getSigner(left) === tenant;
    const rightIsTenantSigned = Message.getSigner(right) === tenant;
    if (leftIsTenantSigned !== rightIsTenantSigned) {
      return leftIsTenantSigned ? -1 : 1;
    }

    const dateComparison = lexicographicalCompare(left.descriptor.dateCreated, right.descriptor.dateCreated);
    if (dateComparison !== 0) {
      return dateComparison;
    }

    return lexicographicalCompare(left.recordId, right.recordId);
  }

  private static getRequiredStringTag(message: RecordsWriteMessage, tag: string, recordType: 'audience' | 'delivery'): string {
    const value = message.descriptor.tags?.[tag];
    if (typeof value !== 'string') {
      const errorCode = recordType === 'audience'
        ? DwnErrorCode.EncryptionControlValidateAudienceMissingRequiredTag
        : DwnErrorCode.EncryptionControlValidateDeliveryMissingRequiredTag;
      throw new DwnError(
        errorCode,
        `${recordType} control records must include string tag '${tag}'.`
      );
    }

    return value;
  }
}
