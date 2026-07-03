import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { LegacyRoleAudienceKeyEncryption, SourceRoleAudienceKeyEncryption } from '../utils/encryption.js';
import type { ProtocolActionRule, ProtocolDefinition, ProtocolRuleSet, ProtocolType, ProtocolTypes } from '../types/protocols-types.js';

import { KeyDerivationScheme } from '../utils/hd-key.js';
import { Records } from '../utils/records.js';
import { validateProtocolTags } from '../utils/protocol-tags.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { Encryption, ROLE_AUDIENCE_DERIVATION_SCHEME } from '../utils/encryption.js';
import { getRoleAudienceContextId, getRuleSetAtPath, getTypeName, parseCrossProtocolRef } from '../utils/protocols.js';
import { ProtocolAction, ProtocolRecordLimitStrategy } from '../types/protocols-types.js';

type ResolvedRoleAudience = {
  contextId: string;
  protocol: string;
  rolePath: string;
};

type RoleAudienceEntryValidationResult = {
  hasAudience: boolean;
  hasEntry: boolean;
};

/**
 * Verifies the `protocolPath` declared in the given message matches the path of actual record chain.
 * For cross-protocol composition, the parent record may belong to a different protocol (resolved via `$ref` in the composing protocol).
 * @throws {DwnError} if fails verification.
 */
export async function verifyProtocolPathAndContextId(
  tenant: string,
  inboundMessage: RecordsWrite,
  validationStateReader: ValidationStateReader,
  protocolDefinitionTimestamp?: string,
): Promise<void> {
  const declaredProtocolPath = inboundMessage.message.descriptor.protocolPath;
  const declaredTypeName = getTypeName(declaredProtocolPath);

  const parentId = inboundMessage.message.descriptor.parentId;
  if (parentId === undefined) {
    if (declaredProtocolPath !== declaredTypeName) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationParentlessIncorrectProtocolPath,
        `Declared protocol path '${declaredProtocolPath}' is not valid for records with no parent'.`
      );
    }

    return;
  }

  // Else `parentId` is defined, so we need to verify both protocolPath and contextId

  // Determine the protocol URI for the parent query.
  // If the parent path segment has a `$ref` in the composing protocol, the parent lives in a different protocol.
  const childProtocol = inboundMessage.message.descriptor.protocol;
  const parentProtocolUri = await resolveParentProtocolUri(
    tenant, childProtocol, declaredProtocolPath, validationStateReader, protocolDefinitionTimestamp
  );

  // fetch the parent message
  const parentMessage = await validationStateReader.fetchParentRecord({
    tenant,
    parentProtocolUri,
    parentId,
  });

  if (parentMessage === undefined) {
    // if this is a cross-protocol composition lookup, use a more descriptive error
    if (parentProtocolUri !== childProtocol) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationCrossProtocolParentNotFound,
        `Could not find parent record '${parentId}' in protocol '${parentProtocolUri}' ` +
        `for cross-protocol child at path '${declaredProtocolPath}'.`
      );
    }

    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationParentRecordNotFound,
      `Could not find parent record '${parentId}' to verify declared protocol path '${declaredProtocolPath}'.`
    );
  }

  // verifying protocolPath of incoming message is a child of the parent message's protocolPath
  const parentProtocolPath = parentMessage.descriptor.protocolPath;
  const expectedProtocolPath = `${parentProtocolPath}/${declaredTypeName}`;
  if (expectedProtocolPath !== declaredProtocolPath) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationIncorrectProtocolPath,
      `Could not find matching parent record to verify declared protocol path '${declaredProtocolPath}'.`
    );
  }

  // verifying contextId of incoming message is a child of the parent message's contextId
  const expectedContextId = `${parentMessage.contextId}/${inboundMessage.message.recordId}`;
  const actualContextId = inboundMessage.message.contextId;
  if (actualContextId !== expectedContextId) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationIncorrectContextId,
      `Declared contextId '${actualContextId}' is not the same as expected: '${expectedContextId}'.`
    );
  }

}

