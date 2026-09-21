import type { AbstractLevel } from 'abstract-level';
import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type {
  DeadLetterEntry,
  ReplicationLinkSnapshot,
  StartSyncParams,
  SyncConnectivityState,
  SyncDirection,
  SyncDrainOptions,
  SyncDrainResult,
  SyncDrainTargetResult,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
  SyncHealthSummary,
  SyncIdentityOptions,
  SyncIdentityStatus,
  SyncLifecycleOptions,
  SyncRunOptions,
} from '../types/sync.js';
import type { FollowedSyncSource, FollowedSyncSourceInput } from '../followed-sync-source.js';

import { AgentPermissionsApi } from '../permissions-api.js';
import { buildLinkKey } from '../sync-link-key.js';
import { FollowedSyncSourceStoreLevel } from '../followed-sync-source-store-level.js';
import { Level } from 'level';
import { openSyncNextSubscriptions } from './subscriptions.js';
import { SyncEchoSuppressor } from '../sync-echo-suppressor.js';
import { SyncEndpointStoreLevel } from '../sync-endpoint-store-level.js';
import { SyncEngineLevel } from '../sync-engine-level.js';
import { SyncIdentityStoreLevel } from '../sync-identity-store-level.js';
import { SyncNextDeliveryRetry } from './delivery-retry.js';
import { SyncNextLedgerStore } from './ledger-store.js';
import { SyncNextLinkSession } from './link-session.js';
import { SyncNextPullPage } from './pull-page.js';
import { SyncNextPushPage } from './push-page.js';
import { SyncNextQuarantineRetry } from './quarantine-retry.js';
import { SyncTargetPlanner } from '../sync-target-planner.js';
import { MAX_TIMER_DELAY_MS, parseDurationInMilliseconds } from '@enbox/common';
import {
  messageFeedFiltersForSyncScope,
  normalizeSyncProtocols,
  projectReplicationCurrentness,
  syncEventScope,
} from '../types/sync.js';
import { normalizeDwnEndpoint, SyncTargetResolver } from '../sync-target-resolver.js';
import { queryLocalMessageFeed, queryRemoteMessageFeed, syncMessageDescriptor } from '../sync-messages.js';

type LevelKey = string | Buffer | Uint8Array;

export type SyncEngineNextParams = {
  dataPath?: string;
  db?: AbstractLevel<LevelKey>;
};

type ActiveSession = {
  session: SyncNextLinkSession;
  subscribed: boolean;
  target: SyncTarget;
};

type MergedSyncRunRequest = {
  direction?: SyncDirection;
  directionConflict: boolean;
  did?: string;
  unscoped: boolean;
  verifyConvergence: boolean;
};

type PendingSyncRun = {
  cancelled: boolean;
  merged: MergedSyncRunRequest;
  promise: Promise<void>;
};

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Temporary selectable façade for the isolated next-engine implementation. */
export class SyncEngineNext implements SyncEngine {
  private _agent?: EnboxPlatformAgent;
  private readonly _control: SyncEngineLevel;
  private readonly _db: AbstractLevel<LevelKey>;
  private readonly _echoSuppressor = new SyncEchoSuppressor();
  private readonly _endpointStore: SyncEndpointStoreLevel;
  private readonly _eventListeners = new Set<SyncEventListener>();
  private readonly _identityStore: SyncIdentityStoreLevel;
  private readonly _ledger: SyncNextLedgerStore;
  private _live = false;
  private readonly _pausedIdentities = new Map<string, string>();
  private _permissionsApi?: AgentPermissionsApi;
  private readonly _planner: SyncTargetPlanner;
  private _oneShotActive = false;
  private _pendingSyncRun?: PendingSyncRun;
  private _resolver?: SyncTargetResolver;
  private _runtimeGeneration = 0;
  private _runtimeTransitionDepth = 0;
  private readonly _sessions = new Map<string, ActiveSession>();
  private readonly _sourceStore: FollowedSyncSourceStoreLevel;
  private _syncTail: Promise<unknown> = Promise.resolve();
  private _timer?: ReturnType<typeof setInterval>;
  private _transition: Promise<void> = Promise.resolve();

  public constructor({ dataPath, db }: SyncEngineNextParams = {}) {
    this._db = db ?? new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
    this._control = new SyncEngineLevel({ db: this._db });
    this._endpointStore = new SyncEndpointStoreLevel(this._db);
    this._identityStore = new SyncIdentityStoreLevel(this._db);
    this._ledger = new SyncNextLedgerStore(this._db, dataPath ?? 'default');
    this._sourceStore = new FollowedSyncSourceStoreLevel(this._db);
    this._planner = new SyncTargetPlanner({
      getTargetResolver          : (): SyncTargetResolver => this.targetResolver,
      handleAuthorizationFailure : async (): Promise<boolean> => false,
      identityStore              : this._identityStore,
      isIdentityPaused           : (did, delegateDid): boolean =>
        delegateDid !== undefined && this._pausedIdentities.get(did) === delegateDid,
      sourceStore : this._sourceStore,
      warn        : (message, error): void => { console.warn(message, error); },
    });
  }

