import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { AbstractBatchOperation, AbstractLevel, AbstractSublevel } from 'abstract-level';

import type {
  SyncNextDeliveryObligation,
  SyncNextDeliveryOutcome,
  SyncNextLink,
  SyncNextLinkCreate,
  SyncNextLinkIdentity,
  SyncNextPullPageCommit,
  SyncNextPushPageCommit,
  SyncNextQuarantineEntry,
  SyncNextSourceReceipt,
} from './types.js';

import { normalizeDwnEndpoint } from '../sync-target-resolver.js';
import { canonicalJsonStringify, runWithCrossContextLock } from '@enbox/common';

import {
  compareSyncNextPosition,
  isValidSyncNextToken,
  syncNextLinkKey,
  syncNextLinkRange,
  syncNextReceiptKey,
  syncNextTenantRange,
} from './ledger-key.js';

type LevelKey = string | Buffer | Uint8Array;
type SyncNextDatabase = AbstractLevel<LevelKey>;
type SyncNextBatchOperation = AbstractBatchOperation<SyncNextDatabase, string, string>;
type SyncNextSparseEntry = SyncNextDeliveryObligation | SyncNextQuarantineEntry;

const SYNC_NEXT_DEFAULT_MAX_DELIVERY_PER_LINK = 10_000;
const SYNC_NEXT_DEFAULT_MAX_QUARANTINE_BYTES_PER_TENANT = 64 * 1024 * 1024;
const SYNC_NEXT_DEFAULT_MAX_QUARANTINE_PER_TENANT = 10_000;

type SyncNextLedgerStoreOptions = {
  maxDeliveryPerLink?: number;
  maxQuarantineBytesPerTenant?: number;
  maxQuarantinePerTenant?: number;
};

/**
 * Isolated `syncNextV1` durable ledger.
 *
 * Successful outcomes are compressed into link progress. Only quarantine and
 * delivery obligations occupy sparse rows.
 */
export class SyncNextLedgerStore {
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
    options: SyncNextLedgerStoreOptions = {},
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
        SyncNextLedgerStore.assertSameLinkDefinition(existing, normalizedInput);
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

  /** Retire an obsolete binding while preserving inbound recovery input owned by its logical target. */
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

