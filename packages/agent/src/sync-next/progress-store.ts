import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { AbstractBatchOperation, AbstractLevel, AbstractSublevel } from 'abstract-level';

import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryObligation,
  SyncNextDeliveryOutcome,
  SyncNextHandledWrite,
  SyncNextLink,
  SyncNextLinkCreate,
  SyncNextLinkIdentity,
  SyncNextPullPageCommit,
  SyncNextPushPageCommit,
  SyncNextQuarantineEntry,
  SyncNextQuarantineInput,
  SyncNextSourceReceipt,
} from './types.js';

import { normalizeDwnEndpoint } from '../sync-target-resolver.js';
import { canonicalJsonStringify, runWithCrossContextLock } from '@enbox/common';

import {
  compareSyncNextPosition,
  isSameSyncNextToken,
  isValidSyncNextToken,
  syncNextLinkKey,
  syncNextLinkRange,
  syncNextReceiptKey,
  syncNextSourceAtOrBefore,
  syncNextTenantRange,
} from './progress-key.js';

type LevelKey = string | Buffer | Uint8Array;
type SyncNextDatabase = AbstractLevel<LevelKey>;
type SyncNextBatchOperation = AbstractBatchOperation<SyncNextDatabase, string, string>;
type SyncNextPendingEntry = SyncNextDeliveryObligation | SyncNextQuarantineEntry;
type PreparedQuarantineInput = SyncNextQuarantineInput & { entrySize: number };

const SYNC_NEXT_DEFAULT_MAX_DELIVERY_PER_LINK = 10_000;
const SYNC_NEXT_DEFAULT_MAX_QUARANTINE_BYTES_PER_TENANT = 64 * 1024 * 1024;
const SYNC_NEXT_DEFAULT_MAX_QUARANTINE_PER_TENANT = 10_000;
const SYNC_NEXT_MAX_QUARANTINE_ENTRY_BYTES = 1024 * 1024;

type SyncNextProgressStoreOptions = {
  maxDeliveryPerLink?: number;
  maxQuarantineBytesPerTenant?: number;
  maxQuarantinePerTenant?: number;
};

/**
 * Isolated `syncNextV1` durable progress store.
 *
 * Successful outcomes are compressed into link progress. Only quarantine and
 * delivery obligations occupy pending rows.
 */
export class SyncNextProgressStore {
  private readonly _compatibleQuarantineLinks = new Set<string>();
  private readonly _delivery: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>;
  private readonly _links: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>;
  private readonly _lockNamespace: string;
  private readonly _maxDeliveryPerLink: number;
  private readonly _maxQuarantineBytesPerTenant: number;
  private readonly _maxQuarantinePerTenant: number;
  private readonly _quarantine: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>;

  public constructor(
    private readonly _db: SyncNextDatabase,
    lockNamespace = 'default',
    options: SyncNextProgressStoreOptions = {},
  ) {
    this._delivery = _db.sublevel('syncNextV1Delivery');
    this._links = _db.sublevel('syncNextV1Links');
    this._lockNamespace = lockNamespace;
    this._maxDeliveryPerLink = options.maxDeliveryPerLink ?? SYNC_NEXT_DEFAULT_MAX_DELIVERY_PER_LINK;
    this._maxQuarantineBytesPerTenant = options.maxQuarantineBytesPerTenant ??
      SYNC_NEXT_DEFAULT_MAX_QUARANTINE_BYTES_PER_TENANT;
    this._maxQuarantinePerTenant = options.maxQuarantinePerTenant ?? SYNC_NEXT_DEFAULT_MAX_QUARANTINE_PER_TENANT;
    this._quarantine = _db.sublevel('syncNextV1Quarantine');
  }

