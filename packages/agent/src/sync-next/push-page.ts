import type { EnboxPlatformAgent } from '../types/agent.js';
import type { PushFailure } from '../types/sync.js';
import type { SyncEchoSuppressor } from '../sync-echo-suppressor.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryOutcome,
  SyncNextLinkIdentity,
  SyncNextSettledSource,
} from './types.js';

import { compareSyncNextPosition } from './ledger-key.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { sourceTokenFromFeedEntry } from './feed-entry.js';
import { queryLocalMessageFeed, RemoteApplyPushContext } from '../sync-messages.js';

const PUSH_PAGE_SIZE = 100;

export type SyncNextPushPageResult = {
  aborted?: true;
  capturedHead?: ProgressToken;
  delivered: number;
  endpointBlock?: SyncNextDeliveryOutcome;
  handledThrough?: ProgressToken;
  hasMore: boolean;
  retained: number;
};

export type SyncNextPushPageOptions = {
  endpointBlock?: SyncNextDeliveryOutcome;
  head?: ProgressToken;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
};

export type SyncNextPushPageObserver = {
  onCheckpoint?: (target: SyncTarget, token: ProgressToken) => void;
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
      return { aborted: true, delivered: 0, hasMore: false, retained: 0 };
    }
    const identity = SyncNextPushPage.identity(target);
    const link = await this._ledger.getLink(identity);
    if (link === undefined || link.status !== 'active' || !shouldContinue()) {
      return { aborted: true, delivered: 0, hasMore: false, retained: 0 };
    }

    const reply = await this.query(target, link.pushHandledThrough, options.head);
    if (!shouldContinue()) {
      return { aborted: true, delivered: 0, hasMore: false, retained: 0 };
    }
    SyncNextPushPage.assertSuccessfulPage(reply, target);
    SyncNextPushPage.assertHead(reply.head, options.head);
    const handledThrough = reply.cursor;
    if (handledThrough === undefined) {
      throw new Error(
        `SyncNextPushPage: local feed for ${target.did} returned no cursor for a successful page.`,
      );
    }
    SyncNextPushPage.assertCursorAdvanced(link.pushHandledThrough, handledThrough, reply.drained === true);
    SyncNextPushPage.assertCursorWithinHead(handledThrough, reply.head ?? options.head);

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
    const settled: SyncNextSettledSource[] = [];
    let endpointBlock = options.endpointBlock;

    for (const entry of reply.entries ?? []) {
      if (!shouldContinue()) {
        return { aborted: true, delivered: 0, hasMore: false, retained: 0 };
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
            ? {
              detail : 'non-inline payload is delivered outside page intake',
              reason : 'remote-incomplete',
            }
            : {
              ...endpointBlock,
              detail: `endpoint blocked after an earlier page delivery: ${endpointBlock.detail ?? endpointBlock.reason}`,
            },
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
      if (SyncNextPushPage.blocksPageEndpoint(outcome, failure.endpointRejected === true)) {
        endpointBlock = outcome;
      }
    }

    const committed = await this._ledger.commitPushPage(identity, {
      delivery,
      handledThrough,
      settled,
    });
    if (!committed) {
      return { aborted: true, delivered: 0, hasMore: false, retained: 0 };
    }
    this._observer.onCheckpoint?.(target, handledThrough);
    return {
      capturedHead : reply.head ?? options.head,
      delivered    : settled.length,
      ...(endpointBlock === undefined ? {} : { endpointBlock }),
      handledThrough,
      hasMore      : reply.drained !== true,
      retained     : delivery.length,
    };
  }

  private query(
    target: SyncTarget,
    cursor?: ProgressToken,
    head?: ProgressToken,
  ): Promise<MessagesQueryReply> {
    return queryLocalMessageFeed({
      agent              : this._agent,
      cursor,
      delegateDid        : target.delegateDid,
      delegatedGrant     : target.authorDelegatedGrant,
      did                : target.did,
      filters            : messageFeedFiltersForSyncScope(target.scope),
      head,
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
      return { blockScope: 'link', detail: failure.detail, reason: 'quota', ...retry };
    }
    if (failure.tenantInactive === true) {
      return { blockScope: 'link', detail: failure.detail, reason: 'authorization-unresolved', ...retry };
    }
    if (failure.kind === 'Incomplete') {
      return { detail: failure.detail, reason: 'dependency', ...retry };
    }
    if (failure.kind === 'Invalid' || failure.terminal === true) {
      return { detail: failure.detail, reason: 'remote-rejected', ...endpoint, ...retry };
    }
    if (failure.kind === 'Deferred') {
      return { blockScope: 'link', detail: failure.detail, reason: 'remote-incomplete', ...retry };
    }
    return { blockScope: 'endpoint', detail: failure.detail, reason: 'transport', ...retry };
  }

  private static blocksPageEndpoint(outcome: SyncNextDeliveryOutcome, endpointRejected = false): boolean {
    return endpointRejected || outcome.blockScope !== undefined;
  }

  private static assertSuccessfulPage(reply: MessagesQueryReply, target: SyncTarget): void {
    if (reply.status.code !== 200) {
      throw new Error(
        `SyncNextPushPage: local query failed for ${target.did}: ` +
        `${reply.status.code} ${reply.status.detail}`,
      );
    }
  }

  private static assertHead(actual: ProgressToken | undefined, expected: ProgressToken | undefined): void {
    if (expected === undefined) {
      return;
    }
    if (actual === undefined) {
      throw new Error('SyncNextPushPage: local feed omitted the requested captured query head.');
    }
    if (
      actual.streamId !== expected.streamId ||
      actual.epoch !== expected.epoch ||
      actual.position !== expected.position
    ) {
      throw new Error('SyncNextPushPage: local feed changed the captured query head.');
    }
  }

  private static assertCursorWithinHead(cursor: ProgressToken, head: ProgressToken | undefined): void {
    if (head === undefined) {
      return;
    }
    if (
      cursor.streamId !== head.streamId ||
      cursor.epoch !== head.epoch ||
      compareSyncNextPosition(cursor, head) > 0
    ) {
      throw new Error('SyncNextPushPage: local cursor exceeded the captured query head.');
    }
  }

  private static assertCursorAdvanced(
    previous: ProgressToken | undefined,
    next: ProgressToken,
    drained: boolean,
  ): void {
    if (
      previous !== undefined &&
      previous.streamId === next.streamId &&
      previous.epoch === next.epoch &&
      compareSyncNextPosition(next, previous) === 0 &&
      !drained
    ) {
      throw new Error('SyncNextPushPage: non-drained query cursor did not advance.');
    }
  }

  private static identity(target: SyncTarget): SyncNextLinkIdentity {
    return {
      authorizationEpoch : target.authorizationEpoch,
      projectionId       : target.projectionId,
      remoteEndpoint     : target.dwnUrl,
      tenantDid          : target.did,
    };
  }
}
