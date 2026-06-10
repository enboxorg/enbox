import type {
  DependencyRef,
  GenericMessage,
  MessagesReadReply,
  ProtocolsConfigureMessage,
  ProtocolsQueryReply,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsWriteMessage,
  ReplicationApplyResult,
} from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type { PushFailure, PushResult } from './types/sync.js';

import {
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Message,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { DwnRpcError } from '@enbox/dwn-clients';
import { isRecordsWrite } from './utils.js';
import { toMessagesPermissionGrantIds } from './sync-permission-grants.js';
import { getRoleKey, topologicalSort } from './sync-topological-sort.js';

/** Maximum data size (in bytes) to buffer in memory for retry. Larger payloads are re-fetched. */
const MAX_BUFFER_SIZE = 1_048_576; // 1 MB

/** Entry type for fetched messages with optional data stream and retry buffer. */
export type SyncMessageEntry = {
  message: GenericMessage;
  dataStream?: ReadableStream<Uint8Array>;
  dataStreamConsumed?: boolean;
  dataStreamFactory?: () => Promise<ReadableStream<Uint8Array> | undefined>;
  /** Buffered data bytes for retry — avoids re-fetching from remote when stream is consumed. */
  bufferedData?: Uint8Array;
};

type FetchLocalMessageResult =
  | { kind: 'found'; entry: SyncMessageEntry }
  | { kind: 'missing'; localStatusCode?: number; detail?: string };

type FetchDependencyResult =
  | { kind: 'fetched'; entries: SyncMessageEntry[] }
  | { kind: 'failed'; detail: string };

type PushEntryResult =
  | { kind: 'applied'; cid: string }
  | { kind: 'retry'; entries: SyncMessageEntry[] }
  | { kind: 'failed'; failure: PushFailure };

type PushRootOutcome =
  | { kind: 'succeeded'; cid: string }
  | { kind: 'failed'; failure: PushFailure };

// Match the pull-side admission budget. Replication apply reports bounded,
// structured missing dependencies, while this cap prevents remote cycles from
// turning into unbounded local query/apply loops.
const MAX_PUSH_ADMISSION_PASSES = 128;

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
    if (!shouldReadStreamIntoBuffer(entry)) {
      continue;
    }

    const buffer = await bufferDataStream(entry.dataStream!, shouldContinue);
    entry.bufferedData = buffer;
    // Create a fresh ReadableStream from the buffer for the first processing attempt.
    entry.dataStream = dataStreamFromBytes(buffer);
    assertShouldContinue(shouldContinue);
  }
}

function shouldReadStreamIntoBuffer(entry: SyncMessageEntry): boolean {
  return entry.dataStream !== undefined &&
    entry.bufferedData === undefined &&
    shouldBufferDataStream(entry);
}

async function bufferDataStream(dataStream: ReadableStream<Uint8Array>, shouldContinue?: () => boolean): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  const reader = dataStream.getReader();

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

  return concatChunks(chunks, totalSize);
}

function concatChunks(chunks: Uint8Array[], totalSize: number): Uint8Array {
  const buffer = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
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
 * Reads local roots and pushes them through the remote DWN replication entry.
 * The remote DWN is the dependency authority: `Incomplete` results request the
 * exact local dependency refs to fetch and retry.
 *
 * Returns a {@link PushResult} with per-CID outcome tracking instead of throwing
 * on the first failure. Callers use failures to retry transient push problems,
 * dead-letter `Invalid` remote rejections, or mark links for reconciliation.
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
  const context = new RemoteApplyPushContext({
    did,
    dwnUrl,
    delegateDid,
    permissionGrantIds,
    agent,
    permissionsApi,
  });
  return context.push([...new Set(messageCids)]);
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
  const result = await readLocalMessage({ author, delegateDid, permissionGrantIds, messageCid, agent });
  return result.kind === 'found' ? result.entry : undefined;
}

