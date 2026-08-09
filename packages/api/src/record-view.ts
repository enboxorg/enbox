import type { compileRecordQuery } from './record-query.js';
import type { DwnApi } from './dwn-api.js';
import type { Record } from './record.js';
import type { DwnSubscriptionHandler, DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { ProtocolDefinition, RecordsFilter } from '@enbox/dwn-sdk-js';
import type { SyncEngine, SyncEvent } from '@enbox/agent';

import { ContextRetiredError } from './context-errors.js';
import { followedContextChangeRetiresSource } from './followed-context-lifecycle.js';
import { getRuleSetAtPath } from '@enbox/dwn-sdk-js';
import { ObservedView } from './observed-view.js';
import { openView } from './view-opening.js';
import { projectReplicationCurrentness } from './replication-currentness.js';
import { requireDwnSuccess } from './dwn-response-error.js';
import { syncEventCoversProtocol, syncRegistrationCoversProtocol, syncScopeCoversProtocol } from '@enbox/agent';

type RecordViewContents<Item> = Readonly<{
  /**
   * Items from the latest publishable query result.
   *
   * The array and view state are immutable. The query selects each item's
   * record or materialized-record representation.
   */
  records: readonly Item[];

  /** True when another page is available; false before the first query completes. */
  hasMore: boolean;
}>;

/** Immutable materialization state published by a {@link RecordView}. */
export type RecordViewState<Item = Record> = RecordViewContents<Item> & Readonly<
  | {
    /** The first local query has not completed. */
    status: 'loading';
    current: false;
    error?: never;
  }
  | {
    /** Local records are usable. `current` reports whether replication is caught up. */
    status: 'ready';
    current: boolean;
    error?: never;
  }
  | {
    status: 'error';
    current: false;
    /** The query, authorization, terminal subscription, replication, or owning-session termination. */
    error: Error;
  }
>;

type ReadyRecordViewState<Item> = Extract<RecordViewState<Item>, { status: 'ready' }>;

/** Listener notified after a records view publishes new state. */
export type RecordViewListener<Item = Record> = (state: RecordViewState<Item>) => void;

/**
 * A closeable materialized view over one canonical record query.
 *
 * Subscription events are wake signals only. Consumers render immutable
 * states and never maintain collection truth from event payloads.
 */
export interface RecordView<Item = Record> {
  /** Return the current immutable state. Safe to pass as a bare callback. */
  getState: () => RecordViewState<Item>;

  /** Subscribe to later state publications. Safe to pass as a bare callback. */
  subscribe: (listener: RecordViewListener<Item>) => () => void;

  /** Resolve after the first local query makes records, including an empty result, usable. */
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<ReadyRecordViewState<Item>>;

  /** Fence callbacks and close the underlying local subscriptions without publishing new state. */
  close(): Promise<void>;
}

/** A bounded record view whose canonical prefix can grow in fixed-size steps. */
export interface ExpandableRecordView<Item = Record> extends RecordView<Item> {
  /** Grow the retained prefix by the observe request's original limit. */
  loadMore(): Promise<void>;
}

type CompiledRecordQuery = ReturnType<typeof compileRecordQuery>;

/** @internal Dependencies supplied by {@link TypedEnbox} for one view. */
type RecordViewOptions<Item> = {
  additionalWakeFilters?: readonly RecordsFilter[];
  callerSignal?: AbortSignal;
  definition: ProtocolDefinition;
  dwn: DwnApi;
  expandBy?: number;
  materializeRecords: (records: Record[]) => Promise<readonly Item[]>;
  query: CompiledRecordQuery;
  signal?: AbortSignal;
  subscribeToWakes?: (wake: () => void) => () => void;
  sync?: SyncEngine;
};

type RecordViewCurrentness =
  | { current: boolean }
  | { status: 'error'; error: Error };

type RegistrationChangeEvent = Extract<SyncEvent, { type: 'identity:registration-change' }>;
type LinkStatusChangeEvent = Extract<SyncEvent, { type: 'link:status-change' }>;
type LinkConnectivityChangeEvent = Extract<SyncEvent, { type: 'link:connectivity-change' }>;
type PullCurrentnessChangeEvent = Extract<SyncEvent, { type: 'pull:currentness-change' }>;

/** @internal Create and open one observed records view. */
export async function createRecordView<Item = Record>(
  options: RecordViewOptions<Item>,
): Promise<RecordView<Item>> {
  options.callerSignal?.throwIfAborted();
  options.signal?.throwIfAborted();
  const view = new ObservedRecordView<Item>(options);
  await openView(view, [options.callerSignal, options.signal]);
  return view;
}

/** @internal Create an observed records view with an explicitly bounded expansion step. */
export async function createExpandableRecordView<Item = Record>(
  options: RecordViewOptions<Item>,
): Promise<ExpandableRecordView<Item>> {
  const limit = options.query.pagination?.limit;
  if (!Number.isSafeInteger(limit) || limit === undefined || limit <= 0) {
    throw new TypeError('ExpandableRecordView: pagination.limit must be a positive safe integer.');
  }

  options.callerSignal?.throwIfAborted();
  options.signal?.throwIfAborted();
  const view = new ObservedRecordView<Item>({ ...options, expandBy: limit });
  await openView(view, [options.callerSignal, options.signal]);
  return view;
}

type PendingLoad = {
  limit: number;
  reject(reason?: unknown): void;
  resolve(): void;
};

/** One serialized, wake-driven materialization resource. */
class ObservedRecordView<Item> extends ObservedView<RecordViewState<Item>> implements RecordView<Item> {
  private readonly _additionalWakeFilters: readonly RecordsFilter[];
  private readonly _definition: ProtocolDefinition;
  private readonly _dwn: DwnApi;
  private readonly _expandBy?: number;
  private readonly _materializeRecords: (records: Record[]) => Promise<readonly Item[]>;
  private readonly _query: CompiledRecordQuery;
  private readonly _subscribeToWakes?: (wake: () => void) => () => void;
  private readonly _sync?: SyncEngine;
  private readonly _tenantDid: string;
  private readonly _followedContextId?: string;
  private readonly _followedSourceAcceptanceId?: string;
  private readonly _followedSourceId?: string;

  private _hasMaterialized = false;
  private _hasTerminationReason = false;
  private _isOpen = false;
  private _limit?: number;
  private _loadMorePromise?: Promise<void>;
  private _pendingLoad?: PendingLoad;
  private _terminationReason?: unknown;
  private readonly _subscriptions: { close(): Promise<void> }[] = [];
  private _syncUnsubscribe?: () => void;
  private _wakeUnsubscribe?: () => void;

  public constructor(options: RecordViewOptions<Item>) {
    super(immutableState({
      status  : 'loading',
      records : [],
      hasMore : false,
      current : false,
    }), options.callerSignal, options.signal);
    this._additionalWakeFilters = options.additionalWakeFilters ?? [];
    this._definition = options.definition;
    this._dwn = options.dwn;
    this._expandBy = options.expandBy;
    this._limit = options.expandBy === undefined ? undefined : options.query.pagination?.limit;
    this._materializeRecords = options.materializeRecords;
    this._query = options.query;
    this._subscribeToWakes = options.subscribeToWakes;
    this._sync = options.dwn.followedSourceId !== undefined || options.query.from === undefined
      ? options.sync
      : undefined;
    this._tenantDid = options.dwn.recordTenantDid;
    this._followedContextId = options.dwn.followedContextId;
    this._followedSourceAcceptanceId = options.dwn.followedSourceAcceptanceId;
    this._followedSourceId = options.dwn.followedSourceId;
    this._syncUnsubscribe = this._sync?.on((event): void => {
      this.handleSyncEvent(event);
    });
  }

  /** Install the wake subscription before starting the first query. */
  public async open(): Promise<void> {
    const subscriptionHandler = (message: DwnSubscriptionMessage): void => {
      this.handleSubscriptionMessage(message);
    };

    try {
      const wakeFilters = [
        structuralWakeFilter(this._definition, this._query.filter),
        ...this._additionalWakeFilters,
      ];
      for (const filter of wakeFilters) {
        await this.openSubscription(filter, subscriptionHandler);
      }
      this._wakeUnsubscribe = this._subscribeToWakes?.((): void => { this.requestMaterialization(); });

      this._isOpen = true;
      this.requestMaterialization();
    } catch (error: unknown) {
      if (!this.isClosed) {
        await this.close();
      }
      throw error;
    }
  }

  protected async closeOwnedResources(): Promise<void> {
    this._pendingLoad?.reject(this.terminationReason);
    this._pendingLoad = undefined;
    this._wakeUnsubscribe?.();
    this._wakeUnsubscribe = undefined;
    this._syncUnsubscribe?.();
    this._syncUnsubscribe = undefined;
    const subscriptions = this._subscriptions.splice(0);
    await Promise.all(subscriptions.map(async (subscription): Promise<void> => subscription.close()));
  }

  /** Grow this view's canonical prefix once. Exposed only by the expandable factory. */
  public loadMore(): Promise<void> {
    if (this._expandBy === undefined || this._limit === undefined) {
      return Promise.reject(new Error('RecordView is not expandable.'));
    }
    if (this._loadMorePromise !== undefined) {
      return this._loadMorePromise;
    }

    const pending = this.expandOnce();
    this._loadMorePromise = pending;
    void pending.then(
      (): void => { this._loadMorePromise = undefined; },
      (): void => { this._loadMorePromise = undefined; },
    );
    return pending;
  }

  private async expandOnce(): Promise<void> {
    if (this.isClosed) {
      throw this.terminationReason;
    }
    if (this.getState().status === 'loading') {
      try {
        await this.ready();
      } catch (error: unknown) {
        if (this._hasTerminationReason) {
          throw this.terminationReason;
        }
        throw error;
      }
    }
    if (!this.getState().hasMore) {
      return;
    }

    const limit = this._limit! + this._expandBy!;
    if (!Number.isSafeInteger(limit)) {
      throw new RangeError('ExpandableRecordView: pagination limit exceeds Number.MAX_SAFE_INTEGER.');
    }

    await new Promise<void>((resolve, reject): void => {
      this._pendingLoad = { limit, reject, resolve };
      this.requestMaterialization();
    });
  }

  private get terminationReason(): unknown {
    return this._hasTerminationReason ? this._terminationReason : this._closeController.signal.reason;
  }

  private captureTerminationReason(reason: unknown): void {
    if (!this._hasTerminationReason) {
      this._hasTerminationReason = true;
      this._terminationReason = reason;
    }
  }

  /** Retain the first abort reason for loads; publish only owning-session termination. */
  protected handleLifetimeAbort(reason: unknown, sessionEnded: boolean): void {
    this.captureTerminationReason(reason);
    if (sessionEnded) {
      this.publishError(new Error('RecordView: owning session ended.', { cause: reason }));
    }
  }

  /** Open one wake subscription and retain its handle only after validating the reply. */
  private async openSubscription(
    filter: RecordsFilter,
    subscriptionHandler: DwnSubscriptionHandler,
  ): Promise<void> {
    const reply = await this._dwn.records.subscribe({
      from         : this._query.from,
      filter,
      pagination   : { limit: 1 },
      protocolRole : this._query.protocolRole,
      subscriptionHandler,
    });

    if (this.isClosed) {
      await reply.subscription?.close();
      this._callerSignal?.throwIfAborted();
      this._sessionSignal?.throwIfAborted();
      throw new Error('RecordView: closed while opening the subscription.');
    }

    try {
      requireDwnSuccess('RecordView subscription', reply);
    } catch (error: unknown) {
      await reply.subscription?.close();
      throw error;
    }
    if (reply.subscription === undefined) {
      throw new Error('RecordView: DWN returned success without a subscription.');
    }

    this._subscriptions.push(reply.subscription);
  }

  /** Keep transport acknowledgements independent from query latency. */
  private handleSubscriptionMessage(message: DwnSubscriptionMessage): void {
    if (this.isClosed) {
      return;
    }

    if (message.type === 'event') {
      this.requestMaterialization();
      return;
    }

    if (message.type === 'error') {
      this.publishError(new Error(`RecordView: subscription failed (${message.error.code}): ${message.error.detail}`));
      void this.close().catch((): void => {});
    }
  }

  /** Wake only for sync transitions that can change this local materialization. */
  private handleSyncEvent(event: SyncEvent): void {
    if (this.isClosed || event.tenantDid !== this._tenantDid) {
      return;
    }

    if (event.type === 'identity:registration-change') {
      if (this._followedContextId === undefined) {
        this.handleRegistrationChange(event);
      }
      return;
    }

    if (!syncEventCoversProtocol(event, this._query.filter.protocol)
      || (this._followedContextId !== undefined && event.contextId !== this._followedContextId)) {
      return;
    }

    // An exact source change retires this view; other context changes requery.
    if (this._followedSourceId !== undefined) {
      if (
        event.type === 'followed-context:change' &&
        event.actorDid === this._dwn.connectedDid &&
        followedContextChangeRetiresSource({
          acceptanceId : this._followedSourceAcceptanceId!,
          id           : this._followedSourceId,
        }, event)
      ) {
        this.publishError(new ContextRetiredError(this._followedContextId!));
        void this.close().catch((): void => {});
        return;
      }
      this.requestMaterialization();
      return;
    }

    switch (event.type) {
      case 'link:status-change':
        this.handleLinkStatusChange(event);
        break;
      case 'link:connectivity-change':
        this.handleLinkConnectivityChange(event);
        break;
      case 'pull:currentness-change':
        this.handlePullCurrentnessChange(event);
        break;
    }
  }

  /** A changed registration defines a new baseline for its selected protocols. */
  private handleRegistrationChange(event: RegistrationChangeEvent): void {
    if (syncRegistrationCoversProtocol(event.options, this._query.filter.protocol)) {
      this.publishProvisionalReplicationCurrentness();
    }
    this.requestMaterialization();
  }

  private handleLinkStatusChange(event: LinkStatusChangeEvent): void {
    if (event.to !== 'live') {
      this.publishProvisionalReplicationCurrentness(event.to === 'paused');
    }
    this.requestMaterialization();
  }

  private handleLinkConnectivityChange(event: LinkConnectivityChangeEvent): void {
    if (event.to !== 'online') {
      this.publishProvisionalReplicationCurrentness();
    }
    this.requestMaterialization();
  }

  private handlePullCurrentnessChange(event: PullCurrentnessChangeEvent): void {
    if (!event.to) {
      this.publishProvisionalReplicationCurrentness();
      return;
    }
    this.requestMaterialization();
  }

  /** The first pass may start only after every wake subscription is installed. */
  protected override mayStartMaterialization(): boolean {
    return this._isOpen;
  }

  /** Execute and publish one generation without owning the outer drain loop. */
  protected async materialize(generation: number): Promise<void> {
    const query = this.materializationQuery();
    try {
      const result = await this._dwn.records.query(query);
      requireDwnSuccess('RecordView query', result);
      const records = await this._materializeRecords(result.records);

      const currentness = await this.resolveCurrentness();
      if (!this.canPublishMaterialization(generation)) {
        return;
      }
      this.publishMaterialization(records, result.cursor !== undefined, currentness);
      this.completePendingLoad(query);
    } catch (error: unknown) {
      if (this.canPublishMaterialization(generation)) {
        const normalized = toError(error);
        this.publishError(normalized);
        this.failPendingLoad(query, normalized);
      }
    }
  }

  private materializationQuery(): CompiledRecordQuery {
    if (this._limit === undefined) {
      return this._query;
    }

    const { cursor: _cursor, ...pagination } = this._query.pagination!;

    return {
      ...this._query,
      pagination: {
        ...pagination,
        limit: this._pendingLoad?.limit ?? this._limit,
      },
    };
  }

  private completePendingLoad(query: CompiledRecordQuery): void {
    const pending = this._pendingLoad;
    if (pending === undefined || query.pagination?.limit !== pending.limit) {
      return;
    }

    this._limit = pending.limit;
    this._pendingLoad = undefined;
    pending.resolve();
  }

  private failPendingLoad(query: CompiledRecordQuery, error: Error): void {
    const pending = this._pendingLoad;
    if (pending === undefined || query.pagination?.limit !== pending.limit) {
      return;
    }

    this._pendingLoad = undefined;
    pending.reject(error);
  }

  private publishMaterialization(
    records: readonly Item[],
    hasMore: boolean,
    currentness: RecordViewCurrentness,
  ): void {
    if ('status' in currentness) {
      this.publish(immutableState({
        status  : 'error',
        records : records,
        hasMore,
        current : false,
        error   : currentness.error,
      }));
      return;
    }

    this._hasMaterialized = true;
    this.publish(immutableState({
      status  : 'ready',
      records,
      hasMore,
      current : currentness.current,
    }));
  }

  /** Resolve whether this protocol has completed its configured remote baseline. */
  private async resolveCurrentness(): Promise<RecordViewCurrentness> {
    if (this._sync === undefined) {
      return { current: true };
    }

    if (this._followedContextId === undefined) {
      const registration = await this._sync.getIdentityOptions(this._tenantDid);
      if (!syncRegistrationCoversProtocol(registration, this._query.filter.protocol)) {
        return { current: true };
      }
    }

    const links = (await this._sync.getReplicationLinks(this._tenantDid))
      .filter((link): boolean => this._followedContextId === undefined
        ? syncScopeCoversProtocol(link.scope, this._query.filter.protocol)
        : link.scope.kind === 'context'
          && link.scope.protocol === this._query.filter.protocol
          && link.scope.contextId === this._followedContextId
          && link.followedSourceId === this._followedSourceId
          && link.scope.protocolPaths.includes(this._query.filter.protocolPath));
    const status = projectReplicationCurrentness(links);
    if (status === 'error') {
      return this.resolveUnavailableCurrentness(true);
    }
    return { current: status === 'caught-up' };
  }

  /** Resolve a provisional unavailable state or attach the RecordView-specific pause error. */
  private resolveUnavailableCurrentness(isPaused: boolean): RecordViewCurrentness {
    if (isPaused) {
      return {
        status : 'error',
        error  : new Error(`RecordView: replication is paused for protocol '${this._query.filter.protocol}'.`),
      };
    }

    return { current: false };
  }

  private publishError(error: Error): void {
    this.publish(immutableState({
      status  : 'error',
      records : this.getState().records,
      hasMore : this.getState().hasMore,
      current : false,
      error,
    }));
  }

  /** Degrade synchronously without letting partial link evidence clear an existing error. */
  private publishProvisionalReplicationCurrentness(isPaused = false): void {
    const currentness = this.resolveUnavailableCurrentness(isPaused);
    if (this.getState().status === 'error' && !('status' in currentness)) {
      return;
    }

    if ('status' in currentness) {
      this.publishError(currentness.error);
      return;
    }

    if (this._hasMaterialized) {
      this.publish(immutableState({
        status  : 'ready',
        records : this.getState().records,
        hasMore : this.getState().hasMore,
        current : false,
      }));
    }
  }
}

function immutableState<Item>(state: RecordViewState<Item>): RecordViewState<Item> {
  const records = Object.freeze([...state.records]);
  return Object.freeze({ ...state, records });
}

/** Project the canonical query to the structural scope containing every dependency of its result. */
function structuralWakeFilter(
  definition: ProtocolDefinition,
  filter: CompiledRecordQuery['filter'],
): RecordsFilter {
  const recordLimit = getRuleSetAtPath(filter.protocolPath, definition.structure)?.$recordLimit;
  const contextId = recordLimitWakeContextId(recordLimit !== undefined, filter);
  return {
    protocol     : filter.protocol,
    protocolPath : filter.protocolPath,
    ...(contextId === undefined ? {} : { contextId }),
    ...(recordLimit === undefined && filter.recordId !== undefined ? { recordId: filter.recordId } : {}),
  };
}

/** Widen a full-record scope to the parent group whose occupancy can change that record's visibility. */
function recordLimitWakeContextId(
  isRecordLimited: boolean,
  filter: CompiledRecordQuery['filter'],
): string | undefined {
  const contextId = filter.contextId;
  if (contextId === undefined || !isRecordLimited) {
    return contextId;
  }

  const contextSegments = contextId.split('/');
  if (contextSegments.length !== filter.protocolPath.split('/').length) {
    return contextId;
  }

  contextSegments.pop();
  return contextSegments.length === 0 ? undefined : contextSegments.join('/');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
