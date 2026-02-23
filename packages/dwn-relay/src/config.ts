/**
 * Relay-specific configuration, extending dwn-server config.
 * All values sourced from environment variables.
 */
export interface RelayConfig {
  /** Data retention window (e.g., "72h", "7d"). Data older than this is eligible for eviction. */
  dataRetention: string;

  /** Maximum bytes for record data storage. Eviction triggers at this threshold. 0 = unlimited. */
  storageMaxBytes: number;

  /** IPFS HTTP gateway URL for resolving published record data on cache miss. Undefined to disable. */
  ipfsGatewayUrl?: string;

  /** Number of concurrent sync workers. */
  syncWorkers: number;

  /** Interval between sync priority queue scans in seconds. */
  syncIntervalSeconds: number;

  /** Per-protocol storage policy overrides. Maps protocol URI to retention duration string. */
  protocolPolicies: Record<string, string>;
}

export function getRelayConfig(): RelayConfig {
  let protocolPolicies: Record<string, string> = {};
  const policiesEnv = process.env.DWN_RELAY_PROTOCOL_POLICIES;
  if (policiesEnv) {
    try {
      protocolPolicies = JSON.parse(policiesEnv);
    } catch {
      // ignore invalid JSON, use empty policies
    }
  }

  return {
    dataRetention       : process.env.DWN_RELAY_DATA_RETENTION || '72h',
    storageMaxBytes     : parseInt(process.env.DWN_RELAY_STORAGE_MAX_BYTES || '0'),
    ipfsGatewayUrl      : process.env.DWN_RELAY_IPFS_GATEWAY || undefined,
    syncWorkers         : parseInt(process.env.DWN_RELAY_SYNC_WORKERS || '8'),
    syncIntervalSeconds : parseInt(process.env.DWN_RELAY_SYNC_INTERVAL || '30'),
    protocolPolicies,
  };
}
