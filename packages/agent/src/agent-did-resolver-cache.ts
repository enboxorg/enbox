import type { DidResolverCacheLevelParams } from '@enbox/dids/resolver-cache-level';
import type { DidResolutionResult, DidResolverCache, PortableDid } from '@enbox/dids';

import type { EnboxPlatformAgent } from './types/agent.js';

import { DidResolverCacheLevel } from '@enbox/dids/resolver-cache-level';
import { logger } from '@enbox/common';


/**
 * AgentDidResolverCache keeps a stale copy of the Agent's managed Identity DIDs and only evicts and refreshes upon a successful resolution.
 * This allows for quick and offline access to the internal DIDs used by the agent.
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
      const cachedResult = JSON.parse(str);
      if (!this._resolving.has(did) && Date.now() >= cachedResult.ttlMillis) {
        return await this.refreshStaleDid(did) ?? cachedResult.value;
      }
      return cachedResult.value;
    } catch (error: any) {
      if (error.notFound) {
        return;
      }
      throw error;
    }
  }

  /**
   * Re-resolves a DID that is managed by the agent (or is the agent's own DID) after its cache
   * entry has gone stale. If the DID is not found in the DID Store, its cache entry is evicted.
   * Otherwise, the cache entry is kept until a new resolution succeeds, at which point both the
   * store and the cache are updated with the newly resolved Document.
   */
  private async refreshStaleDid(did: string): Promise<DidResolutionResult | undefined> {
    this._resolving.set(did, true);

    // if a DID is stored in the DID Store, then we don't want to evict it from the cache until we have a successful resolution
    // upon a successful resolution, we will update both the storage and the cache with the newly resolved Document.
    const storedDid = await this.agent.did.get({ didUri: did, tenant: this.agent.agentDid.uri });
    if ('undefined' === typeof storedDid) {
      this._resolving.delete(did);
      this.cache.nextTick(() => this.cache.del(did));
    } else {
      try {
        const result = await this.agent.did.refreshResolution(did);

        // if the resolution was successful, update the stored DID with the new Document
        if (!result.didResolutionMetadata.error && result.didDocument) {

          const portableDid = {
            ...storedDid,
            document : result.didDocument,
            metadata : result.didDocumentMetadata,
          };

          await this.updateStoredDid(portableDid);
          return result;
        }
      } catch (error: unknown) {
        logger.error(`Unable to refresh stale DID '${did}': ${error instanceof Error ? error.message : error}`);
      } finally {
        this._resolving.delete(did);
      }
    }

    return undefined;
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
