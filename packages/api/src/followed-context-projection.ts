import type { RecordExecutionContext } from './record-types.js';
import type { FollowedSyncProjection, FollowedSyncSource, SyncEngine, SyncEvent } from '@enbox/agent';

import { combineAbortSignals } from './view-opening.js';
import { followedContextChangeRetiresSource } from './followed-context-lifecycle.js';
import { ContextNotReadyError, ContextRetiredError } from './context-errors.js';
import { followedSyncProjectionEqual, followedSyncSourceActiveEqual, getFollowedSyncProjection, syncEventCoversModule } from '@enbox/agent';

type ReadinessOutcome = { ready: true } | { ready: false; error: unknown };

type ProjectionOptions = {
  module: string;
  onCapture(projection: FollowedSyncProjection, source: FollowedSyncSource): void | Promise<void>;
  signal?: AbortSignal;
  source: FollowedSyncSource;
  sync: SyncEngine;
};

/** @internal One lazily verified consumer binding beneath an existing root acceptance. */
export class FollowedContextProjection {
  public readonly signal: AbortSignal;
  private readonly _controller = new AbortController();
  private readonly _options: ProjectionOptions;
  private readonly _wakes = new Set<() => void>();
  private _captured?: FollowedSyncProjection;
  private _capturing?: Promise<void>;
  private _unsubscribe?: () => void;
  private _preparing?: Promise<FollowedSyncSource>;

  public constructor(options: ProjectionOptions) {
    this._options = options;
    this.signal = combineAbortSignals(options.signal, this._controller.signal)!;
  }

  /** Context routing is read only after assertActive has captured verified metadata. */
  public get executionContext(): RecordExecutionContext {
    const readModuleRole = (): string => {
      if (this._captured === undefined) { throw this.notReady(); }
      return this._captured.moduleRole;
    };
    const { module, source, sync } = this._options;
    return {
      assertActive               : (): Promise<void> => this.assertActive(),
      contextId                  : source.contextId,
      followedSourceAcceptanceId : source.acceptanceId,
      followedSourceId           : source.id,
      followedSourceModule       : source.module,
      invalidateReplica          : async (): Promise<void> => {
        await this.assertActive();
        const current = await this.sourceForProjection(this._captured!);
        await sync.markFollowedSourcePullPending(current, module);
      },
      get moduleRole(): string {
        return readModuleRole();
      },
      remoteEndpoint : source.remoteEndpoint,
      tenantDid      : source.sourceDid,
    };
  }

  /** Ordinary operations fail retryably until the optional module has been verified. */
  public async assertActive(): Promise<void> {
    this.start();
    let projection = await this.readCurrent();
    if (projection === undefined) {
      await this.prepare();
      projection = await this.readCurrent();
    }
    if (projection === undefined) { throw this.notReady(); }
    await this.capture(projection);
  }

