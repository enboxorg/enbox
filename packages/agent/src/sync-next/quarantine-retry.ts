import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncAppliedEntry } from '../sync-admit-closure.js';
import type { SyncMessageEntry } from '../sync-messages.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextQuarantineEntry } from './types.js';
import type { SyncRemoteRequestRunner } from '../sync-request-runner.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import { admitClosure } from '../sync-admit-closure.js';
import { classifySyncMessageScope } from '../sync-scope-acceptance.js';
import { compareSyncNextSparseAttempts } from './ledger-key.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { Cid, DataStream, Encoder, Message, Records, RecordsWrite } from '@enbox/dwn-sdk-js';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { fetchRemoteMessages, SyncPullAbortedError } from '../sync-messages.js';

export type SyncNextQuarantineRetryResult =
  | { kind: 'aborted' | 'empty' | 'pending' }
  | { kind: 'settled'; appliedEntries: SyncAppliedEntry[] };

type RetryAttempt = {
  appliedEntries: SyncAppliedEntry[];
  kind: 'pending' | 'settled';
};

/** Select and retry one retained root without owning scheduling or pagination. */
export async function retryOneQuarantinedRoot({
  agent,
  ledger,
  target,
  runRemoteRequest,
  shouldContinue = (): boolean => true,
}: {
  agent: EnboxPlatformAgent;
  ledger: SyncNextLedgerStore;
  target: SyncTarget;
  runRemoteRequest?: SyncRemoteRequestRunner;
  shouldContinue?: () => boolean;
}): Promise<SyncNextQuarantineRetryResult> {
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }
  const entries = await ledger.getQuarantineForLogicalTarget(target.did, target.projectionId);
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }
  entries.sort(compareSyncNextSparseAttempts);
  const selected = entries[0];
  if (selected === undefined) {
    return { kind: 'empty' };
  }

  try {
    const attempt = await retrySelectedRoot(agent, target, selected, shouldContinue, runRemoteRequest);
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    if (attempt.kind === 'settled') {
      await ledger.settleQuarantineForLogicalTarget(
        target.did,
        target.projectionId,
        selected.messageCid,
      );
    } else {
      await ledger.updateQuarantine(selected);
      return { kind: 'pending' };
    }
    return { kind: 'settled', appliedEntries: attempt.appliedEntries };
  } catch (error: unknown) {
    if (error instanceof SyncPullAbortedError) {
      if (error.reason === 'budget' && shouldContinue()) {
        await ledger.updateQuarantine(selected);
      }
      return { kind: 'aborted' };
    }
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    await ledger.updateQuarantine(selected);
    throw error;
  }
}

async function retrySelectedRoot(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  selected: SyncNextQuarantineEntry,
  shouldContinue: () => boolean,
  runRemoteRequest: SyncRemoteRequestRunner | undefined,
): Promise<RetryAttempt> {
  if (target.authorization.kind === 'role') {
    return { appliedEntries: [], kind: 'pending' };
  }
  const root = await prepareRetainedRoot(agent, target, selected, runRemoteRequest);
  if (!shouldContinue()) {
    return { appliedEntries: [], kind: 'pending' };
  }

  const localCompletion = await tryEstablishLocalWriteCompletion(agent, target, selected.messageCid, root);
  if (localCompletion !== undefined) {
    return localCompletion;
  }

  const outcome = await admitClosure(selected.messageCid, {
    agent,
    did                : target.did,
    dwnUrl             : target.dwnUrl,
    delegateDid        : target.delegateDid,
    permissionGrantIds : target.permissionGrantIds,
    permissionsApi     : agent.permissions,
    prefetched         : [root],
    runRemoteRequest,
    scope              : target.scope,
    shouldContinue,
  });
  if (outcome.kind !== 'admitted') {
    return { appliedEntries: [], kind: 'pending' };
  }

  // A fresh apply establishes completion only when this attempt supplied the body.
  const rootWasCompleted =
    (root.bufferedData !== undefined || root.dataStreamFactory !== undefined) &&
    outcome.appliedEntries.some(entry => entry.messageCid === selected.messageCid);
  if (recordsWriteRequiresData(root.message) && !rootWasCompleted) {
    return { appliedEntries: outcome.appliedEntries, kind: 'pending' };
  }
  return { appliedEntries: outcome.appliedEntries, kind: 'settled' };
}

