import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';
import type { ExpandableRecordView, RecordViewState } from '../record-view.js';

import { StoreNotConnectedError, StoreRetiredError, toStoreError, withStoreSignal } from './scope.js';

/** State shared by native observable views; payload fields remain native to each view. */
export type ResourceViewState = Readonly<
  | { status: 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: Error }
>;

type Payload<State> = State extends unknown ? Omit<State, 'status' | 'error' | 'selection' | 'isLoadingMore'> : never;
type SelectionState<Selection> = [Selection] extends [never] ? unknown : Readonly<{ selection: Selection | null }>;
type ReadyResourceState<State, Selection> = Extract<State, { status: 'ready' }> &
  Readonly<{ isLoadingMore: boolean }> & SelectionState<Selection>;

/** Native state with shared ownership metadata; payloads are optional until a view supplies them. */
export type StoreResourceState<State extends ResourceViewState, Selection = never> = (
  | (Partial<Payload<State>> & Readonly<{ status: 'idle'; error?: never }>)
  | (Partial<Payload<State>> & Readonly<{ status: 'loading'; error?: never }>)
  | (Partial<Payload<State>> & Readonly<{ status: 'error'; error: Error }>)
  | Extract<State, { status: 'ready' }>
) & Readonly<{ isLoadingMore: boolean }> & SelectionState<Selection>;

interface ResourceOwner<State extends ResourceViewState, Selection> extends ObservableStore<StoreResourceState<State, Selection>> {
  /** Keep this resource live until the returned idempotent release runs or its owner ends. */
  retain(): () => void;
  /** Wait for usable local state with a temporary lease; cancellation affects this waiter alone. */
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<ReadyResourceState<State, Selection>>;
  /** Reopen the current selection and await usable rows, including configured loadAll pages. */
  retry(): Promise<void>;
  /** Invalidate this owner and await its native openers and cleanup, surfacing release failures. */
  close(): Promise<void>;
}

/** A lazy native-view owner; keyed resources also own their explicit choice until cleared or closed. */
export type StoreResource<State extends ResourceViewState = ResourceViewState, Selection = never> =
  ResourceOwner<State, Selection> & ([Selection] extends [never] ? unknown : Readonly<{
    /** Select and retain one key until replacement, null, close, or abort; await its usable local state. */
    select(selection: Selection | null): Promise<void>;
  }>);

interface ResourceView<State extends ResourceViewState = ResourceViewState> extends ObservableStore<State> {
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<Extract<State, { status: 'ready' }>>;
  close(): Promise<void>;
}
type Refresh<State extends ResourceViewState, Selection> = Readonly<{
  /** Recompute native local state without implying remote replication is current. */
  refresh(): Promise<ReadyResourceState<State, Selection>>;
}>;
type Pagination = Readonly<{
  /** Share one page expansion and await its usable local rows. */
  loadMore(): Promise<void>;
}>;
type ViewState<View extends ResourceView> = ReturnType<View['getSnapshot']>;
type ResourceState<Resource extends StoreResource> = Extract<
  ReturnType<Resource['getSnapshot']> extends infer State
    ? State extends unknown ? Omit<State, 'selection' | 'isLoadingMore'> : never
    : never,
  ResourceViewState
>;
type Capabilities<View, State extends ResourceViewState, Selection> =
  (View extends { refresh(): unknown } ? Refresh<State, Selection> : unknown) &
  (View extends { loadMore(): unknown } ? Pagination : unknown);
type ResourceForView<View extends ResourceView, Selection = never> =
  StoreResource<ViewState<View>, Selection> & Capabilities<View, ViewState<View>, Selection>;
type ResourceForSource<Resource extends StoreResource, Selection> =
  StoreResource<ResourceState<Resource>, Selection> & Capabilities<Resource, ResourceState<Resource>, Selection>;
