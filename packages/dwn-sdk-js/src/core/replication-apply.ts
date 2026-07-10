import type { EncryptionControlPath } from './constants.js';
import type { GenericMessage } from '../types/message-types.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { ProtocolDefinition } from '../types/protocols-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

import { DwnErrorCode } from './dwn-error.js';
import { Encoder } from '../utils/encoder.js';
import { EncryptionProtocol } from '../protocols/encryption.js';
import { Message } from './message.js';
import { ROLE_AUDIENCE_DERIVATION_SCHEME } from '../utils/encryption.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH } from './constants.js';
import { getRoleAudienceContextId, getRoleContextPrefix, isCrossProtocolRef, parseCrossProtocolRef } from '../utils/protocols.js';

export type ReplicationApplyOptions = {
  dataStream?: ReadableStream<Uint8Array>;
};

export type ReplicationApplyResult =
  | {
      kind: 'Applied';
      /** True when the local store retained dependency ancestry but did not advance latest state. */
      ancestryOnly?: true;
      /** Local admission position, when the receiving store has a durable replication log. */
      position?: ProgressToken;
    }
  | { kind: 'Duplicate' }
  | { kind: 'Superseded' }
  | { kind: 'Incomplete'; missing: DependencyRef[] }
  | { kind: 'Invalid'; reason: string }
  | { kind: 'Deferred'; reason: 'tenant-inactive' | 'resolver-unavailable' | 'storage' };

export type ReplicationApplyResultContext = {
  protocolDefinition?: ProtocolDefinition;

  /**
   * Complete set of locally-missing ancestor recordIds for a missing-ancestor failure
   * (immediate parent or record-chain construction), ordered root-first with the failure-named
   * ancestor last, as computed by `missingAncestorRecordIdsFromReply()`. When present, the
   * resulting `Incomplete` carries one ref per entry so the entire ancestry resolves in a
   * single fetch pass instead of one ancestry level per retry.
   */
  missingAncestorRecordIds?: string[];
};

