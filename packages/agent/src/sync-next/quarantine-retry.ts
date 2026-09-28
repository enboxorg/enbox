import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncMessageEntry } from '../sync-messages.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextQuarantineEntry } from './types.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import { admitClosure } from '../sync-admit-closure.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { syncNextReceiptKey } from './ledger-key.js';
import { Cid, Encoder, Message, Records, RecordsWrite } from '@enbox/dwn-sdk-js';
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
  const selected = entries.sort(compareAttempts)[0];
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
  const prefetched = await prepareRetainedRoot(agent, target, selected);
  const root = prefetched.at(-1)!;
  const outcome = await admitClosure(selected.messageCid, {
    agent,
    did                : target.did,
    dwnUrl             : target.dwnUrl,
    delegateDid        : target.delegateDid,
    permissionGrantIds : target.permissionGrantIds,
    permissionsApi     : agent.permissions,
    prefetched,
    scope              : target.scope,
    shouldContinue,
  });
  if (outcome.kind !== 'admitted') {
    return { freshEntries: [], kind: 'pending' };
  }

  const rootWasApplied = outcome.freshEntries.some(entry => entry.messageCid === selected.messageCid);
  if (
    recordsWriteRequiresData(root.message) &&
    (root.isLatestBaseState !== true || !rootWasApplied)
  ) {
    return { freshEntries: outcome.freshEntries, kind: 'pending' };
  }
  return { freshEntries: outcome.freshEntries, kind: 'settled' };
}

async function prepareRetainedRoot(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  row: SyncNextQuarantineEntry,
): Promise<SyncMessageEntry[]> {
  const entry = row.entry;
  if (new TextEncoder().encode(JSON.stringify(entry)).byteLength !== row.entrySize ||
      entry.messageCid !== row.messageCid || entry.seq !== row.source.position ||
      (row.source.messageCid !== undefined && row.source.messageCid !== row.messageCid) ||
      typeof entry.isLatestBaseState !== 'boolean' ||
      entry.message === undefined || await Message.getCid(entry.message) !== row.messageCid) {
    throw new Error('SyncNextQuarantineRetry: retained entry does not match its durable receipt.');
  }

  const prefetched: SyncMessageEntry[] = entry.initialWrite === undefined
    ? []
    : [{ message: entry.initialWrite, isLatestBaseState: false }];
  const root: SyncMessageEntry = {
    isLatestBaseState : entry.isLatestBaseState,
    message           : entry.message,
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
  prefetched.push(root);
  return prefetched;
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
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
