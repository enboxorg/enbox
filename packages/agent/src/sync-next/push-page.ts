import type { EnboxPlatformAgent } from '../types/agent.js';
import type { PushFailure } from '../types/sync.js';
import type { SyncEchoSuppressor } from '../sync-echo-suppressor.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryObligation,
  SyncNextDeliveryOutcome,
  SyncNextSourceReceipt,
} from './types.js';

import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { syncNextLinkIdentity } from './ledger-key.js';
import { assertPageCursorAdvanced, sourceTokenFromFeedEntry } from './feed-entry.js';
import { queryLocalMessageFeed, RemoteApplyPushContext } from '../sync-messages.js';

const PUSH_PAGE_SIZE = 100;

export type SyncNextPushPageResult = { aborted: true } | {
  aborted?: false;
  delivered: number;
  endpointBlock?: SyncNextDeliveryOutcome;
  hasMore: boolean;
  retained: number;
};

export type SyncNextPushPageOptions = {
  endpointBlock?: SyncNextDeliveryOutcome;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
};

export type SyncNextPushPageObserver = {
  onCheckpoint?: (target: SyncTarget, token: ProgressToken) => void;
};

export type SyncNextDeliveryRetryResult = {
  kind: 'aborted' | 'pending' | 'settled';
  outcome?: SyncNextDeliveryOutcome;
};

