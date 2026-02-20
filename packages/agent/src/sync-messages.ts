import type { PermissionsApi } from './types/permissions.js';
import type { Web5PlatformAgent } from './types/agent.js';
import type { GenericMessage, MessagesReadReply, UnionMessageReply } from '@enbox/dwn-sdk-js';

import { DwnInterfaceName, DwnMethodName, Message } from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { topologicalSort } from './sync-topological-sort.js';

/** Entry type for fetched messages with optional data stream. */
export type SyncMessageEntry = { message: GenericMessage; dataStream?: ReadableStream<Uint8Array> };

/**
 * 202: message was successfully written to the remote DWN
 * 204: an initial write message was written without any data
 * 409: message was already present on the remote DWN
 * RecordsDelete + 404: the initial write was not found or already deleted
 */
export function syncMessageReplyIsSuccessful(reply: UnionMessageReply): boolean {
  return reply.status.code === 202 ||
    reply.status.code === 204 ||
    reply.status.code === 409 ||
    (
      reply.entry?.message.descriptor.interface === DwnInterfaceName.Records &&
      reply.entry?.message.descriptor.method === DwnMethodName.Delete &&
      reply.status.code === 404
    );
}

/**
 * Helper to get the CID of a message for logging purposes.
 */
export async function getMessageCid(message: GenericMessage): Promise<string> {
  try {
    return await Message.getCid(message);
  } catch {
    return 'unknown';
  }
}

/**
 * Fetches missing messages from the remote DWN and processes them on the local DWN
 * in dependency order (topological sort).
 *
 * Messages that fail processing are re-fetched from the remote before each retry
 * pass rather than buffered in memory. ReadableStream is single-use, so a failed
 * message's data stream is consumed on the first attempt. Re-fetching provides a
 * fresh stream without holding all record data in memory simultaneously.
 */
export async function pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids, agent, permissionsApi }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  messageCids: string[];
  agent: Web5PlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<void> {
  // Step 1: Fetch all missing messages from the remote in parallel.
  const fetched = await fetchRemoteMessages({ did, dwnUrl, delegateDid, protocol, messageCids, agent, permissionsApi });

  // Step 2: Build dependency graph and topological sort.
  const sorted = topologicalSort(fetched);

  // Step 3: Process messages in dependency order with multi-pass retry.
  // Retry up to MAX_RETRY_PASSES times for messages that fail due to
  // dependency ordering issues (e.g., a RecordsWrite whose ProtocolsConfigure
  // hasn't committed yet). Failed messages are re-fetched from the remote
  // to obtain a fresh data stream, since ReadableStream is single-use.
  const MAX_RETRY_PASSES = 3;
  let pending = sorted;

  for (let pass = 0; pass <= MAX_RETRY_PASSES && pending.length > 0; pass++) {
    const failedCids: string[] = [];

    for (const entry of pending) {
      const pullReply = await agent.dwn.node.processMessage(did, entry.message, { dataStream: entry.dataStream });
      if (!syncMessageReplyIsSuccessful(pullReply)) {
        const cid = await getMessageCid(entry.message);
        failedCids.push(cid);
      }
    }

    // Re-fetch failed messages from the remote to get fresh data streams.
    if (failedCids.length > 0) {
      const reFetched = await fetchRemoteMessages({ did, dwnUrl, delegateDid, protocol, messageCids: failedCids, agent, permissionsApi });
      pending = topologicalSort(reFetched);
    } else {
      pending = [];
    }
  }
}

/**
 * Fetches messages from a remote DWN by their CIDs using MessagesRead.
 */
