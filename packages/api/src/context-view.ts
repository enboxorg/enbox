import type { ObservableStore } from './observable-store.js';

import { ObservedView } from './observed-view.js';
import { openView } from './view-opening.js';

/** A saved follow choice, including contexts whose access cannot currently be restored. */
export type SavedContextFollow = Readonly<{
  key: string;
  id: string;
  ownerDid: string;
  /** Protocol path of the saved context root. */
  path: string;
}>;

/** Immutable state of one protocol's local context catalog. */
export type ContextViewState<Context> = Readonly<{
  contexts: readonly Context[];
  /** Current saved follows in key order; these coordinates alone do not establish access. */
  savedFollows: readonly SavedContextFollow[];
}> & Readonly<
  | { status: 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: Error }
>;

type ReadyContextViewState<Context> = Extract<ContextViewState<Context>, { status: 'ready' }>;

/** Closeable live view of one protocol's local context catalog. */
export interface ContextView<Context> extends ObservableStore<ContextViewState<Context>> {
  /** Resolve after the catalog's first local materialization. */
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<ReadyContextViewState<Context>>;
  close(): Promise<void>;
}

type ContextViewOptions<Context> = {
  callerSignal?: AbortSignal;
  getSavedFollows?(): readonly SavedContextFollow[];
  list(): Promise<readonly Context[]>;
  openWakeSubscription(
    wake: () => void,
    fail: (error: Error) => void,
  ): Promise<{ close(): Promise<void> }>;
  signal?: AbortSignal;
};

/** @internal Create a view after installing its wake subscription. */
export async function createContextView<Context>(
  options: ContextViewOptions<Context>,
): Promise<ContextView<Context>> {
  options.callerSignal?.throwIfAborted();
  options.signal?.throwIfAborted();
  const view = new ObservedContextView(options);
  await openView(view, [options.callerSignal, options.signal]);
  return view;
}

class ObservedContextView<Context> extends ObservedView<ContextViewState<Context>> implements ContextView<Context> {
  private readonly _getSavedFollows: () => readonly SavedContextFollow[];
  private readonly _list: ContextViewOptions<Context>['list'];
  private readonly _openWakeSubscription: ContextViewOptions<Context>['openWakeSubscription'];

  private _wakeSubscription?: { close(): Promise<void> };

  public constructor(options: ContextViewOptions<Context>) {
    super(immutableState({ status: 'loading', contexts: [], savedFollows: [] }), options.callerSignal, options.signal);
    this._getSavedFollows = options.getSavedFollows ?? ((): readonly SavedContextFollow[] => []);
    this._list = options.list;
    this._openWakeSubscription = options.openWakeSubscription;
  }

  /** Install wake delivery before the initial list so changes cannot fall through the handoff. */
  public async open(): Promise<void> {
    try {
      const wakeSubscription = await this._openWakeSubscription(
        (): void => {
          // The initial list includes changes delivered while subscriptions are still opening.
          if (this._wakeSubscription !== undefined) { this.requestMaterialization(); }
        },
        (error): void => {
          if (!this.isClosed) {
            this.publishError(error);
            void this.close().catch((): void => {});
          }
        },
      );
      if (this.isClosed) {
        await wakeSubscription.close();
        this._callerSignal?.throwIfAborted();
        this._sessionSignal?.throwIfAborted();
        return;
      }
      this._wakeSubscription = wakeSubscription;
      this.requestMaterialization();
    } catch (error: unknown) {
      await this.close();
      throw error;
    }
  }

  protected async closeOwnedResources(): Promise<void> {
    await this._wakeSubscription?.close();
    this._wakeSubscription = undefined;
  }

  protected async materialize(generation: number): Promise<void> {
    try {
      const contexts = await this._list();
      if (this.canPublishMaterialization(generation)) {
        this.publish(immutableState({ status: 'ready', contexts, savedFollows: this._getSavedFollows() }));
      }
    } catch (error: unknown) {
      if (this.canPublishMaterialization(generation)) {
        this.publishError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  protected statesEqual(previous: ContextViewState<Context>, next: ContextViewState<Context>): boolean {
    return statesEqual(previous, next);
  }

  /** Keep caller abort silent; publish owning-session termination. */
  protected handleLifetimeAbort(reason: unknown, sessionEnded: boolean): void {
    if (sessionEnded) {
      this.publishError(new Error('ContextView: owning session ended.', { cause: reason }));
    }
  }

  private publishError(error: Error): void {
    this.publish(immutableState({ ...this.getSnapshot(), status: 'error', error }));
  }
}

function immutableState<Context>(state: ContextViewState<Context>): ContextViewState<Context> {
  return Object.freeze({
    ...state,
    contexts     : Object.freeze([...state.contexts]),
    savedFollows : Object.freeze(state.savedFollows.map(follow => Object.freeze({ ...follow }))),
  });
}

function statesEqual<Context>(a: ContextViewState<Context>, b: ContextViewState<Context>): boolean {
  return a.status === b.status &&
    a.error === b.error &&
    a.contexts.length === b.contexts.length &&
    a.contexts.every((context, index) => context === b.contexts[index]) &&
    a.savedFollows.length === b.savedFollows.length &&
    a.savedFollows.every((follow, index) => {
      const other = b.savedFollows[index];
      return follow.key === other.key && follow.id === other.id &&
        follow.ownerDid === other.ownerDid && follow.path === other.path;
    });
}