  public async getOrCreateLink(input: SyncNextLinkCreate): Promise<SyncNextLink> {
    const normalizedInput = { ...input, remoteEndpoint: normalizeDwnEndpoint(input.remoteEndpoint) };
    const key = syncNextLinkKey(normalizedInput);
    return this.runMutation(async (): Promise<SyncNextLink> => {
      const existing = await this.getValue<SyncNextLink>(this._links, key);
      if (existing !== undefined) {
        SyncNextProgressStore.assertSameLinkDefinition(existing, normalizedInput);
        return existing;
      }

      const link: SyncNextLink = {
        authorization      : structuredClone(normalizedInput.authorization),
        authorizationEpoch : normalizedInput.authorizationEpoch,
        lifetimeId         : crypto.randomUUID(),
        projectionId       : normalizedInput.projectionId,
        remoteEndpoint     : normalizedInput.remoteEndpoint,
        scope              : structuredClone(normalizedInput.scope),
        tenantDid          : normalizedInput.tenantDid,
        updatedAt          : new Date().toISOString(),
      };
      await this._links.put(key, JSON.stringify(link));
      return link;
    });
  }

  public async getLink(identity: SyncNextLinkIdentity): Promise<SyncNextLink | undefined> {
    return this.getValue(this._links, syncNextLinkKey(identity));
  }

  public async getLinksForTenant(tenantDid: string): Promise<SyncNextLink[]> {
    return this.readValues(this._links.iterator(syncNextTenantRange(tenantDid)));
  }

  public async getAllLinks(): Promise<SyncNextLink[]> {
    return this.readValues(this._links.iterator());
  }

  /** Check for durable work outside direction checkpoints without scanning either queue. */
  public async hasPendingWork(): Promise<{ delivery: boolean; quarantine: boolean }> {
    const [delivery, quarantine] = await Promise.all([
      this._delivery.iterator({ limit: 1 }).all(),
      this._quarantine.iterator({ limit: 1 }).all(),
    ]);
    return { delivery: delivery.length > 0, quarantine: quarantine.length > 0 };
  }

  /** Retire an obsolete binding while preserving inbound recovery input owned by its projection. */
  public async retireLink(queriedLink: SyncNextLink): Promise<void> {
    const key = syncNextLinkKey(queriedLink);
    await this.runMutation(async (): Promise<void> => {
      const current = await this.getValue<SyncNextLink>(this._links, key);
      if (current?.lifetimeId !== queriedLink.lifetimeId) {
        return;
      }
      const operations: SyncNextBatchOperation[] = [this.deleteOperation(this._links, key)];
      for (const entry of await this.getDeliveryForLink(queriedLink)) {
        operations.push(this.deleteOperation(this._delivery, syncNextReceiptKey(queriedLink, entry)));
      }
      await this._db.batch(operations);
    });
  }

  /** Explicitly remove one current link and all pending work owned by that exact link. */
  public async deleteLinkAndPendingWork(queriedLink: SyncNextLink): Promise<void> {
    const key = syncNextLinkKey(queriedLink);
    await this.runMutation(async (): Promise<void> => {
      const current = await this.getValue<SyncNextLink>(this._links, key);
      if (current?.lifetimeId !== queriedLink.lifetimeId) {
        return;
      }
      const operations: SyncNextBatchOperation[] = [this.deleteOperation(this._links, key)];
      for (const entry of await this.getQuarantineForLink(queriedLink)) {
        operations.push(this.deleteOperation(this._quarantine, syncNextReceiptKey(queriedLink, entry)));
      }
      for (const entry of await this.getDeliveryForLink(queriedLink)) {
        operations.push(this.deleteOperation(this._delivery, syncNextReceiptKey(queriedLink, entry)));
      }
      await this._db.batch(operations);
    });
  }

