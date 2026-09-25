import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { AbstractBatchOperation, AbstractLevel, AbstractSublevel } from 'abstract-level';

import type {
  SyncNextDeliveryInput,
  SyncNextDeliveryObligation,
  SyncNextDeliveryOutcome,
  SyncNextLink,
  SyncNextLinkCreate,
  SyncNextLinkIdentity,
  SyncNextPullPageCommit,
  SyncNextPushPageCommit,
  SyncNextQuarantineEntry,
  SyncNextQuarantineInput,
  SyncNextQuarantineOutcome,
  SyncNextSettledSource,
  SyncNextSourceReceipt,
} from './types.js';

import { runSerializedByKey, runWithCrossContextLock } from '@enbox/common';

import { SYNC_NEXT_LEDGER_VERSION } from './types.js';
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

export const SYNC_NEXT_DEFAULT_MAX_DELIVERY_PER_LINK = 10_000;
export const SYNC_NEXT_DEFAULT_MAX_QUARANTINE_BYTES_PER_LINK = 64 * 1024 * 1024;
export const SYNC_NEXT_DEFAULT_MAX_QUARANTINE_PER_LINK = 10_000;

export type SyncNextLedgerStoreOptions = {
  maxDeliveryPerLink?: number;
  maxQuarantineBytesPerLink?: number;
  maxQuarantinePerLink?: number;
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
  private readonly _maxQuarantineBytesPerLink: number;
  private readonly _maxQuarantinePerLink: number;
  private readonly _pendingOperations = new Map<string, Promise<void>>();
  private readonly _quarantine: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>;

  public constructor(
    private readonly _db: SyncNextDatabase,
    lockNamespace = 'default',
    options: SyncNextLedgerStoreOptions = {},
  ) {
    this._delivery = _db.sublevel('syncNextV1Delivery');
    this._links = _db.sublevel('syncNextV1Links');
    this._lockNamespace = lockNamespace;
    this._maxDeliveryPerLink = SyncNextLedgerStore.capacity(
      options.maxDeliveryPerLink,
      SYNC_NEXT_DEFAULT_MAX_DELIVERY_PER_LINK,
      'maxDeliveryPerLink',
    );
    this._maxQuarantineBytesPerLink = SyncNextLedgerStore.capacity(
      options.maxQuarantineBytesPerLink,
      SYNC_NEXT_DEFAULT_MAX_QUARANTINE_BYTES_PER_LINK,
      'maxQuarantineBytesPerLink',
    );
    this._maxQuarantinePerLink = SyncNextLedgerStore.capacity(
      options.maxQuarantinePerLink,
      SYNC_NEXT_DEFAULT_MAX_QUARANTINE_PER_LINK,
      'maxQuarantinePerLink',
    );
    this._quarantine = _db.sublevel('syncNextV1Quarantine');
  }

  /** Create one exact link without reading or mutating legacy sync state. */
  public async getOrCreateLink(input: SyncNextLinkCreate): Promise<SyncNextLink> {
    const key = syncNextLinkKey(input);
    return this.runForLink(key, async (): Promise<SyncNextLink> => {
      const existing = await this.getStoredLink(key);
      if (existing !== undefined) {
        SyncNextLedgerStore.assertSameLinkDefinition(existing, input);
        return existing;
      }

      const now = new Date().toISOString();
      const link: SyncNextLink = {
        authorization      : structuredClone(input.authorization),
        authorizationEpoch : input.authorizationEpoch,
        createdAt          : now,
        ...(input.delegateDid === undefined ? {} : { delegateDid: input.delegateDid }),
        logicalTargetId    : input.logicalTargetId,
        projectionId       : input.projectionId,
        remoteEndpoint     : input.remoteEndpoint,
        scope              : structuredClone(input.scope),
        status             : 'active',
        tenantDid          : input.tenantDid,
        updatedAt          : now,
        version            : SYNC_NEXT_LEDGER_VERSION,
      };
      await this._links.put(key, JSON.stringify(link));
      return link;
    });
  }

  public async getLink(identity: SyncNextLinkIdentity): Promise<SyncNextLink | undefined> {
    return this.getStoredLink(syncNextLinkKey(identity));
  }

  public async getLinksForTenant(tenantDid: string): Promise<SyncNextLink[]> {
    return this.readValues(this._links.iterator(syncNextTenantRange(tenantDid)));
  }

  public async getAllLinks(): Promise<SyncNextLink[]> {
    return this.readValues(this._links.iterator());
  }

  /** Delete only the link. Sparse receipts survive until explicit owner cleanup or rebuild. */
  public async deleteLink(identity: SyncNextLinkIdentity): Promise<void> {
    const key = syncNextLinkKey(identity);
    await this.runForLink(key, async (): Promise<void> => {
      await this._links.del(key);
    });
  }

  /** Retire an obsolete binding while preserving inbound recovery input owned by its logical target. */
  public async retireLink(identity: SyncNextLinkIdentity): Promise<void> {
    const key = syncNextLinkKey(identity);
    await this.runForLink(key, async (): Promise<void> => {
      const operations: SyncNextBatchOperation[] = [this.deleteOperation(this._links, key)];
      for (const entry of await this.getDeliveryForLink(identity)) {
        operations.push(this.deleteOperation(this._delivery, syncNextReceiptKey(identity, entry)));
      }
      await this._db.batch(operations);
    });
  }

  /** Explicit acceptance removal deletes one link and every sparse outcome it owns. */
  public async deleteLinkAndSparse(identity: SyncNextLinkIdentity): Promise<void> {
    const key = syncNextLinkKey(identity);
    await this.runForLink(key, async (): Promise<void> => {
      const operations: SyncNextBatchOperation[] = [this.deleteOperation(this._links, key)];
      for (const entry of await this.getQuarantineForLink(identity)) {
        operations.push(this.deleteOperation(this._quarantine, syncNextReceiptKey(identity, entry)));
      }
      for (const entry of await this.getDeliveryForLink(identity)) {
        operations.push(this.deleteOperation(this._delivery, syncNextReceiptKey(identity, entry)));
      }
      await this._db.batch(operations);
    });
  }

  public async setLinkStatus(
    identity: SyncNextLinkIdentity,
    status: SyncNextLink['status'],
  ): Promise<boolean> {
    const key = syncNextLinkKey(identity);
    return this.runForLink(key, async (): Promise<boolean> => {
      const link = await this.getStoredLink(key);
      if (link === undefined) {
        return false;
      }
      link.status = status;
      link.updatedAt = new Date().toISOString();
      await this._links.put(key, JSON.stringify(link));
      return true;
    });
  }

  /** Atomically retain pull exceptions and advance the remote handled-through token. */
  public async commitPullPage(
    identity: SyncNextLinkIdentity,
    commit: SyncNextPullPageCommit,
  ): Promise<boolean> {
    SyncNextLedgerStore.validatePullCommit(commit);
    const key = syncNextLinkKey(identity);
    return this.runForLink(key, async (): Promise<boolean> => {
      const link = await this.getActiveLink(key);
      if (link === undefined) {
        return false;
      }
      if (!SyncNextLedgerStore.canAdvance(link.pullHandledThrough, commit.handledThrough)) {
        return false;
      }

      const operations: SyncNextBatchOperation[] = [];
      const retained = new Map((await this.getQuarantineForLink(link)).map(
        (entry): [string, SyncNextQuarantineEntry] => [syncNextReceiptKey(link, entry), entry],
      ));
      for (const input of commit.quarantine) {
        const state = await this.nextQuarantineState(link, input);
        const receiptKey = syncNextReceiptKey(link, state);
        retained.set(receiptKey, state);
        operations.push(this.putOperation(this._quarantine, receiptKey, state));
      }
      for (const settled of commit.settled) {
        const receiptKey = syncNextReceiptKey(link, settled);
        retained.delete(receiptKey);
        operations.push(this.deleteOperation(this._quarantine, receiptKey));
      }
      this.assertQuarantineCapacity(retained.values());

      const updated = SyncNextLedgerStore.withProgress(link, 'pull', commit.handledThrough);
      operations.push(this.putOperation(this._links, key, updated));
      await this._db.batch(operations);
      return true;
    });
  }

  /** Atomically retain outbound exceptions and advance the local handled-through token. */
  public async commitPushPage(
    identity: SyncNextLinkIdentity,
    commit: SyncNextPushPageCommit,
  ): Promise<boolean> {
    SyncNextLedgerStore.validatePushCommit(commit);
    const key = syncNextLinkKey(identity);
    return this.runForLink(key, async (): Promise<boolean> => {
      const link = await this.getActiveLink(key);
      if (link === undefined) {
        return false;
      }
      if (!SyncNextLedgerStore.canAdvance(link.pushHandledThrough, commit.handledThrough)) {
        return false;
      }

      const operations: SyncNextBatchOperation[] = [];
      const retained = new Map((await this.getDeliveryForLink(link)).map(
        (entry): [string, SyncNextDeliveryObligation] => [syncNextReceiptKey(link, entry), entry],
      ));
      for (const input of commit.delivery) {
        const state = await this.nextDeliveryState(link, input);
        const receiptKey = syncNextReceiptKey(link, state);
        retained.set(receiptKey, state);
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

  public async getAllQuarantine(): Promise<SyncNextQuarantineEntry[]> {
    return this.readValues(this._quarantine.iterator());
  }

  public async getQuarantineForTenant(tenantDid: string): Promise<SyncNextQuarantineEntry[]> {
    return this.readValues(this._quarantine.iterator(syncNextTenantRange(tenantDid)));
  }

  public async getDeliveryForLink(identity: SyncNextLinkIdentity): Promise<SyncNextDeliveryObligation[]> {
    return this.readValues(this._delivery.iterator(syncNextLinkRange(identity)));
  }

  public async getAllDelivery(): Promise<SyncNextDeliveryObligation[]> {
    return this.readValues(this._delivery.iterator());
  }

  public async getDeliveryForTenant(tenantDid: string): Promise<SyncNextDeliveryObligation[]> {
    return this.readValues(this._delivery.iterator(syncNextTenantRange(tenantDid)));
  }

  /** Explicit identity removal owns all next-engine state for that tenant. */
  public async deleteForTenant(tenantDid: string): Promise<void> {
    const range = syncNextTenantRange(tenantDid);
    await Promise.all([this._delivery.clear(range), this._links.clear(range), this._quarantine.clear(range)]);
  }

  /** Sparse scan used after one CID materializes locally to settle duplicate source receipts. */
  public async getQuarantineForLogicalTarget(
    logicalTargetId: string,
    messageCid?: string,
  ): Promise<SyncNextQuarantineEntry[]> {
    return (await this.getAllQuarantine()).filter(entry =>
      entry.logicalTargetId === logicalTargetId &&
      (messageCid === undefined || entry.messageCid === messageCid)
    );
  }

  public async settleQuarantine(
    identity: SyncNextLinkIdentity,
    receipt: SyncNextSourceReceipt,
  ): Promise<void> {
    return this.settleSparse(this._quarantine, identity, receipt);
  }

  /** Update one retained receipt without requiring its original link to remain active. */
  public async updateQuarantine(
    entry: SyncNextQuarantineEntry,
    outcome: SyncNextQuarantineOutcome,
  ): Promise<void> {
    const linkKey = syncNextLinkKey(entry);
    await this.runForLink(linkKey, async (): Promise<void> => {
      const key = syncNextReceiptKey(entry, entry);
      const current = await this.getSparseValue<SyncNextQuarantineEntry>(this._quarantine, key);
      if (current === undefined) {
        return;
      }
      const updated: SyncNextQuarantineEntry = {
        ...current,
        attempts      : current.attempts + 1,
        lastAttemptAt : new Date().toISOString(),
        outcome       : structuredClone(outcome),
      };
      await this._quarantine.put(key, JSON.stringify(updated));
    });
  }

  /** Settle every exact-source receipt satisfied by one verified local materialization. */
  public async settleQuarantineForLogicalTarget(
    logicalTargetId: string,
    messageCids: string | readonly string[],
  ): Promise<void> {
    const cids = new Set(typeof messageCids === 'string' ? [messageCids] : messageCids);
    const entries = (await this.getQuarantineForLogicalTarget(logicalTargetId))
      .filter(entry => cids.has(entry.messageCid));
    await Promise.all(entries.map((entry): Promise<void> => this.settleQuarantine(entry, entry)));
  }

  /** Explicit recovery cleanup after every current source checkpoint has been reset. */
  public async purgeQuarantineForLogicalTarget(logicalTargetId: string): Promise<number> {
    const entries = await this.getQuarantineForLogicalTarget(logicalTargetId);
    await Promise.all(entries.map((entry): Promise<void> => this.settleQuarantine(entry, entry)));
    return entries.length;
  }

  public async settleDelivery(
    identity: SyncNextLinkIdentity,
    receipt: SyncNextSourceReceipt,
  ): Promise<void> {
    return this.settleSparse(this._delivery, identity, receipt);
  }

  /** Update one outbound retry outcome without changing local feed progress. */
  public async updateDelivery(
    entry: SyncNextDeliveryObligation,
    outcome: SyncNextDeliveryOutcome,
  ): Promise<void> {
    const linkKey = syncNextLinkKey(entry);
    await this.runForLink(linkKey, async (): Promise<void> => {
      const key = syncNextReceiptKey(entry, entry);
      const current = await this.getSparseValue<SyncNextDeliveryObligation>(this._delivery, key);
      if (current === undefined) {
        return;
      }
      const updated: SyncNextDeliveryObligation = {
        ...current,
        attempts      : current.attempts + 1,
        lastAttemptAt : new Date().toISOString(),
        outcome       : structuredClone(outcome),
      };
      await this._delivery.put(key, JSON.stringify(updated));
    });
  }

  /** Atomically discard reconstructible sparse state and reset one source for replay. */
  public async rebuildDirection(
    identity: SyncNextLinkIdentity,
    direction: 'pull' | 'push',
    token?: ProgressToken,
  ): Promise<boolean> {
    if (token !== undefined) {
      SyncNextLedgerStore.assertValidToken(token, `${direction} rebuild token`);
    }
    const key = syncNextLinkKey(identity);
    return this.runForLink(key, async (): Promise<boolean> => {
      const link = await this.getStoredLink(key);
      if (link === undefined) {
        return false;
      }
      const operations: SyncNextBatchOperation[] = [];
      const sparse = direction === 'pull'
        ? await this.getQuarantineForLink(identity)
        : await this.getDeliveryForLink(identity);
      for (const entry of sparse) {
        operations.push(this.deleteOperation(
          direction === 'pull' ? this._quarantine : this._delivery,
          syncNextReceiptKey(identity, entry),
        ));
      }
      const updated = structuredClone(link);
      if (direction === 'pull') {
        updated.pullHandledThrough = token;
      } else {
        updated.pushHandledThrough = token;
      }
      updated.updatedAt = new Date().toISOString();
      operations.push(this.putOperation(this._links, key, updated));
      await this._db.batch(operations);
      return true;
    });
  }

  /** Clear only the isolated next-engine namespace. */
  public async clear(): Promise<void> {
    await this.waitForPendingOperations();
    await Promise.all([
      this._delivery.clear(),
      this._links.clear(),
      this._quarantine.clear(),
    ]);
  }

  private async getActiveLink(key: string): Promise<SyncNextLink | undefined> {
    const link = await this.getStoredLink(key);
    return link?.status === 'active' ? link : undefined;
  }

  private async getStoredLink(key: string): Promise<SyncNextLink | undefined> {
    try {
      return JSON.parse(await this._links.get(key)) as SyncNextLink;
    } catch (error: unknown) {
      if (SyncNextLedgerStore.isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async nextQuarantineState(
    link: SyncNextLink,
    input: SyncNextQuarantineInput,
  ): Promise<SyncNextQuarantineEntry> {
    const key = syncNextReceiptKey(link, input);
    const previous = await this.getSparseValue<SyncNextQuarantineEntry>(this._quarantine, key);
    const now = new Date().toISOString();
    return {
      attempts           : (previous?.attempts ?? 0) + 1,
      authorizationEpoch : link.authorizationEpoch,
      encryptedPayload   : input.encryptedPayload,
      firstPendingAt     : previous?.firstPendingAt ?? now,
      lastAttemptAt      : now,
      logicalTargetId    : link.logicalTargetId,
      messageCid         : input.messageCid,
      outcome            : structuredClone(input.outcome),
      projectionId       : link.projectionId,
      remoteEndpoint     : link.remoteEndpoint,
      source             : structuredClone(input.source),
      tenantDid          : link.tenantDid,
      version            : SYNC_NEXT_LEDGER_VERSION,
    };
  }

  private async nextDeliveryState(
    link: SyncNextLink,
    input: SyncNextDeliveryInput,
  ): Promise<SyncNextDeliveryObligation> {
    const key = syncNextReceiptKey(link, input);
    const previous = await this.getSparseValue<SyncNextDeliveryObligation>(this._delivery, key);
    const now = new Date().toISOString();
    return {
      attempts           : (previous?.attempts ?? 0) + 1,
      authorizationEpoch : link.authorizationEpoch,
      firstPendingAt     : previous?.firstPendingAt ?? now,
      lastAttemptAt      : now,
      logicalTargetId    : link.logicalTargetId,
      messageCid         : input.messageCid,
      outcome            : structuredClone(input.outcome),
      projectionId       : link.projectionId,
      remoteEndpoint     : link.remoteEndpoint,
      source             : structuredClone(input.source),
      tenantDid          : link.tenantDid,
      version            : SYNC_NEXT_LEDGER_VERSION,
    };
  }

  private async getSparseValue<T>(
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

  private settleSparse(
    store: AbstractSublevel<SyncNextDatabase, LevelKey, string, string>,
    identity: SyncNextLinkIdentity,
    receipt: SyncNextSourceReceipt,
  ): Promise<void> {
    const linkKey = syncNextLinkKey(identity);
    return this.runForLink(linkKey, (): Promise<void> =>
      store.del(syncNextReceiptKey(identity, receipt))
    );
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

  private runForLink<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return runSerializedByKey(
      this._pendingOperations,
      key,
      (): Promise<T> => runWithCrossContextLock(
        `enbox:sync-next-link:${this._lockNamespace}:${key}`,
        operation,
      ),
    );
  }

  private async waitForPendingOperations(): Promise<void> {
    await Promise.allSettled([...this._pendingOperations.values()]);
  }

  private assertQuarantineCapacity(entries: Iterable<SyncNextQuarantineEntry>): void {
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      count++;
      bytes += entry.encryptedPayload.length;
    }
    if (count > this._maxQuarantinePerLink) {
      throw new Error(
        `SyncNextLedgerStore: quarantine entry capacity ${this._maxQuarantinePerLink} exceeded.`,
      );
    }
    if (bytes > this._maxQuarantineBytesPerLink) {
      throw new Error(
        `SyncNextLedgerStore: quarantine byte capacity ${this._maxQuarantineBytesPerLink} exceeded.`,
      );
    }
  }

  private static validatePullCommit(commit: SyncNextPullPageCommit): void {
    SyncNextLedgerStore.validatePageCommit(
      commit.handledThrough,
      commit.quarantine,
      commit.settled,
      'pull',
    );
  }

  private static validatePushCommit(commit: SyncNextPushPageCommit): void {
    SyncNextLedgerStore.validatePageCommit(
      commit.handledThrough,
      commit.delivery,
      commit.settled,
      'push',
    );
  }

  private static validatePageCommit(
    handledThrough: ProgressToken,
    pending: SyncNextSourceReceipt[],
    settled: SyncNextSettledSource[],
    direction: 'pull' | 'push',
  ): void {
    SyncNextLedgerStore.assertValidToken(handledThrough, `${direction} handled-through token`);
    const seen = new Set<string>();
    for (const receipts of [pending, settled]) {
      for (const receipt of receipts) {
        SyncNextLedgerStore.assertReceiptWithinPage(receipt, handledThrough, direction);
        const key = SyncNextLedgerStore.receiptIdentity(receipt);
        if (seen.has(key)) {
          throw new Error(
            `SyncNextLedgerStore: ${direction} source ${key} has more than one page disposition.`,
          );
        }
        seen.add(key);
      }
    }
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
    return compareSyncNextPosition(incoming, current) >= 0;
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
    return [
      receipt.source.streamId,
      receipt.source.epoch,
      receipt.source.position,
      receipt.messageCid,
    ].join('\u0000');
  }

  private static assertSameLinkDefinition(existing: SyncNextLink, input: SyncNextLinkCreate): void {
    if (
      existing.logicalTargetId !== input.logicalTargetId ||
      JSON.stringify(existing.scope) !== JSON.stringify(input.scope) ||
      JSON.stringify(existing.authorization) !== JSON.stringify(input.authorization)
    ) {
      throw new Error('SyncNextLedgerStore: exact link key resolves to a different durable definition.');
    }
  }

  private static capacity(value: number | undefined, fallback: number, label: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
      throw new RangeError(`SyncNextLedgerStore: ${label} must be a non-negative safe integer.`);
    }
    return resolved;
  }

  private static isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      (error as { code?: unknown }).code === 'LEVEL_NOT_FOUND';
  }
}
