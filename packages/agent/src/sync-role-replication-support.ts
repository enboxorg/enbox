import type {
  ProtocolDefinition,
  ProtocolsConfigureMessage,
  RecordsDeleteMessage,
  RecordsReadMessage,
  RecordsReadReplicationSupportEntry,
  RecordsReadReply,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import type { DwnDataEncodedRecordsWriteMessage } from './types/dwn.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncMessageEntry } from './sync-messages.js';

import {
  authenticate,
  DwnConstant,
  DwnErrorCode,
  Encoder,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  getRoleAudienceContextId,
  getRoleContextPrefix,
  getRuleSetAtPath,
  Message,
  Records,
  RecordsWrite,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isTenantProtocolConfig } from './sync-fetch-helpers.js';
import { resolveDwnSubscriptionUrl as resolveDwnWebSocketUrl } from './utils.js';
import { verifyRemoteDwnResponse } from './remote-dwn-response.js';
import { capRecordsWriteDataStream, SyncPullAbortedError } from './sync-messages.js';

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
  expectedRootCid?: string;
  protocolPath: string;
  protocolRole: string;
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
  agent: EnboxPlatformAgent;
  contextId: string;
  protocol: string;
  protocolPath: string;
  protocolRole: string;
  replyRoleId: string | undefined;
  roleContextId: string | undefined;
  root: RecordsWriteMessage;
  sourceDid: string;
  support: readonly RecordsReadReplicationSupportEntry[];
};

type SupportScan = {
  audienceKeyIds: Set<string>;
  currentProtocolConfigure?: ProtocolsConfigureMessage;
  currentProtocolConfigureMatches: number;
  deliveredKeyIds: Set<string>;
  initialRoleMatches: number;
  role?: RecordsWriteMessage;
  roleMatches: number;
  unrelated?: RecordsReadReplicationSupportEntry;
};

/** Verified current state of one previously accepted role assignment. */
type FollowedRoleState =
  | { kind: 'active' }
  | { kind: 'absent'; tombstone: RecordsDeleteMessage };

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

/**
 * Reads one previously accepted role record without invoking that role. A
 * deleted read carries the signed tombstone needed to retire the same role in
 * the local foreign-tenant replica.
 */
