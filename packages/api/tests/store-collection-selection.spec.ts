import type { StoreCollectionResource } from '../src/store/resource.js';
import type { StoreScope } from '../src/store/scope.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';

import { describe, expect, it } from 'bun:test';

import { createCollectionResource } from '../src/store/resource.js';
import { createCollectionSelection } from '../src/store/collection-selection.js';
import { createEnboxTestContext } from '../src/testing.js';
import { createProtocolStore } from '../src/store/protocol-store.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';
import { StoreRetiredError } from '../src/store/scope.js';

type ReadyState = Extract<RecordViewState<string>, { status: 'ready' }>;

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete): void => { resolve = complete; });
  return { promise, resolve };
}

function readyState(records: readonly string[], hasMore = false): ReadyState {
  return Object.freeze({ status: 'ready', records: Object.freeze(records), hasMore, current: false });
}

function nativeView(initial: RecordViewState<string> = readyState(['first']), nextPage?: readonly string[]): {
  view: ExpandableRecordView<string>;
  readyRequested: Promise<void>;
  publish(state: RecordViewState<string>): void;
  closes(): number;
  pages(): number;
} {
  let state = initial;
  let closes = 0;
  let pages = 0;
  const requested = deferred<void>();
  const listeners = new Set<(state: RecordViewState<string>) => void>();
  const waiters = new Set<(state: RecordViewState<string>) => void>();
  const publish = (next: RecordViewState<string>): void => {
    state = next;
    for (const listener of listeners) { listener(next); }
    for (const waiter of waiters) { waiter(next); }
  };
  const ready = (options: Readonly<{ signal?: AbortSignal }> = {}): Promise<ReadyState> => {
    requested.resolve();
    if (options.signal?.aborted) { return Promise.reject(options.signal.reason); }
    if (state.status === 'ready') { return Promise.resolve(state); }
    if (state.status === 'error') { return Promise.reject(state.error); }
    return new Promise<ReadyState>((resolve, reject): void => {
      const cleanup = (): void => {
        waiters.delete(changed);
        options.signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => { cleanup(); reject(options.signal?.reason); };
      const changed = (next: RecordViewState<string>): void => {
        if (next.status === 'ready') { cleanup(); resolve(next); }
        if (next.status === 'error') { cleanup(); reject(next.error); }
      };
      waiters.add(changed);
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  };
  return {
    readyRequested : requested.promise,
    publish,
    closes         : (): number => closes,
    pages          : (): number => pages,
    view           : {
      getSnapshot : (): RecordViewState<string> => state,
      subscribe   : (listener): (() => void) => {
        listeners.add(listener);
        return (): void => { listeners.delete(listener); };
      },
      ready,
      refresh  : (): Promise<ReadyState> => ready(),
      loadMore : async (): Promise<void> => {
        pages += 1;
        publish(readyState(nextPage ?? state.records));
      },
      close: async (): Promise<void> => { closes += 1; },
    },
  };
}

type CollectionSource = {
  resource: StoreCollectionResource<string>;
  native: ReturnType<typeof nativeView>;
  opens(): number;
  openRequested: Promise<void>;
};

function fixture(): {
  scope: StoreScope;
  within(parentContextId: string): StoreCollectionResource<string>;
  resource(parentContextId: string, options?: Readonly<{
    native?: ReturnType<typeof nativeView>;
    open?: () => Promise<ExpandableRecordView<string>>;
    loadAll?: boolean;
  }>): CollectionSource;
  resolutions(): number;
  retire(): void;
  close(): Promise<void>;
  } {
  const controller = new AbortController();
  const callbacks: Array<() => void | Promise<void>> = [];
  const resources = new Map<string, StoreCollectionResource<string>>();
  let resolutions = 0;
  const scope: StoreScope = {
    signal        : controller.signal,
    assertCurrent : (): void => {
      if (controller.signal.aborted) { throw new StoreRetiredError(); }
    },
    getEnbox : (): never => { throw new Error('Selection fixture supplies native views directly.'); },
    onClose  : (callback): void => { callbacks.push(callback); },
  };
  return {
    scope,
    within: (parentContextId): StoreCollectionResource<string> => {
      resolutions += 1;
      if (parentContextId.length === 0) { throw new TypeError('A parent context ID is required.'); }
      const resource = resources.get(parentContextId);
      if (resource === undefined) { throw new Error(`Unknown fixture parent: ${parentContextId}`); }
      return resource;
    },
    resource: (parentContextId, options = {}): CollectionSource => {
      const native = options.native ?? nativeView(readyState([parentContextId]));
      const opened = deferred<void>();
      let opens = 0;
      const resource = createCollectionResource(scope, async () => {
        opens += 1;
        opened.resolve();
        return options.open === undefined ? native.view : options.open();
      }, { loadAll: options.loadAll });
      resources.set(parentContextId, resource);
      return { resource, native, opens: (): number => opens, openRequested: opened.promise };
    },
    resolutions : (): number => resolutions,
    retire      : (): void => { controller.abort(); },
    close       : async (): Promise<void> => {
      controller.abort();
      await Promise.all(callbacks.map(callback => callback()));
    },
  };
}

describe('store collection selections', () => {
  it('is inert until explicitly selected and preserves cached empty server state', async () => {
    const owner = fixture();
    const source = owner.resource('A');
    const selection = createCollectionSelection(owner.scope, owner.within);
    const idle = selection.getSnapshot();
    const server = selection.getServerSnapshot();
    const unsubscribe = selection.subscribe((): void => {});
    expect(selection.getSnapshot()).toBe(idle);
    expect(selection.getServerSnapshot()).toBe(server);
    expect(idle).toMatchObject({ status: 'idle', parentContextId: null, records: [] });
    expect(owner.resolutions()).toBe(0);
    expect(source.opens()).toBe(0);
    await selection.select(null);
    expect(owner.resolutions()).toBe(0);
    await selection.select('A');
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'A', records: ['A'] });
    expect(selection.getSnapshot()).toBe(selection.getSnapshot());
    expect(selection.getSnapshot().records).toBe(source.resource.getSnapshot().records);
    expect(Object.isFrozen(selection.getSnapshot())).toBe(true);
    expect(selection.getServerSnapshot()).toBe(server);
    unsubscribe();
    expect(source.resource.getSnapshot().status).toBe('ready');
    selection.close();
    await owner.close();
    expect(source.native.closes()).toBe(1);
  });

  it('shares a canonical observation for concurrent same-parent selection and awaits all pages', async () => {
    const owner = fixture();
    const native = nativeView(readyState(['first'], true), ['first', 'second']);
    const source = owner.resource('A', { native, loadAll: true });
    const selection = createCollectionSelection(owner.scope, owner.within);
    await Promise.all([selection.select('A'), selection.select('A')]);
    expect(selection.getSnapshot()).toMatchObject({ parentContextId: 'A', records: ['first', 'second'], hasMore: false });
    expect(source.opens()).toBe(1);
    expect(native.pages()).toBe(1);
    expect(source.resource.getSnapshot().status).toBe('ready');
    selection.close();
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('changes published identity between empty parents and leaves valid ownership intact after invalid input', async () => {
    const owner = fixture();
    const first = owner.resource('A', { native: nativeView(readyState([])) });
    owner.resource('B', { native: nativeView(readyState([])) });
    const selection = createCollectionSelection(owner.scope, owner.within);
    await selection.select('A');
    const selectedA = selection.getSnapshot();
    await expect(selection.select('')).rejects.toBeInstanceOf(TypeError);
    expect(selection.getSnapshot()).toBe(selectedA);
    expect(first.resource.getSnapshot().status).toBe('ready');
    await selection.select('B');
    expect(selection.getSnapshot()).not.toBe(selectedA);
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'B', records: [] });
    await selection.select(null);
    expect(selection.getSnapshot()).toMatchObject({ status: 'idle', parentContextId: null, records: [] });
    await owner.close();
  });

  it('takes over a prefetch lease before publishing the selected ready state', async () => {
    const owner = fixture();
    const source = owner.resource('A');
    const releasePrefetch = source.resource.retain();
    await source.resource.ready();
    const selection = createCollectionSelection(owner.scope, owner.within);
    let handoffs = 0;
    selection.subscribe((state): void => {
      if (state.parentContextId === 'A' && state.status === 'ready') {
        handoffs += 1;
        releasePrefetch();
      }
    });
    await selection.select('A');
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'A', records: ['A'] });
    expect(source.opens()).toBe(1);
    expect(source.native.closes()).toBe(0);
    expect(handoffs).toBe(1);
    selection.close();
    await owner.close();
    expect(source.native.closes()).toBe(1);
  });

  it('releases only its own lease when changing parent or closing', async () => {
    const owner = fixture();
    const first = owner.resource('A');
    const second = owner.resource('B');
    const releaseBackground = first.resource.retain();
    await first.resource.ready();
    const selection = createCollectionSelection(owner.scope, owner.within);
    await selection.select('A');
    await selection.select('B');
    expect(first.resource.getSnapshot().status).toBe('ready');
    expect(first.opens()).toBe(1);
    selection.close();
    selection.close();
    expect(first.resource.getSnapshot().status).toBe('ready');
    expect(second.resource.getSnapshot().status).toBe('idle');
    releaseBackground();
    await owner.close();
    expect(first.native.closes()).toBe(1);
    expect(second.native.closes()).toBe(1);
  });

  it('cancels an obsolete pending open and closes its late view without publishing it', async () => {
    const owner = fixture();
    const opening = deferred<ExpandableRecordView<string>>();
    const first = owner.resource('A', { open: (): Promise<ExpandableRecordView<string>> => opening.promise });
    owner.resource('B');
    const selection = createCollectionSelection(owner.scope, owner.within);
    const pending = selection.select('A');
    const obsolete = pending.catch((error: unknown): unknown => error);
    await first.openRequested;
    await selection.select('B');
    expect(await obsolete).toBeInstanceOf(StoreRetiredError);
    const states: Array<string | null> = [];
    selection.subscribe((state): void => { states.push(state.parentContextId); });
    opening.resolve(first.native.view);
    await owner.close();
    expect(first.native.closes()).toBe(1);
    expect(states).not.toContain('A');
    expect(selection.getSnapshot()).toMatchObject({ status: 'idle', parentContextId: null, records: [] });
  });

  it('does not revive the first A waiter after A to B to A while a background lease preserves the handle', async () => {
    const owner = fixture();
    const native = nativeView(Object.freeze({ status: 'loading', records: Object.freeze([]), hasMore: false, current: false }));
    const first = owner.resource('A', { native });
    owner.resource('B');
    const releaseBackground = first.resource.retain();
    const selection = createCollectionSelection(owner.scope, owner.within);
    const firstA = selection.select('A');
    const obsolete = firstA.catch((error: unknown): unknown => error);
    await native.readyRequested;
    await selection.select('B');
    expect(await obsolete).toBeInstanceOf(StoreRetiredError);
    const secondA = selection.select('A');
    native.publish(readyState(['current A']));
    await secondA;
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'A', records: ['current A'] });
    expect(first.opens()).toBe(1);
    expect(native.closes()).toBe(0);
    selection.close();
    expect(first.resource.getSnapshot().status).toBe('ready');
    releaseBackground();
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('cancels one owner readiness without cancelling another owner of the same pending collection', async () => {
    const owner = fixture();
    const native = nativeView(Object.freeze({ status: 'loading', records: Object.freeze([]), hasMore: false, current: false }));
    const first = owner.resource('A', { native });
    owner.resource('B');
    const primary = createCollectionSelection(owner.scope, owner.within);
    const auxiliary = createCollectionSelection(owner.scope, owner.within);
    const pending = primary.select('A').catch((error: unknown): unknown => error);
    const auxiliaryReady = auxiliary.select('A');
    await native.readyRequested;
    await primary.select('B');
    expect(await pending).toBeInstanceOf(StoreRetiredError);
    expect(first.resource.getSnapshot().status).toBe('loading');
    native.publish(readyState(['shared A']));
    await auxiliaryReady;
    expect(auxiliary.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'A', records: ['shared A'] });
    expect(primary.getSnapshot().parentContextId).toBe('B');
    expect(first.opens()).toBe(1);
    primary.close();
    expect(first.resource.getSnapshot().status).toBe('ready');
    await owner.close();
  });

  it.each(['owner', 'session'] as const)('retires pending readiness synchronously when its %s ends', async (lifetime) => {
    const owner = fixture();
    const controller = new AbortController();
    const native = nativeView(Object.freeze({ status: 'loading', records: Object.freeze([]), hasMore: false, current: false }));
    const source = owner.resource('A', { native });
    const releaseBackground = source.resource.retain();
    const selection = createCollectionSelection(owner.scope, owner.within, { signal: controller.signal });
    const pending = selection.select('A');
    const retired = pending.catch((error: unknown): unknown => error);
    await native.readyRequested;
    if (lifetime === 'owner') { controller.abort(); } else { owner.retire(); }
    expect(selection.getSnapshot()).toMatchObject({ status: 'idle', parentContextId: null, records: [] });
    expect(await retired).toBeInstanceOf(StoreRetiredError);
    await expect(selection.select(null)).rejects.toBeInstanceOf(StoreRetiredError);
    native.publish(readyState(['obsolete']));
    expect(selection.getSnapshot().records).toEqual([]);
    if (lifetime === 'owner') { expect(source.resource.getSnapshot().status).toBe('ready'); }
    releaseBackground();
    await owner.close();
  });

  it.each(['owner', 'session'] as const)('keeps an already retired %s factory inert', async (lifetime) => {
    const owner = fixture();
    const controller = new AbortController();
    const source = owner.resource('A');
    if (lifetime === 'owner') { controller.abort(); } else { owner.retire(); }
    const selection = createCollectionSelection(owner.scope, owner.within, { signal: controller.signal });
    selection.subscribe((): void => {});
    await expect(selection.select('A')).rejects.toBeInstanceOf(StoreRetiredError);
    expect(selection.getSnapshot()).toMatchObject({ status: 'idle', parentContextId: null, records: [] });
    expect(owner.resolutions()).toBe(0);
    expect(source.opens()).toBe(0);
    selection.close();
    await owner.close();
  });

  it.each(['B', null])('keeps a reentrant selection when replacing the old parent with %s', async (parentContextId) => {
    const owner = fixture();
    const first = owner.resource('A');
    const second = owner.resource('B');
    owner.resource('C');
    const selection = createCollectionSelection(owner.scope, owner.within);
    const subscribe = first.resource.subscribe;
    let nested: Promise<void> | undefined;
    first.resource.subscribe = (listener): (() => void) => {
      const unsubscribe = subscribe(listener);
      return (): void => { unsubscribe(); nested = selection.select('C'); };
    };
    await selection.select('A');
    await expect(selection.select(parentContextId)).rejects.toBeInstanceOf(StoreRetiredError);
    await nested;
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'C', records: ['C'] });
    expect(first.resource.getSnapshot().status).toBe('idle');
    expect(second.resource.getSnapshot().status).toBe('idle');
    await owner.close();
  });

  it('releases a stale subscription returned after its synchronous publication changes the selection', async () => {
    const owner = fixture();
    const first = owner.resource('A');
    owner.resource('B');
    const selection = createCollectionSelection(owner.scope, owner.within);
    let nested: Promise<void> | undefined;
    selection.subscribe((state): void => {
      if (state.parentContextId === 'A' && state.status === 'loading') { nested = selection.select('B'); }
    });
    await expect(selection.select('A')).rejects.toBeInstanceOf(StoreRetiredError);
    await nested;
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'B', records: ['B'] });
    expect(first.resource.getSnapshot().status).toBe('idle');
    await owner.close();
  });

  it('does not forward a superseded publication to later listeners after one selects another parent', async () => {
    const owner = fixture();
    owner.resource('A');
    owner.resource('B');
    const selection = createCollectionSelection(owner.scope, owner.within);
    let nested: Promise<void> | undefined;
    const inconsistent: Array<string | null> = [];
    selection.subscribe((state): void => {
      if (state.parentContextId === 'A' && state.status === 'ready') { nested = selection.select('B'); }
    });
    selection.subscribe((state): void => {
      if (state.parentContextId !== selection.getSnapshot().parentContextId) { inconsistent.push(state.parentContextId); }
    });
    await expect(selection.select('A')).rejects.toBeInstanceOf(StoreRetiredError);
    await nested;
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'B' });
    expect(inconsistent).toEqual([]);
    await owner.close();
  });

  it.each(['ready', 'error'] as const)('fences native readiness %s before its obsolete outcome is forwarded', async (status) => {
    const owner = fixture();
    const failure = new Error('Obsolete A query failed');
    const native = nativeView(status === 'ready' ? readyState(['A']) : Object.freeze({
      status  : 'error',
      records : Object.freeze([]),
      hasMore : false,
      current : false,
      error   : failure,
    }));
    const first = owner.resource('A', { native });
    owner.resource('B');
    const selection = createCollectionSelection(owner.scope, owner.within);
    const ready = first.native.view.ready;
    let nested: Promise<void> | undefined;
    first.native.view.ready = (options): ReturnType<typeof ready> => {
      const result = ready(options);
      queueMicrotask((): void => { nested = selection.select('B'); });
      return result;
    };
    await expect(selection.select('A')).rejects.toBeInstanceOf(StoreRetiredError);
    await nested;
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'B' });
    await owner.close();
  });

  it('makes close terminal before a setup publication can reenter selection', async () => {
    const owner = fixture();
    const first = owner.resource('A');
    const selection = createCollectionSelection(owner.scope, owner.within);
    selection.subscribe((state): void => {
      if (state.status === 'loading') { selection.close(); }
    });
    await expect(selection.select('A')).rejects.toBeInstanceOf(StoreRetiredError);
    expect(selection.getSnapshot()).toMatchObject({ status: 'idle', parentContextId: null, records: [] });
    expect(first.resource.getSnapshot().status).toBe('idle');
    await expect(selection.select(null)).rejects.toBeInstanceOf(StoreRetiredError);
    selection.close();
    await owner.close();
  });

  it('publishes canonical query failures and recovers through the shared handle', async () => {
    const owner = fixture();
    const failure = new Error('Local query failed');
    const failed = nativeView(Object.freeze({ status: 'error', records: Object.freeze([]), hasMore: false, current: false, error: failure }));
    const recovered = nativeView(readyState(['recovered']));
    let opens = 0;
    const source = owner.resource('A', {
      native : failed,
      open   : async (): Promise<ExpandableRecordView<string>> => ++opens === 1 ? failed.view : recovered.view,
    });
    const selection = createCollectionSelection(owner.scope, owner.within);
    await expect(selection.select('A')).rejects.toBe(failure);
    expect(selection.getSnapshot()).toMatchObject({ status: 'error', parentContextId: 'A', error: failure });
    await source.resource.retry();
    await selection.select('A');
    expect(selection.getSnapshot()).toMatchObject({ status: 'ready', parentContextId: 'A', records: ['recovered'] });
    expect(source.opens()).toBe(2);
    await owner.close();
    expect(failed.closes()).toBe(1);
    expect(recovered.closes()).toBe(1);
  });

  it('binds fresh family owners to canonical native collections and their real session lifetime', async () => {
    const protocol = defineProtocol({
      protocol  : 'https://example.com/protocols/collection-selection',
      published : true,
      types     : {
        folder : { dataFormats: ['application/json'] },
        note   : { dataFormats: ['application/json'] },
      },
      structure: { folder: { note: {} } },
    } as const, {
      folder : recordCodecs.json<{ title: string }>(),
      note   : recordCodecs.json<{ text: string }>(),
    });
    const context = await createEnboxTestContext({ application: defineApplicationManifest({ protocols: [protocol] }) });
    const callbacks: Array<() => void | Promise<void>> = [];
    const scope: StoreScope = {
      signal        : context.session.signal,
      assertCurrent : (): void => {
        if (context.session.signal.aborted) { throw new StoreRetiredError(); }
      },
      getEnbox : () => context.enbox,
      onClose  : (callback): void => { callbacks.push(callback); },
    };
    try {
      const store = createProtocolStore(protocol, scope);
      const folders = store.collection('folder');
      const first = await folders.create.run({ title: 'A' });
      const second = await folders.create.run({ title: 'B' });
      const family = store.collection('folder/note');
      const firstCollection = family.within(first.contextId);
      const secondCollection = family.within(second.contextId);
      await firstCollection.create.run({ text: 'A note' });
      await secondCollection.create.run({ text: 'B note' });
      const primary = family.createSelection();
      const auxiliary = family.createSelection();
      expect(primary).not.toBe(auxiliary);
      await Promise.all([primary.select(first.contextId), auxiliary.select(first.contextId)]);
      await primary.select(second.contextId);
      expect(primary.getSnapshot().records.map(row => row.value.text)).toEqual(['B note']);
      expect(auxiliary.getSnapshot().records.map(row => row.value.text)).toEqual(['A note']);
      expect(firstCollection.getSnapshot().status).toBe('ready');
      primary.close();
      expect(secondCollection.getSnapshot().status).toBe('idle');
      expect(firstCollection.getSnapshot().status).toBe('ready');
      await context.close();
      expect(auxiliary.getSnapshot()).toMatchObject({ status: 'idle', parentContextId: null, records: [] });
      await expect(auxiliary.select(first.contextId)).rejects.toBeInstanceOf(StoreRetiredError);
    } finally {
      await Promise.all(callbacks.map(callback => callback()));
      await context.close();
    }
  });
});