async function readLocalMessage({ author, delegateDid, permissionGrantIds, messageCid, agent }: {
  author: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  messageCid: string;
  agent: EnboxPlatformAgent;
}): Promise<FetchLocalMessageResult> {
  const { reply } = await agent.dwn.processRequest({
    author,
    target        : author,
    messageType   : DwnInterface.MessagesRead,
    granteeDid    : delegateDid,
    messageParams : { messageCid, permissionGrantIds: toMessagesPermissionGrantIds(permissionGrantIds) }
  });

  if (reply.status.code !== 200 || !reply.entry) {
    return { kind: 'missing', localStatusCode: reply.status.code, detail: reply.status.detail };
  }
  const messageEntry = reply.entry!;

  const result: SyncMessageEntry = {
    message: messageEntry.message
  };

  if (isRecordsWrite(messageEntry) && messageEntry.data) {
    result.dataStream = messageEntry.data;
    result.dataStreamFactory = async (): Promise<ReadableStream<Uint8Array> | undefined> => {
      const refreshed = await readLocalMessage({ author, delegateDid, permissionGrantIds, messageCid, agent });
      return refreshed.kind === 'found' ? refreshed.entry.dataStream : undefined;
    };
  }

  return { kind: 'found', entry: result };
}

class RemoteApplyPushContext {
  private readonly entriesByCid = new Map<string, SyncMessageEntry>();
  private readonly fetchedDependencyEntries = new Map<string, SyncMessageEntry[]>();
  private readonly fetchedRefs = new Set<string>();