/**
 * Resolves the protocol URI that should be used when querying for the parent record.
 * For standard (non-composed) records, this is the same as the child's protocol.
 * For cross-protocol composition, the parent may live in a different protocol
 * (resolved via `$ref` in the composing protocol's definition).
 *
 * Logic: Given a child at protocolPath `a/b/c`, the parent is at `a/b`.
 * Walk up the composing protocol's structure from root to `a/b`.
 * If any segment along the way has a `$ref`, the parent (and its ancestors up to the `$ref` boundary)
 * live in the referenced protocol. Specifically, the `$ref` at the topmost ancestor tells us
 * the parent's protocol URI.
 */
export async function resolveParentProtocolUri(
  tenant: string,
  childProtocolUri: string,
  childProtocolPath: string,
  validationStateReader: ValidationStateReader,
  protocolDefinitionTimestamp?: string,
): Promise<string> {
  const segments = childProtocolPath.split('/');

  // A root-level record (no `/` in path) has no parent or uses the same protocol
  if (segments.length <= 1) {
    return childProtocolUri;
  }

  // Fetch the composing protocol's definition at the incoming message timestamp
  const composingDefinition = await validationStateReader.fetchProtocolDefinition(
    tenant, childProtocolUri, protocolDefinitionTimestamp
  );

  // Walk the structure to find the parent's path segment
  // The parent's position in the structure is at segments[0..n-2]
  // We check if the first segment has a `$ref`, which means the parent is in a different protocol
  const firstSegmentRuleSet = composingDefinition.structure[segments[0]];
  if (firstSegmentRuleSet?.$ref !== undefined) {
    const parsed = parseCrossProtocolRef(firstSegmentRuleSet.$ref);
    if (parsed !== undefined && composingDefinition.uses !== undefined) {
      const resolvedUri = composingDefinition.uses[parsed.alias];
      if (resolvedUri !== undefined) {
        // The parent path is within the `$ref` boundary — check if the parent IS the `$ref` node
        // or is a descendant of it (which would still be in the composing protocol).
        // If segments.length === 2, parent is at segments[0] which IS the $ref node → parent's protocol is the referenced one.
        // If segments.length > 2, parent is at segments[0..n-2]. If segments[0] is $ref, the parent could be:
        //   - Still the $ref node itself (segments.length === 2) → referenced protocol
        //   - A child of the $ref node defined in the composing protocol (segments.length > 2) → composing protocol
        if (segments.length === 2) {
          // Parent is the $ref node itself (e.g., child is "thread/comment", parent is "thread")
          return resolvedUri;
        }
        // else: parent is a deeper child defined in the composing protocol
        return childProtocolUri;
      }
    }
  }

  return childProtocolUri;
}

/**
 * Verifies the `dataFormat` and `schema` declared in the given message matches the type in the protocol.
 * For cross-protocol composition, if the type is at a `$ref` position in the structure,
 * the type definition is looked up in the referenced protocol's `types` map instead.
 */
export async function verifyTypeWithComposition(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  protocolDefinition: ProtocolDefinition,
  validationStateReader: ValidationStateReader,
  protocolDefinitionTimestamp?: string,
): Promise<void> {
  const declaredProtocolPath = inboundMessage.descriptor.protocolPath;
  const declaredTypeName = getTypeName(declaredProtocolPath);

  // Resolve which protocol types map to use.
  // If the first path segment has `$ref`, this record's type might be defined in a referenced protocol.
  const protocolTypes = await resolveProtocolTypesForPath(
    tenant, declaredProtocolPath, protocolDefinition, validationStateReader, protocolDefinitionTimestamp
  );

  const protocolType = verifyType(inboundMessage, protocolTypes, declaredTypeName);
  await verifyProtocolPathEncryptionIfNeeded(
    tenant,
    inboundMessage,
    protocolDefinition,
    protocolType,
    validationStateReader,
  );
}

