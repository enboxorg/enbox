import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';
import type { ExpandableRecordView, RecordViewState } from '../record-view.js';

import { StoreNotConnectedError, StoreRetiredError, toStoreError } from './scope.js';

/** An unopened or inactive collection retains no rows. */
export type StoreCollectionSnapshot<Item> = RecordViewState<Item> | Readonly<{
  status: 'idle';
  records: readonly Item[];
  hasMore: false;
  current: false;
  error?: never;
}>;

/** A shared lazy resource over one native materialized record view. */
export interface StoreCollectionResource<Item> extends ObservableStore<StoreCollectionSnapshot<Item>> {
  getServerSnapshot(): StoreCollectionSnapshot<Item>;
  /** Keep this selection live until release; concurrent consumers share one native view. */
  retain(): () => void;
  /**
   * Temporarily retain usable local rows, including every page when loadAll is enabled.
   * The waiter releases its ownership on settlement; use retain() for a persistent consumer.
   */
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>>;
  /** Reopen the native view. Subscriber and explicit retain() ownership remain unchanged. */
  retry(): Promise<void>;
  loadMore(): Promise<void>;
  /** Rematerialize the native query without claiming remote replication currentness. */
  refresh(): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>>;
}

/** @internal Mutation commands refresh acquired selections without opening unused views. */
export interface StoreCollectionController<Item> extends StoreCollectionResource<Item> {
  refreshIfActive(): Promise<void>;
}

type Attempt<Item> = {
  controller: AbortController;
  opening: Promise<ExpandableRecordView<Item>>;
  view?: ExpandableRecordView<Item>;
  unsubscribe?: () => void;
  paging?: Promise<void>;
  loadingAll?: Promise<void>;
};

