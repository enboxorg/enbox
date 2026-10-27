import type { StoreScope } from '../src/store/scope.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';

import sinon from 'sinon';

import { createContextView } from '../src/context-view.js';
import { createEnboxTestContext } from '../src/testing.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { recordCodecs } from '../src/record-codec.js';
import { StoreRetiredError } from '../src/store/scope.js';
import { createCollectionResource, createResourceFactory } from '../src/store/resource.js';
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
      getEnbox : (): never => { throw new Error('Resource fixture supplies native views directly.'); },
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

describe('store collection resources', () => {
  it.each(['retry', 'refresh', 'loadMore'] as const)('%s releases its temporary lease when no consumer retains the view', async (control) => {
    const owner = fixture();
    const native = nativeView();
    const resource = createCollectionResource(owner.scope, async () => native.view);
    await resource[control]();
    expect(resource.getSnapshot()).toMatchObject({ status: 'idle', records: [] });
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('reports active observation changes without activating an unused handle', async () => {
    const owner = fixture();
    const native = nativeView();
    const changes: boolean[] = [];
    const resource = createCollectionResource(owner.scope, async () => native.view, {
      onObservationChange: (active): void => { changes.push(active); },
    });
    expect(changes).toEqual([]);
    const release = resource.retain();
    expect(changes).toEqual([true]);
    await resource.ready();
    const unsubscribe = resource.subscribe((): void => {});
    release();
    expect(changes).toEqual([true]);
    unsubscribe();
    expect(changes).toEqual([true, false]);
    await owner.close();
    expect(changes).toEqual([true, false]);
  });

  it('shares one native view across consumers and closes after the last lease', async () => {
    const owner = fixture();
    const native = nativeView();
    let opens = 0;
    const resource = createCollectionResource(owner.scope, async () => { opens += 1; return native.view; });
    expect(resource.getSnapshot().status).toBe('idle');
    expect(opens).toBe(0);
    const release = resource.retain();
    const unsubscribe = resource.subscribe((): void => {});
    await resource.ready();
    expect(opens).toBe(1);
    release();
    expect(native.closes()).toBe(0);
    unsubscribe();
    await owner.close();
    expect(native.closes()).toBe(1);
    expect(resource.getSnapshot().status).toBe('idle');
  });

  it('ready does not retain visited resources and honors the loadAll policy', async () => {
    const owner = fixture();
    const native = nativeView();
    const resource = createCollectionResource(owner.scope, async () => native.view, { loadAll: true });
    const result = await resource.ready();
    expect(result.records).toEqual(['first', 'second']);
    expect(result.hasMore).toBe(false);
    expect(native.pages()).toBe(1);
    expect(resource.getSnapshot().status).toBe('idle');
    await owner.close();
    expect(native.closes()).toBe(1);
  });

  it('closes views returned after scope retirement without publishing stale rows', async () => {
    const owner = fixture();
    const native = nativeView();
    let finish!: (view: ExpandableRecordView<string>) => void;
    const opening = new Promise<ExpandableRecordView<string>>((resolve) => { finish = resolve; });
    const resource = createCollectionResource(owner.scope, () => opening);
    resource.retain();
    await Promise.resolve();
    const closing = owner.close();
    expect(resource.getSnapshot().status).toBe('idle');
    finish(native.view);
    await closing;
    expect(native.closes()).toBe(1);
    expect(resource.getSnapshot().records).toEqual([]);
  });

  it('cancels one readiness waiter without cancelling another consumer', async () => {
    const owner = fixture();
    const native = nativeView();
    let finish!: (view: ExpandableRecordView<string>) => void;
    const resource = createCollectionResource(owner.scope, () => new Promise(resolve => { finish = resolve; }));
    const release = resource.retain();
    const waiter = new AbortController();
    const pending = resource.ready({ signal: waiter.signal });
    await Promise.resolve();
    const reason = new Error('Selection changed');
    waiter.abort(reason);
    await expect(pending).rejects.toBe(reason);
    finish(native.view);
    await resource.ready();
    expect(resource.getSnapshot().status).toBe('ready');
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
    const resource = createCollectionResource(owner.scope, async () => native.view);
    const release = resource.retain();
    await resource.ready();
    await expect(resource.refreshIfActive()).rejects.toBe(failure);
    expect(resource.getSnapshot().status).toBe('error');
    expect(resource.getSnapshot().records).toEqual(['first']);
    release();
    await owner.close();
  });

  it('shares one checked attachment across concurrent retries', async () => {
    const owner = fixture();
    const first = nativeView();
    const replacement = nativeView();
    let opens = 0;
    let finish!: (view: ExpandableRecordView<string>) => void;
    const resource = createCollectionResource(owner.scope, async () => {
      opens += 1;
      return opens === 1 ? first.view : new Promise(resolve => { finish = resolve; });
    });
    const release = resource.retain();
    await resource.ready();
    const retry = resource.retry();
    expect(resource.retry()).toBe(retry);
    await Promise.resolve();
    await Promise.resolve();
    expect(opens).toBe(2);
    finish(replacement.view);
    await retry;
    expect(resource.getSnapshot()).toEqual({ ...replacement.view.getSnapshot(), isLoadingMore: false });
    expect(resource.getSnapshot()).toBe(resource.getSnapshot());
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
      return (): void => { unsubscribe(); nested = resource.retry(); };
    };
    const resource = createCollectionResource(owner.scope, async () => ++opens === 1 ? first.view : replacement.view);
    const release = resource.retain();
    await resource.ready();
    const retry = resource.retry();
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
      return (): void => { unsubscribe(); nested = resource.retry(); };
    };
    const resource = createCollectionResource(owner.scope, async () => ++opens === 1 ? first.view : replacement.view);
    const retry = resource.retry();
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
    const resource = createCollectionResource(owner.scope, async () => native.view);
    const release = resource.retain();
    await resource.ready();
    const ready = native.view.ready;
    let closing: Promise<void> | undefined;
    native.view.ready = (): ReturnType<typeof ready> => {
      const settled = ready();
      queueMicrotask((): void => { closing = owner.close(); });
      return settled;
    };
    try {
      await expect(resource[operation]()).rejects.toBeInstanceOf(StoreRetiredError);
      expect(resource.getSnapshot().records).toEqual([]);
    } finally {
      release();
      await closing;
      await owner.close();
    }
    expect(native.closes()).toBe(1);
  });
});

