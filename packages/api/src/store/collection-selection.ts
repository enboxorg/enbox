import type { ObservableStore } from '../observable-store.js';
import type { StoreScope } from './scope.js';
import type { StoreCollectionResource, StoreCollectionState } from './resource.js';

import { StoreRetiredError } from './scope.js';

/** The selected direct parent and its canonical collection state, published together. */
export type StoreCollectionSelectionState<Item> = StoreCollectionState<Item> & Readonly<{
  /** The exact direct-parent context, or null when no collection is selected. */
  parentContextId: string | null;
}>;

/**
 * An independent owner of one selected collection from a keyed family.
 * Subscribing observes its choice without selecting a parent or changing the ownership lifetime.
 */
export interface StoreCollectionSelection<Item> extends ObservableStore<StoreCollectionSelectionState<Item>> {
  /** Return cached empty state with no selected parent for SSR and hydration. */
  getServerSnapshot(): StoreCollectionSelectionState<Item>;
  /**
   * Select a direct parent and wait for usable local rows, including configured loadAll pages.
   * The selection keeps the canonical collection live until replacement, null, close, or owner abort.
   * Replacing, clearing, or closing rejects pending waits with StoreRetiredError; other consumers remain active.
   * Repeating the same parent preserves its observation and waits for its current readiness.
   */
  select(parentContextId: string | null): Promise<void>;
  /** Permanently release this owner's subscription; the shared collection remains independently usable. */
  close(): void;
}

type ActiveSelection<Item> = {
  parentContextId: string;
  collection: StoreCollectionResource<Item>;
  readiness: AbortController;
  unsubscribe?: () => void;
  sourceState?: StoreCollectionState<Item>;
};

/** @internal Borrow canonical family handles without opening or owning another native view. */
export function createCollectionSelection<Item>(
  scope: StoreScope,
  resolve: (parentContextId: string) => StoreCollectionResource<Item>,
  options: Readonly<{ signal?: AbortSignal }> = {},
): StoreCollectionSelection<Item> {
  const idleState = Object.freeze({
    status          : 'idle' as const,
    records         : Object.freeze([]),
    hasMore         : false as const,
    current         : false as const,
    parentContextId : null,
  });
  const signal = options.signal === undefined ? scope.signal : AbortSignal.any([scope.signal, options.signal]);
  const listeners = new Set<(state: StoreCollectionSelectionState<Item>) => void>();
  let state: StoreCollectionSelectionState<Item> = idleState;
  let active: ActiveSelection<Item> | undefined;
  let closed = false;
  let publicationRevision = 0;

  const assertOpen = (): void => {
    if (closed || signal.aborted) { throw new StoreRetiredError(); }
  };
  const isActive = (selection: ActiveSelection<Item>): boolean =>
    !closed && !signal.aborted && active === selection;
  const assertActive = (selection: ActiveSelection<Item>): void => {
    assertOpen();
    scope.assertCurrent();
    if (active !== selection) { throw new StoreRetiredError(); }
  };
  const publish = (next: StoreCollectionSelectionState<Item>): void => {
    if (state === next) { return; }
    state = next;
    const revision = ++publicationRevision;
    const subscribers = [...listeners];
    for (const listener of subscribers) {
      // A subscriber may synchronously select another parent or close this owner.
      if (revision !== publicationRevision) { return; }
      if (listeners.has(listener)) {
        try { listener(next); } catch { /* Consumer failures cannot interrupt selection cleanup. */ }
      }
    }
  };
  const apply = (selection: ActiveSelection<Item>, next: StoreCollectionState<Item>): void => {
    if (!isActive(selection) || selection.sourceState === next) { return; }
    selection.sourceState = next;
    publish(Object.freeze({ ...next, parentContextId: selection.parentContextId }));
  };
  const release = (selection: ActiveSelection<Item> | undefined): void => {
    if (selection === undefined) { return; }
    const unsubscribe = selection.unsubscribe;
    selection.unsubscribe = undefined;
    try { selection.readiness.abort(new StoreRetiredError()); } finally { unsubscribe?.(); }
  };
  const close = (): void => {
    if (closed) { return; }
    closed = true;
    const previous = active;
    active = undefined;
    // Publish terminal state before cleanup callbacks can inspect or reenter this owner.
    publish(idleState);
    try { release(previous); } finally {
      listeners.clear();
      signal.removeEventListener('abort', close);
    }
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) { close(); }

  return {
    getSnapshot       : (): StoreCollectionSelectionState<Item> => state,
    getServerSnapshot : (): StoreCollectionSelectionState<Item> => idleState,
    subscribe         : (listener): (() => void) => {
      if (closed) { return (): void => {}; }
      listeners.add(listener);
      return (): void => { listeners.delete(listener); };
    },
    select: async (parentContextId): Promise<void> => {
      assertOpen();
      if (parentContextId === null) {
        const previous = active;
        active = undefined;
        publish(idleState);
        release(previous);
        assertOpen();
        if (active !== undefined) { throw new StoreRetiredError(); }
        return;
      }
      scope.assertCurrent();
      let selection = active;
      if (selection?.parentContextId !== parentContextId) {
        // Resolve and validate before disturbing the previous selection.
        const collection = resolve(parentContextId);
        const previous = active;
        selection = { parentContextId, collection, readiness: new AbortController() };
        active = selection;
        apply(selection, collection.getSnapshot());
        release(previous);
        assertActive(selection);
        const selected = selection;
        // This forwarding subscription is itself the selection's collection lease.
        const unsubscribe = collection.subscribe((next): void => { apply(selected, next); });
        if (!isActive(selected)) {
          unsubscribe();
          throw new StoreRetiredError();
        }
        selected.unsubscribe = unsubscribe;
        apply(selected, collection.getSnapshot());
      }
      assertActive(selection);
      try {
        await selection.collection.ready({ signal: selection.readiness.signal });
      } finally {
        // Superseded waits report retirement even when their native query already failed.
        assertActive(selection);
      }
    },
    close,
  };
}
