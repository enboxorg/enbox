import type {
  DataEncodedRecordsWriteMessage,
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
  SyncMessageDescriptor,
} from './types/sync.js';

import {
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Message,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isRecordsWrite } from './utils.js';
import { resolveDelegatePermissionGrantId } from './delegate-permission-grant.js';
import { toMessagesPermissionGrantIds } from './sync-permission-grants.js';
import {
  dependencyKey,
  hasTerminalDependency,
  isTenantProtocolConfig,
  matchesEncryptionControlDependency,
  missingDependencyDetail,
  newestProtocolConfig,
  recordsWriteRequiresData,
} from './sync-fetch-helpers.js';
import { DwnRpcError, isQuotaExceededError } from '@enbox/dwn-clients';
import { getRoleKey, orderMessagesForAdmission } from './sync-admission-order.js';
import { isNonRetryableSyncAuthorizationFailure, syncErrorMessage } from './sync-runtime-errors.js';

/** Maximum data size (in bytes) to buffer in memory for retry. Larger payloads are re-fetched. */
const MAX_BUFFER_SIZE = 1_048_576; // 1 MB

/** Entry type for fetched messages with optional data stream and retry buffer. */
export type SyncMessageEntry = {
  message: GenericMessage;
  dataStream?: ReadableStream<Uint8Array>;
  dataStreamConsumed?: boolean;
  dataStreamFactory?: () => Promise<ReadableStream<Uint8Array> | undefined>;
  /** Source query/feed attestation. Latest RecordsWrite entries must carry data before apply. */
  isLatestBaseState?: boolean;
  /** Buffered data bytes for retry — avoids re-fetching from remote when stream is consumed. */
  bufferedData?: Uint8Array;
};

/**
 * Builds a {@link SyncMessageDescriptor} for a sync-delivered message so event
 * consumers can route the change (protocol path, record, author) without
 * re-reading the local store. Fields a given interface/method does not carry
 * are simply absent: `recordId` comes from the message envelope for
 * `RecordsWrite` and from the descriptor for `RecordsDelete`, and `protocol`
 * falls back to the configured definition for `ProtocolsConfigure`.
 */
export function syncMessageDescriptor(message: GenericMessage): SyncMessageDescriptor {
  const descriptor = message.descriptor as GenericMessage['descriptor'] & {
    protocol?: string;
    protocolPath?: string;
    recordId?: string;
    definition?: { protocol?: string };
  };
  const envelope = message as GenericMessage & { recordId?: string; contextId?: string };

  let author: string | undefined;
  try {
    author = Message.getAuthor(message) ?? undefined;
  } catch {
    // Anonymous or unparseable authorization — the descriptor stays author-less.
  }

  const protocol = descriptor.protocol ?? descriptor.definition?.protocol;
  const recordId = envelope.recordId ?? descriptor.recordId;

  return {
    interface : descriptor.interface,
    method    : descriptor.method,
    ...(descriptor.messageTimestamp === undefined ? {} : { messageTimestamp: descriptor.messageTimestamp }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(descriptor.protocolPath === undefined ? {} : { protocolPath: descriptor.protocolPath }),
    ...(recordId === undefined ? {} : { recordId }),
    ...(envelope.contextId === undefined ? {} : { contextId: envelope.contextId }),
    ...(author === undefined ? {} : { author }),
  };
}

type MessageFeedQuery = {
  did: string;
  authorDid?: string;
  delegateDid?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  permissionGrantIds?: string[];
  protocolRole?: string;
  filters?: MessagesFilter[];
  cursor?: ProgressToken;
  limit?: number;
  cidsOnly?: boolean;
  agent: EnboxPlatformAgent;
};

type MessageFeedParams = Omit<MessageFeedQuery, 'authorDid' | 'did' | 'delegateDid' | 'agent'>;

type FetchLocalMessageResult =
  | { kind: 'found'; entry: SyncMessageEntry }
  | { kind: 'missing'; localStatusCode?: number; detail?: string };

type FetchDependencyResult =
  | { kind: 'fetched'; entries: SyncMessageEntry[] }
  | { kind: 'failed'; dependencyCid?: string; detail: string; localMissing?: boolean };

type PrepareLocalEntryParams = {
  message: GenericMessage;
  isLatestBaseState: boolean;
  encodedData?: string;
  messageCid?: string;
};

function fetchFailureFromError(
  error: unknown,
  detail: string,
  dependencyCid?: string,
): FetchDependencyResult {
  const errorDetail = syncErrorMessage(error);
  if (isNonRetryableSyncAuthorizationFailure(errorDetail)) {
    throw error;
  }

  return {
    kind   : 'failed',
    ...(dependencyCid === undefined ? {} : { dependencyCid }),
    detail : `${detail}: ${errorDetail}`,
  };
}

type PushEntryResult =
  | { kind: 'applied' }
  | { kind: 'retry'; entries: SyncMessageEntry[] }
  | { kind: 'failed'; failure: PushFailure };

type PushPayload = Blob | ReadableStream<Uint8Array> | undefined;

type PushRootOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; failure: PushFailure };

