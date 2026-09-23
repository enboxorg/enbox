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
  warn?: (message: string, error: unknown) => void;
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
  private readonly _sourceStore: FollowedSyncSourceStore;
  private _lastResolutionComplete = false;
  private readonly _now: () => number;
  private _topologyGeneration = 0;
  private readonly _warn: (message: string, error: unknown) => void;

  constructor({
    cacheTtlMs = SyncTargetPlanner.DEFAULT_CACHE_TTL_MS,
    getTargetResolver,
    identityStore,
    sourceStore,
    now = (): number => Date.now(),
    warn = (message, error): void => { console.warn(message, error); },
  }: SyncTargetPlannerParams) {
    this._cacheTtlMs = cacheTtlMs;
    this._getTargetResolver = getTargetResolver;
    this._identityStore = identityStore;
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
  public async getTargets(): Promise<SyncTarget[]> {
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
        // Retain the source while its actor is inactive. Registration changes
        // invalidate the plan so it can include the source when the actor returns.
        continue;
      }
      targets.push(await this._getTargetResolver().buildTargetForSource(entry.source, identity.delegateDid));
    }

    this.cacheCompleteTargets({
      anyTargetUnavailable,
      topologyGenerationAtStart,
      hasRegistrations,
      targets,
    });
    return targets;
  }

  /** Resolve shared authorization once before materializing endpoint-specific targets. */
  private async resolveIdentity(did: string, options: SyncIdentityOptions): Promise<RegisteredIdentityTargets> {
    let resolutions: SyncTargetResolution[];
    try {
      resolutions = await this._getTargetResolver().buildTargetResolutions(
        did,
        syncScopeFromProtocols(options.protocols),
        options,
      );
    } catch (error: unknown) {
      if (isDidResolutionUnavailableError(error)) {
        throw error;
      }
      this._warn(`SyncEngineLevel: Unable to resolve sync authorization for ${did}, skipping identity:`, error);
      return { targets: [], unavailable: true };
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

  private cacheCompleteTargets({
    anyTargetUnavailable,
    topologyGenerationAtStart,
    hasRegistrations,
    targets,
  }: {
    anyTargetUnavailable: boolean;
    topologyGenerationAtStart: number;
    hasRegistrations: boolean;
    targets: SyncTarget[];
  }): void {
    const topologyGenerationIsCurrent = this._topologyGeneration === topologyGenerationAtStart;
    this._lastResolutionComplete = !anyTargetUnavailable && topologyGenerationIsCurrent;
    const isComplete = hasRegistrations && this._lastResolutionComplete;
    if (targets.length === 0 || !isComplete) {
      return;
    }

    if (this._topologyGeneration === topologyGenerationAtStart) {
      this._cache = { targets, timestamp: this._now() };
    } else {
      this._lastResolutionComplete = false;
    }
  }
}