/** Try to establish complete local state before fetching a retained write's body from its source. */
async function tryEstablishLocalWriteCompletion(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  messageCid: string,
  root: SyncMessageEntry,
): Promise<RetryAttempt | undefined> {
  if (!recordsWriteRequiresData(root.message) ||
      classifySyncMessageScope({ message: root.message, scope: target.scope }) !== 'in-scope') {
    return undefined;
  }

  // A materialized duplicate needs no source read. A missing write may also be
  // applied here, but only its complete Applied result can settle it.
  const applyResult = await agent.dwn.applyReplicatedMessage(target.did, root.message, {
    includeMaterializationConfirmation: true,
    ...(root.bufferedData === undefined ? {} : { dataStream: DataStream.fromBytes(root.bufferedData) }),
  }).catch((error: unknown) => {
    // Remote mode can still retry normally with an ordinary local server or a
    // socket endpoint, where this confirmation is unavailable.
    if (error instanceof DwnRpcError &&
        ((error.code === JsonRpcErrorCodes.Forbidden &&
          error.message.includes('includeMaterializationConfirmation requires an authenticated local-node connection')) ||
         (error.code === JsonRpcErrorCodes.InvalidParams &&
          error.message.includes('materialization confirmation requires HTTP transport')))) {
      return undefined;
    }
    throw error;
  });
  if (applyResult?.kind === 'Duplicate' && applyResult.materialized === true) {
    return { appliedEntries: [], kind: 'settled' };
  }
  if (applyResult?.kind === 'Applied' && applyResult.ancestryOnly !== true) {
    return {
      appliedEntries : [{ message: root.message, messageCid }],
      kind           : 'settled',
    };
  }
  return undefined;
}

async function prepareRetainedRoot(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  row: SyncNextQuarantineEntry,
  runRemoteRequest: SyncRemoteRequestRunner | undefined,
): Promise<SyncMessageEntry> {
  const entry = row.entry;
  if (new TextEncoder().encode(JSON.stringify(entry)).byteLength !== row.entrySize ||
      entry.messageCid !== row.messageCid || entry.seq !== row.source.position ||
      (row.source.messageCid !== undefined && row.source.messageCid !== row.messageCid) ||
      typeof entry.isLatestBaseState !== 'boolean' ||
      entry.message === undefined || await Message.getCid(entry.message) !== row.messageCid) {
    throw new Error('SyncNextQuarantineRetry: retained entry does not match its durable receipt.');
  }

  const root: SyncMessageEntry = {
    isLatestBaseState  : entry.isLatestBaseState,
    message            : entry.message,
    verifiedMessageCid : row.messageCid,
  };
  if (entry.encodedData !== undefined) {
    if (!Records.isRecordsWrite(entry.message)) {
      throw new Error('SyncNextQuarantineRetry: non-RecordsWrite entry retained record data.');
    }
    const data = Encoder.base64UrlToBytes(entry.encodedData);
    const dataCid = await Cid.computeDagPbCidFromBytes(data);
    RecordsWrite.validateDataIntegrity(
      entry.message.descriptor.dataCid,
      entry.message.descriptor.dataSize,
      dataCid,
      data.byteLength,
    );
    root.bufferedData = data;
  } else if (
    entry.isLatestBaseState &&
    recordsWriteRequiresData(entry.message)
  ) {
    root.dataStreamFactory = (): Promise<ReadableStream<Uint8Array> | undefined> =>
      fetchRootData(agent, target, row.messageCid, runRemoteRequest);
  }
  return root;
}

async function fetchRootData(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  messageCid: string,
  runRemoteRequest: SyncRemoteRequestRunner | undefined,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const [entry] = await fetchRemoteMessages({
    agent,
    delegateDid        : target.delegateDid,
    did                : target.did,
    dwnUrl             : target.dwnUrl,
    messageCids        : [messageCid],
    permissionGrantIds : target.permissionGrantIds,
    runRemoteRequest,
  });
  return entry?.dataStream;
}
