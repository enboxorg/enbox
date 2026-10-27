import type { StoreScope } from '../src/store/scope.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';

import sinon from 'sinon';

import { createContextView } from '../src/context-view.js';
import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';
import { StoreRetiredError } from '../src/store/scope.js';
import { createObservationFactory, createObservedCollection } from '../src/store/observed-store.js';
import { describe, expect, it } from 'bun:test';

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void; reject(error: unknown): void } {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((complete, fail): void => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(): { scope: StoreScope; registrations(): number; close(): Promise<void> } {
  const controller = new AbortController();
  const closes = new Set<() => void | Promise<void>>();
  return {
    scope: {
      signal        : controller.signal,
      assertCurrent : (): void => {
        if (controller.signal.aborted) { throw new StoreRetiredError(); }
      },
      getEnbox : (): never => { throw new Error('Observation fixture supplies native views directly.'); },
      onClose  : (close): (() => void) => { closes.add(close); return (): void => { closes.delete(close); }; },
    },
    registrations : (): number => closes.size,
    close         : async (): Promise<void> => {
      controller.abort();
      await Promise.all([...closes].map(close => close()));
    },
  };
}

function nativeView(): { view: ExpandableRecordView<string>; closes(): number; pages(): number } {
  let state: RecordViewState<string> = Object.freeze({ status: 'ready', records: Object.freeze(['first']), hasMore: true, current: false });
  const listeners = new Set<(snapshot: RecordViewState<string>) => void>();
  let closed = 0;
  let pages = 0;
  return {
    closes : (): number => closed,
    pages  : (): number => pages,
    view   : {
      getSnapshot : (): RecordViewState<string> => state,
      subscribe   : (listener): (() => void) => {
        listeners.add(listener);
        return (): void => { listeners.delete(listener); };
      },
      ready: async (): Promise<Extract<RecordViewState<string>, { status: 'ready' }>> => {
        if (state.status !== 'ready') { throw new Error('Fixture view is not ready.'); }
        return state;
      },
      refresh: async (): Promise<Extract<RecordViewState<string>, { status: 'ready' }>> => {
        if (state.status !== 'ready') { throw new Error('Fixture view is not ready.'); }
        return state;
      },
      loadMore: async (): Promise<void> => {
        pages += 1;
        state = Object.freeze({ status: 'ready', records: Object.freeze(['first', 'second']), hasMore: false, current: false });
        for (const listener of listeners) { listener(state); }
      },
      close: async (): Promise<void> => { closed += 1; },
    },
  };
}

describe('observed collections', () => {
  it.each(['retry', 'refresh', 'loadMore'] as const)('%s releases its temporary lease when no consumer retains the view', async (control) => {
    const owner = fixture();
    const native = nativeView();
    const store = createObservedCollection(owner.scope, async () => native.view);
    await store[control]();
    expect(store.getSnapshot()).toMatchObject({ status: 'idle', records: [] });
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('reports active observation changes without activating an unused handle', async () => {
    const owner = fixture();
    const native = nativeView();
    const changes: boolean[] = [];
    const store = createObservedCollection(owner.scope, async () => native.view, {
      onObservationChange: (active): void => { changes.push(active); },
    });
    expect(changes).toEqual([]);
    const release = store.retain();
    expect(changes).toEqual([true]);
    await store.ready();
    const unsubscribe = store.subscribe((): void => {});
    release();
    expect(changes).toEqual([true]);
    unsubscribe();
    expect(changes).toEqual([true, false]);
    await owner.close();
    expect(changes).toEqual([true, false]);
  });

  it('supplies a stable private write-refresh control without retaining an abandoned observation', async () => {
    const owner = fixture();
    const native = nativeView();
    const pending = deferred<Extract<RecordViewState<string>, { status: 'ready' }>>();
    const requested = deferred<void>();
    native.view.refresh = (): typeof pending.promise => { requested.resolve(); return pending.promise; };
    const callbacks: Array<() => Promise<void>> = [];
    let opens = 0;
    const observed = createObservedCollection(owner.scope, async () => { opens++; return native.view; }, {
      onObservationChange: (_active, refresh): void => { callbacks.push(refresh); },
    });
    const release = observed.retain();
    await observed.ready();
    const refreshing = callbacks[0]().catch((error: unknown): unknown => error);
    await requested.promise;
    release();
    expect(observed.getSnapshot().status).toBe('idle');
    expect(await refreshing).toBeInstanceOf(StoreRetiredError);
    expect(callbacks[1]).toBe(callbacks[0]);
    await callbacks[1]();
    expect(opens).toBe(1);
    pending.resolve({ status: 'ready', records: [], current: false, hasMore: false });
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('shares one native view across consumers and closes after the last lease', async () => {
    const owner = fixture();
    const native = nativeView();
    let opens = 0;
    const store = createObservedCollection(owner.scope, async () => { opens += 1; return native.view; });
    expect(store.getSnapshot().status).toBe('idle');
    expect(opens).toBe(0);
    const release = store.retain();
    const unsubscribe = store.subscribe((): void => {});
    await store.ready();
    expect(opens).toBe(1);
    release();
    expect(native.closes()).toBe(0);
    unsubscribe();
    await owner.close();
    expect(native.closes()).toBe(1);
    expect(store.getSnapshot().status).toBe('idle');
  });

  it('ready does not retain visited stores and honors the loadAll policy', async () => {
    const owner = fixture();
    const native = nativeView();
    const store = createObservedCollection(owner.scope, async () => native.view, { loadAll: true });
    const result = await store.ready();
    expect(result.records).toEqual(['first', 'second']);
    expect(result.hasMore).toBe(false);
    expect(native.pages()).toBe(1);
    expect(store.getSnapshot().status).toBe('idle');
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('closes views returned after scope retirement without publishing stale rows', async () => {
    const owner = fixture();
    const native = nativeView();
    let finish!: (view: ExpandableRecordView<string>) => void;
    const opening = new Promise<ExpandableRecordView<string>>((resolve) => { finish = resolve; });
    const store = createObservedCollection(owner.scope, () => opening);
    store.retain();
    await Promise.resolve();
    const closing = owner.close();
    expect(store.getSnapshot().status).toBe('idle');
    finish(native.view);
    await closing;
    expect(native.closes()).toBe(1);
    expect(store.getSnapshot().records).toEqual([]);
  });

  it('cancels one readiness waiter without cancelling another consumer', async () => {
    const owner = fixture();
    const native = nativeView();
    let finish!: (view: ExpandableRecordView<string>) => void;
    const store = createObservedCollection(owner.scope, () => new Promise(resolve => { finish = resolve; }));
    const release = store.retain();
    const waiter = new AbortController();
    const pending = store.ready({ signal: waiter.signal });
    await Promise.resolve();
    const reason = new Error('Selection changed');
    waiter.abort(reason);
    await expect(pending).rejects.toBe(reason);
    finish(native.view);
    await store.ready();
    expect(store.getSnapshot().status).toBe('ready');
    expect(native.closes()).toBe(0);
    release();
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('publishes native refresh failures while preserving the previous materialized rows', async () => {
    const owner = fixture();
    const native = nativeView();
    const failure = new Error('Canonical reread failed');
    native.view.refresh = async (): Promise<never> => { throw failure; };
    const store = createObservedCollection(owner.scope, async () => native.view);
    const release = store.retain();
    await store.ready();
    await expect(store.refresh()).rejects.toBe(failure);
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().records).toEqual(['first']);
    release();
    await owner.close();
  });

  it('shares one checked attachment across concurrent retries', async () => {
    const owner = fixture();
    const first = nativeView();
    const replacement = nativeView();
    let opens = 0;
    let finish!: (view: ExpandableRecordView<string>) => void;
    const store = createObservedCollection(owner.scope, async () => {
      opens += 1;
      return opens === 1 ? first.view : new Promise(resolve => { finish = resolve; });
    });
    const release = store.retain();
    await store.ready();
    const retry = store.retry();
    expect(store.retry()).toBe(retry);
    await Promise.resolve();
    await Promise.resolve();
    expect(opens).toBe(2);
    finish(replacement.view);
    await retry;
    expect(store.getSnapshot()).toEqual({ ...replacement.view.getSnapshot(), isLoadingMore: false });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    release();
    await owner.close();
    expect(first.closes()).toBe(1);
    expect(replacement.closes()).toBe(1);
  });

  it('installs the shared retry before retiring a native subscription can reenter', async () => {
    const owner = fixture();
    const first = nativeView();
    const replacement = nativeView();
    let opens = 0;
    let nested: Promise<void> | undefined;
    const subscribe = first.view.subscribe;
    first.view.subscribe = (listener): (() => void) => {
      const unsubscribe = subscribe(listener);
      return (): void => { unsubscribe(); nested = store.retry(); };
    };
    const store = createObservedCollection(owner.scope, async () => ++opens === 1 ? first.view : replacement.view);
    const release = store.retain();
    await store.ready();
    const retry = store.retry();
    await retry;
    expect(nested).toBe(retry);
    expect(opens).toBe(2);
    release();
    await owner.close();
  });

  it('allows a new retry requested by final lease cleanup after the prior retry settles', async () => {
    const owner = fixture();
    const first = nativeView();
    const replacement = nativeView();
    let opens = 0;
    let nested: Promise<void> | undefined;
    const subscribe = first.view.subscribe;
    first.view.subscribe = (listener): (() => void) => {
      const unsubscribe = subscribe(listener);
      return (): void => { unsubscribe(); nested = store.retry(); };
    };
    const store = createObservedCollection(owner.scope, async () => ++opens === 1 ? first.view : replacement.view);
    const retry = store.retry();
    await retry;
    expect(nested).toBeDefined();
    expect(nested).not.toBe(retry);
    await nested;
    expect(opens).toBe(2);
    await owner.close();
    expect(first.closes()).toBe(1);
    expect(replacement.closes()).toBe(1);
  });

  it.each(['ready', 'refresh'] as const)('fences %s after native readiness settles but before its result is forwarded', async (operation) => {
    const owner = fixture();
    const native = nativeView();
    const store = createObservedCollection(owner.scope, async () => native.view);
    const release = store.retain();
    await store.ready();
    const ready = native.view.ready;
    let closing: Promise<void> | undefined;
    native.view.ready = (): ReturnType<typeof ready> => {
      const settled = ready();
      queueMicrotask((): void => { closing = owner.close(); });
      return settled;
    };
    try {
      await expect(store[operation]()).rejects.toBeInstanceOf(StoreRetiredError);
      expect(store.getSnapshot().records).toEqual([]);
    } finally {
      release();
      await closing;
      await owner.close();
    }
    expect(native.closes()).toBe(1);
  });
});

describe('observed stores', () => {
  it('consumes readiness rejected during synchronous owner retirement', async () => {
    const owner = fixture();
    const caller = new AbortController();
    const native = nativeView();
    native.view.ready = (options = {}): Promise<never> => {
      caller.abort();
      return Promise.reject(options.signal?.reason);
    };
    const store = createObservationFactory(owner.scope)(async () => native.view, { signal: caller.signal });
    await expect(store.ready()).rejects.toBeInstanceOf(StoreRetiredError);
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('preserves native context payloads and reopens the same owner on retry', async () => {
    const owner = fixture();
    let contexts: readonly { id: string }[] = [{ id: 'first' }];
    let wake!: () => void;
    let opens = 0;
    let closes = 0;
    const store = createObservationFactory(owner.scope)(signal => createContextView({
      callerSignal         : signal,
      list                 : async () => contexts,
      openWakeSubscription : async (notify) => {
        opens += 1;
        wake = notify;
        return { close: async (): Promise<void> => { closes += 1; } };
      },
    }));
    expect(store.getSnapshot()).toEqual({ status: 'idle', isLoadingMore: false });
    const stop = store.subscribe((): void => {});
    try {
      expect((await store.ready()).contexts).toEqual([{ id: 'first' }]);
      contexts = [{ id: 'second' }];
      wake();
      await store.retry();
      expect(store.getSnapshot()).toEqual({ status: 'ready', contexts, isLoadingMore: false });
      expect(opens).toBe(2);
      expect(closes).toBe(1);
    } finally { stop(); await owner.close(); }
    expect(closes).toBe(2);
  });

  it('keeps selectable native choices alive without a separate subscriber and closes obsolete late views', async () => {
    const owner = fixture();
    const first = nativeView();
    const second = nativeView();
    const opening = deferred<ExpandableRecordView<string>>();
    const requested = deferred<void>();
    const store = createObservationFactory(owner.scope)({
      open: async (key: string) => {
        if (key === 'first') { requested.resolve(); return opening.promise; }
        return second.view;
      },
    });
    const selecting = store.select('first');
    const retired = selecting.catch((error: unknown) => error);
    await requested.promise;
    await store.select('second');
    expect(await retired).toBeInstanceOf(StoreRetiredError);
    opening.resolve(first.view);
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', selection: 'second' });
    expect(second.closes()).toBe(0);
    await store.select(null);
    await owner.close();
    expect(first.closes()).toBe(1);
    expect(second.closes()).toBe(1);
  });

  it.each(['refresh', 'loadMore'] as const)('fences failed %s work when retry replaces its native observation', async (operation) => {
    const owner = fixture();
    const first = nativeView();
    const replacement = nativeView();
    const pending = deferred<never>();
    const requested = deferred<void>();
    first.view[operation] = (): Promise<never> => { requested.resolve(); return pending.promise; };
    let opens = 0;
    const store = createObservationFactory(owner.scope)(async () => ++opens === 1 ? first.view : replacement.view);
    const release = store.retain();
    try {
      await store.ready();
      const result = store[operation]();
      const retired = result.catch((error: unknown) => error);
      await requested.promise;
      await store.retry();
      pending.reject(new Error('Obsolete query failed'));
      expect(await retired).toBeInstanceOf(StoreRetiredError);
      expect(store.getSnapshot().status).toBe('ready');
      expect(store.getSnapshot().error).toBeUndefined();
    } finally { release(); await owner.close(); }
  });

  it('shares pagination work and publishes progress until the page is usable', async () => {
    const owner = fixture();
    const native = nativeView();
    const page = deferred<void>();
    let requests = 0;
    const loadMore = native.view.loadMore;
    native.view.loadMore = async (): Promise<void> => { requests += 1; await page.promise; await loadMore(); };
    const store = createObservationFactory(owner.scope)(async () => native.view);
    const release = store.retain();
    await store.ready();
    const first = store.loadMore();
    const second = store.loadMore();
    expect(store.getSnapshot().isLoadingMore).toBe(true);
    page.resolve();
    await Promise.all([first, second]);
    expect(requests).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ records: ['first', 'second'], isLoadingMore: false });
    release();
    await owner.close();
  });

  it('retains rows after automatic pagination fails without retrying the failed page', async () => {
    const owner = fixture();
    const native = nativeView();
    const failure = new Error('Next page failed');
    let requests = 0;
    native.view.loadMore = async (): Promise<void> => { requests += 1; throw failure; };
    const store = createObservationFactory(owner.scope)(async () => native.view, { loadAll: true });
    const failed = deferred<void>();
    const stop = store.subscribe((state): void => { if (state.status === 'error') { failed.resolve(); } });
    try {
      await failed.promise;
      expect(store.getSnapshot()).toMatchObject({ status: 'error', records: ['first'], error: failure, isLoadingMore: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(requests).toBe(1);
    } finally { stop(); await owner.close(); }
  });

  it('keeps replacement rows when an obsolete automatic expansion fails', async () => {
    const owner = fixture();
    const first = nativeView();
    const second = nativeView();
    const page = deferred<void>();
    const requested = deferred<void>();
    first.view.loadMore = (): Promise<void> => { requested.resolve(); return page.promise; };
    const store = createObservationFactory(owner.scope)({
      open: async (key: string) => key === 'first' ? first.view : second.view,
    }, { loadAll: true });
    const selecting = store.select('first').catch((error: unknown) => error);
    await requested.promise;
    await store.select('second');
    page.reject(new Error('Obsolete page failed'));
    expect(await selecting).toBeInstanceOf(StoreRetiredError);
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', selection: 'second', records: ['first', 'second'], hasMore: false });
    await owner.close();
  });

  it('rejects ambiguous selectable configuration and non-boolean pagination policies before opening', async () => {
    const owner = fixture();
    const store = createObservationFactory(owner.scope);
    const native = nativeView();
    const open = async (): Promise<ExpandableRecordView<string>> => native.view;
    expect(() => store({ open, source: () => store(open) } as never)).toThrow(TypeError);
    expect(() => store({} as never)).toThrow(TypeError);
    expect(() => store(open, { loadAll: 'true' } as never)).toThrow(TypeError);
    await owner.close();
    expect(native.closes()).toBe(0);
  });

  it('awaits slow cleanup even when an earlier view cleanup rejects', async () => {
    const owner = fixture();
    const first = nativeView();
    const replacement = nativeView();
    const failure = new Error('First close failed');
    const slowClose = deferred<void>();
    first.view.close = async (): Promise<void> => { throw failure; };
    replacement.view.close = (): Promise<void> => slowClose.promise;
    const warn = sinon.stub(console, 'warn');
    let opens = 0;
    const store = createObservationFactory(owner.scope)(async () => ++opens === 1 ? first.view : replacement.view);
    const release = store.retain();
    try {
      await store.ready();
      await store.retry();
      const closing = store.close();
      let settled = false;
      const result = closing.catch((error: AggregateError): void => {
        settled = true;
        expect(error.errors).toEqual([failure]);
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      slowClose.resolve();
      await result;
      expect(settled).toBe(true);
      expect(owner.registrations()).toBe(1);
      await expect(owner.close()).rejects.toBeInstanceOf(AggregateError);
    } finally { release(); slowClose.resolve(); warn.restore(); }
  });

  it('releases a closed caller store registration after cleanup while scope disposal still awaits pending release', async () => {
    const owner = fixture();
    const caller = new AbortController();
    const native = nativeView();
    const nativeClosing = deferred<void>();
    native.view.close = (): Promise<void> => nativeClosing.promise;
    const store = createObservationFactory(owner.scope)(async () => native.view, { signal: caller.signal });
    const release = store.retain();
    await store.ready();
    caller.abort();
    expect(owner.registrations()).toBe(1);
    let disposed = false;
    const disposal = owner.close().then((): void => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    nativeClosing.resolve();
    await disposal;
    expect(owner.registrations()).toBe(0);
    expect(disposed).toBe(true);
    release();
  });

  it.each(['unsubscribe', 'abort', 'close'] as const)('tracks native cleanup before %s can reenter close', async (stage) => {
    const owner = fixture();
    const native = nativeView();
    const closing = deferred<void>();
    let reentrant: Promise<void> | undefined;
    let nativeCloses = 0;
    native.view.close = (): Promise<void> => {
      nativeCloses += 1;
      if (stage === 'close') { reentrant = store.close(); }
      return closing.promise;
    };
    const subscribe = native.view.subscribe;
    native.view.subscribe = (listener): (() => void) => {
      const stop = subscribe(listener);
      return (): void => { stop(); if (stage === 'unsubscribe') { reentrant = store.close(); } };
    };
    const store = createObservationFactory(owner.scope)(async signal => {
      if (stage === 'abort') { signal.addEventListener('abort', (): void => { reentrant = store.close(); }, { once: true }); }
      return native.view;
    });
    if (stage === 'close') { await store.ready(); }
    else { await expect(store.ready()).rejects.toBeInstanceOf(StoreRetiredError); }
    await Promise.resolve();
    expect(reentrant).toBeDefined();
    let finished = false;
    const completion = reentrant!.then((): void => { finished = true; });
    await Promise.resolve();
    expect(nativeCloses).toBe(1);
    expect(finished).toBe(false);
    closing.resolve();
    await completion;
    expect(finished).toBe(true);
    await owner.close();
  });

  it('observes encrypted records, singleton children, and owned contexts through the same observe helper', async () => {
    const protocol = defineProtocol({
      protocol  : 'https://api.example.test/store-store/native', published : false,
      types     : {
        note    : { dataFormats: ['application/json'], encryptionRequired: true },
        preview : { dataFormats: ['application/json'], encryptionRequired: true },
        member  : { dataFormats: ['application/json'] },
      },
      structure: { note: {
        $actions : [{ role: 'note/member', can: ['read'] }],
        preview  : { $recordLimit: { max: 1 } }, member   : { $role: true },
      } },
    } as const, {
      note    : recordCodecs.json<{ title: string }>(),
      preview : recordCodecs.json<{ body: string }>(),
      member  : recordCodecs.json<{ label: string }>(),
    }, { roleGroups: { default: ['note/member'] } });
    const context = await createEnboxTestContext({ application: defineApplicationManifest({ protocols: [protocol] }) });
    const owner = fixture();
    const typed = context.enbox.using(protocol);
    const store = createObservationFactory(owner.scope);
    const notes = store(signal => typed.records.observe<'note', { children: readonly ['note/preview'] }>('note', {
      pagination: { limit: 1 }, materialize: { children: ['note/preview'] }, signal,
    }));
    const contexts = store(signal => typed.contexts.observe({ signal }));
    const stopNotes = notes.retain();
    const stopContexts = contexts.retain();
    try {
      const first = await typed.records.create('note', { data: { title: 'First' } });
      await typed.records.create('note', { data: { title: 'Second' } });
      await notes.refresh();
      expect((await notes.ready()).records).toHaveLength(1);
      await notes.loadMore();
      expect(notes.getSnapshot().records).toHaveLength(2);
      await typed.records.set('note/preview', { within: first.contextId, data: { body: 'Preview' } });
      await notes.refresh();
      expect(notes.getSnapshot().records?.find(row => row.record.id === first.id)?.children.preview?.value.body).toBe('Preview');
      await contexts.retry();
      expect((await contexts.ready()).contexts).toHaveLength(2);
      expect(contexts.getSnapshot().contexts?.[0]).toMatchObject({ access: 'owner', path: 'note' });
    } finally {
      stopNotes(); stopContexts();
      await owner.close();
      await context.close();
    }
  });
});