type ResourceOptions = Readonly<{ signal?: AbortSignal; loadAll?: never }>;
type ExpandableOptions = Readonly<{ signal?: AbortSignal; loadAll?: boolean }>;
type NativeSelection<Selection, View extends ResourceView> = Readonly<{
  selection: Selection | null;
  open(selection: Selection, signal: AbortSignal): Promise<View>;
  source?: never;
}>;
type BorrowedSelection<Selection, Resource extends StoreResource> = Readonly<{
  selection: Selection | null;
  source(selection: Selection): Resource;
  open?: never;
}>;

/** One scoped factory for fixed views, keyed views, or borrowed canonical resource handles. */
export interface ResourceFactory {
  <View extends ResourceView & Pagination>(
    open: (signal: AbortSignal) => Promise<View>, options: ExpandableOptions,
  ): ResourceForView<View>;
  <View extends ResourceView>(open: (signal: AbortSignal) => Promise<View>, options?: ResourceOptions): ResourceForView<View>;
  <Selection, View extends ResourceView & Pagination>(
    config: NativeSelection<Selection, View>, options: ExpandableOptions,
  ): ResourceForView<View, Selection>;
  <Selection, View extends ResourceView>(
    config: NativeSelection<Selection, View>, options?: ResourceOptions,
  ): ResourceForView<View, Selection>;
  <Selection, Resource extends StoreResource & Pagination>(
    config: BorrowedSelection<Selection, Resource>, options: ExpandableOptions,
  ): ResourceForSource<Resource, Selection>;
  <Selection, Resource extends StoreResource>(
    config: BorrowedSelection<Selection, Resource>, options?: ResourceOptions,
  ): ResourceForSource<Resource, Selection>;
}

/** Protocol collections preserve their always-present native record payload. */
export type StoreCollectionState<Item> = (RecordViewState<Item> | Readonly<{
  status: 'idle'; records: readonly Item[]; hasMore: false; current: false; error?: never;
}>) & Readonly<{ isLoadingMore: boolean }>;

/** Typed owned-collection convenience over the common resource owner. */
export interface StoreCollectionResource<Item> extends StoreResource<RecordViewState<Item>>, Refresh<RecordViewState<Item>, never>, Pagination {
  getSnapshot(): StoreCollectionState<Item>;
}
/** @internal Mutation barriers refresh existing observations without opening unused resources. */
export interface StoreCollectionController<Item> extends StoreCollectionResource<Item> {
  refreshIfActive(): Promise<void>;
}

type Backend = ResourceView | StoreResource;
type SourceState = ResourceViewState | StoreResourceState<ResourceViewState>;
type ResourceConfiguration =
  | { kind: 'native'; keyed: boolean; selection: unknown; open(key: unknown, signal: AbortSignal): Promise<ResourceView> }
  | { kind: 'source'; keyed: true; selection: unknown; source(key: unknown): StoreResource };
type OwnerOptions = Readonly<{
  signal?: AbortSignal;
  loadAll?: boolean;
  emptyPayload?: Readonly<object>;
  onObservationChange?: (active: boolean) => void;
}>;
type Slot = { key: unknown; source?: StoreResource; observation?: Observation; retrying?: Promise<void> };
type Observation = {
  slot: Slot;
  abortController: AbortController;
  opening: Promise<Backend>;
  backend?: Backend;
  unsubscribe?: () => void;
  sourceState?: SourceState;
  paging?: Promise<void>;
  expanding?: Promise<void>;
};
type RuntimeResource = StoreResource<ResourceViewState, unknown> & Refresh<ResourceViewState, unknown> & Pagination & {
  refreshIfActive(): Promise<void>;
};

