import type { DidResolver } from '@enbox/dids';
import type { IpfsResolver } from '../proxy/ipfs-resolver.js';
import log from 'loglevel';
import type { MetadataStore } from './metadata-store.js';
import type { RelayConfig } from '../config.js';
import { resolveEndpoints } from '../endpoint-resolver.js';
import { Cid, DataStream, Time } from '@enbox/dwn-sdk-js';
import type { DataStore, DataStoreGetResult, DataStorePutResult } from '@enbox/dwn-sdk-js';
import type { DwnRpc, DwnRpcRequest } from '@enbox/dwn-clients';

/**
 * Metadata tracked for each piece of stored record data.
 * Keyed by `${tenant}|${recordId}|${dataCid}`.
 */
export interface DataMetadataEntry {
  tenant: string;
  recordId: string;
  dataCid: string;
  dataSize: number;
  storedAt: number; // epoch ms
  protocol?: string; // protocol URI from the RecordsWrite, for per-protocol eviction
  synced: boolean; // true if confirmed synced to at least one full peer
}

/**
 * RelayDataStore wraps any DataStore implementation with eviction awareness.
 *
 * It delegates all operations to the underlying store and adds:
 * - Storage usage tracking (total bytes, per-tenant bytes)
 * - Eviction metadata (when data was stored, whether it has been synced)
 * - Interface for the EvictionManager to query and delete eligible data
 *
 * The wrapper is transparent to the DWN engine — it implements the same
 * DataStore interface. The eviction logic is driven externally by the
 * EvictionManager, not by the store itself.
 */
/**
 * Options for configuring the read-proxy behavior of RelayDataStore.
 * When set, `get()` transparently proxies from IPFS or peer DWN on cache miss.
 */
export interface RelayDataStoreProxyOptions {
  didResolver: DidResolver;
  rpcClient: DwnRpc;
  config: RelayConfig;
  ipfsResolver?: IpfsResolver;
}

export class RelayDataStore implements DataStore {
  #inner: DataStore;
  #metadata: Map<string, DataMetadataEntry> = new Map();
  #totalBytes = 0;
  #tenantBytes: Map<string, number> = new Map();
  #proxy?: RelayDataStoreProxyOptions;
  #metadataStore?: MetadataStore;

  constructor(innerStore: DataStore, metadataStore?: MetadataStore) {
    this.#inner = innerStore;
    this.#metadataStore = metadataStore;
  }

  /**
   * Enable transparent read-proxying on cache miss.
   * Must be called after construction (proxy dependencies may not be available at construction time).
   */
  setProxy(options: RelayDataStoreProxyOptions): void {
    this.#proxy = options;
  }

