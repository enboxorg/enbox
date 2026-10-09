import type { EnboxPlatformAgent } from '../types/agent.js';
import type { PushResult } from '../types/sync.js';
import type { SyncNextPreparedFeedEntry } from './feed-page.js';
import type { SyncNextProgressStore } from './progress-store.js';
import type { SyncRemoteRequestRunner } from '../sync-request-runner.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { GenericMessage, MessagesQueryReply, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryOutcome,
  SyncNextHandledWrite,
  SyncNextSourceReceipt,
} from './types.js';

import { Records } from '@enbox/dwn-sdk-js';

import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { syncNextDeliveryOutcome } from './delivery-outcome.js';
import { prepareSyncNextFeedPage, sliceSyncNextFeedPage, SYNC_NEXT_PAGE_SIZE } from './feed-page.js';
import { queryLocalMessageFeed, RemoteApplyPushContext, SyncWorkInterruptedError } from '../sync-messages.js';
import { syncNextLinkIdentity, syncNextSourceAtOrBefore } from './progress-key.js';

type ClassifiedPushPage = {
  acknowledged: number;
  blocked?: SyncNextDeliveryOutcome;
  delivery: SyncNextDeliveryInput[];
  entryCount: number;
  handledWrites: SyncNextHandledWrite[];
  settled: SyncNextSourceReceipt[];
};

export type SyncNextPushPageResult =
  | { kind: 'aborted' | 'stale' }
  | {
      kind: 'committed';
      acknowledged: number;
      checkpoint: ProgressToken;
      feedDrained: boolean;
      retained: number;
      /** Link/endpoint-wide outcome that stopped further requests in this page. */
      blocked?: SyncNextDeliveryOutcome;
    };

/** Queries, delivers, and commits exactly one local feed page for one endpoint. */
export class SyncNextPushPage {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _progressStore: SyncNextProgressStore,
    private readonly _runRemoteRequest?: SyncRemoteRequestRunner,
  ) {}

  public async run(
    target: SyncTarget,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<SyncNextPushPageResult> {
    if (target.authorization.kind === 'role') {
      throw new Error('SyncNextPushPage: role-authorized targets are pull-only.');
    }
    const link = await this._progressStore.getLink(syncNextLinkIdentity(target));
    if (link === undefined) {
      return { kind: 'stale' };
    }
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }

    const reply = await this.query(target, link.pushCheckpoint);
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const page = await prepareSyncNextFeedPage({
      label    : 'SyncNextPushPage',
      previous : link.pushCheckpoint,
      reply,
      target   : `local query for ${target.did} -> ${target.dwnUrl}`,
    });
    const classified = await this.classifyPage(target, page.entries, shouldContinue);
    if (classified === undefined || !shouldContinue()) {
      return { kind: 'aborted' };
    }
    const handledPage = sliceSyncNextFeedPage(page, classified.entryCount);
    if (handledPage === undefined) {
      return { kind: 'aborted' };
    }

    const committed = await this._progressStore.commitPushPage(link, {
      checkpoint    : handledPage.checkpoint,
      delivery      : classified.delivery,
      handledWrites : classified.handledWrites,
      pageReceipts  : handledPage.pageReceipts,
      settled       : classified.settled,
    });
    if (!committed) {
      return { kind: 'stale' };
    }

    return {
      ...(classified.blocked === undefined ? {} : { blocked: classified.blocked }),
      acknowledged : classified.acknowledged,
      checkpoint   : handledPage.checkpoint,
      feedDrained  : handledPage.drained,
      kind         : 'committed',
      retained     : classified.delivery.length,
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
      runRemoteRequest   : this._runRemoteRequest,
    });
    const delivery: SyncNextDeliveryInput[] = [];
    const handledWrites = new Map<string, SyncNextHandledWrite>();
    const settled: SyncNextSourceReceipt[] = [];
    let blocked: SyncNextDeliveryOutcome | undefined;
    let entryCount = 0;

    for (const prepared of entries) {
      const { entry } = prepared;
      if (!shouldContinue()) {
        return undefined;
      }
      if (blocked !== undefined) {
        delivery.push(deliveryInput(prepared, blocked));
        entryCount++;
        continue;
      }

      const result = await SyncNextPushPage.pushWithinBudget(context, entry);
      if (result === undefined) {
        return shouldContinue()
          ? finishClassifiedPushPage(blocked, delivery, handledWrites, settled, entryCount)
          : undefined;
      }
      if (!shouldContinue()) {
        return undefined;
      }
      blocked = SyncNextPushPage.recordDisposition(prepared, result, delivery, handledWrites, settled);
      entryCount++;
    }

    return finishClassifiedPushPage(blocked, delivery, handledWrites, settled, entryCount);
  }

  private static async pushWithinBudget(
    context: RemoteApplyPushContext,
    entry: SyncNextPreparedFeedEntry['entry'],
  ): Promise<PushResult | undefined> {
    try {
      return await context.pushFeedEntry(entry, []);
    } catch (error: unknown) {
      if (error instanceof SyncWorkInterruptedError) {
        return undefined;
      }
      throw error;
    }
  }

  private static recordDisposition(
    prepared: SyncNextPreparedFeedEntry,
    result: PushResult,
    delivery: SyncNextDeliveryInput[],
    handledWrites: Map<string, SyncNextHandledWrite>,
    settled: SyncNextSourceReceipt[],
  ): SyncNextDeliveryOutcome | undefined {
    if (result.succeeded.includes(prepared.entry.messageCid)) {
      settled.push(prepared.receipt);
      rememberHandledWrite(handledWrites, prepared);
      return undefined;
    }
    const failure = result.failed.find(candidate => candidate.cid === prepared.entry.messageCid);
    if (failure === undefined) {
      throw new Error(`SyncNextPushPage: push returned no disposition for ${prepared.entry.messageCid}.`);
    }
    const outcome = syncNextDeliveryOutcome(failure);
    delivery.push(deliveryInput(prepared, outcome));
    return outcome.blockScope === undefined ? undefined : outcome;
  }

}

