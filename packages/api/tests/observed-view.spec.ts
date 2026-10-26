import { describe, expect, it } from 'bun:test';

import { ObservedView } from '../src/observed-view.js';

type State = Readonly<{ status: 'ready'; value: number }> | Readonly<{ status: 'error'; error: Error }>;

class ControlledView extends ObservedView<State> {
  public readonly passes: Array<{ generation: number; finish(state: State): void }> = [];
  public closes = 0;

  public constructor() { super(Object.freeze({ status: 'ready', value: 0 })); }

  public wake(): void { this.requestMaterialization(); }

  protected async materialize(generation: number): Promise<void> {
    const state = await new Promise<State>((resolve): void => { this.passes.push({ generation, finish: resolve }); });
    if (this.canPublishMaterialization(generation)) { this.publish(state); }
  }

  protected async closeOwnedResources(): Promise<void> { this.closes += 1; }
  protected handleLifetimeAbort(): void {}
  protected statesEqual(previous: State, next: State): boolean { return previous === next; }
}

async function microtasks(): Promise<void> { for (let i = 0; i < 5; i += 1) { await Promise.resolve(); } }

describe('ObservedView refresh barriers', () => {
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
