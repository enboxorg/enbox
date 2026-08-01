import type { FollowedSyncSource, SyncEngine, SyncEvent } from '@enbox/agent';

import { followedContextChangeRetiresSource } from './followed-context-lifecycle.js';
import { followedSyncSourceActiveEqual } from '@enbox/agent';

/** Immutable materialization of the locally accepted contexts for one protocol. */
export type ContextViewSnapshot<Context> = Readonly<{
  contexts: readonly Context[];
}> & Readonly<
  | { state: 'loading' | 'ready'; error?: never }
  | { state: 'error'; error: Error }
>;

/** Listener notified after an accepted-context view publishes a new snapshot. */
export type ContextViewListener<Context> = (snapshot: ContextViewSnapshot<Context>) => void;

/** Closeable live view of the durable contexts accepted by one actor. */
export interface ContextView<Context> {
  getSnapshot: () => ContextViewSnapshot<Context>;
  subscribe: (listener: ContextViewListener<Context>) => () => void;
  close(): Promise<void>;
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
export async function createContextView<Context>(options: ContextViewOptions<Context>): Promise<ContextView<Context>> {
  options.signal?.throwIfAborted();
  const view = new ObservedContextView(options);
  view.open();
  return view;
}

class ObservedContextView<Context> implements ContextView<Context> {
  private readonly _actorDid: string;
  private readonly _bind: ContextViewOptions<Context>['bind'];
  private readonly _listeners = new Set<ContextViewListener<Context>>();
  private readonly _listSources: ContextViewOptions<Context>['listSources'];
  private readonly _protocol: string;
  private readonly _signal?: AbortSignal;
  private readonly _sync: SyncEngine;

  private _bound = new Map<string, BoundContext<Context>>();
  private _closed = false;
  private _materializing = false;
  private _materializationRequested = false;
  private _requestGeneration = 0;
  private _snapshot: ContextViewSnapshot<Context> = immutableSnapshot({ state: 'loading', contexts: [] });
  private _syncUnsubscribe?: () => void;

  private readonly _handleAbort = (): void => {
    this.publishError(new Error('ContextView: owning session ended.', { cause: this._signal?.reason }));
    void this.close();
  };

  public constructor(options: ContextViewOptions<Context>) {
    this._actorDid = options.actorDid;
    this._bind = options.bind;
    this._listSources = options.listSources;
    this._protocol = options.protocol;
    this._signal = options.signal;
    this._sync = options.sync;
  }

  public open(): void {
    this._signal?.addEventListener('abort', this._handleAbort, { once: true });
    this._syncUnsubscribe = this._sync.on((event): void => { this.handleSyncEvent(event); });
    this.requestMaterialization();
  }

  public readonly getSnapshot = (): ContextViewSnapshot<Context> => this._snapshot;

  public readonly subscribe = (listener: ContextViewListener<Context>): (() => void) => {
    if (this._closed) {
      return (): void => {};
    }
    this._listeners.add(listener);
    return (): void => { this._listeners.delete(listener); };
  };

  public async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._requestGeneration += 1;
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
      const key = contextKey({ sourceDid: event.tenantDid, contextId: event.contextId });
      const bound = this._bound.get(key);
      if (bound !== undefined && followedContextChangeRetiresSource(bound.source, event)) {
        this._bound.delete(key);
      }
      this.requestMaterialization();
    }
  }

  private requestMaterialization(): void {
    if (this._closed) {
      return;
    }
    this._requestGeneration += 1;
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
        await this.materializeRequestedGeneration();
      }
    } finally {
      this._materializing = false;
    }
  }

  private async materializeRequestedGeneration(): Promise<void> {
    this._materializationRequested = false;
    const generation = this._requestGeneration;
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
      if (!this.canPublish(generation)) {
        return;
      }
      this._bound = bound;
      this.publish(immutableSnapshot({ state: 'ready', contexts }));
    } catch (error: unknown) {
      if (this.canPublish(generation)) {
        this.publishError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private canPublish(generation: number): boolean {
    return !this._closed && generation === this._requestGeneration;
  }

  private publishError(error: Error): void {
    this.publish(immutableSnapshot({ state: 'error', contexts: this._snapshot.contexts, error }));
  }

  private publish(snapshot: ContextViewSnapshot<Context>): void {
    if (snapshotsEqual(this._snapshot, snapshot)) {
      return;
    }
    this._snapshot = snapshot;
    for (const listener of [...this._listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures do not own the catalog lifecycle.
      }
    }
  }
}

function contextKey(source: Pick<FollowedSyncSource, 'contextId' | 'sourceDid'>): string {
  return JSON.stringify([source.sourceDid, source.contextId]);
}

function immutableSnapshot<Context>(snapshot: ContextViewSnapshot<Context>): ContextViewSnapshot<Context> {
  return Object.freeze({ ...snapshot, contexts: Object.freeze([...snapshot.contexts]) });
}

function snapshotsEqual<Context>(
  a: ContextViewSnapshot<Context>,
  b: ContextViewSnapshot<Context>,
): boolean {
  return a.state === b.state &&
    a.error === b.error &&
    a.contexts.length === b.contexts.length &&
    a.contexts.every((context, index) => context === b.contexts[index]);
}