export type DependencyRef =
  | { type: 'Protocol'; protocol: string; messageCid?: string; terminal?: boolean }
  | { type: 'InitialWrite'; recordId: string; protocol?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Parent'; recordId: string; protocol: string; messageCid?: string; terminal?: boolean }
  | { type: 'Ancestor'; recordId: string; protocol?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Role'; protocol: string; protocolPath: string; recipient: string; contextPrefix?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Grant'; permissionGrantId: string; messageCid?: string; terminal?: boolean }
  | {
      type: 'EncryptionControl';
      protocol: string;
      protocolPath: EncryptionControlPath;
      tags?: Record<string, string | number>;
      recipient?: string;
      messageCid?: string;
      terminal?: boolean;
    }
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
  reply: { status: { code: number; detail?: string }; position?: ProgressToken },
  context: ReplicationApplyResultContext = {},
): ReplicationApplyResult {
  const { code, detail = '' } = reply.status;

  if (code === 202 || code === 204) {
    return {
      kind: 'Applied',
      ...(code === 204 ? { ancestryOnly: true as const } : {}),
      ...(reply.position === undefined ? {} : { position: reply.position }),
    };
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

  const missing = dependencyRefsFromStatus(message, code, detail, context);
  if (missing.length > 0) {
    return { kind: 'Incomplete', missing };
  }

  if (code >= 500) {
    return { kind: 'Deferred', reason: 'storage' };
  }

  return { kind: 'Invalid', reason: detail || `replicated message rejected with status ${code}` };
}

/**
 * Computes the complete set of locally-missing ancestor recordIds for a replicated message that
 * failed on a missing ancestor — either the immediate parent referential check
 * (`ProtocolAuthorizationParentRecordNotFound`) or record-chain construction
 * (`ProtocolAuthorizationParentNotFoundConstructingRecordChain`).
 *
 * Both failures name a single ancestor, but the message's `contextId` names the full ancestor
 * recordId chain, so every segment the failed check could not reach is presence-checked here and
 * all absent segments are returned in one batch (ordered root-first, named ancestor last).
 * Feeding the result to `replicationApplyResultFromReply()` via `ReplicationApplyResultContext`
 * lets sync fetch the entire ancestry in a single pass instead of one level per retry.
 *
 * @returns the missing ancestor recordIds, or `undefined` when the reply is not a
 *          missing-ancestor failure or the chain cannot be determined from the message (callers
 *          then fall back to emitting the single ancestor named by the failure).
 */
export async function missingAncestorRecordIdsFromReply(
  tenant: string,
  message: GenericMessage,
  reply: { status: { detail?: string } },
  validationStateReader: ValidationStateReader,
): Promise<string[] | undefined> {
  const detail = reply.status.detail ?? '';
  const errorCode = getDwnErrorCode(detail);

  let namedRecordId: string | undefined;
  if (errorCode === DwnErrorCode.ProtocolAuthorizationParentRecordNotFound) {
    namedRecordId = parentRecordIdFromMessage(message, detail);
  } else if (errorCode === DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain) {
    namedRecordId = ancestorRecordIdFromDetail(detail);
  } else {
    return undefined;
  }

  const contextId = (message as { contextId?: unknown }).contextId;
  if (namedRecordId === undefined || typeof contextId !== 'string') {
    return undefined;
  }

  // `contextId` is the ancestor recordId chain ending with the record's own recordId. The failed
  // check stopped at `namedRecordId`, so every segment below it is locally present; only the
  // segments above it (closer to the root) still need a presence check. Presence means an initial
  // write exists — exactly what record-chain construction reads for the segments above the
  // immediate parent.
  const ancestorRecordIds = contextId.split('/').slice(0, -1);
  const namedIndex = ancestorRecordIds.indexOf(namedRecordId);
  if (namedIndex === -1) {
    return undefined;
  }

  const missingRecordIds: string[] = [];
  for (const ancestorRecordId of ancestorRecordIds.slice(0, namedIndex)) {
    const initialWrite = await validationStateReader.fetchInitialWrite(tenant, ancestorRecordId);
    if (initialWrite === undefined) {
      missingRecordIds.push(ancestorRecordId);
    }
  }
  missingRecordIds.push(namedRecordId);

  return missingRecordIds;
}

function dependencyRefsFromStatus(
  message: GenericMessage,
  code: number,
  detail: string,
  context: ReplicationApplyResultContext,
): DependencyRef[] {
  const errorCode = getDwnErrorCode(detail);
  switch (errorCode) {
  case DwnErrorCode.ProtocolAuthorizationProtocolNotFound:
  case DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled:
    return toRefList(protocolDependencyFromMessage(message, detail));
  case DwnErrorCode.ProtocolAuthorizationParentRecordNotFound:
    return parentDependenciesFromMessage(message, detail, context);
  case DwnErrorCode.ProtocolAuthorizationCrossProtocolParentNotFound:
    return toRefList(parentDependencyFromMessage(message, detail));
  case DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain:
    return ancestorDependenciesFromMessage(message, detail, context);
  case DwnErrorCode.RecordsWriteGetInitialWriteNotFound:
    return toRefList(initialWriteDependencyFromMessage(message));
  case DwnErrorCode.GrantAuthorizationGrantMissing:
    return toRefList(grantDependencyFromMessage(message));
  case DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound:
    return toRefList(roleDependencyFromMessage(message, context));
  case DwnErrorCode.ProtocolAuthorizationEncryptionRoleAudienceMissing:
    return encryptionAudienceDependenciesFromRoleAudienceEntries(message);
  case DwnErrorCode.EncryptionControlValidateDeliveryAudienceMissing:
    return toRefList(encryptionAudienceDependencyFromDelivery(message));
  case DwnErrorCode.EncryptionControlValidateDeliveryRecipientRoleRecordMissing:
    return toRefList(roleDependencyFromEncryptionControlDeliveryRecipient(message));
  case DwnErrorCode.RecordsWriteMissingDataInPrevious:
  case DwnErrorCode.RecordsWriteMissingEncodedDataInPrevious:
    return toRefList(recordDataDependencyFromMessage(message));
  default:
    break;
  }

  if (code === 404 && isRecordsDelete(message)) {
    return [{ type: 'InitialWrite', recordId: getRecordsDeleteRecordId(message) }];
  }

  return [];
}

function toRefList(ref: DependencyRef | undefined): DependencyRef[] {
  return ref === undefined ? [] : [ref];
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

  const protocol = dependencyProtocolFromMessage(message);
  return typeof protocol === 'string' ? { type: 'Protocol', protocol } : undefined;
}

/**
 * Emits the refs for an immediate-parent referential failure. The missing parent keeps its
 * existing `Parent` ref; when the apply context carries the layer-batched missing-ancestor set
 * (see `missingAncestorRecordIdsFromReply()`), an `Ancestor` ref is additionally emitted for
 * every locally-absent segment above the parent, so the entire ancestry resolves in a single
 * fetch pass instead of one level per retry.
 */
function parentDependenciesFromMessage(
  message: GenericMessage,
  detail: string,
  context: ReplicationApplyResultContext,
): DependencyRef[] {
  const parentRef = parentDependencyFromMessage(message, detail);
  if (parentRef === undefined) {
    return [];
  }

  const protocol = dependencyProtocolFromMessage(message);
  const protocolProperty = typeof protocol === 'string' ? { protocol } : {};
  const ancestorRefs = (context.missingAncestorRecordIds ?? [])
    .filter((recordId): boolean => recordId !== parentRef.recordId)
    .map((recordId): DependencyRef => ({ type: 'Ancestor', recordId, ...protocolProperty }));

  return [...ancestorRefs, parentRef];
}

function parentDependencyFromMessage(
  message: GenericMessage,
  detail: string,
): Extract<DependencyRef, { type: 'Parent' }> | undefined {
  const parentId = parentRecordIdFromMessage(message, detail);
  const protocol = /in protocol '([^']+)'/.exec(detail)?.[1] ?? dependencyProtocolFromMessage(message);

  if (parentId === undefined || typeof protocol !== 'string') {
    return undefined;
  }

  return { type: 'Parent', recordId: parentId, protocol };
}

