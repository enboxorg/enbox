import type { compileRecordQuery } from './record-query.js';
import type { DwnApi } from './dwn-api.js';
import type { Record } from './record.js';
import type { DwnSubscriptionHandler, DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { ProtocolDefinition, RecordsFilter } from '@enbox/dwn-sdk-js';
import type { ReplicationLinkSnapshot, SyncEngine, SyncEvent, SyncIdentityOptions } from '@enbox/agent';

import { getRuleSetAtPath } from '@enbox/dwn-sdk-js';
import { requireDwnSuccess } from './dwn-response-error.js';

/** Currentness of one locally materialized records view. */
export type RecordViewState = 'loading' | 'ready' | 'stale' | 'error';

type RecordViewContents<Item> = Readonly<{
  /**
   * Items from the latest publishable query result.
   *
   * The array and snapshot are immutable. The query selects each item's
   * record or materialized-record representation.
   */
  records: readonly Item[];

  /** True when another page is available; false before the first query completes. */
  hasMore: boolean;
}>;

/** Immutable materialization published by a {@link RecordView}. */
export type RecordViewSnapshot<Item = Record> = RecordViewContents<Item> & Readonly<
  | {
    /** Whether the local materialization is current with its configured replicated sources. */
    state: Exclude<RecordViewState, 'error'>;
    error?: never;
  }
  | {
    state: 'error';
    /** The query, authorization, terminal subscription, replication, or owning-session termination. */
    error: Error;
  }
>;

/** Listener notified after a records view publishes a new snapshot. */
export type RecordViewListener<Item = Record> = (snapshot: RecordViewSnapshot<Item>) => void;

/**
 * A closeable local materialized view over one canonical record query.
 *
 * Subscription events are wake signals only. Consumers render immutable
 * snapshots and never maintain collection truth from event payloads.
 */
export interface RecordView<Item = Record> {
  /** Return the current immutable snapshot. Safe to pass as a bare callback. */
  getSnapshot: () => RecordViewSnapshot<Item>;

  /** Subscribe to later snapshot publications. Safe to pass as a bare callback. */
  subscribe: (listener: RecordViewListener<Item>) => () => void;

  /** Fence callbacks and close the underlying local subscriptions without publishing a new snapshot. */
  close(): Promise<void>;
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
  sync?: SyncEngine;
};

type RecordViewCurrentness =
  | { state: Exclude<RecordViewState, 'error'> }
  | { state: 'error'; error: Error };

type RegistrationChangeEvent = Extract<SyncEvent, { type: 'identity:registration-change' }>;
type LinkStatusChangeEvent = Extract<SyncEvent, { type: 'link:status-change' }>;
type LinkConnectivityChangeEvent = Extract<SyncEvent, { type: 'link:connectivity-change' }>;
type PullCurrentnessChangeEvent = Extract<SyncEvent, { type: 'pull:currentness-change' }>;

/** @internal Create and open one local observed records view. */
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
  private readonly _definition: ProtocolDefinition;
  private readonly _dwn: DwnApi;
  private readonly _listeners = new Set<RecordViewListener<Item>>();
  private readonly _materializeRecords: (records: Record[]) => Promise<readonly Item[]>;
  private readonly _query: CompiledRecordQuery;
  private readonly _signal?: AbortSignal;
  private readonly _sync?: SyncEngine;

  private _closed = false;
  private _closePromise?: Promise<void>;
  private _hasPublishedReady = false;
  private _isMaterializing = false;
  private _isOpen = false;
  private _materializationRequested = false;
  private _requestGeneration = 0;
  private _snapshot: RecordViewSnapshot<Item> = immutableSnapshot({
    state   : 'loading',
    records : [],
    hasMore : false,
  });
  private readonly _subscriptions: { close(): Promise<void> }[] = [];
  private _syncUnsubscribe?: () => void;

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
    this._sync = options.sync;

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

      this._isOpen = true;
      this.requestMaterialization();
    } catch (error: unknown) {
      if (!this._closed) {
        await this.close();
      }
      throw error;
    }
  }

  public readonly getSnapshot = (): RecordViewSnapshot<Item> => {
    return this._snapshot;
  };

  public readonly subscribe = (listener: RecordViewListener<Item>): (() => void) => {
    if (this._closed) {
      return (): void => {};
    }

    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  public close(): Promise<void> {
    this._closePromise ??= this.closeOwnedResources();
    return this._closePromise;
  }

  private async closeOwnedResources(): Promise<void> {
    this._closed = true;
    this._requestGeneration += 1;
    this._materializationRequested = false;
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
      filter,
      pagination   : { limit: 1 },
      protocolRole : this._query.protocolRole,
      subscriptionHandler,
    });

    if (this._closed) {
      await reply.subscription?.close();
      this._signal?.throwIfAborted();
      throw new Error('RecordView: closed while opening the local subscription.');
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
    if (this._closed || event.tenantDid !== this._dwn.connectedDid) {
      return;
    }

    if (event.type === 'identity:registration-change') {
      this.handleRegistrationChange(event);
      return;
    }

    if (!eventCoversProtocol(event, this._query.filter.protocol)) {
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
    if (registrationCoversProtocol(event.options, this._query.filter.protocol)) {
      this._hasPublishedReady = false;
      this.publish(immutableSnapshot({
        state   : 'loading',
        records : this._snapshot.records,
        hasMore : this._snapshot.hasMore,
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
    if (currentness.state === 'error') {
      this.publish(immutableSnapshot({
        state : 'error',
        records,
        hasMore,
        error : currentness.error,
      }));
      return;
    }

    if (currentness.state === 'ready') {
      this._hasPublishedReady = true;
    }
    this.publish(immutableSnapshot({
      state: currentness.state,
      records,
      hasMore,
    }));
  }

  /** Resolve whether this protocol has completed its configured remote baseline. */
  private async resolveCurrentness(): Promise<RecordViewCurrentness> {
    if (this._sync === undefined) {
      return { state: 'ready' };
    }

    const registration = await this._sync.getIdentityOptions(this._dwn.connectedDid);
    if (!registrationCoversProtocol(registration, this._query.filter.protocol)) {
      return { state: 'ready' };
    }

    const links = (await this._sync.getReplicationLinks(this._dwn.connectedDid))
      .filter((link): boolean => linkCoversProtocol(link, this._query.filter.protocol));
    if (links.some((link): boolean => link.status === 'paused')) {
      return this.resolveUnavailableCurrentness(true);
    }

    const isCurrent = links.length > 0 && links.every((link): boolean =>
      link.status === 'live' && link.connectivity === 'online' && link.isPullCurrent);
    return isCurrent ? { state: 'ready' } : this.resolveUnavailableCurrentness(false);
  }

  /** Resolve the shared policy for unavailable replication. */
  private resolveUnavailableCurrentness(isPaused: boolean): RecordViewCurrentness {
    if (isPaused) {
      return {
        state : 'error',
        error : new Error(`RecordView: replication is paused for protocol '${this._query.filter.protocol}'.`),
      };
    }

    return { state: this._hasPublishedReady ? 'stale' : 'loading' };
  }

  private publishError(error: Error): void {
    this.publish(immutableSnapshot({
      state   : 'error',
      records : this._snapshot.records,
      hasMore : this._snapshot.hasMore,
      error,
    }));
  }

  /** Degrade synchronously without letting partial link evidence clear an existing error. */
  private publishProvisionalReplicationCurrentness(isPaused = false): void {
    const currentness = this.resolveUnavailableCurrentness(isPaused);
    if (this._snapshot.state === 'error' && currentness.state !== 'error') {
      return;
    }

    if (currentness.state === 'error') {
      this.publishError(currentness.error);
      return;
    }

    this.publish(immutableSnapshot({
      state   : currentness.state,
      records : this._snapshot.records,
      hasMore : this._snapshot.hasMore,
    }));
  }

  private publish(snapshot: RecordViewSnapshot<Item>): void {
    if (this._closed) {
      return;
    }

    this._snapshot = snapshot;
    // Listener mutations apply to later publications, never the one already in progress.
    const listeners = [...this._listeners];
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A consumer cannot poison the view or prevent other notifications.
      }
    }
  }
}

function immutableSnapshot<Item>(snapshot: RecordViewSnapshot<Item>): RecordViewSnapshot<Item> {
  const records = Object.freeze([...snapshot.records]);
  return Object.freeze({ ...snapshot, records });
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

function registrationCoversProtocol(
  registration: SyncIdentityOptions | undefined,
  protocol: string,
): boolean {
  return registration !== undefined
    && (registration.protocols === 'all' || registration.protocols.includes(protocol));
}

function linkCoversProtocol(link: ReplicationLinkSnapshot, protocol: string): boolean {
  return link.scope.kind === 'full' || link.scope.protocols.includes(protocol);
}

function eventCoversProtocol(
  event: Exclude<SyncEvent, { type: 'identity:registration-change' }>,
  protocol: string,
): boolean {
  if (event.protocols !== undefined) {
    return event.protocols.includes(protocol);
  }
  return event.protocol === undefined || event.protocol === protocol;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
