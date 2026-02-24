import log from 'loglevel';

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

  /** Interval in seconds between eviction manager scans. */
  evictionIntervalSeconds: number;

  /** High-water mark (0.0-1.0) of storageMaxBytes that triggers eviction. */
  evictionHighWaterMark: number;

  /** Low-water mark (0.0-1.0) of storageMaxBytes that eviction targets. */
  evictionLowWaterMark: number;

  /** Read proxy timeout in milliseconds for peer and IPFS requests. */
  readProxyTimeoutMs: number;

  /** Whether to re-cache data fetched via read proxy. */
  readProxyCacheLocally: boolean;

  /** This node's own base URL, used to filter self from peer endpoint lists. */
  selfUrl?: string;
}

/**
 * Parse a duration string like "72h", "7d", "30m", "3600s" into milliseconds.
 * Supports: ms, s, m, h, d suffixes. Plain numbers are treated as milliseconds.
 */
export function parseDuration(duration: string): number {
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) {
    throw new Error(`Invalid duration string: "${duration}"`);
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const multipliers: Record<string, number> = {
    ms : 1,
    s  : 1_000,
    m  : 60_000,
    h  : 3_600_000,
    d  : 86_400_000,
  };
  return value * multipliers[unit];
}

export function getRelayConfig(): RelayConfig {
  let protocolPolicies: Record<string, string> = {};
  const policiesEnv = process.env.DWN_RELAY_PROTOCOL_POLICIES;
  if (policiesEnv) {
    try {
      protocolPolicies = JSON.parse(policiesEnv);
    } catch {
      log.warn('Failed to parse DWN_RELAY_PROTOCOL_POLICIES, using empty policies');
    }
  }

  return {
    dataRetention           : process.env.DWN_RELAY_DATA_RETENTION || '72h',
    storageMaxBytes         : parseInt(process.env.DWN_RELAY_STORAGE_MAX_BYTES || '0'),
    ipfsGatewayUrl          : process.env.DWN_RELAY_IPFS_GATEWAY || undefined,
    syncWorkers             : parseInt(process.env.DWN_RELAY_SYNC_WORKERS || '8'),
    syncIntervalSeconds     : parseInt(process.env.DWN_RELAY_SYNC_INTERVAL || '30'),
    protocolPolicies,
    evictionIntervalSeconds : parseInt(process.env.DWN_RELAY_EVICTION_INTERVAL || '60'),
    evictionHighWaterMark   : parseFloat(process.env.DWN_RELAY_EVICTION_HIGH_WATER || '0.9'),
    evictionLowWaterMark    : parseFloat(process.env.DWN_RELAY_EVICTION_LOW_WATER || '0.7'),
    readProxyTimeoutMs      : parseInt(process.env.DWN_RELAY_READ_PROXY_TIMEOUT_MS || '15000'),
    readProxyCacheLocally   : process.env.DWN_RELAY_READ_PROXY_CACHE !== 'false',
    selfUrl                 : process.env.DWN_BASE_URL || undefined,
  };
}
