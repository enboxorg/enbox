import type { RecordsPermissionScope } from '../types/permission-types.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { EncryptionControlAudiencePayload, EncryptionControlDeliveryTags, RoleAudienceKeyId } from '../types/encryption-types.js';
import type { ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet } from '../types/protocols-types.js';
import type { RecordsCountMessage, RecordsFilter, RecordsQueryMessage, RecordsReadMessage, RecordsSubscribeMessage, RecordsWriteMessage, RecordsWriteTags } from '../types/records-types.js';

import { checkActor } from './protocol-authorization-action.js';
import { DwnConstant } from './dwn-constant.js';
import { Encoder } from '../utils/encoder.js';
import { Encryption } from '../utils/encryption.js';
import { EncryptionControlDeliveryRecipientAuthority } from '../types/encryption-types.js';
import { GrantAuthorization } from './grant-authorization.js';
import { Jws } from '../utils/jws.js';
import { Message } from './message.js';
import { PermissionConditionPublication } from '../types/permission-types.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { PermissionScopeMatcher } from '../utils/permission-scope.js';
import { validateJsonSchema } from '../schema-validator.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH, isEncryptionControlPath } from './constants.js';
import { getRuleSetAtPath, isCrossProtocolRef, parseCrossProtocolRef } from '../utils/protocols.js';
import { ProtocolAction, ProtocolActor } from '../types/protocols-types.js';

type RoleAudienceDefinition = {
  protocolDefinition: ProtocolDefinition;
  ruleSet: ProtocolRuleSet;
};

type EffectiveControlActor = {
  did: string | undefined;
  grant?: PermissionGrant;
};

type ExactAudienceFilterTuple = Omit<RoleAudienceKeyId, 'keyId'> & {
  keyId?: string;
};

export class EncryptionControl {
  public static isControlMessage(message: RecordsWriteMessage): boolean {
    return isEncryptionControlPath(message.descriptor.protocolPath);
  }

  public static getRequester(
    message: RecordsCountMessage | RecordsReadMessage | RecordsQueryMessage | RecordsSubscribeMessage,
  ): string | undefined {
    return Message.isSignedByAuthorDelegate(message) ? Message.getSigner(message) : Message.getAuthor(message);
  }

  public static isExactAudienceFilter(filter: RecordsFilter): boolean {
    return EncryptionControl.getExactAudienceFilterTuple(filter) !== undefined;
  }

  public static async filterVisibleControlRecords<T extends RecordsWriteMessage>(input: {
    tenant: string;
    incomingMessage: RecordsCountMessage | RecordsQueryMessage | RecordsSubscribeMessage;
    requester: string | undefined;
    recordsWriteMessages: T[];
    validationStateReader: ValidationStateReader;
  }): Promise<T[]> {
    const visibleRecordsWrites: T[] = [];
    for (const recordsWrite of input.recordsWriteMessages) {
      if (!EncryptionControl.isControlMessage(recordsWrite)) {
        visibleRecordsWrites.push(recordsWrite);
        continue;
      }

      try {
        if (await EncryptionControl.canRead({
          tenant                : input.tenant,
          incomingMessage       : input.incomingMessage,
          requester             : input.requester,
          recordsWriteMessage   : recordsWrite,
          validationStateReader : input.validationStateReader,
        })) {
          visibleRecordsWrites.push(recordsWrite);
        }
      } catch (error) {
        if (!(error instanceof DwnError)) {
          throw error;
        }
      }
    }

    return visibleRecordsWrites;
  }

