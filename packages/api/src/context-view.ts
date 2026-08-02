import type { FollowedSyncSource, SyncEngine, SyncEvent } from '@enbox/agent';

import { followedSyncSourceActiveEqual } from '@enbox/agent';

/** Immutable state of the locally accepted contexts for one protocol. */
export type ContextViewState<Context> = Readonly<{
  contexts: readonly Context[];
}> & Readonly<
  | { status: 'loading' | 'ready'; error?: never }
  | { status: 'error'; error: Error }
>;

/** Listener notified after an accepted-context view publishes new state. */
export type ContextViewListener<Context> = (state: ContextViewState<Context>) => void;

/** Closeable live view of the durable contexts accepted by one actor. */
export interface ContextView<Context> {
  getState: () => ContextViewState<Context>;
  subscribe: (listener: ContextViewListener<Context>) => () => void;
  close(): void;
}

type ContextViewOptions<Context> = {
  actorDid: string;
  bind(source: FollowedSyncSource): Context;
  listSources(): Promise<readonly FollowedSyncSource[]>;
  protocol: string;
  signal?: AbortSignal;
  sync: SyncEngine;
};

type BoundContext<Context> = {
  context: Context;
  source: FollowedSyncSource;
};

/** @internal Create a view after installing its wake listener. */
export function createContextView<Context>(options: ContextViewOptions<Context>): ContextView<Context> {
  options.signal?.throwIfAborted();
  return new ObservedContextView(options);
}

class ObservedContextView<Context> implements ContextView<Context> {
  private readonly _actorDid: string;
  private readonly _bind: ContextViewOptions<Context>['bind'];
  private readonly _listeners = new Set<ContextViewListener<Context>>();
  private readonly _listSources: ContextViewOptions<Context>['listSources'];
  private readonly _protocol: string;
  private readonly _signal?: AbortSignal;

  private _bound = new Map<string, BoundContext<Context>>();
  private _closed = false;
  private _materializing = false;
  private _materializationRequested = false;
  private _state: ContextViewState<Context> = immutableState({ status: 'loading', contexts: [] });
  private _syncUnsubscribe?: () => void;

  private readonly _handleAbort = (): void => {
    this.publishError(new Error('ContextView: owning session ended.', { cause: this._signal?.reason }));
    this.close();
  };

  public constructor(options: ContextViewOptions<Context>) {
    this._actorDid = options.actorDid;
    this._bind = options.bind;
    this._listSources = options.listSources;
    this._protocol = options.protocol;
    this._signal = options.signal;
    this._signal?.addEventListener('abort', this._handleAbort, { once: true });
    this._syncUnsubscribe = options.sync.on((event): void => { this.handleSyncEvent(event); });
    this.requestMaterialization();
  }

  public readonly getState = (): ContextViewState<Context> => this._state;

  public readonly subscribe = (listener: ContextViewListener<Context>): (() => void) => {
    if (this._closed) {
      return (): void => {};
    }
    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  public close(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._materializationRequested = false;
    this._syncUnsubscribe?.();
    this._syncUnsubscribe = undefined;
    this._signal?.removeEventListener('abort', this._handleAbort);
    this._listeners.clear();
    this._bound.clear();
  }

  private handleSyncEvent(event: SyncEvent): void {
    if (
      event.type === 'followed-context:change' &&
      event.actorDid === this._actorDid &&
      event.protocol === this._protocol
    ) {
      this.requestMaterialization();
    }
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
      const sources = await this._listSources();
      const bound = new Map<string, BoundContext<Context>>();
      const contexts = sources.map((source): Context => {
        const key = contextKey(source);
        const existing = this._bound.get(key);
        const context = existing !== undefined && followedSyncSourceActiveEqual(existing.source, source)
          ? existing.context
          : this._bind(source);
        bound.set(key, { context, source });
        return context;
      });
      if (!this.canPublish()) {
        return;
      }
      this._bound = bound;
      this.publish(immutableState({ status: 'ready', contexts }));
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

function contextKey(source: Pick<FollowedSyncSource, 'contextId' | 'sourceDid'>): string {
  return JSON.stringify([source.sourceDid, source.contextId]);
}

function immutableState<Context>(state: ContextViewState<Context>): ContextViewState<Context> {
  return Object.freeze({ ...state, contexts: Object.freeze([...state.contexts]) });
}

function statesEqual<Context>(
  a: ContextViewState<Context>,
  b: ContextViewState<Context>,
): boolean {
  return a.status === b.status &&
    a.error === b.error &&
    a.contexts.length === b.contexts.length &&
    a.contexts.every((context, index) => context === b.contexts[index]);
}