/** Consumes one local feed page without letting one delivery block its independent tail. */
export class SyncNextPushPage {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _echoSuppressor?: SyncEchoSuppressor,
    private readonly _observer: SyncNextPushPageObserver = {},
  ) {}

  public async consume(
    target: SyncTarget,
    options: SyncNextPushPageOptions = {},
  ): Promise<SyncNextPushPageResult> {
    const shouldContinue = options.shouldContinue ?? ((): boolean => true);
    if (target.authorization.kind === 'role') {
      return { aborted: true };
    }
    const identity = syncNextLinkIdentity(target);
    const link = await this._ledger.getLink(identity);
    if (link === undefined || link.status !== 'active' || !shouldContinue()) {
      return { aborted: true };
    }

    const reply = await this.query(target, link.pushHandledThrough);
    if (!shouldContinue()) {
      return { aborted: true };
    }
    SyncNextPushPage.assertSuccessfulPage(reply, target);
    const handledThrough = reply.cursor;
    if (handledThrough === undefined) {
      throw new Error(
        `SyncNextPushPage: local feed for ${target.did} returned no cursor for a successful page.`,
      );
    }
    assertPageCursorAdvanced(
      link.pushHandledThrough,
      handledThrough,
      reply.drained === true,
      'SyncNextPushPage',
    );

    const context = new RemoteApplyPushContext({
      agent         : this._agent,
      did           : target.did,
      dwnUrl        : target.dwnUrl,
      delegateDid   : target.delegateDid,
      onBeforeApply : (messageCid): void => {
        this._echoSuppressor?.trackPushed(target.did, messageCid, target.dwnUrl);
      },
      permissionGrantIds : target.permissionGrantIds,
      permissionsApi     : this._agent.permissions,
      signal             : options.signal,
    });
    const delivery: SyncNextDeliveryInput[] = [];
    const settled: SyncNextSourceReceipt[] = [];
    let endpointBlock = options.endpointBlock;

    for (const entry of reply.entries ?? []) {
      if (!shouldContinue()) {
        return { aborted: true };
      }
      const source = sourceTokenFromFeedEntry(handledThrough, entry);
      if (this._echoSuppressor?.hasRecentlyPulled(target.did, entry.messageCid, target.dwnUrl) === true) {
        settled.push({ messageCid: entry.messageCid, source });
        continue;
      }
      if (endpointBlock !== undefined || SyncNextPushPage.requiresDeferredStream(entry)) {
        delivery.push({
          messageCid : entry.messageCid,
          outcome    : endpointBlock === undefined
            ? { reason: 'remote-incomplete' }
            : endpointBlock,
          source,
        });
        continue;
      }

      const result = await context.pushFeedEntry(entry, []);
      const failure = result.failed.find(({ cid }): boolean => cid === entry.messageCid);
      if (failure === undefined) {
        settled.push({ messageCid: entry.messageCid, source });
        continue;
      }

      const outcome = SyncNextPushPage.deliveryOutcome(failure);
      delivery.push({ messageCid: entry.messageCid, outcome, source });
      if (outcome.blockScope !== undefined) {
        endpointBlock = outcome;
      }
    }

    const committed = await this._ledger.commitPushPage(identity, {
      delivery,
      handledThrough,
      settled,
    });
    if (!committed) {
      return { aborted: true };
    }
    this._observer.onCheckpoint?.(target, handledThrough);
    return {
      delivered : settled.length,
      ...(endpointBlock === undefined ? {} : { endpointBlock }),
      hasMore   : reply.drained !== true,
      retained  : delivery.length,
    };
  }

  /** Retry one exact outbound obligation from the authoritative local feed. */
  public async retryDelivery(
    target: SyncTarget,
    obligation: SyncNextDeliveryObligation,
    shouldContinue: () => boolean = (): boolean => true,
    signal?: AbortSignal,
  ): Promise<SyncNextDeliveryRetryResult> {
    if (target.authorization.kind === 'role' || !shouldContinue()) {
      return { kind: 'aborted' };
    }
    if (
      obligation.tenantDid !== target.did ||
      obligation.remoteEndpoint !== target.dwnUrl ||
      obligation.projectionId !== target.projectionId ||
      obligation.authorizationEpoch !== target.authorizationEpoch
    ) {
      throw new Error('SyncNextPushPage: target does not own this delivery obligation.');
    }
    const context = new RemoteApplyPushContext({
      agent              : this._agent,
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      permissionsApi     : this._agent.permissions,
      signal,
    });
    const result = await context.push([obligation.messageCid]);
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const failure = result.failed.find(({ cid }): boolean => cid === obligation.messageCid);
    if (failure === undefined) {
      await this._ledger.settleDelivery(obligation, obligation);
      return { kind: 'settled' };
    }

    const outcome = SyncNextPushPage.deliveryOutcome(failure);
    await this._ledger.updateDelivery(obligation, outcome);
    return { kind: 'pending', outcome };
  }

  private query(target: SyncTarget, cursor?: ProgressToken): Promise<MessagesQueryReply> {
    return queryLocalMessageFeed({
      agent              : this._agent,
      cursor,
      delegateDid        : target.delegateDid,
      delegatedGrant     : target.authorDelegatedGrant,
      did                : target.did,
      filters            : messageFeedFiltersForSyncScope(target.scope),
      limit              : PUSH_PAGE_SIZE,
      permissionGrantIds : target.permissionGrantIds,
    });
  }

  private static requiresDeferredStream(entry: MessagesQueryReplyEntry): boolean {
    return entry.message !== undefined &&
      entry.isLatestBaseState &&
      entry.encodedData === undefined &&
      recordsWriteRequiresData(entry.message);
  }

  public static deliveryOutcome(failure: PushFailure): SyncNextDeliveryOutcome {
    const retry = failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter };
    const endpoint = failure.endpointRejected === true ? { blockScope: 'endpoint' as const } : {};
    if (failure.quotaBlocked === true) {
      return { blockScope: 'link', reason: 'quota', ...retry };
    }
    if (failure.tenantInactive === true) {
      return { blockScope: 'link', reason: 'authorization-unresolved', ...retry };
    }
    if (failure.kind === 'Incomplete') {
      return { reason: 'dependency', ...retry };
    }
    if (failure.kind === 'Invalid' || failure.terminal === true) {
      return { reason: 'remote-rejected', ...endpoint, ...retry };
    }
    if (failure.kind === 'Deferred') {
      return { blockScope: 'link', reason: 'remote-incomplete', ...retry };
    }
    return { blockScope: 'endpoint', reason: 'transport', ...retry };
  }

  private static assertSuccessfulPage(reply: MessagesQueryReply, target: SyncTarget): void {
    if (reply.status.code !== 200) {
      throw new Error(
        `SyncNextPushPage: local query failed for ${target.did}: ` +
        `${reply.status.code} ${reply.status.detail}`,
      );
    }
  }

}
