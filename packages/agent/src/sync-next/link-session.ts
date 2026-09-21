import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { SyncDirection } from '../types/sync.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import type { SyncNextDeliveryRetry } from './delivery-retry.js';
import type { SyncNextPullPage } from './pull-page.js';
import type { SyncNextPushPage } from './push-page.js';
import type { SyncNextQuarantineRetry } from './quarantine-retry.js';
import { SyncNextWorkPump } from './work-pump.js';

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

type CoveringRun = {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
  head?: ProgressToken;
  shouldContinue: () => boolean;
};

/** A covering operation reached its finite feed head but retained sparse obligations. */
export class SyncNextIncompleteError extends Error {
  public constructor(direction: SyncDirection, count: number) {
    super(`SyncEngineNext: ${direction} reached its captured head with ${count} unresolved obligations.`);
    this.name = 'SyncNextIncompleteError';
  }
}

/** Four independent, coalesced activities for one exact link. */
export class SyncNextLinkSession {
  private readonly _abortController = new AbortController();
  private _deliveryIndex = 0;
  private readonly _deliveryNotBefore = new Map<string, number>();
  private readonly _deliveryPump: SyncNextWorkPump;
  private _pullCover?: CoveringRun;
  private _pullCurrent = false;
  private _pullFeedDrained = false;
  private _pullFailures = 0;
  private readonly _pullPagePump: SyncNextWorkPump;
  private _quarantineIndex = 0;
  private readonly _quarantineNotBefore = new Map<string, number>();
  private readonly _quarantinePump: SyncNextWorkPump;
  private _pushCover?: CoveringRun;
  private _pushFailures = 0;
  private readonly _pushPagePump: SyncNextWorkPump;
  private readonly _subscriptions = new Set<() => Promise<void>>();
  private _online = false;

  public constructor(
    private readonly _target: SyncTarget,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _pullPage: SyncNextPullPage,
    private readonly _pushPage: SyncNextPushPage,
    private readonly _quarantineRetry: SyncNextQuarantineRetry,
    private readonly _deliveryRetry: SyncNextDeliveryRetry,
    private readonly _reportError: (error: unknown) => void,
  ) {
    this._pullPagePump = new SyncNextWorkPump(
      (): Promise<void> => this.consumePullPage(),
      (error): void => this.handlePageError('pull', error),
    );
    this._pushPagePump = new SyncNextWorkPump(
      (): Promise<void> => this.consumePushPage(),
      (error): void => this.handlePageError('push', error),
    );
    this._quarantinePump = new SyncNextWorkPump(
      (): Promise<void> => this.retryQuarantine(),
      (error): void => this.handleRetryError('pull', error),
    );
    this._deliveryPump = new SyncNextWorkPump(
      (): Promise<void> => this.retryDelivery(),
      (error): void => this.handleRetryError('push', error),
    );
  }

  public start(): void {
    this.requestPull();
    if (this._target.authorization.kind !== 'role') {
      this.requestPush();
    }
    if (this._pullCover === undefined) {
      this._quarantinePump.request();
    }
    if (this._pushCover === undefined) {
      this._deliveryPump.request();
    }
  }

  public get isPullCurrent(): boolean {
    return this._pullCurrent;
  }

  public get isOnline(): boolean {
    return this._online;
  }

  public addSubscription(close: () => Promise<void>): void {
    this._subscriptions.add(close);
  }

  public requestPull(): void {
    this._pullCurrent = false;
    this._pullFeedDrained = false;
    this._pullPagePump.request();
  }

  public requestPush(): void {
    if (this._target.authorization.kind !== 'role') {
      this._pushPagePump.request();
    }
  }

