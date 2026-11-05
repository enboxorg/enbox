import type { EncryptionControlPath } from './constants.js';
import type { GenericMessage } from '../types/message-types.js';
import type { ProgressToken } from '../types/subscriptions.js';
import type { ResolvedModuleGraph } from './module-graph.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';

import { DwnErrorCode } from './dwn-error.js';
import { Encoder } from '../utils/encoder.js';
import { EncryptionModule } from '../modules/encryption.js';
import { Message } from './message.js';
import { ROLE_AUDIENCE_DERIVATION_SCHEME } from '../utils/encryption.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { ENCRYPTION_CONTROL_AUDIENCE_PATH, ENCRYPTION_CONTROL_DELIVERY_PATH } from './constants.js';
import { getRoleAudienceContextId, getRoleContextPrefix } from './module-role-records.js';

export type ReplicationApplyOptions = {
  dataStream?: ReadableStream<Uint8Array>;
  /** Request confirmation of complete current RecordsWrite state for duplicate or superseded input. */
  includeMaterializationConfirmation?: boolean;
};

export type ReplicationApplyResult =
  | {
      kind: 'Applied';
      /** True when the local store retained dependency ancestry but did not advance latest state. */
      ancestryOnly?: true;
      /** Local admission position, when the receiving store has a durable replication log. */
      position?: ProgressToken;
    }
  | {
      kind: 'Duplicate';
      /** True when confirmation was requested or an exact body replay found complete stored data. */
      materialized?: true;
    }
  | {
      kind: 'Superseded';
      /** True only when requested and a newer current RecordsWrite has its data. */
      currentWriteMaterialized?: true;
    }
  | { kind: 'Incomplete'; missing: DependencyRef[] }
  | { kind: 'Invalid'; reason: string }
  | {
      kind: 'Deferred';
      reason: 'record-data-unavailable' | 'resolver-unavailable' | 'storage' | 'tenant-inactive';
    };

export type ReplicationApplyResultContext = {
  resolvedGraph?: ResolvedModuleGraph;

  /**
   * Complete set of locally-missing ancestor recordIds for a missing-ancestor failure
   * (immediate parent or record-chain construction), ordered root-first with the failure-named
   * ancestor last, as computed by `missingAncestorRecordIdsFromReply()`. When present, the
   * resulting `Incomplete` carries one ref per entry so the entire ancestry resolves in a
   * single fetch pass instead of one ancestry level per retry.
   */
  missingAncestorRecordIds?: string[];

  /**
   * Set by the receiver when a parent-missing reply is locally known to be terminal because the
   * referenced parent record carries a prune tombstone. The generic on-wire parent-not-found code then
   * classifies as `Invalid` instead of a retryable `Incomplete`, so the receiver stops retrying a
   * dependency that can never be repaired without the reply leaking the tombstone to its sender.
   */
  parentRecordPruned?: boolean;
};

