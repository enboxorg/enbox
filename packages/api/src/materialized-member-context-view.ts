import type { ContextView } from './context-view.js';
import type { RecordView, RecordViewState } from './record-view.js';

import { createContextView } from './context-view.js';

const MEMBER_ROOT_OPEN_CONCURRENCY = 4;

/** One accepted member context paired with its independently observed root state. */
export type MaterializedMemberContext<Context, Root> = Readonly<{
  context: Context;
  root: RecordViewState<Root>;
}>;

type MaterializedMemberContextViewOptions<Context extends { key: string }, Root> = {
  callerSignal?: AbortSignal;
  listContexts(): Promise<readonly Context[]>;
  openRootView(context: Context, signal: AbortSignal): Promise<RecordView<Root>>;
  openWakeSubscription(
    wake: () => void,
    fail: (error: Error) => void,
  ): Promise<{ close(): Promise<void> }>;
  signal?: AbortSignal;
};

type Binding<Context, Root> = {
  context: Context;
  controller: AbortController;
  row: MaterializedMemberContext<Context, Root>;
  unsubscribe?: () => void;
  view?: RecordView<Root>;
};

/** @internal Coordinate independently observed roots for one live member-context catalog. */
export function createMaterializedMemberContextView<Context extends { key: string }, Root>(
  options: MaterializedMemberContextViewOptions<Context, Root>,
): Promise<ContextView<MaterializedMemberContext<Context, Root>>> {
  const loading = Object.freeze({
    status  : 'loading',
    records : Object.freeze([]),
    hasMore : false,
    current : false,
  }) as RecordViewState<Root>;
  let bindings = new Map<string, Binding<Context, Root>>();
  let ordered: Binding<Context, Root>[] = [];
  let catalogVersion = 0;
  let listedVersion = -1;
  let closed = false;
  let wakeView = (): void => {};
  let activeOpenings = 0;
  const openingQueue: Binding<Context, Root>[] = [];
  const openingTasks = new Set<Promise<void>>();
  const cleanupTasks = new Set<Promise<void>>();

  const row = (context: Context, root: RecordViewState<Root>): MaterializedMemberContext<Context, Root> =>
    Object.freeze({ context, root });

  const dispose = (binding: Binding<Context, Root>): Promise<void> | undefined => {
    if (binding.controller.signal.aborted) { return; }
    binding.controller.abort();
    binding.unsubscribe?.();
    binding.unsubscribe = undefined;
    const view = binding.view;
    binding.view = undefined;
    return view?.close();
  };

  const disposeQuietly = (binding: Binding<Context, Root>): void => {
    const task = dispose(binding)?.catch((): void => {});
    if (task === undefined) { return; }
    cleanupTasks.add(task);
    void task.then((): void => { cleanupTasks.delete(task); });
  };

  const publishRoot = (binding: Binding<Context, Root>, root: RecordViewState<Root>): void => {
    if (
      closed || binding.controller.signal.aborted ||
      bindings.get(binding.context.key) !== binding || binding.row.root === root
    ) {
      return;
    }
    binding.row = row(binding.context, root);
    wakeView();
  };

  const openBinding = async (binding: Binding<Context, Root>): Promise<void> => {
    try {
      const view = await options.openRootView(binding.context, binding.controller.signal);
      if (closed || binding.controller.signal.aborted || bindings.get(binding.context.key) !== binding) {
        await view.close();
        return;
      }
      binding.view = view;
      binding.unsubscribe = view.subscribe((state): void => { publishRoot(binding, state); });
      publishRoot(binding, view.getSnapshot());
    } catch (error: unknown) {
      if (closed || binding.controller.signal.aborted || bindings.get(binding.context.key) !== binding) {
        return;
      }
      publishRoot(binding, Object.freeze({
        status  : 'error',
        records : Object.freeze([]),
        hasMore : false,
        current : false,
        error   : error instanceof Error ? error : new Error(String(error)),
      }));
    }
  };

  const drainOpenings = (): void => {
    while (!closed && activeOpenings < MEMBER_ROOT_OPEN_CONCURRENCY && openingQueue.length > 0) {
      const binding = openingQueue.shift()!;
      if (binding.controller.signal.aborted || bindings.get(binding.context.key) !== binding) { continue; }
      activeOpenings += 1;
      const task = openBinding(binding);
      openingTasks.add(task);
      void task.finally((): void => {
        openingTasks.delete(task);
        activeOpenings -= 1;
        drainOpenings();
      });
    }
  };

  const reconcile = (contexts: readonly Context[]): void => {
    const next = new Map<string, Binding<Context, Root>>();
    const nextOrdered: Binding<Context, Root>[] = [];
    for (const context of contexts) {
      let binding = bindings.get(context.key);
      if (
        binding === undefined || binding.context !== context ||
        (binding.view === undefined && binding.row.root.status === 'error')
      ) {
        if (binding !== undefined) { disposeQuietly(binding); }
        binding = {
          context,
          controller : new AbortController(),
          row        : row(context, loading),
        };
        openingQueue.push(binding);
      }
      next.set(context.key, binding);
      nextOrdered.push(binding);
    }
    for (const binding of bindings.values()) {
      if (next.get(binding.context.key) !== binding) { disposeQuietly(binding); }
    }
    bindings = next;
    ordered = nextOrdered;
    drainOpenings();
  };

  return createContextView({
    callerSignal : options.callerSignal,
    list         : async (): Promise<readonly MaterializedMemberContext<Context, Root>[]> => {
      const version = catalogVersion;
      if (listedVersion !== version) {
        const contexts = await options.listContexts();
        if (closed) { return []; }
        reconcile(contexts);
        listedVersion = version;
      }
      return ordered.map(binding => binding.row);
    },
    openWakeSubscription: async (wake, fail) => {
      wakeView = wake;
      const catalog = await options.openWakeSubscription((): void => {
        catalogVersion += 1;
        wake();
      }, fail);
      return {
        close: async (): Promise<void> => {
          closed = true;
          wakeView = (): void => {};
          openingQueue.length = 0;
          const closingViews = [...bindings.values()]
            .map(dispose)
            .filter((task): task is Promise<void> => task !== undefined);
          bindings.clear();
          ordered = [];
          const results = await Promise.allSettled([
            catalog.close(),
            ...openingTasks,
            ...closingViews,
            ...cleanupTasks,
          ]);
          const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failure !== undefined) { throw failure.reason; }
        },
      };
    },
    signal: options.signal,
  });
}
