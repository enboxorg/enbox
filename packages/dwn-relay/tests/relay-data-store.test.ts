import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { RelayDataStore } from '../src/stores/relay-data-store.js';
import { createMockDataStore, randomBytes, streamFromBytes } from './test-utils.js';

describe('RelayDataStore', () => {
  let innerStore: ReturnType<typeof createMockDataStore>;
  let store: RelayDataStore;

  beforeEach(async () => {
    innerStore = createMockDataStore();
    store = new RelayDataStore(innerStore);
    await store.open();
  });

  afterEach(async () => {
    await store.close();
  });

  // ─── DataStore interface compliance ────────────────────────────────

  describe('DataStore interface', () => {
    it('should delegate open/close to inner store', async () => {
      // Already opened in beforeEach, close and reopen
      await store.close();
      await store.open();
      // No errors means delegation works
    });

    it('should delegate put and return correct dataSize', async () => {
      const data = randomBytes(500);
      const result = await store.put('tenant1', 'rec1', 'cid1', streamFromBytes(data));
      expect(result.dataSize).toBe(500);
    });

    it('should delegate get to inner store', async () => {
      const data = randomBytes(200);
      await store.put('tenant1', 'rec1', 'cid1', streamFromBytes(data));
      const result = await store.get('tenant1', 'rec1', 'cid1');
      expect(result).toBeDefined();
      expect(result!.dataSize).toBe(200);
    });

    it('should return undefined for non-existent data on get', async () => {
      const result = await store.get('tenant1', 'rec-none', 'cid-none');
      expect(result).toBeUndefined();
    });

    it('should delegate delete to inner store', async () => {
      const data = randomBytes(300);
      await store.put('tenant1', 'rec1', 'cid1', streamFromBytes(data));
      await store.delete('tenant1', 'rec1', 'cid1');
      const result = await store.get('tenant1', 'rec1', 'cid1');
      expect(result).toBeUndefined();
    });

    it('should delegate clear to inner store', async () => {
      await store.put('tenant1', 'rec1', 'cid1', streamFromBytes(randomBytes(100)));
      await store.put('tenant2', 'rec2', 'cid2', streamFromBytes(randomBytes(200)));
      await store.clear();
      expect(store.getTotalStorageBytes()).toBe(0);
      expect(store.getEntryCount()).toBe(0);
    });
  });

  // ─── Storage tracking ──────────────────────────────────────────────

  describe('storage tracking', () => {
    it('should track total storage bytes', async () => {
      expect(store.getTotalStorageBytes()).toBe(0);
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(1000)));
      expect(store.getTotalStorageBytes()).toBe(1000);
      await store.put('t1', 'r2', 'c2', streamFromBytes(randomBytes(2000)));
      expect(store.getTotalStorageBytes()).toBe(3000);
    });

    it('should track per-tenant storage bytes', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(1000)));
      await store.put('t2', 'r2', 'c2', streamFromBytes(randomBytes(2000)));
      await store.put('t1', 'r3', 'c3', streamFromBytes(randomBytes(500)));

      expect(store.getTenantStorageBytes('t1')).toBe(1500);
      expect(store.getTenantStorageBytes('t2')).toBe(2000);
      expect(store.getTenantStorageBytes('t3')).toBe(0);
    });

    it('should track entry count', async () => {
      expect(store.getEntryCount()).toBe(0);
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));
      expect(store.getEntryCount()).toBe(1);
      await store.put('t1', 'r2', 'c2', streamFromBytes(randomBytes(100)));
      expect(store.getEntryCount()).toBe(2);
    });

    it('should update tracking on delete', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(1000)));
      await store.put('t1', 'r2', 'c2', streamFromBytes(randomBytes(2000)));
      expect(store.getTotalStorageBytes()).toBe(3000);

      await store.delete('t1', 'r1', 'c1');
      expect(store.getTotalStorageBytes()).toBe(2000);
      expect(store.getTenantStorageBytes('t1')).toBe(2000);
      expect(store.getEntryCount()).toBe(1);
    });

    it('should remove tenant tracking when tenant storage reaches zero', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(1000)));
      await store.delete('t1', 'r1', 'c1');
      expect(store.getTenantStorageBytes('t1')).toBe(0);
    });

    it('should handle replacing data for the same key', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(1000)));
      expect(store.getTotalStorageBytes()).toBe(1000);

      // Put again with different size
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(2000)));
      expect(store.getTotalStorageBytes()).toBe(2000);
      expect(store.getEntryCount()).toBe(1); // still 1 entry
    });

    it('should handle delete of non-existent entry gracefully', async () => {
      await store.delete('t1', 'nonexistent', 'cid');
      expect(store.getTotalStorageBytes()).toBe(0);
    });
  });

  // ─── Eviction metadata ────────────────────────────────────────────

  describe('eviction metadata', () => {
    it('should mark entries as synced', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));
      store.markSynced('t1', 'r1', 'c1');

      // synced entries are always candidates regardless of age
      const candidates = store.getEvictionCandidates(Infinity);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].synced).toBe(true);
    });

    it('should set protocol metadata', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));
      store.setProtocol('t1', 'r1', 'c1', 'https://example.com/chat');
      store.markSynced('t1', 'r1', 'c1'); // make it a candidate

      const candidates = store.getEvictionCandidates(Infinity);
      expect(candidates[0].protocol).toBe('https://example.com/chat');
    });

    it('should ignore markSynced for non-existent entry', () => {
      // Should not throw
      store.markSynced('t1', 'nonexistent', 'cid');
    });

    it('should ignore setProtocol for non-existent entry', () => {
      store.setProtocol('t1', 'nonexistent', 'cid', 'proto');
    });
  });

  // ─── Eviction candidates ──────────────────────────────────────────

  describe('getEvictionCandidates', () => {
    it('should return synced entries as candidates regardless of age', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));
      store.markSynced('t1', 'r1', 'c1');

      // maxAgeMs = Infinity means nothing is old enough, but synced entries are always eligible
      const candidates = store.getEvictionCandidates(Infinity);
      expect(candidates).toHaveLength(1);
    });

    it('should return entries older than maxAgeMs', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));

      // Wait 1ms to ensure age > 0, then use maxAgeMs=0 (any age qualifies)
      await new Promise(r => setTimeout(r, 2));
      const candidates = store.getEvictionCandidates(0);
      expect(candidates).toHaveLength(1);
    });

    it('should not return entries that are neither synced nor old', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));

      // Very large maxAgeMs — entry is too young, not synced
      const candidates = store.getEvictionCandidates(999_999_999);
      expect(candidates).toHaveLength(0);
    });

    it('should sort synced entries first', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));
      await store.put('t1', 'r2', 'c2', streamFromBytes(randomBytes(200)));
      store.markSynced('t1', 'r2', 'c2');

      // Wait so age > 0 for the age-based eligibility check
      await new Promise(r => setTimeout(r, 2));
      const candidates = store.getEvictionCandidates(0);
      expect(candidates).toHaveLength(2);
      expect(candidates[0].recordId).toBe('r2'); // synced first
      expect(candidates[1].recordId).toBe('r1');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await store.put('t1', `r${i}`, `c${i}`, streamFromBytes(randomBytes(100)));
        store.markSynced('t1', `r${i}`, `c${i}`);
      }
      const candidates = store.getEvictionCandidates(Infinity, undefined, 3);
      expect(candidates).toHaveLength(3);
    });

    it('should use per-protocol maxAge when provided', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(100)));
      store.setProtocol('t1', 'r1', 'c1', 'proto-a');

      // Protocol-specific: very large retention → not eligible
      const candidates = store.getEvictionCandidates(0, (_proto) => 999_999_999, 100);
      expect(candidates).toHaveLength(0);
    });
  });

  // ─── Evict method ─────────────────────────────────────────────────

  describe('evict', () => {
    it('should delete data and return freed bytes', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(1000)));
      const freed = await store.evict('t1', 'r1', 'c1');
      expect(freed).toBe(1000);
      expect(store.getTotalStorageBytes()).toBe(0);
      expect(store.getEntryCount()).toBe(0);
    });

    it('should return 0 for non-existent entry', async () => {
      const freed = await store.evict('t1', 'nonexistent', 'cid');
      expect(freed).toBe(0);
    });

    it('should update per-tenant tracking after eviction', async () => {
      await store.put('t1', 'r1', 'c1', streamFromBytes(randomBytes(500)));
      await store.put('t1', 'r2', 'c2', streamFromBytes(randomBytes(300)));
      await store.evict('t1', 'r1', 'c1');
      expect(store.getTenantStorageBytes('t1')).toBe(300);
    });
  });
});
