import type {
  ProtocolDefinition,
  ProtocolsConfigureMessage,
  RecordsFilter,
  RecordsReadReplicationSupportEntry,
  RecordsReadReply,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { SyncMessageEntry } from './sync-messages.js';

import {
  authenticate,
  DwnConstant,
  DwnInterfaceName,
  DwnMethodName,
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
import { verifyRemoteDwnResponse } from './remote-dwn-response.js';
import { capRecordsWriteDataStream, SyncPullAbortedError } from './sync-messages.js';

/** A role-authorized read and its server-proven local-replication prerequisites. */
export type RoleReplicationSupportBatch = {
  dependencies: SyncMessageEntry[];
  roleRecordId: string;
  root: SyncMessageEntry;
  rootCid: string;
};

/** The role is valid, but its audience key material is not ready for this member. */
export class FollowedSourceNotReadyError extends Error {
  public constructor(detail: string) {
    super(`Followed source is not ready: ${detail}`);
    this.name = 'FollowedSourceNotReadyError';
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
  recordId: string;
  shouldContinue?: () => boolean;
  sourceDid: string;
}): Promise<RoleReplicationSupportBatch> {
  assertCurrent(params.shouldContinue);

  let delegatedGrant;
  if (params.delegateDid !== undefined) {
    ({ message: delegatedGrant } = await params.permissionsApi.getPermissionForRequest({
      connectedDid : params.actorDid,
      contextId    : params.contextId,
      delegate     : true,
      delegateDid  : params.delegateDid,
      forceRefresh : true,
      messageType  : DwnInterface.RecordsRead,
      protocol     : params.protocol,
      protocolPath : params.protocolPath,
    }));
  }

  const filter: RecordsFilter = {
    contextId    : params.contextId,
    protocol     : params.protocol,
    protocolPath : params.protocolPath,
    recordId     : params.recordId,
  };
  const { message } = await params.agent.dwn.processRequest({
    author        : params.actorDid,
    granteeDid    : params.delegateDid,
    messageParams : {
      filter,
      includeReplicationSupport : true,
      protocolRole              : params.protocolRole,
      ...(delegatedGrant === undefined ? {} : { delegatedGrant }),
    },
    messageType : DwnInterface.RecordsRead,
    store       : false,
    target      : params.sourceDid,
  });
  if (message === undefined) {
    throw new Error('Role replication support read did not produce a signed request.');
  }

  assertCurrent(params.shouldContinue);
  const reply = await params.agent.rpc.sendDwnRequest({
    dwnUrl    : params.dwnUrl,
    message,
    targetDid : params.sourceDid,
  }) as RecordsReadReply;
  assertCurrent(params.shouldContinue);
  await verifyRemoteDwnResponse({
    didResolver : params.agent.did,
    message,
    reply,
    targetDid   : params.sourceDid,
  });

  if (reply.status.code !== 200) {
    throw new Error(
      `Role replication support read failed (${reply.status.code}): ${reply.status.detail ?? 'Unknown error'}`,
    );
  }
  const rootMessage = reply.entry?.recordsWrite;
  const rootData = reply.entry?.data;
  if (rootMessage === undefined || rootData === undefined) {
    throw new Error('Role replication support response did not contain a readable root record.');
  }
  assertRoot(rootMessage, params);

  const rootCid = await Message.getCid(rootMessage);
  if (params.expectedRootCid !== undefined && rootCid !== params.expectedRootCid) {
    throw new Error(
      `Role replication support returned root CID '${rootCid}' instead of '${params.expectedRootCid}'.`,
    );
  }

  const support = reply.support ?? [];
  await verifyRootInitialWrite(reply.entry?.initialWrite, rootMessage);
  const roleContextId = getRoleContextPrefix(params.protocolRole, params.contextId);
  const { protocolDefinition, roleRecordId } = await validateSupport({
    actorDid     : params.actorDid,
    agent        : params.agent,
    contextId    : params.contextId,
    protocol     : params.protocol,
    protocolPath : params.protocolPath,
    protocolRole : params.protocolRole,
    replyRoleId  : reply.roleRecordId,
    roleContextId,
    sourceDid    : params.sourceDid,
    support,
  });
  const roleRuleSet = getRuleSetAtPath(params.protocolRole, protocolDefinition.structure);
  assertAudienceDeliveryReady(
    rootMessage,
    support,
    params,
    roleRuleSet?.$role === true && roleRuleSet.$keyAgreement !== undefined,
  );

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
    if (entry.initialWrite !== undefined) {
      await append({ message: entry.initialWrite, isLatestBaseState: false });
    }
    await append(toSyncEntry(entry));
  }

  return {
    dependencies : [...dependencies.values()],
    roleRecordId,
    root         : {
      message           : rootMessage,
      dataStream        : capRecordsWriteDataStream(rootMessage, rootData),
      isLatestBaseState : true,
    },
    rootCid,
  };
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

async function verifyRootInitialWrite(
  initialWrite: RecordsWriteMessage | undefined,
  root: RecordsWriteMessage,
): Promise<void> {
  if (initialWrite === undefined) {
    return;
  }
  assertRoot(initialWrite, {
    contextId    : root.contextId,
    protocol     : root.descriptor.protocol,
    protocolPath : root.descriptor.protocolPath,
    recordId     : root.recordId,
  });
  if (!await RecordsWrite.isInitialWrite(initialWrite)) {
    throw new Error('Role replication support root initialWrite is not an initial write.');
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
  let role: RecordsWriteMessage | undefined;
  let roleMatches = 0;
  let currentProtocolConfigure: ProtocolsConfigureMessage | undefined;
  let currentProtocolConfigureMatches = 0;
  let unrelated: RecordsReadReplicationSupportEntry | undefined;

  for (const entry of params.support) {
    const actualCid = await Message.getCid(entry.message);
    if (actualCid !== entry.messageCid) {
      throw new Error(`Role replication support entry CID '${entry.messageCid}' does not match '${actualCid}'.`);
    }
    if (isExactProtocolConfigure(entry.message, params.protocol, params.sourceDid)) {
      if (
        typeof entry.isLatestBaseState !== 'boolean' ||
        entry.initialWrite !== undefined ||
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
    const isRole = message.recordId === params.replyRoleId &&
      message.descriptor.protocol === params.protocol &&
      message.descriptor.protocolPath === params.protocolRole &&
      message.descriptor.recipient === params.actorDid &&
      Records.getParentContextFromOfContextId(message.contextId) === params.roleContextId &&
      entry.isLatestBaseState === true &&
      typeof entry.encodedData === 'string';
    if (isRole) {
      role = message;
      roleMatches++;
    }
    const isAudience = isTaggedEncryptionControl(
      message,
      ENCRYPTION_CONTROL_AUDIENCE_PATH,
      params.protocol,
      params.protocolRole,
      audienceContextId,
    ) && entry.isLatestBaseState === true && typeof entry.encodedData === 'string';
    const isDelivery = isTaggedEncryptionControl(
      message,
      ENCRYPTION_CONTROL_DELIVERY_PATH,
      params.protocol,
      params.protocolRole,
      audienceContextId,
    ) && message.descriptor.recipient === params.actorDid &&
      entry.isLatestBaseState === true && typeof entry.encodedData === 'string';

    if (!isAncestor && !isRole && !isAudience && !isDelivery) {
      unrelated ??= entry;
      continue;
    }
    if (entry.initialWrite !== undefined) {
      if (!isRole || entry.initialWrite.recordId !== message.recordId || !await RecordsWrite.isInitialWrite(entry.initialWrite)) {
        unrelated ??= entry;
        continue;
      }
      const initialRole = entry.initialWrite;
      if (
        initialRole.descriptor.protocol !== params.protocol ||
        initialRole.descriptor.protocolPath !== params.protocolRole ||
        initialRole.descriptor.recipient !== params.actorDid ||
        Records.getParentContextFromOfContextId(initialRole.contextId) !== params.roleContextId
      ) {
        unrelated ??= entry;
      }
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
  if (unrelated !== undefined) {
    throw unsupportedEntry(unrelated);
  }
  if (currentProtocolConfigure === undefined || currentProtocolConfigureMatches !== 1) {
    throw new Error('Role replication support response must contain exactly one current protocol configuration.');
  }

  await RecordsWrite.parse(role);
  await authenticate(role.authorization, params.agent.did);
  return {
    protocolDefinition : currentProtocolConfigure.descriptor.definition,
    roleRecordId       : params.replyRoleId,
  };
}

function isExactProtocolConfigure(
  message: RecordsReadReplicationSupportEntry['message'],
  protocol: string,
  sourceDid: string,
): message is ProtocolsConfigureMessage {
  if (
    message.descriptor.interface !== DwnInterfaceName.Protocols ||
    message.descriptor.method !== DwnMethodName.Configure
  ) {
    return false;
  }
  const definition = (message.descriptor as { definition?: { protocol?: unknown } }).definition;
  return definition?.protocol === protocol && Message.getAuthor(message) === sourceDid;
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

function unsupportedEntry(entry: RecordsReadReplicationSupportEntry): Error {
  return new Error(`Role replication support returned unrelated entry '${entry.messageCid}'.`);
}

function assertAudienceDeliveryReady(
  root: RecordsWriteMessage,
  support: readonly RecordsReadReplicationSupportEntry[],
  expected: { actorDid: string; contextId: string; protocol: string; protocolRole: string },
  deliveryRequired: boolean,
): void {
  const wrappedKeyIds = new Set(root.encryption?.keyEncryption
    .filter(entry => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
      'protocol' in entry && entry.protocol === expected.protocol && entry.rolePath === expected.protocolRole)
    .map(entry => entry.keyId) ?? []);

  const audienceContextId = getRoleAudienceContextId(expected.protocolRole, expected.contextId);
  const audienceKeyIds = new Set<string>();
  const deliveredKeyIds = new Set<string>();
  for (const entry of support) {
    if (!Records.isRecordsWrite(entry.message)) {
      continue;
    }
    const message = entry.message;
    if (isTaggedEncryptionControl(
      message,
      ENCRYPTION_CONTROL_AUDIENCE_PATH,
      expected.protocol,
      expected.protocolRole,
      audienceContextId,
    )) {
      audienceKeyIds.add(message.descriptor.tags!.keyId as string);
    }
    if (
      message.descriptor.recipient === expected.actorDid &&
      isTaggedEncryptionControl(
        message,
        ENCRYPTION_CONTROL_DELIVERY_PATH,
        expected.protocol,
        expected.protocolRole,
        audienceContextId,
      )
    ) {
      deliveredKeyIds.add(message.descriptor.tags!.keyId as string);
    }
  }

  if (!deliveryRequired && wrappedKeyIds.size === 0 && audienceKeyIds.size === 0) {
    return;
  }
  const missingAudience = (deliveryRequired && audienceKeyIds.size === 0) ||
    [...wrappedKeyIds].some(keyId => !audienceKeyIds.has(keyId));
  const missingDelivery = [...audienceKeyIds].some(keyId => !deliveredKeyIds.has(keyId));
  if (missingAudience || missingDelivery) {
    throw new FollowedSourceNotReadyError(
      missingAudience
        ? 'the role audience key is unavailable.'
        : `the audience key has not been delivered to ${expected.actorDid}.`,
    );
  }
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
      throw new Error(`Role replication support entry '${entry.messageCid}' inline data exceeds its declared bound.`);
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
