import type { SyncDirection } from '../types/sync.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncNextPullPage } from './pull-page.js';
import type { SyncNextPushPage } from './push-page.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import type { SyncNextDeliveryObligation, SyncNextDeliveryOutcome } from './types.js';
import type { SyncNextQuarantineAttempt, SyncNextQuarantineRetry } from './quarantine-retry.js';

import { runSerializedByKey } from '@enbox/common';
import { SyncNextEndpointBackoffError } from './endpoint-gate.js';
import { SyncNextWorkPump } from './work-pump.js';
import { syncNextLinkIdentity, syncNextLogicalTargetId } from './ledger-key.js';

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const COVER_SPARSE_RETRY_LIMIT = 100;

type SparseAttempt = {
  attempted: boolean;
  progressed: boolean;
  remaining: number;
};

type PageAttempt = {
  hasMore: boolean;
  retained: boolean;
};

type DirectionState = {
  failures: number;
  notBefore: number;
  pump: SyncNextWorkPump;
  requested: boolean;
  wakeVersion: number;
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

/** Owns the two independent page loops for one exact replication link. */
export class SyncNextLinkSession {
  private readonly _abortController = new AbortController();
  private _online = false;
  private readonly _pull: DirectionState;
  private _pullCurrent = false;
  private readonly _push: DirectionState;
  private readonly _runs = new Map<string, Promise<void>>();
  private readonly _subscriptions = new Set<() => Promise<void>>();

  public constructor(
    private readonly _target: SyncTarget,
    private readonly _ledger: SyncNextLedgerStore,
    private readonly _pullPage: SyncNextPullPage,
    private readonly _pushPage: SyncNextPushPage,
    private readonly _quarantine: SyncNextQuarantineRetry,
    private readonly _reportError: (error: unknown) => void,
    private readonly _endpoint: SyncNextEndpointOperations = {
      block : (): void => {},
      clear : (): void => {},
      run   : operation => operation(),
    },
    private readonly _observer: SyncNextLinkSessionObserver = {},
  ) {
    this._pull = {
      failures  : 0,
      notBefore : 0,
      pump      : new SyncNextWorkPump(
        (): Promise<void> => this.runRequested('pull'),
        (error): void => this.handleBackgroundError('pull', error),
      ),
      requested   : false,
      wakeVersion : 0,
    };
    this._push = {
      failures  : 0,
      notBefore : 0,
      pump      : new SyncNextWorkPump(
        (): Promise<void> => this.runRequested('push'),
        (error): void => this.handleBackgroundError('push', error),
      ),
      requested   : false,
      wakeVersion : 0,
    };
  }

  public get isPullCurrent(): boolean {
    return this._pullCurrent;
  }

  public get isOnline(): boolean {
    return this._online;
  }

  public start(): void {
    this.requestPull();
    this.requestPush();
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

  public requestPull(force = false): void {
    this.requestDirection('pull', force);
  }

  public requestPush(force = false): void {
    if (this._target.authorization.kind === 'role') {
      return;
    }
    this.requestDirection('push', force);
  }

  public clearRetryBackoff(): void {
    for (const state of [this._pull, this._push]) {
      state.failures = 0;
      state.notBefore = 0;
    }
  }

  /** Consume bounded pages until drain, including one finite sparse recovery pass. */
  public cover(
    direction?: SyncDirection,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<void> {
    const runs: Promise<void>[] = [];
    if (direction !== 'push') {
      this.requestDirection('pull', true, false);
      runs.push(this.runDirection('pull', shouldContinue));
    }
    if (direction !== 'pull' && this._target.authorization.kind !== 'role') {
      this.requestDirection('push', true, false);
      runs.push(this.runDirection('push', shouldContinue));
    }
    return Promise.all(runs).then((): void => {});
  }

  public async dispose(): Promise<void> {
    if (!this._abortController.signal.aborted) {
      this._abortController.abort(new DOMException('Sync link session disposed.', 'AbortError'));
    }
    this._pull.pump.dispose();
    this._push.pump.dispose();
    await Promise.allSettled([...this._subscriptions].map(close => close()));
    this._subscriptions.clear();
    await Promise.allSettled([
      this._pull.pump.waitForIdle(),
      this._push.pump.waitForIdle(),
      ...this._runs.values(),
    ]);
  }

  private requestDirection(direction: SyncDirection, force = false, schedule = true): void {
    const state = this.state(direction);
    state.requested = true;
    state.wakeVersion++;
    if (force) {
      state.notBefore = 0;
    }
    if (direction === 'pull') {
      this.setPullCurrent(false);
    }
    if (schedule) {
      state.pump.request(Math.max(0, state.notBefore - Date.now()));
    }
  }

  private runRequested(direction: SyncDirection): Promise<void> {
    return runSerializedByKey(this._runs, direction, async (): Promise<void> => {
      const state = this.state(direction);
      if (!state.requested || this._abortController.signal.aborted) {
        return;
      }
      state.requested = false;
      const wakeVersion = state.wakeVersion;
      const shouldContinue = (): boolean => !this._abortController.signal.aborted;
      const page = await this.consumePage(direction, shouldContinue);
      const sparse = await this.retrySparse(direction, page.retained, shouldContinue);
      if (page.hasMore) {
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
        const state = this.state(direction);
        state.requested = false;
        const wakeVersion = state.wakeVersion;
        const page = await this.consumePage(direction, shouldContinue);
        const sparse = await this.retrySparse(direction, page.retained, shouldContinue);
        if (page.hasMore) {
          await SyncNextLinkSession.yieldTurn();
          continue;
        }

        const remaining = await this.retryCoverSparse(direction, shouldContinue, sparse);
        this.assertCurrent(direction, shouldContinue);
        if (state.requested || wakeVersion !== state.wakeVersion) {
          await SyncNextLinkSession.yieldTurn();
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
    this._pull.failures = 0;
    this._pull.notBefore = 0;
    this._endpoint.clear();
    this.setOnline(true);
    if (result.materializedCids.length > 0) {
      await this._ledger.settleQuarantineForLogicalTarget(
        syncNextLogicalTargetId(this._target.did, this._target.projectionId),
        result.materializedCids,
      );
    }
    return { hasMore: result.hasMore, retained: result.quarantined > 0 };
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
    this._push.failures = 0;
    this._push.notBefore = 0;
    return { hasMore: result.hasMore, retained: result.retained > 0 };
  }

  private retrySparse(
    direction: SyncDirection,
    force: boolean,
    shouldContinue: () => boolean,
  ): Promise<SparseAttempt> {
    return direction === 'pull'
      ? this.retryQuarantine(force, shouldContinue).then(result => ({
        attempted  : result.kind !== 'deferred' && result.kind !== 'empty',
        progressed : result.kind === 'settled',
        remaining  : result.remaining,
      }))
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
      return { attempted: false, progressed: false, remaining: entries.length };
    }
    const entry = force
      ? entries[0]
      : entries.find(candidate => SyncNextLinkSession.deliveryRetryAt(candidate) <= Date.now());
    if (entry === undefined) {
      return { attempted: false, progressed: false, remaining: entries.length };
    }
    const result = await this._endpoint.run(() => this._pushPage.retryDelivery(
      this._target,
      entry,
      shouldContinue,
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
    const remaining = (await this._ledger.getDeliveryForLink(syncNextLinkIdentity(this._target))).length;
    return { attempted: true, progressed: result.kind === 'settled', remaining };
  }

  private async retryCoverSparse(
    direction: SyncDirection,
    shouldContinue: () => boolean,
    initial: SparseAttempt,
  ): Promise<number> {
    let result = initial;
    for (let attempts = 0; attempts < COVER_SPARSE_RETRY_LIMIT; attempts++) {
      if (result.remaining === 0 || !shouldContinue() || (result.attempted && !result.progressed)) {
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

  private handleBackgroundError(direction: SyncDirection, error: unknown): void {
    this.setOnline(false);
    if (this._abortController.signal.aborted) {
      return;
    }
    if (error instanceof SyncNextEndpointBackoffError) {
      this.state(direction).notBefore = Date.now() + error.retryAfterMs;
    } else {
      this._reportError(error);
      const state = this.state(direction);
      state.notBefore = Date.now() + SyncNextLinkSession.retryDelay(++state.failures);
    }
    this.request(direction);
  }

  private request(direction: SyncDirection): void {
    if (direction === 'pull') {
      this.requestPull();
    } else {
      this.requestPush();
    }
  }

  private state(direction: SyncDirection): DirectionState {
    return direction === 'pull' ? this._pull : this._push;
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
    const retryAfter = SyncNextLinkSession.retryAfter(entry.outcome);
    return retryAfter !== undefined && retryAfter > Date.now()
      ? retryAfter
      : Date.parse(entry.lastAttemptAt) + SyncNextLinkSession.retryDelay(entry.attempts);
  }

  private static retryAfter(outcome: SyncNextDeliveryOutcome): number | undefined {
    if (outcome.retryAfter === undefined) {
      return;
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

  private static retryDelay(attempts: number): number {
    const exponent = Math.min(Math.max(0, attempts - 1), 6);
    return Math.min(RETRY_DELAY_MS * (2 ** exponent), MAX_RETRY_DELAY_MS);
  }

  private static yieldTurn(): Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, 1); });
  }
}
