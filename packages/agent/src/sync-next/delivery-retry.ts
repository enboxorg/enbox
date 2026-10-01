import type { EnboxPlatformAgent } from '../types/agent.js';
import type { PushResult } from '../types/sync.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { SyncNextDeliveryObligation, SyncNextDeliveryOutcome, SyncNextLink } from './types.js';

import { RemoteApplyPushContext } from '../sync-messages.js';
import { syncNextDeliveryOutcome } from './delivery-outcome.js';
import { compareSyncNextSparseAttempts, syncNextLinkIdentity } from './ledger-key.js';

export type SyncNextDeliveryRetryResult =
  | { kind: 'aborted' | 'empty' | 'stale' | 'settled' }
  | { kind: 'pending'; outcome: SyncNextDeliveryOutcome };

/** Retry one exact endpoint obligation without owning its schedule. */
export async function retryOneDeliveryObligation({
  agent,
  ledger,
  target,
  shouldContinue = (): boolean => true,
}: {
  agent: EnboxPlatformAgent;
  ledger: SyncNextLedgerStore;
  target: SyncTarget;
  shouldContinue?: () => boolean;
}): Promise<SyncNextDeliveryRetryResult> {
  if (target.authorization.kind === 'role') {
    throw new Error('SyncNextDeliveryRetry: role-authorized targets are pull-only.');
  }
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }

  const link = await ledger.getLink(syncNextLinkIdentity(target));
  if (link === undefined) {
    return { kind: 'stale' };
  }
  const entries = await ledger.getDeliveryForLink(link);
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }
  entries.sort(compareSyncNextSparseAttempts);
  const selected = entries[0];
  if (selected === undefined) {
    return { kind: 'empty' };
  }

  const context = new RemoteApplyPushContext({
    agent,
    did                : target.did,
    dwnUrl             : target.dwnUrl,
    delegateDid        : target.delegateDid,
    permissionGrantIds : target.permissionGrantIds,
    permissionsApi     : agent.permissions,
  });
  let result: PushResult;
  try {
    if (typeof selected.wasLatestBaseState !== 'boolean') {
      throw new TypeError('SyncNextDeliveryRetry: retained source state is missing.');
    }
    result = await context.pushRetainedRoot(selected.messageCid, selected.wasLatestBaseState);
  } catch (error: unknown) {
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    if (!await ledger.finishDeliveryAttempt(link, selected, selected.outcome)) {
      return { kind: 'stale' };
    }
    throw error;
  }
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }

  return finishDeliveryResult(ledger, link, selected, result);
}

async function finishDeliveryResult(
  ledger: SyncNextLedgerStore,
  link: SyncNextLink,
  selected: SyncNextDeliveryObligation,
  result: PushResult,
): Promise<SyncNextDeliveryRetryResult> {
  if (result.succeeded.includes(selected.messageCid)) {
    return await ledger.finishDeliveryAttempt(link, selected)
      ? { kind: 'settled' }
      : { kind: 'stale' };
  }

  const failure = result.failed.find(candidate => candidate.cid === selected.messageCid);
  if (failure === undefined) {
    throw new Error(`SyncNextDeliveryRetry: push returned no disposition for ${selected.messageCid}.`);
  }
  const outcome = syncNextDeliveryOutcome(failure);
  return await ledger.finishDeliveryAttempt(link, selected, outcome)
    ? { kind: 'pending', outcome }
    : { kind: 'stale' };
}