  /** Atomically retain pull exceptions and advance the pull checkpoint. */
  public async commitPullPage(
    queriedLink: SyncNextLink,
    commit: SyncNextPullPageCommit,
  ): Promise<boolean> {
    SyncNextProgressStore.assertValidToken(commit.checkpoint, 'pull checkpoint');
    const preparedQuarantine = commit.quarantine.map(SyncNextProgressStore.prepareQuarantineInput);
    const key = syncNextLinkKey(queriedLink);
    return this.runMutation(async (): Promise<boolean> => {
      const link = await this.getValue<SyncNextLink>(this._links, key);
      if (link?.lifetimeId !== queriedLink.lifetimeId) {
        return false;
      }
      await this.assertCompatibleQuarantine(link);
      if (!isSameSyncNextToken(link.pullCheckpoint, queriedLink.pullCheckpoint)) {
        return false;
      }
      if (!SyncNextProgressStore.canAdvance(link.pullCheckpoint, commit.checkpoint)) {
        return SyncNextProgressStore.isEmptyReplay(
          link.pullCheckpoint, commit.checkpoint, commit.pageReceipts, commit.quarantine, commit.settled,
        );
      }
      SyncNextProgressStore.validatePageCommit(
        commit.checkpoint, commit.pageReceipts, commit.quarantine, commit.settled,
        link.pullCheckpoint, 'pull',
      );

      const operations: SyncNextBatchOperation[] = [];
      const quarantined = preparedQuarantine.map(input => this.createPendingEntry(link, input, {
        entry     : input.entry,
        entrySize : input.entrySize,
      }));
      if (quarantined.length > 0) {
        const retained = new Map((await this.readQuarantine(
          this._quarantine.iterator(syncNextTenantRange(link.tenantDid)),
        )).map(
          (entry): [string, SyncNextQuarantineEntry] => [syncNextReceiptKey(entry, entry), entry],
        ));
        for (const state of quarantined) {
          retained.set(syncNextReceiptKey(link, state), state);
        }
        for (const settled of commit.settled) {
          retained.delete(syncNextReceiptKey(link, settled));
        }
        this.assertTenantQuarantineCapacity(retained.values());
      }
      for (const state of quarantined) {
        operations.push(this.putOperation(this._quarantine, syncNextReceiptKey(link, state), state));
      }
      for (const settled of commit.settled) {
        operations.push(this.deleteOperation(this._quarantine, syncNextReceiptKey(link, settled)));
      }

      const updated = SyncNextProgressStore.withCheckpoint(link, 'pull', commit.checkpoint);
      operations.push(this.putOperation(this._links, key, updated));
      await this._db.batch(operations);
      return true;
    });
  }

  /** Atomically retain outbound exceptions and advance the push checkpoint. */
  public async commitPushPage(
    queriedLink: SyncNextLink,
    commit: SyncNextPushPageCommit,
  ): Promise<boolean> {
    SyncNextProgressStore.assertValidToken(commit.checkpoint, 'push checkpoint');
    const key = syncNextLinkKey(queriedLink);
    return this.runMutation(async (): Promise<boolean> => {
      const link = await this.getValue<SyncNextLink>(this._links, key);
      if (link?.lifetimeId !== queriedLink.lifetimeId) {
        return false;
      }
      if (!isSameSyncNextToken(link.pushCheckpoint, queriedLink.pushCheckpoint)) {
        return false;
      }
      if (!SyncNextProgressStore.canAdvance(link.pushCheckpoint, commit.checkpoint)) {
        return commit.handledWrites.length === 0 && SyncNextProgressStore.isEmptyReplay(
          link.pushCheckpoint, commit.checkpoint, commit.pageReceipts, commit.delivery, commit.settled,
        );
      }
      SyncNextProgressStore.validatePageCommit(
        commit.checkpoint, commit.pageReceipts, commit.delivery, commit.settled,
        link.pushCheckpoint, 'push',
      );
      SyncNextProgressStore.validateDeliveryInputs(commit.delivery);
      const handledWrites = SyncNextProgressStore.validateHandledWrites(commit.handledWrites, commit.settled);

      const operations: SyncNextBatchOperation[] = [];
      const existingDelivery = await this.getDeliveryForLink(link);
      const retained = new Set(existingDelivery.map(
        entry => syncNextReceiptKey(link, entry)
      ));
      for (const entry of existingDelivery) {
        if (SyncNextProgressStore.deliveryIsCovered(entry, handledWrites)) {
          const receiptKey = syncNextReceiptKey(link, entry);
          retained.delete(receiptKey);
          operations.push(this.deleteOperation(this._delivery, receiptKey));
        }
      }
      for (const input of commit.delivery) {
        if (SyncNextProgressStore.deliveryIsCovered(input, handledWrites)) {
          continue;
        }
        const state = this.createPendingEntry(link, input, {
          outcome            : structuredClone(input.outcome),
          ...(input.writeRecordId === undefined ? {} : { writeRecordId: input.writeRecordId }),
          wasLatestBaseState : input.wasLatestBaseState,
        });
        const receiptKey = syncNextReceiptKey(link, state);
        retained.add(receiptKey);
        operations.push(this.putOperation(this._delivery, receiptKey, state));
      }
      for (const settled of commit.settled) {
        retained.delete(syncNextReceiptKey(link, settled));
        operations.push(this.deleteOperation(this._delivery, syncNextReceiptKey(link, settled)));
      }
      if (retained.size > this._maxDeliveryPerLink) {
        throw new Error(
          `SyncNextProgressStore: delivery obligation capacity ${this._maxDeliveryPerLink} exceeded.`,
        );
      }

      const updated = SyncNextProgressStore.withCheckpoint(link, 'push', commit.checkpoint);
      operations.push(this.putOperation(this._links, key, updated));
      await this._db.batch(operations);
      return true;
    });
  }