function finishClassifiedPushPage(
  blocked: SyncNextDeliveryOutcome | undefined,
  delivery: SyncNextDeliveryInput[],
  handledWrites: Map<string, SyncNextHandledWrite>,
  settled: SyncNextSourceReceipt[],
  entryCount: number,
): ClassifiedPushPage {
  const partitioned = partitionCoveredDelivery(delivery, handledWrites);
  const acknowledged = settled.length;
  settled.push(...partitioned.covered);

  return {
    ...(blocked === undefined ? {} : { blocked }),
    acknowledged,
    delivery      : partitioned.pending,
    entryCount,
    handledWrites : [...handledWrites.values()],
    settled,
  };
}

function deliveryInput(
  prepared: SyncNextPreparedFeedEntry,
  outcome: SyncNextDeliveryOutcome,
): SyncNextDeliveryInput {
  const writeRecordId = recordIdForRecordsWrite(prepared.message);
  return {
    ...prepared.receipt,
    outcome,
    ...(writeRecordId === undefined ? {} : { writeRecordId }),
    wasLatestBaseState: prepared.entry.isLatestBaseState,
  };
}

function rememberHandledWrite(
  handledWrites: Map<string, SyncNextHandledWrite>,
  prepared: SyncNextPreparedFeedEntry,
): void {
  const recordId = prepared.entry.isLatestBaseState
    ? recordIdForRecordsWrite(prepared.message)
    : undefined;
  if (recordId === undefined) {
    return;
  }
  const previous = handledWrites.get(recordId);
  if (previous === undefined || syncNextSourceAtOrBefore(previous.receipt.source, prepared.receipt.source)) {
    handledWrites.set(recordId, { recordId, receipt: prepared.receipt });
  }
}

function recordIdForRecordsWrite(message: GenericMessage): string | undefined {
  return Records.isRecordsWrite(message) ? message.recordId : undefined;
}

function partitionCoveredDelivery(
  delivery: SyncNextDeliveryInput[],
  handledWrites: ReadonlyMap<string, SyncNextHandledWrite>,
): { covered: SyncNextSourceReceipt[]; pending: SyncNextDeliveryInput[] } {
  const covered: SyncNextSourceReceipt[] = [];
  const pending: SyncNextDeliveryInput[] = [];
  for (const input of delivery) {
    const handled = input.writeRecordId === undefined ? undefined : handledWrites.get(input.writeRecordId);
    if (handled !== undefined && syncNextSourceAtOrBefore(input.source, handled.receipt.source)) {
      covered.push(input);
    } else {
      pending.push(input);
    }
  }
  return { covered, pending };
}
