import type {
  ProtocolDefinition,
  ProtocolsConfigureMessage,
  RecordsDeleteMessage,
  RecordsReadMessage,
  RecordsReadReplicationSupportEntry,
  RecordsReadReply,
  RecordsWriteMessage,
  RoleRecordIdentity,
} from '@enbox/dwn-sdk-js';

import type { DwnDataEncodedRecordsWriteMessage } from './types/dwn.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncMessageEntry } from './sync-messages.js';

import {
  DwnConstant,
  DwnErrorCode,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  getRoleAudienceContextId,
  getRoleRecordIdentity,
  getRuleSetAtPath,
  Message,
  Records,
  RecordsWrite,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isEncryptionControlRecordFor } from './dwn-encryption.js';
import { isTenantProtocolConfig } from './sync-fetch-helpers.js';
import { verifyRemoteDwnResponse } from './remote-dwn-response.js';
import { capRecordsWriteDataStream, dataStreamFromBytes, SyncPullAbortedError } from './sync-messages.js';
import { getRecordAuthor, getRecordProtocolRole, resolveDwnSubscriptionUrl as resolveDwnWebSocketUrl } from './utils.js';

/** A role-authorized read, its current protocol definition, and its local-replication prerequisites. */
export type RoleReplicationSupportBatch = {
  dependencies: SyncMessageEntry[];
  protocolDefinition: ProtocolDefinition;
  roleRecordId: string;
  root: SyncMessageEntry;
  rootCid: string;
};

type DelegatedRoleReadParams = {
  actorDid: string;
  delegateDid?: string;
  permissionsApi: PermissionsApi;
  protocol: string;
};

type RoleReplicationSupportParams = DelegatedRoleReadParams & {
  agent: EnboxPlatformAgent;
  contextId: string;
  dwnUrl: string;
  expectedRoot?: RecordsDeleteMessage | RecordsWriteMessage;
  protocolPath: string;
  protocolRole: string;
  rootData?: Uint8Array;
  shouldContinue?: () => boolean;
  sourceDid: string;
};

type ExactRoleReadFilter = {
  contextId: string;
  protocol: string;
  protocolPath: string;
  recordId: string;
};

type SupportValidationParams = {
  actorDid: string;
  contextId: string;
  protocol: string;
  protocolPath: string;
  protocolRole: string;
  replyRoleId: string | undefined;
  roleIdentity: RoleRecordIdentity;
  root: RecordsWriteMessage;
  rootDelete: RecordsDeleteMessage | undefined;
  rootInitialWrite: RecordsWriteMessage | undefined;
  sourceDid: string;
  support: readonly RecordsReadReplicationSupportEntry[];
};

type SupportScan = {
  audienceKeyIds: Set<string>;
  currentProtocolConfigure?: ProtocolsConfigureMessage;
  currentProtocolConfigureMatches: number;
  deliveredKeyIds: Set<string>;
  role?: RecordsWriteMessage;
};

/** The role is valid, but its audience key material is not ready for this member. */
export class FollowedSourceNotReadyError extends Error {
  public constructor(detail: string) {
    super(`Followed source is not ready: ${detail}`);
    this.name = 'FollowedSourceNotReadyError';
  }
}

/** Every matching role record is absent from one verified remote response. */
export class FollowedSourceRoleAbsentError extends Error {
  public constructor(detail: string) {
    super(`Followed source role is absent: ${detail}`);
    this.name = 'FollowedSourceRoleAbsentError';
  }
}

/** The remote DWN returned an unusable replication-support closure. */
export class RoleReplicationSupportError extends Error {
  public constructor(detail: string) {
    super(`Role replication support is invalid: ${detail}`);
    this.name = 'RoleReplicationSupportError';
  }
}

/**
 * Reads one exact record as a role holder and converts the returned closure to
 * the sync engine's existing admission entries. The response's unsigned role
 * ID is accepted only when it names the signed role record in the closure.
 */
