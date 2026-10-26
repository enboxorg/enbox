import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';

import { toStoreError } from './scope.js';

/** Immutable progress for one store command. */
export type StoreCommandSnapshot<Input> = Readonly<{
  pendingCount: number;
  /** Inputs of all unresolved invocations, ordered from oldest to newest. */
  pendingVariables: readonly Input[];
  error: Error | undefined;
}>;

/** A generation-bound operation whose native outcome remains available to callers. */
export interface StoreCommand<Input, Output> extends ObservableStore<StoreCommandSnapshot<Input>> {
  getServerSnapshot(): StoreCommandSnapshot<Input>;
  run(input: Input): Promise<Output>;
  reset(): void;
  isCurrent(): boolean;
}

/** Create an observable command without starting application work. */
export function createCommand<Input, Output>(
  scope: StoreScope,
  operation: (input: Input) => Promise<Output> | Output,
): StoreCommand<Input, Output> {
  const idle = Object.freeze({ pendingCount: 0, pendingVariables: Object.freeze([]), error: undefined });
  let snapshot: StoreCommandSnapshot<Input> = idle;
  const listeners = new Set<(state: StoreCommandSnapshot<Input>) => void>();
  const pending = new Map<number, Input>();
  let latest = 0;
  let retired = false;

  const current = (): boolean => {
    if (retired || scope.signal.aborted) { return false; }
    try { scope.assertCurrent(); return true; } catch { return false; }
  };
  const publish = (error: Error | undefined): void => {
    snapshot = Object.freeze({
      pendingCount     : pending.size,
      pendingVariables : Object.freeze([...pending.values()]),
      error,
    });
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) {
        try { listener(snapshot); } catch { /* Consumer failures do not change command outcomes. */ }
      }
    }
  };
  const retire = (): void => {
    if (retired) { return; }
    retired = true;
    pending.clear();
    snapshot = idle;
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) {
        try { listener(snapshot); } catch { /* The scope must still retire. */ }
      }
    }
    listeners.clear();
    scope.signal.removeEventListener('abort', retire);
  };
  scope.signal.addEventListener('abort', retire, { once: true });
  scope.onClose(retire);

  return {
    getSnapshot       : (): StoreCommandSnapshot<Input> => snapshot,
    getServerSnapshot : (): StoreCommandSnapshot<Input> => idle,
    isCurrent         : current,
    subscribe         : (listener): (() => void) => {
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
          publish(snapshot.error);
        },
        (error: unknown): void => {
          if (id === undefined || !current()) { return; }
          pending.delete(id);
          publish(id === latest ? toStoreError(error) : snapshot.error);
        },
      );
      return promise;
    },
  };
}
