import log from 'loglevel';
import { parseDuration } from '../config.js';
import type { RelayConfig } from '../config.js';
import type { RelayDataStore } from '../stores/relay-data-store.js';
import type { StoragePolicy } from './storage-policies.js';
import { getRetentionMs, parsePolicies } from './storage-policies.js';

/**
 * EvictionManager monitors storage usage and evicts record data from the
 * DataStore when storage pressure exceeds configured thresholds.
 *
 * Key invariant: only record data is evicted. Message envelopes (MessageStore)
 * and SMT entries (StateIndex) are never touched by eviction — they are required
 * for sync correctness.
 *
 * Eviction strategies (combined):
 * - Synced-first: prefer data confirmed synced to a full peer
 * - Age-based: evict data older than the retention window
 * - Size-based: evict largest records first (as tiebreaker)
 * - Per-protocol: different retention windows per protocol
 */
export class EvictionManager {
  #dataStore: RelayDataStore;
  #config: RelayConfig;
  #policies: StoragePolicy[];
  #intervalHandle: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(dataStore: RelayDataStore, config: RelayConfig) {
    this.#dataStore = dataStore;
    this.#config = config;
    this.#policies = parsePolicies(config.dataRetention, config.protocolPolicies);
  }

  /**
   * Start the eviction manager. Runs a periodic scan at the configured interval.
   */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;

    const intervalMs = this.#config.evictionIntervalSeconds * 1_000;
    this.#intervalHandle = setInterval(() => {
      void this.#runEvictionCycle();
    }, intervalMs);

    log.info(`EvictionManager started (interval=${this.#config.evictionIntervalSeconds}s, ` +
      `maxBytes=${this.#config.storageMaxBytes || 'unlimited'})`);
  }

  /**
   * Stop the eviction manager.
   */
  stop(): void {
    if (!this.#running) {
      return;
    }
    this.#running = false;

    if (this.#intervalHandle !== undefined) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = undefined;
    }

    log.info('EvictionManager stopped');
  }

  /**
   * Run a single eviction cycle. Exposed for testing.
   */
  async runOnce(): Promise<{ freedBytes: number; evictedCount: number }> {
    return this.#runEvictionCycle();
  }

  async #runEvictionCycle(): Promise<{ freedBytes: number; evictedCount: number }> {
    const totalBytes = this.#dataStore.getTotalStorageBytes();
    const maxBytes = this.#config.storageMaxBytes;

    // No eviction needed if under the high-water mark (or no limit set)
    if (maxBytes === 0 || totalBytes < maxBytes * this.#config.evictionHighWaterMark) {
      return { freedBytes: 0, evictedCount: 0 };
    }

    const targetBytes = maxBytes * this.#config.evictionLowWaterMark;
    const bytesToFree = totalBytes - targetBytes;
    const globalMaxAgeMs = parseDuration(this.#config.dataRetention);

    log.info(`Eviction cycle: ${totalBytes} bytes used, target=${targetBytes}, ` +
      `need to free ${bytesToFree} bytes`);

    let freedBytes = 0;
    let evictedCount = 0;

    // Get candidates in batches until we've freed enough
    while (freedBytes < bytesToFree) {
      const candidates = this.#dataStore.getEvictionCandidates(
        globalMaxAgeMs,
        (protocol) => getRetentionMs(this.#policies, protocol),
        100,
      );

      if (candidates.length === 0) {
        log.warn('Eviction: no more candidates available, cannot reach low-water mark');
        break;
      }

      for (const candidate of candidates) {
        if (freedBytes >= bytesToFree) {
          break;
        }

        const freed = await this.#dataStore.evict(
          candidate.tenant,
          candidate.recordId,
          candidate.dataCid,
        );

        if (freed > 0) {
          freedBytes += freed;
          evictedCount++;
        }
      }
    }

    if (evictedCount > 0) {
      log.info(`Eviction cycle complete: freed ${freedBytes} bytes, evicted ${evictedCount} entries`);
    }

    return { freedBytes, evictedCount };
  }

  /**
   * Force an immediate age-based eviction pass regardless of storage pressure.
   * Evicts all data older than the retention window. Used for maintenance.
   */
  async evictExpired(): Promise<{ freedBytes: number; evictedCount: number }> {
    const globalMaxAgeMs = parseDuration(this.#config.dataRetention);
    const candidates = this.#dataStore.getEvictionCandidates(
      globalMaxAgeMs,
      (protocol) => getRetentionMs(this.#policies, protocol),
      Infinity,
    );

    let freedBytes = 0;
    let evictedCount = 0;

    for (const candidate of candidates) {
      // Only evict truly expired entries, not just synced ones
      const age = Date.now() - candidate.storedAt;
      const effectiveMaxAge = getRetentionMs(this.#policies, candidate.protocol);
      if (age <= effectiveMaxAge && !candidate.synced) {
        continue;
      }

      const freed = await this.#dataStore.evict(
        candidate.tenant,
        candidate.recordId,
        candidate.dataCid,
      );

      if (freed > 0) {
        freedBytes += freed;
        evictedCount++;
      }
    }

    return { freedBytes, evictedCount };
  }
}
