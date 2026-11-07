import type { ProjectionViewGeneration } from '../src/projected-record-view.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';
import type { FollowedSyncSource, SyncEngine, SyncEvent, SyncEventListener } from '@enbox/agent';

import { createProjectedRecordView } from '../src/projected-record-view.js';
import { ContextNotReadyError, ContextRetiredError } from '../src/context-errors.js';
import { describe, expect, it } from 'bun:test';

const source: FollowedSyncSource = {
  acceptanceId   : 'accepted', actorDid       : 'did:example:member', contextId      : 'page', id             : 'role',
  module         : 'https://example.com/notebook', modulePaths    : ['page'], moduleRole     : 'page/editor',
  remoteEndpoint : 'https://owner.example', roles          : ['page/editor'], sourceDid      : 'did:example:owner',
};
const consumer = 'https://example.com/realtime';

type State = RecordViewState<string>;
class NativeView implements ExpandableRecordView<string> {
  public readonly listeners = new Set<(state: State) => void>();
  public closed = false;
  public closeCount = 0;
  public loadMoreCount = 0;
  public onClose?: () => void;
  private _state: State;

  public constructor(value: string) {
    this._state = { status: 'ready', current: true, records: [value], hasMore: false };
  }
  public getSnapshot = (): State => this._state;
  public subscribe = (listener: (state: State) => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  };
  public async ready(): Promise<Extract<State, { status: 'ready' }>> {
    if (this._state.status !== 'ready') { throw new Error('native view unavailable'); }
    return this._state;
  }
  public async refresh(): Promise<Extract<State, { status: 'ready' }>> { return this.ready(); }
  public async loadMore(): Promise<void> { this.loadMoreCount++; }
  public async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    this.closeCount++;
    this.onClose?.();
    this.listeners.clear();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail): void => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

async function settled(predicate: () => boolean): Promise<void> {
  for (let pass = 0; pass < 100 && !predicate(); pass++) { await Promise.resolve(); }
  expect(predicate()).toBe(true);
}

function harness(): {
  emit(active?: boolean): void;
  listeners: Set<SyncEventListener>;
  session: AbortController;
  sync: SyncEngine;
  } {
  const listeners = new Set<SyncEventListener>();
  return {
    emit: (active = true): void => {
      const event: SyncEvent = {
        type                       : 'followed-context:change', actorDid                   : source.actorDid, contextId                  : source.contextId,
        followedSourceAcceptanceId : source.acceptanceId, followedSourceId           : active ? source.id : undefined,
        module                     : source.module, tenantDid                  : source.sourceDid,
      };
      for (const listener of listeners) { listener(event); }
    },
    listeners,
    session : new AbortController(),
    sync    : {
      getFollowedSource : async (id: string): Promise<FollowedSyncSource | undefined> => id === source.id ? source : undefined,
      on                : (listener: SyncEventListener): (() => void) => {
        listeners.add(listener);
        return (): void => { listeners.delete(listener); };
      },
    } as unknown as SyncEngine,
  };
}

