import type { SyncIdentityOptions } from './types/sync.js';
import type { SyncIdentityStore } from './sync-identity-store.js';
import type { SyncTarget } from './sync-target-resolver.js';

/** Target-resolution surface required to plan registered sync targets. */
export interface SyncTargetPlanningResolver {
  getEndpointUrls(did: string): Promise<string[]>;
  buildTargetsForEndpoint(did: string, dwnUrl: string, options: SyncIdentityOptions): Promise<SyncTarget[]>;
}

export type SyncTargetPlannerParams = {
  cacheTtlMs?: number;
  getTargetResolver: () => SyncTargetPlanningResolver;
  identityStore: SyncIdentityStore;
  now?: () => number;
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
  private _lastResolutionComplete = false;
  private readonly _now: () => number;
  private _topologyGeneration = 0;
  private readonly _warn: (message: string, error: unknown) => void;

  constructor({
    cacheTtlMs = SyncTargetPlanner.DEFAULT_CACHE_TTL_MS,
    getTargetResolver,
    identityStore,
    now = (): number => Date.now(),
    warn = (message, error): void => { console.warn(message, error); },
  }: SyncTargetPlannerParams) {
    this._cacheTtlMs = cacheTtlMs;
    this._getTargetResolver = getTargetResolver;
    this._identityStore = identityStore;
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
    let hasRegisteredIdentities = false;
    let anyTargetUnavailable = false;
    this._lastResolutionComplete = false;

    for await (const entry of this._identityStore.entries()) {
      hasRegisteredIdentities = true;
      if (entry.status === 'corrupt') {
        this._warn(`SyncEngineLevel: Corrupt sync options for ${entry.did}, skipping identity:`, entry.error);
        anyTargetUnavailable = true;
        continue;
      }

      const resolved = await this.resolveRegisteredIdentity(entry.did, entry.options);
      targets.push(...resolved.targets);
      anyTargetUnavailable ||= resolved.unavailable;
    }

    await this.cacheCompleteTargets({
      anyTargetUnavailable,
      beforeCache,
      topologyGenerationAtStart,
      hasRegisteredIdentities,
      targets,
    });
    return targets;
  }

  private async resolveRegisteredIdentity(did: string, options: SyncIdentityOptions): Promise<RegisteredIdentityTargets> {
    const dwnEndpointUrls = await this._getTargetResolver().getEndpointUrls(did);
    if (dwnEndpointUrls.length === 0) {
      return { targets: [], unavailable: true };
    }

    const targets: SyncTarget[] = [];
    let unavailable = false;
    for (const dwnUrl of dwnEndpointUrls) {
      try {
        targets.push(...await this._getTargetResolver().buildTargetsForEndpoint(did, dwnUrl, options));
      } catch (error: unknown) {
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
    hasRegisteredIdentities,
    targets,
  }: {
    anyTargetUnavailable: boolean;
    beforeCache: SyncTargetPlanningOptions['beforeCache'];
    topologyGenerationAtStart: number;
    hasRegisteredIdentities: boolean;
    targets: SyncTarget[];
  }): Promise<void> {
    const topologyGenerationIsCurrent = this._topologyGeneration === topologyGenerationAtStart;
    this._lastResolutionComplete = !anyTargetUnavailable && topologyGenerationIsCurrent;
    const isComplete = hasRegisteredIdentities && this._lastResolutionComplete;
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
