import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { SourceRoleAudienceKeyEncryption } from '../utils/encryption.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ModuleActionRule, ModuleDefinition, ModuleRuleSet, ModuleType, ModuleTypes } from '../types/modules-types.js';

import { KeyDerivationScheme } from '../utils/hd-key.js';
import { ModuleAction } from '../types/modules-types.js';
import { Records } from '../utils/records.js';
import { validateModuleTags } from '../utils/module-tags.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { Encryption, ROLE_AUDIENCE_DERIVATION_SCHEME } from '../utils/encryption.js';
import { ENCRYPTION_MODULE_GRANT_KEY_PATH, ENCRYPTION_MODULE_URI } from './constants.js';
import { getRoleAudienceContextId, getRuleSetAtPath, getTypeName, parseCrossModuleRef } from '../utils/modules.js';

type ResolvedRoleAudience = {
  contextId: string;
  module: string;
  rolePath: string;
};

type RoleAudienceEntryValidationResult = {
  hasAudience: boolean;
  hasEntry: boolean;
};

/**
 * Verifies the `modulePath` declared in the given message matches the path of actual record chain.
 * For cross-module composition, the parent record may belong to a different module (resolved via `$ref` in the composing module).
 * @throws {DwnError} if fails verification.
 */
export async function verifyModulePathAndContextId(
  tenant: string,
  inboundMessage: RecordsWrite,
  validationStateReader: ValidationStateReader,
  moduleDefinitionTimestamp?: string,
): Promise<void> {
  const declaredModulePath = inboundMessage.message.descriptor.modulePath;
  const declaredTypeName = getTypeName(declaredModulePath);

  const parentId = inboundMessage.message.descriptor.parentId;
  if (parentId === undefined) {
    if (declaredModulePath !== declaredTypeName) {
      throw new DwnError(
        DwnErrorCode.ModuleAuthorizationParentlessIncorrectModulePath,
        `Declared module path '${declaredModulePath}' is not valid for records with no parent'.`
      );
    }

    return;
  }

  // Else `parentId` is defined, so we need to verify both modulePath and contextId

  // Determine the module URI for the parent query.
  // If the parent path segment has a `$ref` in the composing module, the parent lives in a different module.
  const childModule = inboundMessage.message.descriptor.module;
  const parentModuleUri = await resolveParentModuleUri(
    tenant, childModule, declaredModulePath, validationStateReader, moduleDefinitionTimestamp
  );

  // fetch the parent message
  const parentMessage = await validationStateReader.fetchParentRecord({
    tenant,
    parentModuleUri,
    parentId,
  });

  if (parentMessage === undefined) {
    // A missing parent and a pruned parent are indistinguishable here; the replication apply
    // layer classifies a prune tombstone as terminal locally via `parentRecordPrunedFromReply`. This
    // keeps the client-facing reply from leaking whether a record was pruned.
    // If this is a cross-module composition lookup, use a more descriptive error.
    if (parentModuleUri !== childModule) {
      throw new DwnError(
        DwnErrorCode.ModuleAuthorizationCrossModuleParentNotFound,
        `Could not find parent record '${parentId}' in module '${parentModuleUri}' ` +
        `for cross-module child at path '${declaredModulePath}'.`
      );
    }

    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationParentRecordNotFound,
      `Could not find parent record '${parentId}' to verify declared module path '${declaredModulePath}'.`
    );
  }

  // verifying modulePath of incoming message is a child of the parent message's modulePath
  const parentModulePath = parentMessage.descriptor.modulePath;
  const expectedModulePath = `${parentModulePath}/${declaredTypeName}`;
  if (expectedModulePath !== declaredModulePath) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationIncorrectModulePath,
      `Could not find matching parent record to verify declared module path '${declaredModulePath}'.`
    );
  }

  // verifying contextId of incoming message is a child of the parent message's contextId
  const expectedContextId = `${parentMessage.contextId}/${inboundMessage.message.recordId}`;
  const actualContextId = inboundMessage.message.contextId;
  if (actualContextId !== expectedContextId) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationIncorrectContextId,
      `Declared contextId '${actualContextId}' is not the same as expected: '${expectedContextId}'.`
    );
  }

}