  public async getQuarantineForLink(identity: SyncNextLinkIdentity): Promise<SyncNextQuarantineEntry[]> {
    return this.readQuarantine(this._quarantine.iterator(syncNextLinkRange(identity)));
  }

  public async getQuarantineForTenant(tenantDid: string): Promise<SyncNextQuarantineEntry[]> {
    return this.readQuarantine(this._quarantine.iterator(syncNextTenantRange(tenantDid)));
  }

  public async getDeliveryForLink(identity: SyncNextLinkIdentity): Promise<SyncNextDeliveryObligation[]> {
    return this.readValues(this._delivery.iterator(syncNextLinkRange(identity)));
  }

  public async getDeliveryForTenant(tenantDid: string): Promise<SyncNextDeliveryObligation[]> {
    return this.readValues(this._delivery.iterator(syncNextTenantRange(tenantDid)));
  }

  public async deleteForTenant(tenantDid: string): Promise<void> {
    await this.runMutation(async (): Promise<void> => {
      const range = syncNextTenantRange(tenantDid);
      await this._links.clear(range);
      await Promise.all([this._delivery.clear(range), this._quarantine.clear(range)]);
      this._compatibleQuarantineLinks.clear();
    });
  }

  /** Pending-work scan used after one CID materializes locally to settle duplicate source receipts. */
  public async getQuarantineForProjection(
    tenantDid: string,
    projectionId: string,
  ): Promise<SyncNextQuarantineEntry[]> {
    return (await this.getQuarantineForTenant(tenantDid)).filter(entry => entry.projectionId === projectionId);
  }

  public updateQuarantine(entry: SyncNextQuarantineEntry): Promise<void> {
    return this.runMutation((): Promise<void> => this.updatePendingEntry(this._quarantine, entry));
  }

  /** Settle every exact-source receipt satisfied by one verified local materialization. */
  public async settleQuarantineForProjection(
    tenantDid: string,
    projectionId: string,
    messageCids: string | readonly string[],
  ): Promise<void> {
    await this.runMutation(async (): Promise<void> => {
      const cids = new Set(typeof messageCids === 'string' ? [messageCids] : messageCids);
      const entries = (await this.getQuarantineForProjection(tenantDid, projectionId))
        .filter(entry => cids.has(entry.messageCid));
      await Promise.all(entries.map((entry): Promise<void> =>
        this._quarantine.del(syncNextReceiptKey(entry, entry))
      ));
    });
  }

