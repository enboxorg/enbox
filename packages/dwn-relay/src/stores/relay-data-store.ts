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

// TODO: Implementation
// - Implement DataStore interface (put, get, delete)
// - On put(): delegate to underlying store, record metadata (timestamp, tenant, size)
// - On get(): delegate to underlying store
// - On delete(): delegate to underlying store, update usage tracking
// - Expose query methods for EvictionManager:
//   - getEvictionCandidates(policy, limit): records eligible for eviction
//   - getTotalStorageBytes(): current data storage usage
//   - getTenantStorageBytes(tenant): per-tenant data usage

export class RelayDataStore {
  // Placeholder — will implement DataStore from @enbox/dwn-sdk-js
}