export async function fetchRemoteMessages({ did, dwnUrl, delegateDid, protocol, messageCids, agent, permissionsApi }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  messageCids: string[];
  agent: Web5PlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<SyncMessageEntry[]> {
  const results: SyncMessageEntry[] = [];

  let permissionGrantId: string | undefined;
  if (delegateDid) {
    try {
      const messagesReadGrant = await permissionsApi.getPermissionForRequest({
        connectedDid : did,
        messageType  : DwnInterface.MessagesRead,
        delegateDid,
        protocol,
        cached       : true
      });
      permissionGrantId = messagesReadGrant.grant.id;
    } catch (error: any) {
      console.error('SyncEngineLevel: pull - Error fetching MessagesRead permission grant for delegate DID', error);
      return results;
    }
  }

  // Fetch messages in parallel with bounded concurrency.
  const CONCURRENCY = 10;
  let cursor = 0;

  while (cursor < messageCids.length) {
    const batch = messageCids.slice(cursor, cursor + CONCURRENCY);
    cursor += CONCURRENCY;

    type FetchResult = SyncMessageEntry | undefined;
    const batchResults = await Promise.all(batch.map(async (messageCid): Promise<FetchResult> => {
      const messagesRead = await agent.processDwnRequest({
        store         : false,
        author        : did,
        target        : did,
        messageType   : DwnInterface.MessagesRead,
        granteeDid    : delegateDid,
        messageParams : { messageCid, permissionGrantId }
      });

      let reply: MessagesReadReply;
      try {
        reply = await agent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid : did,
          message   : messagesRead.message,
        }) as MessagesReadReply;
      } catch {
        return undefined;
      }

      if (reply.status.code !== 200 || !reply.entry?.message) {
        return undefined;
      }

      const replyEntry = reply.entry;
      let dataStream: ReadableStream<Uint8Array> | undefined;
      if (isRecordsWrite(replyEntry) && replyEntry.data) {
        dataStream = replyEntry.data;
      }

      return { message: replyEntry.message, dataStream };
    }));

    for (const result of batchResults) {
      if (result) {
        results.push(result);
      }
    }
  }

  return results;
}

/**
 * Reads missing messages from the local DWN and pushes them to the remote DWN.
 * Messages are fetched first, then sorted in dependency order (topological sort)
 * so that initial writes come before updates, and ProtocolsConfigures come before
 * records that reference those protocols.
 */
export async function pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids, agent, permissionsApi }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  messageCids: string[];
  agent: Web5PlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<void> {
  // Step 1: Fetch all local messages (streams are pull-based, not yet consumed).
  const fetched: SyncMessageEntry[] = [];
  for (const messageCid of messageCids) {
    const dwnMessage = await getLocalMessage({ author: did, messageCid, delegateDid, protocol, agent, permissionsApi });
    if (dwnMessage) {
      fetched.push(dwnMessage);
    }
  }

  // Step 2: Sort in dependency order using topological sort.
  const sorted = topologicalSort(fetched);

  // Step 3: Push messages in dependency order, consuming each stream as we go.
  for (const entry of sorted) {
    try {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : did,
        data      : entry.dataStream,
        message   : entry.message
      });

      if (!syncMessageReplyIsSuccessful(reply)) {
        const cid = await getMessageCid(entry.message);
        console.error(`SyncEngineLevel: push failed for ${cid}: ${reply.status.code} ${reply.status.detail}`);
      }
    } catch {
      // Remote unreachable — stop pushing to this endpoint.
      throw new Error(`SyncEngineLevel: Remote DWN at ${dwnUrl} is unreachable.`);
    }
  }
}

/**
 * Reads a message from the local DWN by its CID using MessagesRead.
 */
export async function getLocalMessage({ author, delegateDid, protocol, messageCid, agent, permissionsApi }: {
  author: string;
  delegateDid?: string;
  protocol?: string;
  messageCid: string;
  agent: Web5PlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<SyncMessageEntry | undefined> {
  let permissionGrantId: string | undefined;
  if (delegateDid) {
    try {
      const messagesReadGrant = await permissionsApi.getPermissionForRequest({
        connectedDid : author,
        messageType  : DwnInterface.MessagesRead,
        delegateDid,
        protocol,
        cached       : true
      });
      permissionGrantId = messagesReadGrant.grant.id;
    } catch (error: any) {
      console.error('SyncEngineLevel: push - Error fetching MessagesRead permission grant for delegate DID', error);
      return;
    }
  }

  const { reply } = await agent.dwn.processRequest({
    author,
    target        : author,
    messageType   : DwnInterface.MessagesRead,
    granteeDid    : delegateDid,
    messageParams : { messageCid, permissionGrantId }
  });

  if (reply.status.code !== 200 || !reply.entry) {
    return undefined;
  }
  const messageEntry = reply.entry!;

  const result: SyncMessageEntry = {
    message: messageEntry.message
  };

  if (isRecordsWrite(messageEntry) && messageEntry.data) {
    result.dataStream = messageEntry.data;
  }

  return result;
}