/** @internal Keep native view ownership outside framework bindings. */
export function createCollectionResource<Item>(
  scope: StoreScope,
  open: (signal: AbortSignal) => Promise<ExpandableRecordView<Item>>,
  options: Readonly<{ loadAll?: boolean }> = {},
): StoreCollectionController<Item> {
  const idle = Object.freeze({ status: 'idle' as const, records: Object.freeze([]), hasMore: false as const, current: false as const });
  let snapshot: StoreCollectionSnapshot<Item> = idle;
  let attempt: Attempt<Item> | undefined;
  let retained = 0;
  let closed = false;
  let retrying: Promise<void> | undefined;
  const listeners = new Set<(state: StoreCollectionSnapshot<Item>) => void>();
  const cleanups = new Set<Promise<void>>();
  const openings = new Set<Promise<ExpandableRecordView<Item>>>();

  const publish = (state: StoreCollectionSnapshot<Item>): void => {
    if (closed || snapshot === state) { return; }
    snapshot = state;
    const subscribers = [...listeners];
    for (const listener of subscribers) {
      if (listeners.has(listener)) {
        try { listener(state); } catch { /* Consumer failures do not affect a native view. */ }
      }
    }
  };
  const valid = (candidate: Attempt<Item>): boolean => !closed && !scope.signal.aborted && attempt === candidate;
  const trackClose = (view: ExpandableRecordView<Item>): void => {
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
  const retire = (): void => {
    const previous = attempt;
    attempt = undefined;
    if (previous === undefined) { return; }
    previous.unsubscribe?.();
    previous.controller.abort();
    if (previous.view !== undefined) { trackClose(previous.view); }
  };
  const fail = (candidate: Attempt<Item>, error: unknown): void => {
    if (!valid(candidate)) { return; }
    publish(Object.freeze({
      status  : 'error',
      records : snapshot.records,
      hasMore : snapshot.hasMore,
      current : false,
      error   : toStoreError(error),
    }));
  };

  const page = (candidate: Attempt<Item>): Promise<void> => {
    if (candidate.paging !== undefined) { return candidate.paging; }
    const pending = candidate.opening.then(async (view): Promise<void> => {
      scope.assertCurrent();
      if (!valid(candidate)) { throw new StoreRetiredError(); }
      await view.loadMore();
    });
    candidate.paging = pending;
    void pending.then(
      (): void => { candidate.paging = undefined; },
      (error: unknown): void => { candidate.paging = undefined; fail(candidate, error); },
    );
    return pending;
  };

  const drainAll = (candidate: Attempt<Item>): Promise<void> => {
    if (candidate.loadingAll !== undefined) { return candidate.loadingAll; }
    const pending = candidate.opening.then((view): Promise<void> => {
      const expand = (): Promise<void> => {
        if (!valid(candidate) || !view.getSnapshot().hasMore) { return Promise.resolve(); }
        return page(candidate).then(expand);
      };
      return view.ready({ signal: candidate.controller.signal }).then(expand);
    });
    candidate.loadingAll = pending;
    void pending.then(
      (): void => { candidate.loadingAll = undefined; },
      (error: unknown): void => { candidate.loadingAll = undefined; fail(candidate, error); },
    );
    return pending;
  };

  const refresh = async (candidate: Attempt<Item>): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
    try {
      const view = await candidate.opening;
      scope.assertCurrent();
      if (!valid(candidate)) { throw new StoreRetiredError(); }
      await view.refresh();
      if (options.loadAll) { await drainAll(candidate); }
      scope.assertCurrent();
      if (!valid(candidate)) { throw new StoreRetiredError(); }
      const state = await view.ready();
      scope.assertCurrent();
      if (!valid(candidate)) { throw new StoreRetiredError(); }
      return state;
    } catch (error: unknown) { fail(candidate, error); throw error; }
  };

  const start = (): Attempt<Item> => {
    scope.assertCurrent();
    if (closed) { throw new Error('Store collection is closed.'); }
    if (attempt !== undefined) { return attempt; }
    const controller = new AbortController();
    const candidate: Attempt<Item> = {
      controller,
      opening: Promise.resolve().then(async (): Promise<ExpandableRecordView<Item>> => {
        scope.assertCurrent();
        if (!valid(candidate)) { throw new StoreRetiredError(); }
        const view = await open(AbortSignal.any([controller.signal, scope.signal]));
        if (!valid(candidate)) {
          await view.close();
          throw new StoreRetiredError();
        }
        candidate.view = view;
        const unsubscribe = view.subscribe((state): void => {
          if (valid(candidate)) {
            publish(state);
            if (options.loadAll && state.status === 'ready' && state.hasMore) {
              void drainAll(candidate).catch((): void => {});
            }
          }
        });
        if (!valid(candidate)) {
          unsubscribe();
          return view;
        }
        candidate.unsubscribe = unsubscribe;
        publish(view.getSnapshot());
        return view;
      }),
    };
    attempt = candidate;
    openings.add(candidate.opening);
    void candidate.opening.then(
      (): void => { openings.delete(candidate.opening); },
      (): void => { openings.delete(candidate.opening); },
    );
    publish(Object.freeze({ status: 'loading', records: Object.freeze([]), hasMore: false, current: false }));
    void candidate.opening.catch((error: unknown): void => { fail(candidate, error); });
    if (options.loadAll) { void drainAll(candidate).catch((): void => {}); }
    return candidate;
  };
  const startAutomatic = (): void => {
    try { start(); } catch (error: unknown) {
      if (!(error instanceof StoreNotConnectedError) && !closed && !scope.signal.aborted) {
        publish(Object.freeze({ status: 'error', records: Object.freeze([]), hasMore: false, current: false, error: toStoreError(error) }));
      }
    }
  };
  const releaseUnused = (): void => {
    if (retained === 0 && listeners.size === 0 && !closed) {
      retire();
      if (attempt === undefined) { publish(idle); }
    }
  };
  const close = async (): Promise<void> => {
    if (!closed) {
      retire();
      publish(idle);
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
    getSnapshot       : (): StoreCollectionSnapshot<Item> => snapshot,
    getServerSnapshot : (): StoreCollectionSnapshot<Item> => idle,
    subscribe         : (listener): (() => void) => {
      if (closed) { return (): void => {}; }
      listeners.add(listener);
      startAutomatic();
      return (): void => { listeners.delete(listener); releaseUnused(); };
    },
    retain: (): (() => void) => {
      if (closed) { return (): void => {}; }
      retained += 1;
      startAutomatic();
      let released = false;
      return (): void => {
        if (released) { return; }
        released = true;
        retained -= 1;
        releaseUnused();
      };
    },
    ready: async (readyOptions = {}): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
      readyOptions.signal?.throwIfAborted();
      retained += 1;
      try {
        const candidate = start();
        const view = await whileNotAborted(candidate.opening, readyOptions.signal);
        scope.assertCurrent();
        if (!valid(candidate)) { throw new StoreRetiredError(); }
        if (options.loadAll) { await whileNotAborted(drainAll(candidate), readyOptions.signal); }
        const state = await view.ready(readyOptions);
        scope.assertCurrent();
        if (!valid(candidate)) { throw new StoreRetiredError(); }
        readyOptions.signal?.throwIfAborted();
        return state;
      } finally { retained -= 1; releaseUnused(); }
    },
    retry: (): Promise<void> => {
      try { scope.assertCurrent(); } catch (error: unknown) { return Promise.reject(error); }
      if (retrying !== undefined) { return retrying; }
      retained += 1;
      const pending = Promise.resolve().then(async (): Promise<void> => {
        scope.assertCurrent();
        retire();
        const candidate = start();
        await candidate.opening;
        scope.assertCurrent();
        if (!valid(candidate)) { throw new StoreRetiredError(); }
      }).finally((): void => {
        if (retrying === pending) { retrying = undefined; }
        retained -= 1;
        releaseUnused();
      });
      retrying = pending;
      return pending;
    },
    loadMore: (): Promise<void> => {
      try {
        scope.assertCurrent();
        retained += 1;
        let pending: Promise<void>;
        try { pending = page(start()); } catch (error: unknown) { retained -= 1; releaseUnused(); throw error; }
        return pending.finally((): void => { retained -= 1; releaseUnused(); });
      } catch (error: unknown) { return Promise.reject(error); }
    },
    refresh: async (): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> => {
      scope.assertCurrent();
      retained += 1;
      try { return await refresh(start()); } finally { retained -= 1; releaseUnused(); }
    },
    refreshIfActive: async (): Promise<void> => {
      const candidate = attempt;
      if (candidate !== undefined && valid(candidate)) { await refresh(candidate); }
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
