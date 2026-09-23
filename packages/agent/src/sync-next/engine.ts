import type { AbstractLevel } from 'abstract-level';
import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncFreshEntry } from '../sync-admit-closure.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type { FollowedSyncSource, FollowedSyncSourceInput } from '../followed-sync-source.js';
import type {
  ReplicationLinkSnapshot,
  StartSyncParams,
  SyncDirection,
  SyncDrainOptions,
  SyncDrainResult,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
  SyncIdentityOptions,
  SyncIdentityStatus,
  SyncLifecycleOptions,
  SyncRunOptions,
} from '../types/sync.js';

import { AgentPermissionsApi } from '../permissions-api.js';
import { executeUnlessAborted } from '@enbox/dwn-sdk-js';
import { FollowedSourceRoleAbsentError } from '../sync-role-replication-support.js';
import { FollowedSyncSourceStoreLevel } from '../followed-sync-source-store-level.js';
import { Level } from 'level';
import { openSyncNextSubscriptions } from './subscriptions.js';
import { RateLimitError } from '@enbox/dwn-clients';
import { resolveSyncConnectivityState } from '../sync-connectivity-manager.js';
import { SyncEchoSuppressor } from '../sync-echo-suppressor.js';
import { SyncEndpointStoreLevel } from '../sync-endpoint-store-level.js';
import { SyncIdentityStoreLevel } from '../sync-identity-store-level.js';
import { syncMessageDescriptor } from '../sync-messages.js';
import { SyncNextCatalog } from './catalog.js';
import { SyncNextEndpointGate } from './endpoint-gate.js';
import { SyncNextLedgerStore } from './ledger-store.js';
import { SyncNextLinkSession } from './link-session.js';
import { SyncNextPullPage } from './pull-page.js';
import { SyncNextPushPage } from './push-page.js';
import { SyncNextQuarantineRetry } from './quarantine-retry.js';
import { SyncTargetPlanner } from '../sync-target-planner.js';
import { followedSyncSourceActiveEqual, normalizeFollowedSyncSource } from '../followed-sync-source.js';
import { isNonRetryableSyncAuthorizationFailure, syncErrorMessage } from '../sync-runtime-errors.js';
import { MAX_TIMER_DELAY_MS, parseDurationInMilliseconds, runSerializedByKey } from '@enbox/common';
import { normalizeDwnEndpoint, SyncTargetResolver } from '../sync-target-resolver.js';
import {
  normalizeSyncProtocols,
  projectReplicationCurrentness,
  syncEventScope,
} from '../types/sync.js';
import { syncNextLinkIdentity, syncNextLinkKey, syncNextLogicalTargetId } from './ledger-key.js';

type LevelKey = string | Buffer | Uint8Array;

export type SyncEngineNextParams = {
  agent?: EnboxPlatformAgent;
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
  did?: string;
};

/** Watermark-based sync engine. */
export class SyncEngineNext implements SyncEngine {
  private _agent?: EnboxPlatformAgent;
  private _catalog?: SyncNextCatalog;
  private readonly _catalogChannel?: BroadcastChannel;
  private readonly _db: AbstractLevel<LevelKey>;
  private readonly _echoSuppressor = new SyncEchoSuppressor();
  private readonly _endpointGate = new SyncNextEndpointGate();
  private readonly _endpointStore: SyncEndpointStoreLevel;
  private readonly _eventListeners = new Set<SyncEventListener>();
  private readonly _identityStore: SyncIdentityStoreLevel;
  private readonly _ledger: SyncNextLedgerStore;
  private readonly _lockNamespace: string;
  private _live = false;
  private readonly _operations = new Map<string, Promise<void>>();
  private readonly _planner: SyncTargetPlanner;
  private _quarantineRetry?: SyncNextQuarantineRetry;
  private _queuedSync?: MergedSyncRunRequest;
  private _resolver?: SyncTargetResolver;
  private _refreshLive?: Promise<void>;
  private _refreshLivePending = false;
  private _runtimeGeneration = 0;
  private readonly _sessionCreations = new Map<string, Promise<ActiveSession>>();
  private readonly _sessions = new Map<string, ActiveSession>();
  private readonly _sourceStore: FollowedSyncSourceStoreLevel;
  private _syncRun?: Promise<void>;
  private _liveRetryTimer?: ReturnType<typeof setTimeout>;
  private _timer?: ReturnType<typeof setInterval>;

