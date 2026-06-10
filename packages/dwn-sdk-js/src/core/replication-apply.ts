import type { GenericMessage } from '../types/message-types.js';

import { DwnErrorCode } from './dwn-error.js';
import { Encoder } from '../utils/encoder.js';
import { Message } from './message.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type ReplicationApplyOptions = {
  dataStream?: ReadableStream<Uint8Array>;
};

export type ReplicationApplyResult =
  | { kind: 'Applied' }
  | { kind: 'Duplicate' }
  | { kind: 'Superseded' }
  | { kind: 'Incomplete'; missing: DependencyRef[] }
  | { kind: 'Invalid'; reason: string }
  | { kind: 'Deferred'; reason: 'tenant-inactive' | 'resolver-unavailable' | 'storage' };

export type DependencyRef =
  | { type: 'Protocol'; protocol: string; messageCid?: string; terminal?: boolean }
  | { type: 'InitialWrite'; recordId: string; protocol?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Parent'; recordId: string; protocol: string; messageCid?: string; terminal?: boolean }
  | { type: 'Ancestor'; recordId: string; protocol?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Role'; protocol: string; protocolPath: string; recipient: string; contextPrefix?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Grant'; permissionGrantId: string; messageCid?: string; terminal?: boolean }
  | { type: 'KeyDelivery'; protocol: string; contextId: string; messageCid?: string; terminal?: boolean }
  | { type: 'CrossProtocolRef'; protocol: string; recordId: string; messageCid?: string; terminal?: boolean }
  | { type: 'RecordData'; recordId: string; dataCid: string; protocol?: string; messageCid?: string; terminal?: boolean };

/**
 * Converts a regular handler reply into the structured result consumed by
 * replication sync. The DWN handler remains the dependency authority; this
 * adapter only gives the sync transport a typed way to distinguish missing
 * dependencies from terminal invalid messages.
 */
export function replicationApplyResultFromReply(
  message: GenericMessage,
  reply: { status: { code: number; detail?: string } },
): ReplicationApplyResult {
  const { code, detail = '' } = reply.status;

  if (code === 202 || code === 204) {
    return { kind: 'Applied' };
  }

  if (code === 409) {
    return { kind: 'Superseded' };
  }

  if (getDwnErrorCode(detail) === DwnErrorCode.RecordsWriteNotAllowedAfterDelete) {
    return { kind: 'Superseded' };
  }

  if (isResolverFailure(detail)) {
    return { kind: 'Deferred', reason: 'resolver-unavailable' };
  }

  const missing = dependencyRefFromStatus(message, code, detail);
  if (missing !== undefined) {
    return { kind: 'Incomplete', missing: [missing] };
  }

  if (code >= 500) {
    return { kind: 'Deferred', reason: 'storage' };
  }

  return { kind: 'Invalid', reason: detail || `replicated message rejected with status ${code}` };
}

function dependencyRefFromStatus(
  message: GenericMessage,
  code: number,
  detail: string,
): DependencyRef | undefined {
  const errorCode = getDwnErrorCode(detail);
  switch (errorCode) {
  case DwnErrorCode.ProtocolAuthorizationProtocolNotFound:
  case DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled:
    return protocolDependencyFromMessage(message, detail);
  case DwnErrorCode.ProtocolAuthorizationParentRecordNotFound:
  case DwnErrorCode.ProtocolAuthorizationCrossProtocolParentNotFound:
    return parentDependencyFromMessage(message, detail);
  case DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain:
    return ancestorDependencyFromMessage(message, detail);
  case DwnErrorCode.RecordsWriteGetInitialWriteNotFound:
    return initialWriteDependencyFromMessage(message);
  case DwnErrorCode.GrantAuthorizationGrantMissing:
    return grantDependencyFromMessage(message);
  case DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound:
    return roleDependencyFromMessage(message);
  case DwnErrorCode.RecordsWriteMissingDataInPrevious:
  case DwnErrorCode.RecordsWriteMissingEncodedDataInPrevious:
    return recordDataDependencyFromMessage(message);
  default:
    break;
  }

  if (code === 404 && isRecordsDelete(message)) {
    return { type: 'InitialWrite', recordId: getRecordsDeleteRecordId(message) };
  }

  return undefined;
}

function getDwnErrorCode(detail: string): string | undefined {
  const delimiter = detail.indexOf(':');
  return delimiter === -1 ? undefined : detail.slice(0, delimiter);
}

function isResolverFailure(detail: string): boolean {
  return getDwnErrorCode(detail) === DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound;
}

function protocolDependencyFromMessage(message: GenericMessage, detail: string): DependencyRef | undefined {
  const composedProtocol = /composed protocol '([^']+)'/.exec(detail)?.[1];
  if (composedProtocol !== undefined) {
    return { type: 'Protocol', protocol: composedProtocol };
  }

  const protocol = (message.descriptor as Record<string, unknown>).protocol;
  return typeof protocol === 'string' ? { type: 'Protocol', protocol } : undefined;
}

