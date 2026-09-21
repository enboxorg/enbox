import type { AbstractLevel } from 'abstract-level';
import type { EnboxPlatformAgent } from '../types/agent.js';
import type { SyncTarget } from '../sync-target-resolver.js';
import type {
  DeadLetterEntry,
  ReplicationLinkSnapshot,
  StartSyncParams,
  SyncConnectivityState,
  SyncDirection,
  SyncDrainOptions,
  SyncDrainResult,
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
import { SyncTargetResolver } from '../sync-target-resolver.js';
import { MAX_TIMER_DELAY_MS, parseDurationInMilliseconds } from '@enbox/common';
import { normalizeSyncProtocols, projectReplicationCurrentness } from '../types/sync.js';

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
  private _resolver?: SyncTargetResolver;
  private readonly _sessions = new Map<string, ActiveSession>();
  private readonly _sourceStore: FollowedSyncSourceStoreLevel;
  private _syncTail: Promise<void> = Promise.resolve();
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
    const operation = this._syncTail.then((): Promise<void> => this.runCoveringSync(direction, options));
    this._syncTail = operation.catch((): void => {});
    return operation;
  }

  public async drainTo(endpoint: string, options: SyncDrainOptions = {}): Promise<SyncDrainResult> {
    await this._endpointStore.set(endpoint);
    this._planner.invalidate();
    if (options.signal?.aborted === true) {
      return { endpoint, completed: false, cancelled: true, topologyChanged: false, targets: [] };
    }
    try {
      await this.sync();
    } catch (error: unknown) {
      return {
        endpoint,
        completed       : false,
        cancelled       : Boolean(options.signal?.aborted),
        topologyChanged : false,
        targets         : [],
        error           : error instanceof Error ? error.message : String(error),
      };
    }
    const links = (await this.getReplicationLinks()).filter(link => link.remoteEndpoint === endpoint);
    return {
      endpoint,
      completed       : links.length > 0 && links.every(link => link.isPullCurrent),
      cancelled       : false,
      topologyChanged : false,
      targets         : links.map(link => ({
        completed      : link.isPullCurrent,
        converged      : link.isPullCurrent,
        remoteEndpoint : link.remoteEndpoint,
        scope          : link.scope,
        tenantDid      : link.tenantDid,
        cancelled      : false,
      })),
    };
  }

  public async startSync(params: StartSyncParams = {}): Promise<void> {
    const interval = Math.min(
      Math.max(parseDurationInMilliseconds(params.interval ?? '5m'), 1_000),
      MAX_TIMER_DELAY_MS,
    );
    await this.runTransition(async (): Promise<void> => {
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
      this.runTransition((): Promise<void> => this.stopRuntime()),
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
      }));
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
    const targets = (await this._planner.getTargets()).filter(target =>
      target.did === tenantDid && target.dwnUrl === remoteEndpoint
    );
    const active = await Promise.all(targets.map(target => this.ensureSession(target)));
    const outcomes = [
      ...await Promise.allSettled(active.map(({ session }) => session.cover('pull'))),
      ...await Promise.allSettled(active.map(({ session }) => session.cover('push'))),
    ];
    if (!this._live) {
      await Promise.all(targets.map(target => this.disposeSession(target)));
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

  private async runCoveringSync(direction: SyncDirection | undefined, options: SyncRunOptions): Promise<void> {
    if (options.did !== undefined && await this._identityStore.get(options.did) === undefined) {
      throw new Error(`SyncEngineNext: identity '${options.did}' is not registered.`);
    }
    const allTargets = await this._planner.getTargets();
    await this.pruneSupersededLinks(allTargets);
    const targets = allTargets.filter(target => options.did === undefined || target.did === options.did);
    const sessions = await Promise.all(targets.map(target => this.ensureSession(target)));
    const outcomes = direction === undefined
      ? [
        ...await Promise.allSettled(sessions.map(({ session }) => session.cover('pull'))),
        ...await Promise.allSettled(sessions.map(({ session }) => session.cover('push'))),
      ]
      : await Promise.allSettled(sessions.map(({ session }) => session.cover(direction)));
    if (!this._live) {
      await Promise.all(targets.map(target => this.disposeSession(target)));
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
      await Promise.allSettled(active.map(({ session }) => session.cover('pull')));
      await Promise.allSettled(active.map(({ session }) => session.cover('push')));
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
    const pullPage = new SyncNextPullPage(this.agent, this._ledger, this._echoSuppressor);
    const pushPage = new SyncNextPushPage(this.agent, this._ledger, this._echoSuppressor);
    const active: ActiveSession = {
      session: new SyncNextLinkSession(
        target,
        this._ledger,
        pullPage,
        pushPage,
        new SyncNextQuarantineRetry(this.agent, this._ledger),
        new SyncNextDeliveryRetry(this.agent, this._ledger),
        (error): void => { console.error('SyncEngineNext: link work failed', error); },
      ),
      subscribed: false,
      target,
    };
    this._sessions.set(key, active);
    return active;
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

  private runTransition(operation: () => Promise<void>): Promise<void> {
    const transition = this._transition.then(operation, operation);
    this._transition = transition.catch((): void => {});
    return transition;
  }

  private emit(event: SyncEvent): void {
    for (const listener of this._eventListeners) {
      listener(event);
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
