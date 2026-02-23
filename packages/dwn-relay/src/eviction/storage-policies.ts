/**
 * Per-protocol storage retention policies.
 *
 * The operator configures how long record data is retained per protocol.
 * Protocols not explicitly configured use the global DWN_RELAY_DATA_RETENTION.
 */

export interface StoragePolicy {
  /** Protocol URI this policy applies to. '*' for the global default. */
  protocol: string;

  /** Maximum age of record data before it becomes eligible for eviction. */
  retentionDuration: string;
}

/**
 * Parse protocol policies from config into StoragePolicy objects.
 */
export function parsePolicies(
  globalRetention: string,
  protocolOverrides: Record<string, string>,
): StoragePolicy[] {
  const policies: StoragePolicy[] = [
    { protocol: '*', retentionDuration: globalRetention },
  ];

  for (const [protocol, duration] of Object.entries(protocolOverrides)) {
    policies.push({ protocol, retentionDuration: duration });
  }

  return policies;
}
