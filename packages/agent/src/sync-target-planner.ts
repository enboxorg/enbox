import type { SyncIdentityOptions } from './types/sync.js';
import type { SyncIdentityStore } from './sync-identity-store.js';
import type { FollowedSyncSource, FollowedSyncSourceStore } from './followed-sync-source.js';
import type { SyncTarget, SyncTargetResolution } from './sync-target-resolver.js';

import { isDidResolutionUnavailableError } from './did-resolution-error.js';
import { syncScopeFromProtocols } from './types/sync.js';

/** Target-resolution surface required to plan registered sync targets. */
export interface SyncTargetPlanningResolver {
  getEndpointUrls(did: string): Promise<string[]>;
  buildTargetResolutions(
    did: string,
    scope: ReturnType<typeof syncScopeFromProtocols>,
    options: SyncIdentityOptions,
  ): Promise<SyncTargetResolution[]>;
  buildTargetsForEndpoint(
    did: string,
    dwnUrl: string,
    options: SyncIdentityOptions,
    resolvedTargets?: SyncTargetResolution[],
  ): Promise<SyncTarget[]>;
  buildTargetForSource(
    source: FollowedSyncSource,
    delegateDid?: string,
  ): Promise<SyncTarget>;
}

export type SyncTargetPlannerParams = {
  cacheTtlMs?: number;
  getTargetResolver: () => SyncTargetPlanningResolver;
  identityStore: SyncIdentityStore;
  sourceStore: FollowedSyncSourceStore;
  now?: () => number;
  isIdentityPaused?: (did: string, delegateDid?: string) => boolean;
  handleAuthorizationFailure?: (did: string, options: SyncIdentityOptions, error: unknown) => Promise<boolean>;
  warn?: (message: string, error: unknown) => void;
};

export type SyncTargetPlanningOptions = {
  /** Run engine-owned pruning before a complete target snapshot is cached. */
  beforeCache?: (targets: SyncTarget[], topologyGeneration: number) => Promise<void>;
};

type SyncTargetCache = {
  targets: SyncTarget[];
  timestamp: number;
};

type RegisteredIdentityTargets = {
  targets: SyncTarget[];
  unavailable: boolean;
};

/**
 * Plans and caches canonical sync targets for every registered identity.
 *
 * Persistence and target resolution are supplied through backend-neutral
 * contracts. Engine-specific lifecycle and pruning policy remains outside.
 */
export class SyncTargetPlanner {
  private static readonly DEFAULT_CACHE_TTL_MS = 30_000;

  private _cache?: SyncTargetCache;
  private readonly _cacheTtlMs: number;
  private readonly _getTargetResolver: () => SyncTargetPlanningResolver;
  private readonly _identityStore: SyncIdentityStore;
  private readonly _isIdentityPaused: NonNullable<SyncTargetPlannerParams['isIdentityPaused']>;
  private readonly _handleAuthorizationFailure: NonNullable<SyncTargetPlannerParams['handleAuthorizationFailure']>;
  private readonly _sourceStore: FollowedSyncSourceStore;
  private _lastResolutionComplete = false;
  private readonly _now: () => number;
  private _topologyGeneration = 0;
  private readonly _warn: (message: string, error: unknown) => void;

  constructor({
    cacheTtlMs = SyncTargetPlanner.DEFAULT_CACHE_TTL_MS,
    getTargetResolver,
    identityStore,
    isIdentityPaused = (): boolean => false,
    handleAuthorizationFailure = async (): Promise<boolean> => false,
    sourceStore,
    now = (): number => Date.now(),
    warn = (message, error): void => { console.warn(message, error); },
  }: SyncTargetPlannerParams) {
    this._cacheTtlMs = cacheTtlMs;
    this._getTargetResolver = getTargetResolver;
    this._identityStore = identityStore;
    this._isIdentityPaused = isIdentityPaused;
    this._handleAuthorizationFailure = handleAuthorizationFailure;
    this._sourceStore = sourceStore;
    this._now = now;
    this._warn = warn;
  }

  /** Monotonic topology version used to reject work planned before invalidation. */
  public get topologyGeneration(): number {
    return this._topologyGeneration;
  }

  /** Whether the latest uncached resolution covered every registration. */
  public get lastResolutionComplete(): boolean {
    return this._lastResolutionComplete;
  }

  /** Invalidate cached targets and advance the topology generation. */
  public invalidate(): void {
    this._cache = undefined;
    this._lastResolutionComplete = false;
    this._topologyGeneration++;
  }

