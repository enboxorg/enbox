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
import { RateLimitError } from '@enbox/dwn-clients';
import { resolveSyncConnectivityState } from '../sync-connectivity-manager.js';
import { SyncEchoSuppressor } from '../sync-echo-suppressor.js';
import { SyncEndpointStoreLevel } from '../sync-endpoint-store-level.js';
import { SyncIdentityStoreLevel } from '../sync-identity-store-level.js';
import { SyncNextCatalog } from './catalog.js';
import { SyncNextEndpointGate } from './endpoint-gate.js';
import { SyncNextLedgerStore } from './ledger-store.js';
import { SyncNextLinkSession } from './link-session.js';
import { SyncNextPullPage } from './pull-page.js';
import { SyncNextPushPage } from './push-page.js';
import { SyncNextQuarantineRetry } from './quarantine-retry.js';
import { SyncTargetPlanner } from '../sync-target-planner.js';
import { followedSyncSourceActiveEqual, normalizeFollowedSyncSource } from '../followed-sync-source.js';
import { MAX_TIMER_DELAY_MS, parseDurationInMilliseconds, runSerializedByKey } from '@enbox/common';
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

export type SyncEngineNextRebuildParams = {
  direction: SyncDirection;
  remoteEndpoint: string;
  tenantDid: string;
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

type CatalogWake =
  | { did: string; kind: 'identity' }
  | { deleted: boolean; kind: 'followed-source'; source: FollowedSyncSource };

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Temporary selectable façade for the isolated next-engine implementation. */
export class SyncEngineNext implements SyncEngine {
  private _agent?: EnboxPlatformAgent;
  private _catalog?: SyncNextCatalog;
  private readonly _catalogChannel?: BroadcastChannel;
  private _catalogClosed = false;
  private _catalogWakeTail: Promise<void> = Promise.resolve();
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
  private readonly _pausedIdentities = new Map<string, string>();
  private _permissionsApi?: AgentPermissionsApi;
  private readonly _planner: SyncTargetPlanner;
  private _quarantineRetry?: SyncNextQuarantineRetry;
  private _pendingSyncRun?: PendingSyncRun;
  private _resolver?: SyncTargetResolver;
  private _refreshLive?: Promise<void>;
  private _refreshLivePending = false;
  private _runtimeGeneration = 0;
  private _runtimeTransitionDepth = 0;
  private readonly _sessionCreations = new Map<string, Promise<ActiveSession>>();
  private readonly _sessions = new Map<string, ActiveSession>();
  private readonly _sourceStore: FollowedSyncSourceStoreLevel;
  private _subscriptionRetryTimer?: ReturnType<typeof setTimeout>;
  private _timer?: ReturnType<typeof setInterval>;

  public constructor({ dataPath, db }: SyncEngineNextParams = {}) {
    this._db = db ?? new Level<string, string>(dataPath ?? 'DATA/AGENT/SYNC_STORE');
    this._lockNamespace = dataPath ?? 'default';
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
    if (dataPath !== undefined && typeof BroadcastChannel !== 'undefined') {
      this._catalogChannel = new BroadcastChannel(`enbox:sync-catalog:${dataPath}`);
      (this._catalogChannel as { unref?: () => void }).unref?.();
      this._catalogChannel.onmessage = ({ data }: MessageEvent): void => {
        this.scheduleCatalogWake(data);
      };
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
    this._permissionsApi = new AgentPermissionsApi({ agent });
    this._resolver = new SyncTargetResolver({
      endpointStore        : this._endpointStore,
      getEndpointDiscovery : (): EnboxPlatformAgent['dwn'] => this.agent.dwn,
      permissionsApi       : this._permissionsApi,
    });
    this._catalog = new SyncNextCatalog(
      agent,
      this._permissionsApi,
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
    await this.runRuntimeTransition(async (): Promise<void> => {
      await this.catalog.setIdentityOptions(
        { did, options: normalized },
        lifecycleOptions,
        (): Promise<void> => this.disposeIdentitySessions(did),
      );
      this._pausedIdentities.delete(did);
      this._planner.invalidate();
      this.emit({ type: 'identity:registration-change', tenantDid: did, options: normalized });
      this.publishCatalogWake({ did, kind: 'identity' });
      await this.refreshLiveTargets(false, did);
    });
  }

  public async ensureIdentityOptions(
    params: { did: string; options: SyncIdentityOptions },
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<boolean> {
    const normalized = SyncEngineNext.normalizeOptions(params.options);
    let changed = false;
    await this.runRuntimeTransition(async (): Promise<void> => {
      changed = await this.catalog.setIdentityOptions(
        { did: params.did, options: normalized },
        lifecycleOptions,
        (): Promise<void> => this.disposeIdentitySessions(params.did),
        true,
      );
      if (!changed) {
        return;
      }
      this._pausedIdentities.delete(params.did);
      this._planner.invalidate();
      this.emit({ type: 'identity:registration-change', tenantDid: params.did, options: normalized });
      this.publishCatalogWake({ did: params.did, kind: 'identity' });
      await this.refreshLiveTargets(false, params.did);
    });
    return changed;
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
        this._pausedIdentities.set(params.did, params.delegateDid);
        try {
          await this.disposeIdentitySessions(params.did);
          for (const link of await this._ledger.getAllLinks()) {
            const belongsToIdentity = link.tenantDid === params.did ||
              (link.authorization.kind === 'role' && link.authorization.actorDid === params.did);
            if (belongsToIdentity && link.delegateDid === params.delegateDid) {
              await this._ledger.setLinkStatus(link, 'authorization-paused');
            }
          }
        } catch (error: unknown) {
          this._pausedIdentities.delete(params.did);
          throw error;
        }
      });
      if (!paused) {
        return;
      }
      this._planner.invalidate();
      await this.refreshLiveTargets(false, params.did);
    });
    return paused;
  }

  public async removeIdentity(
    did: string,
    lifecycleOptions: SyncLifecycleOptions = {},
  ): Promise<void> {
    await this.runRuntimeTransition(async (): Promise<void> => {
      const removed = await this.catalog.removeIdentity(did, lifecycleOptions, async (): Promise<void> => {
        await this.disposeIdentitySessions(did);
        await this._ledger.deleteForTenant(did);
        for (const link of await this._ledger.getAllLinks()) {
          if (link.authorization.kind === 'role' && link.authorization.actorDid === did) {
            await this._ledger.retireLink(link);
          }
        }
      });
      if (!removed) {
        return;
      }
      this._pausedIdentities.delete(did);
      this._planner.invalidate();
      this.emit({ type: 'identity:registration-change', tenantDid: did });
      this.publishCatalogWake({ did, kind: 'identity' });
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
      this.publishCatalogWake({ deleted: false, kind: 'followed-source', source: followed });
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
        const identity = await this._identityStore.get(current.actorDid);
        const target = SyncEngineNext.normalizeTarget(
          await this.targetResolver.buildTargetForSource(current, identity?.delegateDid),
        );
        await this.disposeSession(target);
        await this._ledger.deleteLinkAndSparse({
          authorizationEpoch : target.authorizationEpoch,
          projectionId       : target.projectionId,
          remoteEndpoint     : target.dwnUrl,
          tenantDid          : target.did,
        });
      });
      if (removed === undefined) {
        return;
      }
      this._planner.invalidate();
      this.emitFollowedSourceChange(removed, undefined);
      this.publishCatalogWake({ deleted: true, kind: 'followed-source', source: removed });
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
        active.session.requestPull();
      }
    }
    return true;
  }

  public async pullFollowedSource(source: FollowedSyncSource): Promise<boolean> {
    const expected = normalizeFollowedSyncSource(source);
    const runtimeGeneration = this._runtimeGeneration;
    try {
      return await this.runExclusive(async (): Promise<boolean> => {
        if (runtimeGeneration !== this._runtimeGeneration) {
          return false;
        }
        return this.runFollowedSourcePull(expected, runtimeGeneration);
      });
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
    if (this._runtimeTransitionDepth > 0) {
      return Promise.reject(new Error('SyncEngineNext: sync run cancelled by a runtime transition.'));
    }
    if (this.hasExclusiveWork || this._pendingSyncRun !== undefined) {
      return this.joinPendingSyncRun(direction, options);
    }
    return this.runExclusive((): Promise<void> => this.runCoveringSync(direction, options));
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
    if (this.hasExclusiveWork || this._pendingSyncRun !== undefined) {
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
    this._catalogClosed = true;
    this._catalogChannel?.close();
    await this._catalogWakeTail;
    await this._db.close();
  }

  public async getDeadLetters(tenantDid?: string): Promise<DeadLetterEntry[]> {
    void tenantDid;
    return [];
  }

  public async getSyncHealth(): Promise<SyncHealthSummary> {
    return this.readHealth();
  }

  public async getIdentitySyncStatus(tenantDid: string): Promise<SyncIdentityStatus> {
    const [delivery, durableLinks, quarantine, registration] = await Promise.all([
      this._ledger.getDeliveryForTenant(tenantDid),
      this._ledger.getLinksForTenant(tenantDid),
      this._ledger.getQuarantineForTenant(tenantDid),
      this.getIdentityOptions(tenantDid),
    ]);
    const links = this.linkSnapshots(durableLinks);
    const degradedKeys = new Set([
      ...durableLinks.filter(link => link.status === 'authorization-paused').map(SyncEngineNext.healthKey),
      ...delivery.map(SyncEngineNext.healthKey),
      ...quarantine.map(SyncEngineNext.healthKey),
    ]);
    const quotaBlockedMessageCount = delivery.filter(entry => entry.outcome.reason === 'quota').length;
    const connectivity = resolveSyncConnectivityState(links.map(link => link.connectivity), this.connectivityState);
    const health: SyncHealthSummary = {
      connectivity,
      degradedLinkCount  : degradedKeys.size,
      failedMessageCount : 0,
      quotaBlockedMessageCount,
      syncHealthy        : degradedKeys.size === 0,
    };
    const endpoints = new Set([
      ...links.map(link => link.remoteEndpoint),
      ...delivery.map(entry => entry.remoteEndpoint),
      ...quarantine.map(entry => entry.remoteEndpoint),
    ]);
    const remotes = [...endpoints].map(remoteEndpoint => {
      const remoteLinks = links.filter(link => link.remoteEndpoint === remoteEndpoint);
      const failedMessageCount = 0;
      const quotaBlockedMessageCount = delivery.filter(entry =>
        entry.tenantDid === tenantDid &&
        entry.remoteEndpoint === remoteEndpoint &&
        entry.outcome.reason === 'quota'
      ).length;
      const remoteConnectivity = resolveSyncConnectivityState(remoteLinks.map(link => link.connectivity));
      const pending = delivery.some(entry => entry.remoteEndpoint === remoteEndpoint) ||
        quarantine.some(entry => entry.remoteEndpoint === remoteEndpoint);
      const degraded = failedMessageCount > 0 || pending || remoteLinks.some(link => link.status === 'paused');
      return {
        connectivity : remoteConnectivity,
        failedMessageCount,
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
      health,
      lastActivityAt,
      links,
      registration,
      remotes,
    };
  }

  public async getReplicationLinks(tenantDid?: string): Promise<ReplicationLinkSnapshot[]> {
    const links = tenantDid === undefined
      ? await this._ledger.getAllLinks()
      : await this._ledger.getLinksForTenant(tenantDid);
    return this.linkSnapshots(links);
  }

  private linkSnapshots(links: Awaited<ReturnType<SyncNextLedgerStore['getAllLinks']>>): ReplicationLinkSnapshot[] {
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
        status           : link.status === 'authorization-paused'
          ? 'paused'
          : active?.subscribed === true ? 'live' : 'initializing',
        tenantDid: link.tenantDid,
      };
    });
  }

  public async retryRemoteNow(tenantDid: string, remoteEndpoint: string): Promise<void> {
    if (this._runtimeTransitionDepth > 0) {
      throw new Error('SyncEngineNext: retry cancelled by a runtime transition.');
    }
    const runtimeGeneration = this._runtimeGeneration;
    await this.runExclusive(async (): Promise<void> => {
      if (runtimeGeneration !== this._runtimeGeneration) {
        throw new Error('SyncEngineNext: queued retry was cancelled by a runtime transition.');
      }
      await this.runRetryRemoteNow(tenantDid, remoteEndpoint);
    });
  }

  /**
   * Explicit disaster recovery for current links at one remote.
   *
   * Pull rebuild first resets every current source for a logical target, then
   * purges its unreadable quarantine so a crash can only cause a conservative
   * rescan. Ordinary retry paths never call this destructive operation.
   */
  public async rebuildRemoteDirection({
    direction,
    remoteEndpoint,
    tenantDid,
  }: SyncEngineNextRebuildParams): Promise<void> {
    if (this._runtimeTransitionDepth > 0) {
      throw new Error('SyncEngineNext: rebuild cancelled by a runtime transition.');
    }
    const endpoint = normalizeDwnEndpoint(remoteEndpoint);
    await this.runRuntimeTransition(async (): Promise<void> => {
      const planned = (await this._planner.getTargets()).map(SyncEngineNext.normalizeTarget);
      const targets = planned.filter(target =>
        target.did === tenantDid &&
        normalizeDwnEndpoint(target.dwnUrl) === endpoint &&
        (direction === 'pull' || target.authorization.kind !== 'role')
      );
      if (!this._planner.lastResolutionComplete) {
        throw new Error('SyncEngineNext: cannot rebuild while sync target resolution is incomplete.');
      }
      if (targets.length === 0) {
        throw new Error('SyncEngineNext: cannot rebuild without a current authorized source link.');
      }

      const logicalTargetIds = new Set(targets.map(target => `${target.did}^${target.projectionId}`));
      const resetTargets = direction === 'pull'
        ? planned.filter(target => logicalTargetIds.has(`${target.did}^${target.projectionId}`))
        : targets;
      await Promise.all(resetTargets.map(target => this.ensureSession(target)));
      await Promise.all(resetTargets.map(target => this.disposeSession(target)));
      const links = (await Promise.all(resetTargets.map(target => this._ledger.getLink({
        authorizationEpoch : target.authorizationEpoch,
        projectionId       : target.projectionId,
        remoteEndpoint     : target.dwnUrl,
        tenantDid          : target.did,
      })))).filter(link => link !== undefined);
      if (links.length === 0) {
        throw new Error('SyncEngineNext: cannot rebuild a link that has no durable checkpoint.');
      }

      for (const link of links) {
        await this._ledger.rebuildDirection(link, direction);
      }
      if (direction === 'pull') {
        for (const logicalTargetId of logicalTargetIds) {
          await this._ledger.purgeQuarantineForLogicalTarget(logicalTargetId);
        }
      }

      try {
        const active = await Promise.all(targets.map(target => this.ensureSession(target)));
        const outcomes = await this.settleCovers(active, direction);
        const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected'
        );
        if (failures.length > 0) {
          throw new AggregateError(failures.map(({ reason }) => reason), 'SyncEngineNext: rebuild sync failed.');
        }
      } finally {
        if (this._live) {
          await this.refreshLiveTargets(false, tenantDid);
        } else {
          await Promise.allSettled(targets.map(target => this.disposeSession(target)));
        }
      }
    });
  }

  private async runRetryRemoteNow(tenantDid: string, remoteEndpoint: string): Promise<void> {
    const normalizedEndpoint = normalizeDwnEndpoint(remoteEndpoint);
    const targets = (await this._planner.getTargets()).map(SyncEngineNext.normalizeTarget).filter(target =>
      target.did === tenantDid && normalizeDwnEndpoint(target.dwnUrl) === normalizedEndpoint
    );
    const outcomes: PromiseSettledResult<void>[] = [];
    try {
      const active = await Promise.all(targets.map(target => this.ensureSession(target)));
      for (const { session } of active) {
        session.clearRetryBackoff();
      }
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
    const planned = (await this._planner.getTargets()).map(SyncEngineNext.normalizeTarget).filter(target =>
      normalizeDwnEndpoint(target.dwnUrl) === endpoint
    );
    const planComplete = this._planner.lastResolutionComplete;

    try {
      const active = await Promise.all(planned.map(target => this.ensureSession(target)));
      const shouldContinue = (): boolean => !isSignalAborted(options.signal) &&
        runtimeGeneration === this._runtimeGeneration &&
        topologyGeneration === this._planner.topologyGeneration;
      const targetOutcomes = await Promise.allSettled(active.map(({ session, target }) =>
        this.drainTarget(target, session, shouldContinue, options)
      ));
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
    session: SyncNextLinkSession,
    shouldContinue: () => boolean,
    options: SyncDrainOptions,
  ): Promise<SyncDrainTargetResult> {
    let convergence: {
      converged: boolean;
      error?: string;
      localFingerprint?: string;
      remoteFingerprint?: string;
    };
    const transfers = await Promise.allSettled([
      session.cover('pull', shouldContinue),
      session.cover('push', shouldContinue),
    ]);
    const transferError = transfers
      .find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')?.reason;
    try {
      if (transferError !== undefined) {
        throw transferError;
      }
      if (!shouldContinue()) {
        throw options.signal?.reason ?? new DOMException('Drain cancelled.', 'AbortError');
      }
      convergence = await this.verifyStableConvergenceAtEndpoint(target, shouldContinue);
    } catch (error: unknown) {
      convergence = { converged: false, error: error instanceof Error ? error.message : String(error) };
    }
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
    const [delivery, quarantine] = await Promise.all([
      this._ledger.getDeliveryForLink(link),
      this._ledger.getQuarantineForLink(link),
    ]);
    const cancelled = isSignalAborted(options.signal);
    const completed = convergence.converged &&
      delivery.length === 0 &&
      quarantine.length === 0 &&
      shouldContinue();
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
    pending.promise = this.runExclusive(async (): Promise<void> => {
      if (this._pendingSyncRun === pending) {
        this._pendingSyncRun = undefined;
      }
      if (pending.cancelled) {
        throw new Error('SyncEngineNext: queued sync run was cancelled by a runtime transition.');
      }
      await this.runCoveringSync(
        merged.directionConflict ? undefined : merged.direction,
        {
          ...(merged.unscoped || merged.did === undefined ? {} : { did: merged.did }),
          ...(merged.verifyConvergence ? { verifyConvergence: true } : {}),
        },
      );
    });
    this._pendingSyncRun = pending;
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
    const allTargets = (await this._planner.getTargets()).map(SyncEngineNext.normalizeTarget);
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
        outcomes.push(...await Promise.allSettled(targets.map(async (target): Promise<void> => {
          if (!shouldContinue()) {
            throw new Error('SyncEngineNext: convergence proof cancelled by a runtime transition.');
          }
          const convergence = await this.verifyStableConvergenceAtEndpoint(target, shouldContinue);
          if (!convergence.converged) {
            throw new Error(convergence.error ?? 'SyncEngineNext: feed fingerprints did not converge.');
          }
        })));
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

  private async refreshLiveTargets(initialCover = false, wakeDid?: string): Promise<void> {
    if (!this._live) {
      return;
    }
    const targets = (await this._planner.getTargets()).map(SyncEngineNext.normalizeTarget);
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
          this.scheduleSubscriptionRetry(error);
          console.error('SyncEngineNext: subscription establishment failed', error);
        }
      }
    }));
    if (initialCover) {
      await this.settleCovers(active, 'pull');
      await this.settleCovers(active, 'push');
    }
    for (const { session, target } of active) {
      if (wakeDid === undefined || SyncEngineNext.targetBelongsToIdentity(target, wakeDid)) {
        session.start(!initialCover);
      }
    }
  }

  private async ensureSession(target: SyncTarget): Promise<ActiveSession> {
    target = SyncEngineNext.normalizeTarget(target);
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
    console.warn('SyncEngineNext: subscription ended; scheduled refresh will retry it', error);
    this.scheduleSubscriptionRetry(error);
  }

  private async createSession(target: SyncTarget, key: string): Promise<ActiveSession> {
    const link = await this._ledger.getOrCreateLink({
      authorization      : target.authorization,
      authorizationEpoch : target.authorizationEpoch,
      delegateDid        : target.delegateDid,
      logicalTargetId    : `${target.did}^${target.projectionId}`,
      projectionId       : target.projectionId,
      remoteEndpoint     : target.dwnUrl,
      scope              : target.scope,
      tenantDid          : target.did,
    });
    if (link.status === 'authorization-paused') {
      await this._ledger.setLinkStatus(link, 'active');
    }
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
    }, (pullTarget): Promise<SyncTarget> => this.targetResolver.withCurrentRoleGrant(pullTarget));
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
        this.quarantineRetry,
        (error): void => { console.error('SyncEngineNext: link work failed', error); },
        {
          block : (delayMs): void => { this._endpointGate.block(target.dwnUrl, delayMs); },
          clear : (): void => { this._endpointGate.clear(target.dwnUrl); },
          run   : operation => this._endpointGate.run(target.dwnUrl, operation),
        },
        {
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
    return Promise.allSettled(active.map(({ session }) => {
      if (!shouldContinue()) {
        return Promise.reject(new Error('SyncEngineNext: covering work was interrupted.'));
      }
      return session.cover(direction, shouldContinue);
    }));
  }

  /** Keep finite fingerprint proofs serial per endpoint without serializing page coverage. */
  private verifyStableConvergenceAtEndpoint(
    target: SyncTarget,
    shouldContinue: () => boolean,
  ): ReturnType<SyncEngineNext['verifyStableConvergence']> {
    return runSerializedByKey(
      this._operations,
      `convergence:${normalizeDwnEndpoint(target.dwnUrl)}`,
      (): ReturnType<SyncEngineNext['verifyStableConvergence']> =>
        this.verifyStableConvergence(target, shouldContinue),
    );
  }

  private async pruneSupersededLinks(targets: readonly SyncTarget[]): Promise<void> {
    if (!this._planner.lastResolutionComplete) {
      return;
    }
    const current = new Set(targets.map(SyncEngineNext.targetKey));
    const currentLogicalTargets = new Set(targets.map(target => `${target.did}^${target.projectionId}`));
    for (const link of await this._ledger.getAllLinks()) {
      const key = buildLinkKey(
        link.tenantDid,
        link.remoteEndpoint,
        link.projectionId,
        link.authorizationEpoch,
      );
      if (!current.has(key)) {
        await this.disposeSession(link);
        if (currentLogicalTargets.has(link.logicalTargetId)) {
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
      : buildLinkKey(target.tenantDid, target.remoteEndpoint, target.projectionId, target.authorizationEpoch);
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
    if (this._subscriptionRetryTimer !== undefined) {
      clearTimeout(this._subscriptionRetryTimer);
      this._subscriptionRetryTimer = undefined;
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

  private scheduleSubscriptionRetry(error: unknown): void {
    if (!this._live || this._subscriptionRetryTimer !== undefined) {
      return;
    }
    const delay = error instanceof RateLimitError ? error.retryAfterSec * 1_000 : 5_000;
    this._subscriptionRetryTimer = setTimeout((): void => {
      this._subscriptionRetryTimer = undefined;
      this.scheduleLiveRefresh();
    }, delay);
  }

  /** Validate and serialize catalog wakes from sibling contexts. */
  private scheduleCatalogWake(value: unknown): void {
    const message = SyncEngineNext.catalogWake(value);
    if (this._catalogClosed || message === undefined) {
      return;
    }
    const operation = message.kind === 'identity'
      ? (): Promise<void> => this.applyExternalIdentityChange(message.did)
      : (): Promise<void> => this.applyExternalFollowedSourceChange(message.source, message.deleted);
    const wake = this._catalogWakeTail.then(operation, operation).catch((error: unknown): void => {
      if (!this._catalogClosed) {
        console.error('SyncEngineNext: cross-context catalog refresh failed', error);
      }
    });
    this._catalogWakeTail = wake;
  }

  private async applyExternalIdentityChange(did: string): Promise<void> {
    await this.runRuntimeTransition(async (): Promise<void> => {
      await this.disposeIdentitySessions(did);
      const options = await this._identityStore.get(did);
      this._pausedIdentities.delete(did);
      if (options === undefined) {
        await this._ledger.deleteForTenant(did);
        for (const link of await this._ledger.getAllLinks()) {
          if (link.authorization.kind === 'role' && link.authorization.actorDid === did) {
            await this._ledger.retireLink(link);
          }
        }
      }
      this._planner.invalidate();
      this.emit(options === undefined
        ? { type: 'identity:registration-change', tenantDid: did }
        : { type: 'identity:registration-change', tenantDid: did, options });
      await this.refreshLiveTargets(false, did);
    });
  }

  private async applyExternalFollowedSourceChange(
    source: FollowedSyncSource,
    deleted: boolean,
  ): Promise<void> {
    await this.runRuntimeTransition(async (): Promise<void> => {
      await this.disposeFollowedContextSessions(source);
      if (deleted) {
        await this.deleteRoleLinkAndSparse(source);
      }
      this._planner.invalidate();
      this.emitFollowedSourceChange(source, deleted ? undefined : source.id);
      await this.refreshLiveTargets(false, source.actorDid);
    });
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

  private publishCatalogWake(message: CatalogWake): void {
    try {
      this._catalogChannel?.postMessage(message);
    } catch {
      // Cross-context notification is best effort; durable catalog state remains authoritative.
    }
  }

  private runRuntimeTransition(operation: () => Promise<void>): Promise<void> {
    this._runtimeGeneration++;
    this._runtimeTransitionDepth++;
    if (this._pendingSyncRun !== undefined) {
      this._pendingSyncRun.cancelled = true;
      this._pendingSyncRun = undefined;
    }
    return this.runExclusive(operation).finally((): void => {
      this._runtimeTransitionDepth--;
    });
  }

  private get hasExclusiveWork(): boolean {
    return this._operations.has('engine');
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

  private async readHealth(tenantDid?: string): Promise<SyncHealthSummary> {
    const [delivery, links, quarantine] = await Promise.all([
      this._ledger.getAllDelivery(),
      this._ledger.getAllLinks(),
      this._ledger.getAllQuarantine(),
    ]);
    const currentLinks = links.filter(link => tenantDid === undefined || link.tenantDid === tenantDid);
    const currentDelivery = delivery.filter(entry => tenantDid === undefined || entry.tenantDid === tenantDid);
    const currentQuarantine = quarantine.filter(entry => tenantDid === undefined || entry.tenantDid === tenantDid);
    const degradedKeys = new Set([
      ...currentLinks.filter(link => link.status === 'authorization-paused').map(SyncEngineNext.healthKey),
      ...currentDelivery.map(SyncEngineNext.healthKey),
      ...currentQuarantine.map(SyncEngineNext.healthKey),
    ]);
    const quotaBlockedMessageCount = currentDelivery.filter(entry => entry.outcome.reason === 'quota').length;
    return {
      connectivity       : this.connectivityState,
      degradedLinkCount  : degradedKeys.size,
      failedMessageCount : 0,
      quotaBlockedMessageCount,
      syncHealthy        : degradedKeys.size === 0,
    };
  }

  private static targetKey(target: SyncTarget): string {
    return buildLinkKey(
      target.did,
      normalizeDwnEndpoint(target.dwnUrl),
      target.projectionId,
      target.authorizationEpoch,
    );
  }

  private static normalizeTarget(target: SyncTarget): SyncTarget {
    const dwnUrl = normalizeDwnEndpoint(target.dwnUrl);
    return dwnUrl === target.dwnUrl ? target : { ...target, dwnUrl };
  }

  private static targetBelongsToIdentity(target: SyncTarget, did: string): boolean {
    return target.did === did ||
      (target.authorization.kind === 'role' && target.authorization.actorDid === did);
  }

  private static catalogWake(value: unknown): CatalogWake | undefined {
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const candidate = value as { deleted?: unknown; did?: unknown; kind?: unknown; source?: unknown };
    if (candidate.kind === 'identity' && typeof candidate.did === 'string') {
      return { did: candidate.did, kind: 'identity' };
    }
    if (candidate.kind !== 'followed-source' || typeof candidate.deleted !== 'boolean') {
      return;
    }
    try {
      return {
        deleted : candidate.deleted,
        kind    : 'followed-source',
        source  : normalizeFollowedSyncSource(candidate.source as FollowedSyncSource),
      };
    } catch {
      return;
    }
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

}
