import type { EnboxPlatformAgent } from '../types/agent.js';
import type { RoleReplicationSupportBatch } from '../sync-role-replication-support.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextQuarantineEntry } from './types.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReplyEntry, RecordsDeleteMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { admitClosure } from '../sync-admit-closure.js';
import { fetchRemoteMessages } from '../sync-messages.js';
import { openSyncNextQuarantinePayload } from './quarantine-codec.js';
import { readRoleReplicationSupport } from '../sync-role-replication-support.js';
import { runSerializedByKey } from '@enbox/common';
import { syncEntriesFromFeedEntries } from './feed-entry.js';
import { syncNextLogicalTargetId } from './ledger-key.js';
import { Encoder, Records } from '@enbox/dwn-sdk-js';

const RETRY_DELAY_MS = 1_000;

export type SyncNextQuarantineAttempt = {
  deferred?: boolean;
  progressed: boolean;
  remaining: number;
};

/** Retries one quarantined root independently from feed-page consumption. */
export class SyncNextQuarantineRetry {
  private readonly _pending = new Map<string, Promise<void>>();

  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _resolveTarget: (target: SyncTarget) => Promise<SyncTarget> = async target => target,
    private readonly _onApplied?: (target: SyncTarget, entries: readonly SyncFreshEntry[]) => void,
  ) {}

  /** Select and retry one due receipt across every binding for a logical target. */
  public retryOne(
    target: SyncTarget,
    shouldContinue: () => boolean = (): boolean => true,
    signal?: AbortSignal,
    force = false,
  ): Promise<SyncNextQuarantineAttempt> {
    const logicalTargetId = syncNextLogicalTargetId(target.did, target.projectionId);
    return runSerializedByKey(this._pending, logicalTargetId, async (): Promise<SyncNextQuarantineAttempt> => {
      if (!shouldContinue()) {
        return { progressed: false, remaining: 0 };
      }
      const entries = await this._ledger.getQuarantineForLogicalTarget(logicalTargetId);
      if (entries.length === 0) {
        return { progressed: false, remaining: 0 };
      }
      entries.sort((left, right) => left.lastAttemptAt.localeCompare(right.lastAttemptAt));
      const entry = force
        ? entries[0]
        : entries.find(candidate => SyncNextQuarantineRetry.retryAt(candidate) <= Date.now());
      if (entry === undefined) {
        return { deferred: true, progressed: false, remaining: entries.length };
      }

      try {
        const progressed = await this.retry(target, entry, shouldContinue, signal);
        const remainingEntries = await this._ledger.getQuarantineForLogicalTarget(logicalTargetId);
        return { progressed, remaining: remainingEntries.length };
      } catch (error: unknown) {
        await this._ledger.updateQuarantine(entry);
        throw error;
      }
    });
  }

  public async retry(
    target: SyncTarget,
    entry: SyncNextQuarantineEntry,
    shouldContinue: () => boolean = (): boolean => true,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!shouldContinue()) {
      return false;
    }
    const logicalTargetId = syncNextLogicalTargetId(target.did, target.projectionId);
    if (syncNextLogicalTargetId(entry.tenantDid, entry.projectionId) !== logicalTargetId) {
      throw new Error('SyncNextQuarantineRetry: target does not own this quarantined receipt.');
    }
    const current = await this._resolveTarget(target);
    const feedEntry = await openSyncNextQuarantinePayload(this._agent.vault, {
      identity   : entry,
      messageCid : entry.messageCid,
      source     : entry.source,
    }, entry.encryptedPayload);
    if (!shouldContinue()) {
      return false;
    }

    const roleSupport = current.authorization.kind === 'role'
      ? await this.fetchRoleSupport(current, feedEntry, shouldContinue)
      : undefined;
    const prefetched = roleSupport === undefined
      ? syncEntriesFromFeedEntries(
        [feedEntry],
        (feedEntry): (() => Promise<ReadableStream<Uint8Array> | undefined>) =>
          (): Promise<ReadableStream<Uint8Array> | undefined> => this.fetchData(current, feedEntry, signal),
      )
      : [roleSupport.root, ...roleSupport.dependencies];
    const outcome = await admitClosure(entry.messageCid, {
      agent       : this._agent,
      did         : current.did,
      dwnUrl      : current.dwnUrl,
      delegateDid : current.delegateDid,
      ...(roleSupport === undefined
        ? {}
        : { fetchReplicationSupport: async (): Promise<RoleReplicationSupportBatch> => roleSupport }),
      permissionGrantIds : current.permissionGrantIds,
      prefetched,
      scope              : current.scope,
      shouldContinue,
    });
    if (!shouldContinue()) {
      return false;
    }

    if (outcome.kind === 'admitted') {
      if (outcome.freshEntries.length > 0) {
        this._onApplied?.(current, outcome.freshEntries);
      }
      await this._ledger.settleQuarantineForLogicalTarget(logicalTargetId, entry.messageCid);
      return true;
    }

    await this._ledger.updateQuarantine(entry);
    return false;
  }

  private async fetchData(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    const [fetched] = await fetchRemoteMessages({
      agent              : this._agent,
      delegateDid        : target.delegateDid,
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      messageCids        : [entry.messageCid],
      permissionGrantIds : target.permissionGrantIds,
      signal,
    });
    return fetched?.dataStream;
  }

  private async fetchRoleSupport(
    target: Extract<SyncTarget, { authorization: { kind: 'role' } }> | SyncTarget,
    entry: MessagesQueryReplyEntry,
    shouldContinue: () => boolean,
  ): Promise<RoleReplicationSupportBatch> {
    const expectedRoot = entry.message;
    const isWrite = expectedRoot !== undefined && Records.isRecordsWrite(expectedRoot);
    const isDelete = expectedRoot?.descriptor.interface === 'Records' &&
      expectedRoot.descriptor.method === 'Delete';
    if (
      target.authorization.kind !== 'role' ||
      target.scope.kind !== 'context' ||
      expectedRoot === undefined ||
      (!isWrite && !isDelete)
    ) {
      throw new Error('SyncNextQuarantineRetry: role quarantine requires an exact context root.');
    }
    const rootRecordId = isWrite
      ? expectedRoot.recordId
      : (expectedRoot as RecordsDeleteMessage).descriptor.recordId;
    const contextualWrite = isWrite ? expectedRoot : entry.initialWrite;
    if (
      contextualWrite === undefined ||
      !Records.isRecordsWrite(contextualWrite) ||
      contextualWrite.recordId !== rootRecordId
    ) {
      throw new Error('SyncNextQuarantineRetry: role delete is missing its initial write.');
    }
    const { contextId, recordId } = contextualWrite;
    const { protocol, protocolPath } = contextualWrite.descriptor;
    if (
      contextId === undefined ||
      recordId === undefined ||
      protocol !== target.scope.protocol ||
      protocolPath === undefined ||
      !target.scope.protocolPaths.includes(protocolPath)
    ) {
      throw new Error('SyncNextQuarantineRetry: role quarantine root is outside the accepted paths.');
    }
    const support = await readRoleReplicationSupport({
      actorDid       : target.authorization.actorDid,
      agent          : this._agent,
      contextId,
      delegateDid    : target.delegateDid,
      dwnUrl         : target.dwnUrl,
      expectedRoot   : expectedRoot as RecordsDeleteMessage | RecordsWriteMessage,
      permissionsApi : this._agent.permissions,
      protocol       : target.scope.protocol,
      protocolPath,
      protocolRole   : target.authorization.protocolRole,
      ...(entry.encodedData === undefined
        ? {}
        : { rootData: Encoder.base64UrlToBytes(entry.encodedData) }),
      shouldContinue,
      sourceDid: target.did,
    });
    return {
      ...support,
      root: { ...support.root, isLatestBaseState: entry.isLatestBaseState },
    };
  }

  private static retryAt(entry: SyncNextQuarantineEntry): number {
    return Date.parse(entry.lastAttemptAt) + RETRY_DELAY_MS;
  }
}
