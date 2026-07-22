import type { DwnApi } from './dwn-api.js';
import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { RecordsFilter } from '@enbox/dwn-sdk-js';
import type { TypedRecord } from './typed-record.js';
import type { DwnPaginationCursor, DwnResponseStatus, ReplicationLinkSnapshot, SyncEngine, SyncEvent, SyncIdentityOptions } from '@enbox/agent';

/** Currentness of one locally materialized records view. */
export type RecordViewState = 'loading' | 'ready' | 'stale' | 'error';

/** Immutable materialization published by a {@link RecordView}. */
export type RecordViewSnapshot<T> = Readonly<{
  /** Whether the local materialization is current with its configured replicated sources. */
  state: RecordViewState;

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

  /** The last query, authorization, or terminal subscription failure. */
  error?: Error;
}>;

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

  /** Fence callbacks and close the underlying local subscription. */
  close(): Promise<void>;
}

/** @internal Dependencies supplied by {@link TypedEnbox} for one view. */
type RecordViewOptions<T> = {
  dwn: DwnApi;
  filter: RecordsFilter;
  materialize: () => Promise<DwnResponseStatus & {
    records: TypedRecord<T>[];
    cursor?: DwnPaginationCursor;
  }>;
  protocol: string;
  protocolRole?: string;
  signal?: AbortSignal;
  sync?: SyncEngine;
};

/** @internal Create and open one local observed records view. */
export async function createRecordView<T>(options: RecordViewOptions<T>): Promise<RecordView<T>> {
  options.signal?.throwIfAborted();
  const view = new ObservedRecordView(options);
  await view.open();
  return view;
}

/** One serialized, wake-driven materialization resource. */
class ObservedRecordView<T> implements RecordView<T> {
  private readonly _dwn: DwnApi;
  private readonly _filter: RecordsFilter;
  private readonly _listeners = new Set<RecordViewListener<T>>();
  private readonly _materialize: RecordViewOptions<T>['materialize'];
  private readonly _protocol: string;
  private readonly _protocolRole?: string;
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
    void this.close().catch((): void => {});
  };

  public constructor(options: RecordViewOptions<T>) {
    this._dwn = options.dwn;
    this._filter = options.filter;
    this._materialize = options.materialize;
    this._protocol = options.protocol;
    this._protocolRole = options.protocolRole;
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
        filter       : structuralWakeFilter(this._filter),
        pagination   : { limit: 1 },
        protocolRole : this._protocolRole,
        subscriptionHandler,
      });

      if (this._closed) {
        await reply.subscription?.close();
        this._signal?.throwIfAborted();
        throw new Error('RecordView: closed while opening the local subscription.');
      }

      if (reply.status.code < 200 || reply.status.code >= 300 || reply.subscription === undefined) {
        await reply.subscription?.close();
        throw new Error(
          `RecordView: unable to open local subscription (${reply.status.code}): ${reply.status.detail}`,
        );
      }

      this._subscription = reply.subscription;
      this._isOpen = true;
      const wakeArrivedWhileOpening = this._materializationRequested;
      this._materializationRequested = false;
      this.requestMaterialization();
      if (wakeArrivedWhileOpening) {
        this.requestMaterialization();
      }
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
      // A changed scope or authorization epoch defines a new baseline. A
      // prior local-only or differently scoped `ready` snapshot cannot prove
      // currentness for the replacement registration.
      if (registrationCoversProtocol(event.options, this._protocol)) {
        this._hasPublishedReady = false;
        this.publish(immutableSnapshot({
          state   : 'loading',
          records : this._snapshot.records,
          hasMore : this._snapshot.hasMore,
        }));
      }
      this.requestMaterialization();
      return;
    }

    if (!eventCoversProtocol(event, this._protocol)) {
      return;
    }

    if (event.type === 'link:status-change') {
      if (event.to === 'paused') {
        this.publishError(new Error(`RecordView: replication is paused for protocol '${this._protocol}'.`));
      } else if (event.to !== 'live') {
        this.publishReplicaUnavailable();
      }
      this.requestMaterialization();
      return;
    }

    if (event.type === 'link:connectivity-change') {
      if (event.to !== 'online') {
        this.publishReplicaUnavailable();
      }
      this.requestMaterialization();
      return;
    }

    if (event.type === 'pull:currentness-change') {
      if (!event.to) {
        this.publishReplicaUnavailable();
      } else {
        this.requestMaterialization();
      }
    }
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
        this._materializationRequested = false;
        const generation = this._requestGeneration;

        try {
          const result = await this._materialize();
          if (result.status.code < 200 || result.status.code >= 300) {
            throw new Error(`RecordView: query failed (${result.status.code}): ${result.status.detail}`);
          }

          const currentness = await this.resolveCurrentness();
          if (this._closed || generation !== this._requestGeneration) {
            continue;
          }

          if ('error' in currentness) {
            this.publishError(currentness.error);
            continue;
          }

          if (currentness.state === 'stale') {
            this.publish(immutableSnapshot({
              state   : 'stale',
              records : result.records,
              hasMore : result.cursor !== undefined,
            }));
            continue;
          }

          const hasMore = result.cursor !== undefined;
          if (currentness.state === 'ready') {
            this._hasPublishedReady = true;
          }
          this.publish(immutableSnapshot({
            state   : currentness.state,
            records : result.records,
            hasMore,
          }));
        } catch (error: unknown) {
          if (!this._closed && generation === this._requestGeneration) {
            this.publishError(toError(error));
          }
        }
      }
    } finally {
      this._isMaterializing = false;
      if (!this._closed && this._materializationRequested) {
        this.requestMaterialization();
      }
    }
  }

  /** Resolve whether this protocol has completed its configured remote baseline. */
  private async resolveCurrentness(): Promise<
    { state: Exclude<RecordViewState, 'error'> } | { error: Error }
    > {
    if (this._sync === undefined) {
      return { state: 'ready' };
    }

    const registration = await this._sync.getIdentityOptions(this._dwn.connectedDid);
    if (!registrationCoversProtocol(registration, this._protocol)) {
      return { state: 'ready' };
    }

    const links = (await this._sync.getReplicationLinks(this._dwn.connectedDid))
      .filter((link): boolean => linkCoversProtocol(link, this._protocol));
    if (links.some((link): boolean => link.status === 'paused')) {
      return {
        error: new Error(`RecordView: replication is paused for protocol '${this._protocol}'.`),
      };
    }

    const isCurrent = links.length > 0 && links.every((link): boolean =>
      link.status === 'live' && link.connectivity === 'online' && link.isPullCurrent);
    if (isCurrent) {
      return { state: 'ready' };
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

  /** Degrade currentness synchronously; local query latency must never delay it. */
  private publishReplicaUnavailable(): void {
    this.publish(immutableSnapshot({
      state   : this._hasPublishedReady ? 'stale' : 'loading',
      records : this._snapshot.records,
      hasMore : this._snapshot.hasMore,
    }));
  }

  private publish(snapshot: RecordViewSnapshot<T>): void {
    if (this._closed) {
      return;
    }

    this._snapshot = snapshot;
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch {
        // A consumer cannot poison the view or prevent other notifications.
      }
    }
  }
}

function immutableSnapshot<T>(snapshot: {
  state: RecordViewState;
  records: readonly TypedRecord<T>[];
  hasMore: boolean;
  error?: Error;
}): RecordViewSnapshot<T> {
  const records = Object.freeze([...snapshot.records]);
  return Object.freeze({ ...snapshot, records });
}

/** Project the canonical query down to fields that cannot leave its structural scope. */
function structuralWakeFilter(filter: RecordsFilter): RecordsFilter {
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
