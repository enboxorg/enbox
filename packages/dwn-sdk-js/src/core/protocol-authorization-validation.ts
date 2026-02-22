import type { Filter } from '../types/query-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type { ProtocolDefinition, ProtocolRuleSet, ProtocolType, ProtocolTypes } from '../types/protocols-types.js';

import { ProtocolRecordLimitStrategy } from '../types/protocols-types.js';

import type { RecordsWrite } from '../interfaces/records-write.js';

import Ajv from 'ajv/dist/2020.js';
import { FilterUtility } from '../utils/filter.js';
import { Records } from '../utils/records.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getTypeName, parseCrossProtocolRef } from '../utils/protocols.js';

import type { FetchProtocolDefinitionFn } from './protocol-authorization.js';

/**
 * Verifies the `protocolPath` declared in the given message matches the path of actual record chain.
 * For cross-protocol composition, the parent record may belong to a different protocol (resolved via `$ref` in the composing protocol).
 * @throws {DwnError} if fails verification.
 */
export async function verifyProtocolPathAndContextId(
  tenant: string,
  inboundMessage: RecordsWrite,
  messageStore: MessageStore,
  fetchProtocolDefinition: FetchProtocolDefinitionFn,
  governingTimestamp?: string,
): Promise<void> {
  const declaredProtocolPath = inboundMessage.message.descriptor.protocolPath!;
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
  const childProtocol = inboundMessage.message.descriptor.protocol!;
  const parentProtocolUri = await resolveParentProtocolUri(
    tenant, childProtocol, declaredProtocolPath, messageStore, fetchProtocolDefinition, governingTimestamp
  );

  // fetch the parent message
  const query: Filter = {
    isLatestBaseState : true, // NOTE: this filter is critical, to ensure are are not returning a deleted parent
    interface         : DwnInterfaceName.Records,
    method            : DwnMethodName.Write,
    protocol          : parentProtocolUri,
    recordId          : parentId
  };
  const { messages: parentMessages } = await messageStore.query(tenant, [query]);
  const parentMessage = (parentMessages as RecordsWriteMessage[])[0];

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
      DwnErrorCode.ProtocolAuthorizationIncorrectProtocolPath,
      `Could not find matching parent record to verify declared protocol path '${declaredProtocolPath}'.`
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
  messageStore: MessageStore,
  fetchProtocolDefinition: FetchProtocolDefinitionFn,
  governingTimestamp?: string,
): Promise<string> {
  const segments = childProtocolPath.split('/');

  // A root-level record (no `/` in path) has no parent or uses the same protocol
  if (segments.length <= 1) {
    return childProtocolUri;
  }

  // Fetch the composing protocol's definition at the governing timestamp
  const composingDefinition = await fetchProtocolDefinition(
    tenant, childProtocolUri, messageStore, governingTimestamp
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
  messageStore: MessageStore,
  fetchProtocolDefinition: FetchProtocolDefinitionFn,
  governingTimestamp?: string,
): Promise<void> {
  const declaredProtocolPath = inboundMessage.descriptor.protocolPath!;
  const declaredTypeName = getTypeName(declaredProtocolPath);

  // Resolve which protocol types map to use.
  // If the first path segment has `$ref`, this record's type might be defined in a referenced protocol.
  const protocolTypes = await resolveProtocolTypesForPath(
    tenant, declaredProtocolPath, protocolDefinition, messageStore, fetchProtocolDefinition, governingTimestamp
  );

  verifyType(inboundMessage, protocolTypes, declaredTypeName);
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
  messageStore: MessageStore,
  fetchProtocolDefinition: FetchProtocolDefinitionFn,
  governingTimestamp?: string,
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
        const refDefinition = await fetchProtocolDefinition(
          tenant, refProtocolUri, messageStore, governingTimestamp
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
): void {
  const declaredTypeName = typeName ?? getTypeName(inboundMessage.descriptor.protocolPath!);
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
 * Verifies record tags against the `$tags` schema in the rule set using JSON Schema (Ajv).
 * Checks required tags, additional properties, and schema conformance.
 */
export function verifyTagsIfNeeded(
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet
): void {
  if (ruleSet.$tags !== undefined) {
    const { tags = {}, protocol, protocolPath } = incomingMessage.message.descriptor;

    const { $allowUndefinedTags, $requiredTags, ...properties } = ruleSet.$tags;

    // if $allowUndefinedTags is set to false and there are properties not defined in the schema, an error is thrown
    const additionalProperties = $allowUndefinedTags || false;

    // if $requiredTags is set, all required tags must be present
    const required = $requiredTags || [];

    const ajv = new Ajv.default();
    const compiledTags = ajv.compile({
      type: 'object',
      properties,
      required,
      additionalProperties,
    });

    const validSchema = compiledTags(tags);
    if (!validSchema) {
      // the `dataVar` is used to add a qualifier to the error message.
      // For example. If the error is related to a tag `status` in a protocol `https://example.protocol` with the protocolPath `example/path`
      // the error would be described as `https://example.protocol/example/path/$tags/status'
      // without this decorator it would show up as `data/status` which may be confusing.
      const schemaError = ajv.errorsText(compiledTags.errors, { dataVar: `${protocol}/${protocolPath}/$tags` });
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
  messageStore: MessageStore,
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

  const protocolPath = incomingRecordsWrite.message.descriptor.protocolPath!;
  const filter: Filter = {
    interface         : DwnInterfaceName.Records,
    method            : DwnMethodName.Write,
    isLatestBaseState : true,
    protocol          : incomingRecordsWrite.message.descriptor.protocol!,
    protocolPath,
    recipient,
  };

  const parentContextId = Records.getParentContextFromOfContextId(incomingRecordsWrite.message.contextId)!;

  // if this is not the root record, add a prefix filter to the query
  if (parentContextId !== '') {
    const prefixFilter = FilterUtility.constructPrefixFilterAsRangeFilter(parentContextId);
    filter.contextId = prefixFilter;
  }

  const { messages: matchingMessages } = await messageStore.query(tenant, [filter]);
  const matchingRecords = matchingMessages as RecordsWriteMessage[];
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
 * Verifies that a new record creation does not exceed the `$recordLimit` defined in the rule set.
 *
 * This check only applies to initial writes (new records). Updates to existing records are not counted.
 * The count is scoped to the same `protocol + protocolPath` within the parent context:
 * - For root-level records: counted across the entire protocol for the tenant.
 * - For nested records: counted within the parent record's context.
 *
 * @throws {DwnError} with `ProtocolAuthorizationRecordLimitExceeded` if the limit is reached and strategy is `reject`.
 * @throws {DwnError} with `ProtocolAuthorizationRecordLimitStrategyNotImplemented` if strategy is not yet implemented.
 */
export async function verifyRecordLimit(
  tenant: string,
  incomingMessage: RecordsWrite,
  ruleSet: ProtocolRuleSet,
  messageStore: MessageStore,
): Promise<void> {
  if (ruleSet.$recordLimit === undefined) {
    return;
  }

  // Only enforce on initial writes — updates to existing records do not count as new records.
  const isInitialWrite = await incomingMessage.isInitialWrite();
  if (!isInitialWrite) {
    return;
  }

  const { max, strategy } = ruleSet.$recordLimit;

  // Build a filter to count existing records at the same protocol path and parent context.
  const protocolPath = incomingMessage.message.descriptor.protocolPath!;
  const filter: Filter = {
    interface         : DwnInterfaceName.Records,
    method            : DwnMethodName.Write,
    isLatestBaseState : true,
    protocol          : incomingMessage.message.descriptor.protocol!,
    protocolPath,
  };

  // Scope by parent context for nested records.
  const parentContextId = Records.getParentContextFromOfContextId(incomingMessage.message.contextId)!;
  if (parentContextId !== '') {
    const prefixFilter = FilterUtility.constructPrefixFilterAsRangeFilter(parentContextId);
    filter.contextId = prefixFilter;
  }

  const existingCount = await messageStore.count(tenant, [filter]);

  if (existingCount >= max) {
    if (strategy === ProtocolRecordLimitStrategy.Reject) {
      throw new DwnError(
        DwnErrorCode.ProtocolAuthorizationRecordLimitExceeded,
        `record limit of ${max} reached at protocol path '${protocolPath}'` +
        `${parentContextId !== '' ? ` under parent context '${parentContextId}'` : ''}` +
        `: new records are rejected until existing records are deleted.`
      );
    }

    // Future strategies (e.g. purgeOldest) will be implemented here.
    // For now, any non-reject strategy that somehow passes schema validation is rejected.
    throw new DwnError(
      DwnErrorCode.ProtocolAuthorizationRecordLimitStrategyNotImplemented,
      `record limit strategy '${strategy}' is not yet implemented.`
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
