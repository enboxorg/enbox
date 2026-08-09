import { ObservedView } from './observed-view.js';
import { openView } from './view-opening.js';

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
  callerSignal?: AbortSignal;
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
  private readonly _callerSignal?: AbortSignal;
  private readonly _list: ContextViewOptions<Context>['list'];
  private readonly _openWakeSubscription: ContextViewOptions<Context>['openWakeSubscription'];
  private readonly _signal?: AbortSignal;

  private _wakeSubscription?: { close(): Promise<void> };

  private readonly _handleAbort = (): void => {
    this.publishError(new Error('ContextView: owning session ended.', { cause: this._signal?.reason }));
    void this.close().catch((): void => {});
  };

  private readonly _handleCallerAbort = (): void => {
    void this.close().catch((): void => {});
  };

  public constructor(options: ContextViewOptions<Context>) {
    super(immutableState({ status: 'loading', contexts: [] }));
    this._callerSignal = options.callerSignal;
    this._list = options.list;
    this._openWakeSubscription = options.openWakeSubscription;
    this._signal = options.signal;
    this._callerSignal?.addEventListener('abort', this._handleCallerAbort, { once: true });
    this._signal?.addEventListener('abort', this._handleAbort, { once: true });
  }

  /** Install wake delivery before the initial list so changes cannot fall through the handoff. */
  public async open(): Promise<void> {
    try {
      const wakeSubscription = await this._openWakeSubscription(
        (): void => { this.requestMaterialization(); },
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
        this._signal?.throwIfAborted();
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
    this._callerSignal?.removeEventListener('abort', this._handleCallerAbort);
    this._signal?.removeEventListener('abort', this._handleAbort);
    await this._wakeSubscription?.close();
    this._wakeSubscription = undefined;
  }

  protected async materialize(generation: number): Promise<void> {
    try {
      const contexts = await this._list();
      if (this.canPublishMaterialization(generation)) {
        this.publish(immutableState({ status: 'ready', contexts }));
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

  private publishError(error: Error): void {
    this.publish(immutableState({ status: 'error', contexts: this.getState().contexts, error }));
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
