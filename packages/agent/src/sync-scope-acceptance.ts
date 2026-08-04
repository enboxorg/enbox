import type { GenericMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, EncryptionProtocol, PermissionsProtocol } from '@enbox/dwn-sdk-js';

import type { SyncScope } from './types/sync.js';

/** Result of testing whether an inbound sync message belongs to a link scope. */
export type SyncScopeClassification = 'in-scope' | 'out-of-scope' | 'unknown';

type SyncMessageScopeClassificationParams = {
  message: GenericMessage;
  initialWrite?: RecordsWriteMessage;
  scope: SyncScope;
};

type ProtocolSetSyncScope = Extract<SyncScope, { kind: 'protocolSet' }>;
type ContextSyncScope = Extract<SyncScope, { kind: 'context' }>;

/**
 * Classifies whether a DWN message belongs to a sync scope before local apply.
 *
 * If a RecordsDelete cannot be tied to its initial write, the result is
 * `unknown` so callers fail closed instead of applying an unclassified delete.
 */
export function classifySyncMessageScope({
  message,
  initialWrite,
  scope,
}: SyncMessageScopeClassificationParams): SyncScopeClassification {
  if (scope.kind === 'full') { return 'in-scope'; }
  if (scope.kind === 'context') { return classifyContextScope(message, initialWrite, scope); }
  return classifyProtocolSetScope(message, initialWrite, scope);
}

function classifyContextScope(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
  scope: ContextSyncScope,
): SyncScopeClassification {
  const isDelete = message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Delete;
  let recordsWrite: RecordsWriteMessage | undefined;
  if (isDelete) {
    recordsWrite = initialWrite;
  } else if (
    message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write
  ) {
    recordsWrite = message as RecordsWriteMessage;
  }
  if (recordsWrite === undefined) {
    return isDelete ? 'unknown' : 'out-of-scope';
  }

  const contextId = recordsWrite.contextId;
  return recordsWrite.descriptor.protocol === scope.protocol &&
    typeof recordsWrite.descriptor.protocolPath === 'string' &&
    scope.protocolPaths.includes(recordsWrite.descriptor.protocolPath) &&
    typeof contextId === 'string' &&
    (contextId === scope.contextId || contextId.startsWith(`${scope.contextId}/`))
    ? 'in-scope'
    : 'out-of-scope';
}

function classifyProtocolSetScope(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
  scope: ProtocolSetSyncScope,
): SyncScopeClassification {
  const descriptor = message.descriptor as Record<string, unknown>;
  const scopedDescriptor = getScopedMessageDescriptor(message, initialWrite);
  if (scopedDescriptor === undefined) {
    return 'unknown';
  }

  const taggedCoreRecordClassification = classifyTaggedCoreProtocolRecord(scopedDescriptor, scope.protocols);
  if (taggedCoreRecordClassification !== undefined) { return taggedCoreRecordClassification; }

  const protocolClassification = classifyProtocolField(scopedDescriptor.protocol, scope.protocols);
  if (protocolClassification !== undefined) { return protocolClassification; }

  return classifyProtocolsConfigureDescriptor(descriptor, scope.protocols);
}

function classifyTaggedCoreProtocolRecord(
  descriptor: Record<string, unknown>,
  protocols: readonly string[],
): SyncScopeClassification | undefined {
  if (
    (descriptor.protocol !== PermissionsProtocol.uri && descriptor.protocol !== EncryptionProtocol.uri) ||
    !isRecordObject(descriptor.tags)
  ) {
    return undefined;
  }

  const taggedProtocol = descriptor.tags.protocol;
  return typeof taggedProtocol === 'string' && protocols.includes(taggedProtocol)
    ? 'in-scope'
    : 'out-of-scope';
}

function classifyProtocolField(protocol: unknown, protocols: readonly string[]): SyncScopeClassification | undefined {
  if (typeof protocol !== 'string') {
    return undefined;
  }

  return protocols.includes(protocol) ? 'in-scope' : 'out-of-scope';
}

function classifyProtocolsConfigureDescriptor(
  descriptor: Record<string, unknown>,
  protocols: readonly string[],
): SyncScopeClassification {
  if (
    descriptor.interface === DwnInterfaceName.Protocols &&
    descriptor.method === DwnMethodName.Configure &&
    isRecordObject(descriptor.definition)
  ) {
    const definitionProtocol = descriptor.definition.protocol;
    return typeof definitionProtocol === 'string' && protocols.includes(definitionProtocol)
      ? 'in-scope'
      : 'out-of-scope';
  }

  return 'out-of-scope';
}

function getScopedMessageDescriptor(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
): Record<string, unknown> | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  if (
    descriptor.interface === DwnInterfaceName.Records &&
    descriptor.method === DwnMethodName.Delete
  ) {
    return initialWrite?.descriptor as Record<string, unknown> | undefined;
  }

  return descriptor;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