/** @internal Bind the shared owner to a feature's exact authorization scope. */
export function createResourceFactory(scope: StoreScope): ResourceFactory {
  const factory = (
    input: ((signal: AbortSignal) => Promise<ResourceView>) | Readonly<{
      selection: unknown;
      open?: (key: unknown, signal: AbortSignal) => Promise<ResourceView>;
      source?: (key: unknown) => StoreResource;
    }>,
    options: OwnerOptions = {},
  ): RuntimeResource => {
    if (typeof input === 'function') {
      return createOwner(scope, { kind: 'native', keyed: false, selection: undefined, open: (_key, signal) => input(signal) }, options);
    }
    if (!Object.hasOwn(input, 'selection') || (typeof input.open === 'function') === (typeof input.source === 'function')) {
      throw new TypeError('Resource: a keyed resource requires selection and exactly one open or source function.');
    }
    return createOwner(scope, typeof input.open === 'function'
      ? { kind: 'native', keyed: true, selection: input.selection, open: input.open }
      : { kind: 'source', keyed: true, selection: input.selection, source: input.source! }, options);
  };
  // The overloads retain native state, supported controls, and key types erased by the owner.
  return factory as unknown as ResourceFactory;
}

/** @internal An empty-record adapter, not another ownership implementation. */
export function createCollectionResource<Item>(
  scope: StoreScope,
  open: (signal: AbortSignal) => Promise<ExpandableRecordView<Item>>,
  options: Readonly<{ loadAll?: boolean; onObservationChange?: (active: boolean) => void }> = {},
): StoreCollectionController<Item> {
  return createOwner(scope, {
    kind      : 'native',
    keyed     : false,
    selection : undefined,
    open      : (_key, signal) => open(signal),
  }, {
    ...options,
    emptyPayload: Object.freeze({ records: Object.freeze([]), hasMore: false, current: false }),
  }) as unknown as StoreCollectionController<Item>;
}