export type DependencyRef =
  | { type: 'Module'; module: string; messageCid?: string; terminal?: boolean }
  | { type: 'InitialWrite'; recordId: string; module?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Parent'; recordId: string; module: string; messageCid?: string; terminal?: boolean }
  | { type: 'Ancestor'; recordId: string; module?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Role'; module: string; modulePath: string; recipient: string; contextPrefix?: string; messageCid?: string; terminal?: boolean }
  | { type: 'Grant'; permissionGrantId: string; messageCid?: string; terminal?: boolean }
  | {
      type: 'EncryptionControl';
      module: string;
      modulePath: EncryptionControlPath;
      tags?: Record<string, string | number>;
      recipient?: string;
      messageCid?: string;
      terminal?: boolean;
    }
  | { type: 'CrossModuleRef'; module: string; recordId: string; messageCid?: string; terminal?: boolean }
  | { type: 'RecordData'; recordId: string; dataCid: string; module?: string; messageCid?: string; terminal?: boolean };

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

  if (
    context.parentRecordPruned === true
    && getDwnErrorCode(detail) === DwnErrorCode.ModuleAuthorizationParentRecordNotFound
  ) {
    return { kind: 'Superseded' };
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
 * (`ModuleAuthorizationParentRecordNotFound`) or record-chain construction
 * (`ModuleAuthorizationParentNotFoundConstructingRecordChain`).
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
  if (errorCode === DwnErrorCode.ModuleAuthorizationParentRecordNotFound) {
    namedRecordId = parentRecordIdFromMessage(message, detail);
  } else if (errorCode === DwnErrorCode.ModuleAuthorizationParentNotFoundConstructingRecordChain) {
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
  case DwnErrorCode.ModuleAuthorizationModuleNotFound:
  case DwnErrorCode.ModulesConfigureComposedModuleNotInstalled:
    return toRefList(moduleDependencyFromMessage(message, detail));
  case DwnErrorCode.ModuleAuthorizationParentRecordNotFound:
    return parentDependenciesFromMessage(message, detail, context);
  case DwnErrorCode.ModuleAuthorizationParentNotFoundConstructingRecordChain:
    return ancestorDependenciesFromMessage(message, detail, context);
  case DwnErrorCode.RecordsWriteGetInitialWriteNotFound:
    return toRefList(initialWriteDependencyFromMessage(message));
  case DwnErrorCode.GrantAuthorizationGrantMissing:
    return toRefList(grantDependencyFromMessage(message));
  case DwnErrorCode.ModuleAuthorizationMatchingRoleRecordNotFound:
    return toRefList(roleDependencyFromMessage(message, context));
  case DwnErrorCode.ModuleAuthorizationEncryptionRoleAudienceMissing:
    return encryptionAudienceDependenciesFromRoleAudienceEntries(message, context);
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

/**
 * Whether a parent-missing reply is terminal because the referenced parent record is pruned
 * locally. Returns `false` for any other reply. The receiver calls this so it can classify a
 * generic on-wire missing-parent error as terminal without the error code itself revealing that a
 * tombstone exists.
 */
export async function parentRecordPrunedFromReply(
  tenant: string,
  message: GenericMessage,
  reply: { status: { detail?: string } },
  validationStateReader: ValidationStateReader,
): Promise<boolean> {
  const detail = reply.status.detail ?? '';
  const errorCode = getDwnErrorCode(detail);
  if (errorCode !== DwnErrorCode.ModuleAuthorizationParentRecordNotFound) {
    return false;
  }

  const parentId = parentRecordIdFromMessage(message, detail);
  if (parentId === undefined) {
    return false;
  }

  const contextId = (message as { contextId?: unknown }).contextId;
  const ancestorRecordIds = typeof contextId === 'string'
    ? contextId.split('/').slice(0, -1)
    : [parentId];
  for (const ancestorRecordId of ancestorRecordIds) {
    if (await validationStateReader.isRecordPruned(tenant, ancestorRecordId)) {
      return true;
    }
  }

  return false;
}

function getDwnErrorCode(detail: string): string | undefined {
  const delimiter = detail.indexOf(':');
  return delimiter === -1 ? undefined : detail.slice(0, delimiter);
}

function isResolverFailure(detail: string): boolean {
  return getDwnErrorCode(detail) === DwnErrorCode.GeneralJwsVerifierGetPublicKeyNotFound;
}

function moduleDependencyFromMessage(message: GenericMessage, detail: string): DependencyRef | undefined {
  const composedModule = /composed module '([^']+)'/.exec(detail)?.[1];
  if (composedModule !== undefined) {
    return { type: 'Module', module: composedModule };
  }

  const module = dependencyModuleFromMessage(message);
  return typeof module === 'string' ? { type: 'Module', module } : undefined;
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

  const ancestorRefs = (context.missingAncestorRecordIds ?? [])
    .filter((recordId): boolean => recordId !== parentRef.recordId)
    .map((recordId): DependencyRef => ancestorDependency(message, context, recordId));

  return [...ancestorRefs, parentRef];
}

function parentDependencyFromMessage(
  message: GenericMessage,
  detail: string,
): Extract<DependencyRef, { type: 'Parent' }> | undefined {
  const parentId = parentRecordIdFromMessage(message, detail);
  const module = /in module '([^']+)'/.exec(detail)?.[1] ?? dependencyModuleFromMessage(message);

  if (parentId === undefined || typeof module !== 'string') {
    return undefined;
  }

  return { type: 'Parent', recordId: parentId, module };
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
  const batchedRecordIds = context.missingAncestorRecordIds;
  if (batchedRecordIds !== undefined && batchedRecordIds.length > 0) {
    return batchedRecordIds.map((recordId): DependencyRef => ancestorDependency(message, context, recordId));
  }

  const namedRecordId = ancestorRecordIdFromDetail(detail);
  if (namedRecordId === undefined) {
    return [];
  }

  return [ancestorDependency(message, context, namedRecordId)];
}

