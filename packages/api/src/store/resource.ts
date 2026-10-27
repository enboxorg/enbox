import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';
import type { ExpandableRecordView, RecordViewState } from '../record-view.js';

import { StoreNotConnectedError, StoreRetiredError, toStoreError } from './scope.js';

/** Native collection state plus an empty idle state when no observation or usable session is available. */
export type StoreCollectionState<Item> = RecordViewState<Item> | Readonly<{
  status: 'idle';
  records: readonly Item[];
  hasMore: false;
  current: false;
  error?: never;
}>;

/**
 * A shared lazy observation of one native materialized selection.
 * Subscriptions and retain() keep it live; async controls hold temporary leases.
 * Constructing or reading the handle does not open a view.
 */
export interface StoreCollectionResource<Item> extends ObservableStore<StoreCollectionState<Item>> {
  /** Return cached empty idle state for server rendering and hydration. */
  getServerSnapshot(): StoreCollectionState<Item>;
  /** Keep the selection live until the returned idempotent release function runs or its session ends. */
  retain(): () => void;
  /**
   * Wait for usable local rows, including all pages when loadAll is enabled.
   * This waiter releases its lease on settlement; cancellation affects only this waiter.
   * Use retain() when the observation must remain live afterwards.
   */
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>>;
  /**
   * Reopen the view and wait for attachment, rather than usable rows.
   * Concurrent retries share completion; existing subscriptions and leases remain in effect.
   * Retain or subscribe when the replacement observation must remain live after this call.
   */
  retry(): Promise<void>;
  /**
   * Expand the native prefix by one configured page; concurrent calls share work and failures remain observable.
   * Retain or subscribe to preserve the expanded prefix after this temporary control lease ends.
   */
  loadMore(): Promise<void>;
  /**
   * Recompute usable local rows, including loadAll pages, without implying remote replication is current.
   * The returned state does not retain the observation; retain or subscribe for later updates.
   */
  refresh(): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>>;
}

/** @internal Mutation commands refresh retained selections without opening unused views. */
export interface StoreCollectionController<Item> extends StoreCollectionResource<Item> {
  /** Refresh only an existing observation; an unused selection remains unopened. */
  refreshIfActive(): Promise<void>;
}

/** One pending or attached native view, with cancellation and serialized pagination controls. */
type CollectionObservation<Item> = {
  abortController: AbortController;
  openPromise: Promise<ExpandableRecordView<Item>>;
  view?: ExpandableRecordView<Item>;
  unsubscribe?: () => void;
  loadMorePromise?: Promise<void>;
  loadAllPromise?: Promise<void>;
};