export async function readRoleReplicationSupport(
  params: RoleReplicationSupportParams,
): Promise<RoleReplicationSupportBatch> {
  assertCurrent(params.shouldContinue);
  const recordId = params.contextId.split('/').at(-1);
  if (recordId === undefined || recordId.length === 0) {
    throw new TypeError('Role replication support requires an exact context ID.');
  }
  const { protocolPath } = params;

  const delegatedGrant = await resolveDelegatedRoleReadGrant(params, params.contextId, protocolPath);

  const filter: ExactRoleReadFilter = {
    contextId : params.contextId,
    protocol  : params.protocol,
    protocolPath,
    recordId,
  };
  const message = await createRoleReplicationSupportReadMessage(params, filter, delegatedGrant, true);

  assertCurrent(params.shouldContinue);
  const reply = await requestRoleReplicationSupport(params, filter, delegatedGrant, message);
  const responseData = reply.entry?.data;
  try {
    return await consumeRoleReplicationSupportReply(params, filter, message, reply);
  } catch (error: unknown) {
    await responseData?.cancel().catch((): void => {});
    throw error;
  }
}

async function createRoleReplicationSupportReadMessage(
  params: RoleReplicationSupportParams,
  filter: ExactRoleReadFilter,
  delegatedGrant: DwnDataEncodedRecordsWriteMessage | undefined,
  includeReplicationSupport: boolean,
): Promise<RecordsReadMessage> {
  const { message } = await params.agent.dwn.processRequest({
    author        : params.actorDid,
    granteeDid    : params.delegateDid,
    messageParams : {
      filter,
      includeReplicationSupport,
      protocolRole: params.protocolRole,
      ...(delegatedGrant === undefined ? {} : { delegatedGrant }),
    },
    messageType : DwnInterface.RecordsRead,
    store       : false,
    target      : params.sourceDid,
  });
  if (message === undefined) {
    throw new Error('Role replication support read did not produce a signed request.');
  }
  return message;
}

async function requestRoleReplicationSupport(
  params: RoleReplicationSupportParams,
  filter: ExactRoleReadFilter,
  delegatedGrant: DwnDataEncodedRecordsWriteMessage | undefined,
  message: RecordsReadMessage,
): Promise<RecordsReadReply> {
  const requestDwnUrl = await resolveRoleReadUrl(params);
  if (params.rootData !== undefined) {
    const reply = await sendRecordsRead(params, requestDwnUrl, message);
    if (reply.status.code === 200 && reply.entry !== undefined) {
      await reply.entry.data?.cancel().catch((): void => {});
      reply.entry.data = dataStreamFromBytes(params.rootData);
    }
    return reply;
  }
  if (isRecordsDeleteMessage(params.expectedRoot)) {
    return sendRecordsRead(params, requestDwnUrl, message);
  }
  const dataMessage = await createRoleReplicationSupportReadMessage(params, filter, delegatedGrant, false);
  const [supportResult, dataResult] = await Promise.allSettled([
    sendRecordsRead(params, requestDwnUrl, message),
    sendRecordsRead(params, params.dwnUrl, dataMessage),
  ]);
  return mergeSplitRoleReadReplies(supportResult, dataResult);
}

async function resolveRoleReadUrl(params: RoleReplicationSupportParams): Promise<string> {
  try {
    return await resolveDwnWebSocketUrl(params.dwnUrl, params.agent.rpc);
  } catch {
    return params.dwnUrl;
  }
}

function sendRecordsRead(
  params: RoleReplicationSupportParams,
  dwnUrl: string,
  message: RecordsReadMessage,
): Promise<RecordsReadReply> {
  return params.agent.rpc.sendDwnRequest({
    dwnUrl,
    message,
    targetDid: params.sourceDid,
  }) as Promise<RecordsReadReply>;
}

async function mergeSplitRoleReadReplies(
  supportResult: PromiseSettledResult<RecordsReadReply>,
  dataResult: PromiseSettledResult<RecordsReadReply>,
): Promise<RecordsReadReply> {
  if (supportResult.status === 'rejected') {
    if (dataResult.status === 'fulfilled') {
      await dataResult.value.entry?.data?.cancel().catch((): void => {});
    }
    throw supportResult.reason;
  }
  if (dataResult.status === 'rejected') {
    await supportResult.value.entry?.data?.cancel().catch((): void => {});
    throw dataResult.reason;
  }

  const supportReply = supportResult.value;
  const dataReply = dataResult.value;
  const data = dataReply.entry?.data;
  if (
    supportReply.status.code === 200 &&
    supportReply.entry !== undefined &&
    dataReply.status.code === 200 &&
    data !== undefined
  ) {
    if (supportReply.entry.data !== data) {
      await supportReply.entry.data?.cancel().catch((): void => {});
    }
    supportReply.entry.data = data;
  } else {
    await data?.cancel().catch((): void => {});
  }
  return supportReply;
}