describe('projected record views', () => {
  it('preserves synchronous subscription setup failures through the public opening promise', async () => {
    const test = harness();
    const failure = new Error('sync event subscription failed');
    test.sync.on = (): never => { throw failure; };
    await expect(createProjectedRecordView({
      module     : consumer, source, sync       : test.sync,
      generation : (): never => { throw new Error('opening must not continue'); },
    })).rejects.toBe(failure);
    expect(test.listeners.size).toBe(0);
  });

  it('rejects expansion while unavailable and delegates it only to the current verified generation', async () => {
    const test = harness();
    const pending = deferred<ExpandableRecordView<string>>();
    const native = new NativeView('ready');
    const view = await createProjectedRecordView({
      module     : consumer, source, sync       : test.sync,
      generation : () => ({ signal: new AbortController().signal, open: (): Promise<ExpandableRecordView<string>> => pending.promise }),
    });
    await expect(view.loadMore()).rejects.toBeInstanceOf(ContextNotReadyError);
    expect(native.loadMoreCount).toBe(0);
    pending.resolve(native);
    await view.ready();
    await view.loadMore();
    expect(native.loadMoreCount).toBe(1);
    await view.close();
  });

  it.each([
    ['Error', new Error('first close failed')],
    ['undefined', undefined],
    ['null', null],
  ] as const)('drains every closing generation and preserves the first %s cleanup failure', async (_label, reason) => {
    const test = harness();
    const first = new NativeView('first');
    const next = new NativeView('next');
    const firstClose = deferred<void>();
    const nextClose = deferred<void>();
    const closeFirst = first.close.bind(first);
    const closeNext = next.close.bind(next);
    first.close = async (): Promise<void> => { await closeFirst(); await firstClose.promise; };
    next.close = async (): Promise<void> => { await closeNext(); await nextClose.promise; };
    const firstScope = new AbortController();
    let generation: ProjectionViewGeneration<string> = { signal: firstScope.signal, open: async () => first };
    const view = await createProjectedRecordView({ module: consumer, source, sync: test.sync, generation: () => generation });
    await view.ready();
    generation = { signal: new AbortController().signal, open: async (): Promise<ExpandableRecordView<string>> => next };
    firstScope.abort();
    await settled(() => view.getSnapshot().records[0] === 'next');
    let closed = false;
    const closing = Promise.allSettled([view.close()]).then((outcomes): PromiseSettledResult<void> => { closed = true; return outcomes[0]; });
    await settled(() => next.closed);
    firstClose.reject(reason);
    await firstClose.promise.catch((): void => {});
    await Promise.resolve();
    expect(closed).toBe(false);
    nextClose.reject(new Error('later cleanup failure'));
    const outcome = await closing;
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') { expect(outcome.reason).toBe(reason); }
    expect(first.closeCount).toBe(1);
    expect(next.closeCount).toBe(1);
    expect(test.listeners.size).toBe(0);
  });

  it('keeps an unknown root-store failure retryable without opening a generation prematurely', async () => {
    const test = harness();
    const native = new NativeView('recovered');
    const failure = new Error('root store temporarily unavailable');
    let unavailable = true;
    let generations = 0;
    test.sync.getFollowedSource = async (): Promise<FollowedSyncSource> => {
      if (unavailable) { throw failure; }
      return source;
    };
    const view = await createProjectedRecordView({
      module     : consumer, source, sync       : test.sync,
      generation : (): ProjectionViewGeneration<string> => {
        generations++;
        return { signal: new AbortController().signal, open: async () => native };
      },
    });
    await settled(() => view.getSnapshot().status === 'error');
    expect(view.getSnapshot()).toMatchObject({ error: failure, current: false });
    expect(generations).toBe(0);
    unavailable = false;
    test.emit();
    await settled(() => view.getSnapshot().status === 'ready');
    expect(generations).toBe(1);
    await view.close();
  });

  it.each(['forget', 'caller-abort', 'session-abort'] as const)(
    'closes promptly after %s while the root lookup is stalled and ignores its late result', async (reason) => {
      const test = harness();
      const caller = new AbortController();
      const lookup = deferred<FollowedSyncSource>();
      let reading = false;
      let generations = 0;
      test.sync.getFollowedSource = (): Promise<FollowedSyncSource> => { reading = true; return lookup.promise; };
      const view = await createProjectedRecordView({
        module       : consumer, source, sync         : test.sync, callerSignal : caller.signal, signal       : test.session.signal,
        generation   : (): never => { generations++; throw new Error('cancelled lookup must not open a generation'); },
      });
      await settled(() => reading);
      if (reason === 'forget') { test.emit(false); }
      else if (reason === 'caller-abort') { caller.abort(); }
      else { test.session.abort(); }
      let closed = false;
      const closing = view.close().then((): void => { closed = true; });
      try {
        await settled(() => closed);
        expect(generations).toBe(0);
        expect(test.listeners.size).toBe(0);
      } finally {
        lookup.resolve(source);
        await closing;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(generations).toBe(0);
      expect(view.getSnapshot().current).toBe(false);
    },
  );

  it('treats a missing root as terminal even when a wake queued another opening', async () => {
    const test = harness();
    const lookup = deferred<FollowedSyncSource | undefined>();
    let reads = 0;
    let generations = 0;
    test.sync.getFollowedSource = (): Promise<FollowedSyncSource | undefined> => { reads++; return lookup.promise; };
    const view = await createProjectedRecordView({
      module     : consumer, source, sync       : test.sync,
      generation : (): never => { generations++; throw new Error('missing root must not open a generation'); },
    });
    await settled(() => reads === 1);
    test.emit();
    lookup.resolve(undefined);
    await settled(() => test.listeners.size === 0);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    expect(generations).toBe(0);
    expect(view.getSnapshot()).toMatchObject({ status: 'error', current: false, error: expect.any(ContextRetiredError) });
    await view.close();
  });

  it('recovers consumer retirement during a pending opening when the root remains active', async () => {
    const test = harness();
    const oldScope = new AbortController();
    const pending = deferred<ExpandableRecordView<string>>();
    const late = new NativeView('retired');
    const next = new NativeView('current');
    let opening = false;
    let generation: ProjectionViewGeneration<string> = {
      signal : oldScope.signal,
      open   : (): Promise<ExpandableRecordView<string>> => { opening = true; return pending.promise; },
    };
    const view = await createProjectedRecordView({ module: consumer, source, sync: test.sync, generation: () => generation });
    await settled(() => opening);
    generation = { signal: new AbortController().signal, open: async (): Promise<ExpandableRecordView<string>> => next };
    oldScope.abort(new ContextRetiredError(source.contextId));
    await settled(() => view.getSnapshot().records[0] === 'current');
    expect(view.getSnapshot().current).toBe(true);
    pending.resolve(late);
    await settled(() => late.closed);
    expect(view.getSnapshot().records).toEqual(['current']);
    expect(test.listeners.size).toBe(1);
    await view.close();
  });

  it('coalesces repeated wakes through the shared drain without overlapping generation opens', async () => {
    const test = harness();
    const first = deferred<ExpandableRecordView<string>>();
    const second = deferred<ExpandableRecordView<string>>();
    const native = new NativeView('ready');
    let opens = 0;
    let active = 0;
    let maximumActive = 0;
    const view = await createProjectedRecordView({
      module     : consumer, source, sync       : test.sync,
      generation : () => ({
        signal : new AbortController().signal,
        open   : async (): Promise<ExpandableRecordView<string>> => {
          const pending = opens++ === 0 ? first.promise : second.promise;
          active++;
          maximumActive = Math.max(maximumActive, active);
          try { return await pending; }
          finally { active--; }
        },
      }),
    });
    try {
      await settled(() => opens === 1);
      for (let wake = 0; wake < 10; wake++) { test.emit(); }
      expect(opens).toBe(1);
      first.reject(new Error('transient open failure'));
      await settled(() => opens === 2);
      expect(maximumActive).toBe(1);
      for (let wake = 0; wake < 10; wake++) { test.emit(); }
      expect(opens).toBe(2);
      second.resolve(native);
      await settled(() => view.getSnapshot().status === 'ready');
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(opens).toBe(2);
      expect(maximumActive).toBe(1);
      expect(view.getSnapshot().records).toEqual(['ready']);
    } finally {
      first.resolve(native);
      second.resolve(native);
      await view.close();
    }
  });

  it('publishes noncurrent before closing a lost generation and reopens without replacing root intent', async () => {
    const test = harness();
    const first = new NativeView('first');
    const next = new NativeView('next');
    const firstScope = new AbortController();
    const nextScope = new AbortController();
    const pending = deferred<ExpandableRecordView<string>>();
    let generation: ProjectionViewGeneration<string> = { signal: firstScope.signal, open: async () => first };
    const view = await createProjectedRecordView({
      module: consumer, source, signal: test.session.signal, sync: test.sync, generation: () => generation,
    });
    await view.ready();
    const lateListeners = [...first.listeners];
    first.onClose = (): void => { expect(view.getSnapshot().current).toBe(false); };
    generation = { signal: nextScope.signal, open: (): Promise<ExpandableRecordView<string>> => pending.promise };
    firstScope.abort(new ContextRetiredError(source.contextId));
    expect(view.getSnapshot().status).toBe('error');
    expect(view.getSnapshot().current).toBe(false);
    expect(first.closeCount).toBe(1);
    pending.resolve(next);
    await settled(() => view.getSnapshot().records[0] === 'next');
    expect(view.getSnapshot().current).toBe(true);
    for (const listener of lateListeners) { listener({ status: 'ready', current: true, records: ['late'], hasMore: false }); }
    expect(view.getSnapshot().records).toEqual(['next']);
    expect(test.session.signal.aborted).toBe(false);
    await view.close();
    expect(next.closeCount).toBe(1);
    expect(test.listeners.size).toBe(0);
  });

  it('does not report current while refresh waits for the replacement opening', async () => {
    const test = harness();
    const first = new NativeView('first');
    const next = new NativeView('next');
    const oldScope = new AbortController();
    const pending = deferred<ExpandableRecordView<string>>();
    let generation: ProjectionViewGeneration<string> = { signal: oldScope.signal, open: async () => first };
    const view = await createProjectedRecordView({ module: consumer, source, sync: test.sync, generation: () => generation });
    await view.ready();
    generation = { signal: new AbortController().signal, open: (): Promise<ExpandableRecordView<string>> => pending.promise };
    oldScope.abort();
    const refreshing = view.refresh();
    expect(view.getSnapshot().current).toBe(false);
    pending.resolve(next);
    expect((await refreshing).records).toEqual(['next']);
    await view.close();
  });

  it('surfaces generation construction failures and retries only after a wake', async () => {
    const test = harness();
    const failure = new Error('projection definition unavailable');
    const native = new NativeView('recovered');
    let unavailable = true;
    let attempts = 0;
    const view = await createProjectedRecordView({
      module     : consumer, source, sync       : test.sync,
      generation : (): ProjectionViewGeneration<string> => {
        attempts++;
        if (unavailable) { throw failure; }
        return { signal: new AbortController().signal, open: async () => native };
      },
    });
    await settled(() => view.getSnapshot().status === 'error');
    expect(view.getSnapshot()).toMatchObject({ error: failure, current: false });
    expect(attempts).toBe(1);
    unavailable = false;
    test.emit();
    await settled(() => view.getSnapshot().status === 'ready');
    expect(attempts).toBe(2);
    await view.close();
  });

  it.each(['forget', 'caller-abort'] as const)('closes late subscription opens after %s during recovery', async (reason) => {
    const test = harness();
    const first = new NativeView('first');
    const late = new NativeView('late');
    const oldScope = new AbortController();
    const caller = new AbortController();
    const pending = deferred<ExpandableRecordView<string>>();
    let opening = false;
    let generation: ProjectionViewGeneration<string> = { signal: oldScope.signal, open: async () => first };
    const view = await createProjectedRecordView({
      module: consumer, source, sync: test.sync, callerSignal: caller.signal, signal: test.session.signal, generation: () => generation,
    });
    await view.ready();
    generation = {
      signal : new AbortController().signal,
      open   : (): Promise<ExpandableRecordView<string>> => { opening = true; return pending.promise; },
    };
    oldScope.abort();
    await settled(() => opening);
    if (reason === 'forget') { test.emit(false); } else { caller.abort(); }
    await view.close();
    pending.resolve(late);
    await settled(() => late.closed);
    expect(view.getSnapshot().current).toBe(false);
    expect(view.getSnapshot().records).not.toEqual(['late']);
    expect(late.closeCount).toBe(1);
    expect(test.listeners.size).toBe(0);
  });
});