  /** Settle or rotate one exact outbound row only while its link and attempt are current. */
  public async finishDeliveryAttempt(
    queriedLink: SyncNextLink,
    selected: SyncNextDeliveryObligation,
    outcome?: SyncNextDeliveryOutcome,
  ): Promise<boolean> {
    const linkKey = syncNextLinkKey(queriedLink);
    if (syncNextLinkKey(selected) !== linkKey) {
      return false;
    }
    return this.runMutation(async (): Promise<boolean> => {
      const link = await this.getValue<SyncNextLink>(this._links, linkKey);
      if (link?.lifetimeId !== queriedLink.lifetimeId) {
        return false;
      }
      const receiptKey = syncNextReceiptKey(queriedLink, selected);
      const current = await this.getValue<SyncNextDeliveryObligation>(this._delivery, receiptKey);
      if (current?.lastAttemptAt !== selected.lastAttemptAt ||
          current.writeRecordId !== selected.writeRecordId ||
          current.wasLatestBaseState !== selected.wasLatestBaseState) {
        return false;
      }
      if (outcome === undefined) {
        if (current.wasLatestBaseState && current.writeRecordId !== undefined) {
          const operations = (await this.getDeliveryForLink(link))
            .filter(entry => entry.writeRecordId === current.writeRecordId &&
              syncNextSourceAtOrBefore(entry.source, current.source))
            .map(entry => this.deleteOperation(this._delivery, syncNextReceiptKey(link, entry)));
          await this._db.batch(operations);
        } else {
          await this._delivery.del(receiptKey);
        }
      } else {
        await this._delivery.put(receiptKey, JSON.stringify({
          ...current,
          lastAttemptAt : SyncNextProgressStore.nextAttemptAt(current.lastAttemptAt),
          outcome       : structuredClone(outcome),
        }));
      }
      return true;
    });
  }

  public async clear(): Promise<void> {
    await this.runMutation(async (): Promise<void> => {
      await this._links.clear();
      await Promise.all([this._delivery.clear(), this._quarantine.clear()]);
      this._compatibleQuarantineLinks.clear();
    });
  }

  private createPendingEntry<T extends object>(
    link: SyncNextLink,
    receipt: SyncNextSourceReceipt,
    state: T,
  ): T & SyncNextLinkIdentity & SyncNextSourceReceipt & { lastAttemptAt: string } {
    return {
      ...state,
      authorizationEpoch : link.authorizationEpoch,
      lastAttemptAt      : new Date().toISOString(),
      messageCid         : receipt.messageCid,
      projectionId       : link.projectionId,
      remoteEndpoint     : link.remoteEndpoint,
      source             : structuredClone(receipt.source),
      tenantDid          : link.tenantDid,
    };
  }

