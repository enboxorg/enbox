import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncEchoSuppressor } from '../sync-echo-suppressor.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { MessagesQueryReply, MessagesQueryReplyEntry, ProgressToken, RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type {
  SyncNextQuarantineInput,
  SyncNextSourceReceipt,
} from './types.js';

import { admitClosure } from '../sync-admit-closure.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { recordsWriteRequiresData } from '../sync-fetch-helpers.js';
import { sealSyncNextQuarantinePayload } from './quarantine-codec.js';
import { syncNextLinkIdentity } from './ledger-key.js';
import { assertPageCursorAdvanced, sourceTokenFromFeedEntry, syncEntriesFromFeedEntries } from './feed-entry.js';
import { Cid, Encoder, Message, Records, RecordsWrite } from '@enbox/dwn-sdk-js';
import { getLocalMessage, queryRemoteMessageFeed } from '../sync-messages.js';

const PULL_PAGE_SIZE = 100;

export type SyncNextPullPageResult = { aborted: true } | {
  aborted?: false;
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
    const identity = syncNextLinkIdentity(target);
    const link = await this._ledger.getLink(identity);
    if (link === undefined || link.status !== 'active' || !shouldContinue()) {
      return { aborted: true };
    }
    const current = await this._resolveTarget(target);

    const reply = await this.query(current, link.pullHandledThrough, options.signal);
    if (!shouldContinue()) {
      return { aborted: true };
    }
    SyncNextPullPage.assertSuccessfulPage(reply, current);

    const handledThrough = reply.cursor;
    if (handledThrough === undefined) {
      throw new Error(
        `SyncNextPullPage: ${target.did} -> ${target.dwnUrl} returned no cursor for a successful page.`,
      );
    }
    assertPageCursorAdvanced(
      link.pullHandledThrough,
      handledThrough,
      reply.drained === true,
      'SyncNextPullPage',
    );
    const entries = reply.entries ?? [];
    for (const entry of entries) {
      if (entry.message === undefined || await Message.getCid(entry.message) !== entry.messageCid) {
        throw new Error(`SyncNextPullPage: feed entry ${entry.messageCid} failed CID verification.`);
      }
      await SyncNextPullPage.assertInlineData(entry);
    }
    const prefetched = syncEntriesFromFeedEntries(entries);
    const quarantine: SyncNextQuarantineInput[] = [];
    const settled: SyncNextSourceReceipt[] = [];
    const materializedCids = new Set<string>();

    for (const entry of entries) {
      if (!shouldContinue()) {
        return { aborted: true };
      }
      const source = sourceTokenFromFeedEntry(handledThrough, entry);
      if (
        current.authorization.kind === 'role' &&
        entry.isLatestBaseState === false &&
        entry.message !== undefined &&
        Records.isRecordsWrite(entry.message)
      ) {
        settled.push({ messageCid: entry.messageCid, source });
        continue;
      }
      const isPushEcho = await this.hasDurableLocalPullEcho(current, entry);
      if (!shouldContinue()) {
        return { aborted: true };
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
        return { aborted: true };
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
      }, entry);
      quarantine.push({
        encryptedPayload,
        messageCid: entry.messageCid,
        source,
      });
    }

    const committed = await this._ledger.commitPullPage(identity, {
      handledThrough,
      quarantine,
      settled,
    });
    if (!committed) {
      return { aborted: true };
    }
    this._observer.onCheckpoint?.(current, handledThrough);

    return {
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

}