  public constructor(private readonly deps: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    permissionGrantIds?: string[];
    agent: EnboxPlatformAgent;
    permissionsApi?: PermissionsApi;
  }) {}

  public async push(rootCids: string[]): Promise<PushResult> {
    const succeeded: string[] = [];
    const failedByRoot = new Map<string, PushFailure>();
    const rootEntries: SyncMessageEntry[] = [];

    for (const rootCid of rootCids) {
      const root = await this.fetchMessageCid(rootCid);
      if (root.kind === 'failed') {
        failedByRoot.set(rootCid, {
          cid    : rootCid,
          detail : root.detail,
        });
        continue;
      }
      rootEntries.push(...root.entries);
    }

    for (const rootEntry of topologicalSort(rootEntries)) {
      const rootCid = await this.rememberEntry(rootEntry);
      if (failedByRoot.has(rootCid)) {
        continue;
      }

      const outcome = await this.pushRoot(rootCid, rootEntry);
      if (outcome.kind === 'succeeded') {
        succeeded.push(outcome.cid);
        failedByRoot.delete(outcome.cid);
      } else {
        failedByRoot.set(outcome.failure.cid, outcome.failure);
      }
    }

    return { succeeded, failed: [...failedByRoot.values()] };
  }

  private async pushRoot(rootCid: string, rootEntry: SyncMessageEntry): Promise<PushRootOutcome> {
    let pending = [rootEntry];
    for (let pass = 0; pass < MAX_PUSH_ADMISSION_PASSES && pending.length > 0; pass++) {
      const retry: SyncMessageEntry[] = [];
      for (const entry of topologicalSort(pending)) {
        const result = await this.pushEntry(rootCid, entry);
        switch (result.kind) {
          case 'applied':
            break;
          case 'retry':
            retry.push(...result.entries);
            break;
          case 'failed':
            return { kind: 'failed', failure: result.failure };
        }
      }
      pending = await dedupeEntries(retry);
    }

    return pending.length === 0
      ? { kind: 'succeeded', cid: rootCid }
      : {
        kind    : 'failed',
        failure : { cid: rootCid, detail: 'remote dependency apply pass budget exhausted' },
      };
  }

  private async pushEntry(rootCid: string, entry: SyncMessageEntry): Promise<PushEntryResult> {
    const cid = await this.rememberEntry(entry);
    try {
      await bufferSmallStreams([entry]);
    } catch (error: any) {
      const detail = error.message ?? String(error);
      console.error(`SyncEngineLevel: push error for ${cid}: ${detail}`);
      return { kind: 'failed', failure: this.retryableFailure(rootCid, cid, detail) };
    }

    let result: ReplicationApplyResult;
    try {
      result = await this.deps.agent.rpc.applyReplicatedMessage({
        dwnUrl    : this.deps.dwnUrl,
        targetDid : this.deps.did,
        data      : await pushData(entry),
        message   : entry.message,
      });
    } catch (error: any) {
      const detail = error.message ?? String(error);
      console.error(`SyncEngineLevel: push error for ${cid}: ${detail}`);
      if (error instanceof DwnRpcError && error.terminal) {
        return { kind: 'failed', failure: this.terminalFailure(rootCid, cid, detail, { kind: 'Invalid', reason: detail }) };
      }
      return { kind: 'failed', failure: this.retryableFailure(rootCid, cid, detail) };
    }

    return this.pushResultFromApply(rootCid, cid, entry, result);
  }

  private async pushResultFromApply(
    rootCid: string,
    cid: string,
    entry: SyncMessageEntry,
    result: ReplicationApplyResult,
  ): Promise<PushEntryResult> {
    switch (result.kind) {
      case 'Applied':
      case 'Duplicate':
      case 'Superseded':
        return { kind: 'applied', cid };
      case 'Deferred':
        return {
          kind    : 'failed',
          failure : this.retryableFailure(rootCid, cid, result.reason, result),
        };
      case 'Invalid':
        return {
          kind    : 'failed',
          failure : this.terminalFailure(rootCid, cid, result.reason, result),
        };
      case 'Incomplete':
        return this.pushResultFromMissingDependencies(rootCid, cid, entry, result.missing);
      default:
        return unreachable(result);
    }
  }

  private async pushResultFromMissingDependencies(
    rootCid: string,
    cid: string,
    entry: SyncMessageEntry,
    missing: DependencyRef[],
  ): Promise<PushEntryResult> {
    if (hasTerminalDependency(missing)) {
      return {
        kind    : 'failed',
        failure : this.terminalFailure(rootCid, cid, missingDependencyDetail(missing), { kind: 'Incomplete', missing }),
      };
    }

    const dependencies = await this.fetchMissingDependencies(missing);
    if (dependencies.kind === 'failed') {
      return {
        kind    : 'failed',
        failure : this.retryableFailure(rootCid, cid, dependencies.detail),
      };
    }

    if (dependencies.entries.length === 0) {
      return {
        kind    : 'failed',
        failure : this.retryableFailure(rootCid, cid, missingDependencyDetail(missing)),
      };
    }

    return { kind: 'retry', entries: [...dependencies.entries, entry] };
  }

  private terminalFailure(
    rootCid: string,
    cid: string,
    detail: string,
    result: Extract<ReplicationApplyResult, { kind: 'Invalid' | 'Incomplete' }>,
  ): PushFailure {
    return {
      cid      : rootCid,
      kind     : result.kind,
      terminal : true,
      detail   : cid === rootCid ? detail : `dependency ${cid} failed before root push: ${detail}`,
    };
  }

  private retryableFailure(
    rootCid: string,
    cid: string,
    detail: string,
    result?: Extract<ReplicationApplyResult, { kind: 'Deferred' }>,
  ): PushFailure {
    return {
      cid    : rootCid,
      ...(cid === rootCid ? {} : { dependencyCid: cid }),
      ...(result === undefined ? {} : { kind: result.kind, reason: result.reason }),
      ...(result?.reason === 'tenant-inactive' ? { tenantInactive: true } : {}),
      detail : cid === rootCid ? detail : `dependency ${cid} failed before root push: ${detail}`,
    };
  }

  private async fetchMissingDependencies(refs: DependencyRef[]): Promise<FetchDependencyResult> {
    const fetched: SyncMessageEntry[] = [];
    for (const ref of refs) {
      const key = dependencyKey(ref);
      if (this.fetchedRefs.has(key)) {
        fetched.push(...(this.fetchedDependencyEntries.get(key) ?? []));
        continue;
      }

      const result = await this.fetchDependency(ref);
      if (result.kind === 'failed') {
        return result;
      }

      this.fetchedRefs.add(key);
      this.fetchedDependencyEntries.set(key, result.entries);
      fetched.push(...result.entries);
    }
    return { kind: 'fetched', entries: fetched };
  }

  private async fetchDependency(ref: DependencyRef): Promise<FetchDependencyResult> {
    if (ref.messageCid !== undefined) {
      return this.fetchMessageCid(ref.messageCid);
    }

    switch (ref.type) {
      case 'Protocol':
        return this.fetchProtocolConfig(ref.protocol);
      case 'InitialWrite':
        return this.fetchRecordsByRecordId(ref.recordId, ref.protocol);
      case 'Parent':
        return this.fetchRecordsByRecordId(ref.recordId, ref.protocol);
      case 'Ancestor':
      case 'CrossProtocolRef':
        return this.fetchRecordsByRecordId(ref.recordId, ref.protocol);
      case 'Role':
        return this.fetchRoleRecord(ref);
      case 'Grant':
        return this.fetchRecordsByRecordId(ref.permissionGrantId);
      case 'RecordData':
        return this.fetchRecordData(ref);
      case 'KeyDelivery':
        // dependencyRefFromStatus() does not currently emit KeyDelivery for push.
        // Key delivery is installed proactively with encrypted protocols, so keep
        // this documented no-op instead of building an unexercised fetch path.
        return { kind: 'fetched', entries: [] };
      default:
        return unreachable(ref);
    }
  }

  private async fetchMessageCid(messageCid: string): Promise<FetchDependencyResult> {
    const result = await readLocalMessage({
      author             : this.deps.did,
      delegateDid        : this.deps.delegateDid,
      permissionGrantIds : this.deps.permissionGrantIds,
      messageCid,
      agent              : this.deps.agent,
    });
    if (result.kind === 'missing') {
      return {
        kind   : 'failed',
        detail : `local dependency message ${messageCid} not found (${result.localStatusCode ?? 'unknown'} ${result.detail ?? ''})`,
      };
    }

    await this.rememberEntry(result.entry);
    return { kind: 'fetched', entries: [result.entry] };
  }

  private async fetchProtocolConfig(protocol: string): Promise<FetchDependencyResult> {
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
      return {
        kind   : 'failed',
        detail : `local protocol query failed for ${protocol}: ${protocolsReply.status.code} ${protocolsReply.status.detail ?? ''}`,
      };
    }

    const config = newestProtocolConfig(protocolsReply.entries.filter(isTenantProtocolConfig(this.deps.did, protocol)));
    const entries = config === undefined ? [] : [{ message: config }];
    await this.rememberEntries(entries);
    return { kind: 'fetched', entries };
  }

  private async fetchRecordsByRecordId(recordId: string, protocol?: string): Promise<FetchDependencyResult> {
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

    const recordsReply = reply as RecordsQueryReply;
    if (recordsReply.status.code !== 200 || recordsReply.entries === undefined) {
      return {
        kind   : 'failed',
        detail : `local records query failed for ${recordId}: ${recordsReply.status.code} ${recordsReply.status.detail ?? ''}`,
      };
    }

    return { kind: 'fetched', entries: await this.entriesFromRecordsQueryEntries(recordsReply.entries) };
  }

  private async fetchRoleRecord(ref: Extract<DependencyRef, { type: 'Role' }>): Promise<FetchDependencyResult> {
    const permissionGrantId = await this.getPermissionGrantId(DwnInterface.RecordsQuery, ref.protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const key = getRoleKey(ref.protocol, ref.protocolPath, ref.recipient, ref.contextPrefix);
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: {
          protocol     : ref.protocol,
          protocolPath : ref.protocolPath,
          recipient    : ref.recipient,
          ...(ref.contextPrefix === undefined ? {} : { contextId: ref.contextPrefix }),
        },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsQuery,
      store       : false,
      target      : this.deps.did,
    });

    const recordsReply = reply as RecordsQueryReply;
    if (recordsReply.status.code !== 200 || recordsReply.entries === undefined) {
      return {
        kind   : 'failed',
        detail : `local role query failed for ${key}: ${recordsReply.status.code} ${recordsReply.status.detail ?? ''}`,
      };
    }

    return { kind: 'fetched', entries: await this.entriesFromRecordsQueryEntries(recordsReply.entries) };
  }

  private async fetchRecordData(ref: Extract<DependencyRef, { type: 'RecordData' }>): Promise<FetchDependencyResult> {
    const permissionGrantId = ref.protocol === undefined
      ? undefined
      : await this.getPermissionGrantId(DwnInterface.RecordsRead, ref.protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { recordId: ref.recordId },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsRead,
      store       : false,
      target      : this.deps.did,
    });

    const recordsReply = reply as RecordsReadReply;
    if (recordsReply.status.code !== 200 || recordsReply.entry?.recordsWrite === undefined || recordsReply.entry.data === undefined) {
      return {
        kind   : 'failed',
        detail : `local record data read failed for ${ref.recordId}: ${recordsReply.status.code} ${recordsReply.status.detail ?? ''}`,
      };
    }

    const recordsWrite = recordsReply.entry.recordsWrite;
    if (recordsWrite.descriptor.dataCid !== ref.dataCid) {
      return { kind: 'fetched', entries: [] };
    }

    const entry: SyncMessageEntry = {
      message           : recordsWrite,
      dataStream        : recordsReply.entry.data,
      dataStreamFactory : async (): Promise<ReadableStream<Uint8Array> | undefined> => {
        const refreshed = await this.fetchRecordData(ref);
        return refreshed.kind === 'fetched' ? refreshed.entries[0]?.dataStream : undefined;
      },
    };
    await this.rememberEntry(entry);
    return { kind: 'fetched', entries: [entry] };
  }

  private async entriesFromRecordsQueryEntries(recordsQueryEntries: NonNullable<RecordsQueryReply['entries']>): Promise<SyncMessageEntry[]> {
    const entries: SyncMessageEntry[] = [];
    for (const recordEntry of recordsQueryEntries) {
      const { encodedData, initialWrite, ...message } = recordEntry;
      if (initialWrite !== undefined) {
        entries.push(await this.entryForRecordsQueryMessage(initialWrite));
      }

      entries.push(await this.entryForRecordsQueryMessage(message, encodedData));
    }

    const dedupedEntries = await dedupeEntries(entries);
    await this.rememberEntries(dedupedEntries);
    return dedupedEntries;
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

  private async rememberEntries(entries: SyncMessageEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.rememberEntry(entry);
    }
  }

  private async rememberEntry(entry: SyncMessageEntry): Promise<string> {
    const cid = await Message.getCid(entry.message);
    this.entriesByCid.set(cid, entry);
    return cid;
  }
}

