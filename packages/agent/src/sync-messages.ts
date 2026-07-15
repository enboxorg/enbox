import type {
  DependencyRef,
  GenericMessage,
  MessagesFilter,
  MessagesQueryOptions,
  MessagesQueryReply,
  MessagesReadReply,
  ProgressToken,
  ProtocolsQueryReply,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsWriteMessage,
  ReplicationApplyResult,
} from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PermissionsApi } from './types/permissions.js';
import type {
  PushAcknowledgement,
  PushFailure,
  PushResult,
  PushSuccessResolution,
} from './types/sync.js';

import {
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Message,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { toMessagesPermissionGrantIds } from './sync-permission-grants.js';
import {
  dependencyKey,
  hasTerminalDependency,
  isTenantProtocolConfig,
  matchesEncryptionControlDependency,
  missingDependencyDetail,
  newestProtocolConfig,
  resolveDelegatePermissionGrantId,
} from './sync-fetch-helpers.js';
import { DwnRpcError, isQuotaExceededError } from '@enbox/dwn-clients';
import { getRoleKey, orderMessagesForAdmission } from './sync-admission-order.js';

/** Maximum data size (in bytes) to buffer in memory for retry. Larger payloads are re-fetched. */
const MAX_BUFFER_SIZE = 1_048_576; // 1 MB

/** Entry type for fetched messages with optional data stream and retry buffer. */
export type SyncMessageEntry = {
  message: GenericMessage;
  dataStream?: ReadableStream<Uint8Array>;
  dataStreamConsumed?: boolean;
  dataStreamFactory?: () => Promise<ReadableStream<Uint8Array> | undefined>;
  /** Source feed attestation. Latest RecordsWrite entries must carry data before apply. */
  isLatestBaseState?: boolean;
  /** Buffered data bytes for retry — avoids re-fetching from remote when stream is consumed. */
  bufferedData?: Uint8Array;
};

export type MessageFeedQuery = {
  did: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  filters?: MessagesFilter[];
  cursor?: ProgressToken;
  limit?: number;
  cidsOnly?: boolean;
  agent: EnboxPlatformAgent;
};

type MessageFeedParams = Omit<MessageFeedQuery, 'did' | 'delegateDid' | 'agent'>;

type FetchLocalMessageResult =
  | { kind: 'found'; entry: SyncMessageEntry }
  | { kind: 'missing'; localStatusCode?: number; detail?: string };

type FetchDependencyResult =
  | { kind: 'fetched'; entries: SyncMessageEntry[] }
  | { kind: 'failed'; detail: string; localMissing?: boolean };

type PushEntryResult =
  | { kind: 'applied'; cid: string; resolution: PushSuccessResolution }
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

export class SyncDataSizeLimitExceededError extends Error {
  public constructor(dataSize: number) {
    super(`SyncEngineLevel: RecordsWrite data exceeded descriptor dataSize ${dataSize}.`);
    this.name = 'SyncDataSizeLimitExceededError';
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

export function capRecordsWriteDataStream(
  message: GenericMessage,
  dataStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (!isRecordsWriteMessage(message)) {
    return dataStream;
  }

  const dataSize = message.descriptor.dataSize;
  if (typeof dataSize !== 'number') {
    return dataStream;
  }

  return capDataStream(dataStream, dataSize);
}

function capDataStream(
  dataStream: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let totalBytes = 0;

  return dataStream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new SyncDataSizeLimitExceededError(maxBytes);
      }

      controller.enqueue(chunk);
    },
  }));
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

    const buffer = await bufferDataStream(entry, shouldContinue);
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

async function bufferDataStream(entry: SyncMessageEntry, shouldContinue?: () => boolean): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  const reader = entry.dataStream!.getReader();

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

function buildMessageFeedParams({
  filters,
  cursor,
  limit,
  cidsOnly,
  permissionGrantIds,
}: MessageFeedParams): Omit<MessagesQueryOptions, 'signer'> {
  return {
    filters,
    cursor,
    limit,
    cidsOnly,
    permissionGrantIds: toMessagesPermissionGrantIds(permissionGrantIds)
  };
}

/**
 * Queries a remote DWN's durable message feed using MessagesQuery.
 */
export async function queryRemoteMessageFeed({
  did,
  dwnUrl,
  delegateDid,
  permissionGrantIds,
  filters,
  cursor,
  limit,
  cidsOnly,
  agent,
}: MessageFeedQuery & { dwnUrl: string }): Promise<MessagesQueryReply> {
  const messagesQuery = await agent.processDwnRequest({
    store         : false,
    author        : did,
    target        : did,
    messageType   : DwnInterface.MessagesQuery,
    granteeDid    : delegateDid,
    messageParams : buildMessageFeedParams({ filters, cursor, limit, cidsOnly, permissionGrantIds })
  });

  return await agent.rpc.sendDwnRequest({
    dwnUrl,
    targetDid : did,
    message   : messagesQuery.message,
  }) as MessagesQueryReply;
}

