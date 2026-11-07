import type { ProjectionViewGeneration } from '../src/projected-record-view.js';
import type { ExpandableRecordView, RecordViewState } from '../src/record-view.js';
import type { FollowedSyncSource, SyncEngine, SyncEvent, SyncEventListener } from '@enbox/agent';

import { ContextRetiredError } from '../src/context-errors.js';
import { createProjectedRecordView } from '../src/projected-record-view.js';
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
  public async loadMore(): Promise<void> {}
  public async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    this.closeCount++;
    this.onClose?.();
    this.listeners.clear();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
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
    sync    : { on: (listener: SyncEventListener): (() => void) => {
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    } } as unknown as SyncEngine,
  };
}

describe('projected record views', () => {
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