function parentDependencyFromMessage(message: GenericMessage, detail: string): DependencyRef | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  const parentId = typeof descriptor.parentId === 'string'
    ? descriptor.parentId
    : /parent record '([^']+)'/.exec(detail)?.[1];
  const protocol = /in protocol '([^']+)'/.exec(detail)?.[1] ?? descriptor.protocol;

  if (typeof parentId !== 'string' || typeof protocol !== 'string') {
    return undefined;
  }

  return { type: 'Parent', recordId: parentId, protocol };
}

function ancestorDependencyFromMessage(message: GenericMessage, detail: string): DependencyRef | undefined {
  const recordId = /ID ([^ ]+)/.exec(detail)?.[1];
  if (recordId === undefined) {
    return undefined;
  }

  const protocol = (message.descriptor as Record<string, unknown>).protocol;
  return {
    type: 'Ancestor',
    recordId,
    ...(typeof protocol === 'string' ? { protocol } : {}),
  };
}

function initialWriteDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  if (!isRecordsWrite(message)) {
    return undefined;
  }

  const protocol = (message.descriptor as Record<string, unknown>).protocol;
  return {
    type     : 'InitialWrite',
    recordId : message.recordId,
    ...(typeof protocol === 'string' ? { protocol } : {}),
  };
}

function grantDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  const descriptorGrantId = (message.descriptor as Record<string, unknown>).permissionGrantId;
  if (typeof descriptorGrantId === 'string') {
    return { type: 'Grant', permissionGrantId: descriptorGrantId };
  }

  const payloadGrantId = getSignaturePayload(message)?.permissionGrantId;
  return typeof payloadGrantId === 'string'
    ? { type: 'Grant', permissionGrantId: payloadGrantId }
    : undefined;
}

function recordDataDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  if (!isRecordsWrite(message)) {
    return undefined;
  }

  const descriptor = message.descriptor as Record<string, unknown>;
  const dataCid = descriptor.dataCid;
  const protocol = descriptor.protocol;
  return typeof dataCid === 'string'
    ? {
      type     : 'RecordData',
      recordId : message.recordId,
      dataCid,
      ...(typeof protocol === 'string' ? { protocol } : {}),
    }
    : undefined;
}

function roleDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  const protocol = descriptor.protocol;
  const protocolRole = getSignaturePayload(message)?.protocolRole;
  const recipient = Message.getAuthor(message);

  if (typeof protocol !== 'string' || typeof protocolRole !== 'string' || recipient === undefined) {
    return undefined;
  }

  const contextId = typeof descriptor.contextId === 'string' ? descriptor.contextId : undefined;
  const roleSegments = protocolRole.split('/').length - 1;
  const contextPrefix = roleSegments > 0 && contextId !== undefined
    ? contextId.split('/').slice(0, roleSegments).join('/')
    : undefined;

  return {
    type         : 'Role',
    protocol,
    protocolPath : protocolRole,
    recipient,
    ...(contextPrefix === undefined ? {} : { contextPrefix }),
  };
}

function isRecordsWrite(message: GenericMessage): message is GenericMessage & { recordId: string } {
  return message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write &&
    typeof (message as { recordId?: unknown }).recordId === 'string';
}

function isRecordsDelete(message: GenericMessage): boolean {
  return message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Delete;
}

function getRecordsDeleteRecordId(message: GenericMessage): string {
  return (message.descriptor as unknown as { recordId: string }).recordId;
}

function getSignaturePayload(message: GenericMessage): Record<string, unknown> | undefined {
  const payload = message.authorization?.signature.payload;
  if (payload === undefined) {
    return undefined;
  }

  try {
    return Encoder.base64UrlToObject(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
