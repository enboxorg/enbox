import { parseDuration } from '../config.js';

/**
 * Per-protocol storage retention policies.
 *
 * The operator configures how long record data is retained per protocol.
 * Protocols not explicitly configured use the global DWN_RELAY_DATA_RETENTION.
 */
export interface StoragePolicy {
  /** Protocol URI this policy applies to. '*' for the global default. */
  protocol: string;

  /** Maximum age of record data before it becomes eligible for eviction, in milliseconds. */
  retentionMs: number;
}

/**
 * Parse protocol policies from config into StoragePolicy objects.
 */
export function parsePolicies(
  globalRetention: string,
  protocolOverrides: Record<string, string>,
): StoragePolicy[] {
  const policies: StoragePolicy[] = [
    { protocol: '*', retentionMs: parseDuration(globalRetention) },
  ];

  for (const [protocol, duration] of Object.entries(protocolOverrides)) {
    policies.push({ protocol, retentionMs: parseDuration(duration) });
  }

  return policies;
}

/**
 * Get the retention duration for a given protocol URI.
 * Falls back to the global default ('*') if no protocol-specific policy exists.
 */
export function getRetentionMs(policies: StoragePolicy[], protocol?: string): number {
  if (protocol) {
    const match = policies.find(p => p.protocol === protocol);
    if (match) {
      return match.retentionMs;
    }
  }
  const global = policies.find(p => p.protocol === '*');
  return global?.retentionMs ?? 259_200_000; // default 72h
}
