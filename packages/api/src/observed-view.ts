import type { ObservableStore } from './observable-store.js';
import type { ViewState } from './view-ready.js';

import { waitForViewReady } from './view-ready.js';

/**
 * @internal Listener fan-out, idempotent close, and a serialized
 * rematerialization drain shared by the observed views. Subclasses own their
 * subscriptions (released from {@link closeOwnedResources}) and their state
 * computation ({@link materialize}); stale passes are fenced by the request
 * generation supplied to each materialization.
 */
export abstract class ObservedView<TState extends ViewState> implements ObservableStore<TState> {
  protected readonly _closeController = new AbortController();
  protected readonly _callerSignal?: AbortSignal;
  protected readonly _sessionSignal?: AbortSignal;
  private readonly _listeners = new Set<(state: TState) => void>();

  private _closed = false;
  private _closePromise?: Promise<void>;
  private _materializing = false;
  private _materializationRequested = false;
  private _state: TState;

  private _requestGeneration = 0;

  private readonly _handleLifetimeAbort = (): void => {
    const sessionEnded = this._sessionSignal?.aborted === true;
    const signal = sessionEnded ? this._sessionSignal : this._callerSignal;
    this.handleLifetimeAbort(signal?.reason, sessionEnded);
    void this.close().catch((): void => {});
  };

  protected constructor(initialState: TState, callerSignal?: AbortSignal, sessionSignal?: AbortSignal) {
    this._callerSignal = callerSignal;
    this._sessionSignal = sessionSignal;
    this._state = initialState;
    this._callerSignal?.addEventListener('abort', this._handleLifetimeAbort, { once: true });
    this._sessionSignal?.addEventListener('abort', this._handleLifetimeAbort, { once: true });
  }

  public readonly getSnapshot = (): TState => this._state;

  public readonly subscribe = (listener: (state: TState) => void): (() => void) => {
    if (this._closed) {
      return (): void => {};
    }

    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  /** Resolve with the first usable local state; reject on view error, caller abort, or close. */
  public ready(
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<Extract<TState, { status: 'ready' }>> {
    return waitForViewReady({
      closeSignal : this._closeController.signal,
      getSnapshot : this.getSnapshot,
      signal      : options.signal,
      subscribe   : this.subscribe,
    });
  }

  public close(): Promise<void> {
    this._closePromise ??= this.closeView();
    return this._closePromise;
  }

  protected get isClosed(): boolean {
    return this._closed;
  }

  /** Coalesce arbitrary wakes into one active and at most one trailing pass. */
  protected requestMaterialization(): void {
    if (this._closed) {
      return;
    }

    this._requestGeneration += 1;
    this._materializationRequested = true;
    if (this._materializing || !this.mayStartMaterialization()) {
      return;
    }

    this._materializing = true;
    void this.drainMaterializations();
  }

  private async drainMaterializations(): Promise<void> {
    try {
      while (!this._closed && this._materializationRequested) {
        // Clear before the pass so a wake during it schedules a trailing pass.
        this._materializationRequested = false;
        await this.materialize(this._requestGeneration);
      }
    } finally {
      this._materializing = false;
    }
  }

  /** Publish one state to every listener, isolating listener failures from the view lifecycle. */
  protected publish(state: TState): void {
    if (this._closed || this.statesEqual(this._state, state)) {
      return;
    }

    this._state = state;
    // Listener mutations apply to later publications, never the one already in progress.
    const listeners = [...this._listeners];
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A consumer cannot poison the view or prevent other notifications.
      }
    }
  }

  /** Whether a materialization is still the newest requested pass. */
  protected canPublishMaterialization(generation: number): boolean {
    return !this._closed && generation === this._requestGeneration;
  }

  private async closeView(): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._closeController.abort();
    this._requestGeneration += 1;
    this._materializationRequested = false;
    this._listeners.clear();
    this._callerSignal?.removeEventListener('abort', this._handleLifetimeAbort);
    this._sessionSignal?.removeEventListener('abort', this._handleLifetimeAbort);
    await this.closeOwnedResources();
  }

  /** Release owned subscriptions and hooks; called exactly once under the memoized close. */
  protected abstract closeOwnedResources(): Promise<void>;

  /** Execute and publish one requested pass without owning the outer drain loop. */
  protected abstract materialize(generation: number): Promise<void>;

  /** Apply state specific to the first caller or owning-session lifetime that ends. */
  protected abstract handleLifetimeAbort(reason: unknown, sessionEnded: boolean): void;

  /** Whether a requested pass may start now; subclasses gate on open state. */
  protected mayStartMaterialization(): boolean {
    return true;
  }

  /** Publication dedupe; defaults to publishing every computed state. */
  protected statesEqual(_previous: TState, _next: TState): boolean {
    return false;
  }
}
