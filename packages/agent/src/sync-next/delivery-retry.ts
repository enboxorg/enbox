import type { EnboxPlatformAgent } from '../types/agent.js';
import type { PushResult } from '../types/sync.js';
import type { SyncNextProgressStore } from './progress-store.js';
import type { SyncRemoteRequestRunner } from '../sync-request-runner.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { SyncNextDeliveryObligation, SyncNextDeliveryOutcome, SyncNextLink } from './types.js';

import { RemoteApplyPushContext } from '../sync-messages.js';
import { syncNextDeliveryOutcome } from './delivery-outcome.js';
import { compareSyncNextRetryOrder, syncNextLinkIdentity } from './progress-key.js';

export type SyncNextDeliveryRetryResult =
  | { kind: 'aborted' | 'empty' | 'stale' | 'settled' }
  | { kind: 'pending'; outcome: SyncNextDeliveryOutcome };

/** Retry one exact endpoint obligation without owning its schedule. */
export async function retryOneDeliveryObligation({
  agent,
  progressStore,
  target,
  runRemoteRequest,
  shouldContinue = (): boolean => true,
}: {
  agent: EnboxPlatformAgent;
  progressStore: SyncNextProgressStore;
  target: SyncTarget;
  runRemoteRequest?: SyncRemoteRequestRunner;
  shouldContinue?: () => boolean;
}): Promise<SyncNextDeliveryRetryResult> {
  if (target.authorization.kind === 'role') {
    throw new Error('SyncNextDeliveryRetry: role-authorized targets are pull-only.');
  }
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }

  const link = await progressStore.getLink(syncNextLinkIdentity(target));
  if (link === undefined) {
    return { kind: 'stale' };
  }
  const entries = await progressStore.getDeliveryForLink(link);
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }
  entries.sort(compareSyncNextRetryOrder);
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
    runRemoteRequest,
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
    if (!await progressStore.finishDeliveryAttempt(link, selected, selected.outcome)) {
      return { kind: 'stale' };
    }
    throw error;
  }
  if (!shouldContinue()) {
    return { kind: 'aborted' };
  }

  return finishDeliveryResult(progressStore, link, selected, result);
}

async function finishDeliveryResult(
  progressStore: SyncNextProgressStore,
  link: SyncNextLink,
  selected: SyncNextDeliveryObligation,
  result: PushResult,
): Promise<SyncNextDeliveryRetryResult> {
  if (result.succeeded.includes(selected.messageCid)) {
    return await progressStore.finishDeliveryAttempt(link, selected)
      ? { kind: 'settled' }
      : { kind: 'stale' };
  }

  const failure = result.failed.find(candidate => candidate.cid === selected.messageCid);
  if (failure === undefined) {
    throw new Error(`SyncNextDeliveryRetry: push returned no disposition for ${selected.messageCid}.`);
  }
  const outcome = syncNextDeliveryOutcome(failure);
  return await progressStore.finishDeliveryAttempt(link, selected, outcome)
    ? { kind: 'pending', outcome }
    : { kind: 'stale' };
}
