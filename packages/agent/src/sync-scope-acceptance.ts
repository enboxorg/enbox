import type { GenericMessage, MessageEvent, ProtocolScope, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, PermissionScopeMatcher, PermissionsProtocol } from '@enbox/dwn-sdk-js';

import type { SyncScope } from './types/sync.js';

/** Result of testing whether an inbound sync message belongs to a link scope. */
export type SyncScopeClassification = 'in-scope' | 'out-of-scope' | 'unknown';

type SyncMessageScopeClassificationParams = {
  message: GenericMessage;
  initialWrite?: RecordsWriteMessage;
  scope: SyncScope;
};

/**
 * Classifies whether a live event belongs to the link's current sync scope.
 *
 * Full links accept every message. Protocol-set links accept records for a
 * covered protocol, ProtocolsConfigure messages that install a covered
 * protocol, and permission records tagged for a covered protocol. RecordsDelete
 * messages carry no protocol in their descriptor, so they must be classified
 * from the event's initial write metadata.
 */
export function classifySyncEventScope(event: MessageEvent, scope: SyncScope): SyncScopeClassification {
  return classifySyncMessageScope({
    message      : event.message,
    initialWrite : event.initialWrite,
    scope,
  });
}

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
  if (scope.kind === 'recordsProjection') {
    return classifyRecordsProjectionScope(message, initialWrite, scope);
  }

  const descriptor = message.descriptor as Record<string, unknown>;
  const scopedDescriptor = getScopedMessageDescriptor(message, initialWrite);
  if (scopedDescriptor === undefined) {
    return 'unknown';
  }

  const protocol = scopedDescriptor.protocol;
  if (protocol === PermissionsProtocol.uri && isRecordObject(scopedDescriptor.tags)) {
    const taggedProtocol = scopedDescriptor.tags.protocol;
    return typeof taggedProtocol === 'string' && scope.protocols.includes(taggedProtocol)
      ? 'in-scope'
      : 'out-of-scope';
  }

  if (typeof protocol === 'string') {
    return scope.protocols.includes(protocol) ? 'in-scope' : 'out-of-scope';
  }

  if (
    descriptor.interface === DwnInterfaceName.Protocols &&
    descriptor.method === DwnMethodName.Configure &&
    isRecordObject(descriptor.definition)
  ) {
    const definitionProtocol = descriptor.definition.protocol;
    return typeof definitionProtocol === 'string' && scope.protocols.includes(definitionProtocol)
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

function classifyRecordsProjectionScope(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
  scope: Extract<SyncScope, { kind: 'recordsProjection' }>,
): SyncScopeClassification {
  const target = getRecordsProjectionTarget(message, initialWrite);
  if (target === undefined) {
    return isRecordsDelete(message) ? 'unknown' : 'out-of-scope';
  }

  return scope.scopes.some(projectionScope => PermissionScopeMatcher.matches(projectionScope, target))
    ? 'in-scope'
    : 'out-of-scope';
}

function getRecordsProjectionTarget(
  message: GenericMessage,
  initialWrite: RecordsWriteMessage | undefined,
): ProtocolScope | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  if (descriptor.interface !== DwnInterfaceName.Records) {
    return undefined;
  }

  if (descriptor.method === DwnMethodName.Write) {
    return {
      protocol     : stringField(descriptor.protocol),
      protocolPath : stringField(descriptor.protocolPath),
      contextId    : (message as RecordsWriteMessage).contextId,
    };
  }

  if (descriptor.method === DwnMethodName.Delete) {
    if (initialWrite === undefined) {
      return undefined;
    }
    return {
      protocol     : initialWrite.descriptor.protocol,
      protocolPath : initialWrite.descriptor.protocolPath,
      contextId    : initialWrite.contextId,
    };
  }
}

function isRecordsDelete(message: GenericMessage): boolean {
  const descriptor = message.descriptor as Record<string, unknown>;
  return descriptor.interface === DwnInterfaceName.Records &&
    descriptor.method === DwnMethodName.Delete;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
