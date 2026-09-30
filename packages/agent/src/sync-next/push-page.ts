import type { EnboxPlatformAgent } from '../types/agent.js';
import type { PushFailure } from '../types/sync.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextPreparedFeedEntry } from './feed-page.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryOutcome,
  SyncNextSourceReceipt,
} from './types.js';

import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { syncNextLinkIdentity } from './ledger-key.js';
import { prepareSyncNextFeedPage, SYNC_NEXT_PAGE_SIZE } from './feed-page.js';
import { queryLocalMessageFeed, RemoteApplyPushContext } from '../sync-messages.js';

type ClassifiedPushPage = {
  blocked?: SyncNextDeliveryOutcome;
  delivery: SyncNextDeliveryInput[];
  settled: SyncNextSourceReceipt[];
};

export type SyncNextPushPageResult =
  | { kind: 'aborted' | 'stale' }
  | {
      kind: 'committed';
      acknowledged: number;
      handledThrough: ProgressToken;
      hasMore: boolean;
      retained: number;
      /** Link/endpoint-wide outcome that stopped further requests in this page. */
      blocked?: SyncNextDeliveryOutcome;
    };

/** Queries, delivers, and commits exactly one local feed page for one endpoint. */
export class SyncNextPushPage {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
  ) {}

  public async consume(
    target: SyncTarget,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<SyncNextPushPageResult> {
    if (target.authorization.kind === 'role') {
      throw new Error('SyncNextPushPage: role-authorized targets are pull-only.');
    }
    const link = await this._ledger.getLink(syncNextLinkIdentity(target));
    if (link === undefined) {
      return { kind: 'stale' };
    }
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }

    const reply = await this.query(target, link.pushHandledThrough);
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const page = await prepareSyncNextFeedPage({
      label    : 'SyncNextPushPage',
      previous : link.pushHandledThrough,
      reply,
      target   : `local query for ${target.did} -> ${target.dwnUrl}`,
    });
    const classified = await this.classifyPage(target, page.entries, shouldContinue);
    if (classified === undefined || !shouldContinue()) {
      return { kind: 'aborted' };
    }

    const committed = await this._ledger.commitPushPage(link, {
      delivery       : classified.delivery,
      handledThrough : page.handledThrough,
      pageReceipts   : page.pageReceipts,
      settled        : classified.settled,
    });
    if (!committed) {
      return { kind: 'stale' };
    }

    return {
      ...(classified.blocked === undefined ? {} : { blocked: classified.blocked }),
      acknowledged   : classified.settled.length,
      handledThrough : page.handledThrough,
      hasMore        : !page.drained,
      kind           : 'committed',
      retained       : classified.delivery.length,
    };
  }

  private query(target: SyncTarget, cursor?: ProgressToken): Promise<MessagesQueryReply> {
    return queryLocalMessageFeed({
      agent              : this._agent,
      cursor,
      delegateDid        : target.delegateDid,
      delegatedGrant     : target.authorDelegatedGrant,
      did                : target.did,
      filters            : messageFeedFiltersForSyncScope(target.scope),
      limit              : SYNC_NEXT_PAGE_SIZE,
      permissionGrantIds : target.permissionGrantIds,
    });
  }

  private async classifyPage(
    target: SyncTarget,
    entries: SyncNextPreparedFeedEntry[],
    shouldContinue: () => boolean,
  ): Promise<ClassifiedPushPage | undefined> {
    const context = new RemoteApplyPushContext({
      agent              : this._agent,
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      permissionsApi     : this._agent.permissions,
    });
    const delivery: SyncNextDeliveryInput[] = [];
    const settled: SyncNextSourceReceipt[] = [];
    let blocked: SyncNextDeliveryOutcome | undefined;

    for (const { entry, receipt } of entries) {
      if (!shouldContinue()) {
        return undefined;
      }
      if (blocked !== undefined) {
        delivery.push({ ...receipt, outcome: blocked });
        continue;
      }

      const result = await context.pushFeedEntry(entry, []);
      if (!shouldContinue()) {
        return undefined;
      }
      if (result.succeeded.includes(entry.messageCid)) {
        settled.push(receipt);
        continue;
      }

      const failure = result.failed.find(candidate => candidate.cid === entry.messageCid);
      if (failure === undefined) {
        throw new Error(`SyncNextPushPage: push returned no disposition for ${entry.messageCid}.`);
      }
      const outcome = SyncNextPushPage.deliveryOutcome(failure);
      delivery.push({ ...receipt, outcome });
      if (outcome.blockScope !== undefined) {
        blocked = outcome;
      }
    }

    return {
      ...(blocked === undefined ? {} : { blocked }),
      delivery,
      settled,
    };
  }

  private static deliveryOutcome(failure: PushFailure): SyncNextDeliveryOutcome {
    if (failure.quotaBlocked === true) {
      return { blockScope: 'link', reason: 'quota' };
    }
    if (failure.tenantInactive === true) {
      return { blockScope: 'link', reason: 'authorization-unresolved' };
    }
    if (failure.kind === 'Invalid' || failure.terminal === true) {
      return { reason: 'remote-rejected' };
    }
    if (failure.localStatusCode === 401 || failure.localStatusCode === 403) {
      return { blockScope: 'link', reason: 'authorization-unresolved' };
    }
    const localStatusCode = failure.localStatusCode;
    if (localStatusCode !== undefined && (localStatusCode === 408 || localStatusCode === 429 || localStatusCode >= 500)) {
      return { blockScope: 'link', reason: 'transport' };
    }
    if (failure.localDataUnavailable === true) {
      return { reason: 'dependency' };
    }
    if (failure.localMissing === true || failure.localStatusCode !== undefined || failure.kind === 'Incomplete') {
      return { reason: 'dependency' };
    }
    if (failure.reason === 'record-data-unavailable') {
      return { reason: 'remote-incomplete' };
    }
    if (failure.kind === 'Deferred') {
      return { blockScope: 'link', reason: 'remote-incomplete' };
    }
    return { blockScope: 'endpoint', reason: 'transport' };
  }
}