/** @internal Keep native view ownership outside framework bindings. */
export function createCollectionResource<Item>(
  scope: StoreScope,
  openView: (signal: AbortSignal) => Promise<ExpandableRecordView<Item>>,
  options: Readonly<{
    loadAll?: boolean;
    /** Keep protocol write refreshers limited to observations with an active owner. */
    onObservationChange?: (active: boolean) => void;
  }> = {},
): StoreCollectionController<Item> {
  const idleState = Object.freeze({ status: 'idle' as const, records: Object.freeze([]), hasMore: false as const, current: false as const });
  let state: StoreCollectionState<Item> = idleState;
  let activeObservation: CollectionObservation<Item> | undefined;
  let leaseCount = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let retrying: Promise<void> | undefined;
  const listeners = new Set<(state: StoreCollectionState<Item>) => void>();
  const cleanups = new Set<Promise<void>>();
  const cleanupFailures: unknown[] = [];
  const openings = new Set<Promise<ExpandableRecordView<Item>>>();

  const publish = (nextState: StoreCollectionState<Item>): void => {
    if (closed || state === nextState) { return; }
    state = nextState;
    const subscribers = [...listeners];
    for (const listener of subscribers) {
      if (listeners.has(listener)) {
        try { listener(nextState); } catch { /* Consumer failures do not affect a native view. */ }
      }
    }
  };
  const isActiveObservation = (observation: CollectionObservation<Item>): boolean =>
    !closed && !scope.signal.aborted && activeObservation === observation;
  const assertActiveObservation = (observation: CollectionObservation<Item>): void => {
    scope.assertCurrent();
    if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
  };
  const trackClose = (view: ExpandableRecordView<Item>): Promise<void> => {
    // Register completion before native cleanup can synchronously reenter this owner.
    const cleanup = Promise.resolve().then(() => view.close());
    cleanups.add(cleanup);
    void cleanup.then(
      (): void => { cleanups.delete(cleanup); },
      (error: unknown): void => {
        cleanups.delete(cleanup);
        cleanupFailures.push(error);
        console.warn('[@enbox/api] Store resource cleanup failed.', error);
      },
    );
    return cleanup;
  };
  const retireObservation = (): void => {
    const previous = activeObservation;
    // Detach first so cleanup callbacks cannot reclaim the retiring view.
    activeObservation = undefined;
    if (previous === undefined) { return; }
    // Acquire cleanup ownership before unsubscribe or abort callbacks can reenter close().
    if (previous.view !== undefined) { trackClose(previous.view); }
    options.onObservationChange?.(false);
    try { previous.unsubscribe?.(); } finally { previous.abortController.abort(); }
  };
  const fail = (observation: CollectionObservation<Item>, error: unknown): void => {
    if (!isActiveObservation(observation)) { return; }
    publish(Object.freeze({
      status  : 'error',
      records : state.records,
      hasMore : state.hasMore,
      current : false,
      error   : toStoreError(error),
    }));
  };

  const page = (observation: CollectionObservation<Item>): Promise<void> => {
    if (observation.loadMorePromise !== undefined) { return observation.loadMorePromise; }
    const pending = observation.openPromise.then(async (view): Promise<void> => {
      assertActiveObservation(observation);
      await view.loadMore();
    });
    observation.loadMorePromise = pending;
    void pending.then(
      (): void => { observation.loadMorePromise = undefined; },
      (error: unknown): void => { observation.loadMorePromise = undefined; fail(observation, error); },
    );
    return pending;
  };

  const drainAll = (observation: CollectionObservation<Item>): Promise<void> => {
    if (observation.loadAllPromise !== undefined) { return observation.loadAllPromise; }
    const pending = observation.openPromise.then((view): Promise<void> => {
      const expand = (): Promise<void> => {
        if (!isActiveObservation(observation) || !view.getSnapshot().hasMore) { return Promise.resolve(); }
        return page(observation).then(expand);
      };
      return view.ready({ signal: observation.abortController.signal }).then(expand);
    });
    observation.loadAllPromise = pending;
    void pending.then(
      (): void => { observation.loadAllPromise = undefined; },
      (error: unknown): void => { observation.loadAllPromise = undefined; fail(observation, error); },
    );
    return pending;
  };

  const refresh = async (observation: CollectionObservation<Item>): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
    try {
      const view = await observation.openPromise;
      assertActiveObservation(observation);
      await view.refresh();
      if (options.loadAll) { await drainAll(observation); }
      assertActiveObservation(observation);
      const state = await view.ready();
      assertActiveObservation(observation);
      return state;
    } catch (error: unknown) { fail(observation, error); throw error; }
  };

  const startObservation = (): CollectionObservation<Item> => {
    scope.assertCurrent();
    if (closed) { throw new StoreRetiredError(); }
    if (activeObservation !== undefined) { return activeObservation; }
    const abortController = new AbortController();
    const observation: CollectionObservation<Item> = {
      abortController,
      // The owner registers this observation before its opener runs.
      openPromise: Promise.resolve().then(async (): Promise<ExpandableRecordView<Item>> => {
        assertActiveObservation(observation);
        const view = await openView(AbortSignal.any([abortController.signal, scope.signal]));
        if (!isActiveObservation(observation)) {
          await trackClose(view);
          throw new StoreRetiredError();
        }
        observation.view = view;
        // Attach before reading state, then check again in case subscribe() reentered cleanup.
        const unsubscribe = view.subscribe((state): void => {
          if (isActiveObservation(observation)) {
            publish(state);
            if (options.loadAll && state.status === 'ready' && state.hasMore) {
              void drainAll(observation).catch((): void => {});
            }
          }
        });
        if (!isActiveObservation(observation)) {
          unsubscribe();
          return view;
        }
        observation.unsubscribe = unsubscribe;
        publish(view.getSnapshot());
        return view;
      }),
    };
    activeObservation = observation;
    openings.add(observation.openPromise);
    void observation.openPromise.then(
      (): void => { openings.delete(observation.openPromise); },
      (): void => { openings.delete(observation.openPromise); },
    );
    options.onObservationChange?.(true);
    publish(Object.freeze({ status: 'loading', records: Object.freeze([]), hasMore: false, current: false }));
    void observation.openPromise.catch((error: unknown): void => { fail(observation, error); });
    if (options.loadAll) { void drainAll(observation).catch((): void => {}); }
    return observation;
  };
  const startAutomaticObservation = (): void => {
    try { startObservation(); } catch (error: unknown) {
      if (!(error instanceof StoreNotConnectedError) && !closed && !scope.signal.aborted) {
        publish(Object.freeze({ status: 'error', records: Object.freeze([]), hasMore: false, current: false, error: toStoreError(error) }));
      }
    }
  };
  const releaseUnused = (): void => {
    if (leaseCount === 0 && listeners.size === 0 && !closed) {
      retireObservation();
      if (activeObservation === undefined) { publish(idleState); }
    }
  };
  const acquireLease = (): (() => void) => {
    leaseCount += 1;
    let released = false;
    return (): void => {
      if (released) { return; }
      released = true;
      leaseCount -= 1;
      releaseUnused();
    };
  };
  const waitForCleanup = async (): Promise<void> => {
    await Promise.allSettled(openings);
    await Promise.allSettled(cleanups);
    // Late openers and reentrant cleanup can register another owned close while earlier work finishes.
    if (openings.size > 0 || cleanups.size > 0) { return waitForCleanup(); }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Store resource cleanup failed.');
    }
  };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) { return closePromise; }
    // Install terminal completion before retiring subscriptions can synchronously reenter.
    closePromise = Promise.resolve().then(waitForCleanup);
    try {
      retireObservation();
    } catch (error) {
      cleanupFailures.push(error);
    } finally {
      publish(idleState);
      closed = true;
      listeners.clear();
      scope.signal.removeEventListener('abort', abort);
    }
    return closePromise;
  };
  const abort = (): void => { void close().catch((): void => {}); };
  scope.signal.addEventListener('abort', abort, { once: true });
  scope.onClose(close);

  return {
    getSnapshot       : (): StoreCollectionState<Item> => state,
    getServerSnapshot : (): StoreCollectionState<Item> => idleState,
    subscribe         : (listener): (() => void) => {
      if (closed) { return (): void => {}; }
      listeners.add(listener);
      startAutomaticObservation();
      return (): void => { listeners.delete(listener); releaseUnused(); };
    },
    retain: (): (() => void) => {
      if (closed) { return (): void => {}; }
      const release = acquireLease();
      startAutomaticObservation();
      return release;
    },
    ready: async (readyOptions = {}): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
      readyOptions.signal?.throwIfAborted();
      const release = acquireLease();
      try {
        const observation = startObservation();
        const view = await whileNotAborted(observation.openPromise, readyOptions.signal);
        assertActiveObservation(observation);
        if (options.loadAll) { await whileNotAborted(drainAll(observation), readyOptions.signal); }
        const state = await view.ready(readyOptions);
        assertActiveObservation(observation);
        readyOptions.signal?.throwIfAborted();
        return state;
      } finally { release(); }
    },
    retry: (): Promise<void> => {
      try { scope.assertCurrent(); } catch (error: unknown) { return Promise.reject(error); }
      if (retrying !== undefined) { return retrying; }
      const release = acquireLease();
      // Publish the shared completion before retiring subscriptions can request another retry.
      const pending = Promise.resolve().then(async (): Promise<void> => {
        scope.assertCurrent();
        retireObservation();
        const observation = startObservation();
        await observation.openPromise;
        assertActiveObservation(observation);
      }).finally((): void => {
        if (retrying === pending) { retrying = undefined; }
        release();
      });
      retrying = pending;
      return pending;
    },
    loadMore: (): Promise<void> => {
      let release: (() => void) | undefined;
      try {
        scope.assertCurrent();
        release = acquireLease();
        return page(startObservation()).finally(release);
      } catch (error: unknown) { release?.(); return Promise.reject(error); }
    },
    refresh: async (): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
      scope.assertCurrent();
      const release = acquireLease();
      try { return await refresh(startObservation()); } finally { release(); }
    },
    refreshIfActive: async (): Promise<void> => {
      const observation = activeObservation;
      if (observation !== undefined && isActiveObservation(observation)) { await refresh(observation); }
    },
  };
}


function whileNotAborted<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (signal === undefined) { return promise; }
  signal.throwIfAborted();
  return new Promise<Value>((resolve, reject): void => {
    const abort = (): void => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value): void => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown): void => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
