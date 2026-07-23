import type { compileRecordQuery } from './record-query.js';
import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { RecordsFilter } from '@enbox/dwn-sdk-js';
import type { DwnApi, RecordsQueryResponse } from './dwn-api.js';
import type { ReplicationLinkSnapshot, SyncEngine, SyncEvent, SyncIdentityOptions } from '@enbox/agent';

import { isOk } from './utils.js';
import { TypedRecord } from './typed-record.js';

/** Currentness of one locally materialized records view. */
export type RecordViewState = 'loading' | 'ready' | 'stale' | 'error';

type RecordViewContents<T> = Readonly<{
  /**
   * Record handles from the latest publishable query result.
   *
   * The array and snapshot are immutable. Each handle identifies the queried
   * record version until the caller explicitly invokes one of that handle's
   * normal mutating `TypedRecord` methods.
   */
  records: readonly TypedRecord<T>[];

  /** True when another page is available; false before the first query completes. */
  hasMore: boolean;
}>;

/** Immutable materialization published by a {@link RecordView}. */
export type RecordViewSnapshot<T> = RecordViewContents<T> & Readonly<
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
export type RecordViewListener<T> = (snapshot: RecordViewSnapshot<T>) => void;

/**
 * A closeable local materialized view over one canonical record query.
 *
 * Subscription events are wake signals only. Consumers render immutable
 * snapshots and never maintain collection truth from event payloads.
 */
export interface RecordView<T> {
  /** Return the current immutable snapshot. Safe to pass as a bare callback. */
  getSnapshot: () => RecordViewSnapshot<T>;

  /** Subscribe to later snapshot publications. Safe to pass as a bare callback. */
  subscribe: (listener: RecordViewListener<T>) => () => void;

  /** Fence callbacks and close the underlying local subscription without publishing a new snapshot. */
  close(): Promise<void>;
}

type CompiledRecordQuery = ReturnType<typeof compileRecordQuery>;

/** @internal Dependencies supplied by {@link TypedEnbox} for one view. */
type RecordViewOptions = {
  dwn: DwnApi;
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
export async function createRecordView<T>(options: RecordViewOptions): Promise<RecordView<T>> {
  options.signal?.throwIfAborted();
  const view = new ObservedRecordView<T>(options);
  await view.open();
  return view;
}

/** One serialized, wake-driven materialization resource. */
class ObservedRecordView<T> implements RecordView<T> {
  private readonly _dwn: DwnApi;
  private readonly _listeners = new Set<RecordViewListener<T>>();
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
  private _snapshot: RecordViewSnapshot<T> = immutableSnapshot({
    state   : 'loading',
    records : [],
    hasMore : false,
  });
  private _subscription?: { close(): Promise<void> };
  private _syncUnsubscribe?: () => void;

  private readonly _handleAbort = (): void => {
    this.publishError(new Error('RecordView: owning session ended.', { cause: this._signal?.reason }));
    void this.close().catch((): void => {});
  };

  public constructor(options: RecordViewOptions) {
    this._dwn = options.dwn;
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
      const reply = await this._dwn.records.subscribe({
        filter       : structuralWakeFilter(this._query.filter),
        pagination   : { limit: 1 },
        protocolRole : this._query.protocolRole,
        subscriptionHandler,
      });

      if (this._closed) {
        await reply.subscription?.close();
        this._signal?.throwIfAborted();
        throw new Error('RecordView: closed while opening the local subscription.');
      }

      if (!isOk(reply) || reply.subscription === undefined) {
        await reply.subscription?.close();
        throw new Error(
          `RecordView: unable to open local subscription (${reply.status.code}): ${reply.status.detail}`,
        );
      }

      this._subscription = reply.subscription;
      this._isOpen = true;
      this.requestMaterialization();
    } catch (error: unknown) {
      if (!this._closed) {
        await this.close();
      }
      throw error;
    }
  }

  public readonly getSnapshot = (): RecordViewSnapshot<T> => {
    return this._snapshot;
  };

  public readonly subscribe = (listener: RecordViewListener<T>): (() => void) => {
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

    const subscription = this._subscription;
    this._subscription = undefined;
    if (subscription !== undefined) {
      await subscription.close();
    }
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
      if (!isOk(result)) {
        throw new Error(`RecordView: query failed (${result.status.code}): ${result.status.detail}`);
      }

      const currentness = await this.resolveCurrentness();
      if (!this.canPublishGeneration(generation)) {
        return;
      }
      this.publishMaterialization(result, currentness);
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
    result: RecordsQueryResponse,
    currentness: RecordViewCurrentness,
  ): void {
    const records = result.records.map((record) => new TypedRecord<T>(record));
    const hasMore = result.cursor !== undefined;
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

  private publish(snapshot: RecordViewSnapshot<T>): void {
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

function immutableSnapshot<T>(snapshot: RecordViewSnapshot<T>): RecordViewSnapshot<T> {
  const records = Object.freeze([...snapshot.records]);
  return Object.freeze({ ...snapshot, records });
}

/** Project the canonical query down to fields that cannot leave its structural scope. */
function structuralWakeFilter(filter: CompiledRecordQuery['filter']): RecordsFilter {
  return {
    protocol     : filter.protocol,
    protocolPath : filter.protocolPath,
    ...(filter.contextId === undefined ? {} : { contextId: filter.contextId }),
    ...(filter.recordId === undefined ? {} : { recordId: filter.recordId }),
  };
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