/**
 * Resolves the `ProtocolTypes` map that contains the type definition for the given protocol path.
 * For non-composed records, this is the protocol definition's own `types` map.
 * For records at a `$ref` position, this is the referenced protocol's `types` map.
 */
export async function resolveProtocolTypesForPath(
  tenant: string,
  protocolPath: string,
  protocolDefinition: ProtocolDefinition,
  validationStateReader: ValidationStateReader,
  protocolDefinitionTimestamp?: string,
): Promise<ProtocolTypes> {
  const segments = protocolPath.split('/');

  // Check if the first segment has a `$ref`
  const firstSegmentRuleSet = protocolDefinition.structure[segments[0]];
  if (firstSegmentRuleSet?.$ref !== undefined && segments.length === 1) {
    // This record IS the $ref node itself — its type is defined in the referenced protocol
    const parsed = parseCrossProtocolRef(firstSegmentRuleSet.$ref);
    if (parsed !== undefined && protocolDefinition.uses !== undefined) {
      const refProtocolUri = protocolDefinition.uses[parsed.alias];
      if (refProtocolUri !== undefined) {
        const refDefinition = await validationStateReader.fetchProtocolDefinition(
          tenant, refProtocolUri, protocolDefinitionTimestamp
        );
        return refDefinition.types;
      }
    }
  }

  // Default: use the composing protocol's own types
  return protocolDefinition.types;
}

/**
 * Verifies the `dataFormat` and `schema` declared in the given message (if it is a RecordsWrite) matches dataFormat
 * and schema of the type in the given protocol.
 * @throws {DwnError} if fails verification.
 */
export function verifyType(
  inboundMessage: RecordsWriteMessage,
  protocolTypes: ProtocolTypes,
  typeName?: string,
): ProtocolType {
  const declaredTypeName = typeName ?? getTypeName(inboundMessage.descriptor.protocolPath);
  const typeNames = Object.keys(protocolTypes);

  if (!typeNames.includes(declaredTypeName)) {
    throw new DwnError(DwnErrorCode.ProtocolAuthorizationInvalidType,
      `record with type ${declaredTypeName} not allowed in protocol`);
  }

  const protocolType: ProtocolType = protocolTypes[declaredTypeName];

  // no `schema` specified in protocol definition means that any schema is allowed
  const { schema } = inboundMessage.descriptor;
  if (protocolType.schema !== undefined && protocolType.schema !== schema) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationInvalidSchema,
      `type '${declaredTypeName}' must have schema '${protocolType.schema}', \
      instead has '${schema}'`
    );
  }

  // no `dataFormats` specified in protocol definition means that all dataFormats are allowed
  const { dataFormat } = inboundMessage.descriptor;
  if (protocolType.dataFormats !== undefined && !protocolType.dataFormats.includes(dataFormat)) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationIncorrectDataFormat,
      `type '${declaredTypeName}' must have data format in (${protocolType.dataFormats}), \
      instead has '${dataFormat}'`
    );
  }

  // enforce encryption when the protocol type requires it
  if (protocolType.encryptionRequired === true && inboundMessage.encryption === undefined) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationEncryptionRequired,
      `type '${declaredTypeName}' requires encryption but message has no encryption metadata`
    );
  }

  return protocolType;
}

