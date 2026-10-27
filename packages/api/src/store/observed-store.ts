import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';
import type { ExpandableRecordView, RecordViewState } from '../record-view.js';

import { StoreNotConnectedError, StoreRetiredError, toStoreError, withStoreSignal } from './scope.js';

/** State shared by native observable views; payload fields remain native to each view. */
export type NativeObservationState = Readonly<
  | { status: 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: Error }
>;

type Payload<State> = State extends unknown ? Omit<State, 'status' | 'error' | 'selection' | 'isLoadingMore'> : never;
type SelectionState<Selection> = [Selection] extends [never] ? unknown : Readonly<{ selection: Selection | null }>;
type ReadyObservationState<State, Selection> = Extract<State, { status: 'ready' }> &
  Readonly<{ isLoadingMore: boolean }> & SelectionState<Selection>;

/** Native state with shared ownership metadata; payloads are optional until a view supplies them. */
export type ObservedStoreState<State extends NativeObservationState, Selection = never> = (
  | (Partial<Payload<State>> & Readonly<{ status: 'idle'; error?: never }>)
  | (Partial<Payload<State>> & Readonly<{ status: 'loading'; error?: never }>)
  | (Partial<Payload<State>> & Readonly<{ status: 'error'; error: Error }>)
  | Extract<State, { status: 'ready' }>
) & Readonly<{ isLoadingMore: boolean }> & SelectionState<Selection>;

interface ObservationOwner<State extends NativeObservationState, Selection> extends ObservableStore<ObservedStoreState<State, Selection>> {
  /** Keep this observation live until the returned idempotent release runs or its owner ends. */
  retain(): () => void;
  /** Wait for usable state with a temporary lease; cancellation affects this waiter alone. */
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<ReadyObservationState<State, Selection>>;
  /** Reopen the current observation and await usable state, including configured loadAll pages. */
  retry(): Promise<void>;
  /** Invalidate this owner and await its native openers and cleanup, surfacing release failures. */
  close(): Promise<void>;
}

/** A lazy native-view owner; selectable stores also own their explicit choice until cleared or closed. */
export type ObservedStore<State extends NativeObservationState = NativeObservationState, Selection = never> =
  ObservationOwner<State, Selection> & ([Selection] extends [never] ? unknown : Readonly<{
    /** Select and retain one input until replacement, null, close, or abort; await its usable local state. */
    select(selection: Selection | null): Promise<void>;
  }>);

interface NativeObservation<State extends NativeObservationState = NativeObservationState> extends ObservableStore<State> {
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<Extract<State, { status: 'ready' }>>;
  close(): Promise<void>;
}
type Refresh<State extends NativeObservationState, Selection> = Readonly<{
  /** Request another read from the observed source and await usable state. */
  refresh(): Promise<ReadyObservationState<State, Selection>>;
}>;
type Pagination = Readonly<{
  /** Share one page expansion and await its usable local rows. */
  loadMore(): Promise<void>;
}>;
type NativeState<Native extends NativeObservation> = ReturnType<Native['getSnapshot']>;
type ObservedSourceState<Source extends ObservedStore> = Extract<
  ReturnType<Source['getSnapshot']> extends infer State
    ? State extends unknown ? Omit<State, 'selection' | 'isLoadingMore'> : never
    : never,
  NativeObservationState
>;
type Capabilities<Native, State extends NativeObservationState, Selection> =
  (Native extends { refresh(): unknown } ? Refresh<State, Selection> : unknown) &
  (Native extends { loadMore(): unknown } ? Pagination : unknown);
type StoreForObservation<Native extends NativeObservation, Selection = never> =
  ObservedStore<NativeState<Native>, Selection> & Capabilities<Native, NativeState<Native>, Selection>;
type StoreForSource<Source extends ObservedStore, Selection> =
  ObservedStore<ObservedSourceState<Source>, Selection> & Capabilities<Source, ObservedSourceState<Source>, Selection>;
