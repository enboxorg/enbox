import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';

import { toStoreError } from './scope.js';

/** Immutable progress shared by every consumer of one command. */
export type StoreCommandState<Input> = Readonly<{
  /** Unresolved invocations belonging to the current authorization scope. */
  pendingCount: number;
  /** Unresolved inputs in start order, retained by reference; repeated inputs remain distinct. */
  pendingVariables: readonly Input[];
  /** Display error from the latest invocation admitted to the current scope; initial scope rejection leaves state unchanged. */
  error: Error | undefined;
}>;

/** An authorization-bound operation with shared progress and unchanged operation outcomes. */
export interface StoreCommand<Input, Output> extends ObservableStore<StoreCommandState<Input>> {
  /**
   * Dispatch once through the captured authorization scope and preserve the result or rejection.
   * Retirement prevents new dispatch; operations already issued can still finish.
   */
  run(input: Input): Promise<Output>;
  /** Clear the displayed error without cancelling pending operations. */
  reset(): void;
  /** Check whether the captured authorization is still usable; UI lifetimes, drafts, and navigation remain caller-owned. */
  isCurrent(): boolean;
}

/** @internal Bind observable progress to a scope without dispatching application work. */
export function createCommand<Input, Output>(
  scope: StoreScope,
  operation: (input: Input) => Promise<Output> | Output,
): StoreCommand<Input, Output> {
  const idleState = Object.freeze({ pendingCount: 0, pendingVariables: Object.freeze([]), error: undefined });
  let state: StoreCommandState<Input> = idleState;
  const listeners = new Set<(state: StoreCommandState<Input>) => void>();
  const pending = new Map<number, Input>();
  let latest = 0;
  let retired = false;
  let unregisterCleanup = (): void => {};

  const current = (): boolean => {
    if (retired || scope.signal.aborted) { return false; }
    try { scope.assertCurrent(); return true; } catch { return false; }
  };
  const publish = (error: Error | undefined): void => {
    state = Object.freeze({
      pendingCount     : pending.size,
      pendingVariables : Object.freeze([...pending.values()]),
      error,
    });
    const subscribers = [...listeners];
    for (const listener of subscribers) {
      if (listeners.has(listener)) {
        try { listener(state); } catch { /* Consumer failures do not change command outcomes. */ }
      }
    }
  };
  const retire = (): void => {
    if (retired) { return; }
    retired = true;
    pending.clear();
    state = idleState;
    const subscribers = [...listeners];
    for (const listener of subscribers) {
      if (listeners.has(listener)) {
        try { listener(state); } catch { /* The scope must still retire. */ }
      }
    }
    listeners.clear();
    scope.signal.removeEventListener('abort', retire);
    unregisterCleanup();
  };
  scope.signal.addEventListener('abort', retire, { once: true });
  unregisterCleanup = scope.onClose(retire);
  if (scope.signal.aborted) { retire(); }

  return {
    getSnapshot : (): StoreCommandState<Input> => state,
    isCurrent   : current,
    subscribe   : (listener): (() => void) => {
      if (retired) { return (): void => {}; }
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    reset: (): void => {
      scope.assertCurrent();
      latest += 1;
      publish(undefined);
    },
    run: (input): Promise<Output> => {
      let promise: Promise<Output>;
      let invocation: number | undefined;
      try {
        scope.assertCurrent();
        invocation = ++latest;
        pending.set(invocation, input);
        publish(undefined);
        // A progress subscriber may replace the session synchronously.
        scope.assertCurrent();
        promise = Promise.resolve(operation(input));
      } catch (error: unknown) {
        promise = Promise.reject(error);
      }
      const id = invocation;
      void promise.then(
        (): void => {
          if (id === undefined || !current()) { return; }
          pending.delete(id);
          publish(state.error);
        },
        (error: unknown): void => {
          if (id === undefined || !current()) { return; }
          pending.delete(id);
          publish(id === latest ? toStoreError(error) : state.error);
        },
      );
      return promise;
    },
  };
}
