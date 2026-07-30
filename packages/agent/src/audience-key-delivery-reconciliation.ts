import type {
  GenericMessage,
  MessagesQueryReplyEntry,
  ProgressToken,
  ProtocolDefinition,
  RecordsDeleteMessage,
} from '@enbox/dwn-sdk-js';

import type { AudienceKeyDeliveryIntent } from './audience-key-delivery.js';
import type { EnboxPlatformAgent } from './types/agent.js';

import {
  DwnInterfaceName,
  DwnMethodName,
  getGrantKeyDeliveryScopes,
  getRoleAudienceContextId,
  Records,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { queryLocalMessageFeed } from './sync-messages.js';
import { getMessagesPermissionGrantsForScope, permissionGrantIdsFromEntries } from './sync-permission-grants.js';
import { isValidProgressToken, SyncCheckpoint } from './sync-checkpoint.js';

const PAGE_LIMIT = 100;

/** Scans the complete local feed for the active encrypted roles in one protocol. */
export async function scanActiveAudienceKeyDeliveryIntents({
  agent,
  delegateDid,
  protocolDefinition,
  sourceDid,
}: {
  agent: EnboxPlatformAgent;
  delegateDid?: string;
  protocolDefinition: ProtocolDefinition;
  sourceDid: string;
}): Promise<AudienceKeyDeliveryIntent[]> {
  const protocol = protocolDefinition.protocol;
  const rolePaths = new Set(getGrantKeyDeliveryScopes({
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Write,
    protocol,
  }, protocolDefinition).flatMap(scope => scope.protocolPath === undefined ? [] : [scope.protocolPath]));
  if (rolePaths.size === 0) {
    return [];
  }

  const permissionGrants = await getMessagesPermissionGrantsForScope({
    did            : sourceDid,
    delegateDid,
    protocols      : [protocol],
    messageType    : DwnInterface.MessagesQuery,
    permissionsApi : agent.permissions,
  });
  const permissionGrantIds = permissionGrantIdsFromEntries(permissionGrants);
  const intents = new Map<string, AudienceKeyDeliveryIntent>();
  let cursor: ProgressToken | undefined;

  for (;;) {
    const reply = await queryLocalMessageFeed({
      agent,
      cursor,
      delegateDid,
      did     : sourceDid,
      filters : [...rolePaths].map(protocolPathPrefix => ({
        interface: DwnInterfaceName.Records,
        protocol,
        protocolPathPrefix,
      })),
      limit: PAGE_LIMIT,
      permissionGrantIds,
    });
    if (reply.status.code !== 200 || reply.entries === undefined) {
      throw new Error(
        `AgentDwnApi: role delivery reconciliation failed for ${sourceDid} / ${protocol}: ` +
        `${reply.status.code} ${reply.status.detail}`,
      );
    }

    applyFeedEntries(reply.entries, intents, sourceDid, protocol, rolePaths);

    if (reply.drained === true) {
      return [...intents.values()];
    }
    cursor = advancingCursor(cursor, reply.cursor);
  }
}

function applyFeedEntries(
  entries: readonly MessagesQueryReplyEntry[],
  intents: Map<string, AudienceKeyDeliveryIntent>,
  sourceDid: string,
  protocol: string,
  rolePaths: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    if (entry.message === undefined) {
      throw new Error(`AgentDwnApi: role delivery reconciliation received message metadata without the message.`);
    }
    if (isRecordsDelete(entry.message)) {
      intents.delete(entry.message.descriptor.recordId);
      continue;
    }
    if (!entry.isLatestBaseState) {
      continue;
    }

    const intent = roleDeliveryIntent(entry.message, sourceDid, protocol, rolePaths);
    if (intent !== undefined) {
      intents.set(intent.roleRecordId, intent);
    }
  }
}

function advancingCursor(previous: ProgressToken | undefined, next: ProgressToken | undefined): ProgressToken {
  if (next === undefined || !isValidProgressToken(next)) {
    throw new Error(`AgentDwnApi: role delivery reconciliation returned no valid cursor before drain.`);
  }
  if (previous !== undefined && (
    previous.streamId !== next.streamId ||
    previous.epoch !== next.epoch ||
    SyncCheckpoint.comparePosition(next, previous) <= 0
  )) {
    throw new Error(`AgentDwnApi: role delivery reconciliation cursor did not advance.`);
  }
  return next;
}

function roleDeliveryIntent(
  message: GenericMessage,
  sourceDid: string,
  protocol: string,
  rolePaths: ReadonlySet<string>,
): AudienceKeyDeliveryIntent | undefined {
  if (!Records.isRecordsWrite(message)) {
    return undefined;
  }

  const { protocol: messageProtocol, protocolPath, recipient } = message.descriptor;
  if (messageProtocol !== protocol || protocolPath === undefined || !rolePaths.has(protocolPath)) {
    return undefined;
  }

  const contextId = getRoleAudienceContextId(protocolPath, message.contextId);
  if (recipient === undefined || contextId === undefined) {
    throw new Error(`AgentDwnApi: active role record '${message.recordId}' has no delivery recipient or audience context.`);
  }

  return {
    contextId,
    protocol,
    recipientDid : recipient,
    rolePath     : protocolPath,
    roleRecordId : message.recordId,
    sourceDid,
  };
}

function isRecordsDelete(message: GenericMessage): message is RecordsDeleteMessage {
  return message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Delete;
}
