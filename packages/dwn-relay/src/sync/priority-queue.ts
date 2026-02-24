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
 */

export interface SyncWorkItem {
  tenant: string;
  peerEndpoint: string;
  priority: number;
  lastWriteTimestamp?: number;
  lastSyncTimestamp?: number;
  consecutiveFailures: number;
}

// TODO: Implementation
// - Min-heap or sorted structure ordered by priority
// - Deduplication: only one item per (tenant, peerEndpoint) pair
// - Priority recalculation on re-insertion
// - Batch insertion for periodic scans

export class SyncPriorityQueue {
  // Placeholder
}