/**
 * Resolves the module URI that should be used when querying for the parent record.
 * For standard (non-composed) records, this is the same as the child's module.
 * For cross-module composition, the parent may live in a different module
 * (resolved via `$ref` in the composing module's definition).
 *
 * Logic: Given a child at modulePath `a/b/c`, the parent is at `a/b`.
 * Walk up the composing module's structure from root to `a/b`.
 * If any segment along the way has a `$ref`, the parent (and its ancestors up to the `$ref` boundary)
 * live in the referenced module. Specifically, the `$ref` at the topmost ancestor tells us
 * the parent's module URI.
 */
export async function resolveParentModuleUri(
  tenant: string,
  childModuleUri: string,
  childModulePath: string,
  validationStateReader: ValidationStateReader,
  moduleDefinitionTimestamp?: string,
): Promise<string> {
  const segments = childModulePath.split('/');

  // A root-level record (no `/` in path) has no parent or uses the same module
  if (segments.length <= 1) {
    return childModuleUri;
  }

  // Fetch the composing module's definition at the incoming message timestamp
  const composingDefinition = await validationStateReader.fetchModuleDefinition(
    tenant, childModuleUri, moduleDefinitionTimestamp
  );

  // Walk the structure to find the parent's path segment
  // The parent's position in the structure is at segments[0..n-2]
  // We check if the first segment has a `$ref`, which means the parent is in a different module
  const firstSegmentRuleSet = composingDefinition.structure[segments[0]];
  if (firstSegmentRuleSet?.$ref !== undefined) {
    const parsed = parseCrossModuleRef(firstSegmentRuleSet.$ref);
    if (parsed !== undefined && composingDefinition.uses !== undefined) {
      const resolvedUri = composingDefinition.uses[parsed.alias];
      if (resolvedUri !== undefined) {
        // The parent path is within the `$ref` boundary — check if the parent IS the `$ref` node
        // or is a descendant of it (which would still be in the composing module).
        // If segments.length === 2, parent is at segments[0] which IS the $ref node → parent's module is the referenced one.
        // If segments.length > 2, parent is at segments[0..n-2]. If segments[0] is $ref, the parent could be:
        //   - Still the $ref node itself (segments.length === 2) → referenced module
        //   - A child of the $ref node defined in the composing module (segments.length > 2) → composing module
        if (segments.length === 2) {
          // Parent is the $ref node itself (e.g., child is "thread/comment", parent is "thread")
          return resolvedUri;
        }
        // else: parent is a deeper child defined in the composing module
        return childModuleUri;
      }
    }
  }

  return childModuleUri;
}

/**
 * Verifies the `dataFormat` and `schema` declared in the given message matches the type in the module.
 * For cross-module composition, if the type is at a `$ref` position in the structure,
 * the type definition is looked up in the referenced module's `types` map instead.
 */
export async function verifyTypeWithComposition(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  moduleDefinition: ModuleDefinition,
  validationStateReader: ValidationStateReader,
  moduleDefinitionTimestamp?: string,
): Promise<void> {
  const declaredModulePath = inboundMessage.descriptor.modulePath;
  const declaredTypeName = getTypeName(declaredModulePath);

  // Resolve which module types map to use.
  // If the first path segment has `$ref`, this record's type might be defined in a referenced module.
  const moduleTypes = await resolveModuleTypesForPath(
    tenant, declaredModulePath, moduleDefinition, validationStateReader, moduleDefinitionTimestamp
  );

  const moduleType = verifyType(inboundMessage, moduleTypes, declaredTypeName);
  await verifyModulePathEncryptionIfNeeded(
    tenant,
    inboundMessage,
    moduleDefinition,
    moduleType,
    validationStateReader,
  );
}

