import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncEchoSuppressor } from '../sync-echo-suppressor.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken, RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type {
  SyncNextLinkIdentity,
  SyncNextQuarantineInput,
  SyncNextQuarantineReason,
  SyncNextSettledSource,
} from './types.js';

import { Cid, Encoder, Message, RecordsWrite } from '@enbox/dwn-sdk-js';

import { admitClosure } from '../sync-admit-closure.js';
import { compareSyncNextPosition } from './ledger-key.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { sealSyncNextQuarantinePayload } from './quarantine-codec.js';
import { getLocalMessage, queryRemoteMessageFeed } from '../sync-messages.js';
import { sourceTokenFromFeedEntry, syncEntriesFromFeedEntries } from './feed-entry.js';

const PULL_PAGE_SIZE = 100;

export type SyncNextPullPageResult = {
  aborted?: true;
  handledThrough?: ProgressToken;
  hasMore: boolean;
  materializedCids: string[];
  quarantined: number;
};

export type SyncNextPullPageOptions = {
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
};

export type SyncNextPullPageObserver = {
  onApplied?: (target: SyncTarget, entries: readonly SyncFreshEntry[]) => void;
  onCheckpoint?: (target: SyncTarget, token: ProgressToken) => void;
};

/** Consumes exactly one remote feed page through normal local DWN admission. */
export class SyncNextPullPage {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _echoSuppressor?: SyncEchoSuppressor,
    private readonly _observer: SyncNextPullPageObserver = {},
    private readonly _resolveTarget: (target: SyncTarget) => Promise<SyncTarget> = async target => target,
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
    const current = await this._resolveTarget(target);

    const reply = await this.query(current, link.pullHandledThrough, options.signal);
    if (!shouldContinue()) {
      return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
    }
    SyncNextPullPage.assertSuccessfulPage(reply, current);

    const handledThrough = reply.cursor;
    if (handledThrough === undefined) {
      throw new Error(
        `SyncNextPullPage: ${target.did} -> ${target.dwnUrl} returned no cursor for a successful page.`,
      );
    }
    SyncNextPullPage.assertCursorAdvanced(link.pullHandledThrough, handledThrough, reply.drained === true);
    const entries = reply.entries ?? [];
    for (const entry of entries) {
      if (entry.message === undefined || await Message.getCid(entry.message) !== entry.messageCid) {
        throw new Error(`SyncNextPullPage: feed entry ${entry.messageCid} failed CID verification.`);
      }
      await SyncNextPullPage.assertInlineData(entry);
    }
    const prefetched = syncEntriesFromFeedEntries(entries);
    const quarantine: SyncNextQuarantineInput[] = [];
    const settled: SyncNextSettledSource[] = [];
    const materializedCids = new Set<string>();

    for (const entry of entries) {
      if (!shouldContinue()) {
        return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
      }
      const source = sourceTokenFromFeedEntry(handledThrough, entry);
      const isPushEcho = await this.hasDurableLocalPullEcho(current, entry);
      if (!shouldContinue()) {
        return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
      }
      if (isPushEcho) {
        settled.push({ messageCid: entry.messageCid, source });
        materializedCids.add(entry.messageCid);
        continue;
      }
      const outcome = await admitClosure(entry.messageCid, {
        agent         : this._agent,
        did           : current.did,
        dwnUrl        : current.dwnUrl,
        delegateDid   : current.delegateDid,
        onBeforeApply : (messageCid): void => {
          this._echoSuppressor?.trackPulled(current.did, messageCid, current.dwnUrl);
        },
        permissionGrantIds : current.permissionGrantIds,
        prefetched,
        remoteHydration    : 'defer',
        scope              : current.scope,
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
        if (outcome.freshEntries.length > 0) {
          this._observer.onApplied?.(current, outcome.freshEntries);
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
          reason: SyncNextPullPage.quarantineReason(outcome),
        },
        source,
      });
    }

    const committed = await this._ledger.commitPullPage(identity, {
      handledThrough,
      quarantine,
      settled,
    });
    if (!committed) {
      return { aborted: true, hasMore: false, materializedCids: [], quarantined: 0 };
    }
    this._observer.onCheckpoint?.(current, handledThrough);

    return {
      handledThrough,
      hasMore          : reply.drained !== true,
      materializedCids : [...materializedCids],
      quarantined      : quarantine.length,
    };
  }

  private query(
    target: SyncTarget,
    cursor?: ProgressToken,
    signal?: AbortSignal,
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
      limit              : PULL_PAGE_SIZE,
      permissionGrantIds : target.permissionGrantIds,
      protocolRole       : role?.protocolRole,
      signal,
    });
  }

  /** Verify a recent-push hint against the complete local message before skipping its pull echo. */
  private async hasDurableLocalPullEcho(
    target: SyncTarget,
    entry: MessagesQueryReplyEntry,
  ): Promise<boolean> {
    if (this._echoSuppressor?.hasRecentlyPushed(target.did, entry.messageCid, target.dwnUrl) !== true) {
      return false;
    }

    const local = await getLocalMessage({
      agent              : this._agent,
      author             : target.did,
      delegateDid        : target.delegateDid,
      messageCid         : entry.messageCid,
      permissionGrantIds : target.permissionGrantIds,
    });
    if (local === undefined) {
      return false;
    }

    const hasStoredData = local.dataStream !== undefined;
    await local.dataStream?.cancel();
    return entry.isLatestBaseState !== true ||
      !recordsWriteRequiresData(local.message) ||
      hasStoredData;
  }

  private static quarantineReason(
    outcome: Exclude<Awaited<ReturnType<typeof admitClosure>>, { kind: 'admitted' }>,
  ): SyncNextQuarantineReason {
    if (outcome.kind === 'failed') {
      return 'admission-unresolved';
    }
    return outcome.reason ?? 'admission-unresolved';
  }

  private static async assertInlineData(entry: MessagesQueryReplyEntry): Promise<void> {
    if (
      entry.encodedData === undefined ||
      entry.message?.descriptor.interface !== 'Records' ||
      entry.message.descriptor.method !== 'Write'
    ) {
      return;
    }
    const data = Encoder.base64UrlToBytes(entry.encodedData);
    const write = entry.message as RecordsWriteMessage;
    const dataCid = await Cid.computeDagPbCidFromBytes(data);
    RecordsWrite.validateDataIntegrity(
      write.descriptor.dataCid,
      write.descriptor.dataSize,
      dataCid,
      data.byteLength,
    );
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
      throw new Error('SyncNextPullPage: non-drained query cursor did not advance.');
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