describe('store native resources', () => {
  it('preserves native context payloads and reopens the same owner on retry', async () => {
    const owner = fixture();
    let contexts: readonly { id: string }[] = [{ id: 'first' }];
    let wake!: () => void;
    let opens = 0;
    let closes = 0;
    const resource = createResourceFactory(owner.scope)(signal => createContextView({
      callerSignal         : signal,
      list                 : async () => contexts,
      openWakeSubscription : async (notify) => {
        opens += 1;
        wake = notify;
        return { close: async (): Promise<void> => { closes += 1; } };
      },
    }));
    expect(resource.getSnapshot()).toEqual({ status: 'idle', isLoadingMore: false });
    const stop = resource.subscribe((): void => {});
    try {
      expect((await resource.ready()).contexts).toEqual([{ id: 'first' }]);
      contexts = [{ id: 'second' }];
      wake();
      await resource.retry();
      expect(resource.getSnapshot()).toEqual({ status: 'ready', contexts, isLoadingMore: false });
      expect(opens).toBe(2);
      expect(closes).toBe(1);
    } finally { stop(); await owner.close(); }
    expect(closes).toBe(2);
  });

  it('keeps keyed native choices alive without a separate subscriber and closes obsolete late views', async () => {
    const owner = fixture();
    const first = nativeView();
    const second = nativeView();
    const opening = deferred<ExpandableRecordView<string>>();
    const requested = deferred<void>();
    const resource = createResourceFactory(owner.scope)({
      selection : null as string | null,
      open      : async (key) => {
        if (key === 'first') { requested.resolve(); return opening.promise; }
        return second.view;
      },
    });
    const selecting = resource.select('first');
    const retired = selecting.catch((error: unknown) => error);
    await requested.promise;
    await resource.select('second');
    expect(await retired).toBeInstanceOf(StoreRetiredError);
    opening.resolve(first.view);
    expect(resource.getSnapshot()).toMatchObject({ status: 'ready', selection: 'second' });
    expect(second.closes()).toBe(0);
    await resource.select(null);
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
    const resource = createResourceFactory(owner.scope)(async () => ++opens === 1 ? first.view : replacement.view);
    const release = resource.retain();
    try {
      await resource.ready();
      const result = resource[operation]();
      const retired = result.catch((error: unknown) => error);
      await requested.promise;
      await resource.retry();
      pending.reject(new Error('Obsolete query failed'));
      expect(await retired).toBeInstanceOf(StoreRetiredError);
      expect(resource.getSnapshot().status).toBe('ready');
      expect(resource.getSnapshot().error).toBeUndefined();
    } finally { release(); await owner.close(); }
  });

  it('shares pagination work and publishes progress until the page is usable', async () => {
    const owner = fixture();
    const native = nativeView();
    const page = deferred<void>();
    let requests = 0;
    const loadMore = native.view.loadMore;
    native.view.loadMore = async (): Promise<void> => { requests += 1; await page.promise; await loadMore(); };
    const resource = createResourceFactory(owner.scope)(async () => native.view);
    const release = resource.retain();
    await resource.ready();
    const first = resource.loadMore();
    const second = resource.loadMore();
    expect(resource.getSnapshot().isLoadingMore).toBe(true);
    page.resolve();
    await Promise.all([first, second]);
    expect(requests).toBe(1);
    expect(resource.getSnapshot()).toMatchObject({ records: ['first', 'second'], isLoadingMore: false });
    release();
    await owner.close();
  });

  it('retains rows after automatic pagination fails without retrying the failed page', async () => {
    const owner = fixture();
    const native = nativeView();
    const failure = new Error('Next page failed');
    let requests = 0;
    native.view.loadMore = async (): Promise<void> => { requests += 1; throw failure; };
    const resource = createResourceFactory(owner.scope)(async () => native.view, { loadAll: true });
    const failed = deferred<void>();
    const stop = resource.subscribe((state): void => { if (state.status === 'error') { failed.resolve(); } });
    try {
      await failed.promise;
      expect(resource.getSnapshot()).toMatchObject({ status: 'error', records: ['first'], error: failure, isLoadingMore: false });
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
    const resource = createResourceFactory(owner.scope)({
      selection : null as string | null,
      open      : async key => key === 'first' ? first.view : second.view,
    }, { loadAll: true });
    const selecting = resource.select('first').catch((error: unknown) => error);
    await requested.promise;
    await resource.select('second');
    page.reject(new Error('Obsolete page failed'));
    expect(await selecting).toBeInstanceOf(StoreRetiredError);
    expect(resource.getSnapshot()).toMatchObject({ status: 'ready', selection: 'second', records: ['first', 'second'], hasMore: false });
    await owner.close();
  });

  it('rejects ambiguous keyed configuration and non-boolean pagination policies before opening', async () => {
    const owner = fixture();
    const resource = createResourceFactory(owner.scope);
    const native = nativeView();
    const open = async (): Promise<ExpandableRecordView<string>> => native.view;
    expect(() => resource({ selection: null, open, source: () => resource(open) } as never)).toThrow(TypeError);
    expect(() => resource({ open } as never)).toThrow(TypeError);
    expect(() => resource(open, { loadAll: 'true' } as never)).toThrow(TypeError);
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
    const resource = createResourceFactory(owner.scope)(async () => ++opens === 1 ? first.view : replacement.view);
    const release = resource.retain();
    try {
      await resource.ready();
      await resource.retry();
      const closing = resource.close();
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

  it('releases a closed caller resource registration after cleanup while scope disposal still awaits pending release', async () => {
    const owner = fixture();
    const caller = new AbortController();
    const native = nativeView();
    const nativeClosing = deferred<void>();
    native.view.close = (): Promise<void> => nativeClosing.promise;
    const resource = createResourceFactory(owner.scope)(async () => native.view, { signal: caller.signal });
    const release = resource.retain();
    await resource.ready();
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
      if (stage === 'close') { reentrant = resource.close(); }
      return closing.promise;
    };
    const subscribe = native.view.subscribe;
    native.view.subscribe = (listener): (() => void) => {
      const stop = subscribe(listener);
      return (): void => { stop(); if (stage === 'unsubscribe') { reentrant = resource.close(); } };
    };
    const resource = createResourceFactory(owner.scope)(async signal => {
      if (stage === 'abort') { signal.addEventListener('abort', (): void => { reentrant = resource.close(); }, { once: true }); }
      return native.view;
    });
    if (stage === 'close') { await resource.ready(); }
    else { await expect(resource.ready()).rejects.toBeInstanceOf(StoreRetiredError); }
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

  it('observes encrypted records, singleton children, and owned contexts through the same resource factory', async () => {
    const protocol = defineProtocol({
      protocol  : 'https://api.example.test/store-resource/native', published : false,
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
    const resource = createResourceFactory(owner.scope);
    const notes = resource(signal => typed.records.observe<'note', { children: readonly ['note/preview'] }>('note', {
      pagination: { limit: 1 }, materialize: { children: ['note/preview'] }, signal,
    }));
    const contexts = resource(signal => typed.contexts.observe({ signal }));
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
