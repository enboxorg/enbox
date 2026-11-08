import type { FollowedModuleLease } from './followed-module-lease.js';
import type { ExpandableRecordView, RecordViewState } from './record-view.js';
import type { FollowedSyncSource, SyncEngine, SyncEvent } from '@enbox/agent';

import { ObservedView } from './observed-view.js';
import { syncEventCoversModule } from '@enbox/agent';
import { combineAbortSignals, openView, whileSignalsActive } from './view-opening.js';
import { ContextNotReadyError, ContextRetiredError } from './context-errors.js';

export type ProjectionViewGeneration<Item> = {
  open(signal: AbortSignal): Promise<ExpandableRecordView<Item>>;
  signal: AbortSignal;
};

type ProjectedRecordViewOptions<Item> = {
  callerSignal?: AbortSignal;
  generation(): ProjectionViewGeneration<Item>;
  module: string;
  signal?: AbortSignal;
  source: FollowedSyncSource;
  root: Pick<FollowedModuleLease, 'currentSource'>;
  sync: SyncEngine;
};

/** Keep one query intent while verified consumer generations and their record handles retire. */
export async function createProjectedRecordView<Item>(options: ProjectedRecordViewOptions<Item>): Promise<ExpandableRecordView<Item>> {
  const view = new ProjectedRecordView(options);
  await openView(view, [options.callerSignal, options.signal]);
  return view;
}

class ProjectedRecordView<Item> extends ObservedView<RecordViewState<Item>> implements ExpandableRecordView<Item> {
  private readonly _options: ProjectedRecordViewOptions<Item>;
  private readonly _closing = new Set<Promise<void>>();
  private _cleanupFailure?: { reason: unknown };
  private _generation?: { controller: AbortController; detach(): void; pendingView?: ExpandableRecordView<Item> };
  private _inner?: ExpandableRecordView<Item>;
  private _opening?: Promise<void>;
  private _unsubscribe?: () => void;

  public constructor(options: ProjectedRecordViewOptions<Item>) {
    super(Object.freeze({ status: 'loading', current: false, hasMore: false, records: Object.freeze([]) }),
      options.callerSignal, options.signal);
    this._options = options;
  }

  public open(): Promise<void> {
    this._unsubscribe = this._options.sync.on((event): void => this.handleEvent(event));
    this.requestMaterialization();
    return Promise.resolve();
  }

  public async refresh(): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>> {
    if (this._inner !== undefined) { return this._inner.refresh(); }
    const state = this.getSnapshot();
    this.publish(Object.freeze({ status: 'loading', current: false, hasMore: state.hasMore, records: state.records }));
    this.requestMaterialization();
    return this.ready();
  }

  public async loadMore(): Promise<void> {
    if (this._inner === undefined) { throw new ContextNotReadyError(); }
    await this._inner.loadMore();
  }

  protected async materialize(): Promise<void> {
    if (this._inner !== undefined || this.isClosed) { return; }
    const opening = Promise.resolve().then(() => this.openGeneration());
    this._opening = opening;
    try { await opening; }
    finally { if (this._opening === opening) { this._opening = undefined; } }
  }

  protected handleLifetimeAbort(reason: unknown, sessionEnded: boolean): void {
    if (sessionEnded) { this.fail(reason); }
  }

  protected async closeOwnedResources(): Promise<void> {
    this._unsubscribe?.();
    this.clearGeneration();
    await this._opening;
    await Promise.all(this._closing);
    if (this._cleanupFailure !== undefined) { throw this._cleanupFailure.reason; }
  }

  /** A missed root-retirement notification must not restart optional consumer recovery indefinitely. */
  private async verifyRootBeforeOpening(): Promise<boolean> {
    try {
      await whileSignalsActive(() => this._options.root.currentSource(),
        [this._closeController.signal, this._callerSignal, this._sessionSignal]);
    } catch (error: unknown) {
      if (!this.isClosed) { this.fail(error); }
      return false;
    }
    if (this.isClosed) { return false; }
    return true;
  }

  private async openGeneration(): Promise<void> {
    let attempted: NonNullable<typeof this._generation> | undefined;
    try {
      if (this.isClosed) { return; }
      if (!await this.verifyRootBeforeOpening() || this.isClosed) { return; }
      const generation = this._options.generation();
      const controller = new AbortController();
      const signal = combineAbortSignals(this._closeController.signal, this._callerSignal, this._sessionSignal, controller.signal)!;
      const retired = (): void => {
        if (this.isClosed || this._generation !== current) { return; }
        this.fail(new ContextNotReadyError(generation.signal.reason));
        this.clearGeneration();
        this.requestMaterialization();
      };
      const current: NonNullable<typeof this._generation> = {
        controller, detach: (): void => generation.signal.removeEventListener('abort', retired),
      };
      attempted = current;
      this._generation = current;
      generation.signal.addEventListener('abort', retired, { once: true });
      if (generation.signal.aborted) { retired(); return; }
      const opening = generation.open(signal).then(view => {
        current.pendingView = view;
        if (this.isClosed || this._generation !== current || signal.aborted) {
          current.pendingView = undefined;
          this.closeInner(view);
        }
        return view;
      });
      // A transport may finish after cancellation; its late view is closed above.
      void opening.catch((): void => {});
      const view = await whileSignalsActive(() => opening, [signal]);
      if (this.isClosed || this._generation !== current || signal.aborted) {
        this.closeInner(view);
        return;
      }
      current.pendingView = undefined;
      this._inner = view;
      const unsubscribe = view.subscribe(state => {
        if (this._generation === current) { this.publish(state); }
      });
      const detach = current.detach;
      current.detach = (): void => { detach(); unsubscribe(); };
      this.publish(view.getSnapshot());
    } catch (error: unknown) {
      if (this.isClosed || (attempted !== undefined && this._generation !== attempted)) { return; }
      if (!(error instanceof ContextNotReadyError)) { this.fail(error); }
      this.clearGeneration();
      if (this._sessionSignal?.aborted || error instanceof ContextRetiredError) {
        void this.close().catch((): void => {});
      }
    }
  }

  private clearGeneration(): void {
    const generation = this._generation;
    this._generation = undefined;
    generation?.detach();
    generation?.controller.abort();
    if (generation?.pendingView !== undefined) {
      this.closeInner(generation.pendingView);
      generation.pendingView = undefined;
    }
    const inner = this._inner;
    this._inner = undefined;
    if (inner !== undefined) { this.closeInner(inner); }
  }

  private closeInner(view: ExpandableRecordView<Item>): void {
    const closing = view.close().catch((error: unknown): void => { this._cleanupFailure ??= { reason: error }; })
      .finally((): void => { this._closing.delete(closing); });
    this._closing.add(closing);
  }

  private handleEvent(event: SyncEvent): void {
    const { source, module } = this._options;
    if (this.isClosed || event.tenantDid !== source.sourceDid || event.type === 'identity:registration-change'
      || event.type === 'dead-letter:change' || (event.contextId !== undefined && event.contextId !== source.contextId)) { return; }
    if (!syncEventCoversModule(event, module) && event.module !== source.rootModule) { return; }
    if (this._inner === undefined) { this.requestMaterialization(); }
  }

  private fail(cause: unknown): void {
    const state = this.getSnapshot();
    this.publish(Object.freeze({
      status  : 'error', current : false, hasMore : state.hasMore, records : state.records,
      error   : cause instanceof Error ? cause : new Error(String(cause)),
    }));
  }
}
