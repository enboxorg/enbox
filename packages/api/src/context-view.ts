import { waitForViewReady } from './view-ready.js';

/** Immutable state of one protocol's local context catalog. */
export type ContextViewState<Context> = Readonly<{
  contexts: readonly Context[];
}> & Readonly<
  | { status: 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: Error }
>;

type ReadyContextViewState<Context> = Extract<ContextViewState<Context>, { status: 'ready' }>;

/** Listener notified after a context view publishes new state. */
export type ContextViewListener<Context> = (state: ContextViewState<Context>) => void;

/** Closeable live view of one protocol's local context catalog. */
export interface ContextView<Context> {
  getState: () => ContextViewState<Context>;
  subscribe: (listener: ContextViewListener<Context>) => () => void;
  /** Resolve after the catalog's first local materialization. */
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<ReadyContextViewState<Context>>;
  close(): Promise<void>;
}

type ContextViewOptions<Context> = {
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
  options.signal?.throwIfAborted();
  const view = new ObservedContextView(options);
  await view.open();
  return view;
}

class ObservedContextView<Context> implements ContextView<Context> {
  private readonly _closeController = new AbortController();
  private readonly _listeners = new Set<ContextViewListener<Context>>();
  private readonly _list: ContextViewOptions<Context>['list'];
  private readonly _openWakeSubscription: ContextViewOptions<Context>['openWakeSubscription'];
  private readonly _signal?: AbortSignal;

  private _closed = false;
  private _closePromise?: Promise<void>;
  private _materializing = false;
  private _materializationRequested = false;
  private _state: ContextViewState<Context> = immutableState({ status: 'loading', contexts: [] });
  private _wakeSubscription?: { close(): Promise<void> };

  private readonly _handleAbort = (): void => {
    this.publishError(new Error('ContextView: owning session ended.', { cause: this._signal?.reason }));
    void this.close().catch((): void => {});
  };

  public constructor(options: ContextViewOptions<Context>) {
    this._list = options.list;
    this._openWakeSubscription = options.openWakeSubscription;
    this._signal = options.signal;
    this._signal?.addEventListener('abort', this._handleAbort, { once: true });
  }

  public readonly getState = (): ContextViewState<Context> => this._state;

  public readonly subscribe = (listener: ContextViewListener<Context>): (() => void) => {
    if (this._closed) {
      return (): void => {};
    }
    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  public ready(
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ReadyContextViewState<Context>> {
    return waitForViewReady({
      closeSignal : this._closeController.signal,
      getState    : this.getState,
      signal      : options.signal,
      subscribe   : this.subscribe,
    });
  }

  public close(): Promise<void> {
    this._closePromise ??= this.closeOwnedResources();
    return this._closePromise;
  }

  /** Install wake delivery before the initial list so changes cannot fall through the handoff. */
  public async open(): Promise<void> {
    try {
      this._wakeSubscription = await this._openWakeSubscription(
        (): void => { this.requestMaterialization(); },
        (error): void => {
          if (!this._closed) {
            this.publishError(error);
            void this.close().catch((): void => {});
          }
        },
      );
      if (this._closed) {
        await this._wakeSubscription.close();
        return;
      }
      this.requestMaterialization();
    } catch (error: unknown) {
      await this.close();
      throw error;
    }
  }

  private async closeOwnedResources(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._closeController.abort();
    this._materializationRequested = false;
    this._signal?.removeEventListener('abort', this._handleAbort);
    this._listeners.clear();
    await this._wakeSubscription?.close();
    this._wakeSubscription = undefined;
  }

  private requestMaterialization(): void {
    if (this._closed) {
      return;
    }
    this._materializationRequested = true;
    if (this._materializing) {
      return;
    }
    this._materializing = true;
    void this.drainMaterializations();
  }

  private async drainMaterializations(): Promise<void> {
    try {
      while (!this._closed && this._materializationRequested) {
        await this.materialize();
      }
    } finally {
      this._materializing = false;
    }
  }

  private async materialize(): Promise<void> {
    this._materializationRequested = false;
    try {
      const contexts = await this._list();
      if (this.canPublish()) {
        this.publish(immutableState({ status: 'ready', contexts }));
      }
    } catch (error: unknown) {
      if (this.canPublish()) {
        this.publishError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private canPublish(): boolean {
    return !this._closed && !this._materializationRequested;
  }

  private publishError(error: Error): void {
    this.publish(immutableState({ status: 'error', contexts: this._state.contexts, error }));
  }

  private publish(state: ContextViewState<Context>): void {
    if (statesEqual(this._state, state)) {
      return;
    }
    this._state = state;
    for (const listener of [...this._listeners]) {
      try {
        listener(state);
      } catch {
        // Listener failures do not own the catalog lifecycle.
      }
    }
  }
}

function immutableState<Context>(state: ContextViewState<Context>): ContextViewState<Context> {
  return Object.freeze({ ...state, contexts: Object.freeze([...state.contexts]) });
}

function statesEqual<Context>(a: ContextViewState<Context>, b: ContextViewState<Context>): boolean {
  return a.status === b.status &&
    a.error === b.error &&
    a.contexts.length === b.contexts.length &&
    a.contexts.every((context, index) => context === b.contexts[index]);
}