  /** Run the same page pumps to one finite captured head. */
  public cover(
    direction?: SyncDirection,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<void> {
    const runs: Promise<void>[] = [];
    if (direction !== 'push') {
      this._pullCover ??= SyncNextLinkSession.coveringRun(shouldContinue);
      runs.push(this._pullCover.promise);
      this.requestPull();
    }
    if (direction !== 'pull' && this._target.authorization.kind !== 'role') {
      this._pushCover ??= SyncNextLinkSession.coveringRun(shouldContinue);
      runs.push(this._pushCover.promise);
      this.requestPush();
    }
    return Promise.all(runs).then((): void => {});
  }

  public async dispose(): Promise<void> {
    if (!this._abortController.signal.aborted) {
      this._abortController.abort(new DOMException('Sync link session disposed.', 'AbortError'));
    }
    this._pullPagePump.dispose();
    this._pushPagePump.dispose();
    this._quarantinePump.dispose();
    this._deliveryPump.dispose();
    const error = this._abortController.signal.reason;
    this.rejectCover('pull', error);
    this.rejectCover('push', error);
    await Promise.allSettled([...this._subscriptions].map(close => close()));
    this._subscriptions.clear();
    await Promise.all([
      this._pullPagePump.waitForIdle(),
      this._pushPagePump.waitForIdle(),
      this._quarantinePump.waitForIdle(),
      this._deliveryPump.waitForIdle(),
    ]);
  }

  private async consumePullPage(): Promise<void> {
    const result = await this._pullPage.consume(this._target, {
      head           : this._pullCover?.head,
      signal         : this._abortController.signal,
      shouldContinue : (): boolean => this.shouldContinue('pull'),
    });
    if (result.aborted === true) {
      this.rejectInterruptedCover('pull');
      return;
    }
    this._pullFailures = 0;
    this._online = true;
    for (const messageCid of result.materializedCids) {
      await this._ledger.settleQuarantineForLogicalTarget(
        `${this._target.did}^${this._target.projectionId}`,
        messageCid,
      );
    }
    if (this._pullCover !== undefined) {
      this._pullCover.head ??= result.capturedHead;
      if (this._pullCover.head === undefined) {
        throw new Error('SyncEngineNext: remote does not support captured query heads.');
      }
    }
    this._quarantinePump.request();
    if (result.hasMore) {
      if (!this.shouldContinue('pull')) {
        this.rejectInterruptedCover('pull');
        return;
      }
      this._pullPagePump.request();
      return;
    }
    this._pullFeedDrained = true;
    this._pullCurrent = (await this.getQuarantine()).length === 0;
    await this.finishCover('pull');
  }

  private async consumePushPage(): Promise<void> {
    const result = await this._pushPage.consume(this._target, {
      head           : this._pushCover?.head,
      signal         : this._abortController.signal,
      shouldContinue : (): boolean => this.shouldContinue('push'),
    });
    if (result.aborted === true) {
      this.rejectInterruptedCover('push');
      return;
    }
    this._pushFailures = 0;
    this._online = true;
    if (this._pushCover !== undefined) {
      this._pushCover.head ??= result.capturedHead;
      if (this._pushCover.head === undefined) {
        throw new Error('SyncEngineNext: local feed did not return a captured query head.');
      }
    }
    this._deliveryPump.request();
    if (result.hasMore) {
      if (!this.shouldContinue('push')) {
        this.rejectInterruptedCover('push');
        return;
      }
      this._pushPagePump.request();
      return;
    }
    await this.finishCover('push');
  }

  private async retryQuarantine(): Promise<void> {
    const entries = await this.getQuarantine();
    if (entries.length === 0 || this._abortController.signal.aborted) {
      return;
    }
    const selected = this.selectEligible(entries, this._quarantineNotBefore, this._quarantineIndex);
    if (selected === undefined) {
      this._quarantinePump.request(SyncNextLinkSession.nextEligibilityDelay(entries, this._quarantineNotBefore));
      return;
    }
    const entry = entries[selected];
    this._quarantineIndex = (selected + 1) % entries.length;
    const result = await this._quarantineRetry.retry(
      this._target,
      entry,
      (): boolean => !this._abortController.signal.aborted,
      this._abortController.signal,
    );
    if (result.kind === 'pending') {
      this._quarantineNotBefore.set(
        SyncNextLinkSession.receiptKey(entry),
        Date.now() + SyncNextLinkSession.retryDelay(entry.attempts),
      );
      this._quarantinePump.request(SyncNextLinkSession.nextEligibilityDelay(entries, this._quarantineNotBefore));
    } else {
      this._quarantineNotBefore.delete(SyncNextLinkSession.receiptKey(entry));
      if (entries.length > 1) {
        this._quarantinePump.request();
      }
    }
    if (result.kind === 'settled' && entries.length === 1 && this._pullFeedDrained) {
      this._pullCurrent = true;
    }
  }

  private async retryDelivery(): Promise<void> {
    const entries = await this._ledger.getDeliveryForLink(SyncNextLinkSession.identity(this._target));
    if (entries.length === 0 || this._abortController.signal.aborted) {
      return;
    }
    const selected = this.selectEligible(entries, this._deliveryNotBefore, this._deliveryIndex);
    if (selected === undefined) {
      this._deliveryPump.request(SyncNextLinkSession.nextEligibilityDelay(entries, this._deliveryNotBefore));
      return;
    }
    const entry = entries[selected];
    this._deliveryIndex = (selected + 1) % entries.length;
    const result = await this._deliveryRetry.retry(
      this._target,
      entry,
      (): boolean => !this._abortController.signal.aborted,
      this._abortController.signal,
    );
    if (result.kind === 'pending') {
      const retryAfter = entry.outcome.retryAfter === undefined ? undefined : Date.parse(entry.outcome.retryAfter);
      this._deliveryNotBefore.set(
        SyncNextLinkSession.receiptKey(entry),
        retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > Date.now()
          ? retryAfter
          : Date.now() + SyncNextLinkSession.retryDelay(entry.attempts),
      );
      this._deliveryPump.request(SyncNextLinkSession.nextEligibilityDelay(entries, this._deliveryNotBefore));
    } else {
      this._deliveryNotBefore.delete(SyncNextLinkSession.receiptKey(entry));
      if (entries.length > 1) {
        this._deliveryPump.request();
      }
    }
  }

  private async finishCover(direction: SyncDirection): Promise<void> {
    const cover = direction === 'pull' ? this._pullCover : this._pushCover;
    if (cover === undefined) {
      return;
    }
    let pendingCount: number;
    if (direction === 'pull') {
      for (const entry of await this.getQuarantine()) {
        if (!this.shouldContinue(direction)) {
          this.rejectInterruptedCover(direction);
          return;
        }
        await this._quarantineRetry.retry(
          this._target,
          entry,
          (): boolean => this.shouldContinue(direction),
          this._abortController.signal,
        );
      }
      if (!this.shouldContinue(direction)) {
        this.rejectInterruptedCover(direction);
        return;
      }
      pendingCount = (await this.getQuarantine()).length;
    } else {
      for (const entry of await this._ledger.getDeliveryForLink(SyncNextLinkSession.identity(this._target))) {
        if (!this.shouldContinue(direction)) {
          this.rejectInterruptedCover(direction);
          return;
        }
        await this._deliveryRetry.retry(
          this._target,
          entry,
          (): boolean => this.shouldContinue(direction),
          this._abortController.signal,
        );
      }
      if (!this.shouldContinue(direction)) {
        this.rejectInterruptedCover(direction);
        return;
      }
      pendingCount = (await this._ledger.getDeliveryForLink(
        SyncNextLinkSession.identity(this._target),
      )).length;
    }
    if (pendingCount > 0) {
      this.rejectCover(direction, new SyncNextIncompleteError(direction, pendingCount));
    } else {
      cover.resolve();
      this.clearCover(direction);
    }
  }

  private handlePageError(direction: SyncDirection, error: unknown): void {
    this._online = false;
    this.rejectCover(direction, error);
    this._reportError(error);
    if (!this._abortController.signal.aborted) {
      const attempts = direction === 'pull' ? ++this._pullFailures : ++this._pushFailures;
      (direction === 'pull' ? this._pullPagePump : this._pushPagePump)
        .request(SyncNextLinkSession.retryDelay(attempts));
    }
  }

  private getQuarantine(): ReturnType<SyncNextLedgerStore['getQuarantineForLogicalTarget']> {
    return this._ledger.getQuarantineForLogicalTarget(
      `${this._target.did}^${this._target.projectionId}`,
    );
  }

  private selectEligible<T extends { messageCid: string; source: ProgressToken }>(
    entries: readonly T[],
    notBefore: ReadonlyMap<string, number>,
    start: number,
  ): number | undefined {
    const now = Date.now();
    for (let offset = 0; offset < entries.length; offset++) {
      const index = (start + offset) % entries.length;
      if ((notBefore.get(SyncNextLinkSession.receiptKey(entries[index])) ?? 0) <= now) {
        return index;
      }
    }
  }

  private static nextEligibilityDelay<T extends { messageCid: string; source: ProgressToken }>(
    entries: readonly T[],
    notBefore: ReadonlyMap<string, number>,
  ): number {
    const now = Date.now();
    const next = Math.min(...entries.map(entry =>
      notBefore.get(SyncNextLinkSession.receiptKey(entry)) ?? now
    ));
    return Math.max(0, next - now);
  }

  private static retryDelay(attempts: number): number {
    const exponent = Math.min(Math.max(0, attempts - 1), 6);
    return Math.min(RETRY_DELAY_MS * (2 ** exponent), MAX_RETRY_DELAY_MS);
  }

  private static receiptKey(entry: { messageCid: string; source: ProgressToken }): string {
    return `${entry.source.streamId}\u0000${entry.source.epoch}\u0000${entry.source.position}\u0000${entry.messageCid}`;
  }

  private handleRetryError(direction: SyncDirection, error: unknown): void {
    this._reportError(error);
    if (!this._abortController.signal.aborted) {
      (direction === 'pull' ? this._quarantinePump : this._deliveryPump).request(RETRY_DELAY_MS);
    }
  }

  private rejectCover(direction: SyncDirection, error: unknown): void {
    const cover = direction === 'pull' ? this._pullCover : this._pushCover;
    if (cover !== undefined) {
      cover.reject(error);
      this.clearCover(direction);
    }
  }

  private clearCover(direction: SyncDirection): void {
    if (direction === 'pull') {
      this._pullCover = undefined;
    } else {
      this._pushCover = undefined;
    }
  }

  private shouldContinue(direction: SyncDirection): boolean {
    const cover = direction === 'pull' ? this._pullCover : this._pushCover;
    return !this._abortController.signal.aborted && (cover?.shouldContinue() ?? true);
  }

  private rejectInterruptedCover(direction: SyncDirection): void {
    const cover = direction === 'pull' ? this._pullCover : this._pushCover;
    if (cover !== undefined && !cover.shouldContinue()) {
      this.rejectCover(direction, new DOMException('Covering sync cancelled.', 'AbortError'));
    }
  }

  private static coveringRun(shouldContinue: () => boolean): CoveringRun {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, reject, resolve, shouldContinue };
  }

  private static identity(target: SyncTarget): {
    authorizationEpoch: string;
    projectionId: string;
    remoteEndpoint: string;
    tenantDid: string;
  } {
    return {
      authorizationEpoch : target.authorizationEpoch,
      projectionId       : target.projectionId,
      remoteEndpoint     : target.dwnUrl,
      tenantDid          : target.did,
    };
  }
}
