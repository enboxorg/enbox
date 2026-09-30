import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncMessageEntry } from '../sync-messages.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextQuarantineEntry } from './types.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import { admitClosure } from '../sync-admit-closure.js';
import { classifySyncMessageScope } from '../sync-scope-acceptance.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { syncNextReceiptKey } from './ledger-key.js';
import { Cid, DataStream, Encoder, Message, Records, RecordsWrite } from '@enbox/dwn-sdk-js';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { fetchRemoteMessages, SyncPullAbortedError } from '../sync-messages.js';

export type SyncNextQuarantineRetryResult =
  | { kind: 'aborted' | 'empty' | 'pending' }
  | { kind: 'settled'; freshEntries: SyncFreshEntry[] };

type RetryAttempt = {
  freshEntries: SyncFreshEntry[];
  kind: 'pending' | 'settled';
};

/** Select and retry one retained root without owning scheduling or pagination. */
export async function retryOneQuarantinedRoot({
  agent,
  ledger,
  target,
  shouldContinue = (): boolean => true,
}: {
  agent: EnboxPlatformAgent;
  ledger: SyncNextLedgerStore;
  target: SyncTarget;
  shouldContinue?: () => boolean;
}): Promise<SyncNextQuarantineRetryResult> {
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }
  const entries = await ledger.getQuarantineForLogicalTarget(target.did, target.projectionId);
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }
  entries.sort(compareAttempts);
  const selected = entries[0];
  if (selected === undefined) {
    return { kind: 'empty' };
  }

  try {
    const attempt = await retrySelectedRoot(agent, target, selected, shouldContinue);
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
    return { kind: 'settled', freshEntries: attempt.freshEntries };
  } catch (error: unknown) {
    if (error instanceof SyncPullAbortedError || !shouldContinue()) {
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
): Promise<RetryAttempt> {
  if (target.authorization.kind === 'role') {
    return { freshEntries: [], kind: 'pending' };
  }
  const root = await prepareRetainedRoot(agent, target, selected);
  if (!shouldContinue()) {
    return { freshEntries: [], kind: 'pending' };
  }

  if (recordsWriteRequiresData(root.message) &&
      classifySyncMessageScope({ message: root.message, scope: target.scope }) === 'in-scope') {
    // An exact local duplicate with a body needs no remote read. This call may
    // also apply a missing write, so only a complete apply can settle it.
    const proof = await agent.dwn.applyReplicatedMessage(target.did, root.message, {
      includeMaterializationProof: true,
      ...(root.bufferedData === undefined ? {} : { dataStream: DataStream.fromBytes(root.bufferedData) }),
    }).catch((error: unknown) => {
      // Remote mode can still retry normally when its local server is unpaired
      // or its configured endpoint uses a socket, where proof is unavailable.
      if (error instanceof DwnRpcError &&
          ((error.code === JsonRpcErrorCodes.Forbidden &&
            error.message.includes('includeMaterializationProof requires an authenticated local-node connection')) ||
           (error.code === JsonRpcErrorCodes.InvalidParams &&
            error.message.includes('materialization proof requires HTTP transport')))) {
        return undefined;
      }
      throw error;
    });
    if (proof?.kind === 'Duplicate' && proof.materialized === true) {
      return { freshEntries: [], kind: 'settled' };
    }
    if (proof?.kind === 'Applied' && proof.ancestryOnly !== true) {
      return {
        freshEntries : [{ message: root.message, messageCid: selected.messageCid }],
        kind         : 'settled',
      };
    }
  }

  const outcome = await admitClosure(selected.messageCid, {
    agent,
    did                : target.did,
    dwnUrl             : target.dwnUrl,
    delegateDid        : target.delegateDid,
    permissionGrantIds : target.permissionGrantIds,
    permissionsApi     : agent.permissions,
    prefetched         : [root],
    scope              : target.scope,
    shouldContinue,
  });
  if (outcome.kind !== 'admitted') {
    return { freshEntries: [], kind: 'pending' };
  }

  // A fresh apply proves completion only when this attempt supplied the body.
  const rootWasCompleted =
    (root.bufferedData !== undefined || root.dataStreamFactory !== undefined) &&
    outcome.freshEntries.some(entry => entry.messageCid === selected.messageCid);
  if (recordsWriteRequiresData(root.message) && !rootWasCompleted) {
    return { freshEntries: outcome.freshEntries, kind: 'pending' };
  }
  return { freshEntries: outcome.freshEntries, kind: 'settled' };
}

async function prepareRetainedRoot(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  row: SyncNextQuarantineEntry,
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
      fetchRootData(agent, target, row.messageCid);
  }
  return root;
}

async function fetchRootData(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  messageCid: string,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const [entry] = await fetchRemoteMessages({
    agent,
    delegateDid        : target.delegateDid,
    did                : target.did,
    dwnUrl             : target.dwnUrl,
    messageCids        : [messageCid],
    permissionGrantIds : target.permissionGrantIds,
  });
  return entry?.dataStream;
}

function compareAttempts(left: SyncNextQuarantineEntry, right: SyncNextQuarantineEntry): number {
  const leftTime = Date.parse(left.lastAttemptAt);
  const rightTime = Date.parse(right.lastAttemptAt);
  const comparableLeft = Number.isNaN(leftTime) ? -Infinity : leftTime;
  const comparableRight = Number.isNaN(rightTime) ? -Infinity : rightTime;
  if (comparableLeft !== comparableRight) {
    return comparableLeft < comparableRight ? -1 : 1;
  }
  const leftKey = syncNextReceiptKey(left, left);
  const rightKey = syncNextReceiptKey(right, right);
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}
