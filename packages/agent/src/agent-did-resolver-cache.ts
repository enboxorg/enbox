import type { DidResolverCacheLevelParams } from '@enbox/dids/resolver-cache-level';
import type { DidResolutionResult, DidResolverCache, PortableDid } from '@enbox/dids';

import type { EnboxPlatformAgent } from './types/agent.js';

import { DidResolverCacheLevel } from '@enbox/dids/resolver-cache-level';
import { logger } from '@enbox/common';


/**
 * Extends the persistent DID cache with refresh behavior for DIDs managed by the agent.
 * Managed DIDs keep their last successful resolution when a refresh fails.
 */
export class AgentDidResolverCache extends DidResolverCacheLevel implements DidResolverCache {

  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentDidApi`. This agent is used to interact with other Enbox agent components. It's vital
   * to ensure this instance is set to correctly contextualize operations within the broader Enbox
   * Agent framework.
   */
  private _agent?: EnboxPlatformAgent;

  /** A map of DIDs that are currently in-flight. This helps avoid going into an infinite loop */
  private readonly _resolving: Map<string, boolean> = new Map();

  public constructor({ agent, ...cacheOptions }: DidResolverCacheLevelParams & { agent?: EnboxPlatformAgent }) {
    super(cacheOptions);
    this._agent = agent;
  }

  public get agent(): EnboxPlatformAgent {
    if (!this._agent) {
      throw new Error('Agent not initialized');
    }
    return this._agent;
  }

  public set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
  }

  /**
   * Get the DID resolution result from the cache for the given DID.
   *
   * Stale managed DIDs are refreshed here so their stored document can be updated. Other stale
   * DIDs return a cache miss; the universal resolver then performs the normal refresh and may use
   * the retained result if that refresh cannot reach the network.
   */
  public async get(didUri: string): Promise<DidResolutionResult | void> {
    const retained = await this.readRetainedEntry(didUri);
    if (retained === undefined) {
      return;
    }

    const { entry, lastUsedAt } = retained;
    if (Date.now() < entry.ttlMillis) {
      await this.touch(didUri, lastUsedAt);
      return entry.value;
    }

    return await this.refreshStaleDid(didUri, entry.value, lastUsedAt);
  }

  /**
   * Re-resolves a managed DID after its cache entry becomes stale. A non-managed DID is left for
   * the universal resolver's normal refresh path. The vault-owned agent DID is recognized directly
   * because it is intentionally not duplicated in the managed DID store.
   */
  private async refreshStaleDid(
    did: string,
    cachedResult: DidResolutionResult,
    lastUsedAt: number,
  ): Promise<DidResolutionResult | undefined> {
    const agentDid = this.agent.agentDid;
    const isAgentDid = did === agentDid.uri;
    const storedDid = isAgentDid ? undefined : await this.agent.did.get({ didUri: did, tenant: agentDid.uri });

    if (!isAgentDid && storedDid === undefined) {
      return;
    }

    if (this._resolving.has(did)) {
      await this.touch(did, lastUsedAt);
      return cachedResult;
    }

    this._resolving.set(did, true);
    try {
      const result = await this.agent.did.refreshResolution(did);
      if (!result.didResolutionMetadata.error && result.didDocument) {
        if (storedDid !== undefined) {
          const portableDid = {
            ...storedDid,
            document : result.didDocument,
            metadata : result.didDocumentMetadata,
          };

          await this.updateStoredDid(portableDid);
        }
        return result;
      }
    } catch (error: unknown) {
      logger.error(`Unable to refresh stale DID '${did}': ${error instanceof Error ? error.message : error}`);
    } finally {
      this._resolving.delete(did);
    }

    await this.touch(did, lastUsedAt);
    return cachedResult;
  }

  /**
   * Persists a freshly resolved Document to the DID Store. Throws internally (and is swallowed
   * here) if the DID is not managed by the agent, or if there is no difference between the stored
   * and resolved DID — in either case we don't publish the DID, as it was received by the resolver.
   */
  private async updateStoredDid(portableDid: PortableDid): Promise<void> {
    try {
      await this.agent.did.update({ portableDid, tenant: this.agent.agentDid.uri, publish: false });
    } catch (error: any) {
      // if the error is not due to no changes detected, log the error
      if (error.message && !error.message.includes('No changes detected, update aborted')) {
        logger.error(`Error updating DID: ${error.message}`);
      }
    }
  }
}