  /** Explicitly remove one current link and all sparse state owned by that exact link. */
  public async deleteLinkAndSparse(queriedLink: SyncNextLink): Promise<void> {
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

  /** Atomically retain pull exceptions and advance the remote handled-through token. */
  public async commitPullPage(
    queriedLink: SyncNextLink,
    commit: SyncNextPullPageCommit,
  ): Promise<boolean> {
    SyncNextLedgerStore.assertValidToken(commit.handledThrough, 'pull handled-through token');
    const key = syncNextLinkKey(queriedLink);
    return this.runMutation(async (): Promise<boolean> => {
      const link = await this.getValue<SyncNextLink>(this._links, key);
      if (link?.lifetimeId !== queriedLink.lifetimeId) {
        return false;
      }
      if (!SyncNextLedgerStore.sameToken(link.pullHandledThrough, queriedLink.pullHandledThrough)) {
        return false;
      }
      if (!SyncNextLedgerStore.canAdvance(link.pullHandledThrough, commit.handledThrough)) {
        return SyncNextLedgerStore.isEmptyReplay(
          link.pullHandledThrough, commit.handledThrough, commit.pageReceipts, commit.quarantine, commit.settled,
        );
      }
      SyncNextLedgerStore.validatePageCommit(
        commit.handledThrough, commit.pageReceipts, commit.quarantine, commit.settled,
        link.pullHandledThrough, 'pull',
      );

      const operations: SyncNextBatchOperation[] = [];
      const quarantined = commit.quarantine.map(input => this.nextSparseState(link, input, {
        encryptedPayload: input.encryptedPayload,
      }));
      if (quarantined.length > 0) {
        const retained = new Map((await this.getQuarantineForTenant(link.tenantDid)).map(
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

      const updated = SyncNextLedgerStore.withProgress(link, 'pull', commit.handledThrough);
      operations.push(this.putOperation(this._links, key, updated));
      await this._db.batch(operations);
      return true;
    });
  }

  /** Atomically retain outbound exceptions and advance the local handled-through token. */
  public async commitPushPage(
    queriedLink: SyncNextLink,
    commit: SyncNextPushPageCommit,
  ): Promise<boolean> {
    SyncNextLedgerStore.assertValidToken(commit.handledThrough, 'push handled-through token');
    const key = syncNextLinkKey(queriedLink);
    return this.runMutation(async (): Promise<boolean> => {
      const link = await this.getValue<SyncNextLink>(this._links, key);
      if (link?.lifetimeId !== queriedLink.lifetimeId) {
        return false;
      }
      if (!SyncNextLedgerStore.sameToken(link.pushHandledThrough, queriedLink.pushHandledThrough)) {
        return false;
      }
      if (!SyncNextLedgerStore.canAdvance(link.pushHandledThrough, commit.handledThrough)) {
        return SyncNextLedgerStore.isEmptyReplay(
          link.pushHandledThrough, commit.handledThrough, commit.pageReceipts, commit.delivery, commit.settled,
        );
      }
      SyncNextLedgerStore.validatePageCommit(
        commit.handledThrough, commit.pageReceipts, commit.delivery, commit.settled,
        link.pushHandledThrough, 'push',
      );

      const operations: SyncNextBatchOperation[] = [];
      const retained = new Set((await this.getDeliveryForLink(link)).map(
        entry => syncNextReceiptKey(link, entry)
      ));
      for (const input of commit.delivery) {
        const state = this.nextSparseState(link, input, {
          outcome: structuredClone(input.outcome),
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
          `SyncNextLedgerStore: delivery obligation capacity ${this._maxDeliveryPerLink} exceeded.`,
        );
      }

      const updated = SyncNextLedgerStore.withProgress(link, 'push', commit.handledThrough);
      operations.push(this.putOperation(this._links, key, updated));
      await this._db.batch(operations);
      return true;
    });
  }

  public async getQuarantineForLink(identity: SyncNextLinkIdentity): Promise<SyncNextQuarantineEntry[]> {
    return this.readValues(this._quarantine.iterator(syncNextLinkRange(identity)));
  }

  public async getQuarantineForTenant(tenantDid: string): Promise<SyncNextQuarantineEntry[]> {
    return this.readValues(this._quarantine.iterator(syncNextTenantRange(tenantDid)));
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
    });
  }

  /** Sparse scan used after one CID materializes locally to settle duplicate source receipts. */
  public async getQuarantineForLogicalTarget(
    tenantDid: string,
    projectionId: string,
  ): Promise<SyncNextQuarantineEntry[]> {
    return (await this.getQuarantineForTenant(tenantDid)).filter(entry => entry.projectionId === projectionId);
  }

  public updateQuarantine(entry: SyncNextQuarantineEntry): Promise<void> {
    return this.runMutation((): Promise<void> => this.updateSparse(this._quarantine, entry));
  }

  /** Settle every exact-source receipt satisfied by one verified local materialization. */
  public async settleQuarantineForLogicalTarget(
    tenantDid: string,
    projectionId: string,
    messageCids: string | readonly string[],
  ): Promise<void> {
    await this.runMutation(async (): Promise<void> => {
      const cids = new Set(typeof messageCids === 'string' ? [messageCids] : messageCids);
      const entries = (await this.getQuarantineForLogicalTarget(tenantDid, projectionId))
        .filter(entry => cids.has(entry.messageCid));
      await Promise.all(entries.map((entry): Promise<void> =>
        this._quarantine.del(syncNextReceiptKey(entry, entry))
      ));
    });
  }

  public settleDelivery(
    identity: SyncNextLinkIdentity,
    receipt: SyncNextSourceReceipt,
  ): Promise<void> {
    return this.runMutation((): Promise<void> => this._delivery.del(syncNextReceiptKey(identity, receipt)));
  }

  public updateDelivery(
    entry: SyncNextDeliveryObligation,
    outcome: SyncNextDeliveryOutcome,
  ): Promise<void> {
    return this.runMutation((): Promise<void> => this.updateSparse(this._delivery, entry, outcome));
  }

  public async clear(): Promise<void> {
    await this.runMutation(async (): Promise<void> => {
      await this._links.clear();
      await Promise.all([this._delivery.clear(), this._quarantine.clear()]);
    });
  }

  private nextSparseState<T extends object>(
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
      if (SyncNextLedgerStore.isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async updateSparse(
    store: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>,
    entry: SyncNextSparseEntry,
    outcome?: SyncNextDeliveryOutcome,
  ): Promise<void> {
    const key = syncNextReceiptKey(entry, entry);
    const current = await this.getValue<SyncNextSparseEntry>(store, key);
    if (current === undefined) {
      return;
    }
    await store.put(key, JSON.stringify({
      ...current,
      lastAttemptAt: new Date().toISOString(),
      ...(outcome === undefined ? {} : { outcome: structuredClone(outcome) }),
    }));
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

  /** Serialize ledger mutations that must not interleave with reset. */
  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return runWithCrossContextLock(
      `enbox:sync-next-ledger:${this._lockNamespace}`,
      operation,
    );
  }

  private assertTenantQuarantineCapacity(entries: Iterable<SyncNextQuarantineEntry>): void {
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      count++;
      bytes += entry.encryptedPayload.length;
    }
    if (count > this._maxQuarantinePerTenant) {
      throw new Error(
        `SyncNextLedgerStore: tenant quarantine entry capacity ${this._maxQuarantinePerTenant} exceeded.`,
      );
    }
    if (bytes > this._maxQuarantineBytesPerTenant) {
      throw new Error(
        `SyncNextLedgerStore: tenant quarantine byte capacity ${this._maxQuarantineBytesPerTenant} exceeded.`,
      );
    }
  }

  private static validatePageCommit(
    handledThrough: ProgressToken,
    pageReceipts: SyncNextSourceReceipt[],
    pending: SyncNextSourceReceipt[],
    settled: SyncNextSourceReceipt[],
    previous: ProgressToken | undefined,
    direction: 'pull' | 'push',
  ): void {
    SyncNextLedgerStore.assertValidToken(handledThrough, `${direction} handled-through token`);
    const page = SyncNextLedgerStore.validatePageReceipts(
      handledThrough, pageReceipts, previous, direction,
    );
    const seen = SyncNextLedgerStore.validatePageDispositions(
      handledThrough, page, pending, settled, direction,
    );
    if (seen.size !== page.size) {
      throw new Error(`SyncNextLedgerStore: ${direction} page has a source without a disposition.`);
    }
    if (handledThrough.messageCid !== undefined && !pageReceipts.some(receipt =>
      receipt.source.position === handledThrough.position && receipt.messageCid === handledThrough.messageCid
    )) {
      throw new Error(`SyncNextLedgerStore: ${direction} cursor CID does not match its page entry.`);
    }
  }

  private static validatePageReceipts(
    handledThrough: ProgressToken,
    pageReceipts: SyncNextSourceReceipt[],
    previous: ProgressToken | undefined,
    direction: 'pull' | 'push',
  ): Set<string> {
    const page = new Set<string>();
    const positions = new Set<string>();
    for (const receipt of pageReceipts) {
      SyncNextLedgerStore.assertReceiptWithinPage(receipt, handledThrough, direction);
      if (previous !== undefined && compareSyncNextPosition(receipt.source, previous) <= 0) {
        throw new Error(`SyncNextLedgerStore: ${direction} source is behind its previous checkpoint.`);
      }
      const key = SyncNextLedgerStore.receiptIdentity(receipt);
      if (page.has(key)) {
        throw new Error(`SyncNextLedgerStore: ${direction} page repeats source ${key}.`);
      }
      if (positions.has(receipt.source.position)) {
        throw new Error(
          `SyncNextLedgerStore: ${direction} page assigns more than one CID to position ` +
          `${receipt.source.position}.`,
        );
      }
      page.add(key);
      positions.add(receipt.source.position);
    }
    return page;
  }

  private static validatePageDispositions(
    handledThrough: ProgressToken,
    page: Set<string>,
    pending: SyncNextSourceReceipt[],
    settled: SyncNextSourceReceipt[],
    direction: 'pull' | 'push',
  ): Set<string> {
    const seen = new Set<string>();
    for (const receipts of [pending, settled]) {
      for (const receipt of receipts) {
        SyncNextLedgerStore.assertReceiptWithinPage(receipt, handledThrough, direction);
        const key = SyncNextLedgerStore.receiptIdentity(receipt);
        if (!page.has(key)) {
          throw new Error(`SyncNextLedgerStore: ${direction} source ${key} is not in the page.`);
        }
        if (seen.has(key)) {
          throw new Error(
            `SyncNextLedgerStore: ${direction} source ${key} has more than one page disposition.`,
          );
        }
        seen.add(key);
      }
    }
    return seen;
  }

  private static assertReceiptWithinPage(
    receipt: SyncNextSourceReceipt,
    handledThrough: ProgressToken,
    direction: 'pull' | 'push',
  ): void {
    SyncNextLedgerStore.assertValidToken(receipt.source, `${direction} source token`);
    if (receipt.messageCid.length === 0) {
      throw new Error('SyncNextLedgerStore: source message CID must not be empty.');
    }
    if (
      receipt.source.streamId !== handledThrough.streamId ||
      receipt.source.epoch !== handledThrough.epoch
    ) {
      throw new Error(
        `SyncNextLedgerStore: ${direction} source token does not match its page domain.`,
      );
    }
    if (compareSyncNextPosition(receipt.source, handledThrough) > 0) {
      throw new Error(
        `SyncNextLedgerStore: ${direction} source position exceeds its page checkpoint.`,
      );
    }
    if (
      receipt.source.messageCid !== undefined &&
      receipt.source.messageCid !== receipt.messageCid
    ) {
      throw new Error(
        `SyncNextLedgerStore: ${direction} source token CID does not match its receipt CID.`,
      );
    }
  }

  private static assertValidToken(token: ProgressToken, label: string): void {
    if (!isValidSyncNextToken(token)) {
      throw new Error(`SyncNextLedgerStore: ${label} is invalid.`);
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
        'SyncNextLedgerStore: progress token domain changed without an explicit reset.',
      );
    }
    return compareSyncNextPosition(incoming, current) > 0;
  }

  private static sameToken(left: ProgressToken | undefined, right: ProgressToken | undefined): boolean {
    return left === right || (left !== undefined && right !== undefined &&
      left.streamId === right.streamId && left.epoch === right.epoch &&
      left.position === right.position && left.messageCid === right.messageCid);
  }

  private static isEmptyReplay(
    current: ProgressToken | undefined,
    incoming: ProgressToken,
    pageReceipts: SyncNextSourceReceipt[],
    pending: SyncNextSourceReceipt[],
    settled: SyncNextSourceReceipt[],
  ): boolean {
    return current !== undefined && SyncNextLedgerStore.sameToken(current, incoming) &&
      pageReceipts.length === 0 && pending.length === 0 && settled.length === 0;
  }

  private static withProgress(
    link: SyncNextLink,
    direction: 'pull' | 'push',
    token: ProgressToken,
  ): SyncNextLink {
    const updated = structuredClone(link);
    if (direction === 'pull') {
      updated.pullHandledThrough = structuredClone(token);
    } else {
      updated.pushHandledThrough = structuredClone(token);
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
      throw new Error('SyncNextLedgerStore: exact link key resolves to a different durable definition.');
    }
  }

  private static isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      (error as { code?: unknown }).code === 'LEVEL_NOT_FOUND';
  }
}
