import type { StoreScope } from '../src/store/scope.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';

import { describe, expect, it } from 'bun:test';

import { createCollectionResource } from '../src/store/resource.js';
import { StoreRetiredError } from '../src/store/scope.js';

function fixture(): { scope: StoreScope; close(): Promise<void> } {
  const controller = new AbortController();
  const closes: Array<() => void | Promise<void>> = [];
  return {
    scope: {
      signal        : controller.signal,
      assertCurrent : (): void => {
        if (controller.signal.aborted) { throw new StoreRetiredError(); }
      },
      getEnbox : (): never => { throw new Error('Resource fixture supplies native views directly.'); },
      onClose  : (close): void => { closes.push(close); },
    },
    close: async (): Promise<void> => {
      controller.abort();
      await Promise.all(closes.map(close => close()));
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
    expect(resource.getSnapshot()).toBe(replacement.view.getSnapshot());
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