function ancestorDependency(message: GenericMessage, context: ReplicationApplyResultContext, recordId: string): DependencyRef {
  const descriptor = message.descriptor as Record<string, unknown>;
  const contextId = (message as { contextId?: string }).contextId;
  const index = contextId?.split('/').indexOf(recordId) ?? -1;
  const node = typeof descriptor.modulePath === 'string' ? context.resolvedGraph?.nodesByDeclaredPath.get(descriptor.modulePath) : undefined;
  const module = index < 0 ? undefined : node?.physicalAncestors[index]?.owningModuleUri;
  return { type: 'Ancestor', recordId, ...(module === undefined ? {} : { module }) };
}

function ancestorRecordIdFromDetail(detail: string): string | undefined {
  return /ID ([^ ]+)/.exec(detail)?.[1];
}

function initialWriteDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  if (!isRecordsWrite(message)) {
    return undefined;
  }

  const module = dependencyModuleFromMessage(message);
  return {
    type     : 'InitialWrite',
    recordId : message.recordId,
    ...(typeof module === 'string' ? { module } : {}),
  };
}

function grantDependencyFromMessage(message: GenericMessage): DependencyRef | undefined {
  if (isEncryptionModuleMessage(message)) {
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
  const module = dependencyModuleFromMessage(message);
  return typeof dataCid === 'string'
    ? {
      type     : 'RecordData',
      recordId : message.recordId,
      dataCid,
      ...(typeof module === 'string' ? { module } : {}),
    }
    : undefined;
}

function roleDependencyFromMessage(message: GenericMessage, context: ReplicationApplyResultContext): DependencyRef | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  const filter = descriptor.filter as Record<string, unknown> | undefined;
  const module = descriptor.module ?? filter?.module;
  const moduleRole = getSignaturePayload(message)?.moduleRole;
  const recipient = Message.getAuthor(message);

  if (typeof module !== 'string' || typeof moduleRole !== 'string' || recipient === undefined) {
    return undefined;
  }

  if (context.resolvedGraph === undefined) {
    return { type: 'Module', module };
  }
  const role = context.resolvedGraph.resolveInvokedRole(moduleRole);
  const topLevelContext = (message as { contextId?: unknown }).contextId;
  const contextId = typeof topLevelContext === 'string' ? topLevelContext
    : typeof filter?.contextId === 'string' ? filter.contextId : undefined;
  const contextPrefix = getRoleContextPrefix(role, contextId);
  if (role.parentPhysicalDepth > 0 && contextPrefix === undefined) {
    return undefined;
  }
  return {
    type       : 'Role',
    module     : role.owningModuleUri,
    modulePath : role.owningModulePath,
    recipient,
    ...(contextPrefix === undefined ? {} : { contextPrefix }),
  };
}