async function consumeRoleReplicationSupportReply(
  params: RoleReplicationSupportParams,
  filter: ExactRoleReadFilter,
  message: RecordsReadMessage,
  reply: RecordsReadReply,
): Promise<RoleReplicationSupportBatch> {
  assertCurrent(params.shouldContinue);
  const expectsDelete = isRecordsDeleteMessage(params.expectedRoot);
  assertSuccessfulRoleReplicationSupport(reply, expectsDelete);

  const rootMessage = expectsDelete ? reply.entry?.recordsDelete : reply.entry?.recordsWrite;
  const rootWrite = expectsDelete ? reply.entry?.initialWrite : reply.entry?.recordsWrite;
  const rootData = reply.entry?.data;
  if (rootMessage === undefined || rootWrite === undefined || (!expectsDelete && rootData === undefined)) {
    throw new RoleReplicationSupportError('the response did not contain a readable root record.');
  }
  assertRoot(rootWrite, filter);

  const rootCid = await Message.getCid(rootMessage);
  if (params.expectedRoot !== undefined) {
    const expectedRootCid = await Message.getCid(params.expectedRoot);
    if (rootCid !== expectedRootCid) {
      throw new RoleReplicationSupportError(`root CID '${rootCid}' does not match '${expectedRootCid}'.`);
    }
  }

  const support = reply.support ?? [];
  const { protocolDefinition, roleRecordId } = await validateSupport({
    actorDid     : params.actorDid,
    contextId    : params.contextId,
    protocol     : params.protocol,
    protocolPath : params.protocolPath,
    protocolRole : params.protocolRole,
    replyRoleId  : reply.roleRecordId,
    roleIdentity : getRoleRecordIdentity({
      contextId    : params.contextId,
      protocol     : params.protocol,
      protocolPath : params.protocolRole,
      recipient    : params.actorDid,
    }),
    root             : rootWrite,
    rootDelete       : expectsDelete ? rootMessage as RecordsDeleteMessage : undefined,
    rootInitialWrite : reply.entry?.initialWrite,
    sourceDid        : params.sourceDid,
    support,
  });
  const dependencies = await collectSupportDependencies(reply, support, rootCid);

  await verifyRemoteDwnResponse({
    didResolver : params.agent.did,
    message,
    reply,
    targetDid   : params.sourceDid,
  });
  const verifiedRootData = reply.entry?.data;
  if (!expectsDelete && verifiedRootData === undefined) {
    throw new RoleReplicationSupportError('the verified response omitted the root record data.');
  }

  return {
    dependencies,
    protocolDefinition,
    roleRecordId,
    root: {
      message: rootMessage,
      ...(verifiedRootData === undefined
        ? {}
        : { dataStream: capRecordsWriteDataStream(rootWrite, verifiedRootData) }),
      isLatestBaseState: true,
    },
    rootCid,
  };
}

function assertSuccessfulRoleReplicationSupport(reply: RecordsReadReply, expectsDelete: boolean): void {
  if (reply.status.code === 200 || (expectsDelete && reply.status.code === 404)) {
    return;
  }
  const detail = reply.status.detail ?? 'Unknown error';
  const missingRole = DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound;
  if (reply.status.code === 401 && (detail === missingRole || detail.startsWith(`${missingRole}:`))) {
    throw new FollowedSourceRoleAbsentError(detail);
  }
  const unsupported = DwnErrorCode.RecordsReadReplicationSupportUnsupported;
  if (reply.status.code === 400 && (detail === unsupported || detail.startsWith(`${unsupported}:`))) {
    throw new RoleReplicationSupportError(detail);
  }
  throw new Error(`Role replication support read failed (${reply.status.code}): ${detail}`);
}

async function collectSupportDependencies(
  reply: RecordsReadReply,
  support: readonly RecordsReadReplicationSupportEntry[],
  rootCid: string,
): Promise<SyncMessageEntry[]> {
  const dependencies = new Map<string, SyncMessageEntry>();
  const append = async (entry: SyncMessageEntry): Promise<void> => {
    const cid = await Message.getCid(entry.message);
    if (cid !== rootCid) {
      dependencies.set(cid, entry);
    }
  };
  if (reply.entry?.initialWrite !== undefined) {
    await append({ message: reply.entry.initialWrite, isLatestBaseState: false });
  }
  for (const entry of support) {
    await append(toSyncEntry(entry));
  }
  return [...dependencies.values()];
}

