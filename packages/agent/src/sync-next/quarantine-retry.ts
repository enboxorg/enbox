import type { EnboxPlatformAgent } from '../types/agent.js';
import type { MessagesQueryReplyEntry } from '@enbox/dwn-sdk-js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type {
  SyncNextLinkIdentity,
  SyncNextQuarantineEntry,
  SyncNextQuarantineReason,
} from './types.js';

import { admitClosure } from '../sync-admit-closure.js';
import { fetchRemoteMessages } from '../sync-messages.js';
import { openSyncNextQuarantinePayload } from './quarantine-codec.js';
import { syncEntriesFromFeedEntries } from './feed-entry.js';

export type SyncNextQuarantineRetryResult = {
  aborted?: true;
  kind: 'aborted' | 'pending' | 'settled';
  materializedCids?: string[];
};

/** Retries one quarantined root independently from feed-page consumption. */
export class SyncNextQuarantineRetry {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
  ) {}

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
    const sourceIdentity = SyncNextQuarantineRetry.identity(entry);
    const payload = await openSyncNextQuarantinePayload(this._agent.vault, {
      identity   : sourceIdentity,
      messageCid : entry.messageCid,
      source     : entry.source,
    }, entry.encryptedPayload);
    if (!shouldContinue()) {
      return { aborted: true, kind: 'aborted' };
    }

    const received = [payload.entry, ...payload.support];
    const prefetched = syncEntriesFromFeedEntries(
      received,
      (feedEntry): (() => Promise<ReadableStream<Uint8Array> | undefined>) =>
        (): Promise<ReadableStream<Uint8Array> | undefined> => this.fetchData(target, feedEntry, signal),
    );
    const outcome = await admitClosure(entry.messageCid, {
      agent              : this._agent,
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      prefetched,
      scope              : target.scope,
      shouldContinue,
    });
    if (!shouldContinue()) {
      return { aborted: true, kind: 'aborted' };
    }

    if (outcome.kind === 'admitted') {
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
}