async function pushData(entry: SyncMessageEntry): Promise<Blob | ReadableStream<Uint8Array> | undefined> {
  if (entry.bufferedData !== undefined) {
    return new Blob([entry.bufferedData] as BlobPart[], { type: 'application/octet-stream' });
  }

  if (entry.dataStream !== undefined && entry.dataStreamConsumed !== true) {
    entry.dataStreamConsumed = true;
    return entry.dataStream;
  }

  if (entry.dataStreamFactory !== undefined) {
    return entry.dataStreamFactory();
  }

  return entry.dataStream;
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

function isProtocolsConfigureMessage(message: GenericMessage): message is ProtocolsConfigureMessage {
  return message.descriptor.interface === DwnInterfaceName.Protocols &&
    message.descriptor.method === DwnMethodName.Configure &&
    (message.descriptor as { definition?: unknown }).definition !== undefined;
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

function hasTerminalDependency(refs: DependencyRef[]): boolean {
  return refs.some(ref => ref.terminal === true);
}

function missingDependencyDetail(refs: DependencyRef[]): string {
  return refs.map(dependencyKey).join(', ');
}

function dependencyKey(ref: DependencyRef): string {
  return JSON.stringify(ref);
}

function unreachable(value: never): never {
  throw new Error(`SyncEngineLevel: unreachable sync push branch ${JSON.stringify(value)}`);
}