type ObservationOptions = Readonly<{ signal?: AbortSignal; loadAll?: never }>;
type ExpandableOptions = Readonly<{ signal?: AbortSignal; loadAll?: boolean }>;
type NativeSelection<Selection, Native extends NativeObservation> = Readonly<{
  open(input: Selection, signal: AbortSignal): Promise<Native>;
  source?: never;
}>;
type BorrowedSelection<Selection, Source extends ObservedStore> = Readonly<{
  source(input: Selection): Source;
  open?: never;
}>;

/**
 * Declare a store over a native observation or a selectable canonical source.
 * Construction is inert: subscribe(), retain(), ready(), or select() starts observation.
 * Selectable stores begin without an input; select(input) retains that choice until cleared or closed.
 */
export interface ObservationFactory {
  <Native extends NativeObservation & Pagination>(
    open: (signal: AbortSignal) => Promise<Native>, options: ExpandableOptions,
  ): StoreForObservation<Native>;
  <Native extends NativeObservation>(open: (signal: AbortSignal) => Promise<Native>, options?: ObservationOptions): StoreForObservation<Native>;
  <Selection, Native extends NativeObservation & Pagination>(
    config: NativeSelection<Selection, Native>, options: ExpandableOptions,
  ): StoreForObservation<Native, Selection>;
  <Selection, Native extends NativeObservation>(
    config: NativeSelection<Selection, Native>, options?: ObservationOptions,
  ): StoreForObservation<Native, Selection>;
  <Selection, Source extends ObservedStore & Pagination>(
    config: BorrowedSelection<Selection, Source>, options: ExpandableOptions,
  ): StoreForSource<Source, Selection>;
  <Selection, Source extends ObservedStore>(
    config: BorrowedSelection<Selection, Source>, options?: ObservationOptions,
  ): StoreForSource<Source, Selection>;
}

/** Protocol collections preserve their always-present native record payload. */
export type StoreCollectionState<Item> = (RecordViewState<Item> | Readonly<{
  status: 'idle'; records: readonly Item[]; hasMore: false; current: false; error?: never;
}>) & Readonly<{ isLoadingMore: boolean }>;

/** Typed owned-collection convenience over the common observation owner. */
export interface ObservedCollection<Item> extends ObservedStore<RecordViewState<Item>>, Refresh<RecordViewState<Item>, never>, Pagination {
  getSnapshot(): StoreCollectionState<Item>;
}
type Backend = NativeObservation | ObservedStore;
type SourceState = NativeObservationState | ObservedStoreState<NativeObservationState>;
type ObservationConfiguration =
  | { kind: 'native'; selectable: boolean; open(input: unknown, signal: AbortSignal): Promise<NativeObservation> }
  | { kind: 'source'; selectable: true; source(input: unknown): ObservedStore };
type OwnerOptions = Readonly<{
  signal?: AbortSignal;
  loadAll?: boolean;
  emptyPayload?: Readonly<object>;
  onObservationChange?: (active: boolean, refresh: () => Promise<void>) => void;
}>;
type ObservationSelection = { input: unknown; source?: ObservedStore; observation?: Observation; retrying?: Promise<void> };
type Observation = {
  selection: ObservationSelection;
  abortController: AbortController;
  opening: Promise<Backend>;
  backend?: Backend;
  unsubscribe?: () => void;
  sourceState?: SourceState;
  paging?: Promise<void>;
  expanding?: Promise<void>;
};
type RuntimeObservedStore = ObservedStore<NativeObservationState, unknown> & Refresh<NativeObservationState, unknown> & Pagination;

/** @internal Bind the shared owner to a feature's exact authorization scope. */
export function createObservationFactory(scope: StoreScope): ObservationFactory {
  const factory = (
    input: ((signal: AbortSignal) => Promise<NativeObservation>) | Readonly<{
      open?: (input: unknown, signal: AbortSignal) => Promise<NativeObservation>;
      source?: (input: unknown) => ObservedStore;
    }>,
    options: OwnerOptions = {},
  ): RuntimeObservedStore => {
    if (typeof input === 'function') {
      return createOwner(scope, { kind: 'native', selectable: false, open: (_input, signal) => input(signal) }, options);
    }
    if ((typeof input.open === 'function') === (typeof input.source === 'function')) {
      throw new TypeError('observe: provide exactly one open or source function.');
    }
    return createOwner(scope, typeof input.open === 'function'
      ? { kind: 'native', selectable: true, open: input.open }
      : { kind: 'source', selectable: true, source: input.source! }, options);
  };
  // The overloads retain native state, supported controls, and input types erased by the owner.
  return factory as unknown as ObservationFactory;
}