  public constructor({ agent, dataPath, db }: SyncEngineNextParams = {}) {
    this._db = db ?? new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
    this._lockNamespace = dataPath ?? 'default';
    this._endpointStore = new SyncEndpointStoreLevel(this._db);
    this._identityStore = new SyncIdentityStoreLevel(this._db);
    this._ledger = new SyncNextLedgerStore(this._db, dataPath ?? 'default');
    this._sourceStore = new FollowedSyncSourceStoreLevel(this._db);
    this._planner = new SyncTargetPlanner({
      getTargetResolver : (): SyncTargetResolver => this.targetResolver,
      identityStore     : this._identityStore,
      sourceStore       : this._sourceStore,
      warn              : (message, error): void => { console.warn(message, error); },
    });
    if (dataPath !== undefined && typeof BroadcastChannel !== 'undefined') {
      this._catalogChannel = new BroadcastChannel(`enbox:sync-catalog:${dataPath}`);
      (this._catalogChannel as { unref?: () => void }).unref?.();
      this._catalogChannel.onmessage = (): void => {
        this._planner.invalidate();
        this.scheduleLiveRefresh();
      };
    }
    if (agent !== undefined) {
      this.agent = agent;
    }
  }

  public get agent(): EnboxPlatformAgent {
    if (this._agent === undefined) {
      throw new Error('SyncEngineNext: agent is not set.');
    }
    return this._agent;
  }