/**
 * Resolves the `ModuleTypes` map that contains the type definition for the given module path.
 * For non-composed records, this is the module definition's own `types` map.
 * For records at a `$ref` position, this is the referenced module's `types` map.
 */
export async function resolveModuleTypesForPath(
  tenant: string,
  modulePath: string,
  moduleDefinition: ModuleDefinition,
  validationStateReader: ValidationStateReader,
  moduleDefinitionTimestamp?: string,
): Promise<ModuleTypes> {
  const segments = modulePath.split('/');

  // Check if the first segment has a `$ref`
  const firstSegmentRuleSet = moduleDefinition.structure[segments[0]];
  if (firstSegmentRuleSet?.$ref !== undefined && segments.length === 1) {
    // This record IS the $ref node itself — its type is defined in the referenced module
    const parsed = parseCrossModuleRef(firstSegmentRuleSet.$ref);
    if (parsed !== undefined && moduleDefinition.uses !== undefined) {
      const refModuleUri = moduleDefinition.uses[parsed.alias];
      if (refModuleUri !== undefined) {
        const refDefinition = await validationStateReader.fetchModuleDefinition(
          tenant, refModuleUri, moduleDefinitionTimestamp
        );
        return refDefinition.types;
      }
    }
  }

  // Default: use the composing module's own types
  return moduleDefinition.types;
}

/**
 * Verifies the `dataFormat` and `schema` declared in the given message (if it is a RecordsWrite) matches dataFormat
 * and schema of the type in the given module.
 * @throws {DwnError} if fails verification.
 */
export function verifyType(
  inboundMessage: RecordsWriteMessage,
  moduleTypes: ModuleTypes,
  typeName?: string,
): ModuleType {
  const declaredTypeName = typeName ?? getTypeName(inboundMessage.descriptor.modulePath);
  const typeNames = Object.keys(moduleTypes);

  if (!typeNames.includes(declaredTypeName)) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationInvalidType,
      `record with type ${declaredTypeName} not allowed in module`);
  }

  const moduleType: ModuleType = moduleTypes[declaredTypeName];

  // no `schema` specified in module definition means that any schema is allowed
  const { schema } = inboundMessage.descriptor;
  if (moduleType.schema !== undefined && moduleType.schema !== schema) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationInvalidSchema,
      `type '${declaredTypeName}' must have schema '${moduleType.schema}', \
      instead has '${schema}'`
    );
  }

  // no `dataFormats` specified in module definition means that all dataFormats are allowed
  const { dataFormat } = inboundMessage.descriptor;
  if (moduleType.dataFormats !== undefined && !moduleType.dataFormats.includes(dataFormat)) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationIncorrectDataFormat,
      `type '${declaredTypeName}' must have data format in (${moduleType.dataFormats}), \
      instead has '${dataFormat}'`
    );
  }

  // enforce encryption when the module type requires it
  if (moduleType.encryptionRequired === true && inboundMessage.encryption === undefined) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationEncryptionRequired,
      `type '${declaredTypeName}' requires encryption but message has no encryption metadata`
    );
  }

  if (moduleType.encryptionRequired !== true && inboundMessage.encryption !== undefined) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationEncryptionNotAllowed,
      `type '${declaredTypeName}' requires plaintext but message has encryption metadata`
    );
  }

  return moduleType;
}