async function verifyProtocolPathEncryptionIfNeeded(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  protocolDefinition: ProtocolDefinition,
  protocolType: ProtocolType,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  if (protocolType.encryptionRequired !== true) {
    return;
  }

  const ruleSet = getRuleSetAtPath(inboundMessage.descriptor.protocolPath, protocolDefinition.structure);
  if (ruleSet?.$keyAgreement?.publicKeyJwk === undefined) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationEncryptionKeyAgreementMissing,
      `encrypted protocol path '${inboundMessage.descriptor.protocolPath}' has no $keyAgreement`
    );
  }

  const publicKeyJwk = ruleSet.$keyAgreement.publicKeyJwk;
  const keyId = await Encryption.getKeyId(publicKeyJwk);
  const hasProtocolPathEntry = inboundMessage.encryption!.keyEncryption.some((entry): boolean =>
    entry.derivationScheme === KeyDerivationScheme.ProtocolPath && entry.keyId === keyId
  );

  if (!hasProtocolPathEntry) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationEncryptionProtocolPathEntryMissing,
      `encrypted record is missing a protocolPath keyEncryption entry for '${inboundMessage.descriptor.protocolPath}'`
    );
  }

  await verifyRoleAudienceEncryptionIfNeeded(tenant, inboundMessage, protocolDefinition, ruleSet, validationStateReader);
}

async function verifyRoleAudienceEncryptionIfNeeded(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  protocolDefinition: ProtocolDefinition,
  ruleSet: ProtocolRuleSet,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  const readRoleRules = (ruleSet.$actions ?? []).filter((actionRule): boolean =>
    actionRule.role !== undefined && actionRule.can.includes(ProtocolAction.Read)
  );

  for (const actionRule of readRoleRules) {
    const roleAudience = resolveRoleAudience(actionRule, inboundMessage, protocolDefinition);
    if (roleAudience === undefined) {
      continue;
    }

    await verifyResolvedRoleAudienceEncryption(tenant, inboundMessage, roleAudience, validationStateReader);
  }
}

async function verifyResolvedRoleAudienceEncryption(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  roleAudience: ResolvedRoleAudience,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  const sourceEntryValidation = await validateSourceRoleAudienceEntry(tenant, roleAudience, inboundMessage, validationStateReader);
  if (sourceEntryValidation.hasAudience) {
    return;
  }

  const legacyEntryValidation = await validateLegacyRoleAudienceEntry(tenant, roleAudience, inboundMessage, validationStateReader);
  if (legacyEntryValidation.hasAudience) {
    return;
  }

  if (!sourceEntryValidation.hasEntry && !legacyEntryValidation.hasEntry) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationEncryptionRoleAudienceEntryMissing,
      `encrypted record is missing a roleAudience keyEncryption entry for role '${roleAudience.rolePath}'`
    );
  }

  throw new DwnError(
    DwnErrorCode.ProtocolAuthorizationEncryptionRoleAudienceEpochMissing,
    `encrypted record references a missing audience for role '${roleAudience.rolePath}'`
  );
}

async function validateSourceRoleAudienceEntry(
  tenant: string,
  roleAudience: ResolvedRoleAudience,
  inboundMessage: RecordsWriteMessage,
  validationStateReader: ValidationStateReader,
): Promise<RoleAudienceEntryValidationResult> {
  const matchingEntries = inboundMessage.encryption!.keyEncryption.filter((entry): entry is SourceRoleAudienceKeyEncryption =>
    entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
    entry.protocol === roleAudience.protocol &&
    'rolePath' in entry &&
    entry.rolePath === roleAudience.rolePath
  );

  if (matchingEntries.length === 0) {
    return { hasAudience: false, hasEntry: false };
  }

  for (const matchingEntry of matchingEntries) {
    const matchingAudienceRecords = await validationStateReader.queryAudienceRecords({
      tenant,
      protocol  : roleAudience.protocol,
      contextId : roleAudience.contextId,
      rolePath  : roleAudience.rolePath,
      keyId     : matchingEntry.keyId,
    });

    if (matchingAudienceRecords.length > 0) {
      return { hasAudience: true, hasEntry: true };
    }
  }

  return { hasAudience: false, hasEntry: true };
}