  private async getValue<T>(
    store: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>,
    key: string,
  ): Promise<T | undefined> {
    try {
      return JSON.parse(await store.get(key)) as T;
    } catch (error: unknown) {
      if (SyncNextProgressStore.isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async updatePendingEntry(
    store: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>,
    entry: SyncNextPendingEntry,
    outcome?: SyncNextDeliveryOutcome,
  ): Promise<void> {
    const key = syncNextReceiptKey(entry, entry);
    const current = await this.getValue<SyncNextPendingEntry>(store, key);
    if (current === undefined) {
      return;
    }
    await store.put(key, JSON.stringify({
      ...current,
      lastAttemptAt: SyncNextProgressStore.nextAttemptAt(current.lastAttemptAt),
      ...(outcome === undefined ? {} : { outcome: structuredClone(outcome) }),
    }));
  }

  private static nextAttemptAt(previous: string): string {
    const previousAttempt = Date.parse(previous);
    const nextAttempt = Number.isNaN(previousAttempt)
      ? Date.now() + 1
      : Math.max(Date.now() + 1, previousAttempt + 1);
    return new Date(nextAttempt).toISOString();
  }

  private static deliveryIsCovered(
    delivery: Pick<SyncNextDeliveryObligation, 'source' | 'writeRecordId'>,
    handledWrites: ReadonlyMap<string, SyncNextHandledWrite>,
  ): boolean {
    const handled = delivery.writeRecordId === undefined ? undefined : handledWrites.get(delivery.writeRecordId);
    return handled !== undefined && syncNextSourceAtOrBefore(delivery.source, handled.receipt.source);
  }

  private static validateDeliveryInputs(delivery: readonly SyncNextDeliveryInput[]): void {
    if (delivery.some(input => typeof input.wasLatestBaseState !== 'boolean')) {
      throw new TypeError('SyncNextProgressStore: delivery source state must be a boolean.');
    }
    if (delivery.some(input => input.writeRecordId !== undefined &&
      (typeof input.writeRecordId !== 'string' || input.writeRecordId.length === 0))) {
      throw new TypeError('SyncNextProgressStore: delivery write record ID must be a non-empty string.');
    }
  }

  private static validateHandledWrites(
    handledWrites: readonly SyncNextHandledWrite[],
    settled: readonly SyncNextSourceReceipt[],
  ): Map<string, SyncNextHandledWrite> {
    const settledReceipts = new Set(settled.map(SyncNextProgressStore.receiptIdentity));
    const byRecordId = new Map<string, SyncNextHandledWrite>();
    for (const handled of handledWrites) {
      if (typeof handled.recordId !== 'string' || handled.recordId.length === 0 ||
          !settledReceipts.has(SyncNextProgressStore.receiptIdentity(handled.receipt)) ||
          byRecordId.has(handled.recordId)) {
        throw new TypeError('SyncNextProgressStore: handled write state is invalid.');
      }
      byRecordId.set(handled.recordId, handled);
    }
    return byRecordId;
  }

  private putOperation(
    sublevel: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>,
    key: string,
    value: unknown,
  ): SyncNextBatchOperation {
    return { type: 'put', key, value: JSON.stringify(value), sublevel };
  }

  private deleteOperation(
    sublevel: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>,
    key: string,
  ): SyncNextBatchOperation {
    return { type: 'del', key, sublevel };
  }

  private async readValues<T>(entries: AsyncIterable<[string, string]>): Promise<T[]> {
    const values: T[] = [];
    for await (const [, value] of entries) {
      values.push(JSON.parse(value) as T);
    }
    return values;
  }

  private async readQuarantine(entries: AsyncIterable<[string, string]>): Promise<SyncNextQuarantineEntry[]> {
    const rows = await this.readValues<unknown>(entries);
    return rows.map(SyncNextProgressStore.validateQuarantineAccounting);
  }

  /** One-time format check prevents an old encrypted row from outliving its checkpoint. */
  private async assertCompatibleQuarantine(link: SyncNextLink): Promise<void> {
    const key = syncNextLinkKey(link);
    if (!this._compatibleQuarantineLinks.has(key)) {
      await this.readQuarantine(this._quarantine.iterator(syncNextLinkRange(link)));
      this._compatibleQuarantineLinks.add(key);
    }
  }

  /** Serialize progress-store mutations that must not interleave with reset. */
  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return runWithCrossContextLock(
      `enbox:sync-next-progress:${this._lockNamespace}`,
      operation,
    );
  }

  private assertTenantQuarantineCapacity(entries: Iterable<SyncNextQuarantineEntry>): void {
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      count++;
      bytes += entry.entrySize;
    }
    if (count > this._maxQuarantinePerTenant) {
      throw new Error(
        `SyncNextProgressStore: tenant quarantine entry capacity ${this._maxQuarantinePerTenant} exceeded.`,
      );
    }
    if (bytes > this._maxQuarantineBytesPerTenant) {
      throw new Error(
        `SyncNextProgressStore: tenant quarantine byte capacity ${this._maxQuarantineBytesPerTenant} exceeded.`,
      );
    }
  }

  private static prepareQuarantineInput(input: SyncNextQuarantineInput): PreparedQuarantineInput {
    const entry = structuredClone(input.entry);
    if (entry.messageCid !== input.messageCid) {
      throw new Error('SyncNextProgressStore: quarantine entry CID does not match its receipt.');
    }
    if (entry.seq !== input.source.position) {
      throw new Error('SyncNextProgressStore: quarantine entry position does not match its receipt.');
    }
    return { ...input, entry, entrySize: SyncNextProgressStore.serializedEntrySize(entry) };
  }

  /** Validate only fields used by the progress store; retry owns payload validation. */
  private static validateQuarantineAccounting(value: unknown): SyncNextQuarantineEntry {
    if (typeof value === 'object' && value !== null && 'encryptedPayload' in value) {
      throw new Error(
        'SyncNextProgressStore: encrypted quarantine rows are obsolete; clear the complete sync-next progress store.',
      );
    }
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('SyncNextProgressStore: quarantine row has an invalid schema.');
    }
    const row = value as Partial<SyncNextQuarantineEntry>;
    const source = row.source as Partial<ProgressToken> | undefined;
    const strings = [
      row.authorizationEpoch, row.projectionId, row.remoteEndpoint, row.tenantDid,
      row.lastAttemptAt, row.messageCid, source?.epoch, source?.position, source?.streamId,
    ];
    if (!strings.every(item => typeof item === 'string') ||
        typeof row.entrySize !== 'number' || !Number.isSafeInteger(row.entrySize) ||
        row.entrySize < 0 || row.entrySize > SYNC_NEXT_MAX_QUARANTINE_ENTRY_BYTES) {
      throw new TypeError('SyncNextProgressStore: quarantine row has an invalid schema.');
    }
    return row as SyncNextQuarantineEntry;
  }

