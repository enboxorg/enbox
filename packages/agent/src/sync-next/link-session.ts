import type { ProgressToken } from '@enbox/dwn-sdk-js';
import type { SyncDirection } from '../types/sync.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextPullPage } from './pull-page.js';
import type { SyncNextPushPage } from './push-page.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import type { SyncNextDeliveryObligation, SyncNextDeliveryOutcome } from './types.js';
import type { SyncNextQuarantineAttempt, SyncNextQuarantineRetry } from './quarantine-retry.js';

import { runSerializedByKey } from '@enbox/common';
import {
  compareSyncNextPosition,
  isValidSyncNextToken,
  syncNextLinkIdentity,
  syncNextLogicalTargetId,
} from './ledger-key.js';

const RETRY_DELAY_MS = 1_000;
const COVER_SPARSE_RETRY_LIMIT = 100;

type SparseAttempt = SyncNextQuarantineAttempt;

type PageAttempt = {
  handledThrough?: ProgressToken;
  hasMore: boolean;
  retained: boolean;
};

type DirectionState = {
  requested: boolean;
  running: boolean;
  wakeVersion: number;
  wakeThrough?: ProgressToken;
};

export type SyncNextLinkSessionObserver = {
  onActivity?: () => void;
  onConnectivityChange?: (from: boolean, to: boolean) => void;
  onPullCurrentnessChange?: (from: boolean, to: boolean) => void;
};

