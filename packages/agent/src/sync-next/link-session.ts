import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { SyncDirection } from '../types/sync.js';
import type { SyncNextDeliveryOutcome } from './types.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import type { SyncNextDeliveryRetry } from './delivery-retry.js';
import type { SyncNextPullPage } from './pull-page.js';
import type { SyncNextPushPage } from './push-page.js';
import type { SyncNextQuarantineCoordinator } from './quarantine-coordinator.js';

import { SyncNextEndpointBackoffError } from './endpoint-gate.js';
import { SyncNextWorkPump } from './work-pump.js';

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const COVER_SPARSE_RETRY_LIMIT = 100;

type CoveringRun = {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
  head?: ProgressToken;
  shouldContinue: () => boolean;
};

type DeliveryAttempt = {
  progressed: boolean;
  remaining: number;
};

export type SyncNextLinkSessionObserver = {
  onConnectivityChange?: (from: boolean, to: boolean) => void;
  onPullCurrentnessChange?: (from: boolean, to: boolean) => void;
};

export interface SyncNextEndpointOperations {
  block(delayMs?: number): void;
  clear(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

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
  private _deliveryRetryActive?: Promise<DeliveryAttempt>;
  private _forceDeliveryRetry = false;
  private _pullCover?: CoveringRun;
  private _pullCurrent = false;
  private _pullFeedDrained = false;
  private _pullFailures = 0;
  private _pullNotBefore = 0;
  private readonly _pullPagePump: SyncNextWorkPump;
  private _quarantineNotBefore = 0;
  private readonly _quarantinePump: SyncNextWorkPump;
  private _pushCover?: CoveringRun;
  private _pushFailures = 0;
  private _pushNotBefore = 0;
  private readonly _pushPagePump: SyncNextWorkPump;
  private readonly _subscriptions = new Set<() => Promise<void>>();
  private _online = false;

  public constructor(
    private readonly _target: SyncTarget,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _pullPage: SyncNextPullPage,
    private readonly _pushPage: SyncNextPushPage,
    private readonly _quarantine: SyncNextQuarantineCoordinator,
    private readonly _deliveryRetry: SyncNextDeliveryRetry,
    private readonly _reportError: (error: unknown) => void,
    private readonly _endpoint: SyncNextEndpointOperations = {
      block : (): void => {},
      clear : (): void => {},
      run   : operation => operation(),
    },
    private readonly _observer: SyncNextLinkSessionObserver = {},
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
      async (): Promise<void> => { await this.retryDelivery(); },
      (error): void => this.handleRetryError('push', error),
    );
  }