  /** Observations wait on existing source/sync wakes, independently of the root view. */
  public async waitUntilReady(callerSignal?: AbortSignal): Promise<void> {
    this.start();
    const signal = combineAbortSignals(this.signal, callerSignal)!;
    signal.throwIfAborted();
    const outcome = await new Promise<ReadinessOutcome>((resolve): void => {
      let running = false;
      let requested = false;
      let finished = false;
      const finish = (result: ReadinessOutcome): void => {
        if (finished) { return; }
        finished = true;
        this._wakes.delete(check);
        signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const fail = (error: unknown): void => finish({ ready: false, error });
      const abort = (): void => fail(signal.reason);
      const check = (): void => {
        if (finished) { return; }
        if (running) { requested = true; return; }
        running = true;
        requested = false;
        void this.readCurrent().then(async (projection): Promise<void> => {
          if (projection !== undefined) { await this.capture(projection); finish({ ready: true }); }
        }).catch(fail).finally((): void => {
          running = false;
          if (requested) { check(); }
        });
      };
      this._wakes.add(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      check();
      void this.prepare().then(check, fail);
    });
    if (outcome.ready === false) { throw outcome.error; }
    signal.throwIfAborted();
  }

  private start(): void {
    this.signal.throwIfAborted();
    if (this._unsubscribe !== undefined) { return; }
    this._unsubscribe = this._options.sync.on((event): void => this.handleEvent(event));
    this.signal.addEventListener('abort', (): void => {
      this._unsubscribe?.();
      this._unsubscribe = undefined;
    }, { once: true });
  }

  private prepare(): Promise<FollowedSyncSource> {
    this._preparing ??= this._options.sync.ensureFollowedSourceModules(this._options.source, [this._options.module])
      .finally((): void => { this._preparing = undefined; });
    return this._preparing;
  }

  private async readSource(): Promise<FollowedSyncSource> {
    this.signal.throwIfAborted();
    const { source, sync } = this._options;
    const current = await sync.getFollowedSource(source.id);
    this.signal.throwIfAborted();
    if (current === undefined || !followedSyncSourceActiveEqual(source, current)) { throw this.retire(); }
    return current;
  }

  private async sourceForProjection(expected: FollowedSyncProjection): Promise<FollowedSyncSource> {
    const current = await this.readSource();
    const projection = getFollowedSyncProjection(current, this._options.module);
    if (projection === undefined || !followedSyncProjectionEqual(expected, projection)) {
      throw this.retire(new Error(`Context module '${this._options.module}' no longer has the captured verified projection.`));
    }
    return current;
  }

  private async readCurrent(): Promise<FollowedSyncProjection | undefined> {
    const current = this._captured === undefined ? await this.readSource() : await this.sourceForProjection(this._captured);
    return getFollowedSyncProjection(current, this._options.module);
  }

  private capture(projection: FollowedSyncProjection): Promise<void> {
    this.signal.throwIfAborted();
    if (this._captured !== undefined) { return Promise.resolve(); }
    this._capturing ??= (async (): Promise<void> => {
      const source = await this.sourceForProjection(projection);
      await this._options.onCapture(projection, source);
      const current = await this.readCurrent();
      if (current === undefined || !followedSyncProjectionEqual(projection, current)) {
        throw this.retire(new Error('The consumer projection changed while its representation was being verified.'));
      }
      this._captured = structuredClone(projection);
    })().finally((): void => { this._capturing = undefined; });
    return this._capturing;
  }

  private handleEvent(event: SyncEvent): void {
    const { source, module } = this._options;
    if (event.type === 'identity:registration-change' || event.type === 'dead-letter:change') { return; }
    if (event.tenantDid !== source.sourceDid || (event.contextId !== undefined && event.contextId !== source.contextId)) { return; }
    if (event.type === 'followed-context:change' && event.actorDid === source.actorDid && event.module === source.module) {
      if (followedContextChangeRetiresSource(source, event)) { this.retire(); return; }
      if (this._captured !== undefined && event.affectedModules?.includes(module)) {
        this.retire(new Error(`The verified projection for '${module}' changed.`));
        return;
      }
    } else if (!syncEventCoversModule(event, module)) {
      return;
    }
    if (this._captured !== undefined) {
      void this.readCurrent().catch((error: unknown): void => {
        // Metadata read failures do not revoke a captured offline projection.
        if (error instanceof ContextRetiredError) { this._controller.abort(error); }
      });
    }
    for (const wake of [...this._wakes]) { wake(); } // NOSONAR: S7747 - snapshot excludes waiters added by reentrant callbacks.
  }

  private notReady(): ContextNotReadyError {
    return new ContextNotReadyError(new Error(`Context module '${this._options.module}' has not been verified.`));
  }

  private retire(cause?: unknown): ContextRetiredError {
    const error = new ContextRetiredError(this._options.source.contextId, cause);
    this._controller.abort(error);
    return error;
  }
}
