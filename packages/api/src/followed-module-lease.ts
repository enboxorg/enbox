import type { RecordExecutionContext } from './record-types.js';
import type { FollowedModuleScope, FollowedSyncSource, SyncEngine, SyncEvent } from '@enbox/agent';

import { followedContextChangeRetiresSource } from './followed-context-lifecycle.js';
import { combineAbortSignals, whileSignalsActive } from './view-opening.js';
import { ContextNotReadyError, ContextRetiredError } from './context-errors.js';
import { followedModuleScopeEqual, followedSyncSourceActiveEqual, syncEventCoversModule } from '@enbox/agent';

type LeaseOptions = {
  module: string;
  source: FollowedSyncSource;
  sync: SyncEngine;
  signal: AbortSignal;
  root?: FollowedModuleLease;
  onCapture?(scope: FollowedModuleScope, source: FollowedSyncSource): void | Promise<void>;
};

/** One captured module scope, fenced by its root acceptance and the owning session. */
export class FollowedModuleLease {
  public readonly signal: AbortSignal;
  private readonly _controller = new AbortController();
  private _scope?: FollowedModuleScope;
  private _capturing?: Promise<void>;
  private _unsubscribe?: () => void;

  public constructor(private readonly _options: LeaseOptions) {
    this.signal = combineAbortSignals(_options.root?.signal, _options.signal, this._controller.signal)!;
    if (_options.module === _options.source.rootModule) { this._scope = structuredClone(_options.source.modules[_options.module]!); }
  }

  public executionContext(invokeRole = true): RecordExecutionContext {
    const role = (): string | undefined => {
      if (!invokeRole) { return undefined; }
      if (this._scope === undefined) { throw new ContextNotReadyError(); }
      return this._scope.moduleRole;
    };
    const { source } = this._options;
    return {
      assertActive      : invokeRole ? (): Promise<void> => this.assertActive() : async (): Promise<void> => { await this.currentSource(); },
      contextId         : source.contextId,
      followedSourceId  : invokeRole ? source.id : undefined,
      invalidateReplica : async (): Promise<void> => {
        const current = await this.assertScope();
        await this._options.sync.markFollowedSourcePullPending(current, this._options.module);
      },
      get moduleRole(): string | undefined { return role(); },
      remoteEndpoint : source.remoteEndpoint,
      tenantDid      : source.sourceDid,
    };
  }

  public async currentSource(): Promise<FollowedSyncSource> {
    this.start();
    const { root, source, sync } = this._options;
    const current = await whileSignalsActive(
      () => root === undefined ? sync.getFollowedSource(source.id) : root.currentSource(), [this.signal]);
    if (current === undefined || !followedSyncSourceActiveEqual(this._options.source, current)) { throw this.retire(); }
    return current;
  }

  public async assertActive(): Promise<void> { await this.assertScope(); }

  public async refresh(): Promise<void> {
    const current = await this.assertScope();
    try {
      if (!await this._options.sync.pullFollowedSource(current, this._options.module)) {
        throw new ContextNotReadyError(new Error('Replication did not reach the feed head for the selected module.'));
      }
    } catch (error) {
      await this.assertScope();
      throw error instanceof ContextNotReadyError ? error : new ContextNotReadyError(error);
    }
    await this.assertScope();
  }

  private async assertScope(): Promise<FollowedSyncSource> {
    const current = await this.currentSource();
    const scope = current.modules[this._options.module];
    if (this._scope !== undefined && (scope === undefined || scope === null || !followedModuleScopeEqual(this._scope, scope))) {
      throw this.retire();
    }
    if (scope === undefined || scope === null) { throw new ContextNotReadyError(); }
    if (this._scope === undefined) {
      this._capturing ??= (async (): Promise<void> => {
        await this._options.onCapture?.(scope, current);
        const latest = await this.currentSource();
        const accepted = latest.modules[this._options.module];
        if (accepted === undefined || accepted === null || !followedModuleScopeEqual(scope, accepted)) { throw this.retire(); }
        this._scope = structuredClone(scope);
      })().finally(() => { this._capturing = undefined; });
      await whileSignalsActive(() => this._capturing!, [this.signal]);
    }
    return current;
  }

  private start(): void {
    this.signal.throwIfAborted();
    if (this._unsubscribe !== undefined) { return; }
    this._unsubscribe = this._options.sync.on(event => this.handleEvent(event));
    this.signal.addEventListener('abort', () => { this._unsubscribe?.(); this._unsubscribe = undefined; }, { once: true });
  }

  private handleEvent(event: SyncEvent): void {
    const { source, module, root } = this._options;
    if (event.type === 'identity:registration-change' || event.type === 'dead-letter:change' || event.tenantDid !== source.sourceDid
      || (event.contextId !== undefined && event.contextId !== source.contextId)) { return; }
    if (event.type === 'followed-context:change' && event.actorDid === source.actorDid && event.module === source.rootModule) {
      if (root === undefined && followedContextChangeRetiresSource(source, event)) { this.retire(); return; }
      if (this._scope !== undefined && event.affectedModules?.includes(module)) { this.retire(); return; }
    } else if (!syncEventCoversModule(event, module)) { return; }
    if (this._scope !== undefined) { void this.assertScope().catch(() => {}); }
  }

  private retire(): ContextRetiredError {
    const error = new ContextRetiredError(this._options.source.contextId);
    this._controller.abort(error);
    return error;
  }
}
