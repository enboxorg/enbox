import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { createContextView } from '../src/context-view.js';
import { ObservedView } from '../src/observed-view.js';

type State = Readonly<{ status: 'ready'; value: number }> | Readonly<{ status: 'error'; error: Error }>;

class ControlledView extends ObservedView<State> {
  public readonly passes: Array<{ generation: number; finish(state: State): void; fail(reason: unknown): void }> = [];
  public closes = 0;

  public constructor() { super(Object.freeze({ status: 'ready', value: 0 })); }

  public refresh(): Promise<Extract<State, { status: 'ready' }>> { return this.refreshMaterialization(); }
  public wake(): void { this.requestMaterialization(); }

  protected async materialize(generation: number): Promise<void> {
    const state = await new Promise<State>((resolve, reject): void => { this.passes.push({ generation, finish: resolve, fail: reject }); });
    if (this.canPublishMaterialization(generation)) { this.publish(state); }
  }

  protected async closeOwnedResources(): Promise<void> { this.closes += 1; }
  protected handleLifetimeAbort(): void {}
  protected statesEqual(previous: State, next: State): boolean { return previous === next; }
}

async function microtasks(): Promise<void> { for (let i = 0; i < 5; i += 1) { await Promise.resolve(); } }

describe('ObservedView refresh barriers', () => {
  it('keeps record refresh out of the public context-catalog surface', async () => {
    const catalog = await createContextView({
      list                 : async () => ['context'],
      openWakeSubscription : async () => ({ close: async (): Promise<void> => {} }),
    });
    try {
      expect(await catalog.ready()).toEqual({ status: 'ready', contexts: ['context'] });
      expect('refresh' in catalog).toBe(false);
    } finally {
      await catalog.close();
    }
  });

  it.each(['sync', 'async'] as const)('rejects refresh after an unexpected %s materialization throw and permits immediate retry', async (kind) => {
    const failure = new Error('Unexpected materialization failure');
    const warning = sinon.stub(console, 'warn');
    class ThrowingView extends ObservedView<State> {
      private _fail = true;

      public constructor() { super({ status: 'ready', value: 0 }); }
      public refresh(): Promise<Extract<State, { status: 'ready' }>> { return this.refreshMaterialization(); }
      protected materialize(): Promise<void> {
        if (this._fail) {
          this._fail = false;
          if (kind === 'async') { return Promise.reject(failure); }
          throw failure;
        }
        this.publish({ status: 'ready', value: 1 });
        return Promise.resolve();
      }
      protected async closeOwnedResources(): Promise<void> {}
      protected handleLifetimeAbort(): void {}
    }
    const view = new ThrowingView();
    try {
      const retried = view.refresh().catch((error: unknown) => {
        expect(error).toBe(failure);
        return view.refresh();
      });
      expect(await retried).toEqual({ status: 'ready', value: 1 });
      expect(warning.calledOnce).toBe(true);
      await microtasks();
    } finally {
      await view.close();
      warning.restore();
    }
  });

  it('preserves newer refresh requests when an obsolete materialization throws', async () => {
    const warning = sinon.stub(console, 'warn');
    const view = new ControlledView();
    try {
      const first = view.refresh();
      const second = view.refresh();
      const outcomes = Promise.all([first, second]);
      view.passes[0].fail(new Error('Obsolete query failed'));
      await microtasks();
      expect(view.passes).toHaveLength(2);
      const state = { status: 'ready', value: 2 } as const;
      view.passes[1].finish(state);
      expect(await outcomes).toEqual([state, state]);
      expect(warning.called).toBe(false);
    } finally {
      await view.close();
      warning.restore();
    }
  });

  it('settles every pending refresh after interleaved refresh requests and ordinary wakes', async () => {
    const view = new ControlledView();
    const first = view.refresh();
    const second = view.refresh();
    view.wake();
    const outcomes = Promise.all([first, second]);
    view.passes[0].finish({ status: 'ready', value: 1 });
    await microtasks();
    expect(view.passes).toHaveLength(2);
    const latest = { status: 'ready', value: 3 } as const;
    view.passes[1].finish(latest);
    expect(await outcomes).toEqual([latest, latest]);
    await view.close();
  });

  it('materializes a wake issued by a refresh consumer before the drain becomes idle', async () => {
    const view = new ControlledView();
    const refreshed = view.refresh().then((): void => { view.wake(); });
    view.passes[0].finish({ status: 'ready', value: 1 });
    await refreshed;
    await microtasks();
    expect(view.passes).toHaveLength(2);
    view.passes[1].finish({ status: 'ready', value: 2 });
    await microtasks();
    expect(view.getSnapshot()).toEqual({ status: 'ready', value: 2 });
    await view.close();
  });

  it('serializes refresh after an older pass and never resolves it from stale work', async () => {
    const view = new ControlledView();
    const published: State[] = [];
    view.subscribe(state => published.push(state));
    view.wake();
    let settled = false;
    const refreshed = view.refresh().then((state) => { settled = true; return state; });
    expect(view.passes).toHaveLength(1);
    view.passes[0].finish({ status: 'ready', value: 1 });
    await microtasks();
    expect(settled).toBe(false);
    expect(published).toHaveLength(0);
    expect(view.passes).toHaveLength(2);
    view.passes[1].finish({ status: 'ready', value: 2 });
    expect(await refreshed).toEqual({ status: 'ready', value: 2 });
    expect(published).toEqual([{ status: 'ready', value: 2 }]);
    await view.close();
  });

  it('settles refresh when canonical materialization returns the same snapshot reference', async () => {
    const view = new ControlledView();
    const unchanged = view.getSnapshot();
    let publications = 0;
    view.subscribe((): void => { publications += 1; });
    const refreshed = view.refresh();
    view.passes[0].finish(unchanged);
    expect(await refreshed).toBe(unchanged);
    expect(publications).toBe(0);
    await view.close();
  });

  it('rejects all refreshes covered by a failed canonical pass and permits retry', async () => {
    const view = new ControlledView();
    const first = view.refresh();
    const second = view.refresh();
    const failure = new Error('Materialization failed');
    const outcomes = Promise.allSettled([first, second]);
    view.passes[0].finish({ status: 'ready', value: 1 });
    await microtasks();
    view.passes[1].finish({ status: 'error', error: failure });
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    const retry = view.refresh();
    view.passes[2].finish({ status: 'ready', value: 3 });
    expect(await retry).toEqual({ status: 'ready', value: 3 });
    await view.close();
  });

  it('rejects pending refresh on close and fences both trailing passes and late publications', async () => {
    const view = new ControlledView();
    let publications = 0;
    view.subscribe((): void => { publications += 1; });
    view.wake();
    const refreshed = view.refresh();
    await view.close();
    await expect(refreshed).rejects.toBeDefined();
    view.passes[0].finish({ status: 'ready', value: 1 });
    await microtasks();
    expect(view.passes).toHaveLength(1);
    expect(publications).toBe(0);
    expect(view.getSnapshot()).toEqual({ status: 'ready', value: 0 });
    expect(view.closes).toBe(1);
    await expect(view.refresh()).rejects.toThrow('closed view');
  });
});