async function validateLegacyRoleAudienceEntry(
  tenant: string,
  roleAudience: ResolvedRoleAudience,
  inboundMessage: RecordsWriteMessage,
  validationStateReader: ValidationStateReader,
): Promise<RoleAudienceEntryValidationResult> {
  const matchingLegacyEntries = inboundMessage.encryption!.keyEncryption.filter((entry): entry is LegacyRoleAudienceKeyEncryption =>
    entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
    entry.protocol === roleAudience.protocol &&
    'role' in entry &&
    entry.role === roleAudience.rolePath &&
    'epoch' in entry
  );

  if (matchingLegacyEntries.length === 0) {
    return { hasAudience: false, hasEntry: false };
  }

  for (const matchingLegacyEntry of matchingLegacyEntries) {
    const matchingEpochs = await validationStateReader.queryAudienceEpochs({
      tenant,
      protocol  : roleAudience.protocol,
      contextId : roleAudience.contextId,
      role      : roleAudience.rolePath,
      epoch     : matchingLegacyEntry.epoch,
      keyId     : matchingLegacyEntry.keyId,
    });

    if (matchingEpochs.length > 0) {
      return { hasAudience: true, hasEntry: true };
    }
  }

  return { hasAudience: false, hasEntry: true };
}

function resolveRoleAudience(
  actionRule: ProtocolActionRule,
  inboundMessage: RecordsWriteMessage,
  protocolDefinition: ProtocolDefinition,
): ResolvedRoleAudience | undefined {
  const roleRef = actionRule.role;
  if (roleRef === undefined) {
    return undefined;
  }

  const parsed = parseCrossProtocolRef(roleRef);
  const protocol = parsed === undefined
    ? inboundMessage.descriptor.protocol
    : protocolDefinition.uses?.[parsed.alias];
  const rolePath = parsed === undefined ? roleRef : parsed.protocolPath;
  if (protocol === undefined) {
    return undefined;
  }

  const contextId = getRoleAudienceContextId(rolePath, inboundMessage.contextId);
  return contextId === undefined ? undefined : { protocol, rolePath, contextId };
}

/**
 * Verifies that writes adhere to the $size constraints if provided
 * @throws {Error} if size is exceeded.
 */
export function verifySizeLimit(
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet
): void {
  const { min = 0, max } = ruleSet.$size || {};

  const dataSize = incomingMessage.message.descriptor.dataSize;

  if (dataSize < min) {
    throw new DwnError(DwnErrorCode.ProtocolAuthorizationMinSizeInvalid, `data size ${dataSize} is less than allowed ${min}`);
  }

  if (max === undefined) {
    return;
  }

  if (dataSize > max) {
    throw new DwnError(DwnErrorCode.ProtocolAuthorizationMaxSizeInvalid, `data size ${dataSize} is more than allowed ${max}`);
  }
}

/**
 * Verifies record tags against the `$tags` schema in the rule set.
 * Checks required tags, additional properties, and schema conformance.
 */
export function verifyTagsIfNeeded(
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet
): void {
  if (ruleSet.$tags !== undefined) {
    const { tags = {}, protocol, protocolPath } = incomingMessage.message.descriptor;
    const schemaError = validateProtocolTags(
      ruleSet.$tags,
      tags,
      `${protocol}/${protocolPath}/$tags`,
    );

    if (schemaError !== undefined) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationTagsInvalidSchema, `tags schema validation error: ${schemaError}`);
    }
  }
}

/**
 * If the given RecordsWrite is not a role record, this method does nothing and succeeds immediately.
 *
 * Else it verifies the validity of the given `RecordsWrite` as a role record, including:
 * 1. The same role has not been assigned to the same entity/recipient.
 */
