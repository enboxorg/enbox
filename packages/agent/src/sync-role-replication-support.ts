import type {
  ProtocolDefinition,
  ProtocolsConfigureMessage,
  RecordsDeleteMessage,
  RecordsFilter,
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
export async function readRoleReplicationSupport(params: {
  actorDid: string;
  agent: EnboxPlatformAgent;
  contextId: string;
  delegateDid?: string;
  dwnUrl: string;
  expectedRootCid?: string;
  permissionsApi: PermissionsApi;
  protocol: string;
  protocolPath: string;
  protocolRole: string;
  shouldContinue?: () => boolean;
  sourceDid: string;
}): Promise<RoleReplicationSupportBatch> {
  assertCurrent(params.shouldContinue);
  const recordId = params.contextId.split('/').at(-1);
  if (recordId === undefined || recordId.length === 0) {
    throw new TypeError('Role replication support requires an exact context ID.');
  }
  const { protocolPath } = params;

  const delegatedGrant = await resolveDelegatedRoleReadGrant(params, params.contextId, protocolPath);

  const filter: RecordsFilter = {
    contextId : params.contextId,
    protocol  : params.protocol,
    protocolPath,
    recordId,
  };
  const createReadMessage = async (includeReplicationSupport: boolean): Promise<RecordsReadMessage> => {
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
  };
  const message = await createReadMessage(true);

  assertCurrent(params.shouldContinue);
  let requestDwnUrl = params.dwnUrl;
  try {
    requestDwnUrl = await resolveDwnWebSocketUrl(params.dwnUrl, params.agent.rpc);
  } catch {
    // HTTP remains valid when the endpoint does not advertise WebSockets.
  }
  let reply: RecordsReadReply;
  if (requestDwnUrl === params.dwnUrl) {
    reply = await params.agent.rpc.sendDwnRequest({
      dwnUrl    : params.dwnUrl,
      message,
      targetDid : params.sourceDid,
    }) as RecordsReadReply;
  } else {
    const dataMessage = await createReadMessage(false);
    const [supportResult, dataResult] = await Promise.allSettled([
      params.agent.rpc.sendDwnRequest({
        dwnUrl    : requestDwnUrl,
        message,
        targetDid : params.sourceDid,
      }) as Promise<RecordsReadReply>,
      params.agent.rpc.sendDwnRequest({
        dwnUrl    : params.dwnUrl,
        message   : dataMessage,
        targetDid : params.sourceDid,
      }) as Promise<RecordsReadReply>,
    ]);

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
    reply = supportReply;
  }
  const responseData = reply.entry?.data;
  try {
    assertCurrent(params.shouldContinue);
    if (reply.status.code !== 200) {
      const detail = reply.status.detail ?? 'Unknown error';
      const missingRole = DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound;
      if (reply.status.code === 401 && (detail === missingRole || detail.startsWith(`${missingRole}:`))) {
        throw new FollowedSourceRoleAbsentError(detail);
      }
      throw new Error(
        `Role replication support read failed (${reply.status.code}): ${detail}`,
      );
    }
    const rootMessage = reply.entry?.recordsWrite;
    const rootData = reply.entry?.data;
    if (rootMessage === undefined || rootData === undefined) {
      throw new Error('Role replication support response did not contain a readable root record.');
    }
    assertRoot(rootMessage, {
      contextId : params.contextId,
      protocol  : params.protocol,
      protocolPath,
      recordId,
    });

    const rootCid = await Message.getCid(rootMessage);
    if (params.expectedRootCid !== undefined && rootCid !== params.expectedRootCid) {
      throw new Error(
        `Role replication support returned root CID '${rootCid}' instead of '${params.expectedRootCid}'.`,
      );
    }

    const support = reply.support ?? [];
    const roleContextId = getRoleContextPrefix(params.protocolRole, params.contextId);
    const { protocolDefinition, roleRecordId } = await validateSupport({
      actorDid     : params.actorDid,
      agent        : params.agent,
      contextId    : params.contextId,
      protocol     : params.protocol,
      protocolPath,
      protocolRole : params.protocolRole,
      replyRoleId  : reply.roleRecordId,
      roleContextId,
      root         : rootMessage,
      sourceDid    : params.sourceDid,
      support,
    });

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
      dependencies : [...dependencies.values()],
      protocolDefinition,
      roleRecordId,
      root         : {
        message           : rootMessage,
        dataStream        : capRecordsWriteDataStream(rootMessage, verifiedRootData),
        isLatestBaseState : true,
      },
      rootCid,
    };
  } catch (error: unknown) {
    await responseData?.cancel().catch((): void => {});
    throw error;
  }
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

async function validateSupport(params: {
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
}): Promise<{ protocolDefinition: ProtocolDefinition; roleRecordId: string }> {
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
  const audienceKeyIds = new Set<string>();
  const deliveredKeyIds = new Set<string>();
  let role: RecordsWriteMessage | undefined;
  let roleMatches = 0;
  let initialRoleMatches = 0;
  let currentProtocolConfigure: ProtocolsConfigureMessage | undefined;
  let currentProtocolConfigureMatches = 0;
  let unrelated: RecordsReadReplicationSupportEntry | undefined;
  const isExpectedProtocolConfigure = isTenantProtocolConfig(params.sourceDid, params.protocol);

  for (const entry of params.support) {
    if (isExpectedProtocolConfigure(entry.message)) {
      if (
        typeof entry.isLatestBaseState !== 'boolean' ||
        entry.encodedData !== undefined
      ) {
        unrelated ??= entry;
      }
      if (entry.isLatestBaseState === true) {
        currentProtocolConfigure = entry.message;
        currentProtocolConfigureMatches++;
      }
      continue;
    }
    if (!Records.isRecordsWrite(entry.message)) {
      unrelated ??= entry;
      continue;
    }

    const message = entry.message;
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
    if (isRole) {
      role = message;
      roleMatches++;
    }
    if (isInitialRole) {
      initialRoleMatches++;
    }
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

    if (isUsableAudience && isRoleAudience) {
      audienceKeyIds.add(message.descriptor.tags!.keyId as string);
    }
    if (isDelivery) {
      deliveredKeyIds.add(message.descriptor.tags!.keyId as string);
    }

    if (!isAncestor && !isRole && !isInitialRole && !isUsableAudience && !isDelivery) {
      unrelated ??= entry;
    }
  }
  if (params.replyRoleId === undefined) {
    throw new Error('Role replication support response did not identify its active role record.');
  }
  if (role === undefined || roleMatches !== 1) {
    throw new Error(
      `Role replication support response role '${params.replyRoleId}' is not bound to exactly one signed active assignment.`,
    );
  }
  const expectedInitialRoleMatches = await RecordsWrite.isInitialWrite(role) ? 0 : 1;
  if (initialRoleMatches !== expectedInitialRoleMatches) {
    throw new Error('Role replication support response has an invalid initial role assignment.');
  }
  if (unrelated !== undefined) {
    throw unsupportedEntry(unrelated);
  }
  if (currentProtocolConfigure === undefined || currentProtocolConfigureMatches !== 1) {
    throw new Error('Role replication support response must contain exactly one current protocol configuration.');
  }

  await RecordsWrite.parse(role);
  await authenticate(role.authorization, params.agent.did);
  const roleRuleSet = getRuleSetAtPath(params.protocolRole, currentProtocolConfigure.descriptor.definition.structure);
  const deliveryRequired = roleRuleSet?.$role === true && roleRuleSet.$keyAgreement !== undefined;
  const missingAudience = (deliveryRequired && audienceKeyIds.size === 0) ||
    [...wrappedKeyIds].some(keyId => !audienceKeyIds.has(keyId));
  const missingDelivery = [...audienceKeyIds].some(keyId => !deliveredKeyIds.has(keyId));
  if (missingAudience || missingDelivery) {
    throw new FollowedSourceNotReadyError(
      missingAudience
        ? 'the role audience key is unavailable.'
        : `the audience key has not been delivered to ${params.actorDid}.`,
    );
  }
  return {
    protocolDefinition : currentProtocolConfigure.descriptor.definition,
    roleRecordId       : params.replyRoleId,
  };
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
