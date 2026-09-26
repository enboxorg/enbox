import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncMessageEntry } from '../sync-messages.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type {
  MessagesQueryReply,
  MessagesQueryReplyEntry,
  ProgressToken,
} from '@enbox/dwn-sdk-js';
import type { SyncNextLinkIdentity, SyncNextQuarantineInput, SyncNextSourceReceipt } from './types.js';

import { admitClosure } from '../sync-admit-closure.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { queryRemoteMessageFeed } from '../sync-messages.js';
import { sealSyncNextQuarantinePayload } from './quarantine-codec.js';
import { Cid, Encoder, Message, Records, RecordsWrite } from '@enbox/dwn-sdk-js';
import { compareSyncNextPosition, syncNextLinkIdentity } from './ledger-key.js';

const PULL_PAGE_SIZE = 100;

type PreparedPage = {
  admissionEntries: SyncMessageEntry[];
  pageReceipts: SyncNextSourceReceipt[];
};

type ClassifiedPage = {
  materializedCids: Set<string>;
  quarantine: SyncNextQuarantineInput[];
  settled: SyncNextSourceReceipt[];
};

export type SyncNextPullPageResult =
  | { kind: 'aborted' | 'stale' }
  | {
      kind: 'committed';
      handledThrough: ProgressToken;
      hasMore: boolean;
      materializedCids: string[];
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
    const identity = syncNextLinkIdentity(target);
    const link = await this._ledger.getLink(identity);
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
    SyncNextPullPage.assertSuccessfulPage(reply, target);

    const handledThrough = reply.cursor;
    if (handledThrough === undefined) {
      throw new Error(
        `SyncNextPullPage: ${target.did} -> ${target.dwnUrl} returned no cursor for a successful page.`,
      );
    }
    const entries = reply.entries ?? [];
    SyncNextPullPage.assertCursorProgress(link.pullHandledThrough, handledThrough, reply.drained === true, entries.length);
    const { admissionEntries, pageReceipts } = await SyncNextPullPage.preparePage(handledThrough, entries);
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const classified = await this.classifyPage(
      target, identity, entries, pageReceipts, admissionEntries, shouldContinue,
    );
    if (classified === undefined) {
      return { kind: 'aborted' };
    }

    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const committed = await this._ledger.commitPullPage(link, {
      handledThrough,
      pageReceipts,
      quarantine : classified.quarantine,
      settled    : classified.settled,
    });
    if (!committed) {
      return { kind: 'stale' };
    }

    return {
      handledThrough,
      hasMore          : reply.drained !== true,
      kind             : 'committed',
      materializedCids : [...classified.materializedCids],
      quarantined      : classified.quarantine.length,
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
      limit              : PULL_PAGE_SIZE,
      permissionGrantIds : target.permissionGrantIds,
      protocolRole       : role?.protocolRole,
    });
  }

  private async classifyPage(
    target: SyncTarget,
    identity: SyncNextLinkIdentity,
    entries: readonly MessagesQueryReplyEntry[],
    pageReceipts: readonly SyncNextSourceReceipt[],
    admissionEntries: SyncMessageEntry[],
    shouldContinue: () => boolean,
  ): Promise<ClassifiedPage | undefined> {
    const classified: ClassifiedPage = {
      materializedCids : new Set<string>(),
      quarantine       : [],
      settled          : [],
    };
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const receipt = pageReceipts[index];
      const outcome = await admitClosure(entry.messageCid, {
        agent              : this._agent,
        did                : target.did,
        dwnUrl             : target.dwnUrl,
        delegateDid        : target.delegateDid,
        permissionGrantIds : target.permissionGrantIds,
        prefetched         : admissionEntries,
        remoteHydration    : 'defer',
        scope              : target.scope,
        shouldContinue,
      });
      if (!shouldContinue()) {
        return undefined;
      }
      if (outcome.kind === 'admitted') {
        classified.settled.push(receipt);
        for (const messageCid of outcome.appliedCids) {
          classified.materializedCids.add(messageCid);
        }
        continue;
      }

      const encryptedPayload = await sealSyncNextQuarantinePayload(this._agent.vault, {
        identity,
        messageCid : receipt.messageCid,
        source     : receipt.source,
      }, entry);
      if (!shouldContinue()) {
        return undefined;
      }
      classified.quarantine.push({ encryptedPayload, ...receipt });
    }
    return classified;
  }

  private static async preparePage(
    cursor: ProgressToken,
    entries: readonly MessagesQueryReplyEntry[],
  ): Promise<PreparedPage> {
    const admissionEntries: SyncMessageEntry[] = [];
    const pageReceipts: SyncNextSourceReceipt[] = [];
    for (const entry of entries) {
      pageReceipts.push({
        messageCid : entry.messageCid,
        source     : {
          epoch      : cursor.epoch,
          messageCid : entry.messageCid,
          position   : entry.seq,
          streamId   : cursor.streamId,
        },
      });
      if (entry.message === undefined || await Message.getCid(entry.message) !== entry.messageCid) {
        throw new Error(`SyncNextPullPage: feed entry ${entry.messageCid} failed CID verification.`);
      }
      if (entry.initialWrite !== undefined) {
        admissionEntries.push({
          isLatestBaseState  : false,
          message            : entry.initialWrite,
          verifiedMessageCid : await Message.getCid(entry.initialWrite),
        });
      }

      const bufferedData = await SyncNextPullPage.verifyInlineData(entry);
      admissionEntries.push({
        ...(bufferedData === undefined ? {} : { bufferedData }),
        isLatestBaseState  : entry.isLatestBaseState,
        message            : entry.message,
        verifiedMessageCid : entry.messageCid,
      });
    }
    return { admissionEntries, pageReceipts };
  }

  private static async verifyInlineData(entry: MessagesQueryReplyEntry): Promise<Uint8Array | undefined> {
    if (entry.encodedData === undefined) {
      return undefined;
    }
    const data = Encoder.base64UrlToBytes(entry.encodedData);
    if (entry.message !== undefined && Records.isRecordsWrite(entry.message)) {
      const dataCid = await Cid.computeDagPbCidFromBytes(data);
      RecordsWrite.validateDataIntegrity(
        entry.message.descriptor.dataCid,
        entry.message.descriptor.dataSize,
        dataCid,
        data.byteLength,
      );
    }
    return data;
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

  private static assertCursorProgress(
    previous: ProgressToken | undefined,
    next: ProgressToken,
    drained: boolean,
    entryCount: number,
  ): void {
    if (previous === undefined) {
      return;
    }
    if (previous.streamId !== next.streamId || previous.epoch !== next.epoch) {
      throw new Error('SyncNextPullPage: query cursor changed progress-token domain.');
    }
    const comparison = compareSyncNextPosition(next, previous);
    if (comparison < 0) {
      throw new Error('SyncNextPullPage: query cursor regressed.');
    }
    if (comparison === 0 && (!drained || entryCount > 0)) {
      throw new Error('SyncNextPullPage: query cursor did not advance.');
    }
  }
}
