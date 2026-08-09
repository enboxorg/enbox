import type { DidResolverCacheLevelParams } from '@enbox/dids/resolver-cache-level';
import type { DidResolutionResult, DidResolverCache } from '@enbox/dids';

import type { EnboxPlatformAgent } from './types/agent.js';

import { DidResolverCacheLevel } from '@enbox/dids/resolver-cache-level';


/**
 * AgentDidResolverCache keeps a stale copy of the Agent's managed Identity DIDs and only evicts and refreshes upon a successful resolution.
 * This allows for quick and offline access to the internal DIDs used by the agent.
 */
export class AgentDidResolverCache extends DidResolverCacheLevel implements DidResolverCache {
  /** Delay before retrying a managed DID resolution that failed while its stale value was retained. */
  private static readonly FAILED_REFRESH_RETRY_MS = 5_000;

  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentDidApi`. This agent is used to interact with other Enbox agent components. It's vital
   * to ensure this instance is set to correctly contextualize operations within the broader Enbox
   * Agent framework.
   */
  private _agent?: EnboxPlatformAgent;

  /** Coalesces stale refreshes so one expired DID produces at most one network resolution. */
  private readonly _refreshing = new Map<string, Promise<StaleDidRefresh>>();

  /** Prevents sequential cache reads from repeatedly resolving the same managed DID while offline. */
  private readonly _failedRefreshRetryAfter = new Map<string, number>();

  constructor({ agent, db, location, ttl }: DidResolverCacheLevelParams & { agent?: EnboxPlatformAgent }) {
    super ({ db, location, ttl });
    this._agent = agent;
  }

  get agent(): EnboxPlatformAgent {
    if (!this._agent) {
      throw new Error('Agent not initialized');
    }
    return this._agent;
  }

  set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
  }

  /**
   * Get the DID resolution result from the cache for the given DID.
   *
   * If the DID is managed by the agent, or is the agent's own DID, it will not evict it from the cache until a new resolution is successful.
   * This is done to achieve quick and offline access to the agent's own managed DIDs.
   */
  async get(did: string): Promise<DidResolutionResult | void> {
    try {
      const str = await this.cache.get(did);
      const cachedResult = JSON.parse(str) as { ttlMillis: number; value: DidResolutionResult };
      if (Date.now() < cachedResult.ttlMillis) {
        return cachedResult.value;
      }

      const refresh = await this.refreshStaleDid(did);
      if (!refresh.isManaged) {
        return;
      }

      // Managed DIDs retain their last known document for offline use, but a successful refresh
      // is returned immediately rather than making this first post-TTL operation use stale routes.
      return refresh.value ?? cachedResult.value;
    } catch (error: any) {
      if (error.notFound) {
        return;
      }
      throw error;
    }
  }

  /** Stores an authoritative result and removes any failed-refresh retry delay for the DID. */
  public override async set(did: string, value: DidResolutionResult): Promise<void> {
    await super.set(did, value);
    this._failedRefreshRetryAfter.delete(did);
  }

  /** Deletes a cached result and its failed-refresh retry state. */
  public override async delete(did: string): Promise<void> {
    await super.delete(did);
    this._failedRefreshRetryAfter.delete(did);
  }

  /** Clears all cached results and failed-refresh retry state. */
  public override async clear(): Promise<void> {
    await super.clear();
    this._failedRefreshRetryAfter.clear();
  }

  /**
   * Re-resolves a DID that is managed by the agent (or is the agent's own DID) after its cache
   * entry has gone stale. If the DID is not found in the DID Store, its cache entry is evicted.
   * Otherwise, the cache entry is kept until a new resolution succeeds, at which point both the
   * store and the cache are updated with the newly resolved Document.
   */
  private async refreshStaleDid(did: string): Promise<StaleDidRefresh> {
    const retryAfter = this._failedRefreshRetryAfter.get(did);
    if (retryAfter !== undefined) {
      if (Date.now() < retryAfter) {
        return { isManaged: true };
      }
      this._failedRefreshRetryAfter.delete(did);
    }

    const inFlight = this._refreshing.get(did);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const refresh = this.performStaleDidRefresh(did);
    this._refreshing.set(did, refresh);
    try {
      return await refresh;
    } finally {
      this._refreshing.delete(did);
    }
  }

  private async performStaleDidRefresh(did: string): Promise<StaleDidRefresh> {
    const isAgentDid = did === this.agent.agentDid.uri;
    const storedDid = isAgentDid
      ? undefined
      : await this.agent.did.get({ didUri: did, tenant: this.agent.agentDid.uri });

    if (!isAgentDid && storedDid === undefined) {
      this._failedRefreshRetryAfter.delete(did);
      this.cache.nextTick(() => this.delete(did));
      return { isManaged: false };
    }

    try {
      // The core operation bypasses this cache and generation-conditionally
      // reconciles a managed DID. Calling ordinary `resolve` here would recurse
      // through this same stale entry.
      const result = await this.agent.did.refreshResolutionAndReconcile({
        didUri : did,
        tenant : this.agent.agentDid.uri,
      });
      if (result.didResolutionMetadata.error !== undefined || result.didDocument === null) {
        this.deferFailedRefresh(did);
        return { isManaged: true };
      }

      this._failedRefreshRetryAfter.delete(did);
      return { isManaged: true, value: result };
    } catch {
      // Managed DIDs deliberately retain their last known document while offline.
      this.deferFailedRefresh(did);
      return { isManaged: true };
    }
  }

  /** Applies a short failure-only retry delay without extending the cached document's TTL. */
  private deferFailedRefresh(did: string): void {
    this._failedRefreshRetryAfter.set(did, Date.now() + AgentDidResolverCache.FAILED_REFRESH_RETRY_MS);
  }
}

type StaleDidRefresh = {
  isManaged: boolean;
  value?: DidResolutionResult;
};