export interface SyncNextEndpointOperations {
  block(delayMs?: number): void;
  clear(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** Owns the two independent page loops for one exact replication link. */
export class SyncNextLinkSession {
  private readonly _abortController = new AbortController();
  private readonly _directions: Record<SyncDirection, DirectionState> = {
    pull : { requested: false, running: false, wakeVersion: 0 },
    push : { requested: false, running: false, wakeVersion: 0 },
  };
  private _online = false;
  private _pullCurrent = false;
  private readonly _runs = new Map<string, Promise<void>>();
  private readonly _subscriptions = new Set<() => Promise<void>>();

  public constructor(
    private readonly _target: SyncTarget,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _pullPage: SyncNextPullPage,
    private readonly _pushPage: SyncNextPushPage,
    private readonly _quarantine: SyncNextQuarantineRetry,
    private readonly _reportError: (error: unknown) => void,
    private readonly _endpoint: SyncNextEndpointOperations,
    private readonly _observer: SyncNextLinkSessionObserver = {},
  ) {}

  public get isPullCurrent(): boolean {
    return this._pullCurrent;
  }

  public get isOnline(): boolean {
    return this._online;
  }

  public start(): void {
    this.request('pull');
    this.request('push');
  }

  public addSubscription(close: () => Promise<void>): void {
    this._subscriptions.add(close);
  }

  public removeSubscription(close: () => Promise<void>): void {
    this._subscriptions.delete(close);
  }

  /** Transport loss invalidates currentness but waits for reconnect or the periodic pass. */
  public noteRemoteDisconnected(): void {
    this.setOnline(false);
    this.setPullCurrent(false);
  }

  public request(direction: SyncDirection, schedule = true, wakeThrough?: ProgressToken): void {
    if (direction === 'push' && this._target.authorization.kind === 'role') {
      return;
    }
    const state = this._directions[direction];
    if (direction === 'pull' && wakeThrough !== undefined) {
      SyncNextLinkSession.retainLatestWake(state, wakeThrough);
    }
    state.requested = true;
    state.wakeVersion++;
    if (direction === 'pull') {
      this.setPullCurrent(false);
    }
    if (schedule) {
      this.schedule(direction);
    }
  }

  /** Consume bounded pages until drain, including one finite sparse recovery pass. */
  public cover(
    direction?: SyncDirection,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<void> {
    const runs: Promise<void>[] = [];
    if (direction !== 'push') {
      this.request('pull', false);
      runs.push(this.runDirection('pull', shouldContinue));
    }
    if (direction !== 'pull' && this._target.authorization.kind !== 'role') {
      this.request('push', false);
      runs.push(this.runDirection('push', shouldContinue));
    }
    return Promise.all(runs).then((): void => {});
  }

  public async dispose(): Promise<void> {
    if (!this._abortController.signal.aborted) {
      this._abortController.abort(new DOMException('Sync link session disposed.', 'AbortError'));
    }
    await Promise.allSettled([...this._subscriptions].map(close => close()));
    this._subscriptions.clear();
    await Promise.allSettled([...this._runs.values()]);
  }

  private schedule(direction: SyncDirection): void {
    const state = this._directions[direction];
    if (state.running || this._abortController.signal.aborted) {
      return;
    }
    state.running = true;
    setTimeout((): void => {
      if (this._abortController.signal.aborted) {
        state.running = false;
        return;
      }
      void this.runRequested(direction)
        .catch((error: unknown): void => { this.handleBackgroundError(error); })
        .finally((): void => {
          state.running = false;
          if (state.requested) {
            this.schedule(direction);
          }
        });
    }, 0);
  }

  private runRequested(direction: SyncDirection): Promise<void> {
    return runSerializedByKey(this._runs, direction, async (): Promise<void> => {
      const state = this._directions[direction];
      if (!state.requested || this._abortController.signal.aborted) {
        return;
      }
      state.requested = false;
      const wakeVersion = state.wakeVersion;
      const shouldContinue = (): boolean => !this._abortController.signal.aborted;
      const page = await this.consumePage(direction, shouldContinue);
      const sparse = await this.retrySparse(direction, page.retained, shouldContinue);
      const wakeCovered = direction !== 'pull' || this.clearCoveredWake(page.handledThrough);
      this._observer.onActivity?.();
      if (page.hasMore) {
        this.request(direction);
      } else if (direction === 'pull' && !wakeCovered) {
        await SyncNextLinkSession.yieldTurn(RETRY_DELAY_MS);
        this.request(direction);
      } else if (direction === 'pull' && wakeVersion === state.wakeVersion) {
        this.setPullCurrent(sparse.remaining === 0);
      }
    });
  }

  private runDirection(direction: SyncDirection, shouldContinue: () => boolean): Promise<void> {
    return runSerializedByKey(this._runs, direction, async (): Promise<void> => {
      for (;;) {
        this.assertCurrent(direction, shouldContinue);
        const state = this._directions[direction];
        state.requested = false;
        const wakeVersion = state.wakeVersion;
        const page = await this.consumePage(direction, shouldContinue);
        const sparse = await this.retrySparse(direction, page.retained, shouldContinue);
        const wakeCovered = direction !== 'pull' || this.clearCoveredWake(page.handledThrough);
        if (page.hasMore) {
          this._observer.onActivity?.();
          await SyncNextLinkSession.yieldTurn();
          continue;
        }

        const remaining = await this.retryCoverSparse(direction, shouldContinue, sparse);
        this._observer.onActivity?.();
        this.assertCurrent(direction, shouldContinue);
        if (state.requested || wakeVersion !== state.wakeVersion || !wakeCovered) {
          await SyncNextLinkSession.yieldTurn(wakeCovered ? 1 : RETRY_DELAY_MS);
          continue;
        }
        if (remaining > 0) {
          throw new Error(
            `SyncEngineNext: ${direction} observed feed drain with ${remaining} unresolved obligations.`,
          );
        }
        if (direction === 'pull') {
          this.setPullCurrent(true);
        }
        return;
      }
    });
  }

  private consumePage(direction: SyncDirection, shouldContinue: () => boolean): Promise<PageAttempt> {
    return direction === 'pull'
      ? this.consumePullPage(shouldContinue)
      : this.consumePushPage(shouldContinue);
  }

  private async consumePullPage(shouldContinue: () => boolean): Promise<PageAttempt> {
    const result = await this._endpoint.run(() => this._pullPage.consume(this._target, {
      signal: this._abortController.signal,
      shouldContinue,
    }));
    if (result.aborted === true) {
      this.throwAborted('pull', shouldContinue);
    }
    this._endpoint.clear();
    this.setOnline(true);
    if (result.materializedCids.length > 0) {
      await this._ledger.settleQuarantineForLogicalTarget(
        syncNextLogicalTargetId(this._target.did, this._target.projectionId),
        result.materializedCids,
      );
    }
    return {
      handledThrough : result.handledThrough,
      hasMore        : result.hasMore,
      retained       : result.quarantined > 0,
    };
  }

  private async consumePushPage(shouldContinue: () => boolean): Promise<PageAttempt> {
    const existingBlock = await this.getDeliveryBlock();
    const result = await this._endpoint.run(() => this._pushPage.consume(this._target, {
      endpointBlock : existingBlock,
      signal        : this._abortController.signal,
      shouldContinue,
    }));
    if (result.aborted === true) {
      this.throwAborted('push', shouldContinue);
    }
    if (existingBlock === undefined && result.endpointBlock?.blockScope === 'endpoint') {
      this._endpoint.block(SyncNextLinkSession.endpointDelay(result.endpointBlock));
    } else if (result.delivered > 0) {
      this._endpoint.clear();
    }
    this.setOnline(result.endpointBlock?.reason !== 'transport');
    return { hasMore: result.hasMore, retained: result.retained > 0 };
  }

  private retrySparse(
    direction: SyncDirection,
    force: boolean,
    shouldContinue: () => boolean,
  ): Promise<SparseAttempt> {
    return direction === 'pull'
      ? this.retryQuarantine(force, shouldContinue)
      : this.retryDelivery(force, shouldContinue);
  }

  private retryQuarantine(
    force: boolean,
    shouldContinue: () => boolean,
  ): Promise<SyncNextQuarantineAttempt> {
    return this._endpoint.run(() => this._quarantine.retryOne(
      this._target,
      shouldContinue,
      this._abortController.signal,
      force,
    ));
  }

  private async retryDelivery(
    force: boolean,
    shouldContinue: () => boolean,
  ): Promise<SparseAttempt> {
    const entries = await this._ledger.getDeliveryForLink(syncNextLinkIdentity(this._target));
    if (entries.length === 0 || !shouldContinue()) {
      return { progressed: false, remaining: entries.length };
    }
    entries.sort((left, right) => left.lastAttemptAt.localeCompare(right.lastAttemptAt));
    const entry = force
      ? entries[0]
      : entries.find(candidate => SyncNextLinkSession.deliveryRetryAt(candidate) <= Date.now());
    if (entry === undefined) {
      return { progressed: false, remaining: entries.length };
    }
    const result = await this._endpoint.run(() => this._pushPage.retryDelivery(
      this._target,
      entry,
      shouldContinue,
      this._abortController.signal,
    ));
    if (result.kind !== 'aborted') {
      if (result.outcome?.blockScope === 'endpoint') {
        this._endpoint.block(SyncNextLinkSession.endpointDelay(result.outcome));
      } else {
        this._endpoint.clear();
      }
      this.setOnline(result.outcome?.reason !== 'transport');
    }
    const remaining = (await this._ledger.getDeliveryForLink(syncNextLinkIdentity(this._target))).length;
    return { progressed: result.kind === 'settled', remaining };
  }

  private async retryCoverSparse(
    direction: SyncDirection,
    shouldContinue: () => boolean,
    initial: SparseAttempt,
  ): Promise<number> {
    let result = initial;
    for (let attempts = 0; attempts < COVER_SPARSE_RETRY_LIMIT; attempts++) {
      const forceDeferredPull = direction === 'pull' && result.deferred === true;
      if (result.remaining === 0 || !shouldContinue() || (!result.progressed && !forceDeferredPull)) {
        return result.remaining;
      }
      result = await this.retrySparse(direction, true, shouldContinue);
    }
    return result.remaining;
  }

  private async getDeliveryBlock(): Promise<SyncNextDeliveryOutcome | undefined> {
    const entries = await this._ledger.getDeliveryForLink(syncNextLinkIdentity(this._target));
    return entries.find(entry => entry.outcome.blockScope !== undefined)?.outcome;
  }

  private handleBackgroundError(error: unknown): void {
    this.setOnline(false);
    if (!this._abortController.signal.aborted) {
      this._reportError(error);
    }
  }

  private clearCoveredWake(handledThrough: ProgressToken | undefined): boolean {
    const state = this._directions.pull;
    const required = state.wakeThrough;
    if (required === undefined) {
      return true;
    }
    if (
      handledThrough === undefined ||
      handledThrough.streamId !== required.streamId ||
      handledThrough.epoch !== required.epoch ||
      compareSyncNextPosition(handledThrough, required) < 0
    ) {
      return false;
    }
    state.wakeThrough = undefined;
    return true;
  }

  private assertCurrent(direction: SyncDirection, shouldContinue: () => boolean): void {
    if (!this._abortController.signal.aborted && shouldContinue()) {
      return;
    }
    this.throwAborted(direction, shouldContinue);
  }

  private throwAborted(direction: SyncDirection, shouldContinue: () => boolean): never {
    if (!shouldContinue()) {
      throw new DOMException('Covering sync cancelled.', 'AbortError');
    }
    const error = new Error(`SyncEngineNext: ${direction} link became stale before its page committed.`);
    this._abortController.abort(error);
    throw error;
  }

  private setOnline(online: boolean): void {
    if (this._online !== online) {
      const previous = this._online;
      this._online = online;
      this._observer.onConnectivityChange?.(previous, online);
    }
  }

  private setPullCurrent(current: boolean): void {
    if (this._pullCurrent !== current) {
      const previous = this._pullCurrent;
      this._pullCurrent = current;
      this._observer.onPullCurrentnessChange?.(previous, current);
    }
  }

  private static deliveryRetryAt(entry: SyncNextDeliveryObligation): number {
    return entry.outcome.retryAt !== undefined && entry.outcome.retryAt > Date.now()
      ? entry.outcome.retryAt
      : Date.parse(entry.lastAttemptAt) + RETRY_DELAY_MS;
  }

  private static endpointDelay(outcome: SyncNextDeliveryOutcome): number {
    return outcome.retryAt !== undefined && outcome.retryAt > Date.now()
      ? outcome.retryAt - Date.now()
      : RETRY_DELAY_MS;
  }

  private static retainLatestWake(state: DirectionState, wakeThrough: ProgressToken): void {
    if (!isValidSyncNextToken(wakeThrough)) {
      return;
    }
    const current = state.wakeThrough;
    if (
      current === undefined ||
      current.streamId !== wakeThrough.streamId ||
      current.epoch !== wakeThrough.epoch ||
      compareSyncNextPosition(wakeThrough, current) > 0
    ) {
      state.wakeThrough = structuredClone(wakeThrough);
    }
  }

  private static yieldTurn(delay = 1): Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, delay); });
  }
}