/**
 * Queries the local DWN's durable message feed using MessagesQuery.
 */
export async function queryLocalMessageFeed({
  did,
  delegateDid,
  permissionGrantIds,
  filters,
  cursor,
  limit,
  cidsOnly,
  agent,
}: MessageFeedQuery): Promise<MessagesQueryReply> {
  const { reply } = await agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.MessagesQuery,
    granteeDid    : delegateDid,
    messageParams : buildMessageFeedParams({ filters, cursor, limit, cidsOnly, permissionGrantIds })
  });

  return reply;
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
        dataStream = capRecordsWriteDataStream(replyEntry.message, replyEntry.data);
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

export async function pushMessageEntries({ did, dwnUrl, delegateDid, permissionGrantIds, entries, agent, permissionsApi }: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  entries: SyncMessageEntry[];
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
  return context.pushEntries(entries);
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
    result.dataStream = capRecordsWriteDataStream(messageEntry.message, messageEntry.data);
    result.dataStreamFactory = async (): Promise<ReadableStream<Uint8Array> | undefined> => {
      const refreshed = await readLocalMessage({ author, delegateDid, permissionGrantIds, messageCid, agent });
      return refreshed.kind === 'found' ? refreshed.entry.dataStream : undefined;
    };
  }

  return { kind: 'found', entry: result };
}

class RemoteApplyPushContext {
  private readonly entriesByCid = new Map<string, SyncMessageEntry>();
  private readonly entryCids = new WeakMap<SyncMessageEntry, string>();
  private readonly fetchedDependencyEntries = new Map<string, SyncMessageEntry[]>();
  private readonly fetchedRefs = new Set<string>();
  private readonly acknowledgementsByCid = new Map<string, PushSuccessResolution>();

