/**
 * Priority queue for sync work items.
 *
 * Each item represents a (tenant, peerEndpoint) pair that needs sync attention.
 * Items are ordered by priority score (higher = more urgent).
 *
 * Priority factors:
 * - Time since last write for this tenant (recent writes = urgent)
 * - Time since last successful sync with this peer
 * - Peer reachability status (unreachable = deprioritized)
 *
 * Implementation: binary max-heap with a lookup index for O(log n) upsert.
 */

export interface SyncWorkItem {
  /** The tenant DID. */
  tenant: string;

  /** The peer DWN endpoint URL. */
  peerEndpoint: string;

  /** Computed priority score (higher = more urgent). */
  priority: number;

  /** Epoch ms of the most recent write for this tenant on this node. */
  lastWriteTimestamp: number;

  /** Epoch ms of the last successful sync with this peer for this tenant. */
  lastSyncTimestamp: number;

  /** Number of consecutive sync failures with this peer. */
  consecutiveFailures: number;

  /** Whether this item is currently being processed by a worker. */
  inProgress: boolean;
}

/** Priority multiplier for recent writes (less than 5 minutes old). */
const RECENT_WRITE_BOOST = 100;

/** Priority increase per hour since last sync. */
const STALENESS_PER_HOUR = 10;

/** Priority penalty per consecutive failure (exponential). */
const FAILURE_PENALTY_BASE = 20;

export class SyncPriorityQueue {
  /** Max-heap storage. */
  #heap: SyncWorkItem[] = [];

  /** Lookup: `${tenant}|${peerEndpoint}` → heap index. */
  #index: Map<string, number> = new Map();

