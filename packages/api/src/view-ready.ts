import type { ObservableStore } from './observable-store.js';

export type ViewState =
  | { status: 'loading' | 'ready'; error?: never }
  | { status: 'error'; error: Error };

/** Wait for one observable view to publish its first usable local state. */
export function waitForViewReady<State extends ViewState>(options: ObservableStore<State> & {
  closeSignal: AbortSignal;
  signal?: AbortSignal;
}): Promise<Extract<State, { status: 'ready' }>> {
  const signal = options.signal === undefined
    ? options.closeSignal
    : AbortSignal.any([options.signal, options.closeSignal]);

  return new Promise<Extract<State, { status: 'ready' }>>((resolve, reject): void => {
    let unsubscribe = (): void => {};
    const cleanup = (): void => {
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (reason: unknown): void => {
      cleanup();
      reject(reason);
    };
    const inspect = (state: State): void => {
      if (options.signal?.aborted === true) {
        fail(options.signal.reason);
      } else if (state.status === 'error') {
        fail(state.error);
      } else if (options.closeSignal.aborted) {
        fail(options.closeSignal.reason);
      } else if (state.status === 'ready') {
        cleanup();
        resolve(state as Extract<State, { status: 'ready' }>);
      }
    };
    const onAbort = (): void => { inspect(options.getSnapshot()); };

    signal.addEventListener('abort', onAbort, { once: true });
    unsubscribe = options.subscribe(inspect);
    inspect(options.getSnapshot());
  });
}