  public start(requestPages = true): void {
    if (requestPages) {
      this.requestPull();
      if (this._target.authorization.kind !== 'role') {
        this.requestPush();
      }
    }
    if (this._pullCover === undefined) {
      this._quarantinePump.request(Math.max(0, this._quarantineNotBefore - Date.now()));
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

  public removeSubscription(close: () => Promise<void>): void {
    this._subscriptions.delete(close);
  }

  /** Transport loss invalidates currentness but does not itself start an HTTP catch-up request. */
  public noteRemoteDisconnected(): void {
    this.setOnline(false);
    this.setPullCurrent(false);
    this._pullFeedDrained = false;
  }

  public requestPull(force = false): void {
    this.setPullCurrent(false);
    this._pullFeedDrained = false;
    if (force) {
      this._pullNotBefore = 0;
    }
    this._pullPagePump.request(Math.max(0, this._pullNotBefore - Date.now()));
  }

  public requestPush(force = false): void {
    if (this._target.authorization.kind !== 'role') {
      if (force) {
        this._pushNotBefore = 0;
      }
      this._pushPagePump.request(Math.max(0, this._pushNotBefore - Date.now()));
    }
  }

  public clearRetryBackoff(): void {
    this._pullFailures = 0;
    this._pullNotBefore = 0;
    this._pushFailures = 0;
    this._pushNotBefore = 0;
    this._deliveryNotBefore.clear();
    this._forceDeliveryRetry = true;
    this._quarantineNotBefore = 0;
    this._quarantine.clearBackoff(this._target);
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
      this.requestPull(true);
    }
    if (direction !== 'pull' && this._target.authorization.kind !== 'role') {
      this._pushCover ??= SyncNextLinkSession.coveringRun(shouldContinue);
      runs.push(this._pushCover.promise);
      this.requestPush(true);
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
    const result = await this._endpoint.run(() => this._pullPage.consume(this._target, {
      head           : this._pullCover?.head,
      signal         : this._abortController.signal,
      shouldContinue : (): boolean => this.shouldContinue('pull'),
    }));
    if (result.aborted === true) {
      this.rejectAbortedCover('pull');
      return;
    }
    this._pullFailures = 0;
    this._pullNotBefore = 0;
    this._endpoint.clear();
    this.setOnline(true);
    for (const messageCid of result.materializedCids) {
      await this._ledger.settleQuarantineForLogicalTarget(
        `${this._target.did}^${this._target.projectionId}`,
        messageCid,
      );
    }
    if (this._pullCover !== undefined) {
      this._pullCover.head ??= result.capturedHead;
      if (this._pullCover.head === undefined && result.hasMore) {
        throw new Error('SyncEngineNext: remote does not support captured query heads.');
      }
    }
    if (this._pullCover === undefined) {
      this._quarantinePump.request(Math.max(0, this._quarantineNotBefore - Date.now()));
    }
    if (result.hasMore) {
      if (!this.shouldContinue('pull')) {
        this.rejectInterruptedCover('pull');
        return;
      }
      this.requestPull();
      return;
    }
    this._pullFeedDrained = true;
    this.setPullCurrent((await this.getQuarantine()).length === 0);
    await this.finishCover('pull');
  }

  private async consumePushPage(): Promise<void> {
    const existingBlock = await this.getDeliveryBlock();
    const result = await this._endpoint.run(() => this._pushPage.consume(this._target, {
      endpointBlock  : existingBlock,
      head           : this._pushCover?.head,
      signal         : this._abortController.signal,
      shouldContinue : (): boolean => this.shouldContinue('push'),
    }));
    if (result.aborted === true) {
      this.rejectAbortedCover('push');
      return;
    }
    if (
      existingBlock === undefined &&
      result.endpointBlock?.blockScope === 'endpoint'
    ) {
      this._endpoint.block(SyncNextLinkSession.endpointDelay(result.endpointBlock));
    } else if (result.delivered > 0) {
      this._endpoint.clear();
    }
    this.setOnline(result.endpointBlock?.reason !== 'transport');
    this._pushFailures = 0;
    this._pushNotBefore = 0;
    if (this._pushCover !== undefined) {
      this._pushCover.head ??= result.capturedHead;
      if (this._pushCover.head === undefined && result.hasMore) {
        throw new Error('SyncEngineNext: local feed did not return a captured query head.');
      }
    }
    if (this._pushCover === undefined) {
      this._deliveryPump.request();
    }
    if (result.hasMore) {
      if (!this.shouldContinue('push')) {
        this.rejectInterruptedCover('push');
        return;
      }
      this.requestPush();
      return;
    }
    await this.finishCover('push');
  }

  private async retryQuarantine(): Promise<void> {
    if (this._abortController.signal.aborted) {
      return;
    }
    const entries = await this.getQuarantine();
    if (entries.length === 0) {
      this._quarantineNotBefore = 0;
      if (this._pullFeedDrained) {
        this.setPullCurrent(true);
      }
      return;
    }
    const result = await this._endpoint.run(() => this._quarantine.retryOne(
      this._target,
      (): boolean => !this._abortController.signal.aborted,
      this._abortController.signal,
    ));
    if (result.remaining > 0 && result.kind !== 'aborted') {
      this._quarantineNotBefore = Date.now() + (result.nextDelay ?? 0);
      this._quarantinePump.request(Math.max(0, this._quarantineNotBefore - Date.now()));
    }
    if (result.remaining === 0 && this._pullFeedDrained) {
      this._quarantineNotBefore = 0;
      this.setPullCurrent(true);
    }
  }

  private retryDelivery(): Promise<DeliveryAttempt> {
    if (this._deliveryRetryActive !== undefined) {
      return this._deliveryRetryActive;
    }
    const active = this.doRetryDelivery().finally((): void => {
      if (this._deliveryRetryActive === active) {
        this._deliveryRetryActive = undefined;
      }
    });
    this._deliveryRetryActive = active;
    return active;
  }

  private async doRetryDelivery(): Promise<DeliveryAttempt> {
    const entries = await this._ledger.getDeliveryForLink(SyncNextLinkSession.identity(this._target));
    if (entries.length === 0 || this._abortController.signal.aborted) {
      return { progressed: false, remaining: entries.length };
    }
    if (!this._forceDeliveryRetry) {
      for (const entry of entries) {
        const retryAfter = SyncNextLinkSession.retryAfter(entry.outcome);
        if (retryAfter !== undefined && retryAfter > Date.now()) {
          this._deliveryNotBefore.set(SyncNextLinkSession.receiptKey(entry), retryAfter);
        }
      }
    }
    const selected = this.selectEligible(entries, this._deliveryNotBefore, this._deliveryIndex);
    if (selected === undefined) {
      this._deliveryPump.request(SyncNextLinkSession.nextEligibilityDelay(entries, this._deliveryNotBefore));
      return { progressed: false, remaining: entries.length };
    }
    const entry = entries[selected];
    this._forceDeliveryRetry = false;
    this._deliveryIndex = (selected + 1) % entries.length;
    const result = await this._endpoint.run(() => this._deliveryRetry.retry(
      this._target,
      entry,
      (): boolean => !this._abortController.signal.aborted,
      this._abortController.signal,
    ));
    if (result.kind !== 'aborted') {
      if (result.outcome?.blockScope === 'endpoint') {
        this._endpoint.block(SyncNextLinkSession.endpointDelay(result.outcome, entry.attempts));
      } else {
        this._endpoint.clear();
      }
      this.setOnline(result.outcome?.reason !== 'transport');
    }
    if (result.kind === 'pending') {
      const outcome = result.outcome ?? entry.outcome;
      const notBefore = SyncNextLinkSession.outcomeNotBefore(outcome, entry.attempts);
      this._deliveryNotBefore.set(
        SyncNextLinkSession.receiptKey(entry),
        notBefore,
      );
      this._pushNotBefore = Math.max(this._pushNotBefore, notBefore);
      this._deliveryPump.request(SyncNextLinkSession.nextEligibilityDelay(entries, this._deliveryNotBefore));
    } else {
      this._deliveryNotBefore.delete(SyncNextLinkSession.receiptKey(entry));
      this._pushNotBefore = 0;
      this._pushFailures = 0;
      if (entries.length > 1 && this._pushCover === undefined) {
        this._deliveryPump.request();
      }
    }
    const remaining = (await this._ledger.getDeliveryForLink(SyncNextLinkSession.identity(this._target))).length;
    if (result.kind === 'settled') {
      this.requestPush();
    }
    return { progressed: result.kind === 'settled', remaining };
  }

  private async finishCover(direction: SyncDirection): Promise<void> {
    const cover = direction === 'pull' ? this._pullCover : this._pushCover;
    if (cover === undefined) {
      return;
    }
    let pendingCount: number;
    if (direction === 'pull') {
      pendingCount = await this.retryCoverQuarantine();
    } else {
      pendingCount = await this.retryCoverDelivery();
    }
    if (!this.shouldContinue(direction)) {
      this.rejectInterruptedCover(direction);
      return;
    }
    if (pendingCount > 0) {
      this.rejectCover(direction, new SyncNextIncompleteError(direction, pendingCount));
    } else {
      cover.resolve();
      this.clearCover(direction);
    }
  }

  /** Give distinct recoverable receipts one bounded pass without hot-looping a poison row. */
  private async retryCoverQuarantine(): Promise<number> {
    let remaining = 0;
    for (let attempts = 0; attempts < COVER_SPARSE_RETRY_LIMIT; attempts++) {
      const result = await this._endpoint.run(() => this._quarantine.retryOne(
        this._target,
        (): boolean => this.shouldContinue('pull'),
        this._abortController.signal,
      ));
      remaining = result.remaining;
      if (remaining === 0 || result.kind !== 'settled' || !this.shouldContinue('pull')) {
        return remaining;
      }
    }
    return remaining;
  }

  /** Drain only consecutively successful delivery retries, capped to one sparse page. */
  private async retryCoverDelivery(): Promise<number> {
    let remaining = 0;
    for (let attempts = 0; attempts < COVER_SPARSE_RETRY_LIMIT; attempts++) {
      const result = await this.retryDelivery();
      remaining = result.remaining;
      if (remaining === 0 || !result.progressed || !this.shouldContinue('push')) {
        return result.remaining;
      }
    }
    return remaining;
  }

  private handlePageError(direction: SyncDirection, error: unknown): void {
    this.setOnline(false);
    this.rejectCover(direction, error);
    if (error instanceof SyncNextEndpointBackoffError) {
      const notBefore = Date.now() + error.retryAfterMs;
      if (direction === 'pull') {
        this._pullNotBefore = notBefore;
        this.requestPull();
      } else {
        this._pushNotBefore = notBefore;
        this.requestPush();
      }
      return;
    }
    this._reportError(error);
    if (!this._abortController.signal.aborted) {
      const attempts = direction === 'pull' ? ++this._pullFailures : ++this._pushFailures;
      const notBefore = Date.now() + SyncNextLinkSession.retryDelay(attempts);
      if (direction === 'pull') {
        this._pullNotBefore = notBefore;
        this.requestPull();
      } else {
        this._pushNotBefore = notBefore;
        this.requestPush();
      }
    }
  }

  private getQuarantine(): ReturnType<SyncNextLedgerStore['getQuarantineForLogicalTarget']> {
    return this._ledger.getQuarantineForLogicalTarget(
      `${this._target.did}^${this._target.projectionId}`,
    );
  }

  private async getDeliveryBlock(): Promise<SyncNextDeliveryOutcome | undefined> {
    const local = await this._ledger.getDeliveryForLink(SyncNextLinkSession.identity(this._target));
    const linkBlock = local.find(entry => SyncNextLinkSession.blocksLink(entry.outcome));
    if (linkBlock !== undefined) {
      return linkBlock.outcome;
    }
    const endpoint = await this._ledger.getDeliveryForEndpoint(this._target.dwnUrl);
    return endpoint.find(entry => SyncNextLinkSession.blocksEveryLinkAtEndpoint(entry.outcome))?.outcome;
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

  private static outcomeNotBefore(outcome: SyncNextDeliveryOutcome, attempts: number): number {
    const retryAfter = SyncNextLinkSession.retryAfter(outcome);
    return retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > Date.now()
      ? retryAfter
      : Date.now() + SyncNextLinkSession.retryDelay(attempts);
  }

  private static retryAfter(outcome: SyncNextDeliveryOutcome): number | undefined {
    if (outcome.retryAfter === undefined) {
      return undefined;
    }
    const retryAfter = Date.parse(outcome.retryAfter);
    return Number.isFinite(retryAfter) ? retryAfter : undefined;
  }

  private static endpointDelay(outcome: SyncNextDeliveryOutcome, attempts = 1): number {
    const retryAfter = SyncNextLinkSession.retryAfter(outcome);
    return retryAfter !== undefined && retryAfter > Date.now()
      ? retryAfter - Date.now()
      : SyncNextLinkSession.retryDelay(attempts);
  }

  private static blocksLink(outcome: SyncNextDeliveryOutcome): boolean {
    return outcome.blockScope !== undefined;
  }

  private static blocksEveryLinkAtEndpoint(outcome: SyncNextDeliveryOutcome): boolean {
    return outcome.blockScope === 'endpoint';
  }

  private static receiptKey(entry: { messageCid: string; source: ProgressToken }): string {
    return `${entry.source.streamId}\u0000${entry.source.epoch}\u0000${entry.source.position}\u0000${entry.messageCid}`;
  }

  private handleRetryError(direction: SyncDirection, error: unknown): void {
    if (error instanceof SyncNextEndpointBackoffError) {
      (direction === 'pull' ? this._quarantinePump : this._deliveryPump).request(error.retryAfterMs);
      return;
    }
    this._reportError(error);
    if (!this._abortController.signal.aborted) {
      (direction === 'pull' ? this._quarantinePump : this._deliveryPump).request(RETRY_DELAY_MS);
    }
  }

  private setOnline(online: boolean): void {
    if (this._online === online) {
      return;
    }
    const previous = this._online;
    this._online = online;
    this._observer.onConnectivityChange?.(previous, online);
  }

  private setPullCurrent(current: boolean): void {
    if (this._pullCurrent === current) {
      return;
    }
    const previous = this._pullCurrent;
    this._pullCurrent = current;
    this._observer.onPullCurrentnessChange?.(previous, current);
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

  private rejectAbortedCover(direction: SyncDirection): void {
    const cover = direction === 'pull' ? this._pullCover : this._pushCover;
    if (cover === undefined) {
      return;
    }
    const error = cover.shouldContinue()
      ? new Error(`SyncEngineNext: ${direction} link became stale before its page committed.`)
      : new DOMException('Covering sync cancelled.', 'AbortError');
    this.rejectCover(direction, error);
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
