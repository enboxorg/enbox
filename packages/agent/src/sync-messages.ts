import type {
  GenericMessage,
  MessagesReadReply,
  ProtocolDefinition,
  ProtocolsConfigureMessage,
  ProtocolsQueryReply,
  RecordsDeleteMessage,
  RecordsQueryReply,
  RecordsWriteMessage,
  UnionMessageReply,
} from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { PushFailure, PushResult } from './types/sync.js';

import {
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  isCrossProtocolRef,
  Message,
  parseCrossProtocolRef,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { isTerminalPushStatus } from './types/sync.js';
import {
  buildMessageDependencyGraph,
  getRoleContextPrefix,
  getRoleKey,
  getSignaturePayload,
} from './sync-topological-sort.js';
import { getInvokedPermissionGrantIds, toMessagesPermissionGrantIds } from './sync-permission-grants.js';

/** Maximum data size (in bytes) to buffer in memory for retry. Larger payloads are re-fetched. */
const MAX_BUFFER_SIZE = 1_048_576; // 1 MB

/** Entry type for fetched messages with optional data stream and retry buffer. */
export type SyncMessageEntry = {
  message: GenericMessage;
  dataStream?: ReadableStream<Uint8Array>;
  dataStreamFactory?: () => Promise<ReadableStream<Uint8Array> | undefined>;
  /** Buffered data bytes for retry — avoids re-fetching from remote when stream is consumed. */
  bufferedData?: Uint8Array;
};

type LocalPushClosure = {
  cidByEntry: Map<SyncMessageEntry, string>;
  entries: SyncMessageEntry[];
};

/** Raised when an in-flight pull is cancelled before local apply can continue. */
export class SyncPullAbortedError extends Error {
  constructor() {
    super('Sync pull aborted because the sync target is no longer current.');
    this.name = 'SyncPullAbortedError';
  }
}

function assertShouldContinue(shouldContinue: (() => boolean) | undefined): void {
  if (shouldContinue?.() === false) {
    throw new SyncPullAbortedError();
  }
}

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
 * Helper to get the CID of a message for logging purposes.
 */
export async function getMessageCid(message: GenericMessage): Promise<string> {
  try {
    return await Message.getCid(message);
  } catch {
    return 'unknown';
  }
}

function dataStreamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

/**
 * Buffers small data streams into `Uint8Array` so they can be replayed on retry.
 * Streams larger than `MAX_BUFFER_SIZE` are left as-is (will be re-fetched on retry).
 */
async function bufferSmallStreams(entries: SyncMessageEntry[], shouldContinue?: () => boolean): Promise<void> {
  for (const entry of entries) {
    assertShouldContinue(shouldContinue);
    if (!entry.dataStream) {
      continue;
    }

    if (!shouldBufferDataStream(entry)) {
      continue;
    }

    // Read known-small streams into memory so transport retries can replay them.
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const reader = entry.dataStream.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        assertShouldContinue(shouldContinue);
        totalSize += value.byteLength;
        if (totalSize > MAX_BUFFER_SIZE) {
          throw new Error('SyncEngineLevel: unexpected large stream while buffering push data.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
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
    entry.dataStream = dataStreamFromBytes(buffer);
    assertShouldContinue(shouldContinue);
  }
}

function shouldBufferDataStream(entry: SyncMessageEntry): boolean {
  if (!isRecordsWriteMessage(entry.message)) {
    return true;
  }

  const dataSize = (entry.message.descriptor as { dataSize?: unknown }).dataSize;
  return typeof dataSize === 'number' && dataSize <= MAX_BUFFER_SIZE;
}

/**
 * Fetches messages from a remote DWN by their CIDs using MessagesRead.
 */
export async function fetchRemoteMessages({ did, dwnUrl, delegateDid, permissionGrantIds, messageCids, agent }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  messageCids: string[];
  agent: EnboxPlatformAgent;
}): Promise<SyncMessageEntry[]> {
  const results: SyncMessageEntry[] = [];

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
        messageParams : { messageCid, permissionGrantIds: toMessagesPermissionGrantIds(permissionGrantIds) }
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
 * on the first failure. Callers use failures to retry transient push problems,
 * dead-letter terminal remote rejections, or mark links for reconciliation.
 */
export async function pushMessages({ did, dwnUrl, delegateDid, permissionGrantIds, messageCids, agent, permissionsApi }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  messageCids: string[];
  agent: EnboxPlatformAgent;
  permissionsApi?: PermissionsApi;
}): Promise<PushResult> {
  const requestedRootCids = [...new Set(messageCids)];
  const requestedRootCidSet = new Set(requestedRootCids);
  const succeeded: string[] = [];
  const failedByRoot = new Map<string, PushFailure>();
  const { fetched, failed } = await fetchLocalMessagesForPush({
    did,
    delegateDid,
    permissionGrantIds,
    messageCids: requestedRootCids,
    agent,
  });

  recordRootFailures(failedByRoot, failed);

  const closure = await expandLocalPushClosure({
    did,
    delegateDid,
    permissionGrantIds,
    roots: fetched,
    agent,
    permissionsApi,
  });
  const dependencyGraph = buildMessageDependencyGraph(closure.entries);
  const sorted = dependencyGraph.sorted;
  const dependencyCidsByCid = dependencyCidsByMessageCid(dependencyGraph.dependencies, closure.cidByEntry);

  // ReadableStream is single-use — if sendDwnRequest's underlying fetch
  // retries the HTTP request, the original stream is already consumed.
  await bufferSmallStreams(sorted);

  await pushSortedEntries({
    agent,
    did,
    dwnUrl,
    failedByRoot,
    cidByEntry: closure.cidByEntry,
    dependencyCidsByCid,
    requestedRootCidSet,
    sorted,
    succeeded,
  });

  return { succeeded, failed: [...failedByRoot.values()] };
}

function recordRootFailures(failedByRoot: Map<string, PushFailure>, failed: PushFailure[]): void {
  for (const failure of failed) {
    failedByRoot.set(failure.cid, failure);
  }
}

async function pushSortedEntries({
  did,
  dwnUrl,
  sorted,
  requestedRootCidSet,
  succeeded,
  failedByRoot,
  cidByEntry,
  dependencyCidsByCid,
  agent,
}: {
  did: string;
  dwnUrl: string;
  sorted: SyncMessageEntry[];
  requestedRootCidSet: Set<string>;
  succeeded: string[];
  failedByRoot: Map<string, PushFailure>;
  cidByEntry: Map<SyncMessageEntry, string>;
  dependencyCidsByCid: Map<string, string[]>;
  agent: EnboxPlatformAgent;
}): Promise<void> {
  const failedDependencyByCid = new Map<string, PushFailure>();
  for (const entry of sorted) {
    const cid = cidByEntry.get(entry)!;
    const blockedFailure = firstFailedDependency(cid, dependencyCidsByCid, failedDependencyByCid);
    if (blockedFailure !== undefined) {
      const failure = dependencyBlockedFailure(cid, blockedFailure);
      failedDependencyByCid.set(cid, failure);
      if (requestedRootCidSet.has(cid)) {
        failedByRoot.set(cid, failure);
      }
      continue;
    }

    const outcome = await pushSingleMessage({ did, dwnUrl, cid, entry, agent });
    if (outcome.status === 'succeeded') {
      markRootPushSucceeded(outcome.cid, requestedRootCidSet, succeeded, failedByRoot);
    } else if (requestedRootCidSet.has(outcome.failure.cid)) {
      failedByRoot.set(outcome.failure.cid, outcome.failure);
      failedDependencyByCid.set(outcome.failure.cid, outcome.failure);
    } else {
      failedDependencyByCid.set(outcome.failure.cid, outcome.failure);
    }
  }
}

function dependencyCidsByMessageCid(
  dependencies: Map<SyncMessageEntry, SyncMessageEntry[]>,
  cidByEntry: Map<SyncMessageEntry, string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [entry, dependencyEntries] of dependencies) {
    result.set(cidByEntry.get(entry)!, dependencyEntries.map(dependency => cidByEntry.get(dependency)!));
  }
  return result;
}

function firstFailedDependency(
  cid: string,
  dependencyCidsByCid: Map<string, string[]>,
  failedDependencyByCid: Map<string, PushFailure>,
): PushFailure | undefined {
  for (const dependencyCid of dependencyCidsByCid.get(cid) ?? []) {
    const failure = failedDependencyByCid.get(dependencyCid);
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
}

function dependencyBlockedFailure(cid: string, dependencyFailure: PushFailure): PushFailure {
  const statusCode = isTerminalPushStatus(dependencyFailure.statusCode) ? dependencyFailure.statusCode : undefined;
  return {
    cid,
    ...(statusCode === undefined ? {} : { statusCode }),
    detail: `dependency push failed before root push: ${dependencyFailure.detail ?? dependencyFailure.cid}`,
  };
}

function markRootPushSucceeded(
  cid: string,
  requestedRootCidSet: Set<string>,
  succeeded: string[],
  failedByRoot: Map<string, PushFailure>,
): void {
  if (!requestedRootCidSet.has(cid)) {
    return;
  }

  succeeded.push(cid);
  failedByRoot.delete(cid);
}

async function fetchLocalMessagesForPush({ did, delegateDid, permissionGrantIds, messageCids, agent }: {
  did: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  messageCids: string[];
  agent: EnboxPlatformAgent;
}): Promise<{ fetched: SyncMessageEntry[]; failed: PushFailure[] }> {
  const fetched: SyncMessageEntry[] = [];
  const failed: PushFailure[] = [];

  for (const messageCid of messageCids) {
    const dwnMessage = await getLocalMessage({ author: did, messageCid, delegateDid, permissionGrantIds, agent });
    if (dwnMessage) {
      fetched.push(dwnMessage);
    } else {
      failed.push({ cid: messageCid, detail: 'local message not found' });
    }
  }

  return { fetched, failed };
}

type PushSingleMessageOutcome =
  | { status: 'succeeded'; cid: string }
  | { status: 'failed'; failure: PushFailure };

async function pushSingleMessage({ did, dwnUrl, cid, entry, agent }: {
  did: string;
  dwnUrl: string;
  cid: string;
  entry: SyncMessageEntry;
  agent: EnboxPlatformAgent;
}): Promise<PushSingleMessageOutcome> {
  try {
    const reply = await agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : did,
      data      : pushData(entry),
      message   : entry.message
    });

    if (syncMessageReplyIsSuccessful(reply, entry.message)) {
      return { status: 'succeeded', cid };
    }

    console.error(`SyncEngineLevel: push failed for ${cid}: ${reply.status.code} ${reply.status.detail}`);
    return {
      status  : 'failed',
      failure : { cid, statusCode: reply.status.code, detail: reply.status.detail ?? '' },
    };
  } catch (error: any) {
    console.error(`SyncEngineLevel: push error for ${cid}: ${error.message ?? error}`);
    return { status: 'failed', failure: { cid, detail: error.message ?? String(error) } };
  }
}

