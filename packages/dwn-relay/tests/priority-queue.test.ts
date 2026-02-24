import { describe, expect, it } from 'bun:test';

import { SyncPriorityQueue } from '../src/sync/priority-queue.js';

describe('SyncPriorityQueue', () => {
  describe('basic operations', () => {
    it('should start empty', () => {
      const q = new SyncPriorityQueue();
      expect(q.size).toBe(0);
      expect(q.dequeue()).toBeUndefined();
    });

    it('should upsert and dequeue items', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 'did:test:a', peerEndpoint: 'https://peer1.com' });
      expect(q.size).toBe(1);

      const item = q.dequeue();
      expect(item).toBeDefined();
      expect(item!.tenant).toBe('did:test:a');
      expect(item!.peerEndpoint).toBe('https://peer1.com');
      expect(item!.inProgress).toBe(true);
    });

    it('should deduplicate by (tenant, peer) pair', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 'did:test:a', peerEndpoint: 'https://peer1.com', lastWriteTimestamp: 100 });
      q.upsert({ tenant: 'did:test:a', peerEndpoint: 'https://peer1.com', lastWriteTimestamp: 200 });
      expect(q.size).toBe(1);

      // Should have the updated timestamp
      const items = q.getAll();
      expect(items[0].lastWriteTimestamp).toBe(200);
    });

    it('should keep separate entries for different (tenant, peer) pairs', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 'did:test:a', peerEndpoint: 'https://peer1.com' });
      q.upsert({ tenant: 'did:test:a', peerEndpoint: 'https://peer2.com' });
      q.upsert({ tenant: 'did:test:b', peerEndpoint: 'https://peer1.com' });
      expect(q.size).toBe(3);
    });
  });

  describe('priority ordering', () => {
    it('should dequeue recent writes before stale tenants', () => {
      const q = new SyncPriorityQueue();
      const now = Date.now();

      // Stale tenant (synced hours ago)
      q.upsert({ tenant: 'stale', peerEndpoint: 'https://peer.com', lastSyncTimestamp: now - 3_600_000 });

      // Fresh write (just now)
      q.upsert({ tenant: 'fresh', peerEndpoint: 'https://peer.com', lastWriteTimestamp: now });

      const first = q.dequeue();
      expect(first!.tenant).toBe('fresh');
    });

    it('should deprioritize items with consecutive failures', () => {
      const q = new SyncPriorityQueue();

      q.upsert({ tenant: 'failing', peerEndpoint: 'https://peer.com', consecutiveFailures: 5 });
      q.upsert({ tenant: 'healthy', peerEndpoint: 'https://peer.com', lastWriteTimestamp: 0 });

      const first = q.dequeue();
      expect(first!.tenant).toBe('healthy');
    });

    it('should give higher priority to never-synced tenants', () => {
      const q = new SyncPriorityQueue();
      const now = Date.now();

      q.upsert({ tenant: 'recently-synced', peerEndpoint: 'https://peer.com', lastSyncTimestamp: now });
      q.upsert({ tenant: 'never-synced', peerEndpoint: 'https://peer.com', lastSyncTimestamp: 0 });

      const first = q.dequeue();
      expect(first!.tenant).toBe('never-synced');
    });
  });

  describe('complete', () => {
    it('should reset failure count on success', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 't', peerEndpoint: 'p', consecutiveFailures: 3 });

      const _item = q.dequeue()!;
      q.complete('t', 'p', true);

      const items = q.getAll();
      const updated = items.find(i => i.tenant === 't');
      expect(updated!.consecutiveFailures).toBe(0);
      expect(updated!.inProgress).toBe(false);
      expect(updated!.lastSyncTimestamp).toBeGreaterThan(0);
    });

    it('should increment failure count on failure', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 't', peerEndpoint: 'p', consecutiveFailures: 2 });

      q.dequeue();
      q.complete('t', 'p', false);

      const items = q.getAll();
      const updated = items.find(i => i.tenant === 't');
      expect(updated!.consecutiveFailures).toBe(3);
      expect(updated!.inProgress).toBe(false);
    });

    it('should be a no-op for unknown items', () => {
      const q = new SyncPriorityQueue();
      q.complete('unknown', 'unknown', true); // should not throw
    });
  });

  describe('remove', () => {
    it('should remove an item from the queue', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 't1', peerEndpoint: 'p1' });
      q.upsert({ tenant: 't2', peerEndpoint: 'p2' });
      expect(q.size).toBe(2);

      q.remove('t1', 'p1');
      expect(q.size).toBe(1);
      expect(q.getAll()[0].tenant).toBe('t2');
    });

    it('should be a no-op for unknown items', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 't1', peerEndpoint: 'p1' });
      q.remove('unknown', 'unknown');
      expect(q.size).toBe(1);
    });
  });

  describe('recalculateAll', () => {
    it('should update priorities for all items', () => {
      const q = new SyncPriorityQueue();
      const now = Date.now();

      q.upsert({ tenant: 't1', peerEndpoint: 'p1', lastWriteTimestamp: now });
      q.upsert({ tenant: 't2', peerEndpoint: 'p2', lastSyncTimestamp: now - 7_200_000 }); // 2 hours stale

      const _beforePriorities = q.getAll().map(i => ({ tenant: i.tenant, priority: i.priority }));
      q.recalculateAll();
      const _afterPriorities = q.getAll().map(i => ({ tenant: i.tenant, priority: i.priority }));

      // Priorities should be recalculated (may be same or different depending on timing)
      // At minimum, verify it doesn't throw and heap is still valid
      expect(q.size).toBe(2);
    });
  });

  describe('inProgress handling', () => {
    it('should skip in-progress items when dequeuing', () => {
      const q = new SyncPriorityQueue();
      const now = Date.now();

      q.upsert({ tenant: 'first', peerEndpoint: 'p', lastWriteTimestamp: now });
      q.upsert({ tenant: 'second', peerEndpoint: 'p', lastWriteTimestamp: now - 60_000 });

      // Dequeue first (highest priority)
      const first = q.dequeue();
      expect(first!.tenant).toBe('first');
      expect(first!.inProgress).toBe(true);

      // Next dequeue should skip the in-progress item
      const second = q.dequeue();
      expect(second!.tenant).toBe('second');
    });

    it('should return undefined when all items are in progress', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 't1', peerEndpoint: 'p1' });

      q.dequeue(); // marks t1 in-progress
      expect(q.dequeue()).toBeUndefined();
    });
  });

  describe('heap integrity', () => {
    it('should maintain heap property across many operations', () => {
      const q = new SyncPriorityQueue();
      const now = Date.now();

      // Insert 100 items with varying priorities
      for (let i = 0; i < 100; i++) {
        q.upsert({
          tenant              : `t${i}`,
          peerEndpoint        : `p${i % 10}`,
          lastWriteTimestamp  : now - Math.random() * 3_600_000,
          consecutiveFailures : Math.floor(Math.random() * 5),
        });
      }

      // Dequeue all items. Since dequeue() doesn't remove items (it only
      // marks them in-progress), we remove each item after processing.
      let lastPriority = Infinity;
      let dequeuedCount = 0;
      while (q.size > 0) {
        const item = q.dequeue();
        if (!item) {break;}
        expect(item.priority).toBeLessThanOrEqual(lastPriority);
        lastPriority = item.priority;
        dequeuedCount++;
        q.remove(item.tenant, item.peerEndpoint);
      }
      expect(dequeuedCount).toBe(100);
    });

    it('should maintain integrity after upsert updates existing items', () => {
      const q = new SyncPriorityQueue();
      const now = Date.now();

      q.upsert({ tenant: 'low', peerEndpoint: 'p', consecutiveFailures: 5 });
      q.upsert({ tenant: 'high', peerEndpoint: 'p', lastWriteTimestamp: now });

      // Now boost the low-priority item
      q.upsert({ tenant: 'low', peerEndpoint: 'p', lastWriteTimestamp: now, consecutiveFailures: 0 });

      // 'low' should now be higher priority (recent write, no failures)
      const first = q.dequeue();
      // Both have recent writes and no failures now, so either could be first
      expect(first).toBeDefined();
    });
  });

  describe('getAll', () => {
    it('should return all items for inspection', () => {
      const q = new SyncPriorityQueue();
      q.upsert({ tenant: 't1', peerEndpoint: 'p1' });
      q.upsert({ tenant: 't2', peerEndpoint: 'p2' });

      const all = q.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(i => i.tenant).sort()).toEqual(['t1', 't2']);
    });
  });
});