function parentRecordIdFromMessage(message: GenericMessage, detail: string): string | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  return typeof descriptor.parentId === 'string'
    ? descriptor.parentId
    : /parent record '([^']+)'/.exec(detail)?.[1];
}

/**
 * Emits `Ancestor` refs for a record-chain construction failure. When the apply context carries
 * the layer-batched missing-ancestor set (see `missingAncestorRecordIdsFromReply()`), one ref is
 * emitted per missing segment so the entire ancestry resolves in a single fetch pass; otherwise
 * falls back to the single ancestor named by the failure detail (e.g. for messages that carry no
 * `contextId` chain).
 */
function ancestorDependenciesFromMessage(
  message: GenericMessage,
  detail: string,
  context: ReplicationApplyResultContext,
): DependencyRef[] {
  const protocol = dependencyProtocolFromMessage(message);
  const protocolProperty = typeof protocol === 'string' ? { protocol } : {};

  const batchedRecordIds = context.missingAncestorRecordIds;
  if (batchedRecordIds !== undefined && batchedRecordIds.length > 0) {
    return batchedRecordIds.map((recordId): DependencyRef => ({ type: 'Ancestor', recordId, ...protocolProperty }));
  }

  const namedRecordId = ancestorRecordIdFromDetail(detail);
  if (namedRecordId === undefined) {
    return [];
  }

  return [{ type: 'Ancestor', recordId: namedRecordId, ...protocolProperty }];
}

function ancestorRecordIdFromDetail(detail: string): string | undefined {
  return /ID ([^ ]+)/.exec(detail)?.[1];
}

function initialWriteDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  if (!isRecordsWrite(message)) {
    return undefined;
  }

  const protocol = dependencyProtocolFromMessage(message);
  return {
    type     : 'InitialWrite',
    recordId : message.recordId,
    ...(typeof protocol === 'string' ? { protocol } : {}),
  };
}

function grantDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  if (isEncryptionProtocolMessage(message)) {
    const tags = (message.descriptor as Record<string, unknown>).tags;
    const grantId = isRecordObject(tags) ? tags.grantId : undefined;
    if (typeof grantId === 'string') {
      return { type: 'Grant', permissionGrantId: grantId };
    }
  }

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
  const protocol = dependencyProtocolFromMessage(message);
  return typeof dataCid === 'string'
    ? {
      type     : 'RecordData',
      recordId : message.recordId,
      dataCid,
      ...(typeof protocol === 'string' ? { protocol } : {}),
    }
    : undefined;
}

function roleDependencyFromMessage(message: GenericMessage, context: ReplicationApplyResultContext): DependencyRef | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  const filter = descriptor.filter as Record<string, unknown> | undefined;
  const protocol = descriptor.protocol ?? filter?.protocol;
  const protocolRole = getSignaturePayload(message)?.protocolRole;
  const recipient = Message.getAuthor(message);

  if (typeof protocol !== 'string' || typeof protocolRole !== 'string' || recipient === undefined) {
    return undefined;
  }

  let roleProtocol = protocol;
  let roleProtocolPath = protocolRole;
  if (isCrossProtocolRef(protocolRole)) {
    const parsed = parseCrossProtocolRef(protocolRole);
    const referencedProtocol = parsed === undefined ? undefined : context.protocolDefinition?.uses?.[parsed.alias];
    if (parsed !== undefined && referencedProtocol !== undefined) {
      roleProtocol = referencedProtocol;
      roleProtocolPath = parsed.protocolPath;
    }
  }

  let contextId: string | undefined;
  if (typeof descriptor.contextId === 'string') {
    contextId = descriptor.contextId;
  } else if (typeof filter?.contextId === 'string') {
    contextId = filter.contextId;
  }
  const contextPrefix = getRoleContextPrefix(roleProtocolPath, contextId);

  return {
    type         : 'Role',
    protocol     : roleProtocol,
    protocolPath : roleProtocolPath,
    recipient,
    ...(contextPrefix === undefined ? {} : { contextPrefix }),
  };
}