function pushData(entry: SyncMessageEntry): Blob | ReadableStream<Uint8Array> | undefined {
  // Use a Blob for buffered data: unlike ReadableStream, Blob is replayable,
  // so fetchWithRetry can retry the HTTP request after a transport failure.
  return entry.bufferedData
    ? new Blob([entry.bufferedData] as BlobPart[], { type: 'application/octet-stream' })
    : entry.dataStream;
}

/**
 * Reads a message from the local DWN by its CID using MessagesRead.
 */
export async function getLocalMessage({ author, delegateDid, permissionGrantIds, messageCid, agent }: {
  author: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  messageCid: string;
  agent: EnboxPlatformAgent;
}): Promise<SyncMessageEntry | undefined> {
  const { reply } = await agent.dwn.processRequest({
    author,
    target        : author,
    messageType   : DwnInterface.MessagesRead,
    granteeDid    : delegateDid,
    messageParams : { messageCid, permissionGrantIds: toMessagesPermissionGrantIds(permissionGrantIds) }
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

async function expandLocalPushClosure({ did, delegateDid, permissionGrantIds, roots, agent, permissionsApi }: {
  did: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  roots: SyncMessageEntry[];
  agent: EnboxPlatformAgent;
  permissionsApi?: PermissionsApi;
}): Promise<LocalPushClosure> {
  const builder = new LocalPushClosureBuilder({
    did,
    delegateDid,
    permissionGrantIds,
    agent,
    permissionsApi,
  });
  const entries = await builder.expand(roots);
  return { cidByEntry: builder.cidByEntry(), entries };
}

class LocalPushClosureBuilder {
  private readonly entriesByCid = new Map<string, SyncMessageEntry>();
  private readonly fetchedProtocols = new Set<string>();
  private readonly fetchedRecordIds = new Set<string>();
  private readonly fetchedRoles = new Set<string>();

  public constructor(private readonly deps: {
    did: string;
    delegateDid?: string;
    permissionGrantIds?: string[];
    agent: EnboxPlatformAgent;
    permissionsApi?: PermissionsApi;
  }) { }

  public async expand(roots: SyncMessageEntry[]): Promise<SyncMessageEntry[]> {
    const queue: SyncMessageEntry[] = [];
    for (const root of roots) {
      if (await this.rememberEntry(root)) {
        queue.push(root);
      }
    }

    for (const entry of queue) {
      const dependencies = await this.fetchDependencies(entry.message);
      for (const dependency of dependencies) {
        if (await this.rememberEntry(dependency)) {
          queue.push(dependency);
        }
      }
    }

    return [...this.entriesByCid.values()];
  }

  public cidByEntry(): Map<SyncMessageEntry, string> {
    const cidByEntry = new Map<SyncMessageEntry, string>();
    for (const [cid, entry] of this.entriesByCid) {
      cidByEntry.set(entry, cid);
    }
    return cidByEntry;
  }

  private async fetchDependencies(message: GenericMessage): Promise<SyncMessageEntry[]> {
    if (isProtocolsConfigureMessage(message)) {
      return this.fetchComposedProtocolConfigs(message.descriptor.definition);
    }

    if (isRecordsDeleteMessage(message)) {
      return this.fetchRecordsByRecordId(message.descriptor.recordId);
    }

    if (!isRecordsWriteMessage(message)) {
      return [];
    }

    const dependencies: SyncMessageEntry[] = [];
    const { protocol, parentId } = message.descriptor;
    if (protocol !== undefined) {
      dependencies.push(...await this.fetchProtocolConfig(protocol));
    }

    if (!isInitialWrite(message)) {
      dependencies.push(...await this.fetchRecordsByRecordId(message.recordId, protocol));
    }

    if (parentId !== undefined) {
      dependencies.push(...await this.fetchRecordsByRecordId(parentId, protocol));
    }

    for (const permissionGrantId of getInvokedPermissionGrantIds(message)) {
      dependencies.push(...await this.fetchRecordsByRecordId(permissionGrantId));
    }

    dependencies.push(...await this.fetchRoleRecord(message));
    return dependencies;
  }

  private async fetchComposedProtocolConfigs(definition: ProtocolDefinition): Promise<SyncMessageEntry[]> {
    const protocols = Object.values(definition.uses ?? {}).filter((protocol): protocol is string => typeof protocol === 'string');
    const entries: SyncMessageEntry[] = [];
    for (const protocol of protocols) {
      entries.push(...await this.fetchProtocolConfig(protocol));
    }
    return entries;
  }

  private async fetchProtocolConfig(protocol: string): Promise<SyncMessageEntry[]> {
    if (this.fetchedProtocols.has(protocol)) {
      return [];
    }
    this.fetchedProtocols.add(protocol);

    const config = await this.fetchProtocol(protocol);
    return config === undefined ? [] : [{ message: config }];
  }

  private async fetchProtocol(protocol: string): Promise<ProtocolsConfigureMessage | undefined> {
    const permissionGrantId = await this.getPermissionGrantId(DwnInterface.ProtocolsQuery, protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { protocol },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.ProtocolsQuery,
      store       : false,
      target      : this.deps.did,
    });

    const protocolsReply = reply as ProtocolsQueryReply;
    if (protocolsReply.status.code !== 200 || protocolsReply.entries === undefined) {
      return undefined;
    }

    return newestProtocolConfig(protocolsReply.entries.filter(isTenantProtocolConfig(this.deps.did, protocol)));
  }

  private async fetchRecordsByRecordId(recordId: string, protocol?: string): Promise<SyncMessageEntry[]> {
    const key = `${protocol ?? ''}|${recordId}`;
    if (this.fetchedRecordIds.has(key)) {
      return [];
    }
    this.fetchedRecordIds.add(key);

    const permissionGrantId = protocol === undefined
      ? undefined
      : await this.getPermissionGrantId(DwnInterface.RecordsQuery, protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { recordId, ...(protocol === undefined ? {} : { protocol }) },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsQuery,
      store       : false,
      target      : this.deps.did,
    });

    return this.entriesFromRecordsQueryReply(reply as RecordsQueryReply);
  }

  private async fetchRoleRecord(message: RecordsWriteMessage): Promise<SyncMessageEntry[]> {
    const protocol = message.descriptor.protocol;
    const protocolRole = getSignaturePayload(message)?.protocolRole;
    const recipient = Message.getAuthor(message);
    if (protocol === undefined || typeof protocolRole !== 'string' || recipient === undefined) {
      return [];
    }

    let roleProtocol = protocol;
    let roleProtocolPath = protocolRole;
    if (isCrossProtocolRef(protocolRole)) {
      const parsed = parseCrossProtocolRef(protocolRole);
      const config = await this.fetchProtocol(protocol);
      const referencedProtocol = parsed === undefined ? undefined : config?.descriptor.definition.uses?.[parsed.alias];
      if (parsed === undefined || referencedProtocol === undefined) {
        return [];
      }
      roleProtocol = referencedProtocol;
      roleProtocolPath = parsed.protocolPath;
    }

    const contextPrefix = getRoleContextPrefix(roleProtocolPath, message.contextId);
    const key = getRoleKey(roleProtocol, roleProtocolPath, recipient, contextPrefix);
    if (this.fetchedRoles.has(key)) {
      return [];
    }
    this.fetchedRoles.add(key);

    const permissionGrantId = await this.getPermissionGrantId(DwnInterface.RecordsQuery, roleProtocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: {
          protocol     : roleProtocol,
          protocolPath : roleProtocolPath,
          recipient,
          ...(contextPrefix === undefined ? {} : { contextId: contextPrefix }),
        },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsQuery,
      store       : false,
      target      : this.deps.did,
    });

    return this.entriesFromRecordsQueryReply(reply as RecordsQueryReply);
  }

  private async entriesFromRecordsQueryReply(reply: RecordsQueryReply): Promise<SyncMessageEntry[]> {
    if (reply.status.code !== 200 || reply.entries === undefined) {
      return [];
    }

    const entries: SyncMessageEntry[] = [];
    for (const entry of reply.entries) {
      const { encodedData, initialWrite, ...message } = entry;
      if (initialWrite !== undefined) {
        entries.push(await this.entryForRecordsQueryMessage(initialWrite));
      }

      entries.push(await this.entryForRecordsQueryMessage(message, encodedData));
    }

    return dedupeEntries(entries);
  }

  private async entryForRecordsQueryMessage(message: GenericMessage, encodedData?: string): Promise<SyncMessageEntry> {
    const entry: SyncMessageEntry = { message };
    if (encodedData !== undefined) {
      entry.bufferedData = Encoder.base64UrlToBytes(encodedData);
      return entry;
    }

    if (isRecordsWriteMessage(message) && message.descriptor.dataCid !== undefined) {
      const messageCid = await getMessageCid(message);
      const hydrated = await getLocalMessage({
        author             : this.deps.did,
        delegateDid        : this.deps.delegateDid,
        permissionGrantIds : this.deps.permissionGrantIds,
        messageCid,
        agent              : this.deps.agent,
      });
      if (hydrated !== undefined) {
        return hydrated;
      }
    }

    return entry;
  }

  private async getPermissionGrantId(messageType: DwnInterface, protocol: string): Promise<string | undefined> {
    if (this.deps.delegateDid === undefined || this.deps.permissionsApi === undefined) {
      return undefined;
    }

    try {
      const { grant } = await this.deps.permissionsApi.getPermissionForRequest({
        connectedDid : this.deps.did,
        delegateDid  : this.deps.delegateDid,
        protocol,
        cached       : true,
        messageType,
      });
      return grant.id;
    } catch {
      return undefined;
    }
  }

  private async rememberEntry(entry: SyncMessageEntry): Promise<boolean> {
    const cid = await getMessageCid(entry.message);
    if (this.entriesByCid.has(cid)) {
      return false;
    }
    this.entriesByCid.set(cid, entry);
    return true;
  }
}

