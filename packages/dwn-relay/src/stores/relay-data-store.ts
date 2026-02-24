import log from 'loglevel';
import type { DataStore, DataStoreGetResult, DataStorePutResult } from '@enbox/dwn-sdk-js';

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
export class RelayDataStore implements DataStore {
  #inner: DataStore;
  #metadata: Map<string, DataMetadataEntry> = new Map();
  #totalBytes = 0;
  #tenantBytes: Map<string, number> = new Map();

  constructor(innerStore: DataStore) {
    this.#inner = innerStore;
  }

  static #key(tenant: string, recordId: string, dataCid: string): string {
    return `${tenant}|${recordId}|${dataCid}`;
  }

  async open(): Promise<void> {
    await this.#inner.open();
  }

  async close(): Promise<void> {
    await this.#inner.close();
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

    this.#metadata.set(key, {
      tenant,
      recordId,
      dataCid,
      dataSize : result.dataSize,
      storedAt : Date.now(),
      synced   : false,
    });

    this.#totalBytes += result.dataSize;
    this.#tenantBytes.set(tenant, (this.#tenantBytes.get(tenant) ?? 0) + result.dataSize);

    return result;
  }

  async get(
    tenant: string,
    recordId: string,
    dataCid: string,
  ): Promise<DataStoreGetResult | undefined> {
    return this.#inner.get(tenant, recordId, dataCid);
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
    }
  }

  async clear(): Promise<void> {
    await this.#inner.clear();
    this.#metadata.clear();
    this.#totalBytes = 0;
    this.#tenantBytes.clear();
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
    }
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

    return freed;
  }
}
