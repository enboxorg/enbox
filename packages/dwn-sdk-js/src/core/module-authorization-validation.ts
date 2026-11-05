import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ResolvedModuleNode } from './module-graph.js';
import type { SourceRoleAudienceKeyEncryption } from '../utils/encryption.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ModuleDefinition, ModuleRuleSet, ModuleType, ModuleTypes } from '../types/modules-types.js';

import { getRoleAudienceContextId } from './module-role-records.js';
import { getTypeName } from '../utils/modules.js';
import { KeyDerivationScheme } from '../utils/hd-key.js';
import { ModuleAction } from '../types/modules-types.js';
import { Records } from '../utils/records.js';
import { validateModuleTags } from '../utils/module-tags.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { Encryption, ROLE_AUDIENCE_DERIVATION_SCHEME } from '../utils/encryption.js';
import { ENCRYPTION_MODULE_GRANT_KEY_PATH, ENCRYPTION_MODULE_URI } from './constants.js';

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
  node: ResolvedModuleNode,
): Promise<void> {
  const { parentId, modulePath } = inboundMessage.message.descriptor;
  const expectedParent = node.expectedParent;
  if (parentId === undefined) {
    if (expectedParent !== undefined) {
      throw new DwnError(DwnErrorCode.ModuleAuthorizationParentlessIncorrectModulePath,
        `declared module path '${modulePath}' requires a physical parent.`);
    }
    return;
  }
  if (expectedParent === undefined) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationIncorrectModulePath,
      `root module path '${modulePath}' cannot have a parent.`);
  }
  const parentMessage = await validationStateReader.fetchParentRecord({
    tenant,
    parentModuleUri: expectedParent.owningModuleUri,
    parentId,
  });
  if (parentMessage === undefined) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationParentRecordNotFound,
      `could not find parent record '${parentId}' in module '${expectedParent.owningModuleUri}' for '${modulePath}'.`);
  }
  if (parentMessage.descriptor.module !== expectedParent.owningModuleUri ||
      parentMessage.descriptor.modulePath !== expectedParent.owningModulePath) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationIncorrectModulePath,
      `parent record does not match the resolved parent of module path '${modulePath}'.`);
  }
  const expectedContextId = `${parentMessage.contextId}/${inboundMessage.message.recordId}`;
  if (inboundMessage.message.contextId !== expectedContextId) {
    throw new DwnError(DwnErrorCode.ModuleAuthorizationIncorrectContextId,
      `declared contextId '${inboundMessage.message.contextId}' is not expected context '${expectedContextId}'.`);
  }
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

export async function verifyModulePathEncryptionIfNeeded(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  moduleDefinition: ModuleDefinition,
  resolvedNode: ResolvedModuleNode,
  moduleType: ModuleType,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  if (moduleType.encryptionRequired !== true) {
    return;
  }

  const ruleSet = resolvedNode.ruleSet;
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

  await verifyRoleAudienceEncryptionIfNeeded(tenant, inboundMessage, resolvedNode, validationStateReader);
}

async function verifyRoleAudienceEncryptionIfNeeded(
  tenant: string,
  inboundMessage: RecordsWriteMessage,
  node: ResolvedModuleNode,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  for (const action of node.actions) {
    if (action.resolvedRole === undefined || !action.rule.can.includes(ModuleAction.Read)) {
      continue;
    }
    const role = action.resolvedRole;
    const contextId = getRoleAudienceContextId(role, inboundMessage.contextId);
    if (contextId === undefined) {
      throw new DwnError(DwnErrorCode.ModuleAuthorizationMissingContextId,
        `could not resolve the encryption audience context for '${role.rawRole}'.`);
    }
    await verifyResolvedRoleAudienceEncryption( // NOSONAR: S9382 — bound storage reads and stop at the first invalid role.
      tenant, inboundMessage, {
        module   : role.owningModuleUri,
        rolePath : role.owningModulePath,
        contextId,
      }, validationStateReader);
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
  node: ResolvedModuleNode,
  validationStateReader: ValidationStateReader,
): Promise<void> {
  if (!node.ruleSet.$role) {
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