async function verifyModulePathEncryptionIfNeeded(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  moduleDefinition: ModuleDefinition,
  moduleType: ModuleType,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  if (moduleType.encryptionRequired !== true) {
    return;
  }

  const ruleSet = getRuleSetAtPath(inboundMessage.descriptor.modulePath, moduleDefinition.structure);
  if (ruleSet?.$keyAgreement?.publicKeyJwk === undefined) {
    const usesDynamicCoreRecipientKey = moduleDefinition.module === ENCRYPTION_MODULE_URI &&
      inboundMessage.descriptor.modulePath === ENCRYPTION_MODULE_GRANT_KEY_PATH;
    if (usesDynamicCoreRecipientKey) {
      return;
    }

    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationEncryptionKeyAgreementMissing,
      `encrypted module path '${inboundMessage.descriptor.modulePath}' has no $keyAgreement`
    );
  }

  const publicKeyJwk = ruleSet.$keyAgreement.publicKeyJwk;
  const keyId = await Encryption.getKeyId(publicKeyJwk);
  const hasModulePathEntry = inboundMessage.encryption!.keyEncryption.some((entry): boolean =>
    entry.derivationScheme === KeyDerivationScheme.ModulePath && entry.keyId === keyId
  );

  if (!hasModulePathEntry) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationEncryptionModulePathEntryMissing,
      `encrypted record is missing a modulePath keyEncryption entry for '${inboundMessage.descriptor.modulePath}'`
    );
  }

  await verifyRoleAudienceEncryptionIfNeeded(tenant, inboundMessage, moduleDefinition, ruleSet, validationStateReader);
}

async function verifyRoleAudienceEncryptionIfNeeded(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  moduleDefinition: ModuleDefinition,
  ruleSet: ModuleRuleSet,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  const readRoleRules = (ruleSet.$actions ?? []).filter((actionRule): boolean =>
    actionRule.role !== undefined && actionRule.can.includes(ModuleAction.Read)
  );

  for (const actionRule of readRoleRules) {
    const roleAudience = resolveRoleAudience(actionRule, inboundMessage, moduleDefinition);
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

  if (!sourceEntryValidation.hasEntry) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceEntryMissing,
      `encrypted record is missing a roleAudience keyEncryption entry for role '${roleAudience.rolePath}'`
    );
  }

  throw new DwnError(
    DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceMissing,
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
    entry.module === roleAudience.module &&
    'rolePath' in entry &&
    entry.rolePath === roleAudience.rolePath
  );

  if (matchingEntries.length === 0) {
    return { hasAudience: false, hasEntry: false };
  }

  for (const matchingEntry of matchingEntries) {
    const matchingAudienceRecords = await validationStateReader.queryAudienceRecords({
      tenant,
      module    : roleAudience.module,
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

function resolveRoleAudience(
  actionRule: ModuleActionRule,
  inboundMessage: RecordsWriteMessage,
  moduleDefinition: ModuleDefinition,
): ResolvedRoleAudience | undefined {
  const roleRef = actionRule.role;
  if (roleRef === undefined) {
    return undefined;
  }

  const parsed = parseCrossModuleRef(roleRef);
  const module = parsed === undefined
    ? inboundMessage.descriptor.module
    : moduleDefinition.uses?.[parsed.alias];
  const rolePath = parsed === undefined ? roleRef : parsed.modulePath;
  if (module === undefined) {
    return undefined;
  }

  const contextId = getRoleAudienceContextId(rolePath, inboundMessage.contextId);
  return contextId === undefined ? undefined : { module, rolePath, contextId };
}

/**
 * Verifies that writes adhere to the $size constraints if provided
 * @throws {Error} if size is exceeded.
 */
export function verifySizeLimit(
  incomingMessage: RecordsWrite,
  ruleSet: ModuleRuleSet
): void {
  const { min = 0, max } = ruleSet.$size || {};

  const dataSize = incomingMessage.message.descriptor.dataSize;

  if (dataSize < min) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationMinSizeInvalid, `data size ${dataSize} is less than allowed ${min}`);
  }

  if (max === undefined) {
    return;
  }

  if (dataSize > max) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationMaxSizeInvalid, `data size ${dataSize} is more than allowed ${max}`);
  }
}

/**
 * Verifies record tags against the `$tags` schema in the rule set.
 * Checks required tags, additional properties, and schema conformance.
 */
