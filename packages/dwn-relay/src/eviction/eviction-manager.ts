/**
 * EvictionManager monitors storage usage and evicts record data from the
 * DataStore when storage pressure exceeds configured thresholds.
 *
 * Key invariant: only record data is evicted. Message envelopes (MessageStore)
 * and SMT entries (StateIndex) are never touched by eviction — they are required
 * for sync correctness.
 *
 * Eviction strategies (operator-configurable per protocol):
 * - Synced-first: prefer data confirmed synced to a full peer
 * - Age-based: evict data older than the retention window
 * - Size-based: evict largest records first
 * - Combination: synced + age as primary, size as tiebreaker
 */

// TODO: Implementation
// - Periodic storage usage check against storageMaxBytes threshold
// - Query PeerSyncState to identify synced-safe eviction candidates
// - Query MessageStore for records exceeding retention window
// - Delete from DataStore (not MessageStore, not StateIndex)
// - Per-protocol policy overrides from RelayConfig.protocolPolicies

export class EvictionManager {
  // Placeholder
}
