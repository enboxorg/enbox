import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, ProgressToken } from '@enbox/dwn-sdk-js';
import type {
  SyncNextLinkIdentity,
  SyncNextQuarantineInput,
  SyncNextQuarantineReason,
  SyncNextSettledSource,
} from './types.js';

import { admitClosure } from '../sync-admit-closure.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { queryRemoteMessageFeed } from '../sync-messages.js';
import { sealSyncNextQuarantinePayload } from './quarantine-codec.js';
import { sourceTokenFromFeedEntry, syncEntriesFromFeedEntries } from './feed-entry.js';

const PULL_PAGE_SIZE = 100;

export type SyncNextPullPageResult = {
  aborted?: true;
  capturedHead?: ProgressToken;
  handledThrough?: ProgressToken;
  hasMore: boolean;
  materializedCids: string[];
  quarantined: number;
};

export type SyncNextPullPageOptions = {
  head?: ProgressToken;
  shouldContinue?: () => boolean;
};

/** Consumes exactly one remote feed page through normal local DWN admission. */
export class SyncNextPullPage {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
  ) {}

  public async consume(
    target: SyncTarget,
    options: SyncNextPullPageOptions = {},
  ): Promise<SyncNextPullPageResult> {
    const shouldContinue = options.shouldContinue ?? ((): boolean => true);
    const identity = SyncNextPullPage.identity(target);
    const link = await this._ledger.getLink(identity);
    if (link === undefined || link.status !== 'active' || !shouldContinue()) {
      return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
    }

    const reply = await this.query(target, link.pullHandledThrough, options.head);
    if (!shouldContinue()) {
      return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
    }
    SyncNextPullPage.assertSuccessfulPage(reply, target);
    SyncNextPullPage.assertHead(reply.head, options.head);

    const handledThrough = reply.cursor;
    if (handledThrough === undefined) {
      throw new Error(
        `SyncNextPullPage: ${target.did} -> ${target.dwnUrl} returned no cursor for a successful page.`,
      );
    }
    const entries = reply.entries ?? [];
    const prefetched = syncEntriesFromFeedEntries(entries);
    const quarantine: SyncNextQuarantineInput[] = [];
    const settled: SyncNextSettledSource[] = [];
    const materializedCids = new Set<string>();

    for (const entry of entries) {
      if (!shouldContinue()) {
        return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
      }
      if (entry.message === undefined) {
        throw new Error(`SyncNextPullPage: feed entry ${entry.messageCid} omitted its signed message.`);
      }
      const source = sourceTokenFromFeedEntry(handledThrough, entry);
      const outcome = await admitClosure(entry.messageCid, {
        agent              : this._agent,
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        prefetched,
        remoteHydration    : 'defer',
        scope              : target.scope,
        shouldContinue,
      });
      if (!shouldContinue()) {
        return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
      }

      if (outcome.kind === 'admitted') {
        settled.push({ messageCid: entry.messageCid, source });
        for (const messageCid of outcome.appliedCids) {
          materializedCids.add(messageCid);
        }
        continue;
      }

      const encryptedPayload = await sealSyncNextQuarantinePayload(this._agent.vault, {
        identity,
        messageCid: entry.messageCid,
        source,
      }, {
        entry,
        support: [],
      });
      quarantine.push({
        encryptedPayload,
        messageCid : entry.messageCid,
        outcome    : {
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          ...(outcome.kind === 'deferred' && outcome.missing !== undefined
            ? { missingReferences: outcome.missing }
            : {}),
          reason: SyncNextPullPage.quarantineReason(outcome),
        },
        source,
      });
    }

    const committed = await this._ledger.commitPullPage(identity, {
      handledThrough,
      quarantine,
      settled,
      terminal: [],
    });
    if (!committed || !shouldContinue()) {
      return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
    }

    return {
      capturedHead     : reply.head ?? options.head,
      handledThrough,
      hasMore          : reply.drained !== true,
      materializedCids : [...materializedCids],
      quarantined      : quarantine.length,
    };
  }

  private query(
    target: SyncTarget,
    cursor?: ProgressToken,
    head?: ProgressToken,
  ): Promise<MessagesQueryReply> {
    const role = target.authorization.kind === 'role' ? target.authorization : undefined;
    return queryRemoteMessageFeed({
      agent              : this._agent,
      authorDid          : role?.actorDid,
      cursor,
      delegateDid        : target.delegateDid,
      delegatedGrant     : target.authorDelegatedGrant,
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      filters            : messageFeedFiltersForSyncScope(target.scope),
      head,
      limit              : PULL_PAGE_SIZE,
      permissionGrantIds : target.permissionGrantIds,
      protocolRole       : role?.protocolRole,
    });
  }

  private static quarantineReason(
    outcome: Exclude<Awaited<ReturnType<typeof admitClosure>>, { kind: 'admitted' }>,
  ): SyncNextQuarantineReason {
    if (outcome.kind === 'failed') {
      return 'admission-unresolved';
    }
    return outcome.reason ?? 'admission-unresolved';
  }

  private static assertSuccessfulPage(reply: MessagesQueryReply, target: SyncTarget): void {
    if (reply.status.code !== 200) {
      throw new Error(
        `SyncNextPullPage: query failed for ${target.did} -> ${target.dwnUrl}: ` +
        `${reply.status.code} ${reply.status.detail}`,
      );
    }
    if (
      target.authorization.kind === 'role' &&
      reply.roleRecordId !== target.authorization.roleRecordId
    ) {
      throw new Error(
        `SyncNextPullPage: role feed resolved ${reply.roleRecordId ?? 'no role'} instead of ` +
        `${target.authorization.roleRecordId}.`,
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
      throw new Error('SyncNextPullPage: remote changed the captured query head.');
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