/** @internal An empty-record adapter, not another ownership implementation. */
export function createObservedCollection<Item>(
  scope: StoreScope,
  open: (signal: AbortSignal) => Promise<ExpandableRecordView<Item>>,
  options: Readonly<{ loadAll?: boolean; onObservationChange?: (active: boolean, refresh: () => Promise<void>) => void }> = {},
): ObservedCollection<Item> {
  return createOwner(scope, {
    kind       : 'native',
    selectable : false,
    open       : (_input, signal) => open(signal),
  }, {
    ...options,
    emptyPayload: Object.freeze({ records: Object.freeze([]), hasMore: false, current: false }),
  }) as unknown as ObservedCollection<Item>;
}

function createOwner(parentScope: StoreScope, config: ObservationConfiguration, options: OwnerOptions): RuntimeObservedStore {
  if (options.loadAll !== undefined && typeof options.loadAll !== 'boolean') {
    throw new TypeError('ObservedStore: loadAll must be a boolean.');
  }
  const scope = withStoreSignal(parentScope, options.signal);
  const signal = scope.signal;
  const loadAll = options.loadAll === true;
  const listeners = new Set<(state: ObservedStoreState<NativeObservationState, unknown>) => void>();
  const openings = new Set<Promise<Backend>>();
  const cleanups = new Set<Promise<void>>();
  const cleanupFailures: unknown[] = [];
  let activeSelection: ObservationSelection = { input: config.selectable ? null : undefined };
  let leases = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let observing = false;
  let publication = 0;

  const snapshot = (native: object, input: unknown, loadingMore = false): ObservedStoreState<NativeObservationState, unknown> => Object.freeze({
    ...native,
    isLoadingMore: loadingMore,
    ...(config.selectable ? { selection: input } : {}),
  }) as ObservedStoreState<NativeObservationState, unknown>;
  const idle = (input: unknown): ObservedStoreState<NativeObservationState, unknown> =>
    snapshot({ ...options.emptyPayload, status: 'idle' }, input);
  let state = idle(activeSelection.input);

  const assertOpen = (): void => {
    if (closed || signal.aborted) { throw new StoreRetiredError(); }
    scope.assertCurrent();
  };
  const assertSelection = (captured: ObservationSelection): void => {
    assertOpen();
    if (activeSelection !== captured) { throw new StoreRetiredError(); }
  };
  const current = (observation: Observation): boolean =>
    !closed && !signal.aborted && activeSelection === observation.selection && activeSelection.observation === observation;
  const assertObservation = (observation: Observation): void => {
    assertSelection(observation.selection);
    if (observation.selection.observation !== observation) { throw new StoreRetiredError(); }
  };
  const publish = (next: ObservedStoreState<NativeObservationState, unknown>): void => {
    if (state === next) { return; }
    state = next;
    const revision = ++publication;
    const subscribers = [...listeners];
    for (const listener of subscribers) {
      if (revision !== publication) { return; }
      if (listeners.has(listener)) {
        try { listener(next); } catch { /* Consumer failures cannot interrupt ownership changes. */ }
      }
    }
  };
  const observationChanged = (): void => {
    const next = activeSelection.observation !== undefined;
    if (observing !== next) { observing = next; options.onObservationChange?.(next, refreshIfActive); }
  };
  const cleanupFailed = (error: unknown): void => {
    cleanupFailures.push(error);
    console.warn('[@enbox/api] Observed store cleanup failed.', error);
  };
  const trackClose = (backend: Pick<Backend, 'close'>): Promise<void> => {
    const closing = Promise.resolve().then(() => backend.close());
    cleanups.add(closing);
    void closing.then(
      (): void => { cleanups.delete(closing); },
      (error: unknown): void => { cleanups.delete(closing); cleanupFailed(error); },
    );
    return closing;
  };
  const retire = (previous: Observation | undefined): void => {
    if (previous === undefined) { return; }
    if (previous.selection.observation === previous) { previous.selection.observation = undefined; }
    // Own native completion before unsubscribe/abort callbacks can reenter close().
    if (config.kind === 'native' && previous.backend !== undefined) { void trackClose(previous.backend); }
    const unsubscribe = previous.unsubscribe;
    previous.unsubscribe = undefined;
    observationChanged();
    try { unsubscribe?.(); } catch (error: unknown) { cleanupFailed(error); }
    finally { previous.abortController.abort(new StoreRetiredError()); }
  };
  const apply = (observation: Observation, next: SourceState, force = false): void => {
    if (!current(observation)) { return; }
    const loadingMore = observation.paging !== undefined || ('isLoadingMore' in next && next.isLoadingMore);
    if (!force && observation.sourceState === next && state.isLoadingMore === loadingMore) { return; }
    observation.sourceState = next;
    publish(snapshot(next, observation.selection.input, loadingMore));
    if (current(observation) && loadAll && next.status === 'ready' && 'hasMore' in next && next.hasMore) {
      void expandAll(observation).catch((): void => {});
    }
  };
  const fail = (observation: Observation, error: unknown): void => {
    if (!current(observation)) { return; }
    const previous = observation.sourceState ?? options.emptyPayload ?? {};
    publish(snapshot({
      ...previous,
      status : 'error',
      error  : toStoreError(error),
      ...('current' in previous ? { current: false } : {}),
    }, observation.selection.input, observation.paging !== undefined));
  };
  const attach = (observation: Observation, backend: Backend): void => {
    observation.backend = backend;
    const unsubscribe = backend.subscribe((next): void => { apply(observation, next); });
    if (!current(observation)) { unsubscribe(); return; }
    observation.unsubscribe = unsubscribe;
    apply(observation, backend.getSnapshot());
  };
  const start = (captured: ObservationSelection, replace = false): Observation => {
    assertSelection(captured);
    if (config.selectable && captured.input === null) { throw new TypeError('ObservedStore: select an input before awaiting data.'); }
    if (!replace && captured.observation !== undefined) { return captured.observation; }
    const previous = captured.observation;
    const observation: Observation = {
      selection       : captured,
      abortController : new AbortController(),
      opening         : Promise.resolve().then(async (): Promise<Backend> => {
        assertObservation(observation);
        if (config.kind === 'source') { return captured.source!; }
        const backend = await config.open(captured.input, AbortSignal.any([signal, observation.abortController.signal]));
        if (!current(observation)) {
          await trackClose(backend);
          throw new StoreRetiredError();
        }
        attach(observation, backend);
        return backend;
      }),
    };
    captured.observation = observation;
    openings.add(observation.opening);
    void observation.opening.then(
      (): void => { openings.delete(observation.opening); },
      (error: unknown): void => { openings.delete(observation.opening); fail(observation, error); },
    );
    try {
      observationChanged();
      if (config.kind === 'source') {
        // Borrow before publishing: a listener can release the last prefetch lease.
        attach(observation, captured.source!);
      } else if (current(observation)) {
        publish(snapshot({ ...options.emptyPayload, status: 'loading' }, captured.input));
      }
    } finally { retire(previous); }
    return observation;
  };
  const automaticStart = (): void => {
    const captured = activeSelection;
    if (config.selectable && captured.input === null) { return; }
    try { start(captured); } catch (error: unknown) {
      if (!(error instanceof StoreNotConnectedError) && !closed && !signal.aborted && activeSelection === captured) {
        publish(snapshot({ ...options.emptyPayload, status: 'error', error: toStoreError(error) }, captured.input));
      }
    }
  };
  const releaseUnused = (): void => {
    if (closed || (config.selectable && activeSelection.input !== null) || leases > 0 || listeners.size > 0) { return; }
    retire(activeSelection.observation);
    if (activeSelection.observation === undefined) { publish(idle(activeSelection.input)); }
  };
  const lease = (): (() => void) => {
    leases += 1;
    let released = false;
    return (): void => {
      if (released) { return; }
      released = true;
      leases -= 1;
      releaseUnused();
    };
  };
  const waitSignal = (observation: Observation, caller?: AbortSignal): AbortSignal =>
    AbortSignal.any(caller === undefined
      ? [signal, observation.abortController.signal]
      : [signal, observation.abortController.signal, caller]);
  const page = (observation: Observation): Promise<void> => {
    if (observation.paging !== undefined) { return observation.paging; }
    const waiting = waitSignal(observation);
    const pending = whileNotAborted(observation.opening, waiting).then(async (backend): Promise<void> => {
      assertObservation(observation);
      if (!('loadMore' in backend) || typeof backend.loadMore !== 'function') {
        throw new TypeError('ObservedStore: this native view does not support loadMore().');
      }
      try {
        await whileNotAborted(backend.loadMore(), waiting);
        await whileNotAborted(backend.ready({ signal: waiting }), waiting);
      } finally { assertObservation(observation); }
    });
    observation.paging = pending;
    if (observation.sourceState !== undefined) { apply(observation, observation.sourceState, true); }
    void pending.then(
      (): void => {
        observation.paging = undefined;
        if (observation.sourceState !== undefined) { apply(observation, observation.sourceState, true); }
      },
      (error: unknown): void => { observation.paging = undefined; fail(observation, error); },
    );
    return pending;
  };
  const expandAll = (observation: Observation): Promise<void> => {
    if (observation.expanding !== undefined) { return observation.expanding; }
    const waiting = waitSignal(observation);
    const pending = whileNotAborted(observation.opening, waiting).then(async (backend): Promise<void> => {
      if (!('loadMore' in backend) || typeof backend.loadMore !== 'function') {
        throw new TypeError('ObservedStore: loadAll requires an expandable native view.');
      }
      await whileNotAborted(backend.ready({ signal: waiting }), waiting);
      const expand = (): Promise<void> => {
        assertObservation(observation);
        const next = backend.getSnapshot();
        if (!('hasMore' in next) || !next.hasMore) { return Promise.resolve(); }
        return page(observation).then(expand);
      };
      return expand();
    });
    observation.expanding = pending;
    void pending.then(
      (): void => { observation.expanding = undefined; },
      (error: unknown): void => { observation.expanding = undefined; fail(observation, error); },
    );
    return pending;
  };
  const usable = async (
    observation: Observation,
    caller?: AbortSignal,
  ): Promise<ReadyObservationState<NativeObservationState, unknown>> => {
    const waiting = waitSignal(observation, caller);
    try {
      const backend = await whileNotAborted(observation.opening, waiting);
      assertObservation(observation);
      if (loadAll) { await whileNotAborted(expandAll(observation), waiting); }
      const ready = await whileNotAborted(backend.ready({ signal: waiting }), waiting);
      waiting.throwIfAborted();
      return snapshot(ready, observation.selection.input, state.isLoadingMore) as ReadyObservationState<NativeObservationState, unknown>;
    } finally { assertObservation(observation); }
  };
  const withLease = async <Value>(operation: (captured: ObservationSelection) => Promise<Value>): Promise<Value> => {
    assertOpen();
    const captured = activeSelection;
    const release = lease();
    try { return await operation(captured); }
    finally {
      release();
      // Final-lease cleanup can synchronously replace the input or retire this owner.
      assertSelection(captured);
    }
  };
  const refreshObservation = async (observation: Observation): Promise<ReadyObservationState<NativeObservationState, unknown>> => {
    const waiting = waitSignal(observation);
    try {
      const backend = await whileNotAborted(observation.opening, waiting);
      assertObservation(observation);
      if (!('refresh' in backend) || typeof backend.refresh !== 'function') {
        throw new TypeError('ObservedStore: this native view does not support refresh().');
      }
      await whileNotAborted(backend.refresh(), waiting);
      return await usable(observation);
    } catch (error: unknown) { fail(observation, error); throw error; }
    finally { assertObservation(observation); }
  };
  const refreshIfActive = async (): Promise<void> => {
    const observation = activeSelection.observation;
    if (observation !== undefined && current(observation)) { await refreshObservation(observation); }
  };
  const waitForCleanup = async (): Promise<void> => {
    await Promise.allSettled(openings);
    await Promise.allSettled(cleanups);
    if (openings.size > 0 || cleanups.size > 0) { return waitForCleanup(); }
    if (cleanupFailures.length > 0) { throw new AggregateError(cleanupFailures, 'Observed store cleanup failed.'); }
  };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) { return closePromise; }
    closePromise = Promise.resolve().then(waitForCleanup).then((): void => {
      // Keep pending or failed cleanup owned by application disposal.
      unregister();
    });
    const previous = activeSelection;
    activeSelection = { input: config.selectable ? null : undefined };
    closed = true;
    publish(idle(activeSelection.input));
    try { retire(previous.observation); } finally {
      listeners.clear();
      signal.removeEventListener('abort', abort);
    }
    return closePromise;
  };
  const abort = (): void => { void close().catch((): void => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const unregister = scope.onClose(close);
  if (signal.aborted) { abort(); }

  return {
    getSnapshot : (): ObservedStoreState<NativeObservationState, unknown> => state,
    close,
    subscribe   : (listener): (() => void) => {
      if (closed) { return (): void => {}; }
      const notify = (next: ObservedStoreState<NativeObservationState, unknown>): void => { listener(next); };
      listeners.add(notify);
      automaticStart();
      return (): void => { if (listeners.delete(notify)) { releaseUnused(); } };
    },
    retain: (): (() => void) => {
      if (closed) { return (): void => {}; }
      const release = lease();
      automaticStart();
      return release;
    },
    ready: (readyOptions = {}): Promise<ReadyObservationState<NativeObservationState, unknown>> => {
      if (readyOptions.signal?.aborted) { return Promise.reject(readyOptions.signal.reason); }
      return withLease(captured => usable(start(captured), readyOptions.signal));
    },
    retry: (): Promise<void> => {
      try { assertOpen(); } catch (error: unknown) { return Promise.reject(error); }
      const captured = activeSelection;
      if (captured.retrying !== undefined) { return captured.retrying; }
      const release = lease();
      const pending = Promise.resolve().then(async (): Promise<void> => {
        assertSelection(captured);
        const observation = start(captured, config.kind === 'native');
        if (config.kind === 'source') {
          await whileNotAborted(captured.source!.retry(), waitSignal(observation));
          assertObservation(observation);
        }
        await usable(observation);
      }).finally((): void => {
        if (captured.retrying === pending) { captured.retrying = undefined; }
        release();
        assertSelection(captured);
      });
      captured.retrying = pending;
      void pending.catch((error: unknown): void => {
        const observation = captured.observation;
        if (observation !== undefined) { fail(observation, error); }
      });
      return pending;
    },
    select: async (input): Promise<void> => {
      if (closed || signal.aborted) { throw new StoreRetiredError(); }
      if (!config.selectable) { throw new TypeError('ObservedStore: only selectable stores can select an input.'); }
      if (input !== null) { scope.assertCurrent(); }
      let captured = activeSelection;
      if (!Object.is(captured.input, input)) {
        let source: ObservedStore | undefined;
        if (input !== null && config.kind === 'source') {
          try { source = config.source(input); }
          finally { assertSelection(captured); }
        }
        const previous = captured;
        captured = { input, source };
        activeSelection = captured;
        try {
          if (input === null) { publish(idle(null)); } else { start(captured); }
        } finally { retire(previous.observation); }
      }
      if (input === null) {
        if (closed || signal.aborted || activeSelection !== captured) { throw new StoreRetiredError(); }
        return;
      }
      await usable(start(captured));
      assertSelection(captured);
    },
    loadMore: (): Promise<void> => withLease(async (captured): Promise<void> => {
      const observation = start(captured);
      await page(observation);
      await usable(observation);
    }),
    refresh: () => withLease(captured => refreshObservation(start(captured))),
  };
}

function whileNotAborted<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject): void => {
    const abort = (): void => { reject(signal.reason); };
    // Always consume the supplied promise, including native work rejected by an already-aborted signal.
    void promise.then(
      (value): void => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown): void => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) { abort(); }
    else { signal.addEventListener('abort', abort, { once: true }); }
  });
}
