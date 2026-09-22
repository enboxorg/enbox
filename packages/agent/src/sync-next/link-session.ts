import type { SyncDirection } from '../types/sync.js';
import type { SyncNextLedgerStore } from './ledger-store.js';
import type { SyncTarget } from '../sync-target-resolver.js';

import type { SyncNextDeliveryRetry } from './delivery-retry.js';
import type { SyncNextPullPage } from './pull-page.js';
import type { SyncNextPushPage } from './push-page.js';
import type { SyncNextQuarantineRetry } from './quarantine-retry.js';
import { SyncNextWorkPump } from './work-pump.js';

const RETRY_DELAY_MS = 1_000;

type CoveringRun = {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
};

/** A covering operation observed feed drain but retained sparse obligations. */
export class SyncNextIncompleteError extends Error {
  public constructor(direction: SyncDirection, count: number) {
    super(`SyncEngineNext: ${direction} observed feed drain with ${count} unresolved obligations.`);
    this.name = 'SyncNextIncompleteError';
  }
}

/** Four independent, coalesced activities for one exact link. */
export class SyncNextLinkSession {
  private readonly _abortController = new AbortController();
  private _deliveryIndex = 0;
  private readonly _deliveryPump: SyncNextWorkPump;
  private _pullCover?: CoveringRun;
  private _pullCurrent = false;
  private _pullFeedDrained = false;
  private readonly _pullPagePump: SyncNextWorkPump;
  private _pullWakeVersion = 0;
  private _quarantineIndex = 0;
  private readonly _quarantinePump: SyncNextWorkPump;
  private _pushCover?: CoveringRun;
  private readonly _pushPagePump: SyncNextWorkPump;
  private _pushWakeVersion = 0;
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
    this._quarantinePump.request();
    this._deliveryPump.request();
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
    this._pullWakeVersion++;
    this._pullCurrent = false;
    this._pullFeedDrained = false;
    this._pullPagePump.request();
  }

  public requestPush(): void {
    if (this._target.authorization.kind !== 'role') {
      this._pushWakeVersion++;
      this._pushPagePump.request();
    }
  }

  /** Run the same page pumps until they observe drain with no trailing wake. */
  public cover(direction?: SyncDirection): Promise<void> {
    const runs: Promise<void>[] = [];
    if (direction !== 'push') {
      this._pullCover ??= SyncNextLinkSession.coveringRun();
      runs.push(this._pullCover.promise);
      this.requestPull();
    }
    if (direction !== 'pull' && this._target.authorization.kind !== 'role') {
      this._pushCover ??= SyncNextLinkSession.coveringRun();
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
    const wakeVersion = this._pullWakeVersion;
    const result = await this._pullPage.consume(this._target, {
      shouldContinue: (): boolean => !this._abortController.signal.aborted,
    });
    if (result.aborted === true) {
      return;
    }
    this._online = true;
    this._quarantinePump.request();
    if (result.hasMore) {
      this._pullPagePump.request();
      return;
    }
    this._pullFeedDrained = true;
    const pullCurrent = (await this._ledger.getQuarantineForLink(
      SyncNextLinkSession.identity(this._target),
    )).length === 0;
    if (wakeVersion === this._pullWakeVersion) {
      this._pullCurrent = pullCurrent;
    }
    await this.finishCover('pull', wakeVersion);
  }

  private async consumePushPage(): Promise<void> {
    const wakeVersion = this._pushWakeVersion;
    const result = await this._pushPage.consume(this._target, {
      shouldContinue: (): boolean => !this._abortController.signal.aborted,
    });
    if (result.aborted === true) {
      return;
    }
    this._online = true;
    this._deliveryPump.request();
    if (result.hasMore) {
      this._pushPagePump.request();
      return;
    }
    await this.finishCover('push', wakeVersion);
  }

  private async retryQuarantine(): Promise<void> {
    const entries = await this._ledger.getQuarantineForLink(SyncNextLinkSession.identity(this._target));
    if (entries.length === 0 || this._abortController.signal.aborted) {
      return;
    }
    const entry = entries[this._quarantineIndex % entries.length];
    this._quarantineIndex = (this._quarantineIndex + 1) % entries.length;
    const result = await this._quarantineRetry.retry(
      this._target,
      entry,
      (): boolean => !this._abortController.signal.aborted,
    );
    if (result.kind === 'pending') {
      this._quarantinePump.request(RETRY_DELAY_MS);
    } else if (entries.length > 1) {
      this._quarantinePump.request();
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
    const entry = entries[this._deliveryIndex % entries.length];
    this._deliveryIndex = (this._deliveryIndex + 1) % entries.length;
    const result = await this._deliveryRetry.retry(
      this._target,
      entry,
      (): boolean => !this._abortController.signal.aborted,
    );
    if (result.kind === 'pending') {
      this._deliveryPump.request(RETRY_DELAY_MS);
    } else if (entries.length > 1) {
      this._deliveryPump.request();
    }
  }

  private async finishCover(direction: SyncDirection, pageWakeVersion: number): Promise<void> {
    const cover = direction === 'pull' ? this._pullCover : this._pushCover;
    if (cover === undefined) {
      return;
    }
    const pending = direction === 'pull'
      ? await this._ledger.getQuarantineForLink(SyncNextLinkSession.identity(this._target))
      : await this._ledger.getDeliveryForLink(SyncNextLinkSession.identity(this._target));
    const currentWakeVersion = direction === 'pull' ? this._pullWakeVersion : this._pushWakeVersion;
    if (currentWakeVersion !== pageWakeVersion) {
      return;
    }
    if (pending.length > 0) {
      this.rejectCover(direction, new SyncNextIncompleteError(direction, pending.length));
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
      (direction === 'pull' ? this._pullPagePump : this._pushPagePump).request(RETRY_DELAY_MS);
    }
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

  private static coveringRun(): CoveringRun {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, reject, resolve };
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
