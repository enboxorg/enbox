import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncMessageEntry } from '../sync-messages.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextPreparedFeedEntry } from './feed-page.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type {
  GenericMessage,
  MessagesQueryReply,
  MessagesQueryReplyEntry,
  ProgressToken,
} from '@enbox/dwn-sdk-js';
import type { SyncNextQuarantineInput, SyncNextSourceReceipt } from './types.js';

import { admitClosure } from '../sync-admit-closure.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { orderMessagesForAdmission } from '../sync-admission-order.js';
import { queryRemoteMessageFeed } from '../sync-messages.js';
import { syncNextLinkIdentity } from './ledger-key.js';
import { Cid, Encoder, Records, RecordsWrite } from '@enbox/dwn-sdk-js';
import { prepareSyncNextFeedPage, SYNC_NEXT_PAGE_SIZE } from './feed-page.js';

type ClassifiedPage = {
  handledCids: Set<string>;
  quarantine: SyncNextQuarantineInput[];
  settled: SyncNextSourceReceipt[];
};

export type SyncNextPullPageResult =
  | { kind: 'aborted' | 'stale' }
  | {
      kind: 'committed';
      handledThrough: ProgressToken;
      hasMore: boolean;
      /** Closure messages handled as Applied, Duplicate, or Superseded. */
      handledCids: string[];
      quarantined: number;
    };

/** Queries, classifies, and commits exactly one remote feed page. */
export class SyncNextPullPage {
  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _ledger: SyncNextLedgerStore,
  ) {}

  public async consume(
    target: SyncTarget,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<SyncNextPullPageResult> {
    const link = await this._ledger.getLink(syncNextLinkIdentity(target));
    if (link === undefined) {
      return { kind: 'stale' };
    }
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }

    const reply = await this.query(target, link.pullHandledThrough);
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const feedPage = await prepareSyncNextFeedPage({
      label    : 'SyncNextPullPage',
      previous : link.pullHandledThrough,
      reply,
      target   : `query for ${target.did} -> ${target.dwnUrl}`,
    });
    SyncNextPullPage.assertRoleRecord(reply, target);
    const rootEntries = await SyncNextPullPage.prepareAdmissionEntries(feedPage.entries);
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const classified = await this.classifyPage(
      target, feedPage.entries, rootEntries, shouldContinue,
    );
    if (classified === undefined) {
      return { kind: 'aborted' };
    }

    const committed = await this._ledger.commitPullPage(link, {
      handledThrough : feedPage.handledThrough,
      pageReceipts   : feedPage.pageReceipts,
      quarantine     : classified.quarantine,
      settled        : classified.settled,
    });
    if (!committed) {
      return { kind: 'stale' };
    }

    return {
      handledThrough : feedPage.handledThrough,
      hasMore        : !feedPage.drained,
      kind           : 'committed',
      handledCids    : [...classified.handledCids],
      quarantined    : classified.quarantine.length,
    };
  }

  private query(target: SyncTarget, cursor?: ProgressToken): Promise<MessagesQueryReply> {
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
      limit              : SYNC_NEXT_PAGE_SIZE,
      permissionGrantIds : target.permissionGrantIds,
      protocolRole       : role?.protocolRole,
    });
  }

  private async classifyPage(
    target: SyncTarget,
    entries: SyncNextPreparedFeedEntry[],
    rootEntries: SyncMessageEntry[],
    shouldContinue: () => boolean,
  ): Promise<ClassifiedPage | undefined> {
    const classified: ClassifiedPage = {
      handledCids : new Set<string>(),
      quarantine  : [],
      settled     : [],
    };
    for (const { entry, receipt } of orderMessagesForAdmission(entries)) {
      const outcome = await admitClosure(entry.messageCid, {
        agent              : this._agent,
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        prefetched         : rootEntries,
        remoteHydration    : 'defer',
        scope              : target.scope,
        shouldContinue,
      });
      if (!shouldContinue()) {
        return undefined;
      }
      if (outcome.kind === 'admitted') {
        classified.settled.push(receipt);
        for (const messageCid of outcome.handledCids) {
          classified.handledCids.add(messageCid);
        }
        continue;
      }

      classified.quarantine.push({ entry, ...receipt });
    }
    return classified;
  }

  private static async prepareAdmissionEntries(
    entries: SyncNextPreparedFeedEntry[],
  ): Promise<SyncMessageEntry[]> {
    const rootEntries: SyncMessageEntry[] = [];
    for (const { entry, message } of entries) {
      const admissionEntry = await SyncNextPullPage.prepareAdmissionEntry(entry, message);
      rootEntries.push(admissionEntry);
    }
    return rootEntries;
  }

  private static async prepareAdmissionEntry(
    entry: SyncNextPreparedFeedEntry['entry'],
    message: GenericMessage,
  ): Promise<SyncMessageEntry> {
    const bufferedData = await SyncNextPullPage.verifyInlineData(entry, message);
    return {
      ...(bufferedData === undefined ? {} : { bufferedData }),
      isLatestBaseState  : entry.isLatestBaseState,
      message,
      verifiedMessageCid : entry.messageCid,
    };
  }

  private static async verifyInlineData(
    entry: MessagesQueryReplyEntry,
    message: GenericMessage,
  ): Promise<Uint8Array | undefined> {
    if (entry.encodedData === undefined) {
      return undefined;
    }
    if (!Records.isRecordsWrite(message)) {
      throw new TypeError(`SyncNextPullPage: non-RecordsWrite entry ${entry.messageCid} included record data.`);
    }
    const data = Encoder.base64UrlToBytes(entry.encodedData);
    const dataCid = await Cid.computeDagPbCidFromBytes(data);
    RecordsWrite.validateDataIntegrity(
      message.descriptor.dataCid,
      message.descriptor.dataSize,
      dataCid,
      data.byteLength,
    );
    return data;
  }

  private static assertRoleRecord(reply: MessagesQueryReply, target: SyncTarget): void {
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
