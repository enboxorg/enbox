import type { GenericMessage, MessagesReadReply, MessagesSyncDiffEntry, UnionMessageReply } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { PermanentPushFailure, PushResult } from './types/sync.js';

import { DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { topologicalSort } from './sync-topological-sort.js';
import { getMessagesPermissionGrantId, toMessagesPermissionGrantIds } from './sync-permission-grants.js';

/** Maximum data size (in bytes) to buffer in memory for retry. Larger payloads are re-fetched. */
const MAX_BUFFER_SIZE = 1_048_576; // 1 MB

/** Entry type for fetched messages with optional data stream and retry buffer. */
export type SyncMessageEntry = {
  message: GenericMessage;
  dataStream?: ReadableStream<Uint8Array>;
  /** Buffered data bytes for retry — avoids re-fetching from remote when stream is consumed. */
  bufferedData?: Uint8Array;
};

/**
 * 202: message was successfully written to the remote DWN
 * 204: an initial write message was written without any data
 * 409: message was already present on the remote DWN
 *
 * When the *pushed* message is known (e.g. during push-sync), pass it as the
 * second argument so that RecordsDelete + 404 ("initial write was not found or
 * already deleted") can be detected.  The DWN's 404 reply omits `entry`, so
 * checking `reply.entry` alone is insufficient.
 */
export function syncMessageReplyIsSuccessful(reply: UnionMessageReply, pushedMessage?: GenericMessage): boolean {
  if (reply.status.code === 202 || reply.status.code === 204 || reply.status.code === 409) {
    return true;
  }

  if (reply.status.code === 404) {
    // Check the pushed message first (always available during push-sync).
    if (pushedMessage?.descriptor.interface === DwnInterfaceName.Records &&
        pushedMessage?.descriptor.method === DwnMethodName.Delete) {
      return true;
    }

    // Fallback: check the reply entry (for callers that don't pass the pushed message).
    if (reply.entry?.message.descriptor.interface === DwnInterfaceName.Records &&
        reply.entry?.message.descriptor.method === DwnMethodName.Delete) {
      return true;
    }
  }

  return false;
}

/**
 * 400 detail substrings that indicate a protocol dependency hasn't
 * arrived on the remote yet. These resolve on retry once the
 * dependency is pushed, so they must NOT be treated as permanent.
 */
const TRANSIENT_DEPENDENCY_PATTERNS = [
  'ComposedProtocolNotInstalled',
  'ProtocolNotFound',
];

/**
 * Classifies a failed push reply as permanent (dead-letter) or
 * transient (retry with backoff).
 *
 * Permanent: 401/403 auth errors, most 400 validation errors.
 * Transient: 5xx, network errors, and 400 protocol-dependency errors
 * that self-heal once the dependency arrives on the remote.
 */
export function isPermanentPushFailure(reply: UnionMessageReply): boolean {
  const { code, detail } = reply.status;

  if (code === 401 || code === 403) { return true; }

  if (code === 400) {
    return !TRANSIENT_DEPENDENCY_PATTERNS.some(pattern => detail?.includes(pattern));
  }

  return false;
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
 * Small data payloads (≤ 1 MB) are buffered during the initial fetch so that
 * retries can replay the data from memory instead of re-fetching from remote.
 * Large payloads are re-fetched on retry since buffering them would consume
 * too much memory.
 */
export async function pullMessages({ did, dwnUrl, delegateDid, protocol, messageCids, prefetched, agent, permissionsApi }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  messageCids: string[];
  /** Pre-fetched message entries from the batched diff response (already have message + data). */
  prefetched?: MessagesSyncDiffEntry[];
  agent: EnboxPlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<string[]> {
  // Convert prefetched diff entries into SyncMessageEntry format.
  const prefetchedEntries: SyncMessageEntry[] = [];
  if (prefetched) {
    for (const entry of prefetched) {
      if (!entry.message) { continue; }
      const syncEntry: SyncMessageEntry = { message: entry.message };
      if (entry.encodedData) {
        // Convert base64url-encoded data to a ReadableStream.
        const bytes = Encoder.base64UrlToBytes(entry.encodedData);
        syncEntry.bufferedData = bytes;
        syncEntry.dataStream = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          }
        });
      }
      prefetchedEntries.push(syncEntry);
    }
  }

  // Step 1: Fetch remaining messages (not prefetched) from the remote.
  const fetched = messageCids.length > 0
    ? await fetchRemoteMessages({ did, dwnUrl, delegateDid, protocol, messageCids, agent, permissionsApi })
    : [];

  // Merge prefetched entries with remotely fetched ones.
  const allFetched = [...prefetchedEntries, ...fetched];

  // Step 2: Build dependency graph and topological sort.
  const sorted = topologicalSort(allFetched);

  // Step 3: Buffer small data streams so they can be replayed on retry.
  await bufferSmallStreams(sorted);

  // Step 4: Process messages in dependency order with multi-pass retry.
  const MAX_RETRY_PASSES = 3;
  let pending = sorted;

  for (let pass = 0; pass <= MAX_RETRY_PASSES && pending.length > 0; pass++) {
    const failed: SyncMessageEntry[] = [];

    for (const entry of pending) {
      // Create a fresh ReadableStream from the buffer if available (stream is single-use).
      const dataStream = entry.bufferedData
        ? new ReadableStream<Uint8Array>({ start(c): void { c.enqueue(entry.bufferedData!); c.close(); } })
        : entry.dataStream;

      const pullReply = await agent.dwn.processRawMessage(did, entry.message, { dataStream });

      if (!syncMessageReplyIsSuccessful(pullReply)) {
        failed.push(entry);
      }
    }

    if (failed.length > 0) {
      // Separate entries that have a buffer (can retry locally) from those
      // that need a fresh fetch (large payloads whose stream was consumed).
      const needsRefetch: string[] = [];
      const canRetry: SyncMessageEntry[] = [];

      for (const entry of failed) {
        if (entry.bufferedData || !entry.dataStream) {
          // Has a buffer or has no data — can retry without re-fetching.
          canRetry.push(entry);
        } else {
          // Large payload whose stream was consumed — must re-fetch.
          const cid = await getMessageCid(entry.message);
          needsRefetch.push(cid);
        }
      }

      // Re-fetch only the large-payload messages that we couldn't buffer.
      if (needsRefetch.length > 0) {
        const reFetched = await fetchRemoteMessages({ did, dwnUrl, delegateDid, protocol, messageCids: needsRefetch, agent, permissionsApi });
        canRetry.push(...reFetched);
      }

      pending = topologicalSort(canRetry);
    } else {
      pending = [];
    }
  }

  // Return CIDs that permanently failed after all retry passes.
  const permanentlyFailed: string[] = [];
  for (const entry of pending) {
    const cid = await getMessageCid(entry.message);
    permanentlyFailed.push(cid);
  }
  return permanentlyFailed;
}

