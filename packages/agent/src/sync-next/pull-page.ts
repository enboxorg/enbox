import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncMessageEntry } from '../sync-messages.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type {
  GenericMessage,
  MessagesQueryReply,
  MessagesQueryReplyEntry,
  ProgressToken,
} from '@enbox/dwn-sdk-js';
import type { SyncNextLinkIdentity, SyncNextQuarantineInput, SyncNextSourceReceipt } from './types.js';

import { admitClosure } from '../sync-admit-closure.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { orderMessagesForAdmission } from '../sync-admission-order.js';
import { queryRemoteMessageFeed } from '../sync-messages.js';
import { sealSyncNextQuarantinePayload } from './quarantine-codec.js';
import { Cid, Encoder, Message, Records, RecordsWrite } from '@enbox/dwn-sdk-js';
import { compareSyncNextPosition, isValidSyncNextToken, syncNextLinkIdentity } from './ledger-key.js';

const PULL_PAGE_SIZE = 100;

type PreparedPage = {
  entries: PreparedPageEntry[];
  pageReceipts: SyncNextSourceReceipt[];
  rootEntries: SyncMessageEntry[];
};

type PreparedPageEntry = {
  entry: MessagesQueryReplyEntry;
  message: GenericMessage;
  receipt: SyncNextSourceReceipt;
};

type ClassifiedPage = {
  materializedCids: Set<string>;
  quarantine: SyncNextQuarantineInput[];
  settled: SyncNextSourceReceipt[];
};

type SuccessfulPage = {
  drained: boolean;
  entries: MessagesQueryReplyEntry[];
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
    const { drained, entries } = SyncNextPullPage.successfulPage(reply, target);

    const handledThrough = reply.cursor;
    if (handledThrough === undefined) {
      throw new Error(
        `SyncNextPullPage: ${target.did} -> ${target.dwnUrl} returned no cursor for a successful page.`,
      );
    }
    SyncNextPullPage.assertCursorProgress(link.pullHandledThrough, handledThrough, drained, entries.length);
    const prepared = await SyncNextPullPage.preparePage(
      link.pullHandledThrough, handledThrough, entries,
    );
    if (!shouldContinue()) {
      return { kind: 'aborted' };
    }
    const classified = await this.classifyPage(
      target, identity, prepared.entries, prepared.rootEntries, shouldContinue,
    );
    if (classified === undefined) {
      return { kind: 'aborted' };
    }

    const committed = await this._ledger.commitPullPage(link, {
      handledThrough,
      pageReceipts : prepared.pageReceipts,
      quarantine   : classified.quarantine,
      settled      : classified.settled,
    });
    if (!committed) {
      return { kind: 'stale' };
    }

    return {
      handledThrough,
      hasMore          : !drained,
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
    entries: PreparedPageEntry[],
    rootEntries: SyncMessageEntry[],
    shouldContinue: () => boolean,
  ): Promise<ClassifiedPage | undefined> {
    const classified: ClassifiedPage = {
      materializedCids : new Set<string>(),
      quarantine       : [],
      settled          : [],
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

  /** Validate the untrusted page before admission; the ledger rechecks these receipts at commit. */
  private static async preparePage(
    previous: ProgressToken | undefined,
    cursor: ProgressToken,
    entries: readonly MessagesQueryReplyEntry[],
  ): Promise<PreparedPage> {
    const preparedEntries: PreparedPageEntry[] = [];
    const pageReceipts: SyncNextSourceReceipt[] = [];
    const rootEntries: SyncMessageEntry[] = [];
    const positions = new Set<string>();
    for (const entry of entries) {
      const receipt = SyncNextPullPage.sourceReceipt(previous, cursor, entry, positions);
      const admissionEntry = await SyncNextPullPage.prepareAdmissionEntry(entry);
      rootEntries.push(admissionEntry);
      pageReceipts.push(receipt);
      preparedEntries.push({ entry, message: admissionEntry.message, receipt });
    }
    SyncNextPullPage.assertCursorReceipt(cursor, pageReceipts);
    return { entries: preparedEntries, pageReceipts, rootEntries };
  }

  private static sourceReceipt(
    previous: ProgressToken | undefined,
    cursor: ProgressToken,
    entry: MessagesQueryReplyEntry,
    positions: Set<string>,
  ): SyncNextSourceReceipt {
    if (
      typeof entry.messageCid !== 'string' ||
      typeof entry.seq !== 'string' ||
      typeof entry.isLatestBaseState !== 'boolean'
    ) {
      throw new TypeError('SyncNextPullPage: feed entry has invalid source metadata.');
    }
    const source: ProgressToken = {
      epoch      : cursor.epoch,
      messageCid : entry.messageCid,
      position   : entry.seq,
      streamId   : cursor.streamId,
    };
    if (!isValidSyncNextToken(source) || compareSyncNextPosition(source, cursor) > 0) {
      throw new Error(`SyncNextPullPage: feed entry ${entry.messageCid} has an invalid source position.`);
    }
    if (previous !== undefined && compareSyncNextPosition(source, previous) <= 0) {
      throw new Error(`SyncNextPullPage: feed entry ${entry.messageCid} is behind its checkpoint.`);
    }
    if (positions.has(entry.seq)) {
      throw new Error(`SyncNextPullPage: feed page repeats source position ${entry.seq}.`);
    }
    positions.add(entry.seq);
    return { messageCid: entry.messageCid, source };
  }

  private static async prepareAdmissionEntry(entry: MessagesQueryReplyEntry): Promise<SyncMessageEntry> {
    const message = entry.message;
    if (message === undefined || await Message.getCid(message) !== entry.messageCid) {
      throw new Error(`SyncNextPullPage: feed entry ${entry.messageCid} failed CID verification.`);
    }
    const bufferedData = await SyncNextPullPage.verifyInlineData(entry, message);
    return {
      ...(bufferedData === undefined ? {} : { bufferedData }),
      isLatestBaseState  : entry.isLatestBaseState,
      message,
      verifiedMessageCid : entry.messageCid,
    };
  }

  private static assertCursorReceipt(
    cursor: ProgressToken,
    pageReceipts: readonly SyncNextSourceReceipt[],
  ): void {
    if (cursor.messageCid !== undefined && !pageReceipts.some(receipt =>
      receipt.source.position === cursor.position && receipt.messageCid === cursor.messageCid
    )) {
      throw new Error('SyncNextPullPage: query cursor CID does not identify its page entry.');
    }
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

  private static successfulPage(
    reply: MessagesQueryReply,
    target: SyncTarget,
  ): SuccessfulPage {
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
    if (!Array.isArray(reply.entries)) {
      throw new TypeError('SyncNextPullPage: successful query omitted its entries array.');
    }
    if (typeof reply.drained !== 'boolean') {
      throw new TypeError('SyncNextPullPage: successful query requires a boolean drained value.');
    }
    if (reply.entries.length > PULL_PAGE_SIZE) {
      throw new RangeError(
        `SyncNextPullPage: query returned ${reply.entries.length} entries; maximum is ${PULL_PAGE_SIZE}.`,
      );
    }
    return { drained: reply.drained, entries: reply.entries };
  }

  private static assertCursorProgress(
    previous: ProgressToken | undefined,
    next: ProgressToken,
    drained: boolean,
    entryCount: number,
  ): void {
    if (!isValidSyncNextToken(next)) {
      throw new Error('SyncNextPullPage: query returned an invalid cursor.');
    }
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