async function dedupeEntries(entries: SyncMessageEntry[]): Promise<SyncMessageEntry[]> {
  const byCid = new Map<string, SyncMessageEntry>();
  for (const entry of entries) {
    byCid.set(await getMessageCid(entry.message), entry);
  }
  return [...byCid.values()];
}

function isRecordsWriteMessage(message: GenericMessage): message is RecordsWriteMessage {
  return message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write &&
    typeof (message as { recordId?: unknown }).recordId === 'string';
}

function isRecordsDeleteMessage(message: GenericMessage): message is RecordsDeleteMessage {
  return message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Delete &&
    typeof (message.descriptor as { recordId?: unknown }).recordId === 'string';
}

function isProtocolsConfigureMessage(message: GenericMessage): message is ProtocolsConfigureMessage {
  return message.descriptor.interface === DwnInterfaceName.Protocols &&
    message.descriptor.method === DwnMethodName.Configure &&
    (message.descriptor as { definition?: unknown }).definition !== undefined;
}

function isInitialWrite(message: RecordsWriteMessage): boolean {
  return message.descriptor.dateCreated === message.descriptor.messageTimestamp;
}

function isTenantProtocolConfig(tenantDid: string, protocol: string): (message: GenericMessage) => message is ProtocolsConfigureMessage {
  return (message: GenericMessage): message is ProtocolsConfigureMessage => {
    if (!isProtocolsConfigureMessage(message)) {
      return false;
    }

    return message.descriptor.definition.protocol === protocol && Message.getAuthor(message) === tenantDid;
  };
}

function newestProtocolConfig(configs: ProtocolsConfigureMessage[]): ProtocolsConfigureMessage | undefined {
  let newest: ProtocolsConfigureMessage | undefined;
  for (const config of configs) {
    if (newest === undefined || config.descriptor.messageTimestamp > newest.descriptor.messageTimestamp) {
      newest = config;
    }
  }
  return newest;
}
