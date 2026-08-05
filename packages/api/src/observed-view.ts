import type { ViewState } from './view-ready.js';

import { waitForViewReady } from './view-ready.js';

/**
 * @internal Listener fan-out, idempotent close, and a serialized
 * rematerialization drain shared by the observed views. Subclasses own their
 * subscriptions (released from {@link closeOwnedResources}) and their state
 * computation ({@link materialize}); stale-pass fencing is available through
 * the monotonic {@link ObservedView._requestGeneration} counter.
 */
export abstract class ObservedView<TState extends ViewState> {
  protected readonly _closeController = new AbortController();
  private readonly _listeners = new Set<(state: TState) => void>();

  private _closed = false;
  private _closePromise?: Promise<void>;
  private _materializing = false;
  private _materializationRequested = false;
  private _state: TState;

  /** Monotonic materialization request counter for subclasses that fence stale passes. */
  protected _requestGeneration = 0;

  protected constructor(initialState: TState) {
    this._state = initialState;
  }

  public readonly getState = (): TState => this._state;

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
      getState    : this.getState,
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

  /** Whether a newer pass has been requested behind one in flight. */
  protected get isMaterializationRequested(): boolean {
    return this._materializationRequested;
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
        await this.materialize();
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

  private async closeView(): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._closeController.abort();
    this._requestGeneration += 1;
    this._materializationRequested = false;
    this._listeners.clear();
    await this.closeOwnedResources();
  }

  /** Release owned subscriptions and hooks; called exactly once under the memoized close. */
  protected abstract closeOwnedResources(): Promise<void>;

  /** Execute and publish one requested pass without owning the outer drain loop. */
  protected abstract materialize(): Promise<void>;

  /** Whether a requested pass may start now; subclasses gate on open state. */
  protected mayStartMaterialization(): boolean {
    return true;
  }

  /** Publication dedupe; defaults to publishing every computed state. */
  protected statesEqual(_previous: TState, _next: TState): boolean {
    return false;
  }
}
