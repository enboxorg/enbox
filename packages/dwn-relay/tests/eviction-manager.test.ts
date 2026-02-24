import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { EvictionManager } from '../src/eviction/eviction-manager.js';
import type { RelayConfig } from '../src/config.js';
import { RelayDataStore } from '../src/stores/relay-data-store.js';
import { createMockDataStore, getTestRelayConfig, randomBytes, streamFromBytes } from './test-utils.js';

describe('EvictionManager', () => {
  let innerStore: ReturnType<typeof createMockDataStore>;
  let store: RelayDataStore;
  let config: RelayConfig;

  beforeEach(async () => {
    innerStore = createMockDataStore();
    store = new RelayDataStore(innerStore);
    await store.open();
    config = {
      ...getTestRelayConfig(),
      storageMaxBytes       : 10_000,
      evictionHighWaterMark : 0.8,
      evictionLowWaterMark  : 0.5,
      dataRetention         : '0ms', // everything immediately eligible by age
    };
  });

  afterEach(async () => {
    await store.close();
  });

  describe('runOnce', () => {
    it('should not evict when under high-water mark', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(1000)));
      // 1000 bytes < 10000 * 0.8 = 8000

      const mgr = new EvictionManager(store, config);
      const result = await mgr.runOnce();
      expect(result.freedBytes).toBe(0);
      expect(result.evictedCount).toBe(0);
    });

    it('should evict to low-water mark when above high-water mark', async () => {
      // Fill to 9000 bytes (> 8000 high-water)
      for (let i = 0; i < 9; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(1000)));
      }
      expect(store.getTotalStorageBytes()).toBe(9000);

      // Wait so entries are older than 0ms retention
      await new Promise(r => setTimeout(r, 2));

      const mgr = new EvictionManager(store, config);
      const result = await mgr.runOnce();

      expect(result.evictedCount).toBeGreaterThan(0);
      // Should be at or below low-water mark: 10000 * 0.5 = 5000
      expect(store.getTotalStorageBytes()).toBeLessThanOrEqual(5000);
    });

    it('should prefer synced entries for eviction', async () => {
      for (let i = 0; i < 9; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(1000)));
      }
      // Mark first 3 as synced
      store.markSynced('t1', 'r0', 'c0');
      store.markSynced('t1', 'r1', 'c1');
      store.markSynced('t1', 'r2', 'c2');

      const mgr = new EvictionManager(store, config);
      await mgr.runOnce();

      // Synced entries should have been evicted first
      // Check that inner store no longer has the synced records
      const key0 = innerStore.storage.has('t1|r0|c0');
      const key1 = innerStore.storage.has('t1|r1|c1');
      const key2 = innerStore.storage.has('t1|r2|c2');
      // At least the synced entries should be gone
      expect(!key0 || !key1 || !key2).toBe(true);
    });

    it('should not evict when storageMaxBytes is 0 (unlimited)', async () => {
      config.storageMaxBytes = 0;
      for (let i = 0; i < 5; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(1000)));
      }

      const mgr = new EvictionManager(store, config);
      const result = await mgr.runOnce();
      expect(result.freedBytes).toBe(0);
      expect(result.evictedCount).toBe(0);
    });

    it('should stop when no more candidates are available', async () => {
      // Data with very long retention → not eligible by age, not synced
      config.dataRetention = '999d';
      for (let i = 0; i < 9; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(1000)));
      }

      const mgr = new EvictionManager(store, config);
      const result = await mgr.runOnce();
      // No candidates eligible → cannot evict
      expect(result.evictedCount).toBe(0);
    });
  });

  describe('evictExpired', () => {
    it('should evict all data older than retention window', async () => {
      config.dataRetention = '0ms'; // everything is expired
      for (let i = 0; i < 5; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(100)));
      }

      // Wait so entries are older than 0ms retention
      await new Promise(r => setTimeout(r, 2));

      const mgr = new EvictionManager(store, config);
      const result = await mgr.evictExpired();
      expect(result.evictedCount).toBe(5);
      expect(store.getTotalStorageBytes()).toBe(0);
    });

    it('should not evict data within retention window', async () => {
      config.dataRetention = '999d';
      for (let i = 0; i < 5; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(100)));
      }

      const mgr = new EvictionManager(store, config);
      const result = await mgr.evictExpired();
      // None expired, none synced → no evictions
      expect(result.evictedCount).toBe(0);
    });

    it('should evict synced data even within retention window', async () => {
      config.dataRetention = '999d';
      for (let i = 0; i < 5; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(100)));
      }
      store.markSynced('t1', 'r0', 'c0');
      store.markSynced('t1', 'r1', 'c1');

      const mgr = new EvictionManager(store, config);
      const result = await mgr.evictExpired();
      expect(result.evictedCount).toBe(2);
    });

    it('should respect per-protocol retention overrides', async () => {
      config.dataRetention = '999d'; // global: keep everything
      config.protocolPolicies = { 'proto://short': '0ms' }; // this protocol: evict immediately

      for (let i = 0; i < 3; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(100)));
        store.setProtocol('t1', `r${i}`, `c${i}`, 'proto://short');
      }
      // One entry with a different protocol
      await store.put('t1', 'r-keep', 'c-keep', streamFromBytes(randomBytes(100)));
      store.setProtocol('t1', 'r-keep', 'c-keep', 'proto://long');

      // Wait so short-retention entries are older than 0ms
      await new Promise(r => setTimeout(r, 2));

      const mgr = new EvictionManager(store, config);
      const result = await mgr.evictExpired();
      // Only the 3 short-retention entries should be evicted
      expect(result.evictedCount).toBe(3);
      expect(store.getEntryCount()).toBe(1);
    });
  });

  describe('start/stop', () => {
    it('should start and stop without error', () => {
      const mgr = new EvictionManager(store, config);
      mgr.start();
      mgr.stop();
    });

    it('should be idempotent for start/stop', () => {
      const mgr = new EvictionManager(store, config);
      mgr.start();
      mgr.start(); // double start
      mgr.stop();
      mgr.stop(); // double stop
    });
  });
});