function assertRoot(
  root: RecordsWriteMessage,
  expected: ExactRoleReadFilter,
): void {
  if (
    root.recordId !== expected.recordId ||
    root.contextId !== expected.contextId ||
    root.descriptor.protocol !== expected.protocol ||
    root.descriptor.protocolPath !== expected.protocolPath
  ) {
    throw new RoleReplicationSupportError('the response root does not match the exact requested context record.');
  }
}

async function validateSupport(
  params: SupportValidationParams,
): Promise<{ protocolDefinition: ProtocolDefinition; roleRecordId: string }> {
  const contextSegments = params.contextId.split('/');
  const pathSegments = params.protocolPath.split('/');
  const ancestorIds = new Map(contextSegments.slice(0, -1).map((recordId, index) => [
    recordId,
    {
      contextId    : contextSegments.slice(0, index + 1).join('/'),
      protocolPath : pathSegments.slice(0, index + 1).join('/'),
    },
  ]));
  const audienceContextId = getRoleAudienceContextId(params.protocolRole, params.contextId);
  const wrappedKeyIds = new Set(params.root.encryption?.keyEncryption
    .filter(entry => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
      'protocol' in entry && entry.protocol === params.protocol && entry.rolePath === params.protocolRole)
    .map(entry => entry.keyId) ?? []);
  const authorRoles = expectedAuthorRoleProofs(params, ancestorIds);
  const scan = await scanSupport(params, ancestorIds, audienceContextId, authorRoles);

  if (params.replyRoleId === undefined) {
    throw new RoleReplicationSupportError('the response did not identify its active role record.');
  }
  if (scan.role === undefined) {
    throw new RoleReplicationSupportError(`role '${params.replyRoleId}' has no signed active assignment.`);
  }
  if (scan.currentProtocolConfigure === undefined || scan.currentProtocolConfigureMatches !== 1) {
    throw new RoleReplicationSupportError('the response must contain exactly one current protocol configuration.');
  }

  assertRoleAudienceReady(params, scan.currentProtocolConfigure, wrappedKeyIds, scan);
  return {
    protocolDefinition : scan.currentProtocolConfigure.descriptor.definition,
    roleRecordId       : params.replyRoleId,
  };
}

async function scanSupport(
  params: SupportValidationParams,
  ancestorIds: ReadonlyMap<string, { contextId: string; protocolPath: string }>,
  audienceContextId: string | undefined,
  authorRoles: ReadonlySet<string>,
): Promise<SupportScan> {
  const scan: SupportScan = {
    audienceKeyIds                  : new Set(),
    currentProtocolConfigureMatches : 0,
    deliveredKeyIds                 : new Set(),
  };
  const isExpectedProtocolConfigure = isTenantProtocolConfig(params.sourceDid, params.protocol);

  for (const entry of params.support) {
    if (isExpectedProtocolConfigure(entry.message)) {
      if (typeof entry.isLatestBaseState !== 'boolean' || entry.encodedData !== undefined) {
        throw unsupportedEntry(entry);
      }
      if (entry.isLatestBaseState === true) {
        scan.currentProtocolConfigure = entry.message;
        scan.currentProtocolConfigureMatches++;
      }
      continue;
    }
    if (!Records.isRecordsWrite(entry.message)) {
      throw unsupportedEntry(entry);
    }
    await scanRecordsWriteSupport(scan, params, entry, entry.message, ancestorIds, audienceContextId, authorRoles);
  }
  return scan;
}