/**
 * Buffers small data streams into `Uint8Array` so they can be replayed on retry.
 * Streams larger than `MAX_BUFFER_SIZE` are left as-is (will be re-fetched on retry).
 */
async function bufferSmallStreams(entries: SyncMessageEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!entry.dataStream) {
      continue;
    }

    // Read the stream into memory. If it exceeds the threshold, stop and
    // leave the entry without a buffer (it will be re-fetched on retry).
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    let exceededThreshold = false;
    const reader = entry.dataStream.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        totalSize += value.byteLength;
        if (totalSize > MAX_BUFFER_SIZE) {
          exceededThreshold = true;
          break;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    if (exceededThreshold) {
      // Stream exceeded the buffer threshold. Leave dataStream consumed —
      // the retry path will re-fetch from remote.
      entry.dataStream = undefined;
      continue;
    }

    // Combine chunks into a single Uint8Array buffer.
    const buffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    entry.bufferedData = buffer;
    // Create a fresh ReadableStream from the buffer for the first processing attempt.
    entry.dataStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(buffer);
        controller.close();
      }
    });
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
  agent: EnboxPlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<SyncMessageEntry[]> {
  const results: SyncMessageEntry[] = [];

  const permissionGrantId = await getMessagesPermissionGrantId({
    did,
    delegateDid,
    protocol,
    messageType: DwnInterface.MessagesRead,
    permissionsApi,
  });

  // Fetch messages in parallel with bounded concurrency.  Keep this low
  // to avoid bursting through the remote server's rate limits during sync.
  const CONCURRENCY = 4;
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
        messageParams : { messageCid, permissionGrantIds: toMessagesPermissionGrantIds(permissionGrantId) }
      });

      let reply: MessagesReadReply;
      try {
        reply = await agent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid : did,
          message   : messagesRead.message,
        }) as MessagesReadReply;
      } catch (error: any) {
        console.error(`SyncEngineLevel: pull - failed to read ${messageCid} from ${dwnUrl}:`, error.message ?? error);
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
 *
 * Returns a {@link PushResult} with per-CID outcome tracking instead of throwing
 * on the first failure. Callers use this to advance the push checkpoint
 * incrementally — only up to the highest contiguous success.
 */
export async function pushMessages({ did, dwnUrl, delegateDid, protocol, messageCids, agent, permissionsApi }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  protocol?: string;
  messageCids: string[];
  agent: EnboxPlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<PushResult> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  const permanentlyFailed: PermanentPushFailure[] = [];

  // Step 1: Fetch all local messages (streams are pull-based, not yet consumed).
  const fetched: SyncMessageEntry[] = [];
  for (const messageCid of messageCids) {
    const dwnMessage = await getLocalMessage({ author: did, messageCid, delegateDid, protocol, agent, permissionsApi });
    if (dwnMessage) {
      fetched.push(dwnMessage);
    } else {
      // Message could not be fetched locally — mark as failed.
      failed.push(messageCid);
    }
  }

  // Step 2: Sort in dependency order using topological sort.
  const sorted = topologicalSort(fetched);

  // Step 3: Buffer data streams so they survive fetch retries.
  // ReadableStream is single-use — if sendDwnRequest's underlying fetch
  // retries the HTTP request, the original stream is already consumed.
  await bufferSmallStreams(sorted);

  // Step 4: Push messages in dependency order.
  for (const entry of sorted) {
    const cid = await getMessageCid(entry.message);

    // Use a Blob for buffered data — unlike ReadableStream, Blob is
    // replayable so fetchWithRetry can retry the HTTP request on failure.
    const data = entry.bufferedData
      ? new Blob([entry.bufferedData] as BlobPart[], { type: 'application/octet-stream' })
      : entry.dataStream;

    try {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : did,
        data,
        message   : entry.message
      });

      if (syncMessageReplyIsSuccessful(reply, entry.message)) {
        succeeded.push(cid);
      } else if (isPermanentPushFailure(reply)) {
        // Permanent failures (400/401/403) will never succeed — do NOT retry.
        // These include protocol violations (RecordLimitExceeded), auth errors,
        // and schema validation failures.
        if (reply.status.code === 400 && reply.status.detail?.includes('record limit')) {
          // Expected for singleton convergence in multi-device scenarios:
          // one device created a singleton record, this device has a
          // different one, and the remote rejects the duplicate.
          console.debug(`SyncEngineLevel: singleton already exists on remote, skipping push for ${cid}`);
        } else {
          console.warn(`SyncEngineLevel: push permanently failed for ${cid}: ${reply.status.code} ${reply.status.detail}`);
        }
        permanentlyFailed.push({ cid, statusCode: reply.status.code, detail: reply.status.detail ?? '' });
      } else {
        // Transient failures (5xx, etc.) — worth retrying.
        console.error(`SyncEngineLevel: push failed for ${cid}: ${reply.status.code} ${reply.status.detail}`);
        failed.push(cid);
      }
    } catch (error: any) {
      // Network errors — transient, worth retrying.
      console.error(`SyncEngineLevel: push error for ${cid}: ${error.message ?? error}`);
      failed.push(cid);
    }
  }

  return { succeeded, failed, permanentlyFailed };
}

/**
 * Reads a message from the local DWN by its CID using MessagesRead.
 */
export async function getLocalMessage({ author, delegateDid, protocol, messageCid, agent, permissionsApi }: {
  author: string;
  delegateDid?: string;
  protocol?: string;
  messageCid: string;
  agent: EnboxPlatformAgent;
  permissionsApi: PermissionsApi;
}): Promise<SyncMessageEntry | undefined> {
  const permissionGrantId = await getMessagesPermissionGrantId({
    did         : author,
    delegateDid,
    protocol,
    messageType : DwnInterface.MessagesRead,
    permissionsApi,
  });

  const { reply } = await agent.dwn.processRequest({
    author,
    target        : author,
    messageType   : DwnInterface.MessagesRead,
    granteeDid    : delegateDid,
    messageParams : { messageCid, permissionGrantIds: toMessagesPermissionGrantIds(permissionGrantId) }
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
