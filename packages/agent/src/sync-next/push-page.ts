import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextPreparedFeedEntry } from './feed-page.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryOutcome,
  SyncNextHandledRecord,
  SyncNextSourceReceipt,
} from './types.js';

import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { syncNextDeliveryOutcome } from './delivery-outcome.js';
import { prepareSyncNextFeedPage, SYNC_NEXT_PAGE_SIZE } from './feed-page.js';
import { queryLocalMessageFeed, recordIdForRecordsMessage, RemoteApplyPushContext } from '../sync-messages.js';
import { syncNextLinkIdentity, syncNextSourceAtOrBefore } from './ledger-key.js';

type ClassifiedPushPage = {
  acknowledged: number;
  blocked?: SyncNextDeliveryOutcome;
  delivery: SyncNextDeliveryInput[];
  handledRecords: SyncNextHandledRecord[];
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
      handledRecords : classified.handledRecords,
      pageReceipts   : page.pageReceipts,
      settled        : classified.settled,
    });
    if (!committed) {
      return { kind: 'stale' };
    }

    return {
      ...(classified.blocked === undefined ? {} : { blocked: classified.blocked }),
      acknowledged   : classified.acknowledged,
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
    const handledRecords = new Map<string, SyncNextHandledRecord>();
    const settled: SyncNextSourceReceipt[] = [];
    let blocked: SyncNextDeliveryOutcome | undefined;

    for (const prepared of entries) {
      const { entry, receipt } = prepared;
      if (!shouldContinue()) {
        return undefined;
      }
      if (blocked !== undefined) {
        delivery.push(deliveryInput(prepared, blocked));
        continue;
      }

      const result = await context.pushFeedEntry(entry, []);
      if (!shouldContinue()) {
        return undefined;
      }
      if (result.succeeded.includes(entry.messageCid)) {
        settled.push(receipt);
        rememberHandledRecord(handledRecords, prepared);
        continue;
      }

      const failure = result.failed.find(candidate => candidate.cid === entry.messageCid);
      if (failure === undefined) {
        throw new Error(`SyncNextPushPage: push returned no disposition for ${entry.messageCid}.`);
      }
      const outcome = syncNextDeliveryOutcome(failure);
      delivery.push(deliveryInput(prepared, outcome));
      if (outcome.blockScope !== undefined) {
        blocked = outcome;
      }
    }

    const partitioned = partitionCoveredDelivery(delivery, handledRecords);
    const acknowledged = settled.length;
    settled.push(...partitioned.covered);

    return {
      ...(blocked === undefined ? {} : { blocked }),
      acknowledged,
      delivery       : partitioned.pending,
      handledRecords : [...handledRecords.values()],
      settled,
    };
  }

}

function deliveryInput(
  prepared: SyncNextPreparedFeedEntry,
  outcome: SyncNextDeliveryOutcome,
): SyncNextDeliveryInput {
  const recordId = recordIdForRecordsMessage(prepared.message);
  return {
    ...prepared.receipt,
    outcome,
    ...(recordId === undefined ? {} : { recordId }),
    wasLatestBaseState: prepared.entry.isLatestBaseState,
  };
}

function rememberHandledRecord(
  handledRecords: Map<string, SyncNextHandledRecord>,
  prepared: SyncNextPreparedFeedEntry,
): void {
  const recordId = prepared.entry.isLatestBaseState
    ? recordIdForRecordsMessage(prepared.message)
    : undefined;
  if (recordId === undefined) {
    return;
  }
  const previous = handledRecords.get(recordId);
  if (previous === undefined || syncNextSourceAtOrBefore(previous.receipt.source, prepared.receipt.source)) {
    handledRecords.set(recordId, { recordId, receipt: prepared.receipt });
  }
}

function partitionCoveredDelivery(
  delivery: SyncNextDeliveryInput[],
  handledRecords: ReadonlyMap<string, SyncNextHandledRecord>,
): { covered: SyncNextSourceReceipt[]; pending: SyncNextDeliveryInput[] } {
  const covered: SyncNextSourceReceipt[] = [];
  const pending: SyncNextDeliveryInput[] = [];
  for (const input of delivery) {
    const handled = input.recordId === undefined ? undefined : handledRecords.get(input.recordId);
    if (handled !== undefined && syncNextSourceAtOrBefore(input.source, handled.receipt.source)) {
      covered.push(input);
    } else {
      pending.push(input);
    }
  }
  return { covered, pending };
}