async function scanRecordsWriteSupport(
  scan: SupportScan,
  params: SupportValidationParams,
  entry: RecordsReadReplicationSupportEntry,
  message: RecordsWriteMessage,
  ancestorIds: ReadonlyMap<string, { contextId: string; protocolPath: string }>,
  audienceContextId: string | undefined,
  authorRoles: ReadonlySet<string>,
): Promise<void> {
  const isAncestor = isExpectedAncestor(entry, message, params.protocol, ancestorIds);
  const identity = getRecordsWriteRoleIdentity(message);
  const isRoleVersion = message.recordId === params.replyRoleId && identity?.key === params.roleIdentity.key;
  const isRole = isRoleVersion &&
    entry.isLatestBaseState === true &&
    typeof entry.encodedData === 'string';
  const isInitialRole = isRoleVersion &&
    entry.isLatestBaseState === false &&
    entry.encodedData === undefined &&
    await RecordsWrite.isInitialWrite(message);
  const isAuthorRole = identity !== undefined && authorRoles.has(identity.key) &&
    entry.isLatestBaseState === false &&
    entry.encodedData === undefined &&
    await RecordsWrite.isInitialWrite(message);
  const isRoleAudience = isTaggedEncryptionControl(
    message,
    ENCRYPTION_CONTROL_AUDIENCE_PATH,
    params.protocol,
    params.protocolRole,
    audienceContextId,
  );
  const isAudience = isRoleAudience || isRootAudienceControl(message, params.root, params.protocol);
  const isUsableAudience = isAudience &&
    entry.isLatestBaseState === true && typeof entry.encodedData === 'string';
  const isDelivery = isTaggedEncryptionControl(
    message,
    ENCRYPTION_CONTROL_DELIVERY_PATH,
    params.protocol,
    params.protocolRole,
    audienceContextId,
  ) && message.descriptor.recipient === params.actorDid &&
    entry.isLatestBaseState === true && typeof entry.encodedData === 'string';

  if (isRole) {
    scan.role = message;
  }
  if (isUsableAudience && isRoleAudience) {
    scan.audienceKeyIds.add(message.descriptor.tags!.keyId as string);
  }
  if (isDelivery) {
    scan.deliveredKeyIds.add(message.descriptor.tags!.keyId as string);
  }
  if (!isAncestor && !isRole && !isInitialRole && !isAuthorRole && !isUsableAudience && !isDelivery) {
    throw unsupportedEntry(entry);
  }
}

function expectedAuthorRoleProofs(
  params: SupportValidationParams,
  ancestorIds: ReadonlyMap<string, { contextId: string; protocolPath: string }>,
): Set<string> {
  const records = [params.root];
  if (params.rootInitialWrite !== undefined) {
    records.push(params.rootInitialWrite);
  }
  for (const entry of params.support) {
    if (Records.isRecordsWrite(entry.message) && isExpectedAncestor(entry, entry.message, params.protocol, ancestorIds)) {
      records.push(entry.message);
    }
  }

  const proofs = new Set<string>();
  const addProof = (protocolPath: string | undefined, recipient: string | undefined, contextId: string | undefined): void => {
    if (protocolPath === undefined) {
      return;
    }
    if (recipient === undefined) {
      throw new RoleReplicationSupportError('a role-authored record has no logical author.');
    }
    const identity = getRoleRecordIdentity({
      contextId,
      protocol: params.protocol,
      protocolPath,
      recipient,
    });
    if (identity.key === params.roleIdentity.key) {
      return;
    }
    proofs.add(identity.key);
  };
  for (const record of records) {
    addProof(getRecordProtocolRole(record), getRecordAuthor(record), record.contextId);
  }
  if (params.rootDelete !== undefined) {
    addProof(getRecordProtocolRole(params.rootDelete), getRecordAuthor(params.rootDelete), params.root.contextId);
  }
  return proofs;
}

function isRecordsDeleteMessage(
  message: RecordsDeleteMessage | RecordsWriteMessage | undefined,
): message is RecordsDeleteMessage {
  return message?.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Delete;
}

function isExpectedAncestor(
  entry: RecordsReadReplicationSupportEntry,
  message: RecordsWriteMessage,
  protocol: string,
  ancestorIds: ReadonlyMap<string, { contextId: string; protocolPath: string }>,
): boolean {
  const ancestor = ancestorIds.get(message.recordId);
  return ancestor !== undefined &&
    message.contextId === ancestor.contextId &&
    message.descriptor.protocol === protocol &&
    message.descriptor.protocolPath === ancestor.protocolPath &&
    entry.isLatestBaseState === false &&
    entry.encodedData === undefined;
}

function getRecordsWriteRoleIdentity(message: RecordsWriteMessage): RoleRecordIdentity | undefined {
  const { protocol, protocolPath, recipient } = message.descriptor;
  if (protocol === undefined || protocolPath === undefined || recipient === undefined) {
    return undefined;
  }
  return getRoleRecordIdentity({
    contextId: message.contextId,
    protocol,
    protocolPath,
    recipient,
  });
}