function encryptionAudienceDependenciesFromRoleAudienceEntries(
  message: GenericMessage,
): Extract<DependencyRef, { type: 'EncryptionControl' }>[] {
  const descriptor = message.descriptor as Record<string, unknown>;
  const messageContextId = (message as { contextId?: unknown }).contextId;
  const contextId = typeof messageContextId === 'string' ? messageContextId : descriptor.contextId;
  const keyEncryption = (message as {
    encryption?: {
      keyEncryption?: Record<string, unknown>[];
    };
  }).encryption?.keyEncryption;
  if (typeof contextId !== 'string' || !Array.isArray(keyEncryption)) {
    return [];
  }

  const refs: Extract<DependencyRef, { type: 'EncryptionControl' }>[] = [];
  const sourceEntries = keyEncryption.filter((candidate): boolean =>
    candidate.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
    typeof candidate.protocol === 'string' &&
    typeof candidate.rolePath === 'string' &&
    typeof candidate.keyId === 'string'
  );
  for (const sourceEntry of sourceEntries) {
    const rolePath = sourceEntry.rolePath as string;
    const audienceContextId = getRoleAudienceContextId(rolePath, contextId);
    if (audienceContextId === undefined) {
      continue;
    }

    refs.push({
      type         : 'EncryptionControl',
      protocol     : sourceEntry.protocol as string,
      protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      tags         : {
        protocol  : sourceEntry.protocol as string,
        rolePath,
        contextId : audienceContextId,
        keyId     : sourceEntry.keyId as string,
      },
    });
  }

  return refs;
}

function encryptionAudienceDependencyFromDelivery(
  message: GenericMessage,
): Extract<DependencyRef, { type: 'EncryptionControl' }> | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  if (descriptor.protocolPath !== ENCRYPTION_CONTROL_DELIVERY_PATH) {
    return undefined;
  }

  const tags = descriptor.tags;
  if (!isRecordObject(tags)) {
    return undefined;
  }

  const { protocol, rolePath, contextId, keyId } = tags;
  if (
    typeof protocol !== 'string' ||
    typeof rolePath !== 'string' ||
    typeof contextId !== 'string' ||
    typeof keyId !== 'string'
  ) {
    return undefined;
  }

  return {
    type         : 'EncryptionControl',
    protocol,
    protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
    tags         : { protocol, rolePath, contextId, keyId },
  };
}

function roleDependencyFromEncryptionControlDeliveryRecipient(message: GenericMessage): DependencyRef | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  if (descriptor.protocolPath !== ENCRYPTION_CONTROL_DELIVERY_PATH || typeof descriptor.recipient !== 'string') {
    return undefined;
  }

  const tags = descriptor.tags;
  if (!isRecordObject(tags)) {
    return undefined;
  }

  const { protocol, rolePath, contextId } = tags;
  if (
    typeof protocol !== 'string' ||
    typeof rolePath !== 'string' ||
    typeof contextId !== 'string'
  ) {
    return undefined;
  }

  return {
    type         : 'Role',
    protocol,
    protocolPath : rolePath,
    recipient    : descriptor.recipient,
    ...(contextId === '' ? {} : { contextPrefix: contextId }),
  };
}

function dependencyProtocolFromMessage(message: GenericMessage): string | undefined {
  if (isEncryptionProtocolMessage(message)) {
    const tags = (message.descriptor as Record<string, unknown>).tags;
    const protocol = isRecordObject(tags) ? tags.protocol : undefined;
    return typeof protocol === 'string' ? protocol : undefined;
  }

  const descriptor = message.descriptor as Record<string, unknown>;
  const filter = descriptor.filter as Record<string, unknown> | undefined;
  const protocol = descriptor.protocol ?? filter?.protocol;
  return typeof protocol === 'string' ? protocol : undefined;
}

function isEncryptionProtocolMessage(message: GenericMessage): boolean {
  const descriptor = message.descriptor as Record<string, unknown>;
  return descriptor.interface === DwnInterfaceName.Records &&
    descriptor.protocol === EncryptionProtocol.uri;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