export function verifyTagsIfNeeded(
  incomingMessage: RecordsWrite,
  ruleSet: ModuleRuleSet
): void {
  if (ruleSet.$tags !== undefined) {
    const { tags = {}, module, modulePath } = incomingMessage.message.descriptor;
    const schemaError = validateModuleTags(
      ruleSet.$tags,
      tags,
      `${module}/${modulePath}/$tags`,
    );

    if (schemaError !== undefined) {
      throw new DwnError(DwnErrorCode.ModuleAuthorizationTagsInvalidSchema, `tags schema validation error: ${schemaError}`);
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
  ruleSet: ModuleRuleSet,
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
      DwnErrorCode.ModuleAuthorizationRoleMissingRecipient,
      'Role records must have a recipient'
    );
  }

  const modulePath = incomingRecordsWrite.message.descriptor.modulePath;
  const parentContextId = Records.getParentContextFromOfContextId(incomingRecordsWrite.message.contextId)!;

  // if this is not the root record, scope the role-record query to the parent context
  const matchingRecords = await validationStateReader.queryLatestRoleRecords({
    tenant,
    module          : incomingRecordsWrite.message.descriptor.module,
    modulePath,
    recipient,
    contextIdPrefix : parentContextId === '' ? undefined : parentContextId,
  });

  const matchingRecordsExceptIncomingRecordId = matchingRecords.filter((recordsWriteMessage: RecordsWriteMessage): boolean =>
    recordsWriteMessage.recordId !== incomingRecordsWrite.message.recordId
  );
  if (matchingRecordsExceptIncomingRecordId.length > 0) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationDuplicateRoleRecipient,
      `DID '${recipient}' is already recipient of a role record at module path '${modulePath} under the parent context ${parentContextId}.`
    );
  }
}

/**
 * Verifies that a `RecordsWrite` with `squash: true` is eligible:
 * 1. The module rule set at the record's `modulePath` must have `$squash: true`.
 * 2. The squash write must be an initial write (a new record, not an update).
 *
 * @throws {DwnError} with `ModuleAuthorizationSquashNotEnabled` if `$squash` is not enabled.
 * @throws {DwnError} with `ModuleAuthorizationSquashNotInitialWrite` if the squash write is not an initial write.
 */
export async function verifySquashEligibility(
  incomingMessage: RecordsWrite,
  ruleSet: ModuleRuleSet,
): Promise<void> {
  const squash = incomingMessage.message.descriptor.squash;

  if (squash !== true) {
    return;
  }

  // squash write must be at a module path with $squash: true
  if (ruleSet.$squash !== true) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationSquashNotEnabled,
      `squash writes are not enabled at module path '${incomingMessage.message.descriptor.modulePath}': ` +
      `rule set must have $squash: true.`
    );
  }

  // squash write must be an initial write (a new record, not an update)
  const isInitialWrite = await incomingMessage.isInitialWrite();
  if (!isInitialWrite) {
    throw new DwnError(
      DwnErrorCode.ModuleAuthorizationSquashNotInitialWrite,
      `squash write must be an initial write (a new record): updates cannot be squash writes.`
    );
  }
}

/**
 * Verifies that an update is not attempted on a record whose module path has `$immutable: true`.
 *
 * Only non-initial writes (updates) are rejected — initial writes are always allowed.
 * `RecordsDelete` is not affected by this check; immutability prevents data mutation, not removal.
 *
 * @throws {DwnError} with `ModuleAuthorizationImmutableRecord` if an update is attempted on an immutable record.
 */
export async function verifyImmutability(
  incomingMessage: RecordsWrite,
  ruleSet: ModuleRuleSet,
): Promise<void> {
  if (ruleSet.$immutable !== true) {
    return;
  }

  const isInitialWrite = await incomingMessage.isInitialWrite();
  if (isInitialWrite) {
    return;
  }

  throw new DwnError(
    DwnErrorCode.ModuleAuthorizationImmutableRecord,
    `record at module path '${incomingMessage.message.descriptor.modulePath}' is immutable: updates are not allowed.`
  );
}