function assertRoleAudienceReady(
  params: SupportValidationParams,
  currentProtocolConfigure: ProtocolsConfigureMessage,
  wrappedKeyIds: ReadonlySet<string>,
  scan: SupportScan,
): void {
  const roleRuleSet = getRuleSetAtPath(params.protocolRole, currentProtocolConfigure.descriptor.definition.structure);
  const deliveryRequired = roleRuleSet?.$role === true && roleRuleSet.$keyAgreement !== undefined;
  const missingAudience = (params.rootDelete === undefined && deliveryRequired && scan.audienceKeyIds.size === 0) ||
    [...wrappedKeyIds].some(keyId => !scan.audienceKeyIds.has(keyId));
  const missingDelivery = params.rootDelete === undefined &&
    [...scan.audienceKeyIds].some(keyId => !scan.deliveredKeyIds.has(keyId));
  if (missingAudience || missingDelivery) {
    throw new FollowedSourceNotReadyError(
      missingAudience
        ? 'the role audience key is unavailable.'
        : `the audience key has not been delivered to ${params.actorDid}.`,
    );
  }
}

function isTaggedEncryptionControl(
  message: RecordsWriteMessage,
  protocolPath: string,
  protocol: string,
  rolePath: string,
  contextId: string | undefined,
): boolean {
  return contextId !== undefined &&
    isEncryptionControlRecordFor(message, protocolPath, { protocol, rolePath, contextId });
}

function isRootAudienceControl(
  message: RecordsWriteMessage,
  root: RecordsWriteMessage,
  protocol: string,
): boolean {
  const tags = message.descriptor.tags;
  if (
    message.descriptor.protocol !== protocol ||
    message.descriptor.protocolPath !== ENCRYPTION_CONTROL_AUDIENCE_PATH ||
    tags?.protocol !== protocol ||
    typeof tags.rolePath !== 'string' ||
    typeof tags.contextId !== 'string' ||
    typeof tags.keyId !== 'string'
  ) {
    return false;
  }

  return root.encryption?.keyEncryption.some((entry): boolean =>
    entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
    'protocol' in entry &&
    entry.protocol === protocol &&
    entry.rolePath === tags.rolePath &&
    entry.keyId === tags.keyId &&
    getRoleAudienceContextId(entry.rolePath, root.contextId) === tags.contextId
  ) === true;
}

function unsupportedEntry(entry: RecordsReadReplicationSupportEntry): Error {
  const { interface: interfaceName, method } = entry.message.descriptor;
  return new RoleReplicationSupportError(`the response contains unrelated entry ${interfaceName}/${method}.`);
}

function toSyncEntry(entry: RecordsReadReplicationSupportEntry): SyncMessageEntry {
  const syncEntry: SyncMessageEntry = {
    message           : entry.message,
    isLatestBaseState : entry.isLatestBaseState,
  };
  if (entry.encodedData !== undefined) {
    const dataSize = Records.isRecordsWrite(entry.message)
      ? entry.message.descriptor.dataSize
      : DwnConstant.maxDataSizeAllowedToBeEncoded;
    const maxBytes = Math.min(dataSize, DwnConstant.maxDataSizeAllowedToBeEncoded);
    if (entry.encodedData.length > Math.ceil(maxBytes * 4 / 3)) {
      throw new RoleReplicationSupportError('an entry\'s inline data exceeds its declared bound.');
    }
    syncEntry.bufferedData = Encoder.base64UrlToBytes(entry.encodedData);
  }
  return syncEntry;
}

function assertCurrent(shouldContinue: (() => boolean) | undefined): void {
  if (shouldContinue?.() === false) {
    throw new SyncPullAbortedError();
  }
}

async function resolveDelegatedRoleReadGrant(
  params: DelegatedRoleReadParams,
  contextId: string,
  protocolPath: string,
): Promise<DwnDataEncodedRecordsWriteMessage | undefined> {
  if (params.delegateDid === undefined) {
    return undefined;
  }
  const { message } = await params.permissionsApi.getPermissionForRequest({
    connectedDid : params.actorDid,
    contextId,
    delegate     : true,
    delegateDid  : params.delegateDid,
    forceRefresh : true,
    messageType  : DwnInterface.RecordsRead,
    protocol     : params.protocol,
    protocolPath,
  });
  return message;
}