/**
 * Common push/pull admission budget. Replication apply reports the full set of
 * missing ancestors in a single bounded, structured result, so a well-formed
 * closure converges in a handful of passes; this cap prevents remote cycles
 * and malformed or adversarial remotes from turning into unbounded local
 * query/apply loops.
 */
export const MAX_ADMISSION_PASSES = 128;

/** Raised when an in-flight pull is cancelled before local apply can continue. */
export class SyncPullAbortedError extends Error {
  constructor() {
    super('Sync pull aborted because the sync target is no longer current.');
    this.name = 'SyncPullAbortedError';
  }
}

export class SyncDataSizeLimitExceededError extends Error {
  public constructor(dataSize: number) {
    super(`SyncMessages: RecordsWrite data exceeded descriptor dataSize ${dataSize}.`);
    this.name = 'SyncDataSizeLimitExceededError';
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

/** Build a single-chunk readable stream over one in-memory byte payload. */
export function dataStreamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

/** Resolve the record id of a RecordsWrite or RecordsDelete message, if any. */
export function recordIdForRecordsMessage(message: GenericMessage | undefined): string | undefined {
  if (
    message?.descriptor.interface !== DwnInterfaceName.Records ||
    (
      message.descriptor.method !== DwnMethodName.Write &&
      message.descriptor.method !== DwnMethodName.Delete
    )
  ) {
    return undefined;
  }

  const recordId = (message as { recordId?: unknown }).recordId ??
    (message.descriptor as { recordId?: unknown }).recordId;
  return typeof recordId === 'string' ? recordId : undefined;
}

/** Whether the message is the initial RecordsWrite for the given record. */
export function isInitialWriteForRecord(message: GenericMessage, recordId: string): boolean {
  if (!isRecordsWriteForRecord(message, recordId)) {
    return false;
  }

  const recordsWrite = message as GenericMessage & {
    descriptor: GenericMessage['descriptor'] & { dateCreated?: string };
  };
  return recordsWrite.descriptor.dateCreated === recordsWrite.descriptor.messageTimestamp;
}

/** Whether the message is a RecordsWrite addressing the given record. */
export function isRecordsWriteForRecord(message: GenericMessage, recordId: string): boolean {
  if (
    message.descriptor.interface !== DwnInterfaceName.Records ||
    message.descriptor.method !== DwnMethodName.Write
  ) {
    return false;
  }

  return (message as GenericMessage & { recordId?: string }).recordId === recordId;
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

/** Buffer one small data stream so it can be replayed on retry. */
async function bufferSmallStream(entry: SyncMessageEntry): Promise<void> {
  if (
    entry.dataStream === undefined ||
    entry.dataStreamConsumed === true ||
    entry.bufferedData !== undefined ||
    !shouldBufferDataStream(entry)
  ) {
    return;
  }

  entry.bufferedData = await bufferDataStream(entry.dataStream);
  // The buffered bytes now own retryability; retain no redundant stream.
  entry.dataStream = undefined;
}

async function bufferDataStream(dataStream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  const reader = dataStream.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      totalSize += value.byteLength;
      if (totalSize > MAX_BUFFER_SIZE) {
        throw new Error('SyncMessages: unexpected large stream while buffering push data.');
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
  delegatedGrant,
  permissionGrantIds,
  protocolRole,
}: MessageFeedParams): Omit<MessagesQueryOptions, 'signer'> {
  return {
    filters,
    cursor,
    limit,
    cidsOnly,
    permissionGrantIds: toMessagesPermissionGrantIds(permissionGrantIds),
    ...(delegatedGrant === undefined ? {} : { delegatedGrant }),
    ...(protocolRole === undefined ? {} : { protocolRole }),
  };
}

/**
 * Queries a remote DWN's durable message feed using MessagesQuery.
 */
export async function queryRemoteMessageFeed({
  did,
  authorDid,
  dwnUrl,
  delegateDid,
  delegatedGrant,
  permissionGrantIds,
  protocolRole,
  filters,
  cursor,
  limit,
  cidsOnly,
  agent,
}: MessageFeedQuery & { dwnUrl: string }): Promise<MessagesQueryReply> {
  const messagesQuery = await agent.processDwnRequest({
    store         : false,
    author        : authorDid ?? did,
    target        : did,
    messageType   : DwnInterface.MessagesQuery,
    granteeDid    : delegateDid,
    messageParams : buildMessageFeedParams({
      filters,
      cursor,
      limit,
      cidsOnly,
      delegatedGrant,
      permissionGrantIds,
      protocolRole,
    })
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
  authorDid,
  delegateDid,
  delegatedGrant,
  permissionGrantIds,
  protocolRole,
  filters,
  cursor,
  limit,
  cidsOnly,
  agent,
}: MessageFeedQuery): Promise<MessagesQueryReply> {
  const { reply } = await agent.dwn.processRequest({
    author        : authorDid ?? did,
    target        : did,
    messageType   : DwnInterface.MessagesQuery,
    granteeDid    : delegateDid,
    messageParams : buildMessageFeedParams({
      filters,
      cursor,
      limit,
      cidsOnly,
      delegatedGrant,
      permissionGrantIds,
      protocolRole,
    })
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
        console.error(`SyncMessages: pull - failed to read ${messageCid} from ${dwnUrl}:`, error.message ?? error);
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
export async function pushMessages({
  did,
  dwnUrl,
  delegateDid,
  permissionGrantIds,
  messageCids,
  agent,
  permissionsApi,
  onBeforeApply,
}: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  messageCids: string[];
  agent: EnboxPlatformAgent;
  permissionsApi?: PermissionsApi;
  onBeforeApply?: (messageCid: string) => void;
}): Promise<PushResult> {
  const context = new RemoteApplyPushContext({
    did,
    dwnUrl,
    delegateDid,
    permissionGrantIds,
    agent,
    permissionsApi,
    onBeforeApply,
  });
  return context.push(messageCids);
}

export async function pushMessageEntries({
  did,
  dwnUrl,
  delegateDid,
  permissionGrantIds,
  entries,
  agent,
  permissionsApi,
  onBeforeApply,
}: {
  did: string;
  dwnUrl: string;
  delegateDid?: string;
  permissionGrantIds?: string[];
  entries: SyncMessageEntry[];
  agent: EnboxPlatformAgent;
  permissionsApi?: PermissionsApi;
  onBeforeApply?: (messageCid: string) => void;
}): Promise<PushResult> {
  const context = new RemoteApplyPushContext({
    did,
    dwnUrl,
    delegateDid,
    permissionGrantIds,
    agent,
    permissionsApi,
    onBeforeApply,
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
  const messageEntry = reply.entry;

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

export class RemoteApplyPushContext {
  private readonly entryCids = new WeakMap<SyncMessageEntry, string>();
  private readonly fetchedDependencyEntries = new Map<string, SyncMessageEntry[]>();
  private readonly acknowledgementsByCid = new Map<string, PushSuccessResolution>();

  public constructor(private readonly deps: {
    did: string;
    dwnUrl: string;
    delegateDid?: string;
    permissionGrantIds?: string[];
    agent: EnboxPlatformAgent;
    permissionsApi?: PermissionsApi;
    onBeforeApply?: (messageCid: string) => void;
  }) {}

  public async push(rootCids: string[]): Promise<PushResult> {
    const failedByRoot = new Map<string, PushFailure>();
    const rootEntries = await this.fetchRootEntries(rootCids, failedByRoot);

    return this.pushEntries(rootEntries, failedByRoot);
  }

  /** Push one complete local-feed root alongside any explicitly staged roots. */
  public async pushFeedEntry(
    entry: NonNullable<MessagesQueryReply['entries']>[number],
    stagedRootCids: string[],
  ): Promise<PushResult> {
    const failedByRoot = new Map<string, PushFailure>();
    const rootEntries = await this.fetchRootEntries(stagedRootCids, failedByRoot);
    const feedRoot = await this.fetchMessageFeedEntry(entry);
    if (feedRoot.kind === 'failed') {
      failedByRoot.set(entry.messageCid, { cid: entry.messageCid, detail: feedRoot.detail });
    } else {
      rootEntries.push(...feedRoot.entries);
    }

    return this.pushEntries(rootEntries, failedByRoot);
  }

  private async fetchRootEntries(
    rootCids: string[],
    failedByRoot: Map<string, PushFailure>,
  ): Promise<SyncMessageEntry[]> {
    const rootEntries: SyncMessageEntry[] = [];

    for (const rootCid of new Set(rootCids)) {
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

    return rootEntries;
  }

  public async pushEntries(
    rootEntries: SyncMessageEntry[],
    failedByRoot = new Map<string, PushFailure>(),
  ): Promise<PushResult> {
    const acknowledgedBefore = new Set(this.acknowledgementsByCid.keys());
    const succeeded = new Set<string>();

    for (const rootEntry of orderMessagesForAdmission(rootEntries)) {
      const rootCid = await this.rememberEntry(rootEntry);
      if (failedByRoot.has(rootCid)) {
        await releaseUnusedPushPayload(rootEntry);
        continue;
      }

      const outcome = await this.pushRoot(rootCid, rootEntry);
      if (outcome.kind === 'succeeded') {
        succeeded.add(rootCid);
        failedByRoot.delete(rootCid);
      } else {
        failedByRoot.set(outcome.failure.cid, outcome.failure);
      }
    }

    const acknowledged: PushAcknowledgement[] = [...this.acknowledgementsByCid]
      .filter(([cid]) => !acknowledgedBefore.has(cid) || succeeded.has(cid))
      .map(([cid, resolution]) => ({ cid, resolution }));

    return { succeeded: [...succeeded], acknowledged, failed: [...failedByRoot.values()] };
  }

  private async pushRoot(rootCid: string, rootEntry: SyncMessageEntry): Promise<PushRootOutcome> {
    let pending = [rootEntry];
    for (let pass = 0; pass < MAX_ADMISSION_PASSES && pending.length > 0; pass++) {
      const retry: SyncMessageEntry[] = [];
      const ordered = orderMessagesForAdmission(pending);
      for (let index = 0; index < ordered.length; index++) {
        const entry = ordered[index];
        const result = await this.pushEntry(rootCid, entry);
        switch (result.kind) {
          case 'applied':
            break;
          case 'retry':
            retry.push(...result.entries);
            break;
          case 'failed':
            await releaseUnusedPushPayloads([entry, ...retry, ...ordered.slice(index + 1)]);
            return { kind: 'failed', failure: result.failure };
        }
      }
      pending = await dedupeSyncMessageEntries(retry);
    }

    if (pending.length > 0) {
      await releaseUnusedPushPayloads(pending);
      return {
        kind    : 'failed',
        failure : { cid: rootCid, kind: 'Incomplete', detail: 'remote dependency apply pass budget exhausted' },
      };
    }

    return this.acknowledgementsByCid.has(rootCid)
      ? { kind: 'succeeded' }
      : {
        kind    : 'failed',
        failure : { cid: rootCid, kind: 'Incomplete', detail: 'remote did not acknowledge the pushed root message' },
      };
  }

  private async pushEntry(rootCid: string, entry: SyncMessageEntry): Promise<PushEntryResult> {
    const cid = await this.rememberEntry(entry);
    // Only settled remote outcomes enter this cache. Incomplete dependency
    // resolution remains eligible for another apply attempt.
    if (this.acknowledgementsByCid.has(cid)) {
      await releaseUnusedPushPayload(entry);
      return { kind: 'applied' };
    }

    try {
      await bufferSmallStream(entry);
    } catch (error: any) {
      const detail = error.message ?? String(error);
      console.error(`SyncMessages: push error for ${cid}: ${detail}`);
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
      const data = await resolvePushPayload(entry);
      if (isRequiredPushPayloadMissing(entry, data)) {
        return {
          kind    : 'failed',
          failure : this.retryableFailure(rootCid, cid, 'required payload is unavailable for current message'),
        };
      }
      this.deps.onBeforeApply?.(cid);
      const ancestryOnly = await isAncestryOnlyPush(entry, data);
      result = await this.deps.agent.rpc.applyReplicatedMessage({
        dwnUrl    : this.deps.dwnUrl,
        targetDid : this.deps.did,
        data,
        message   : entry.message,
        ...(ancestryOnly ? { ancestryOnly: true } : {}),
      });
    } catch (error: any) {
      const detail = error.message ?? String(error);
      if (error instanceof SyncDataSizeLimitExceededError) {
        console.error(`SyncMessages: push error for ${cid}: ${detail}`);
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
      console.error(`SyncMessages: push error for ${cid}: ${detail}`);
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
        this.acknowledgementsByCid.set(cid, 'applied');
        return { kind: 'applied' };
      case 'Superseded':
        this.acknowledgementsByCid.set(cid, 'superseded');
        return { kind: 'applied' };
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
        failure : this.retryableFailure(rootCid, dependencies.dependencyCid ?? cid, dependencies.detail),
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
      if (this.acknowledgementsByCid.has(dependencyCid)) {
        await releaseUnusedPushPayload(dependency);
      } else {
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
    const staged = new Map<string, SyncMessageEntry[]>();
    let committed = false;
    try {
      for (const ref of refs) {
        const key = dependencyKey(ref);
        const cached = this.fetchedDependencyEntries.get(key) ?? staged.get(key);
        if (cached !== undefined) {
          fetched.push(...cached);
          continue;
        }

        let result: FetchDependencyResult;
        try {
          result = await this.fetchDependency(ref);
        } catch (error: unknown) {
          return fetchFailureFromError(error, `local dependency fetch failed for ${key}`);
        }
        if (result.kind === 'failed') {
          return result;
        }

        staged.set(key, result.entries);
        fetched.push(...result.entries);
      }

      for (const [key, entries] of staged) {
        this.fetchedDependencyEntries.set(key, entries);
      }
      committed = true;
      return { kind: 'fetched', entries: fetched };
    } finally {
      if (!committed) {
        await releaseUnusedPushPayloads([...staged.values()].flat());
      }
    }
  }

  private async fetchDependency(ref: DependencyRef): Promise<FetchDependencyResult> {
    if (ref.messageCid !== undefined) {
      return this.fetchMessageCid(ref.messageCid);
    }

    switch (ref.type) {
      case 'Protocol':
        return this.fetchProtocolConfig(ref.protocol);
      case 'InitialWrite':
      case 'Parent':
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
    let result: FetchLocalMessageResult;
    try {
      result = await readLocalMessage({
        author             : this.deps.did,
        delegateDid        : this.deps.delegateDid,
        permissionGrantIds : this.deps.permissionGrantIds,
        messageCid,
        agent              : this.deps.agent,
      });
    } catch (error: unknown) {
      return fetchFailureFromError(
        error,
        `local dependency message ${messageCid} read failed`,
        messageCid,
      );
    }
    if (result.kind === 'missing') {
      return {
        kind          : 'failed',
        dependencyCid : messageCid,
        ...(result.localStatusCode === 404 ? { localMissing: true } : {}),
        detail        : `local dependency message ${messageCid} not found (${result.localStatusCode ?? 'unknown'} ${result.detail ?? ''})`,
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

    return this.entriesFromRecordsQueryEntries(recordsReply.entries);
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

    return this.entriesFromRecordsQueryEntries(recordsReply.entries);
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

        const fetched = await this.fetchMessageFeedEntry(entry);
        if (fetched.kind === 'failed') {
          await releaseUnusedPushPayloads(entries);
          return fetched;
        }
        entries.push(...fetched.entries);
      }

      if (entries.length > 0 || reply.drained === true || reply.cursor === undefined) {
        break;
      }
      cursor = reply.cursor;
    }

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

  private async entriesFromRecordsQueryEntries(
    recordsQueryEntries: NonNullable<RecordsQueryReply['entries']>,
  ): Promise<FetchDependencyResult> {
    const entries: SyncMessageEntry[] = [];
    for (const recordEntry of recordsQueryEntries) {
      const { encodedData, initialWrite, ...message } = recordEntry;
      if (initialWrite !== undefined) {
        entries.push({
          message           : initialWrite,
          isLatestBaseState : false,
        });
      }

      const currentEntry = await this.prepareLocalEntry({
        message,
        isLatestBaseState: true,
        encodedData,
      });
      if (currentEntry.kind === 'failed') {
        await releaseUnusedPushPayloads(entries);
        return currentEntry;
      }
      entries.push(...currentEntry.entries);
    }

    const dedupedEntries = await dedupeSyncMessageEntries(entries);
    return { kind: 'fetched', entries: dedupedEntries };
  }

  private async fetchMessageFeedEntry(
    entry: NonNullable<MessagesQueryReply['entries']>[number],
  ): Promise<FetchDependencyResult> {
    if (entry.message === undefined) {
      throw new Error(`SyncMessages: local feed entry ${entry.messageCid} did not include a message.`);
    }

    return this.prepareLocalEntry({
      message           : entry.message,
      isLatestBaseState : entry.isLatestBaseState,
      encodedData       : entry.encodedData,
      messageCid        : entry.messageCid,
    });
  }

  /** Prepare one locally enumerated message without reopening acknowledged payloads. */
  private async prepareLocalEntry(params: PrepareLocalEntryParams): Promise<FetchDependencyResult> {
    const { message, isLatestBaseState, encodedData, messageCid } = params;
    const entry: SyncMessageEntry = { message, isLatestBaseState };
    const cid = await this.rememberEntry(entry);
    const payloadCid = messageCid ?? cid;

    // Dependencies discovered ahead of their own feed row share this path.
    // Once this remote has acknowledged the CID, neither source should decode
    // inline bytes nor open another local payload stream.
    if (this.acknowledgementsByCid.has(cid)) {
      return { kind: 'fetched', entries: [entry] };
    }

    if (encodedData !== undefined) {
      entry.bufferedData = Encoder.base64UrlToBytes(encodedData);
      return { kind: 'fetched', entries: [entry] };
    }

    if (!isLatestBaseState || !recordsWriteRequiresData(message)) {
      return { kind: 'fetched', entries: [entry] };
    }

    let hydrated: FetchLocalMessageResult;
    try {
      hydrated = await readLocalMessage({
        author             : this.deps.did,
        delegateDid        : this.deps.delegateDid,
        permissionGrantIds : this.deps.permissionGrantIds,
        messageCid         : payloadCid,
        agent              : this.deps.agent,
      });
    } catch (error: unknown) {
      return fetchFailureFromError(
        error,
        `local payload read failed for current message ${payloadCid}`,
        payloadCid,
      );
    }

    if (hydrated.kind === 'missing') {
      const status = [hydrated.localStatusCode, hydrated.detail].join(' ').trim();
      return {
        kind          : 'failed',
        dependencyCid : payloadCid,
        detail        : `local payload read failed for current message ${payloadCid}: ${status}`,
      };
    }

    if (hydrated.entry.dataStream === undefined) {
      return {
        kind          : 'failed',
        dependencyCid : payloadCid,
        detail        : `local payload read returned no data for current message ${payloadCid}`,
      };
    }

    entry.dataStream = hydrated.entry.dataStream;
    entry.dataStreamFactory = hydrated.entry.dataStreamFactory;
    return { kind: 'fetched', entries: [entry] };
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
    return cid;
  }
}

async function releaseUnusedPushPayload(entry: SyncMessageEntry): Promise<void> {
  if (entry.dataStream === undefined || entry.dataStreamConsumed === true) {
    return;
  }

  entry.dataStreamConsumed = true;
  try {
    await entry.dataStream.cancel();
  } catch {
    // Cleanup failure cannot change the synchronization outcome already
    // selected by the caller.
  }
}

async function releaseUnusedPushPayloads(entries: SyncMessageEntry[]): Promise<void> {
  for (const entry of entries) {
    await releaseUnusedPushPayload(entry);
  }
}

async function resolvePushPayload(entry: SyncMessageEntry): Promise<PushPayload> {
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

export async function dedupeSyncMessageEntries(entries: SyncMessageEntry[]): Promise<SyncMessageEntry[]> {
  const byCid = new Map<string, SyncMessageEntry>();
  for (const entry of entries) {
    byCid.set(await getMessageCid(entry.message), entry);
  }
  return [...byCid.values()];
}

async function isAncestryOnlyPush(
  entry: SyncMessageEntry,
  data: PushPayload,
): Promise<boolean> {
  return entry.isLatestBaseState === false &&
    data === undefined &&
    recordsWriteRequiresData(entry.message) &&
    await RecordsWrite.isInitialWrite(entry.message);
}

function isRequiredPushPayloadMissing(entry: SyncMessageEntry, data: PushPayload): boolean {
  return entry.isLatestBaseState === true &&
    data === undefined &&
    recordsWriteRequiresData(entry.message);
}

function isRecordsWriteMessage(message: GenericMessage): message is RecordsWriteMessage {
  return message.descriptor.interface === DwnInterfaceName.Records &&
    message.descriptor.method === DwnMethodName.Write &&
    typeof (message as { recordId?: unknown }).recordId === 'string';
}

function unreachable(value: never): never {
  throw new Error(`SyncMessages: unreachable sync push branch ${JSON.stringify(value)}`);
}