  private static serializedEntrySize(entry: SyncNextQuarantineInput['entry']): number {
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (size > SYNC_NEXT_MAX_QUARANTINE_ENTRY_BYTES) {
      throw new Error(
        `SyncNextProgressStore: quarantine entry exceeds ${SYNC_NEXT_MAX_QUARANTINE_ENTRY_BYTES} bytes.`,
      );
    }
    return size;
  }

  private static validatePageCommit(
    checkpoint: ProgressToken,
    pageReceipts: SyncNextSourceReceipt[],
    pending: SyncNextSourceReceipt[],
    settled: SyncNextSourceReceipt[],
    previous: ProgressToken | undefined,
    direction: 'pull' | 'push',
  ): void {
    SyncNextProgressStore.assertValidToken(checkpoint, `${direction} checkpoint`);
    const page = SyncNextProgressStore.validatePageReceipts(
      checkpoint, pageReceipts, previous, direction,
    );
    const seen = SyncNextProgressStore.validatePageDispositions(
      checkpoint, page, pending, settled, direction,
    );
    if (seen.size !== page.size) {
      throw new Error(`SyncNextProgressStore: ${direction} page has a source without a disposition.`);
    }
    if (checkpoint.messageCid !== undefined && !pageReceipts.some(receipt =>
      receipt.source.position === checkpoint.position && receipt.messageCid === checkpoint.messageCid
    )) {
      throw new Error(`SyncNextProgressStore: ${direction} cursor CID does not match its page entry.`);
    }
  }

  private static validatePageReceipts(
    checkpoint: ProgressToken,
    pageReceipts: SyncNextSourceReceipt[],
    previous: ProgressToken | undefined,
    direction: 'pull' | 'push',
  ): Set<string> {
    const page = new Set<string>();
    const positions = new Set<string>();
    for (const receipt of pageReceipts) {
      SyncNextProgressStore.assertReceiptWithinPage(receipt, checkpoint, direction);
      if (previous !== undefined && compareSyncNextPosition(receipt.source, previous) <= 0) {
        throw new Error(`SyncNextProgressStore: ${direction} source is behind its previous checkpoint.`);
      }
      const key = SyncNextProgressStore.receiptIdentity(receipt);
      if (page.has(key)) {
        throw new Error(`SyncNextProgressStore: ${direction} page repeats source ${key}.`);
      }
      if (positions.has(receipt.source.position)) {
        throw new Error(
          `SyncNextProgressStore: ${direction} page assigns more than one CID to position ` +
          `${receipt.source.position}.`,
        );
      }
      page.add(key);
      positions.add(receipt.source.position);
    }
    return page;
  }

