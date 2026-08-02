import type { compileRecordQuery } from './record-query.js';
import type { DwnApi } from './dwn-api.js';
import type { Record } from './record.js';
import type { ReplicationCurrentness } from './replication-currentness.js';
import type { DwnSubscriptionHandler, DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { ProtocolDefinition, RecordsFilter } from '@enbox/dwn-sdk-js';
import type { SyncEngine, SyncEvent } from '@enbox/agent';

import { ContextRetiredError } from './context-errors.js';
import { followedContextChangeRetiresSource } from './followed-context-lifecycle.js';
import { getRuleSetAtPath } from '@enbox/dwn-sdk-js';
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
    /** Whether the materialization is current with its source. */
    status: Exclude<ReplicationCurrentness, 'error'>;
    error?: never;
  }
  | {
    status: 'error';
    /** The query, authorization, terminal subscription, replication, or owning-session termination. */
    error: Error;
  }
>;

type UsableRecordViewState<Item> = Exclude<RecordViewState<Item>, { status: 'error' }>;

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

  /**
   * Resolve with the first usable state.
   *
   * A state is usable when it contains records, or when `ready` makes an
   * empty result authoritative. Errors, caller abort, and view closure reject.
   */
  whenUsable(options?: Readonly<{ signal?: AbortSignal }>): Promise<UsableRecordViewState<Item>>;

  /** Fence callbacks and close the underlying local subscriptions without publishing new state. */
  close(): Promise<void>;
}

type ProjectedStateView<State> = {
  getState: () => State;
  subscribe(listener: (state: State) => void): () => void;
  close(): Promise<void>;
};

/** @internal Project a RecordView's domain state while preserving stable state identity. */
export function projectRecordView<Item, State>(
  view: Pick<RecordView<Item>, 'close' | 'getState' | 'subscribe'>,
  project: (state: RecordViewState<Item>) => State,
): ProjectedStateView<State> {
  let source = view.getState();
  let state = project(source);
  const update = (next: RecordViewState<Item>): State => {
    if (next !== source) {
      source = next;
      state = project(next);
    }
    return state;
  };

  return Object.freeze({
    close     : (): Promise<void> => view.close(),
    getState  : (): State => update(view.getState()),
    subscribe : (listener: (state: State) => void): (() => void) =>
      view.subscribe(next => { listener(update(next)); }),
  });
}

type CompiledRecordQuery = ReturnType<typeof compileRecordQuery>;

/** @internal Dependencies supplied by {@link TypedEnbox} for one view. */
type RecordViewOptions<Item> = {
  additionalWakeFilters?: readonly RecordsFilter[];
  definition: ProtocolDefinition;
  dwn: DwnApi;
  materializeRecords: (records: Record[]) => Promise<readonly Item[]>;
  query: CompiledRecordQuery;
  signal?: AbortSignal;
  subscribeToWakes?: (wake: () => void) => () => void;
  sync?: SyncEngine;
};

type RecordViewCurrentness =
  | { status: Exclude<ReplicationCurrentness, 'error'> }
  | { status: 'error'; error: Error };

type RegistrationChangeEvent = Extract<SyncEvent, { type: 'identity:registration-change' }>;
type LinkStatusChangeEvent = Extract<SyncEvent, { type: 'link:status-change' }>;
type LinkConnectivityChangeEvent = Extract<SyncEvent, { type: 'link:connectivity-change' }>;
type PullCurrentnessChangeEvent = Extract<SyncEvent, { type: 'pull:currentness-change' }>;

/** @internal Create and open one observed records view. */
export async function createRecordView<Item = Record>(
  options: RecordViewOptions<Item>,
): Promise<RecordView<Item>> {
  options.signal?.throwIfAborted();
  const view = new ObservedRecordView<Item>(options);
  await view.open();
  return view;
}

