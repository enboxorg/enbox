import type { GenericMessage, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import type { SyncEchoSuppressor } from './sync-echo-suppressor.js';
import type { SyncIdentityTaskRunner } from './sync-lifecycle-coordinator.js';
import type { SyncTarget } from './sync-target-resolver.js';
import type {
  DeadLetterEntry,
  NonEmptyStringArray,
  PushFailure,
  PushResult,
  ReplicationLinkState,
  SyncScope,
} from './types/sync.js';
import type { SyncLinkController, SyncPushRuntimeEntry, SyncPushRuntimeState } from './sync-link-controller.js';
import type { SyncQuotaPushResultTransition, SyncQuotaPushTransitionOptions } from './sync-quota-manager.js';

import { Message } from '@enbox/dwn-sdk-js';

import { classifySyncEventScope } from './sync-scope-acceptance.js';
import { syncTargetFromLink } from './sync-target-resolver.js';
import { isTerminalPushFailure, pushBatchReconcileReason, singleProtocolForSyncScope } from './types/sync.js';

export type SyncLivePushTarget = SyncTarget & { linkKey: string };

export type SyncLivePushBatchRequest = {
  delegateDid?: string;
  did: string;
  dwnUrl: string;
  messageCids: string[];
  permissionGrantIds?: NonEmptyStringArray;
};

export interface SyncLivePushCoordinatorOperations {
  captureIdentityTaskRunner(tenantDid: string): SyncIdentityTaskRunner;
  clearQuotaBlock(tenantDid: string, linkKey: string, messageCid: string): Promise<unknown>;
  getController(linkKey: string): SyncLinkController | undefined;
  pushMessages(request: SyncLivePushBatchRequest): Promise<PushResult>;
  recordDeadLetter(entry: Omit<DeadLetterEntry, 'failedAt'>): Promise<void>;
  reportError(message: string, error: unknown): void;
  scheduleReconcile(linkKey: string, link: ReplicationLinkState, reason: string, delayMs?: number): void;
  transitionPushResult(
    target: SyncTarget,
    result: PushResult,
    options: SyncQuotaPushTransitionOptions,
  ): Promise<SyncQuotaPushResultTransition>;
}

export type SyncLivePushCoordinatorParams = {
  debounceMs?: number;
  deferredReconcileDelayMs?: number;
  echoSuppressor: SyncEchoSuppressor;
  operations: SyncLivePushCoordinatorOperations;
  retryBackoffMs?: readonly number[];
};

type PushFlushBatch = {
  controller: SyncLinkController;
  entries: SyncPushRuntimeEntry[];
  isStale: () => boolean;
  runtime: SyncPushRuntimeState;
};

export type SyncLivePushPendingBatch = {
  delegateDid?: string;
  did: string;
  dwnUrl: string;
  entries: SyncPushRuntimeEntry[];
  permissionGrantIds?: NonEmptyStringArray;
  protocol?: string;
  retryCount: number;
  scope?: SyncScope;
};

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_DEFERRED_RECONCILE_DELAY_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MS = [0, 250, 1000, 2000] as const;

/**
 * Owns opportunistic live-push batching and retry policy independently of a
 * persistence backend. Link lifetimes remain in SyncLinkController while
 * transport, quota folding, dead letters, and lifecycle supervision are
 * injected effects.
 */
export class SyncLivePushCoordinator {
  private readonly _debounceMs: number;
  private readonly _deferredReconcileDelayMs: number;
  private readonly _echoSuppressor: SyncEchoSuppressor;
  private readonly _operations: SyncLivePushCoordinatorOperations;
  private readonly _retryBackoffMs: readonly number[];

  public constructor({
    debounceMs = DEFAULT_DEBOUNCE_MS,
    deferredReconcileDelayMs = DEFAULT_DEFERRED_RECONCILE_DELAY_MS,
    echoSuppressor,
    operations,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  }: SyncLivePushCoordinatorParams) {
    this._debounceMs = debounceMs;
    this._deferredReconcileDelayMs = deferredReconcileDelayMs;
    this._echoSuppressor = echoSuppressor;
    this._operations = operations;
    this._retryBackoffMs = retryBackoffMs;
  }

  /** Filter and enqueue one local subscription event for its remote link. */
  public async handleEvent(
    target: SyncLivePushTarget,
    controller: SyncLinkController,
    isStale: () => boolean,
    runIdentityTask: SyncIdentityTaskRunner,
    message: SubscriptionMessage,
  ): Promise<void> {
    if (isStale() || message.type !== 'event') {
      return;
    }

    const classification = classifySyncEventScope(message.event, controller.link.scope);
    if (classification === 'out-of-scope') {
      return;
    }
    if (classification === 'unknown') {
      this._operations.scheduleReconcile(target.linkKey, controller.link, 'push-scope-unclassified');
      return;
    }

    const cid = await Message.getCid(message.event.message as GenericMessage);
    if (isStale() || this._echoSuppressor.hasRecentlyPulled(target.did, cid, target.dwnUrl)) {
      return;
    }

    const runtime = controller.getOrCreatePushRuntime({
      did                : target.did,
      dwnUrl             : target.dwnUrl,
      delegateDid        : target.delegateDid,
      protocol           : singleProtocolForSyncScope(target.scope),
      scope              : target.scope,
      permissionGrantIds : target.permissionGrantIds,
    });
    runtime.entries.push({ cid });

    // A busy flush lane means a flush or requeue is queued or in flight:
    // entries appended now ride with it, or with the debounce timer it arms
    // on completion. Repair and reconciliation occupy the mailbox too, so
    // gate on the flush lane rather than mailbox idleness — a flush queued
    // behind a running repair keeps these entries from stalling until the
    // next event arrives.
    if (!controller.mailboxBusy('flush') && runtime.timer === undefined) {
      this.startSupervisedFlush(controller, runIdentityTask);
    }
  }

  /** Flush the current queue for one exact active link lifetime. */
  public async flushLink(linkKey: string, expectedController?: SyncLinkController): Promise<void> {
    const controller = this._operations.getController(linkKey);
    if (controller === undefined || (expectedController !== undefined && controller !== expectedController)) {
      return;
    }
    await controller.enqueue((): Promise<void> => this.flushExclusive(controller), 'flush');
  }

  /** The flush body. Runs only inside the controller's mailbox. */
  private async flushExclusive(controller: SyncLinkController): Promise<void> {
    const batch = this.takeBatch(controller);
    if (batch === undefined) {
      return;
    }

    const { entries, isStale, runtime } = batch;
    const batchRetryCount = runtime.retryCount;
    try {
      const result = await this._operations.pushMessages({
        did                : runtime.did,
        dwnUrl             : runtime.dwnUrl,
        delegateDid        : runtime.delegateDid,
        permissionGrantIds : runtime.permissionGrantIds,
        messageCids        : entries.map(({ cid }) => cid),
      });
      await this.handleBatchResult(controller.linkKey, batch, result);
    } catch (error: unknown) {
      if (!isStale()) {
        this._operations.reportError(
          `SyncLivePushCoordinator: Push batch failed for ${runtime.did} -> ${runtime.dwnUrl}`,
          error,
        );
        await this.requeueExclusive(controller, {
          ...SyncLivePushCoordinator.pendingFromRuntime(runtime),
          entries,
          retryCount: batchRetryCount + 1,
        });
      }
    } finally {
      this.finishFlush(controller, runtime);
    }
  }

  /**
   * Feed reconciliation failures back into the same bounded live retry
   * policy. Called from repair and reconciliation mailbox operations, so it
   * requeues exclusively instead of re-entering the mailbox.
   */
  public async handleReconcileFailures(
    controller: SyncLinkController,
    failures: PushFailure[],
  ): Promise<void> {
    if (!controller.isActive) {
      return;
    }

    const { link } = controller;
    await this.requeueExclusive(controller, {
      did                : link.tenantDid,
      dwnUrl             : link.remoteEndpoint,
      delegateDid        : link.delegateDid,
      protocol           : singleProtocolForSyncScope(link.scope),
      scope              : link.scope,
      permissionGrantIds : SyncLivePushCoordinator.authorizationGrantIds(link),
      entries            : failures.map((failure) => ({ cid: failure.cid, lastFailure: failure })),
      retryCount         : 1,
    });
  }

  /** Requeue a failed batch, or hand it to durable reconciliation when needed. */
  public async requeue(controller: SyncLinkController, pending: SyncLivePushPendingBatch): Promise<void> {
    await controller.enqueue((): Promise<void> => this.requeueExclusive(controller, pending), 'flush');
  }

  /** The requeue body. Runs only inside the controller's mailbox. */
  private async requeueExclusive(controller: SyncLinkController, pending: SyncLivePushPendingBatch): Promise<void> {
    if (!controller.isActive) {
      return;
    }

    const { link, linkKey } = controller;
    const runtime = controller.getOrCreatePushRuntime(pending);
    const entries = await this.removeTerminalFailures(linkKey, pending);
    if (!controller.isActive) {
      return;
    }
    if (entries.length === 0) {
      this.stopRuntime(controller, runtime);
      this._operations.scheduleReconcile(linkKey, link, 'push-terminal');
      return;
    }

    const reconcileReason = pushBatchReconcileReason(entries);
    if (reconcileReason !== undefined) {
      this.stopRuntime(controller, runtime);
      this._operations.scheduleReconcile(
        linkKey,
        link,
        reconcileReason,
        this._deferredReconcileDelayMs,
      );
      return;
    }
    if (pending.retryCount >= this._retryBackoffMs.length) {
      this.stopRuntime(controller, runtime);
      this._operations.scheduleReconcile(linkKey, link, 'push-retry-exhausted');
      return;
    }

    this.scheduleRetry(controller, runtime, { entries, retryCount: pending.retryCount });
  }

  /** Schedule a quota-probe reconciliation using the shared deadline policy. */
  public scheduleQuotaProbe(linkKey: string, link: ReplicationLinkState, nextProbeAt: string): void {
    const parsed = Date.parse(nextProbeAt);
    const delay = Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
    this._operations.scheduleReconcile(linkKey, link, 'push-quota-probe', delay);
  }

  private takeBatch(controller: SyncLinkController): PushFlushBatch | undefined {
    if (controller.link.status !== 'live') {
      controller.clearPushRuntime();
      return undefined;
    }

    const runtime = controller.pushRuntime;
    if (runtime === undefined) {
      return undefined;
    }

    // An armed timer owns the queued entries. Two concurrent events can both
    // observe an idle mailbox before either scheduled flush is admitted (the
    // task runner defers to a microtask), so a redundant flush can reach
    // here while the first flush's debounce or retry timer is already armed
    // — it must not consume the timer's entries early.
    if (runtime.timer !== undefined) {
      return undefined;
    }

    const entries = runtime.entries;
    runtime.entries = [];
    if (entries.length === 0) {
      if (runtime.timer === undefined && runtime.retryCount === 0) {
        controller.clearPushRuntime(runtime);
      }
      return undefined;
    }

    // At most one flush is in flight per link by construction: the mailbox
    // serializes this body, so no in-flight flag is needed.
    return { controller, entries, isStale: () => !controller.isActive, runtime };
  }

  private async handleBatchResult(linkKey: string, batch: PushFlushBatch, result: PushResult): Promise<void> {
    if (batch.isStale()) {
      return;
    }

    const { controller, runtime } = batch;
    const target = syncTargetFromLink(controller.link);
    const transition = await this._operations.transitionPushResult(target, result, {
      protocol : runtime.protocol,
      source   : 'feed',
    });
    if (batch.isStale()) {
      return;
    }

    if (transition.nextQuotaProbeAt !== undefined) {
      this.scheduleQuotaProbe(linkKey, controller.link, transition.nextQuotaProbeAt);
    }
    if (transition.retryableFailures.length > 0) {
      await this.requeueExclusive(controller, {
        ...SyncLivePushCoordinator.pendingFromRuntime(runtime),
        entries: transition.retryableFailures.map((failure) => ({
          cid         : failure.cid,
          lastFailure : failure,
        })),
        retryCount: runtime.retryCount + 1,
      });
      return;
    }

    runtime.retryCount = 0;
    if (runtime.timer === undefined && runtime.entries.length === 0) {
      controller.clearPushRuntime(runtime);
    }
  }

  private finishFlush(controller: SyncLinkController, runtime: SyncPushRuntimeState): void {
    const current = controller.pushRuntime;
    if (!controller.isActive || current !== runtime || current.entries.length === 0 || current.timer !== undefined) {
      return;
    }

    const runIdentityTask = this._operations.captureIdentityTaskRunner(runtime.did);
    const timer = setTimeout((): void => {
      if (!controller.consumePushTimer(runtime, timer)) {
        return;
      }
      this.startSupervisedFlush(controller, runIdentityTask);
    }, this._debounceMs);
    controller.setPushTimer(runtime, timer);
  }

  private async removeTerminalFailures(
    linkKey: string,
    pending: SyncLivePushPendingBatch,
  ): Promise<SyncPushRuntimeEntry[]> {
    const retryable: SyncPushRuntimeEntry[] = [];
    for (const entry of pending.entries) {
      const failure = entry.lastFailure;
      if (failure === undefined || !isTerminalPushFailure(failure)) {
        retryable.push(entry);
        continue;
      }

      await this._operations.clearQuotaBlock(pending.did, linkKey, entry.cid);
      await this._operations.recordDeadLetter({
        messageCid     : entry.cid,
        tenantDid      : pending.did,
        remoteEndpoint : pending.dwnUrl,
        protocol       : pending.protocol,
        category       : 'admit-failed',
        errorCode      : failure.kind ?? 'Invalid',
        errorDetail    : failure.detail ?? 'terminal push failure',
      });
    }
    return retryable;
  }

  private scheduleRetry(
    controller: SyncLinkController,
    runtime: SyncPushRuntimeState,
    pending: Pick<SyncLivePushPendingBatch, 'entries' | 'retryCount'>,
  ): void {
    runtime.entries.push(...pending.entries);
    runtime.retryCount = pending.retryCount;
    const delayMs = this._retryBackoffMs[pending.retryCount] ?? this._retryBackoffMs.at(-1) ?? 0;
    const runIdentityTask = this._operations.captureIdentityTaskRunner(runtime.did);
    const timer = setTimeout((): void => {
      if (!controller.consumePushTimer(runtime, timer)) {
        return;
      }
      this.startSupervisedFlush(controller, runIdentityTask);
    }, delayMs);
    controller.setPushTimer(runtime, timer);
  }

  private startSupervisedFlush(
    controller: SyncLinkController,
    runIdentityTask: SyncIdentityTaskRunner,
  ): void {
    // Supervised task context, outside any mailbox operation: flushLink
    // enqueues the exclusive flush behind whatever is already queued.
    void runIdentityTask(() => this.flushLink(controller.linkKey, controller));
  }

  private stopRuntime(controller: SyncLinkController, runtime: SyncPushRuntimeState): void {
    controller.clearPushRuntime(runtime);
  }

  private static pendingFromRuntime(
    runtime: SyncPushRuntimeState,
  ): Omit<SyncLivePushPendingBatch, 'entries' | 'retryCount'> {
    return {
      did                : runtime.did,
      dwnUrl             : runtime.dwnUrl,
      delegateDid        : runtime.delegateDid,
      protocol           : runtime.protocol,
      scope              : runtime.scope,
      permissionGrantIds : runtime.permissionGrantIds,
    };
  }

  private static authorizationGrantIds(link: ReplicationLinkState): NonEmptyStringArray | undefined {
    return link.authorization.kind === 'delegate' ? link.authorization.permissionGrantIds : undefined;
  }
}