export async function readFollowedRoleState(params: {
  actorDid: string;
  agent: EnboxPlatformAgent;
  contextId: string;
  delegateDid?: string;
  dwnUrl: string;
  permissionsApi: PermissionsApi;
  protocol: string;
  protocolRole: string;
  roleRecordId: string;
  shouldContinue?: () => boolean;
  sourceDid: string;
}): Promise<FollowedRoleState> {
  assertCurrent(params.shouldContinue);
  const roleContextId = `${params.contextId}/${params.roleRecordId}`;
  const delegatedGrant = await resolveDelegatedRoleReadGrant(params, roleContextId, params.protocolRole);

  const { message } = await params.agent.dwn.processRequest({
    author        : params.actorDid,
    granteeDid    : params.delegateDid,
    messageParams : {
      filter: {
        contextId    : roleContextId,
        protocol     : params.protocol,
        protocolPath : params.protocolRole,
        recordId     : params.roleRecordId,
      },
      ...(delegatedGrant === undefined ? {} : { delegatedGrant }),
    },
    messageType : DwnInterface.RecordsRead,
    store       : false,
    target      : params.sourceDid,
  });
  if (message === undefined) {
    throw new Error('Followed role state read did not produce a signed request.');
  }

  assertCurrent(params.shouldContinue);
  const reply = await params.agent.rpc.sendDwnRequest({
    dwnUrl    : params.dwnUrl,
    message,
    targetDid : params.sourceDid,
  }) as RecordsReadReply;
  try {
    assertCurrent(params.shouldContinue);
    await verifyRemoteDwnResponse({
      didResolver : params.agent.did,
      message,
      reply,
      targetDid   : params.sourceDid,
    });

    if (reply.status.code === 200) {
      if (reply.entry?.recordsWrite?.descriptor.recipient !== params.actorDid) {
        throw new Error('Followed role state response is not assigned to the expected member.');
      }
      return { kind: 'active' };
    }
    if (reply.status.code !== 404) {
      throw new Error(
        `Followed role state read failed (${reply.status.code}): ${reply.status.detail ?? 'Unknown error'}`,
      );
    }

    const tombstone = reply.entry?.recordsDelete;
    const initialWrite = reply.entry?.initialWrite;
    if (tombstone === undefined) {
      throw new FollowedSourceNotReadyError('source endpoint has no durable role deletion');
    }
    if (initialWrite?.descriptor.recipient !== params.actorDid) {
      throw new Error('Followed role deletion is not assigned to the expected member.');
    }
    return { kind: 'absent', tombstone };
  } finally {
    await reply.entry?.data?.cancel().catch((): void => {});
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
  if (requestDwnUrl === params.dwnUrl) {
    return sendRecordsRead(params, params.dwnUrl, message);
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
  assertSuccessfulRoleReplicationSupport(reply);

  const rootMessage = reply.entry?.recordsWrite;
  const rootData = reply.entry?.data;
  if (rootMessage === undefined || rootData === undefined) {
    throw new Error('Role replication support response did not contain a readable root record.');
  }
  assertRoot(rootMessage, filter);

  const rootCid = await Message.getCid(rootMessage);
  if (params.expectedRootCid !== undefined && rootCid !== params.expectedRootCid) {
    throw new Error(`Role replication support returned root CID '${rootCid}' instead of '${params.expectedRootCid}'.`);
  }

  const support = reply.support ?? [];
  const { protocolDefinition, roleRecordId } = await validateSupport({
    actorDid      : params.actorDid,
    agent         : params.agent,
    contextId     : params.contextId,
    protocol      : params.protocol,
    protocolPath  : params.protocolPath,
    protocolRole  : params.protocolRole,
    replyRoleId   : reply.roleRecordId,
    roleContextId : getRoleContextPrefix(params.protocolRole, params.contextId),
    root          : rootMessage,
    sourceDid     : params.sourceDid,
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
  if (verifiedRootData === undefined) {
    throw new Error('Verified role replication support omitted the root record data.');
  }

  return {
    dependencies,
    protocolDefinition,
    roleRecordId,
    root: {
      message           : rootMessage,
      dataStream        : capRecordsWriteDataStream(rootMessage, verifiedRootData),
      isLatestBaseState : true,
    },
    rootCid,
  };
}

function assertSuccessfulRoleReplicationSupport(reply: RecordsReadReply): void {
  if (reply.status.code === 200) {
    return;
  }
  const detail = reply.status.detail ?? 'Unknown error';
  const missingRole = DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound;
  if (reply.status.code === 401 && (detail === missingRole || detail.startsWith(`${missingRole}:`))) {
    throw new FollowedSourceRoleAbsentError(detail);
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
  expected: { contextId: string; protocol: string; protocolPath: string; recordId: string },
): void {
  if (
    root.recordId !== expected.recordId ||
    root.contextId !== expected.contextId ||
    root.descriptor.protocol !== expected.protocol ||
    root.descriptor.protocolPath !== expected.protocolPath
  ) {
    throw new Error('Role replication support response root does not match the exact requested context record.');
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
  const scan = await scanSupport(params, ancestorIds, audienceContextId);

  if (params.replyRoleId === undefined) {
    throw new Error('Role replication support response did not identify its active role record.');
  }
  if (scan.role === undefined || scan.roleMatches !== 1) {
    throw new Error(
      `Role replication support response role '${params.replyRoleId}' is not bound to exactly one signed active assignment.`,
    );
  }
  const expectedInitialRoleMatches = await RecordsWrite.isInitialWrite(scan.role) ? 0 : 1;
  if (scan.initialRoleMatches !== expectedInitialRoleMatches) {
    throw new Error('Role replication support response has an invalid initial role assignment.');
  }
  if (scan.unrelated !== undefined) {
    throw unsupportedEntry(scan.unrelated);
  }
  if (scan.currentProtocolConfigure === undefined || scan.currentProtocolConfigureMatches !== 1) {
    throw new Error('Role replication support response must contain exactly one current protocol configuration.');
  }

  await RecordsWrite.parse(scan.role);
  await authenticate(scan.role.authorization, params.agent.did);
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
): Promise<SupportScan> {
  const scan: SupportScan = {
    audienceKeyIds                  : new Set(),
    currentProtocolConfigureMatches : 0,
    deliveredKeyIds                 : new Set(),
    initialRoleMatches              : 0,
    roleMatches                     : 0,
  };
  const isExpectedProtocolConfigure = isTenantProtocolConfig(params.sourceDid, params.protocol);

  for (const entry of params.support) {
    if (isExpectedProtocolConfigure(entry.message)) {
      if (typeof entry.isLatestBaseState !== 'boolean' || entry.encodedData !== undefined) {
        scan.unrelated ??= entry;
      }
      if (entry.isLatestBaseState === true) {
        scan.currentProtocolConfigure = entry.message;
        scan.currentProtocolConfigureMatches++;
      }
      continue;
    }
    if (!Records.isRecordsWrite(entry.message)) {
      scan.unrelated ??= entry;
      continue;
    }
    await scanRecordsWriteSupport(scan, params, entry, entry.message, ancestorIds, audienceContextId);
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
): Promise<void> {
  const ancestor = ancestorIds.get(message.recordId);
  const isAncestor = ancestor !== undefined &&
    message.contextId === ancestor.contextId &&
    message.descriptor.protocol === params.protocol &&
    message.descriptor.protocolPath === ancestor.protocolPath &&
    entry.isLatestBaseState === false &&
    entry.encodedData === undefined;
  const isRoleVersion = message.recordId === params.replyRoleId &&
    message.descriptor.protocol === params.protocol &&
    message.descriptor.protocolPath === params.protocolRole &&
    message.descriptor.recipient === params.actorDid &&
    Records.getParentContextFromOfContextId(message.contextId) === params.roleContextId;
  const isRole = isRoleVersion &&
    entry.isLatestBaseState === true &&
    typeof entry.encodedData === 'string';
  const isInitialRole = isRoleVersion &&
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
    scan.roleMatches++;
  }
  if (isInitialRole) {
    scan.initialRoleMatches++;
  }
  if (isUsableAudience && isRoleAudience) {
    scan.audienceKeyIds.add(message.descriptor.tags!.keyId as string);
  }
  if (isDelivery) {
    scan.deliveredKeyIds.add(message.descriptor.tags!.keyId as string);
  }
  if (!isAncestor && !isRole && !isInitialRole && !isUsableAudience && !isDelivery) {
    scan.unrelated ??= entry;
  }
}

function assertRoleAudienceReady(
  params: SupportValidationParams,
  currentProtocolConfigure: ProtocolsConfigureMessage,
  wrappedKeyIds: ReadonlySet<string>,
  scan: SupportScan,
): void {
  const roleRuleSet = getRuleSetAtPath(params.protocolRole, currentProtocolConfigure.descriptor.definition.structure);
  const deliveryRequired = roleRuleSet?.$role === true && roleRuleSet.$keyAgreement !== undefined;
  const missingAudience = (deliveryRequired && scan.audienceKeyIds.size === 0) ||
    [...wrappedKeyIds].some(keyId => !scan.audienceKeyIds.has(keyId));
  const missingDelivery = [...scan.audienceKeyIds].some(keyId => !scan.deliveredKeyIds.has(keyId));
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
  const tags = message.descriptor.tags;
  return contextId !== undefined &&
    message.descriptor.protocol === protocol &&
    message.descriptor.protocolPath === protocolPath &&
    tags?.protocol === protocol &&
    tags.rolePath === rolePath &&
    tags.contextId === contextId &&
    typeof tags.keyId === 'string';
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
  return new Error(`Role replication support returned unrelated entry ${interfaceName}/${method}.`);
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
      throw new Error('Role replication support entry inline data exceeds its declared bound.');
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