/** One serialized, wake-driven materialization resource. */
class ObservedRecordView<Item> implements RecordView<Item> {
  private readonly _additionalWakeFilters: readonly RecordsFilter[];
  private readonly _closeController = new AbortController();
  private readonly _definition: ProtocolDefinition;
  private readonly _dwn: DwnApi;
  private readonly _listeners = new Set<RecordViewListener<Item>>();
  private readonly _materializeRecords: (records: Record[]) => Promise<readonly Item[]>;
  private readonly _query: CompiledRecordQuery;
  private readonly _signal?: AbortSignal;
  private readonly _subscribeToWakes?: (wake: () => void) => () => void;
  private readonly _sync?: SyncEngine;
  private readonly _tenantDid: string;
  private readonly _followedContextId?: string;
  private readonly _followedSourceAcceptanceId?: string;
  private readonly _followedSourceId?: string;

  private _closed = false;
  private _closePromise?: Promise<void>;
  private _hasPublishedReady = false;
  private _isMaterializing = false;
  private _isOpen = false;
  private _materializationRequested = false;
  private _requestGeneration = 0;
  private _state: RecordViewState<Item> = immutableState({
    status  : 'loading',
    records : [],
    hasMore : false,
  });
  private readonly _subscriptions: { close(): Promise<void> }[] = [];
  private _syncUnsubscribe?: () => void;
  private _wakeUnsubscribe?: () => void;

  private readonly _handleAbort = (): void => {
    this.publishError(new Error('RecordView: owning session ended.', { cause: this._signal?.reason }));
    void this.close().catch((): void => {});
  };