  static #key(tenant: string, peerEndpoint: string): string {
    return `${tenant}|${peerEndpoint}`;
  }

  /** Number of items in the queue. */
  get size(): number {
    return this.#heap.length;
  }

  /**
   * Insert or update a work item. If an item for this (tenant, peer) already
   * exists, its metadata is merged and priority recalculated.
   */
  upsert(params: {
    tenant: string;
    peerEndpoint: string;
    lastWriteTimestamp?: number;
    lastSyncTimestamp?: number;
    consecutiveFailures?: number;
  }): void {
    const key = SyncPriorityQueue.#key(params.tenant, params.peerEndpoint);
    const existingIdx = this.#index.get(key);

    if (existingIdx !== undefined) {
      // Update existing item
      const item = this.#heap[existingIdx];
      if (params.lastWriteTimestamp !== undefined) {
        item.lastWriteTimestamp = Math.max(item.lastWriteTimestamp, params.lastWriteTimestamp);
      }
      if (params.lastSyncTimestamp !== undefined) {
        item.lastSyncTimestamp = params.lastSyncTimestamp;
      }
      if (params.consecutiveFailures !== undefined) {
        item.consecutiveFailures = params.consecutiveFailures;
      }
      item.priority = SyncPriorityQueue.#computePriority(item);

      // Re-heapify
      this.#bubbleUp(existingIdx);
      this.#sinkDown(existingIdx);
    } else {
      // Insert new item
      const item: SyncWorkItem = {
        tenant              : params.tenant,
        peerEndpoint        : params.peerEndpoint,
        priority            : 0,
        lastWriteTimestamp  : params.lastWriteTimestamp ?? 0,
        lastSyncTimestamp   : params.lastSyncTimestamp ?? 0,
        consecutiveFailures : params.consecutiveFailures ?? 0,
        inProgress          : false,
      };
      item.priority = SyncPriorityQueue.#computePriority(item);

      this.#heap.push(item);
      this.#index.set(key, this.#heap.length - 1);
      this.#bubbleUp(this.#heap.length - 1);
    }
  }

  /**
   * Remove and return the highest-priority item that is not in progress.
   * Returns undefined if no eligible items exist.
   */
  dequeue(): SyncWorkItem | undefined {
    // Find the highest-priority item not in progress
    // Since this is a heap, we check from the top. If the top is in progress,
    // we need to scan — but in practice most items won't be in progress.
    for (let i = 0; i < this.#heap.length; i++) {
      if (!this.#heap[i].inProgress) {
        const item = this.#heap[i];
        item.inProgress = true;
        return item;
      }
    }
    return undefined;
  }

  /**
   * Mark a work item as completed (no longer in progress).
   * Updates sync timestamp and resets failure count on success.
   */
  complete(tenant: string, peerEndpoint: string, success: boolean): void {
    const key = SyncPriorityQueue.#key(tenant, peerEndpoint);
    const idx = this.#index.get(key);
    if (idx === undefined) {
      return;
    }

    const item = this.#heap[idx];
    item.inProgress = false;

    if (success) {
      item.lastSyncTimestamp = Date.now();
      item.consecutiveFailures = 0;
    } else {
      item.consecutiveFailures++;
    }

    item.priority = SyncPriorityQueue.#computePriority(item);
    this.#bubbleUp(idx);
    this.#sinkDown(idx);
  }

  /**
   * Remove an item from the queue.
   */
  remove(tenant: string, peerEndpoint: string): void {
    const key = SyncPriorityQueue.#key(tenant, peerEndpoint);
    const idx = this.#index.get(key);
    if (idx === undefined) {
      return;
    }

    // Swap with last element and remove
    const lastIdx = this.#heap.length - 1;
    if (idx !== lastIdx) {
      this.#swap(idx, lastIdx);
      this.#heap.pop();
      this.#index.delete(key);

      if (idx < this.#heap.length) {
        this.#bubbleUp(idx);
        this.#sinkDown(idx);
      }
    } else {
      this.#heap.pop();
      this.#index.delete(key);
    }
  }

  /**
   * Get all items (for inspection/debugging). Does not modify the queue.
   */
  getAll(): ReadonlyArray<Readonly<SyncWorkItem>> {
    return this.#heap;
  }

  /**
   * Recalculate priorities for all items. Call periodically to account for
   * time-based priority changes (staleness, write age).
   */
  recalculateAll(): void {
    for (let i = 0; i < this.#heap.length; i++) {
      this.#heap[i].priority = SyncPriorityQueue.#computePriority(this.#heap[i]);
    }
    // Rebuild heap
    for (let i = Math.floor(this.#heap.length / 2) - 1; i >= 0; i--) {
      this.#sinkDown(i);
    }
  }

  /**
   * Compute the priority score for a work item.
   *
   * Higher score = more urgent. Components:
   * - Recent write boost: +100 if last write is less than 5 min old
   * - Staleness: +10 per hour since last sync
   * - Failure penalty: -20 * 2^(failures - 1), capped at -640
   */
  static #computePriority(item: SyncWorkItem): number {
    const now = Date.now();
    let score = 0;

    // Recent write boost
    if (item.lastWriteTimestamp > 0 && (now - item.lastWriteTimestamp) < 300_000) {
      score += RECENT_WRITE_BOOST;
    }

    // Staleness: how long since last sync
    if (item.lastSyncTimestamp > 0) {
      const hoursSinceSync = (now - item.lastSyncTimestamp) / 3_600_000;
      score += hoursSinceSync * STALENESS_PER_HOUR;
    } else {
      // Never synced — high priority
      score += 50;
    }

    // Failure penalty (exponential backoff in priority space)
    if (item.consecutiveFailures > 0) {
      const penalty = FAILURE_PENALTY_BASE * Math.pow(2, Math.min(item.consecutiveFailures - 1, 5));
      score -= penalty;
    }

    return score;
  }

  // ─── Heap operations ────────────────────────────────────────────────

  #bubbleUp(idx: number): void {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.#heap[idx].priority <= this.#heap[parentIdx].priority) {
        break;
      }
      this.#swap(idx, parentIdx);
      idx = parentIdx;
    }
  }

  #sinkDown(idx: number): void {
    const length = this.#heap.length;
    while (true) {
      let largest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < length && this.#heap[left].priority > this.#heap[largest].priority) {
        largest = left;
      }
      if (right < length && this.#heap[right].priority > this.#heap[largest].priority) {
        largest = right;
      }

      if (largest === idx) {
        break;
      }
      this.#swap(idx, largest);
      idx = largest;
    }
  }

  #swap(i: number, j: number): void {
    const a = this.#heap[i];
    const b = this.#heap[j];

    this.#heap[i] = b;
    this.#heap[j] = a;

    // Update index
    this.#index.set(SyncPriorityQueue.#key(a.tenant, a.peerEndpoint), j);
    this.#index.set(SyncPriorityQueue.#key(b.tenant, b.peerEndpoint), i);
  }
}