  private static validatePageDispositions(
    checkpoint: ProgressToken,
    page: Set<string>,
    pending: SyncNextSourceReceipt[],
    settled: SyncNextSourceReceipt[],
    direction: 'pull' | 'push',
  ): Set<string> {
    const seen = new Set<string>();
    for (const receipts of [pending, settled]) {
      for (const receipt of receipts) {
        SyncNextProgressStore.assertReceiptWithinPage(receipt, checkpoint, direction);
        const key = SyncNextProgressStore.receiptIdentity(receipt);
        if (!page.has(key)) {
          throw new Error(`SyncNextProgressStore: ${direction} source ${key} is not in the page.`);
        }
        if (seen.has(key)) {
          throw new Error(
            `SyncNextProgressStore: ${direction} source ${key} has more than one page disposition.`,
          );
        }
        seen.add(key);
      }
    }
    return seen;
  }

  private static assertReceiptWithinPage(
    receipt: SyncNextSourceReceipt,
    checkpoint: ProgressToken,
    direction: 'pull' | 'push',
  ): void {
    SyncNextProgressStore.assertValidToken(receipt.source, `${direction} source token`);
    if (receipt.messageCid.length === 0) {
      throw new Error('SyncNextProgressStore: source message CID must not be empty.');
    }
    if (
      receipt.source.streamId !== checkpoint.streamId ||
      receipt.source.epoch !== checkpoint.epoch
    ) {
      throw new Error(
        `SyncNextProgressStore: ${direction} source token does not match its page domain.`,
      );
    }
    if (compareSyncNextPosition(receipt.source, checkpoint) > 0) {
      throw new Error(
        `SyncNextProgressStore: ${direction} source position exceeds its page checkpoint.`,
      );
    }
    if (
      receipt.source.messageCid !== undefined &&
      receipt.source.messageCid !== receipt.messageCid
    ) {
      throw new Error(
        `SyncNextProgressStore: ${direction} source token CID does not match its receipt CID.`,
      );
    }
  }

  private static assertValidToken(token: ProgressToken, label: string): void {
    if (!isValidSyncNextToken(token)) {
      throw new Error(`SyncNextProgressStore: ${label} is invalid.`);
    }
  }

  private static canAdvance(
    current: ProgressToken | undefined,
    incoming: ProgressToken,
  ): boolean {
    if (current === undefined) {
      return true;
    }
    if (current.streamId !== incoming.streamId || current.epoch !== incoming.epoch) {
      throw new Error(
        'SyncNextProgressStore: progress token domain changed without an explicit reset.',
      );
    }
    return compareSyncNextPosition(incoming, current) > 0;
  }

  private static isEmptyReplay(
    current: ProgressToken | undefined,
    incoming: ProgressToken,
    pageReceipts: SyncNextSourceReceipt[],
    pending: SyncNextSourceReceipt[],
    settled: SyncNextSourceReceipt[],
  ): boolean {
    return current !== undefined && isSameSyncNextToken(current, incoming) &&
      pageReceipts.length === 0 && pending.length === 0 && settled.length === 0;
  }

  private static withCheckpoint(
    link: SyncNextLink,
    direction: 'pull' | 'push',
    token: ProgressToken,
  ): SyncNextLink {
    const updated = structuredClone(link);
    if (direction === 'pull') {
      updated.pullCheckpoint = structuredClone(token);
    } else {
      updated.pushCheckpoint = structuredClone(token);
    }
    updated.updatedAt = new Date().toISOString();
    return updated;
  }

  private static receiptIdentity(receipt: SyncNextSourceReceipt): string {
    return JSON.stringify([
      receipt.source.streamId,
      receipt.source.epoch,
      receipt.source.position,
      receipt.messageCid,
    ]);
  }

  private static assertSameLinkDefinition(existing: SyncNextLink, input: SyncNextLinkCreate): void {
    if (
      canonicalJsonStringify(existing.scope) !== canonicalJsonStringify(input.scope) ||
      canonicalJsonStringify(existing.authorization) !== canonicalJsonStringify(input.authorization)
    ) {
      throw new Error('SyncNextProgressStore: exact link key resolves to a different durable definition.');
    }
  }

  private static isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      (error as { code?: unknown }).code === 'LEVEL_NOT_FOUND';
  }
}
