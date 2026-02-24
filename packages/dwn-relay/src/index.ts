// Main server
export { RelayServer } from './relay-server.js';
export type { RelayServerOptions } from './relay-server.js';

// Configuration
export { RelayConfig, getRelayConfig, parseDuration } from './config.js';

// Stores
export { RelayDataStore } from './stores/relay-data-store.js';
export type { DataMetadataEntry, RelayDataStoreProxyOptions } from './stores/relay-data-store.js';

// Eviction
export { EvictionManager } from './eviction/eviction-manager.js';
export { parsePolicies, getRetentionMs } from './eviction/storage-policies.js';
export type { StoragePolicy } from './eviction/storage-policies.js';

// Read proxy (standalone class for direct use; also integrated into RelayDataStore.get())
export { ReadProxy } from './proxy/read-proxy.js';
export { IpfsResolver } from './proxy/ipfs-resolver.js';

// Sync
export { ServerSyncEngine } from './sync/server-sync-engine.js';
export type { PeerSyncState } from './sync/server-sync-engine.js';
export { SyncPriorityQueue } from './sync/priority-queue.js';
export type { SyncWorkItem } from './sync/priority-queue.js';
export { ConnectionPool } from './sync/connection-pool.js';

// Endpoint resolution
export { resolveEndpoints, extractDwnEndpoints, clearEndpointCache } from './endpoint-resolver.js';
export type { DwnEndpointInfo } from './endpoint-resolver.js';
