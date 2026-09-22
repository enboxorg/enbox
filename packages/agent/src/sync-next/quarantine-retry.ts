import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReplyEntry, RecordsDeleteMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type {
  SyncNextLinkIdentity,
  SyncNextQuarantineEntry,
  SyncNextQuarantineReason,
} from './types.js';

import { admitClosure } from '../sync-admit-closure.js';
import { fetchRemoteMessages } from '../sync-messages.js';
import { openSyncNextQuarantinePayload } from './quarantine-codec.js';
import { readRoleReplicationSupport } from '../sync-role-replication-support.js';
import { runSerializedByKey } from '@enbox/common';
import { syncEntriesFromFeedEntries } from './feed-entry.js';

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export type SyncNextQuarantineAttempt = {
  kind: 'aborted' | 'deferred' | 'empty' | 'pending' | 'settled';
  remaining: number;
};

export type SyncNextQuarantineRetryResult = {
  aborted?: true;
  kind: 'aborted' | 'pending' | 'settled';
  materializedCids?: string[];
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
    const logicalTargetId = `${target.did}^${target.projectionId}`;
    return runSerializedByKey(this._pending, logicalTargetId, async (): Promise<SyncNextQuarantineAttempt> => {
      if (!shouldContinue()) {
        return { kind: 'aborted', remaining: 0 };
      }
      const entries = await this._ledger.getQuarantineForLogicalTarget(logicalTargetId);
      if (entries.length === 0) {
        return { kind: 'empty', remaining: 0 };
      }
      const entry = force
        ? entries[0]
        : entries.find(candidate => SyncNextQuarantineRetry.retryAt(candidate) <= Date.now());
      if (entry === undefined) {
        return {
          kind      : 'deferred',
          remaining : entries.length,
        };
      }

      try {
        const result = await this.retry(target, entry, shouldContinue, signal);
        if (result.kind === 'aborted') {
          return { kind: 'aborted', remaining: entries.length };
        }
        const remainingEntries = await this._ledger.getQuarantineForLogicalTarget(logicalTargetId);
        return {
          kind      : result.kind,
          remaining : remainingEntries.length,
        };
      } catch (error: unknown) {
        await this._ledger.updateQuarantine(entry, entry.outcome);
        throw error;
      }
    });
  }

  public async retry(
    target: SyncTarget,
    entry: SyncNextQuarantineEntry,
    shouldContinue: () => boolean = (): boolean => true,
    signal?: AbortSignal,
  ): Promise<SyncNextQuarantineRetryResult> {
    if (!shouldContinue()) {
      return { aborted: true, kind: 'aborted' };
    }
    if (entry.logicalTargetId !== `${target.did}^${target.projectionId}`) {
      throw new Error('SyncNextQuarantineRetry: target does not own this quarantined receipt.');
    }
    const current = await this._resolveTarget(target);
    const sourceIdentity = SyncNextQuarantineRetry.identity(entry);
    const payload = await openSyncNextQuarantinePayload(this._agent.vault, {
      identity   : sourceIdentity,
      messageCid : entry.messageCid,
      source     : entry.source,
    }, entry.encryptedPayload);
    if (!shouldContinue()) {
      return { aborted: true, kind: 'aborted' };
    }

    const prefetched = current.authorization.kind === 'role'
      ? await this.fetchRoleSupport(current, payload.entry.message, shouldContinue)
      : syncEntriesFromFeedEntries(
        [payload.entry],
        (feedEntry): (() => Promise<ReadableStream<Uint8Array> | undefined>) =>
          (): Promise<ReadableStream<Uint8Array> | undefined> => this.fetchData(current, feedEntry, signal),
      );
    const outcome = await admitClosure(entry.messageCid, {
      agent              : this._agent,
      did                : current.did,
      dwnUrl             : current.dwnUrl,
      delegateDid        : current.delegateDid,
      permissionGrantIds : current.permissionGrantIds,
      prefetched,
      scope              : current.scope,
      shouldContinue,
    });
    if (!shouldContinue()) {
      return { aborted: true, kind: 'aborted' };
    }

    if (outcome.kind === 'admitted') {
      if (outcome.freshEntries.length > 0) {
        this._onApplied?.(current, outcome.freshEntries);
      }
      await this._ledger.settleQuarantineForLogicalTarget(entry.logicalTargetId, entry.messageCid);
      return { kind: 'settled', materializedCids: outcome.appliedCids };
    }

    await this._ledger.updateQuarantine(entry, {
      reason: SyncNextQuarantineRetry.reason(outcome),
    });
    return { kind: 'pending' };
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
    expectedRoot: MessagesQueryReplyEntry['message'],
    shouldContinue: () => boolean,
  ): Promise<ReturnType<typeof syncEntriesFromFeedEntries>> {
    if (
      target.authorization.kind !== 'role' ||
      target.scope.kind !== 'context' ||
      expectedRoot === undefined ||
      expectedRoot.descriptor.interface !== 'Records' ||
      (expectedRoot.descriptor.method !== 'Write' && expectedRoot.descriptor.method !== 'Delete')
    ) {
      throw new Error('SyncNextQuarantineRetry: role quarantine requires an exact context root.');
    }
    const protocolPath = (expectedRoot.descriptor as { protocolPath?: string }).protocolPath;
    if (protocolPath === undefined || !target.scope.protocolPaths.includes(protocolPath)) {
      throw new Error('SyncNextQuarantineRetry: role quarantine root is outside the accepted paths.');
    }
    const support = await readRoleReplicationSupport({
      actorDid       : target.authorization.actorDid,
      agent          : this._agent,
      contextId      : target.scope.contextId,
      delegateDid    : target.delegateDid,
      dwnUrl         : target.dwnUrl,
      expectedRoot   : expectedRoot as RecordsDeleteMessage | RecordsWriteMessage,
      permissionsApi : this._agent.permissions,
      protocol       : target.scope.protocol,
      protocolPath,
      protocolRole   : target.authorization.protocolRole,
      shouldContinue,
      sourceDid      : target.did,
    });
    return [support.root, ...support.dependencies];
  }

  private static reason(
    outcome: Exclude<Awaited<ReturnType<typeof admitClosure>>, { kind: 'admitted' }>,
  ): SyncNextQuarantineReason {
    return outcome.kind === 'deferred'
      ? outcome.reason ?? 'admission-unresolved'
      : 'admission-unresolved';
  }

  private static identity(entry: SyncNextQuarantineEntry): SyncNextLinkIdentity {
    return {
      authorizationEpoch : entry.authorizationEpoch,
      projectionId       : entry.projectionId,
      remoteEndpoint     : entry.remoteEndpoint,
      tenantDid          : entry.tenantDid,
    };
  }

  private static retryAt(entry: SyncNextQuarantineEntry): number {
    const exponent = Math.min(Math.max(0, entry.attempts - 1), 6);
    const delay = Math.min(RETRY_DELAY_MS * (2 ** exponent), MAX_RETRY_DELAY_MS);
    return Date.parse(entry.lastAttemptAt) + delay;
  }
}