function encryptionAudienceDependenciesFromRoleAudienceEntries(
  message: GenericMessage,
  context: ReplicationApplyResultContext,
): DependencyRef[] {
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

  if (context.resolvedGraph === undefined) {
    const module = dependencyModuleFromMessage(message);
    return typeof module === 'string' ? [{ type: 'Module', module }] : [];
  }
  const graph = context.resolvedGraph;
  const node = typeof descriptor.modulePath === 'string' ? graph.nodesByDeclaredPath.get(descriptor.modulePath) : undefined;
  const requiredRoles = new Map((node?.actions ?? [])
    .filter(action => action.resolvedRole !== undefined && action.rule.can.includes('read'))
    .map(action => [JSON.stringify([action.resolvedRole!.owningModuleUri, action.resolvedRole!.owningModulePath]), action.resolvedRole!]));
  const refs: DependencyRef[] = [];
  const sourceEntries = keyEncryption.filter((candidate): boolean =>
    candidate.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
    typeof candidate.module === 'string' &&
    typeof candidate.rolePath === 'string' &&
    typeof candidate.keyId === 'string'
  );
  for (const sourceEntry of sourceEntries) {
    const rolePath = sourceEntry.rolePath as string;
    const role = requiredRoles.get(JSON.stringify([sourceEntry.module, rolePath]));
    if (role === undefined) {
      continue;
    }
    const audienceContextId = getRoleAudienceContextId(role, contextId);
    if (audienceContextId === undefined) {
      continue;
    }

    refs.push({
      type       : 'EncryptionControl',
      module     : sourceEntry.module as string,
      modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      tags       : {
        module    : sourceEntry.module as string,
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
  if (descriptor.modulePath !== ENCRYPTION_CONTROL_DELIVERY_PATH) {
    return undefined;
  }

  const tags = descriptor.tags;
  if (!isRecordObject(tags)) {
    return undefined;
  }

  const { module, rolePath, contextId, keyId } = tags;
  if (
    typeof module !== 'string' ||
    typeof rolePath !== 'string' ||
    typeof contextId !== 'string' ||
    typeof keyId !== 'string'
  ) {
    return undefined;
  }

  return {
    type       : 'EncryptionControl',
    module,
    modulePath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
    tags       : { module, rolePath, contextId, keyId },
  };
}

function roleDependencyFromEncryptionControlDeliveryRecipient(message: GenericMessage): DependencyRef | undefined {
  const descriptor = message.descriptor as Record<string, unknown>;
  if (descriptor.modulePath !== ENCRYPTION_CONTROL_DELIVERY_PATH || typeof descriptor.recipient !== 'string') {
    return undefined;
  }

  const tags = descriptor.tags;
  if (!isRecordObject(tags)) {
    return undefined;
  }

  const { module, rolePath, contextId } = tags;
  if (
    typeof module !== 'string' ||
    typeof rolePath !== 'string' ||
    typeof contextId !== 'string'
  ) {
    return undefined;
  }

  return {
    type       : 'Role',
    module,
    modulePath : rolePath,
    recipient  : descriptor.recipient,
    ...(contextId === '' ? {} : { contextPrefix: contextId }),
  };
}

function dependencyModuleFromMessage(message: GenericMessage): string | undefined {
  if (isEncryptionModuleMessage(message)) {
    const tags = (message.descriptor as Record<string, unknown>).tags;
    const module = isRecordObject(tags) ? tags.module : undefined;
    return typeof module === 'string' ? module : undefined;
  }

  const descriptor = message.descriptor as Record<string, unknown>;
  const filter = descriptor.filter as Record<string, unknown> | undefined;
  const module = descriptor.module ?? filter?.module;
  return typeof module === 'string' ? module : undefined;
}

function isEncryptionModuleMessage(message: GenericMessage): boolean {
  const descriptor = message.descriptor as Record<string, unknown>;
  return descriptor.interface === DwnInterfaceName.Records &&
    descriptor.module === EncryptionModule.uri;
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