function createOwner(parentScope: StoreScope, config: ResourceConfiguration, options: OwnerOptions): RuntimeResource {
  if (options.loadAll !== undefined && typeof options.loadAll !== 'boolean') {
    throw new TypeError('Resource: loadAll must be a boolean.');
  }
  const scope = withStoreSignal(parentScope, options.signal);
  const signal = scope.signal;
  const loadAll = options.loadAll === true;
  const listeners = new Set<(state: StoreResourceState<ResourceViewState, unknown>) => void>();
  const openings = new Set<Promise<Backend>>();
  const cleanups = new Set<Promise<void>>();
  const cleanupFailures: unknown[] = [];
  let slot: Slot = { key: config.selection };
  let selected = false;
  let leases = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let observing = false;
  let publication = 0;

  const snapshot = (native: object, key: unknown, loadingMore = false): StoreResourceState<ResourceViewState, unknown> => Object.freeze({
    ...native,
    isLoadingMore: loadingMore,
    ...(config.keyed ? { selection: key } : {}),
  }) as StoreResourceState<ResourceViewState, unknown>;
  const idle = (key: unknown): StoreResourceState<ResourceViewState, unknown> =>
    snapshot({ ...options.emptyPayload, status: 'idle' }, key);
  let state = idle(config.selection);

  const assertOpen = (): void => {
    if (closed || signal.aborted) { throw new StoreRetiredError(); }
    scope.assertCurrent();
  };
  const assertSlot = (captured: Slot): void => {
    assertOpen();
    if (slot !== captured) { throw new StoreRetiredError(); }
  };
  const current = (observation: Observation): boolean =>
    !closed && !signal.aborted && slot === observation.slot && slot.observation === observation;
  const assertObservation = (observation: Observation): void => {
    assertSlot(observation.slot);
    if (observation.slot.observation !== observation) { throw new StoreRetiredError(); }
  };
  const publish = (next: StoreResourceState<ResourceViewState, unknown>): void => {
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
    const next = slot.observation !== undefined;
    if (observing !== next) { observing = next; options.onObservationChange?.(next); }
  };
  const cleanupFailed = (error: unknown): void => {
    cleanupFailures.push(error);
    console.warn('[@enbox/api] Store resource cleanup failed.', error);
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
    if (previous.slot.observation === previous) { previous.slot.observation = undefined; }
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
    publish(snapshot(next, observation.slot.key, loadingMore));
    if (loadAll && next.status === 'ready' && 'hasMore' in next && next.hasMore) {
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
    }, observation.slot.key, observation.paging !== undefined));
  };
  const attach = (observation: Observation, backend: Backend): void => {
    observation.backend = backend;
    const unsubscribe = backend.subscribe((next): void => { apply(observation, next); });
    if (!current(observation)) { unsubscribe(); return; }
    observation.unsubscribe = unsubscribe;
    apply(observation, backend.getSnapshot());
  };
  const start = (captured: Slot, replace = false): Observation => {
    assertSlot(captured);
    if (config.keyed && captured.key === null) { throw new StoreRetiredError(); }
    if (!replace && captured.observation !== undefined) { return captured.observation; }
    if (config.kind === 'source' && captured.source === undefined) {
      try { captured.source = config.source(captured.key); }
      finally { assertSlot(captured); }
    }
    const previous = captured.observation;
    const observation: Observation = {
      slot            : captured,
      abortController : new AbortController(),
      opening         : Promise.resolve().then(async (): Promise<Backend> => {
        assertObservation(observation);
        if (config.kind === 'source') { return captured.source!; }
        const backend = await config.open(captured.key, AbortSignal.any([signal, observation.abortController.signal]));
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
        publish(snapshot({ ...options.emptyPayload, status: 'loading' }, captured.key));
      }
    } finally { retire(previous); }
    return observation;
  };
  const automaticStart = (): void => {
    const captured = slot;
    if (config.keyed && captured.key === null) { return; }
    try { start(captured); } catch (error: unknown) {
      if (!(error instanceof StoreNotConnectedError) && !closed && !signal.aborted && slot === captured) {
        publish(snapshot({ ...options.emptyPayload, status: 'error', error: toStoreError(error) }, captured.key));
      }
    }
  };
  const releaseUnused = (): void => {
    if (closed || selected || leases > 0 || listeners.size > 0) { return; }
    retire(slot.observation);
    if (slot.observation === undefined) { publish(idle(slot.key)); }
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
    const pending = observation.opening.then(async (backend): Promise<void> => {
      assertObservation(observation);
      if (!('loadMore' in backend) || typeof backend.loadMore !== 'function') {
        throw new TypeError('Resource: this native view does not support loadMore().');
      }
      try {
        await backend.loadMore();
        await whileNotAborted(backend.ready({ signal: waitSignal(observation) }), waitSignal(observation));
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
    const pending = observation.opening.then(async (backend): Promise<void> => {
      if (!('loadMore' in backend) || typeof backend.loadMore !== 'function') {
        throw new TypeError('Resource: loadAll requires an expandable native view.');
      }
      await whileNotAborted(backend.ready({ signal: waitSignal(observation) }), waitSignal(observation));
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
  ): Promise<ReadyResourceState<ResourceViewState, unknown>> => {
    const waiting = waitSignal(observation, caller);
    try {
      const backend = await whileNotAborted(observation.opening, waiting);
      assertObservation(observation);
      if (loadAll) { await whileNotAborted(expandAll(observation), waiting); }
      const ready = await whileNotAborted(backend.ready({ signal: waiting }), waiting);
      waiting.throwIfAborted();
      return snapshot(ready, observation.slot.key, state.isLoadingMore) as ReadyResourceState<ResourceViewState, unknown>;
    } finally { assertObservation(observation); }
  };
  const withLease = async <Value>(operation: (captured: Slot) => Promise<Value>): Promise<Value> => {
    assertOpen();
    const captured = slot;
    const release = lease();
    try { return await operation(captured); }
    finally {
      release();
      // Final-lease cleanup can synchronously replace the key or retire this owner.
      assertSlot(captured);
    }
  };
  const refreshObservation = async (observation: Observation): Promise<ReadyResourceState<ResourceViewState, unknown>> => {
    try {
      const backend = await observation.opening;
      assertObservation(observation);
      if (!('refresh' in backend) || typeof backend.refresh !== 'function') {
        throw new TypeError('Resource: this native view does not support refresh().');
      }
      await backend.refresh();
      return await usable(observation);
    } catch (error: unknown) { fail(observation, error); throw error; }
    finally { assertObservation(observation); }
  };
  const waitForCleanup = async (): Promise<void> => {
    await Promise.allSettled(openings);
    await Promise.allSettled(cleanups);
    if (openings.size > 0 || cleanups.size > 0) { return waitForCleanup(); }
    if (cleanupFailures.length > 0) { throw new AggregateError(cleanupFailures, 'Store resource cleanup failed.'); }
  };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) { return closePromise; }
    closePromise = Promise.resolve().then(waitForCleanup).then((): void => {
      // Keep pending or failed cleanup owned by application disposal.
      unregister();
    });
    const previous = slot;
    slot = { key: config.keyed ? null : undefined };
    selected = false;
    closed = true;
    publish(idle(slot.key));
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
    getSnapshot : (): StoreResourceState<ResourceViewState, unknown> => state,
    close,
    subscribe   : (listener): (() => void) => {
      if (closed) { return (): void => {}; }
      const notify = (next: StoreResourceState<ResourceViewState, unknown>): void => { listener(next); };
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
    ready: (readyOptions = {}): Promise<ReadyResourceState<ResourceViewState, unknown>> => {
      if (readyOptions.signal?.aborted) { return Promise.reject(readyOptions.signal.reason); }
      return withLease(captured => usable(start(captured), readyOptions.signal));
    },
    retry: (): Promise<void> => {
      try { assertOpen(); } catch (error: unknown) { return Promise.reject(error); }
      const captured = slot;
      if (captured.retrying !== undefined) { return captured.retrying; }
      const release = lease();
      const pending = Promise.resolve().then(async (): Promise<void> => {
        assertSlot(captured);
        const observation = start(captured, config.kind === 'native');
        if (config.kind === 'source') {
          await captured.source!.retry();
          assertObservation(observation);
        }
        await usable(observation);
      }).finally((): void => {
        if (captured.retrying === pending) { captured.retrying = undefined; }
        release();
        assertSlot(captured);
      });
      captured.retrying = pending;
      void pending.catch((error: unknown): void => {
        const observation = captured.observation;
        if (observation !== undefined) { fail(observation, error); }
      });
      return pending;
    },
    select: async (key): Promise<void> => {
      if (closed || signal.aborted) { throw new StoreRetiredError(); }
      if (!config.keyed) { throw new TypeError('Resource: only keyed resources can select a key.'); }
      if (key !== null) { scope.assertCurrent(); }
      let captured = slot;
      if (!Object.is(captured.key, key)) {
        let source: StoreResource | undefined;
        if (key !== null && config.kind === 'source') {
          try { source = config.source(key); }
          finally { assertSlot(captured); }
        }
        const previous = captured;
        captured = { key, source };
        slot = captured;
        selected = key !== null;
        try {
          if (key === null) { publish(idle(null)); } else { start(captured); }
        } finally { retire(previous.observation); }
      } else if (key !== null) { selected = true; }
      if (key === null) {
        if (closed || signal.aborted || slot !== captured) { throw new StoreRetiredError(); }
        return;
      }
      await usable(start(captured));
      assertSlot(captured);
    },
    loadMore: (): Promise<void> => withLease(async (captured): Promise<void> => {
      const observation = start(captured);
      await page(observation);
      await usable(observation);
    }),
    refresh         : () => withLease(captured => refreshObservation(start(captured))),
    refreshIfActive : async (): Promise<void> => {
      const observation = slot.observation;
      if (observation !== undefined && current(observation)) { await refreshObservation(observation); }
    },
  };
}

function whileNotAborted<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
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