  public get agent(): EnboxPlatformAgent {
    if (this._agent === undefined) {
      throw new Error('SyncEngineNext: agent is not set.');
    }
    return this._agent;
  }

  public set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
    this._control.agent = agent;
    this._permissionsApi = new AgentPermissionsApi({ agent });
    this._resolver = new SyncTargetResolver({
      endpointStore        : this._endpointStore,
      getEndpointDiscovery : (): EnboxPlatformAgent['dwn'] => this.agent.dwn,
      permissionsApi       : this._permissionsApi,
    });
  }

  public get connectivityState(): SyncConnectivityState {
    if (this._sessions.size === 0) {
      return 'unknown';
    }
    return [...this._sessions.values()].some(({ session }) => session.isOnline)
      ? 'online'
      : 'offline';
  }

  public get hasActiveSubscriptions(): boolean {
    return [...this._sessions.values()].some(({ subscribed }) => subscribed);
  }

  public async setIdentityOptions(
    { did, options }: { did: string; options: SyncIdentityOptions },
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    const normalized = SyncEngineNext.normalizeOptions(options);
    await this._control.setIdentityOptions({ did, options: normalized }, lifecycleOptions);
    this._pausedIdentities.delete(did);
    this._planner.invalidate();
    this.emit({ type: 'identity:registration-change', tenantDid: did, options: normalized });
    await this.refreshLiveTargets();
  }

  public async ensureIdentityOptions(
    params: { did: string; options: SyncIdentityOptions },
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<boolean> {
    const normalized = SyncEngineNext.normalizeOptions(params.options);
    const changed = await this._control.ensureIdentityOptions({
      did     : params.did,
      options : normalized,
    }, lifecycleOptions);
    if (!changed) {
      return false;
    }
    this._pausedIdentities.delete(params.did);
    this._planner.invalidate();
    this.emit({ type: 'identity:registration-change', tenantDid: params.did, options: normalized });
    await this.refreshLiveTargets();
    return true;
  }

  public async refreshIdentityRouting(
    did: string,
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    if (await this._identityStore.get(did) === undefined) {
      return;
    }
    await this._control.refreshIdentityRouting(did, lifecycleOptions);
    this._planner.invalidate();
    await this.refreshLiveTargets();
  }

  public async pauseIdentity(params: {
    did: string;
    delegateDid: string;
    connectSessionId: string;
  }): Promise<boolean> {
    const paused = await this._control.pauseIdentity(params);
    if (!paused) {
      return false;
    }
    this._pausedIdentities.set(params.did, params.delegateDid);
    for (const link of await this._ledger.getLinksForTenant(params.did)) {
      if (link.delegateDid === params.delegateDid) {
        await this._ledger.setLinkStatus(link, 'authorization-paused');
        await this.disposeSession(link);
      }
    }
    this._planner.invalidate();
    return true;
  }

  public async removeIdentity(
    did: string,
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    await this._control.removeIdentity(did, lifecycleOptions);
    this._pausedIdentities.delete(did);
    for (const [key, active] of this._sessions) {
      if (active.target.did === did) {
        await active.session.dispose();
        this._sessions.delete(key);
      }
    }
    await this._ledger.deleteForTenant(did);
    this._planner.invalidate();
    this.emit({ type: 'identity:registration-change', tenantDid: did });
  }

  public getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined> {
    return this._identityStore.get(did);
  }

  public async followSource(source: FollowedSyncSourceInput): Promise<FollowedSyncSource> {
    const followed = await this._control.followSource(source);
    this._planner.invalidate();
    await this.refreshLiveTargets();
    return followed;
  }

  public getFollowedSource(id: string): Promise<FollowedSyncSource | undefined> {
    return this._sourceStore.get(id);
  }

  public async listFollowedSources(): Promise<FollowedSyncSource[]> {
    return (await this._sourceStore.list()).flatMap(entry => entry.status === 'valid' ? [entry.source] : []);
  }

  public async deleteFollowedSource(source: FollowedSyncSource): Promise<void> {
    const identity = await this._identityStore.get(source.actorDid);
    const target = await this.targetResolver.buildTargetForSource(source, identity?.delegateDid);
    await this.disposeSession(target);
    await this._ledger.deleteLinkAndSparse({
      authorizationEpoch : target.authorizationEpoch,
      projectionId       : target.projectionId,
      remoteEndpoint     : target.dwnUrl,
      tenantDid          : target.did,
    });
    await this._sourceStore.delete(source.id);
    this._planner.invalidate();
    await this.refreshLiveTargets();
  }

  public async markFollowedSourcePullPending(source: FollowedSyncSource): Promise<boolean> {
    const current = await this._sourceStore.get(source.id);
    if (current?.acceptanceId !== source.acceptanceId) {
      return false;
    }
    for (const active of this._sessions.values()) {
      if (
        active.target.authorization.kind === 'role' &&
        active.target.authorization.roleRecordId === source.id
      ) {
        active.session.requestPull();
      }
    }
    return true;
  }

  public async pullFollowedSource(source: FollowedSyncSource): Promise<boolean> {
    const identity = await this._identityStore.get(source.actorDid);
    if (identity === undefined) {
      return false;
    }
    const target = await this.targetResolver.buildTargetForSource(source, identity.delegateDid);
    const active = await this.ensureSession(target);
    try {
      await active.session.cover('pull');
      return true;
    } catch {
      return false;
    } finally {
      if (!this._live) {
        await this.disposeSession(target);
      }
    }
  }

  public sync(direction?: SyncDirection, options: SyncRunOptions = {}): Promise<void> {
    if (this._runtimeTransitionDepth > 0) {
      return Promise.reject(new Error('SyncEngineNext: sync run cancelled by a runtime transition.'));
    }
    if (this._oneShotActive || this._pendingSyncRun !== undefined) {
      return this.joinPendingSyncRun(direction, options);
    }
    return this.runOneShot((): Promise<void> => this.runCoveringSync(direction, options));
  }

  public async drainTo(endpoint: string, options: SyncDrainOptions = {}): Promise<SyncDrainResult> {
    const normalizedEndpoint = normalizeDwnEndpoint(endpoint);
    if (isSignalAborted(options.signal)) {
      return {
        endpoint        : normalizedEndpoint,
        completed       : false,
        cancelled       : true,
        topologyChanged : false,
        targets         : [],
        error           : 'drain aborted',
      };
    }
    if (this._runtimeTransitionDepth > 0) {
      throw new Error('SyncEngineNext: drain cancelled by a runtime transition.');
    }
    if (this._oneShotActive || this._pendingSyncRun !== undefined) {
      throw new Error('SyncEngineNext: Sync operation is already in progress.');
    }
    return this.runOneShot((): Promise<SyncDrainResult> => this.runDrain(normalizedEndpoint, options));
  }

  public async startSync(params: StartSyncParams = {}): Promise<void> {
    const interval = Math.min(
      Math.max(parseDurationInMilliseconds(params.interval ?? '5m'), 1_000),
      MAX_TIMER_DELAY_MS,
    );
    await this.runRuntimeTransition(async (): Promise<void> => {
      await this.stopRuntime();
      this._live = true;
      try {
        await this.refreshLiveTargets(true);
        this._timer = setInterval((): void => {
          for (const { session } of this._sessions.values()) {
            session.start();
          }
        }, interval);
      } catch (error: unknown) {
        await this.stopRuntime();
        throw error;
      }
    });
  }

  public stopSync(timeout = 2_000): Promise<void> {
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMER_DELAY_MS) {
      return Promise.reject(new RangeError(
        `SyncEngineNext: stop timeout must be between 0 and ${MAX_TIMER_DELAY_MS} milliseconds.`,
      ));
    }
    return SyncEngineNext.withTimeout(
      this.runRuntimeTransition((): Promise<void> => this.stopRuntime()),
      timeout,
      `SyncEngineNext: sync runtime did not stop within ${timeout} milliseconds.`,
    );
  }

  public on(listener: SyncEventListener): () => void {
    this._eventListeners.add(listener);
    return (): void => { this._eventListeners.delete(listener); };
  }

  public async close(options: SyncLifecycleOptions = {}): Promise<void> {
    await this.stopSync(options.timeout ?? 2_000);
    await this._control.close();
  }

  public async getDeadLetters(tenantDid?: string): Promise<DeadLetterEntry[]> {
    return (await this._ledger.getAllTerminal())
      .filter(entry => tenantDid === undefined || entry.tenantDid === tenantDid)
      .map(entry => ({
        errorCode      : entry.code,
        errorDetail    : entry.detail ?? entry.code,
        failedAt       : entry.failedAt,
        messageCid     : entry.messageCid,
        remoteEndpoint : entry.remoteEndpoint,
        tenantDid      : entry.tenantDid,
      }))
      .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
  }

  public async getSyncHealth(): Promise<SyncHealthSummary> {
    return this.readHealth();
  }

  public async getIdentitySyncStatus(tenantDid: string): Promise<SyncIdentityStatus> {
    const [delivery, health, links, registration, terminal] = await Promise.all([
      this._ledger.getAllDelivery(),
      this.readHealth(tenantDid),
      this.getReplicationLinks(tenantDid),
      this.getIdentityOptions(tenantDid),
      this._ledger.getAllTerminal(),
    ]);
    const remotes = [...new Set(links.map(link => link.remoteEndpoint))].map(remoteEndpoint => {
      const remoteLinks = links.filter(link => link.remoteEndpoint === remoteEndpoint);
      const failedMessageCount = terminal.filter(entry =>
        entry.tenantDid === tenantDid && entry.remoteEndpoint === remoteEndpoint
      ).length;
      const quotaBlockedMessageCount = delivery.filter(entry =>
        entry.tenantDid === tenantDid &&
        entry.remoteEndpoint === remoteEndpoint &&
        entry.outcome.reason === 'quota'
      ).length;
      const connectivity = remoteLinks.find(link => link.connectivity === 'online')?.connectivity ?? 'unknown';
      const degraded = failedMessageCount > 0 || remoteLinks.some(link => link.status === 'paused');
      return {
        connectivity,
        failedMessageCount,
        quotaBlockedMessageCount,
        remoteEndpoint,
        state: connectivity === 'offline'
          ? 'offline' as const
          : quotaBlockedMessageCount > 0
            ? 'quota-blocked' as const
            : degraded ? 'degraded' as const : 'healthy' as const,
        tenantDid,
      };
    });
    return {
      connectivity : links.some(link => link.connectivity === 'online') ? 'online' : this.connectivityState,
      currentness  : projectReplicationCurrentness(links),
      health,
      links,
      registration,
      remotes,
    };
  }

  public async getReplicationLinks(tenantDid?: string): Promise<ReplicationLinkSnapshot[]> {
    const links = tenantDid === undefined
      ? await this._ledger.getAllLinks()
      : await this._ledger.getLinksForTenant(tenantDid);
    return links.map(link => {
      const active = this._sessions.get(buildLinkKey(
        link.tenantDid,
        link.remoteEndpoint,
        link.projectionId,
        link.authorizationEpoch,
      ));
      return {
        connectivity     : active === undefined ? 'unknown' : active.session.isOnline ? 'online' : 'offline',
        delegateDid      : link.delegateDid,
        followedSourceId : link.authorization.kind === 'role' ? link.authorization.roleRecordId : undefined,
        isPullCurrent    : active?.session.isPullCurrent ?? false,
        lastActivityAt   : link.updatedAt,
        pullPosition     : link.pullHandledThrough?.position,
        pushPosition     : link.pushHandledThrough?.position,
        remoteEndpoint   : link.remoteEndpoint,
        scope            : link.scope,
        status           : link.status === 'authorization-paused' ? 'paused' : active === undefined ? 'initializing' : 'live',
        tenantDid        : link.tenantDid,
      };
    });
  }

  public async retryRemoteNow(tenantDid: string, remoteEndpoint: string): Promise<void> {
    const normalizedEndpoint = normalizeDwnEndpoint(remoteEndpoint);
    const targets = (await this._planner.getTargets()).filter(target =>
      target.did === tenantDid && normalizeDwnEndpoint(target.dwnUrl) === normalizedEndpoint
    );
    const outcomes: PromiseSettledResult<void>[] = [];
    try {
      const active = await Promise.all(targets.map(target => this.ensureSession(target)));
      outcomes.push(
        ...await this.settleCovers(active, 'pull'),
        ...await this.settleCovers(active, 'push'),
      );
    } finally {
      if (!this._live) {
        await Promise.allSettled(targets.map(target => this.disposeSession(target)));
      }
    }
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason), 'SyncEngineNext: retry failed.');
    }
  }

  private get targetResolver(): SyncTargetResolver {
    if (this._resolver === undefined) {
      throw new Error('SyncEngineNext: agent is not set.');
    }
    return this._resolver;
  }

  private async runDrain(endpoint: string, options: SyncDrainOptions): Promise<SyncDrainResult> {
    const runtimeGeneration = this._runtimeGeneration;
    await this._endpointStore.set(endpoint);
    this._planner.invalidate();
    const topologyGeneration = this._planner.topologyGeneration;
    const planned = (await this._planner.getTargets()).filter(target =>
      normalizeDwnEndpoint(target.dwnUrl) === endpoint
    );
    const planComplete = this._planner.lastResolutionComplete;

    try {
      const active = await Promise.all(planned.map(target => this.ensureSession(target)));
      const shouldContinue = (): boolean => !isSignalAborted(options.signal) &&
        runtimeGeneration === this._runtimeGeneration &&
        topologyGeneration === this._planner.topologyGeneration;
      const pullOutcomes = await this.settleCovers(active, 'pull', shouldContinue);
      const stopAfterPull = isSignalAborted(options.signal) ||
        topologyGeneration !== this._planner.topologyGeneration;
      const pushOutcomes = stopAfterPull
        ? SyncEngineNext.rejectedOutcomes(
          active.length,
          options.signal?.reason ?? new Error('SyncEngineNext: drain topology changed.'),
        )
        : await this.settleCovers(active, 'push', shouldContinue);
      const targetOutcomes = await this.settleByEndpoint(
        planned.map((target, index) => ({ index, target })),
        ({ index, target }): Promise<SyncDrainTargetResult> => this.drainTarget(
          target,
          pullOutcomes[index],
          pushOutcomes[index],
          runtimeGeneration,
          topologyGeneration,
          options,
        ),
      );
      const targets = targetOutcomes.map((outcome, index): SyncDrainTargetResult => outcome.status === 'fulfilled'
        ? outcome.value
        : {
          cancelled      : isSignalAborted(options.signal),
          completed      : false,
          converged      : false,
          error          : outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          remoteEndpoint : planned[index].dwnUrl,
          scope          : planned[index].scope,
          tenantDid      : planned[index].did,
        });
      const cancelled = isSignalAborted(options.signal);
      const runtimeChanged = runtimeGeneration !== this._runtimeGeneration;
      const topologyChanged = topologyGeneration !== this._planner.topologyGeneration;
      const completed = targets.length > 0 &&
        targets.every(target => target.completed) &&
        planComplete &&
        !cancelled &&
        !runtimeChanged &&
        !topologyChanged;
      const error = cancelled
        ? 'drain aborted'
        : runtimeChanged
          ? 'sync runtime changed during drain'
          : topologyChanged
            ? 'sync topology changed during drain'
            : !planComplete
              ? 'sync target plan was incomplete during drain'
              : targets.some(target => !target.completed)
                ? 'one or more drain targets are incomplete'
                : undefined;
      return {
        endpoint,
        completed,
        cancelled,
        topologyChanged,
        targets,
        ...(error === undefined ? {} : { error }),
      };
    } finally {
      if (!this._live) {
        await Promise.allSettled(planned.map(target => this.disposeSession(target)));
      }
    }
  }

  private async drainTarget(
    target: SyncTarget,
    pullOutcome: PromiseSettledResult<void>,
    pushOutcome: PromiseSettledResult<void>,
    runtimeGeneration: number,
    topologyGeneration: number,
    options: SyncDrainOptions,
  ): Promise<SyncDrainTargetResult> {
    const link = await this._ledger.getLink({
      authorizationEpoch : target.authorizationEpoch,
      projectionId       : target.projectionId,
      remoteEndpoint     : target.dwnUrl,
      tenantDid          : target.did,
    });
    if (link === undefined) {
      return {
        cancelled      : isSignalAborted(options.signal),
        completed      : false,
        converged      : false,
        error          : 'durable link disappeared during drain',
        remoteEndpoint : target.dwnUrl,
        scope          : target.scope,
        tenantDid      : target.did,
      };
    }

    let convergence: {
      converged: boolean;
      error?: string;
      localFingerprint?: string;
      remoteFingerprint?: string;
    };
    const transferError = [pullOutcome, pushOutcome]
      .find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')?.reason;
    try {
      if (transferError !== undefined) {
        throw transferError;
      }
      if (isSignalAborted(options.signal)) {
        throw options.signal?.reason ?? new DOMException('Drain cancelled.', 'AbortError');
      }
      if (runtimeGeneration !== this._runtimeGeneration) {
        throw new Error('SyncEngineNext: sync runtime changed during drain.');
      }
      if (topologyGeneration !== this._planner.topologyGeneration) {
        throw new Error('SyncEngineNext: drain topology changed.');
      }
      convergence = await this.verifyStableConvergence(
        target,
        (): boolean => !isSignalAborted(options.signal) &&
          runtimeGeneration === this._runtimeGeneration &&
          topologyGeneration === this._planner.topologyGeneration,
      );
    } catch (error: unknown) {
      convergence = { converged: false, error: error instanceof Error ? error.message : String(error) };
    }
    const [delivery, quarantine] = await Promise.all([
      this._ledger.getDeliveryForLink(link),
      this._ledger.getQuarantineForLink(link),
    ]);
    const cancelled = isSignalAborted(options.signal);
    const runtimeChanged = runtimeGeneration !== this._runtimeGeneration;
    const topologyChanged = topologyGeneration !== this._planner.topologyGeneration;
    const completed = convergence.converged &&
      delivery.length === 0 &&
      quarantine.length === 0 &&
      !cancelled &&
      !runtimeChanged &&
      !topologyChanged;
    return {
      cancelled,
      completed,
      converged         : convergence.converged,
      error             : convergence.error,
      localFingerprint  : convergence.localFingerprint,
      pushCheckpoint    : link.pushHandledThrough,
      remoteEndpoint    : link.remoteEndpoint,
      remoteFingerprint : convergence.remoteFingerprint,
      scope             : link.scope,
      tenantDid         : link.tenantDid,
    };
  }

  private runOneShot<T>(operation: () => Promise<T>): Promise<T> {
    this._oneShotActive = true;
    const active = (async (): Promise<T> => {
      try {
        return await operation();
      } finally {
        this._oneShotActive = false;
      }
    })();
    this._syncTail = active.catch((): void => {});
    return active;
  }

  private joinPendingSyncRun(direction: SyncDirection | undefined, options: SyncRunOptions): Promise<void> {
    if (this._pendingSyncRun !== undefined) {
      SyncEngineNext.mergeSyncRunRequest(this._pendingSyncRun.merged, direction, options);
      return this._pendingSyncRun.promise;
    }

    const merged: MergedSyncRunRequest = {
      direction,
      directionConflict : false,
      did               : options.did,
      unscoped          : options.did === undefined,
      verifyConvergence : options.verifyConvergence === true,
    };
    const pending: PendingSyncRun = { cancelled: false, merged, promise: Promise.resolve() };
    pending.promise = this._syncTail.then(async (): Promise<void> => {
      if (this._pendingSyncRun === pending) {
        this._pendingSyncRun = undefined;
      }
      if (pending.cancelled) {
        throw new Error('SyncEngineNext: queued sync run was cancelled by a runtime transition.');
      }
      await this.runOneShot((): Promise<void> => this.runCoveringSync(
        merged.directionConflict ? undefined : merged.direction,
        {
          ...(merged.unscoped || merged.did === undefined ? {} : { did: merged.did }),
          ...(merged.verifyConvergence ? { verifyConvergence: true } : {}),
        },
      ));
    });
    this._pendingSyncRun = pending;
    this._syncTail = pending.promise.catch((): void => {});
    return pending.promise;
  }

  private static mergeSyncRunRequest(
    merged: MergedSyncRunRequest,
    direction: SyncDirection | undefined,
    options: SyncRunOptions,
  ): void {
    if (merged.direction !== direction) {
      merged.directionConflict = true;
    }
    if (options.did === undefined || (merged.did !== undefined && merged.did !== options.did)) {
      merged.unscoped = true;
    } else {
      merged.did = options.did;
    }
    merged.verifyConvergence ||= options.verifyConvergence === true;
  }

  private async runCoveringSync(direction: SyncDirection | undefined, options: SyncRunOptions): Promise<void> {
    const runtimeGeneration = this._runtimeGeneration;
    if (options.did !== undefined && await this._identityStore.get(options.did) === undefined) {
      throw new Error(`SyncEngineNext: identity '${options.did}' is not registered.`);
    }
    const allTargets = await this._planner.getTargets();
    const shouldContinue = (): boolean => runtimeGeneration === this._runtimeGeneration;
    if (!shouldContinue()) {
      throw new Error('SyncEngineNext: sync run cancelled by a runtime transition.');
    }
    await this.pruneSupersededLinks(allTargets);
    const targets = allTargets.filter(target =>
      options.did === undefined || SyncEngineNext.targetBelongsToIdentity(target, options.did)
    );
    const outcomes: PromiseSettledResult<void>[] = [];
    try {
      const sessions = await Promise.all(targets.map(target => this.ensureSession(target)));
      outcomes.push(...direction === undefined
        ? [
          ...await this.settleCovers(sessions, 'pull', shouldContinue),
          ...await this.settleCovers(sessions, 'push', shouldContinue),
        ]
        : await this.settleCovers(sessions, direction, shouldContinue));
      const transferFailed = outcomes.some(outcome => outcome.status === 'rejected');
      if (options.verifyConvergence === true && !transferFailed) {
        outcomes.push(...await this.settleByEndpoint(
          targets.map(target => ({ target })),
          async ({ target }): Promise<void> => {
            if (!shouldContinue()) {
              throw new Error('SyncEngineNext: convergence proof cancelled by a runtime transition.');
            }
            const convergence = await this.verifyStableConvergence(target, shouldContinue);
            if (!convergence.converged) {
              throw new Error(convergence.error ?? 'SyncEngineNext: feed fingerprints did not converge.');
            }
          },
        ));
      }
    } finally {
      if (!this._live) {
        await Promise.allSettled(targets.map(target => this.disposeSession(target)));
      }
    }
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason), 'SyncEngineNext: covering sync failed.');
    }
  }

  private async refreshLiveTargets(initialCover = false): Promise<void> {
    if (!this._live) {
      return;
    }
    const targets = await this._planner.getTargets();
    await this.pruneSupersededLinks(targets);
    const active = await Promise.all(targets.map(target => this.ensureSession(target)));
    await Promise.allSettled(active.map(async (item): Promise<void> => {
      if (!item.subscribed) {
        try {
          await openSyncNextSubscriptions(this.agent, this.targetResolver, item.target, item.session);
          item.subscribed = true;
        } catch (error: unknown) {
          console.error('SyncEngineNext: subscription establishment failed', error);
        }
      }
    }));
    if (initialCover) {
      await this.settleCovers(active, 'pull');
      await this.settleCovers(active, 'push');
    }
    for (const { session } of active) {
      session.start();
    }
  }

  private async ensureSession(target: SyncTarget): Promise<ActiveSession> {
    const key = SyncEngineNext.targetKey(target);
    const existing = this._sessions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    await this._ledger.getOrCreateLink({
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      delegateDid        : target.delegateDid,
      logicalTargetId    : `${target.did}^${target.projectionId}`,
      projectionId       : target.projectionId,
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      tenantDid          : target.did,
    });
    const pullPage = new SyncNextPullPage(this.agent, this._ledger, this._echoSuppressor, {
      onApplied    : (pullTarget, entries): void => this.emitApplied(pullTarget, entries),
      onCheckpoint : (pullTarget, token): void => {
        this.emit({
          type           : 'checkpoint:pull-advance',
          tenantDid      : pullTarget.did,
          remoteEndpoint : pullTarget.dwnUrl,
          ...syncEventScope(pullTarget.scope),
          position       : token.position,
          ...(token.messageCid === undefined ? {} : { messageCid: token.messageCid }),
        });
      },
    });
    const pushPage = new SyncNextPushPage(this.agent, this._ledger, this._echoSuppressor, {
      onCheckpoint: (pushTarget, token): void => {
        this.emit({
          type           : 'checkpoint:push-advance',
          tenantDid      : pushTarget.did,
          remoteEndpoint : pushTarget.dwnUrl,
          ...syncEventScope(pushTarget.scope),
          position       : token.position,
          ...(token.messageCid === undefined ? {} : { messageCid: token.messageCid }),
        });
      },
    });
    const active: ActiveSession = {
      session: new SyncNextLinkSession(
        target,
        this._ledger,
        pullPage,
        pushPage,
        new SyncNextQuarantineRetry(
          this.agent,
          this._ledger,
          (pullTarget, entries): void => this.emitApplied(pullTarget, entries),
        ),
        new SyncNextDeliveryRetry(this.agent, this._ledger),
        (error): void => { console.error('SyncEngineNext: link work failed', error); },
      ),
      subscribed: false,
      target,
    };
    this._sessions.set(key, active);
    return active;
  }

  private async verifyConvergence(target: SyncTarget): Promise<{
    converged: boolean;
    localFingerprint?: string;
    remoteFingerprint?: string;
  }> {
    const current = await this.targetResolver.withCurrentRoleGrant(target);
    const role = current.authorization.kind === 'role' ? current.authorization : undefined;
    const params = {
      agent              : this.agent,
      authorDid          : role?.actorDid,
      cidsOnly           : true,
      delegateDid        : current.delegateDid,
      delegatedGrant     : current.authorDelegatedGrant,
      did                : current.did,
      filters            : messageFeedFiltersForSyncScope(current.scope),
      limit              : 1,
      permissionGrantIds : current.permissionGrantIds,
      protocolRole       : role?.protocolRole,
    };
    const [local, remote] = await Promise.all([
      queryLocalMessageFeed(params),
      queryRemoteMessageFeed({ ...params, dwnUrl: current.dwnUrl }),
    ]);
    if (local.status.code !== 200 || remote.status.code !== 200) {
      throw new Error(
        `SyncEngineNext: convergence query failed: local ${local.status.code}, remote ${remote.status.code}.`,
      );
    }
    return {
      converged         : local.fingerprint !== undefined && local.fingerprint === remote.fingerprint,
      localFingerprint  : local.fingerprint,
      remoteFingerprint : remote.fingerprint,
    };
  }

  private async verifyStableConvergence(
    target: SyncTarget,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<{
    converged: boolean;
    error?: string;
    localFingerprint?: string;
    remoteFingerprint?: string;
  }> {
    const first = await this.verifyConvergence(target);
    if (!first.converged) {
      return { ...first, error: 'SyncEngineNext: feed fingerprints did not converge.' };
    }
    if (!shouldContinue()) {
      return { ...first, converged: false, error: 'SyncEngineNext: convergence proof was interrupted.' };
    }
    const second = await this.verifyConvergence(target);
    if (!shouldContinue()) {
      return { ...second, converged: false, error: 'SyncEngineNext: convergence proof was interrupted.' };
    }
    const stable = second.converged &&
      first.localFingerprint === second.localFingerprint &&
      first.remoteFingerprint === second.remoteFingerprint;
    return stable
      ? second
      : { ...second, converged: false, error: 'SyncEngineNext: feed head changed during convergence proof.' };
  }

  private settleCovers(
    active: readonly ActiveSession[],
    direction: SyncDirection,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<PromiseSettledResult<void>[]> {
    return this.settleByEndpoint(active, ({ session }) => {
      if (!shouldContinue()) {
        return Promise.reject(new Error('SyncEngineNext: covering work was interrupted.'));
      }
      return session.cover(direction, shouldContinue);
    });
  }

  /** Keep independent endpoints concurrent while bounding one endpoint to one covering request stream. */
  private async settleByEndpoint<T extends { target: SyncTarget }, TResult>(
    items: readonly T[],
    operation: (item: T) => Promise<TResult>,
  ): Promise<PromiseSettledResult<TResult>[]> {
    const outcomes = new Array<PromiseSettledResult<TResult>>(items.length);
    const groups = new Map<string, number[]>();
    for (let index = 0; index < items.length; index++) {
      const endpoint = normalizeDwnEndpoint(items[index].target.dwnUrl);
      const group = groups.get(endpoint) ?? [];
      group.push(index);
      groups.set(endpoint, group);
    }
    await Promise.all([...groups.values()].map(async (indexes): Promise<void> => {
      for (const index of indexes) {
        try {
          outcomes[index] = { status: 'fulfilled', value: await operation(items[index]) };
        } catch (reason: unknown) {
          outcomes[index] = { status: 'rejected', reason };
        }
      }
    }));
    return outcomes;
  }

  private async pruneSupersededLinks(targets: readonly SyncTarget[]): Promise<void> {
    if (!this._planner.lastResolutionComplete) {
      return;
    }
    const current = new Set(targets.map(SyncEngineNext.targetKey));
    for (const link of await this._ledger.getAllLinks()) {
      const key = buildLinkKey(
        link.tenantDid,
        link.remoteEndpoint,
        link.projectionId,
        link.authorizationEpoch,
      );
      if (!current.has(key)) {
        await this.disposeSession(link);
        await this._ledger.deleteLink(link);
      }
    }
  }

  private async disposeSession(target: SyncTarget | {
    tenantDid: string;
    remoteEndpoint: string;
    projectionId: string;
    authorizationEpoch: string;
  }): Promise<void> {
    const key = 'did' in target
      ? SyncEngineNext.targetKey(target)
      : buildLinkKey(target.tenantDid, target.remoteEndpoint, target.projectionId, target.authorizationEpoch);
    const active = this._sessions.get(key);
    if (active !== undefined) {
      await active.session.dispose();
      this._sessions.delete(key);
    }
  }

  private async stopRuntime(): Promise<void> {
    this._live = false;
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    const sessions = [...this._sessions.values()];
    this._sessions.clear();
    this._echoSuppressor.clear();
    await Promise.all(sessions.map(({ session }) => session.dispose()));
  }

  private runRuntimeTransition(operation: () => Promise<void>): Promise<void> {
    this._runtimeGeneration++;
    this._runtimeTransitionDepth++;
    if (this._pendingSyncRun !== undefined) {
      this._pendingSyncRun.cancelled = true;
      this._pendingSyncRun = undefined;
    }
    return this.runTransition(operation).finally((): void => {
      this._runtimeTransitionDepth--;
    });
  }

  private runTransition(operation: () => Promise<void>): Promise<void> {
    const transition = this._transition.then(operation, operation);
    this._transition = transition.catch((): void => {});
    return transition;
  }

  private emitApplied(target: SyncTarget, entries: readonly SyncFreshEntry[]): void {
    for (const entry of entries) {
      this.emit({
        type           : 'delivery:applied',
        tenantDid      : target.did,
        remoteEndpoint : target.dwnUrl,
        ...syncEventScope(target.scope),
        descriptor     : syncMessageDescriptor(entry.message),
        messageCid     : entry.messageCid,
      });
    }
  }

  private emit(event: SyncEvent): void {
    for (const listener of Array.from(this._eventListeners)) {
      try {
        listener(event);
      } catch {
        // Observers cannot alter replication outcomes.
      }
    }
  }

  private async readHealth(tenantDid?: string): Promise<SyncHealthSummary> {
    const [delivery, links, quarantine, terminal] = await Promise.all([
      this._ledger.getAllDelivery(),
      this._ledger.getAllLinks(),
      this._ledger.getAllQuarantine(),
      this._ledger.getAllTerminal(),
    ]);
    const currentLinks = links.filter(link => tenantDid === undefined || link.tenantDid === tenantDid);
    const currentDelivery = delivery.filter(entry => tenantDid === undefined || entry.tenantDid === tenantDid);
    const currentQuarantine = quarantine.filter(entry => tenantDid === undefined || entry.tenantDid === tenantDid);
    const currentTerminal = terminal.filter(entry => tenantDid === undefined || entry.tenantDid === tenantDid);
    const degradedKeys = new Set([
      ...currentLinks.filter(link => link.status === 'authorization-paused').map(SyncEngineNext.healthKey),
      ...currentDelivery.map(SyncEngineNext.healthKey),
      ...currentQuarantine.map(SyncEngineNext.healthKey),
      ...currentTerminal.map(SyncEngineNext.healthKey),
    ]);
    const quotaBlockedMessageCount = currentDelivery.filter(entry => entry.outcome.reason === 'quota').length;
    return {
      connectivity       : this.connectivityState,
      degradedLinkCount  : degradedKeys.size,
      failedMessageCount : currentTerminal.length,
      quotaBlockedMessageCount,
      syncHealthy        : degradedKeys.size === 0,
    };
  }

  private static targetKey(target: SyncTarget): string {
    return buildLinkKey(target.did, target.dwnUrl, target.projectionId, target.authorizationEpoch);
  }

  private static targetBelongsToIdentity(target: SyncTarget, did: string): boolean {
    return target.did === did ||
      (target.authorization.kind === 'role' && target.authorization.actorDid === did);
  }

  private static healthKey(link: {
    authorizationEpoch: string;
    projectionId: string;
    remoteEndpoint: string;
    tenantDid: string;
  }): string {
    return buildLinkKey(link.tenantDid, link.remoteEndpoint, link.projectionId, link.authorizationEpoch);
  }

  private static normalizeOptions(options: SyncIdentityOptions): SyncIdentityOptions {
    return options.protocols === 'all'
      ? { ...options, protocols: 'all' }
      : { ...options, protocols: normalizeSyncProtocols(options.protocols) };
  }

  private static async withTimeout<T>(operation: Promise<T>, timeout: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout((): void => { reject(new Error(message)); }, timeout);
    });
    try {
      return await Promise.race([operation, expired]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private static rejectedOutcomes(count: number, reason: unknown): PromiseRejectedResult[] {
    return Array.from({ length: count }, (): PromiseRejectedResult => ({ status: 'rejected', reason }));
  }
}