  /** Resolve every registered identity into canonical sync targets. */
  public async getTargets({ beforeCache }: SyncTargetPlanningOptions = {}): Promise<SyncTarget[]> {
    if (this._cache !== undefined && (this._now() - this._cache.timestamp) < this._cacheTtlMs) {
      this._lastResolutionComplete = true;
      return this._cache.targets;
    }

    const topologyGenerationAtStart = this._topologyGeneration;
    const targets: SyncTarget[] = [];
    let hasRegistrations = false;
    let anyTargetUnavailable = false;
    this._lastResolutionComplete = false;

    for await (const entry of this._identityStore.entries()) {
      hasRegistrations = true;
      if (entry.status === 'corrupt') {
        this._warn(`SyncEngineLevel: Corrupt sync options for ${entry.did}, skipping identity:`, entry.error);
        anyTargetUnavailable = true;
        continue;
      }

      const resolved = await this.resolveIdentity(entry.did, entry.options);
      targets.push(...resolved.targets);
      anyTargetUnavailable ||= resolved.unavailable;
    }

    for (const entry of await this._sourceStore.list()) {
      hasRegistrations = true;
      if (entry.status === 'corrupt') {
        this._warn(`SyncEngineLevel: Corrupt followed source ${entry.id}, skipping source:`, entry.error);
        anyTargetUnavailable = true;
        continue;
      }

      const identity = await this._identityStore.get(entry.source.actorDid);
      if (identity === undefined) {
        anyTargetUnavailable = true;
        continue;
      }
      if (this._isIdentityPaused(entry.source.actorDid, identity.delegateDid)) {
        continue;
      }
      targets.push(await this._getTargetResolver().buildTargetForSource(entry.source, identity.delegateDid));
    }

    await this.cacheCompleteTargets({
      anyTargetUnavailable,
      beforeCache,
      topologyGenerationAtStart,
      hasRegistrations,
      targets,
    });
    return targets;
  }

  /** Shared prerequisite for endpoint planning and durable-link retention. */
  public async resolveAuthorization(did: string, options: SyncIdentityOptions): Promise<SyncTargetResolution[] | undefined> {
    if (this._isIdentityPaused(did, options.delegateDid)) {
      return undefined;
    }
    try {
      return await this._getTargetResolver().buildTargetResolutions(did, syncScopeFromProtocols(options.protocols), options);
    } catch (error: unknown) {
      if (await this._handleAuthorizationFailure(did, options, error)) {
        return undefined;
      }
      throw error;
    }
  }

  /** Resolve shared authorization once before materializing endpoint-specific targets. */
  public async resolveIdentity(did: string, options: SyncIdentityOptions): Promise<RegisteredIdentityTargets> {
    let resolutions: SyncTargetResolution[] | undefined;
    try {
      resolutions = await this.resolveAuthorization(did, options);
    } catch (error: unknown) {
      if (isDidResolutionUnavailableError(error)) {
        throw error;
      }
      this._warn(`SyncEngineLevel: Unable to resolve sync authorization for ${did}, skipping identity:`, error);
      return { targets: [], unavailable: true };
    }
    if (resolutions === undefined) {
      return { targets: [], unavailable: false };
    }
    const resolver = this._getTargetResolver();
    const dwnEndpointUrls = await resolver.getEndpointUrls(did);
    if (dwnEndpointUrls.length === 0) {
      return { targets: [], unavailable: true };
    }

    const targets: SyncTarget[] = [];
    let unavailable = false;
    for (const dwnUrl of dwnEndpointUrls) {
      try {
        targets.push(...await resolver.buildTargetsForEndpoint(did, dwnUrl, options, resolutions));
      } catch (error: unknown) {
        // Grant/signing prerequisites are shared by the identity's endpoints.
        // Let the supervisor defer this pass instead of repeating the lookup.
        if (isDidResolutionUnavailableError(error)) {
          throw error;
        }
        unavailable = true;
        this._warn(`SyncEngineLevel: Unable to resolve sync targets for ${did} at ${dwnUrl}, skipping identity endpoint:`, error);
      }
    }
    return { targets, unavailable };
  }

  private async cacheCompleteTargets({
    anyTargetUnavailable,
    beforeCache,
    topologyGenerationAtStart,
    hasRegistrations,
    targets,
  }: {
    anyTargetUnavailable: boolean;
    beforeCache: SyncTargetPlanningOptions['beforeCache'];
    topologyGenerationAtStart: number;
    hasRegistrations: boolean;
    targets: SyncTarget[];
  }): Promise<void> {
    const topologyGenerationIsCurrent = this._topologyGeneration === topologyGenerationAtStart;
    this._lastResolutionComplete = !anyTargetUnavailable && topologyGenerationIsCurrent;
    const isComplete = hasRegistrations && this._lastResolutionComplete;
    if (targets.length === 0 || !isComplete) {
      return;
    }

    await beforeCache?.(targets, topologyGenerationAtStart);
    if (this._topologyGeneration === topologyGenerationAtStart) {
      this._cache = { targets, timestamp: this._now() };
    } else {
      this._lastResolutionComplete = false;
    }
  }
}