  public constructor(options: RecordViewOptions<Item>) {
    this._additionalWakeFilters = options.additionalWakeFilters ?? [];
    this._definition = options.definition;
    this._dwn = options.dwn;
    this._materializeRecords = options.materializeRecords;
    this._query = options.query;
    this._signal = options.signal;
    this._subscribeToWakes = options.subscribeToWakes;
    this._sync = options.dwn.followedSourceId !== undefined || options.query.from === undefined
      ? options.sync
      : undefined;
    this._tenantDid = options.dwn.recordTenantDid;
    this._followedContextId = options.dwn.followedContextId;
    this._followedSourceAcceptanceId = options.dwn.followedSourceAcceptanceId;
    this._followedSourceId = options.dwn.followedSourceId;

    this._signal?.addEventListener('abort', this._handleAbort, { once: true });
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
      if (!this._closed) {
        await this.close();
      }
      throw error;
    }
  }

  public readonly getState = (): RecordViewState<Item> => {
    return this._state;
  };

  public readonly subscribe = (listener: RecordViewListener<Item>): (() => void) => {
    if (this._closed) {
      return (): void => {};
    }

    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  public whenUsable(
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<UsableRecordViewState<Item>> {
    const signal = options.signal === undefined
      ? this._closeController.signal
      : AbortSignal.any([options.signal, this._closeController.signal]);
    return new Promise<UsableRecordViewState<Item>>((resolve, reject): void => {
      let unsubscribe = (): void => {};
      const cleanup = (): void => {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      };
      const fail = (reason: unknown): void => {
        cleanup();
        reject(reason);
      };
      const inspect = (state: RecordViewState<Item>): void => {
        if (options.signal?.aborted === true) {
          fail(options.signal.reason);
        } else if (state.status === 'error') {
          fail(state.error);
        } else if (this._closeController.signal.aborted) {
          fail(this._closeController.signal.reason);
        } else if (state.status === 'ready' || state.records.length > 0) {
          cleanup();
          resolve(state);
        }
      };
      const onAbort = (): void => { inspect(this._state); };

      signal.addEventListener('abort', onAbort, { once: true });
      unsubscribe = this.subscribe(inspect);
      inspect(this._state);
    });
  }

  public close(): Promise<void> {
    this._closePromise ??= this.closeOwnedResources();
    return this._closePromise;
  }

  private async closeOwnedResources(): Promise<void> {
    this._closed = true;
    this._closeController.abort();
    this._requestGeneration += 1;
    this._materializationRequested = false;
    this._wakeUnsubscribe?.();
    this._wakeUnsubscribe = undefined;
    this._syncUnsubscribe?.();
    this._syncUnsubscribe = undefined;
    this._signal?.removeEventListener('abort', this._handleAbort);
    this._listeners.clear();

    const subscriptions = this._subscriptions.splice(0);
    await Promise.all(subscriptions.map(async (subscription): Promise<void> => subscription.close()));
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

    if (this._closed) {
      await reply.subscription?.close();
      this._signal?.throwIfAborted();
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
    if (this._closed) {
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
    if (this._closed || event.tenantDid !== this._tenantDid) {
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
      this._hasPublishedReady = false;
      this.publish(immutableState({
        status  : 'loading',
        records : this._state.records,
        hasMore : this._state.hasMore,
      }));
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

  /** Coalesce arbitrary wakes into one active and at most one trailing pass. */
  private requestMaterialization(): void {
    if (this._closed) {
      return;
    }

    this._requestGeneration += 1;
    this._materializationRequested = true;
    if (!this._isOpen || this._isMaterializing) {
      return;
    }

    this._isMaterializing = true;
    void this.drainMaterializations();
  }

  private async drainMaterializations(): Promise<void> {
    try {
      while (!this._closed && this._materializationRequested) {
        await this.materializeRequestedGeneration();
      }
    } finally {
      this._isMaterializing = false;
    }
  }

  /** Execute and publish one generation without owning the outer drain loop. */
  private async materializeRequestedGeneration(): Promise<void> {
    this._materializationRequested = false;
    const generation = this._requestGeneration;

    try {
      const result = await this._dwn.records.query(this._query);
      requireDwnSuccess('RecordView query', result);
      const records = await this._materializeRecords(result.records);

      const currentness = await this.resolveCurrentness();
      if (!this.canPublishGeneration(generation)) {
        return;
      }
      this.publishMaterialization(records, result.cursor !== undefined, currentness);
    } catch (error: unknown) {
      if (this.canPublishGeneration(generation)) {
        this.publishError(toError(error));
      }
    }
  }

  private canPublishGeneration(generation: number): boolean {
    return !this._closed && generation === this._requestGeneration;
  }

  private publishMaterialization(
    records: readonly Item[],
    hasMore: boolean,
    currentness: RecordViewCurrentness,
  ): void {
    if (currentness.status === 'error') {
      this.publish(immutableState({
        status : 'error',
        records,
        hasMore,
        error  : currentness.error,
      }));
      return;
    }

    if (currentness.status === 'ready') {
      this._hasPublishedReady = true;
    }
    this.publish(immutableState({
      status: currentness.status,
      records,
      hasMore,
    }));
  }

  /** Resolve whether this protocol has completed its configured remote baseline. */
  private async resolveCurrentness(): Promise<RecordViewCurrentness> {
    if (this._sync === undefined) {
      return { status: 'ready' };
    }

    if (this._followedContextId === undefined) {
      const registration = await this._sync.getIdentityOptions(this._tenantDid);
      if (!syncRegistrationCoversProtocol(registration, this._query.filter.protocol)) {
        return { status: 'ready' };
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
    const status = projectReplicationCurrentness(links, this._hasPublishedReady);
    if (status === 'error') {
      return this.resolveUnavailableCurrentness(true);
    }
    return { status };
  }

  /** Resolve a provisional unavailable state or attach the RecordView-specific pause error. */
  private resolveUnavailableCurrentness(isPaused: boolean): RecordViewCurrentness {
    if (isPaused) {
      return {
        status : 'error',
        error  : new Error(`RecordView: replication is paused for protocol '${this._query.filter.protocol}'.`),
      };
    }

    return { status: this._hasPublishedReady ? 'stale' : 'loading' };
  }

  private publishError(error: Error): void {
    this.publish(immutableState({
      status  : 'error',
      records : this._state.records,
      hasMore : this._state.hasMore,
      error,
    }));
  }

  /** Degrade synchronously without letting partial link evidence clear an existing error. */
  private publishProvisionalReplicationCurrentness(isPaused = false): void {
    const currentness = this.resolveUnavailableCurrentness(isPaused);
    if (this._state.status === 'error' && currentness.status !== 'error') {
      return;
    }

    if (currentness.status === 'error') {
      this.publishError(currentness.error);
      return;
    }

    this.publish(immutableState({
      status  : currentness.status,
      records : this._state.records,
      hasMore : this._state.hasMore,
    }));
  }

  private publish(state: RecordViewState<Item>): void {
    if (this._closed) {
      return;
    }

    this._state = state;
    // Listener mutations apply to later publications, never the one already in progress.
    const listeners = [...this._listeners];
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A consumer cannot poison the view or prevent other notifications.
      }
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