  public set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
    const permissionsApi = new AgentPermissionsApi({ agent });
    this._resolver = new SyncTargetResolver({
      endpointStore        : this._endpointStore,
      getEndpointDiscovery : (): EnboxPlatformAgent['dwn'] => this.agent.dwn,
      permissionsApi,
    });
    this._catalog = new SyncNextCatalog(
      agent,
      permissionsApi,
      this._identityStore,
      this._sourceStore,
      this._resolver,
      this._lockNamespace,
    );
    this._quarantineRetry = new SyncNextQuarantineRetry(
      agent,
      this._ledger,
      (target): Promise<SyncTarget> => this.targetResolver.withCurrentRoleGrant(target),
      (pullTarget, entries): void => this.emitApplied(pullTarget, entries),
    );
  }

  public get hasActiveSubscriptions(): boolean {
    return [...this._sessions.values()].some(({ subscribed }) => subscribed);
  }

  public async setIdentityOptions(
    params: { did: string; options: SyncIdentityOptions },
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    const options = params.options.protocols === 'all'
      ? { ...params.options, protocols: 'all' as const }
      : { ...params.options, protocols: normalizeSyncProtocols(params.options.protocols) };
    await this.runRuntimeTransition(async (): Promise<void> => {
      await this.catalog.setIdentityOptions(
        { did: params.did, options },
        lifecycleOptions,
        (): Promise<void> => this.disposeIdentitySessions(params.did),
      );
      this._planner.invalidate();
      this.emit({ type: 'identity:registration-change', tenantDid: params.did, options });
      this.publishCatalogWake();
      await this.refreshLiveTargets(false, params.did);
    });
  }

  public async refreshIdentityRouting(
    did: string,
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    await this.runRuntimeTransition(async (): Promise<void> => {
      const refreshed = await this.catalog.refreshIdentityRouting(
        did,
        lifecycleOptions,
        (): Promise<void> => this.disposeIdentitySessions(did),
      );
      if (!refreshed) {
        return;
      }
      this._planner.invalidate();
      await this.refreshLiveTargets(false, did);
    });
  }

  public async pauseIdentity(params: {
    did: string;
    delegateDid: string;
    connectSessionId: string;
  }): Promise<boolean> {
    let paused = false;
    await this.runRuntimeTransition(async (): Promise<void> => {
      paused = await this.catalog.pauseIdentity(params, async (): Promise<void> => {
        await this.disposeIdentitySessions(params.did);
        await this.deleteIdentityReplicationState(params.did);
      });
      if (!paused) {
        return;
      }
      this._planner.invalidate();
      this.emit({ type: 'identity:registration-change', tenantDid: params.did });
      this.publishCatalogWake();
      await this.refreshLiveTargets();
    });
    return paused;
  }

  public async removeIdentity(
    did: string,
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    await this.runRuntimeTransition(async (): Promise<void> => {
      const removed = await this.catalog.removeIdentity(did, lifecycleOptions, async (): Promise<void> => {
        const active = [...this._sessions.values()]
          .filter(({ target }) => SyncEngineNext.targetBelongsToIdentity(target, did));
        SyncEngineNext.throwRejected(
          await this.settleCovers(active, 'push'),
          'SyncEngineNext: identity push did not drain.',
        );
        await this.disposeIdentitySessions(did);
        await this.deleteIdentityReplicationState(did);
      });
      if (!removed) {
        return;
      }
      this._planner.invalidate();
      this.emit({ type: 'identity:registration-change', tenantDid: did });
      this.publishCatalogWake();
      await this.refreshLiveTargets();
    });
  }

  public getIdentityOptions(did: string): Promise<SyncIdentityOptions | undefined> {
    return this._identityStore.get(did);
  }

  public async followSource(source: FollowedSyncSourceInput): Promise<FollowedSyncSource> {
    let followed!: FollowedSyncSource;
    await this.runRuntimeTransition(async (): Promise<void> => {
      const result = await this.catalog.followSource(
        source,
        (accepted): Promise<void> => this.disposeFollowedContextSessions(accepted),
      );
      followed = result.source;
      if (!result.changed) {
        return;
      }
      this._planner.invalidate();
      this.emitFollowedSourceChange(followed, followed.id);
      this.publishCatalogWake();
      await this.refreshLiveTargets(false, source.actorDid);
    });
    return followed;
  }

  public getFollowedSource(id: string): Promise<FollowedSyncSource | undefined> {
    return this._sourceStore.get(id);
  }

  public listFollowedSources(): Promise<FollowedSyncSource[]> {
    return this.catalog.listFollowedSources();
  }

  public async deleteFollowedSource(source: FollowedSyncSource): Promise<void> {
    await this.runRuntimeTransition(async (): Promise<void> => {
      const removed = await this.catalog.deleteFollowedSource(source, async (current): Promise<void> => {
        await this.disposeFollowedContextSessions(current);
        await this.deleteRoleLinkAndSparse(current);
      });
      if (removed === undefined) {
        return;
      }
      this._planner.invalidate();
      this.emitFollowedSourceChange(removed, undefined);
      this.publishCatalogWake();
      await this.refreshLiveTargets(false, source.actorDid);
    });
  }

  public async markFollowedSourcePullPending(source: FollowedSyncSource): Promise<boolean> {
    const expected = normalizeFollowedSyncSource(source);
    const current = await this._sourceStore.get(expected.id);
    if (current === undefined || !followedSyncSourceActiveEqual(current, expected)) {
      return false;
    }
    for (const active of this._sessions.values()) {
      if (
        active.target.authorization.kind === 'role' &&
        active.target.authorization.roleRecordId === expected.id
      ) {
        active.session.request('pull');
      }
    }
    return true;
  }

  public async pullFollowedSource(source: FollowedSyncSource): Promise<boolean> {
    const expected = normalizeFollowedSyncSource(source);
    try {
      return await this.runExclusive((): Promise<boolean> =>
        this.runFollowedSourcePull(expected, this._runtimeGeneration)
      );
    } catch {
      return false;
    }
  }

  private async runFollowedSourcePull(
    source: FollowedSyncSource,
    runtimeGeneration: number,
  ): Promise<boolean> {
    const [accepted, identity] = await Promise.all([
      this._sourceStore.get(source.id),
      this._identityStore.get(source.actorDid),
    ]);
    if (accepted === undefined || !followedSyncSourceActiveEqual(accepted, source)) {
      return false;
    }
    if (identity === undefined) {
      return false;
    }
    const target = await this.targetResolver.buildTargetForSource(source, identity.delegateDid);
    const active = await this.ensureSession(target);
    try {
      await active.session.cover('pull', (): boolean => runtimeGeneration === this._runtimeGeneration);
      const [current, currentIdentity] = await Promise.all([
        this._sourceStore.get(source.id),
        this._identityStore.get(source.actorDid),
      ]);
      return runtimeGeneration === this._runtimeGeneration &&
        current !== undefined &&
        followedSyncSourceActiveEqual(current, source) &&
        currentIdentity !== undefined &&
        currentIdentity.delegateDid === identity.delegateDid;
    } finally {
      if (!this._live) {
        await this.disposeSession(target);
      }
    }
  }

  public sync(direction?: SyncDirection, options: SyncRunOptions = {}): Promise<void> {
    this.mergeSyncRequest(direction, options.did);
    if (this._syncRun !== undefined) {
      return this._syncRun;
    }
    const run = this.runExclusive(async (): Promise<void> => {
      try {
        while (this._queuedSync !== undefined) {
          const request = this._queuedSync;
          this._queuedSync = undefined;
          await this.runCoveringSync(request.direction, request.did === undefined ? {} : { did: request.did });
        }
      } finally {
        this._syncRun = undefined;
      }
    });
    this._syncRun = run;
    return run;
  }

  public async drainTo(endpoint: string, options: SyncDrainOptions = {}): Promise<SyncDrainResult> {
    const normalizedEndpoint = normalizeDwnEndpoint(endpoint);
    if (options.signal?.aborted === true) {
      return {
        endpoint  : normalizedEndpoint,
        completed : false,
        cancelled : true,
        error     : 'drain aborted',
      };
    }
    if (this._operations.has('engine') || this._syncRun !== undefined) {
      throw new Error('SyncEngineNext: Sync operation is already in progress.');
    }
    return this.runExclusive((): Promise<SyncDrainResult> => this.runDrain(normalizedEndpoint, options));
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
        const initial = this.refreshLiveTargets(true).finally((): void => {
          this.finishLiveRefresh(initial);
        });
        this._refreshLive = initial;
        await initial;
        this._timer = setInterval((): void => {
          this.scheduleLiveRefresh();
        }, interval);
      } catch (error: unknown) {
        await this.stopRuntime();
        throw error;
      }
    });
  }

  public stopSync(timeout = 2_000): Promise<void> {
    return executeUnlessAborted(
      this.runRuntimeTransition((): Promise<void> => this.stopRuntime()),
      AbortSignal.timeout(timeout),
    );
  }

  public on(listener: SyncEventListener): () => void {
    this._eventListeners.add(listener);
    return (): void => { this._eventListeners.delete(listener); };
  }

  public async reset(): Promise<void> {
    await this.runRuntimeTransition(async (): Promise<void> => {
      await this.stopRuntime();
      await Promise.all([
        this._endpointStore.clear(),
        this._identityStore.clear(),
        this._ledger.clear(),
        this._sourceStore.clear(),
      ]);
      this._planner.invalidate();
      this.publishCatalogWake();
    });
  }

  public async close(options: SyncLifecycleOptions = {}): Promise<void> {
    await this.stopSync(options.timeout ?? 2_000);
    this._catalogChannel?.close();
    await this._db.close();
  }

  public async getIdentitySyncStatus(tenantDid: string): Promise<SyncIdentityStatus> {
    const [delivery, durableLinks, quarantine, registration] = await Promise.all([
      this._ledger.getDeliveryForTenant(tenantDid),
      this._ledger.getLinksForTenant(tenantDid),
      this._ledger.getQuarantineForTenant(tenantDid),
      this.getIdentityOptions(tenantDid),
    ]);
    const links = this.linkSnapshots(durableLinks);
    const connectivity = resolveSyncConnectivityState(links.map(link => link.connectivity));
    const endpoints = new Set([
      ...links.map(link => link.remoteEndpoint),
      ...delivery.map(entry => entry.remoteEndpoint),
      ...quarantine.map(entry => entry.remoteEndpoint),
    ]);
    const remotes = [...endpoints].map(remoteEndpoint => {
      const remoteLinks = links.filter(link => link.remoteEndpoint === remoteEndpoint);
      const quotaBlockedMessageCount = delivery.filter(entry =>
        entry.tenantDid === tenantDid &&
        entry.remoteEndpoint === remoteEndpoint &&
        entry.outcome.reason === 'quota'
      ).length;
      const remoteConnectivity = resolveSyncConnectivityState(remoteLinks.map(link => link.connectivity));
      const pending = delivery.some(entry => entry.remoteEndpoint === remoteEndpoint) ||
        quarantine.some(entry => entry.remoteEndpoint === remoteEndpoint);
      const degraded = pending || remoteLinks.some(link => link.status === 'paused');
      return {
        connectivity : remoteConnectivity,
        quotaBlockedMessageCount,
        remoteEndpoint,
        state        : remoteConnectivity === 'offline'
          ? 'offline' as const
          : quotaBlockedMessageCount > 0
            ? 'quota-blocked' as const
            : degraded ? 'degraded' as const : 'healthy' as const,
        tenantDid,
      };
    });
    const lastActivityAt = links.reduce<string | undefined>((latest, link) =>
      link.lastActivityAt !== undefined && (latest === undefined || link.lastActivityAt > latest)
        ? link.lastActivityAt
        : latest
    , undefined);
    return {
      connectivity,
      currentness: projectReplicationCurrentness(links),
      lastActivityAt,
      links,
      registration,
      remotes,
    };
  }

  public async getReplicationLinks(tenantDid: string): Promise<ReplicationLinkSnapshot[]> {
    return this.linkSnapshots(await this._ledger.getLinksForTenant(tenantDid));
  }

  private linkSnapshots(links: Awaited<ReturnType<SyncNextLedgerStore['getAllLinks']>>): ReplicationLinkSnapshot[] {
    return links.map(link => {
      const active = this._sessions.get(syncNextLinkKey(link));
      return {
        connectivity : active === undefined ? 'unknown' : active.session.isOnline ? 'online' : 'offline',
        delegateDid  : active?.target.delegateDid ??
          (link.authorization.kind === 'delegate' ? link.authorization.delegateDid : undefined),
        followedSourceId : link.authorization.kind === 'role' ? link.authorization.roleRecordId : undefined,
        isPullCurrent    : active?.session.isPullCurrent ?? false,
        lastActivityAt   : link.updatedAt,
        pullPosition     : link.pullHandledThrough?.position,
        pushPosition     : link.pushHandledThrough?.position,
        remoteEndpoint   : link.remoteEndpoint,
        scope            : link.scope,
        status           : active?.subscribed === true ? 'live' : 'initializing',
        tenantDid        : link.tenantDid,
      };
    });
  }

  public async retryRemoteNow(tenantDid: string, remoteEndpoint: string): Promise<void> {
    const endpoint = normalizeDwnEndpoint(remoteEndpoint);
    const runtimeGeneration = this._runtimeGeneration;
    this._endpointGate.clear(endpoint);
    await this.runExclusive((): Promise<void> => {
      if (runtimeGeneration !== this._runtimeGeneration) {
        throw new Error('SyncEngineNext: remote retry cancelled by a runtime transition.');
      }
      return this.runCoveringSync(undefined, { did: tenantDid }, endpoint);
    });
  }

  private get targetResolver(): SyncTargetResolver {
    if (this._resolver === undefined) {
      throw new Error('SyncEngineNext: agent is not set.');
    }
    return this._resolver;
  }

  private get catalog(): SyncNextCatalog {
    if (this._catalog === undefined) {
      throw new Error('SyncEngineNext: agent is not set.');
    }
    return this._catalog;
  }

  private get quarantineRetry(): SyncNextQuarantineRetry {
    if (this._quarantineRetry === undefined) {
      throw new Error('SyncEngineNext: agent is not set.');
    }
    return this._quarantineRetry;
  }

  private async runDrain(endpoint: string, options: SyncDrainOptions): Promise<SyncDrainResult> {
    const runtimeGeneration = this._runtimeGeneration;
    await this._endpointStore.set(endpoint);
    this._planner.invalidate();
    const topologyGeneration = this._planner.topologyGeneration;
    const planned = (await this._planner.getTargets()).filter(target => target.dwnUrl === endpoint);
    try {
      if (!this._planner.lastResolutionComplete || planned.length === 0) {
        throw new Error('sync target plan is incomplete');
      }
      const active = await Promise.all(planned.map(target => this.ensureSession(target)));
      const shouldContinue = (): boolean => options.signal?.aborted !== true &&
        runtimeGeneration === this._runtimeGeneration &&
        topologyGeneration === this._planner.topologyGeneration;
      const [pull, push] = await Promise.all([
        this.settleCovers(active, 'pull', shouldContinue),
        this.settleCovers(active, 'push', shouldContinue),
      ]);
      SyncEngineNext.throwRejected([...pull, ...push], 'SyncEngineNext: drain failed.');
      if (!shouldContinue()) {
        throw new Error(options.signal?.aborted === true ? 'drain aborted' : 'sync topology changed during drain');
      }
      return { endpoint, completed: true, cancelled: false };
    } catch (error: unknown) {
      return {
        endpoint,
        completed : false,
        cancelled : options.signal?.aborted === true,
        error     : error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (!this._live) {
        await Promise.allSettled(planned.map(target => this.disposeSession(target)));
      }
    }
  }

  private mergeSyncRequest(
    direction: SyncDirection | undefined,
    did: string | undefined,
  ): void {
    if (this._queuedSync === undefined) {
      this._queuedSync = { direction, did };
      return;
    }
    if (this._queuedSync.direction !== direction) {
      this._queuedSync.direction = undefined;
    }
    if (this._queuedSync.did !== did) {
      this._queuedSync.did = undefined;
    }
  }

  private async runCoveringSync(
    direction: SyncDirection | undefined,
    options: SyncRunOptions,
    endpoint?: string,
  ): Promise<void> {
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
      (options.did === undefined || SyncEngineNext.targetBelongsToIdentity(target, options.did)) &&
      (endpoint === undefined || target.dwnUrl === endpoint)
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
    } finally {
      if (!this._live) {
        await Promise.allSettled(targets.map(target => this.disposeSession(target)));
      }
    }
    SyncEngineNext.throwRejected(outcomes, 'SyncEngineNext: covering sync failed.');
  }

  private async refreshLiveTargets(initialCover = false, wakeDid?: string): Promise<void> {
    if (!this._live) {
      return;
    }
    const targets = await this._planner.getTargets();
    await this.pruneSupersededLinks(targets);
    const active = await Promise.all(targets.map(target => this.ensureSession(target)));
    await Promise.allSettled(active.map(async (item): Promise<void> => {
      if (!item.subscribed) {
        try {
          await this._endpointGate.run(
            item.target.dwnUrl,
            (): Promise<void> => openSyncNextSubscriptions(
              this.agent,
              this.targetResolver,
              item.target,
              item.session,
              (error): void => { this.handleSubscriptionTerminal(item, error); },
            ),
          );
          item.subscribed = true;
          this._endpointGate.clear(item.target.dwnUrl);
          this.emit({
            type           : 'link:status-change',
            tenantDid      : item.target.did,
            remoteEndpoint : item.target.dwnUrl,
            ...syncEventScope(item.target.scope),
            from           : 'initializing',
            to             : 'live',
          });
        } catch (error: unknown) {
          if (!this.recoverRoleAuthorization(item.target, error)) {
            this.scheduleLiveRetry(error);
            console.error('SyncEngineNext: subscription establishment failed', error);
          }
        }
      }
    }));
    if (initialCover) {
      await this.settleCovers(active, 'pull');
      await this.settleCovers(active, 'push');
    }
    for (const { session, target } of active) {
      if (!initialCover && (wakeDid === undefined || SyncEngineNext.targetBelongsToIdentity(target, wakeDid))) {
        session.start();
      }
    }
  }

  private async ensureSession(target: SyncTarget): Promise<ActiveSession> {
    const key = SyncEngineNext.targetKey(target);
    const existing = this._sessions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this._sessionCreations.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const creation = this.createSession(target, key).finally((): void => {
      if (this._sessionCreations.get(key) === creation) {
        this._sessionCreations.delete(key);
      }
    });
    this._sessionCreations.set(key, creation);
    return creation;
  }

  private handleSubscriptionTerminal(item: ActiveSession, error: unknown): void {
    if (this._sessions.get(SyncEngineNext.targetKey(item.target)) !== item) {
      return;
    }
    const wasSubscribed = item.subscribed;
    item.subscribed = false;
    item.session.noteRemoteDisconnected();
    if (wasSubscribed) {
      this.emit({
        type           : 'link:status-change',
        tenantDid      : item.target.did,
        remoteEndpoint : item.target.dwnUrl,
        ...syncEventScope(item.target.scope),
        from           : 'live',
        to             : 'initializing',
      });
    }
    if (!this.recoverRoleAuthorization(item.target, error)) {
      console.warn('SyncEngineNext: subscription ended; scheduled refresh will retry it', error);
      this.scheduleLiveRetry(error);
    }
  }

  private async createSession(target: SyncTarget, key: string): Promise<ActiveSession> {
    await this._ledger.getOrCreateLink({
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      projectionId       : target.projectionId,
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      tenantDid          : target.did,
    });
    const pullPage = new SyncNextPullPage(
      this.agent,
      this._ledger,
      this._echoSuppressor,
      (pullTarget, entries): void => this.emitApplied(pullTarget, entries),
      (pullTarget): Promise<SyncTarget> => this.targetResolver.withCurrentRoleGrant(pullTarget),
    );
    const pushPage = new SyncNextPushPage(this.agent, this._ledger, this._echoSuppressor);
    const active: ActiveSession = {
      session: new SyncNextLinkSession(
        target,
        this._ledger,
        pullPage,
        pushPage,
        this.quarantineRetry,
        (error): void => {
          if (!this.recoverRoleAuthorization(target, error)) {
            this.scheduleLiveRetry(error);
            console.error('SyncEngineNext: link work failed', error);
          }
        },
        {
          block : (delayMs): void => { this._endpointGate.block(target.dwnUrl, delayMs); },
          clear : (): void => { this._endpointGate.clear(target.dwnUrl); },
          run   : operation => this._endpointGate.run(target.dwnUrl, operation),
        },
        {
          onActivity: (): void => {
            this.emit({
              type           : 'link:activity',
              tenantDid      : target.did,
              remoteEndpoint : target.dwnUrl,
              ...syncEventScope(target.scope),
            });
          },
          onConnectivityChange: (from, to): void => {
            this.emit({
              type           : 'link:connectivity-change',
              tenantDid      : target.did,
              remoteEndpoint : target.dwnUrl,
              ...syncEventScope(target.scope),
              from           : from ? 'online' : 'offline',
              to             : to ? 'online' : 'offline',
            });
          },
          onPullCurrentnessChange: (from, to): void => {
            this.emit({
              type           : 'pull:currentness-change',
              tenantDid      : target.did,
              remoteEndpoint : target.dwnUrl,
              ...syncEventScope(target.scope),
              from,
              to,
            });
          },
        },
      ),
      subscribed: false,
      target,
    };
    this._sessions.set(key, active);
    return active;
  }

  private settleCovers(
    active: readonly ActiveSession[],
    direction: SyncDirection,
    shouldContinue: () => boolean = (): boolean => true,
  ): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(active.map(({ session }) => {
      if (!shouldContinue()) {
        return Promise.reject(new Error('SyncEngineNext: covering work was interrupted.'));
      }
      return session.cover(direction, shouldContinue);
    }));
  }

  private async pruneSupersededLinks(targets: readonly SyncTarget[]): Promise<void> {
    if (!this._planner.lastResolutionComplete) {
      return;
    }
    const current = new Set(targets.map(SyncEngineNext.targetKey));
    const currentLogicalTargets = new Set(targets.map(target =>
      syncNextLogicalTargetId(target.did, target.projectionId)
    ));
    for (const link of await this._ledger.getAllLinks()) {
      const key = syncNextLinkKey(link);
      if (!current.has(key)) {
        await this.disposeSession(link);
        if (currentLogicalTargets.has(syncNextLogicalTargetId(link.tenantDid, link.projectionId))) {
          await this._ledger.retireLink(link);
        } else {
          await this._ledger.deleteLinkAndSparse(link);
        }
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
      : syncNextLinkKey(target);
    const active = this._sessions.get(key);
    if (active !== undefined) {
      await active.session.dispose();
      this._sessions.delete(key);
    }
  }

  private async disposeIdentitySessions(did: string): Promise<void> {
    await this.disposeSessions(target => SyncEngineNext.targetBelongsToIdentity(target, did));
  }

  private async disposeFollowedContextSessions(source: FollowedSyncSource): Promise<void> {
    await this.disposeSessions(target =>
      target.did === source.sourceDid &&
      target.authorization.kind === 'role' &&
      target.authorization.actorDid === source.actorDid &&
      target.scope.kind === 'context' &&
      target.scope.protocol === source.protocol &&
      target.scope.contextId === source.contextId
    );
  }

  private async disposeSessions(matches: (target: SyncTarget) => boolean): Promise<void> {
    await Promise.allSettled([...this._sessionCreations.values()]);
    const sessions = [...this._sessions.entries()].filter(([, { target }]) => matches(target));
    await Promise.all(sessions.map(async ([key, { session }]): Promise<void> => {
      await session.dispose();
      this._sessions.delete(key);
    }));
  }

  private async stopRuntime(): Promise<void> {
    this._live = false;
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    if (this._liveRetryTimer !== undefined) {
      clearTimeout(this._liveRetryTimer);
      this._liveRetryTimer = undefined;
    }
    await this._refreshLive;
    await Promise.allSettled([...this._sessionCreations.values()]);
    const sessions = [...this._sessions.values()];
    this._sessions.clear();
    this._echoSuppressor.clear();
    this._endpointGate.reset();
    await Promise.all(sessions.map(({ session }) => session.dispose()));
  }

  private scheduleLiveRefresh(): void {
    if (!this._live) {
      return;
    }
    if (this._refreshLive !== undefined) {
      this._refreshLivePending = true;
      return;
    }
    const refresh = this.refreshLiveTargets().catch((error: unknown): void => {
      console.error('SyncEngineNext: live refresh failed', error);
    }).finally((): void => {
      this.finishLiveRefresh(refresh);
    });
    this._refreshLive = refresh;
  }

  private finishLiveRefresh(refresh: Promise<void>): void {
    if (this._refreshLive !== refresh) {
      return;
    }
    this._refreshLive = undefined;
    if (this._refreshLivePending) {
      this._refreshLivePending = false;
      this.scheduleLiveRefresh();
    }
  }

  private scheduleLiveRetry(error: unknown): void {
    if (!this._live || this._liveRetryTimer !== undefined) {
      return;
    }
    const delay = error instanceof RateLimitError
      ? error.retryAfterSec * 1_000
      : 5_000;
    this._liveRetryTimer = setTimeout((): void => {
      this._liveRetryTimer = undefined;
      this.scheduleLiveRefresh();
    }, delay);
  }

  private recoverRoleAuthorization(target: SyncTarget, error: unknown): boolean {
    if (
      target.authorization.kind !== 'role' ||
      !isNonRetryableSyncAuthorizationFailure(syncErrorMessage(error))
    ) {
      return false;
    }
    void this.refreshFollowedSource(target).catch((cause: unknown): void => {
      console.warn('SyncEngineNext: followed source refresh failed', cause);
      this.scheduleLiveRetry(cause);
    });
    return true;
  }

  private async refreshFollowedSource(target: SyncTarget): Promise<void> {
    if (target.authorization.kind !== 'role') {
      return;
    }
    const source = await this._sourceStore.get(target.authorization.roleRecordId);
    if (source === undefined) {
      return;
    }
    try {
      await this.followSource({
        actorDid  : source.actorDid,
        contextId : source.contextId,
        protocol  : source.protocol,
        roles     : source.roles,
        sourceDid : source.sourceDid,
      });
    } catch (error: unknown) {
      if (error instanceof FollowedSourceRoleAbsentError) {
        await this.deleteFollowedSource(source);
        return;
      }
      throw error;
    }
  }

  private async deleteRoleLinkAndSparse(source: FollowedSyncSource): Promise<void> {
    for (const link of await this._ledger.getAllLinks()) {
      if (
        link.authorization.kind === 'role' &&
        link.authorization.actorDid === source.actorDid &&
        link.authorization.roleRecordId === source.id
      ) {
        await this._ledger.deleteLinkAndSparse(link);
      }
    }
  }

  private async deleteIdentityReplicationState(did: string): Promise<void> {
    await this._ledger.deleteForTenant(did);
    for (const link of await this._ledger.getAllLinks()) {
      if (link.authorization.kind === 'role' && link.authorization.actorDid === did) {
        await this._ledger.retireLink(link);
      }
    }
  }

  private publishCatalogWake(): void {
    try {
      this._catalogChannel?.postMessage(null);
    } catch {
      // Cross-context notification is best effort; durable catalog state remains authoritative.
    }
  }

  private runRuntimeTransition(operation: () => Promise<void>): Promise<void> {
    this._runtimeGeneration++;
    this._queuedSync = undefined;
    return this.runExclusive(operation);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return runSerializedByKey(this._operations, 'engine', operation);
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

  private emitFollowedSourceChange(
    source: FollowedSyncSource,
    followedSourceId: string | undefined,
  ): void {
    this.emit({
      type                       : 'followed-context:change',
      tenantDid                  : source.sourceDid,
      actorDid                   : source.actorDid,
      protocol                   : source.protocol,
      contextId                  : source.contextId,
      followedSourceAcceptanceId : source.acceptanceId,
      followedSourceId,
    });
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

  private static targetKey(target: SyncTarget): string {
    return syncNextLinkKey(syncNextLinkIdentity(target));
  }

  private static targetBelongsToIdentity(target: SyncTarget, did: string): boolean {
    return target.did === did ||
      (target.authorization.kind === 'role' && target.authorization.actorDid === did);
  }

  private static throwRejected(outcomes: readonly PromiseSettledResult<unknown>[], message: string): void {
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map(({ reason }) => reason), message);
    }
  }

}
