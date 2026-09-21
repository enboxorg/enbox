import type { EnboxPlatformAgent } from '../types/agent.js';
import type { PushFailure } from '../types/sync.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryOutcome,
  SyncNextLinkIdentity,
  SyncNextSettledSource,
} from './types.js';

import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { sourceTokenFromFeedEntry } from './feed-entry.js';
import { queryLocalMessageFeed, RemoteApplyPushContext } from '../sync-messages.js';

const PUSH_PAGE_SIZE = 100;

export type SyncNextPushPageResult = {
  aborted?: true;
  capturedHead?: ProgressToken;
  delivered: number;
  handledThrough?: ProgressToken;
  hasMore: boolean;
  retained: number;
};

export type SyncNextPushPageOptions = {
  head?: ProgressToken;
  shouldContinue?: () => boolean;
};

/** Consumes one local feed page without letting one delivery block its independent tail. */
export class SyncNextPushPage {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
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

    const context = new RemoteApplyPushContext({
      agent              : this._agent,
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      permissionGrantIds : target.permissionGrantIds,
      permissionsApi     : this._agent.permissions,
    });
    const delivery: SyncNextDeliveryInput[] = [];
    const settled: SyncNextSettledSource[] = [];
    let endpointBlock: SyncNextDeliveryOutcome | undefined;

    for (const entry of reply.entries ?? []) {
      if (!shouldContinue()) {
        return { aborted: true, delivered: 0, hasMore: false, retained: 0 };
      }
      const source = sourceTokenFromFeedEntry(handledThrough, entry);
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
      if (SyncNextPushPage.blocksPageEndpoint(outcome)) {
        endpointBlock = outcome;
      }
    }

    const committed = await this._ledger.commitPushPage(identity, {
      delivery,
      handledThrough,
      settled,
      terminal: [],
    });
    if (!committed || !shouldContinue()) {
      return { aborted: true, delivered: 0, hasMore: false, retained: 0 };
    }
    return {
      capturedHead : reply.head ?? options.head,
      delivered    : settled.length,
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
    if (failure.quotaBlocked === true) {
      return { detail: failure.detail, reason: 'quota' };
    }
    if (failure.tenantInactive === true) {
      return { detail: failure.detail, reason: 'authorization-unresolved' };
    }
    if (failure.kind === 'Incomplete') {
      return { detail: failure.detail, reason: 'dependency' };
    }
    if (failure.kind === 'Invalid' || failure.terminal === true) {
      return { detail: failure.detail, reason: 'remote-rejected' };
    }
    if (failure.kind === 'Deferred') {
      return { detail: failure.detail, reason: 'remote-incomplete' };
    }
    return { detail: failure.detail, reason: 'transport' };
  }

  private static blocksPageEndpoint(outcome: SyncNextDeliveryOutcome): boolean {
    return outcome.reason === 'authorization-unresolved' ||
      outcome.reason === 'quota' ||
      outcome.reason === 'transport';
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
    if (actual === undefined || expected === undefined) {
      return;
    }
    if (
      actual.streamId !== expected.streamId ||
      actual.epoch !== expected.epoch ||
      actual.position !== expected.position
    ) {
      throw new Error('SyncNextPushPage: local feed changed the captured query head.');
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