export async function verifyAsRoleRecordIfNeeded(
  tenant: string,
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  if (!ruleSet.$role) {
    return;
  }

  // else this is a role record

  const incomingRecordsWrite = incomingMessage;
  const recipient = incomingRecordsWrite.message.descriptor.recipient;
  if (recipient === undefined) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationRoleMissingRecipient,
      'Role records must have a recipient'
    );
  }

  const protocolPath = incomingRecordsWrite.message.descriptor.protocolPath;
  const parentContextId = Records.getParentContextFromOfContextId(incomingRecordsWrite.message.contextId)!;

  // if this is not the root record, scope the role-record query to the parent context
  const matchingRecords = await validationStateReader.queryLatestRoleRecords({
    tenant,
    protocol        : incomingRecordsWrite.message.descriptor.protocol,
    protocolPath,
    recipient,
    contextIdPrefix : parentContextId === '' ? undefined : parentContextId,
  });

  const matchingRecordsExceptIncomingRecordId = matchingRecords.filter((recordsWriteMessage: RecordsWriteMessage): boolean =>
    recordsWriteMessage.recordId !== incomingRecordsWrite.message.recordId
  );
  if (matchingRecordsExceptIncomingRecordId.length > 0) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationDuplicateRoleRecipient,
      `DID '${recipient}' is already recipient of a role record at protocol path '${protocolPath} under the parent context ${parentContextId}.`
    );
  }
}

/**
 * Verifies that the `$recordLimit` strategy is supported for a new record creation.
 *
 * This check only applies to initial writes (new records). Updates to existing records do not
 * affect record-limit occupancy. The supported `reject` strategy admits every candidate and
 * projects the visible occupant set at read time, so validation stays independent of arrival order.
 *
 * @throws {DwnError} with `ProtocolAuthorizationRecordLimitStrategyNotImplemented` if strategy is not implemented.
 */
export async function verifyRecordLimit(
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet,
): Promise<void> {
  if (ruleSet.$recordLimit === undefined) {
    return;
  }

  // Only initial writes can introduce a new record-limit candidate.
  const isInitialWrite = await incomingMessage.isInitialWrite();
  if (!isInitialWrite) {
    return;
  }

  const { strategy } = ruleSet.$recordLimit;
  if (strategy !== ProtocolRecordLimitStrategy.Reject) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationRecordLimitStrategyNotImplemented,
      `record limit strategy '${strategy}' is not yet implemented.`
    );
  }
}

/**
 * Verifies that a `RecordsWrite` with `squash: true` is eligible:
 * 1. The protocol rule set at the record's `protocolPath` must have `$squash: true`.
 * 2. The squash write must be an initial write (a new record, not an update).
 *
 * @throws {DwnError} with `ProtocolAuthorizationSquashNotEnabled` if `$squash` is not enabled.
 * @throws {DwnError} with `ProtocolAuthorizationSquashNotInitialWrite` if the squash write is not an initial write.
 */
export async function verifySquashEligibility(
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet,
): Promise<void> {
  const squash = incomingMessage.message.descriptor.squash;

  if (squash !== true) {
    return;
  }

  // squash write must be at a protocol path with $squash: true
  if (ruleSet.$squash !== true) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationSquashNotEnabled,
      `squash writes are not enabled at protocol path '${incomingMessage.message.descriptor.protocolPath}': ` +
      `rule set must have $squash: true.`
    );
  }

  // squash write must be an initial write (a new record, not an update)
  const isInitialWrite = await incomingMessage.isInitialWrite();
  if (!isInitialWrite) {
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationSquashNotInitialWrite,
      `squash write must be an initial write (a new record): updates cannot be squash writes.`
    );
  }
}

/**
 * Verifies that an update is not attempted on a record whose protocol path has `$immutable: true`.
 *
 * Only non-initial writes (updates) are rejected — initial writes are always allowed.
 * `RecordsDelete` is not affected by this check; immutability prevents data mutation, not removal.
 *
 * @throws {DwnError} with `ProtocolAuthorizationImmutableRecord` if an update is attempted on an immutable record.
 */
export async function verifyImmutability(
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet,
): Promise<void> {
  if (ruleSet.$immutable !== true) {
    return;
  }

  const isInitialWrite = await incomingMessage.isInitialWrite();
  if (isInitialWrite) {
    return;
  }

  throw new DwnError(
    DwnErrorCode.ProtocolAuthorizationImmutableRecord,
    `record at protocol path '${incomingMessage.message.descriptor.protocolPath}' is immutable: updates are not allowed.`
  );
}