  public static async authorizeRead(input: {
    tenant: string;
    incomingMessage: RecordsCountMessage | RecordsReadMessage | RecordsQueryMessage | RecordsSubscribeMessage;
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
    incomingMessage: RecordsCountMessage | RecordsReadMessage | RecordsQueryMessage | RecordsSubscribeMessage;
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
      return requester === recordsWriteMessage.descriptor.recipient ||
        requester === Message.getAuthor(recordsWriteMessage);
    }

    const tags = EncryptionControl.getRoleAudienceKeyId(recordsWriteMessage, 'audience');
    if (EncryptionControl.exactAudienceFilterMatchesRecord(input.incomingMessage.descriptor.filter, tags, recordsWriteMessage.recordId)) {
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
    const { protocolDefinition, ruleSet } = await EncryptionControl.verifyRoleAudienceDefinition(
      tenant, tags, message, validationStateReader, 'delivery'
    );
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
      protocolDefinition,
      ruleSet,
      validationStateReader,
    });
  }

  private static async validateAudience(
    tenant: string,
    message: RecordsWriteMessage,
    dataBytes: Uint8Array,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
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

    const { ruleSet } = await EncryptionControl.verifyRoleAudienceDefinition(tenant, tags, message, validationStateReader, 'audience');
    const sealingKeyId = await Encryption.getKeyId(ruleSet.$keyAgreement!.publicKeyJwk);
    if (Object.is(sealingKeyId, dataObject.sealedPrivateKey.keyId)) {
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
    protocolDefinition: ProtocolDefinition;
    ruleSet: ProtocolRuleSet;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const { tags } = input;

    switch (tags.recipientAuthority) {
    case EncryptionControlDeliveryRecipientAuthority.RoleHolder:
      if (await EncryptionControl.deliveryRecipientIsRoleHolder(input)) {
        return;
      }
      break;
    case EncryptionControlDeliveryRecipientAuthority.RoleCreatorGrant:
      if (await EncryptionControl.deliveryRecipientHasRoleCreateGrant(input)) {
        return;
      }
      break;
    case EncryptionControlDeliveryRecipientAuthority.RoleCreatorRole:
      if (await EncryptionControl.deliveryRecipientHasRoleCreateRole(input)) {
        return;
      }
      break;
    case EncryptionControlDeliveryRecipientAuthority.RoleCreatorAnyone:
      if (EncryptionControl.anyoneCanCreateRole(input.ruleSet)) {
        return;
      }
      break;
    default:
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateDeliveryRecipientAuthorityInvalid,
        `unsupported delivery recipient authority '${tags.recipientAuthority}'.`
      );
    }

    throw new DwnError(
      DwnErrorCode.EncryptionControlValidateDeliveryRecipientUnauthorized,
      'delivery recipient is not authorized for the referenced audience.'
    );
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

  private static async deliveryRecipientHasRoleCreateGrant(input: {
    tenant: string;
    message: RecordsWriteMessage;
    tags: EncryptionControlDeliveryTags;
    validationStateReader: ValidationStateReader;
  }): Promise<boolean> {
    if (input.tags.grantId === undefined) {
      return false;
    }

    const grant = await input.validationStateReader.fetchGrant(input.tenant, input.tags.grantId);
    await GrantAuthorization.performBaseValidation({
      incomingMessage       : input.message,
      expectedGrantor       : input.tenant,
      expectedGrantee       : input.message.descriptor.recipient!,
      permissionGrant       : grant,
      validationStateReader : input.validationStateReader,
    });
    return EncryptionControl.grantCoversRoleCreate(grant, input.tags);
  }

  private static async deliveryRecipientHasRoleCreateRole(input: {
    tenant: string;
    message: RecordsWriteMessage;
    tags: EncryptionControlDeliveryTags;
    protocolDefinition: ProtocolDefinition;
    ruleSet: ProtocolRuleSet;
    validationStateReader: ValidationStateReader;
  }): Promise<boolean> {
    if (input.tags.roleRef === undefined) {
      return false;
    }

    for (const actionRule of input.ruleSet.$actions ?? []) {
      if (!actionRule.can.includes(ProtocolAction.Create) || actionRule.role !== input.tags.roleRef) {
        continue;
      }

      if (await EncryptionControl.roleRuleAllowsActor(
        input.tenant,
        input.message.descriptor.recipient!,
        actionRule,
        input.tags,
        input.protocolDefinition,
        input.validationStateReader,
        input.tags.roleRef,
      )) {
        return true;
      }
    }

    return false;
  }

  private static anyoneCanCreateRole(ruleSet: ProtocolRuleSet): boolean {
    return (ruleSet.$actions ?? []).some((actionRule: ProtocolActionRule): boolean =>
      actionRule.who === ProtocolActor.Anyone && actionRule.can.includes(ProtocolAction.Create)
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
    incomingMessage: RecordsCountMessage | RecordsReadMessage | RecordsQueryMessage | RecordsSubscribeMessage;
    tags: RoleAudienceKeyId;
    validationStateReader: ValidationStateReader;
  }): Promise<boolean> {
    const {
      tenant, actorDid, incomingMessage, tags, validationStateReader
    } = input;
    const grant = await EncryptionControl.getInvokedReadGrant({
      tenant,
      actorDid,
      incomingMessage,
      validationStateReader,
    });
    if (grant !== undefined && EncryptionControl.grantCoversAudienceEnumeration(grant, tags)) {
      return true;
    }

    const { protocolDefinition, ruleSet } = await EncryptionControl.getRoleAudienceDefinition({
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

  private static async getInvokedReadGrant(input: {
    tenant: string;
    actorDid: string;
    incomingMessage: RecordsCountMessage | RecordsReadMessage | RecordsQueryMessage | RecordsSubscribeMessage;
    validationStateReader: ValidationStateReader;
  }): Promise<PermissionGrant | undefined> {
    if (Message.isSignedByAuthorDelegate(input.incomingMessage)) {
      return PermissionGrant.parse(input.incomingMessage.authorization!.authorDelegatedGrant!);
    }

    const grantId = input.incomingMessage.descriptor.permissionGrantId;
    if (grantId === undefined) {
      return undefined;
    }

    const grant = await input.validationStateReader.fetchGrant(input.tenant, grantId);
    await GrantAuthorization.performBaseValidation({
      incomingMessage       : input.incomingMessage,
      expectedGrantor       : input.tenant,
      expectedGrantee       : input.actorDid,
      permissionGrant       : grant,
      validationStateReader : input.validationStateReader,
    });
    return grant;
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

  private static async getRoleAudienceDefinition(input: {
    tenant: string;
    tags: RoleAudienceKeyId;
    messageTimestamp: string;
    validationStateReader: ValidationStateReader;
  }): Promise<RoleAudienceDefinition> {
    return EncryptionControl.resolveRoleAudienceDefinition(input);
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
    const ancestorDepth = rolePath.split('/').length - 1;
    let contextIdPrefix: string | undefined;
    if (ancestorDepth > 0) {
      contextIdPrefix = contextId.split('/').slice(0, ancestorDepth).join('/');
      if (contextIdPrefix === '') {
        return false;
      }
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
      recipientAuthority : EncryptionControl.getRequiredStringTag(message, 'recipientAuthority', 'delivery') as EncryptionControlDeliveryTags['recipientAuthority'],
      grantId            : EncryptionControl.getOptionalStringTag(message.descriptor.tags, 'grantId'),
      roleRef            : EncryptionControl.getOptionalStringTag(message.descriptor.tags, 'roleRef'),
    };
  }

  private static getRecordType(message: RecordsWriteMessage): 'audience' | 'delivery' {
    return message.descriptor.protocolPath === ENCRYPTION_CONTROL_DELIVERY_PATH ? 'delivery' : 'audience';
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

  private static getExactFilterTag(filter: RecordsFilter, tag: string): string | undefined {
    const value = filter.tags?.[tag];
    return typeof value === 'string' ? value : undefined;
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

  private static getOptionalStringTag(tags: RecordsWriteTags | undefined, tag: string): string | undefined {
    const value = tags?.[tag];
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new DwnError(
        DwnErrorCode.EncryptionControlValidateDeliveryMissingRequiredTag,
        `delivery control tag '${tag}' must be a string.`
      );
    }

    return value;
  }
}