  static #key(tenant: string, recordId: string, dataCid: string): string {
    return `${tenant}|${recordId}|${dataCid}`;
  }

  async open(): Promise<void> {
    await this.#inner.open();

    // Seed in-memory caches from persistent metadata if available.
    if (this.#metadataStore) {
      this.#metadataStore.open();
      this.#seedFromStore();
    }
  }

  async close(): Promise<void> {
    await this.#inner.close();
    this.#metadataStore?.close();
  }

  /**
   * Seed the in-memory metadata map and byte counters from the persistent store.
   */
  #seedFromStore(): void {
    const store = this.#metadataStore!;
    const entries = store.getAll();

    this.#metadata.clear();
    this.#tenantBytes.clear();
    this.#totalBytes = 0;

    for (const entry of entries) {
      const key = RelayDataStore.#key(entry.tenant, entry.recordId, entry.dataCid);
      this.#metadata.set(key, entry);
      this.#totalBytes += entry.dataSize;
      this.#tenantBytes.set(entry.tenant, (this.#tenantBytes.get(entry.tenant) ?? 0) + entry.dataSize);
    }

    log.info(`RelayDataStore: seeded ${entries.length} metadata entries (${this.#totalBytes} bytes) from persistent store`);
  }

  async put(
    tenant: string,
    recordId: string,
    dataCid: string,
    dataStream: ReadableStream<Uint8Array>,
  ): Promise<DataStorePutResult> {
    const result = await this.#inner.put(tenant, recordId, dataCid, dataStream);

    const key = RelayDataStore.#key(tenant, recordId, dataCid);
    const existing = this.#metadata.get(key);

    // Update tracking — if replacing, subtract old size first
    if (existing) {
      this.#totalBytes -= existing.dataSize;
      this.#tenantBytes.set(tenant, (this.#tenantBytes.get(tenant) ?? 0) - existing.dataSize);
    }

    const entry: DataMetadataEntry = {
      tenant,
      recordId,
      dataCid,
      dataSize : result.dataSize,
      storedAt : Date.now(),
      synced   : false,
    };
    this.#metadata.set(key, entry);
    this.#metadataStore?.put(entry);

    this.#totalBytes += result.dataSize;
    this.#tenantBytes.set(tenant, (this.#tenantBytes.get(tenant) ?? 0) + result.dataSize);

    return result;
  }

  async get(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<DataStoreGetResult | undefined> {
    // Try local store first
    const local = await this.#inner.get(tenant, recordId, dataCid);
    if (local) {
      return local;
    }

    // If no proxy configured, return undefined (DWN returns 410 to the requester)
    if (!this.#proxy) {
      return undefined;
    }

    // Transparent proxy: attempt to fetch from IPFS or peer DWN
    return this.#proxyGet(tenant, recordId, dataCid);
  }

  /**
   * Attempt to resolve data from external sources on cache miss.
   * Resolution order: IPFS gateway (if configured) → peer DWN endpoints.
   */
  async #proxyGet(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<DataStoreGetResult | undefined> {
    const proxy = this.#proxy!;

    // Strategy 1: IPFS gateway
    if (proxy.ipfsResolver) {
      const ipfsResult = await proxy.ipfsResolver.resolve(dataCid);
      if (ipfsResult) {
        log.debug(`RelayDataStore: resolved ${dataCid} via IPFS for tenant ${tenant}`);
        if (proxy.config.readProxyCacheLocally) {
          return this.#recacheAndReturn(tenant, recordId, dataCid, ipfsResult);
        }
        return ipfsResult;
      }
    }

    // Strategy 2: Peer DWN proxy (prefer full endpoints)
    const peerResult = await this.#proxyFromPeer(tenant, recordId, dataCid);
    if (peerResult) {
      log.debug(`RelayDataStore: resolved ${dataCid} via peer proxy for tenant ${tenant}`);
      if (proxy.config.readProxyCacheLocally) {
        return this.#recacheAndReturn(tenant, recordId, dataCid, peerResult);
      }
      return peerResult;
    }

    log.debug(`RelayDataStore: no proxy source for ${dataCid}, tenant ${tenant}`);
    return undefined;
  }

  /**
   * Proxy a RecordsRead to peer DWN endpoints, preferring full nodes.
   */
  async #proxyFromPeer(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<DataStoreGetResult | undefined> {
    const proxy = this.#proxy!;

    const endpoints = await resolveEndpoints(tenant, proxy.didResolver);
    const peers = endpoints
      .filter(ep => ep.url !== proxy.config.selfUrl)
      .sort((a, b) => {
        if (a.isFull && !b.isFull) {return -1;}
        if (!a.isFull && b.isFull) {return 1;}
        return 0;
      });

    if (peers.length === 0) {
      return undefined;
    }

    // Build a minimal RecordsRead message for the peer
    const readMessage = {
      descriptor: {
        interface        : 'Records',
        method           : 'Read',
        messageTimestamp : Time.getCurrentTimestamp(),
        filter           : { recordId },
      },
    };

    for (const endpoint of peers) {
      try {
        const request: DwnRpcRequest = {
          dwnUrl    : endpoint.url,
          targetDid : tenant,
          message   : readMessage as any,
        };

        const response = await proxy.rpcClient.sendDwnRequest(request);

        if (response.status?.code === 200 && response.entry?.data) {
          const data = response.entry.data as ReadableStream<Uint8Array>;
          const dataBytes = await DataStream.toBytes(data);
          const computedCid = await Cid.computeDagPbCidFromBytes(dataBytes);

          if (computedCid !== dataCid) {
            log.warn(`RelayDataStore: CID mismatch from peer ${endpoint.url} for ${dataCid}`);
            continue;
          }

          return {
            dataSize   : dataBytes.length,
            dataStream : DataStream.fromBytes(dataBytes),
          };
        }
      } catch (err) {
        log.debug(`RelayDataStore: peer ${endpoint.url} failed for ${dataCid}:`, err);
      }
    }

    return undefined;
  }

  /**
   * Store fetched data locally and return a fresh result from the local store.
   */
  async #recacheAndReturn(
    tenant: string,
    recordId: string,
    dataCid: string,
    result: DataStoreGetResult,
  ): Promise<DataStoreGetResult | undefined> {
    try {
      const dataBytes = await DataStream.toBytes(result.dataStream);
      await this.#inner.put(tenant, recordId, dataCid, DataStream.fromBytes(dataBytes));
      log.debug(`RelayDataStore: re-cached ${dataCid} for tenant ${tenant} (${dataBytes.length} bytes)`);

      // Update metadata tracking
      const key = RelayDataStore.#key(tenant, recordId, dataCid);
      const entry: DataMetadataEntry = {
        tenant,
        recordId,
        dataCid,
        dataSize : dataBytes.length,
        storedAt : Date.now(),
        synced   : false,
      };
      this.#metadata.set(key, entry);
      this.#metadataStore?.put(entry);
      this.#totalBytes += dataBytes.length;
      this.#tenantBytes.set(tenant, (this.#tenantBytes.get(tenant) ?? 0) + dataBytes.length);

      // Return from local store for a clean stream
      return this.#inner.get(tenant, recordId, dataCid);
    } catch (err) {
      log.warn(`RelayDataStore: re-cache failed for ${dataCid}:`, err);
      return undefined;
    }
  }

  async delete(tenant: string, recordId: string, dataCid: string): Promise<void> {
    const key = RelayDataStore.#key(tenant, recordId, dataCid);
    const entry = this.#metadata.get(key);

    await this.#inner.delete(tenant, recordId, dataCid);

    if (entry) {
      this.#totalBytes -= entry.dataSize;
      const tenantTotal = (this.#tenantBytes.get(tenant) ?? 0) - entry.dataSize;
      if (tenantTotal <= 0) {
        this.#tenantBytes.delete(tenant);
      } else {
        this.#tenantBytes.set(tenant, tenantTotal);
      }
      this.#metadata.delete(key);
      this.#metadataStore?.delete(tenant, recordId, dataCid);
    }
  }

  async clear(): Promise<void> {
    await this.#inner.clear();
    this.#metadata.clear();
    this.#totalBytes = 0;
    this.#tenantBytes.clear();
    this.#metadataStore?.clear();
  }

  // ─── Eviction-aware query methods ───────────────────────────────────

  /** Current total data storage in bytes (tracked, not counted from disk). */
  getTotalStorageBytes(): number {
    return this.#totalBytes;
  }

  /** Data storage for a specific tenant. */
  getTenantStorageBytes(tenant: string): number {
    return this.#tenantBytes.get(tenant) ?? 0;
  }

  /** Number of tracked data entries. */
  getEntryCount(): number {
    return this.#metadata.size;
  }

  /**
   * Mark a data entry as synced to a full peer.
   * Called by the ServerSyncEngine when sync convergence is confirmed.
   */
  markSynced(tenant: string, recordId: string, dataCid: string): void {
    const key = RelayDataStore.#key(tenant, recordId, dataCid);
    const entry = this.#metadata.get(key);
    if (entry) {
      entry.synced = true;
      this.#metadataStore?.markSynced(tenant, recordId, dataCid);
    }
  }

  /**
   * Mark ALL data entries for a tenant as synced.
   * Called by the ServerSyncEngine when SMT root convergence is confirmed with a peer.
   */
  markTenantSynced(tenant: string): void {
    for (const entry of this.#metadata.values()) {
      if (entry.tenant === tenant) {
        entry.synced = true;
      }
    }
    this.#metadataStore?.markTenantSynced(tenant);
  }

  /**
   * Attach protocol metadata to a data entry.
   * Called during write processing when protocol info is available from the message indexes.
   */
  setProtocol(tenant: string, recordId: string, dataCid: string, protocol: string): void {
    const key = RelayDataStore.#key(tenant, recordId, dataCid);
    const entry = this.#metadata.get(key);
    if (entry) {
      entry.protocol = protocol;
      this.#metadataStore?.setProtocol(tenant, recordId, dataCid, protocol);
    }
  }

  /**
   * Get eviction candidates ordered by priority:
   *   1. Synced data (safe to evict — full peer has it)
   *   2. Data older than the given age threshold
   *   3. Larger records first (within each priority tier)
   *
   * @param maxAgeMs - Data older than this is eligible for eviction even if not synced.
   * @param protocolMaxAgeMs - Optional per-protocol override for maxAgeMs lookup.
   * @param limit - Maximum number of candidates to return.
   */
  getEvictionCandidates(
    maxAgeMs: number,
    protocolMaxAgeMs?: (protocol?: string) => number,
    limit = 100,
  ): DataMetadataEntry[] {
    const now = Date.now();
    const candidates: DataMetadataEntry[] = [];

    for (const entry of this.#metadata.values()) {
      const effectiveMaxAge = protocolMaxAgeMs
        ? protocolMaxAgeMs(entry.protocol)
        : maxAgeMs;
      const age = now - entry.storedAt;

      // Eligible if: synced OR older than retention window
      if (entry.synced || age > effectiveMaxAge) {
        candidates.push(entry);
      }
    }

    // Sort: synced first, then by age descending, then by size descending
    candidates.sort((a, b) => {
      if (a.synced !== b.synced) {
        return a.synced ? -1 : 1;
      }
      const ageDiff = a.storedAt - b.storedAt; // older first
      if (ageDiff !== 0) {
        return ageDiff;
      }
      return b.dataSize - a.dataSize; // larger first
    });

    return candidates.slice(0, limit);
  }

  /**
   * Evict a specific data entry. Deletes from the underlying store and removes metadata.
   * Returns the number of bytes freed.
   */
  async evict(tenant: string, recordId: string, dataCid: string): Promise<number> {
    const key = RelayDataStore.#key(tenant, recordId, dataCid);
    const entry = this.#metadata.get(key);
    if (!entry) {
      return 0;
    }

    try {
      await this.#inner.delete(tenant, recordId, dataCid);
    } catch (err) {
      log.warn(`Failed to evict data ${key}:`, err);
      return 0;
    }

    const freed = entry.dataSize;
    this.#totalBytes -= freed;
    const tenantTotal = (this.#tenantBytes.get(tenant) ?? 0) - freed;
    if (tenantTotal <= 0) {
      this.#tenantBytes.delete(tenant);
    } else {
      this.#tenantBytes.set(tenant, tenantTotal);
    }
    this.#metadata.delete(key);
    this.#metadataStore?.delete(tenant, recordId, dataCid);

    return freed;
  }
}