  public constructor(private readonly deps: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    permissionGrantIds?: string[];
    agent: EnboxPlatformAgent;
    permissionsApi?: PermissionsApi;
  }) {}

  public async push(rootCids: string[]): Promise<PushResult> {
    const failedByRoot = new Map<string, PushFailure>();
    const rootEntries: SyncMessageEntry[] = [];

    for (const rootCid of rootCids) {
      const root = await this.fetchMessageCid(rootCid);
      if (root.kind === 'failed') {
        failedByRoot.set(rootCid, {
          cid    : rootCid,
          ...(root.localMissing === true ? { localMissing: true } : {}),
          detail : root.detail,
        });
        continue;
      }
      rootEntries.push(...root.entries);
    }

    return this.pushEntries(rootEntries, failedByRoot);
  }

  public async pushEntries(
    rootEntries: SyncMessageEntry[],
    failedByRoot = new Map<string, PushFailure>(),
  ): Promise<PushResult> {
    const succeeded: string[] = [];

    for (const rootEntry of orderMessagesForAdmission(rootEntries)) {
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

    const acknowledged: PushAcknowledgement[] = [...this.acknowledgementsByCid]
      .map(([cid, resolution]) => ({ cid, resolution }));

    return { succeeded, acknowledged, failed: [...failedByRoot.values()] };
  }

  private async pushRoot(rootCid: string, rootEntry: SyncMessageEntry): Promise<PushRootOutcome> {
    let pending = [rootEntry];
    let rootResolution: PushSuccessResolution | undefined;
    for (let pass = 0; pass < MAX_PUSH_ADMISSION_PASSES && pending.length > 0; pass++) {
      const retry: SyncMessageEntry[] = [];
      for (const entry of orderMessagesForAdmission(pending)) {
        const result = await this.pushEntry(rootCid, entry);
        switch (result.kind) {
          case 'applied':
            if (result.cid === rootCid) {
              rootResolution = result.resolution;
            }
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

    if (pending.length > 0) {
      return {
        kind    : 'failed',
        failure : { cid: rootCid, kind: 'Incomplete', detail: 'remote dependency apply pass budget exhausted' },
      };
    }

    return rootResolution === undefined
      ? {
        kind    : 'failed',
        failure : { cid: rootCid, kind: 'Incomplete', detail: 'remote did not acknowledge the pushed root message' },
      }
      : { kind: 'succeeded', cid: rootCid };
  }

  private async pushEntry(rootCid: string, entry: SyncMessageEntry): Promise<PushEntryResult> {
    const cid = await this.rememberEntry(entry);
    try {
      await bufferSmallStreams([entry]);
    } catch (error: any) {
      const detail = error.message ?? String(error);
      console.error(`SyncEngineLevel: push error for ${cid}: ${detail}`);
      if (error instanceof SyncDataSizeLimitExceededError) {
        return {
          kind    : 'failed',
          failure : this.terminalFailure(rootCid, cid, detail, { kind: 'Invalid', reason: detail }),
        };
      }
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
      if (error instanceof SyncDataSizeLimitExceededError) {
        console.error(`SyncEngineLevel: push error for ${cid}: ${detail}`);
        return { kind: 'failed', failure: this.terminalFailure(rootCid, cid, detail, { kind: 'Invalid', reason: detail }) };
      }
      if (error instanceof DwnRpcError && isQuotaExceededError(error.message, error.data)) {
        // Quota rejection: retryable but NOT hot-loopable. The remote is out of
        // storage for this tenant; re-pushing the same message every tick would
        // flood. Classify it so the engine defers + backed-off re-probes instead
        // (self-heals when quota grows or another device delivers the CID). No log —
        // this is an expected, surfaced condition, not an error.
        return { kind: 'failed', failure: this.quotaBlockedFailure(rootCid, cid, detail) };
      }
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
        return { kind: 'applied', cid, resolution: this.recordAcknowledgement(cid, 'applied') };
      case 'Superseded':
        return { kind: 'applied', cid, resolution: this.recordAcknowledgement(cid, 'superseded') };
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
        failure : this.retryableFailure(rootCid, cid, missingDependencyDetail(missing), { kind: 'Incomplete', missing }),
      };
    }

    const unacknowledgedDependencies: SyncMessageEntry[] = [];
    for (const dependency of dependencies.entries) {
      const dependencyCid = await this.rememberEntry(dependency);
      if (!this.acknowledgementsByCid.has(dependencyCid)) {
        unacknowledgedDependencies.push(dependency);
      }
    }

    if (unacknowledgedDependencies.length === 0) {
      return {
        kind    : 'failed',
        failure : this.retryableFailure(
          rootCid,
          cid,
          `remote still reports acknowledged dependencies as missing: ${missingDependencyDetail(missing)}`,
          { kind: 'Incomplete', missing },
        ),
      };
    }

    return { kind: 'retry', entries: [...unacknowledgedDependencies, entry] };
  }

  private recordAcknowledgement(cid: string, resolution: PushSuccessResolution): PushSuccessResolution {
    const existing = this.acknowledgementsByCid.get(cid);
    const resolved = existing === 'superseded' || resolution === 'superseded' ? 'superseded' : 'applied';
    this.acknowledgementsByCid.set(cid, resolved);
    return resolved;
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
    result?: Extract<ReplicationApplyResult, { kind: 'Deferred' | 'Incomplete' }>,
  ): PushFailure {
    const deferred = result?.kind === 'Deferred' ? result : undefined;
    return {
      cid    : rootCid,
      ...(cid === rootCid ? {} : { dependencyCid: cid }),
      ...(result === undefined ? {} : { kind: result.kind }),
      ...(deferred === undefined ? {} : { reason: deferred.reason }),
      ...(deferred?.reason === 'tenant-inactive' ? { tenantInactive: true } : {}),
      detail : cid === rootCid ? detail : `dependency ${cid} failed before root push: ${detail}`,
    };
  }

  /**
   * A push rejected because the remote is out of storage/message quota for this
   * tenant. Retryable but not hot-loopable: the engine records it as
   * quota-blocked and re-probes on an exponential backoff, self-healing when
   * quota grows, another device delivers the CID, or local history retires it.
   * Modeled as a `Deferred`/
   * `storage` failure (so existing reason-based reporting keeps working) with
   * the distinguishing `quotaBlocked` flag.
   */
  private quotaBlockedFailure(rootCid: string, cid: string, detail: string): PushFailure {
    return {
      cid          : rootCid,
      ...(cid === rootCid ? {} : { dependencyCid: cid }),
      kind         : 'Deferred',
      reason       : 'storage',
      quotaBlocked : true,
      detail       : cid === rootCid ? detail : `dependency ${cid} failed before root push: ${detail}`,
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
      case 'EncryptionControl':
        return this.fetchEncryptionControlRecord(ref);
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
        ...(result.localStatusCode === 404 ? { localMissing: true } : {}),
        detail : `local dependency message ${messageCid} not found (${result.localStatusCode ?? 'unknown'} ${result.detail ?? ''})`,
      };
    }

    await this.rememberEntry(result.entry);
    return { kind: 'fetched', entries: [result.entry] };
  }

  private async fetchProtocolConfig(protocol: string): Promise<FetchDependencyResult> {
    const permissionGrantId = await resolveDelegatePermissionGrantId(this.deps, DwnInterface.ProtocolsQuery, protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { protocol },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.ProtocolsQuery,
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
      : await resolveDelegatePermissionGrantId(this.deps, DwnInterface.RecordsQuery, protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { recordId, ...(protocol === undefined ? {} : { protocol }) },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsQuery,
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
    const permissionGrantId = await resolveDelegatePermissionGrantId(this.deps, DwnInterface.RecordsQuery, ref.protocol);
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

  private async fetchEncryptionControlRecord(ref: Extract<DependencyRef, { type: 'EncryptionControl' }>): Promise<FetchDependencyResult> {
    const entries: SyncMessageEntry[] = [];
    let cursor: ProgressToken | undefined;
    for (;;) {
      const reply = await queryLocalMessageFeed({
        did                : this.deps.did,
        delegateDid        : this.deps.delegateDid,
        permissionGrantIds : this.deps.permissionGrantIds,
        filters            : [{ protocol: ref.protocol, protocolPathPrefix: ref.protocolPath }],
        cursor,
        agent              : this.deps.agent,
      });
      if (reply.status.code !== 200 || reply.entries === undefined) {
        return {
          kind   : 'failed',
          detail : `local encryption control feed query failed for ${ref.protocol}: ${reply.status.code} ${reply.status.detail ?? ''}`,
        };
      }

      for (const entry of reply.entries) {
        if (!matchesEncryptionControlDependency(entry.message, ref)) {
          continue;
        }

        entries.push(await this.entryForMessageFeedEntry(entry));
      }

      if (entries.length > 0 || reply.drained === true || reply.cursor === undefined) {
        break;
      }
      cursor = reply.cursor;
    }

    await this.rememberEntries(entries);
    return { kind: 'fetched', entries };
  }

  private async fetchRecordData(ref: Extract<DependencyRef, { type: 'RecordData' }>): Promise<FetchDependencyResult> {
    const permissionGrantId = ref.protocol === undefined
      ? undefined
      : await resolveDelegatePermissionGrantId(this.deps, DwnInterface.RecordsRead, ref.protocol);
    const granteeDid = permissionGrantId === undefined ? undefined : this.deps.delegateDid;
    const { reply } = await this.deps.agent.dwn.processRequest({
      author        : this.deps.delegateDid ?? this.deps.did,
      granteeDid,
      messageParams : {
        filter: { recordId: ref.recordId },
        ...(permissionGrantId === undefined ? {} : { permissionGrantId }),
      },
      messageType : DwnInterface.RecordsRead,
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
      dataStream        : capRecordsWriteDataStream(recordsWrite, recordsReply.entry.data),
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

  private async entryForMessageFeedEntry(entry: NonNullable<MessagesQueryReply['entries']>[number]): Promise<SyncMessageEntry> {
    if (entry.message === undefined) {
      throw new Error(`SyncEngineLevel: local feed entry ${entry.messageCid} did not include a message.`);
    }

    const messageWithEncodedData = { ...entry.message } as GenericMessage & { encodedData?: string };
    const encodedData = entry.encodedData ?? messageWithEncodedData.encodedData;
    delete messageWithEncodedData.encodedData;

    const syncEntry: SyncMessageEntry = {
      message           : messageWithEncodedData,
      isLatestBaseState : entry.isLatestBaseState,
    };
    if (encodedData !== undefined) {
      syncEntry.bufferedData = Encoder.base64UrlToBytes(encodedData);
      return syncEntry;
    }

    if (isRecordsWriteMessage(messageWithEncodedData) && messageWithEncodedData.descriptor.dataCid !== undefined) {
      const hydrated = await getLocalMessage({
        author             : this.deps.did,
        delegateDid        : this.deps.delegateDid,
        permissionGrantIds : this.deps.permissionGrantIds,
        messageCid         : entry.messageCid,
        agent              : this.deps.agent,
      });
      if (hydrated !== undefined) {
        return hydrated;
      }
    }

    return syncEntry;
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

  private async rememberEntries(entries: SyncMessageEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.rememberEntry(entry);
    }
  }

  /**
   * Records an entry under its message CID. Memoized per entry: `Message.getCid()`
   * re-encodes and hashes the message, and every entry is remembered again on each
   * admission pass and by each producer that already remembered it.
   */
  private async rememberEntry(entry: SyncMessageEntry): Promise<string> {
    const memoized = this.entryCids.get(entry);
    if (memoized !== undefined) {
      return memoized;
    }

    const cid = await Message.getCid(entry.message);
    this.entryCids.set(entry, cid);
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

function unreachable(value: never): never {
  throw new Error(`SyncEngineLevel: unreachable sync push branch ${JSON.stringify(value)}`);
}
