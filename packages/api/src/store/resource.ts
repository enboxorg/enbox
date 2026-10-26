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
   */
  retry(): Promise<void>;
  /** Expand the native prefix by one configured page; concurrent calls share work and failures remain observable. */
  loadMore(): Promise<void>;
  /** Recompute usable local rows, including loadAll pages, without implying remote replication is current. */
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
  options: Readonly<{ loadAll?: boolean }> = {},
): StoreCollectionController<Item> {
  const idleState = Object.freeze({ status: 'idle' as const, records: Object.freeze([]), hasMore: false as const, current: false as const });
  let state: StoreCollectionState<Item> = idleState;
  let activeObservation: CollectionObservation<Item> | undefined;
  let leaseCount = 0;
  let closed = false;
  let retrying: Promise<void> | undefined;
  const listeners = new Set<(state: StoreCollectionState<Item>) => void>();
  const cleanups = new Set<Promise<void>>();
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
  const trackClose = (view: ExpandableRecordView<Item>): void => {
    // Register completion before native cleanup can synchronously reenter this owner.
    const cleanup = Promise.resolve().then(() => view.close());
    cleanups.add(cleanup);
    void cleanup.then(
      (): void => { cleanups.delete(cleanup); },
      (error: unknown): void => {
        cleanups.delete(cleanup);
        console.warn('[@enbox/api] Store resource cleanup failed.', error);
      },
    );
  };
  const retireObservation = (): void => {
    const previous = activeObservation;
    // Detach first so cleanup callbacks cannot reclaim the retiring view.
    activeObservation = undefined;
    if (previous === undefined) { return; }
    previous.unsubscribe?.();
    previous.abortController.abort();
    if (previous.view !== undefined) { trackClose(previous.view); }
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
      scope.assertCurrent();
      if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
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
      scope.assertCurrent();
      if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
      await view.refresh();
      if (options.loadAll) { await drainAll(observation); }
      scope.assertCurrent();
      if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
      const state = await view.ready();
      scope.assertCurrent();
      if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
      return state;
    } catch (error: unknown) { fail(observation, error); throw error; }
  };

  const startObservation = (): CollectionObservation<Item> => {
    scope.assertCurrent();
    if (closed) { throw new Error('Store collection is closed.'); }
    if (activeObservation !== undefined) { return activeObservation; }
    const abortController = new AbortController();
    const observation: CollectionObservation<Item> = {
      abortController,
      // The owner registers this observation before its opener runs.
      openPromise: Promise.resolve().then(async (): Promise<ExpandableRecordView<Item>> => {
        scope.assertCurrent();
        if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
        const view = await openView(AbortSignal.any([abortController.signal, scope.signal]));
        if (!isActiveObservation(observation)) {
          await view.close();
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
  const close = async (): Promise<void> => {
    if (!closed) {
      retireObservation();
      publish(idleState);
      closed = true;
      listeners.clear();
      scope.signal.removeEventListener('abort', abort);
    }
    await Promise.allSettled(openings);
    await Promise.all(cleanups);
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
      leaseCount += 1;
      startAutomaticObservation();
      let released = false;
      return (): void => {
        if (released) { return; }
        released = true;
        leaseCount -= 1;
        releaseUnused();
      };
    },
    ready: async (readyOptions = {}): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
      readyOptions.signal?.throwIfAborted();
      leaseCount += 1;
      try {
        const observation = startObservation();
        const view = await whileNotAborted(observation.openPromise, readyOptions.signal);
        scope.assertCurrent();
        if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
        if (options.loadAll) { await whileNotAborted(drainAll(observation), readyOptions.signal); }
        const state = await view.ready(readyOptions);
        scope.assertCurrent();
        if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
        readyOptions.signal?.throwIfAborted();
        return state;
      } finally { leaseCount -= 1; releaseUnused(); }
    },
    retry: (): Promise<void> => {
      try { scope.assertCurrent(); } catch (error: unknown) { return Promise.reject(error); }
      if (retrying !== undefined) { return retrying; }
      leaseCount += 1;
      // Publish the shared completion before retiring subscriptions can request another retry.
      const pending = Promise.resolve().then(async (): Promise<void> => {
        scope.assertCurrent();
        retireObservation();
        const observation = startObservation();
        await observation.openPromise;
        scope.assertCurrent();
        if (!isActiveObservation(observation)) { throw new StoreRetiredError(); }
      }).finally((): void => {
        if (retrying === pending) { retrying = undefined; }
        leaseCount -= 1;
        releaseUnused();
      });
      retrying = pending;
      return pending;
    },
    loadMore: (): Promise<void> => {
      try {
        scope.assertCurrent();
        leaseCount += 1;
        let pending: Promise<void>;
        try { pending = page(startObservation()); } catch (error: unknown) { leaseCount -= 1; releaseUnused(); throw error; }
        return pending.finally((): void => { leaseCount -= 1; releaseUnused(); });
      } catch (error: unknown) { return Promise.reject(error); }
    },
    refresh: async (): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
      scope.assertCurrent();
      leaseCount += 1;
      try { return await refresh(startObservation()); } finally { leaseCount -= 1; releaseUnused(); }
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
