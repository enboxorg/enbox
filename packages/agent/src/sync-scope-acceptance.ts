import type { GenericMessage, MessageEvent, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, PermissionsProtocol } from '@enbox/dwn-sdk-js';

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

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
