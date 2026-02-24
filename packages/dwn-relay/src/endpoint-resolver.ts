import type { DidResolver, DidDocument, DidService } from '@enbox/dids';
import log from 'loglevel';

/**
 * Parsed DWN endpoint info from a DID document's #dwn service entry.
 */
export interface DwnEndpointInfo {
  /** The network URL of the DWN endpoint. */
  url: string;

  /**
   * Whether this is a full node (retains all data indefinitely).
   * True if: bare string entry, or map without `dataRetention: "cache"`.
   */
  isFull: boolean;
}

/**
 * Cache for resolved endpoints with TTL.
 */
const endpointCache = new Map<string, { endpoints: DwnEndpointInfo[]; expiresAt: number }>();

/** Default cache TTL: 5 minutes. */
const DEFAULT_CACHE_TTL_MS = 300_000;

/**
 * Resolve DWN service endpoints for a given DID.
 *
 * Handles all `serviceEndpoint` formats from the spec:
 * - Bare string: `"https://dwn.example.com"` → full node
 * - Map: `{ "url": "https://relay.example.com", "dataRetention": "cache" }` → cache node
 * - Array of strings and/or maps
 *
 * Results are cached with a 5-minute TTL.
 */
export async function resolveEndpoints(
  did: string,
  didResolver: DidResolver,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
): Promise<DwnEndpointInfo[]> {
  // Check cache
  const cached = endpointCache.get(did);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.endpoints;
  }

  try {
    const result = await didResolver.resolve(did);
    if (!result.didDocument) {
      return [];
    }

    const endpoints = extractDwnEndpoints(result.didDocument);
    endpointCache.set(did, { endpoints, expiresAt: Date.now() + cacheTtlMs });
    return endpoints;
  } catch (err) {
    log.warn(`Failed to resolve DWN endpoints for DID ${did}:`, err);
    return [];
  }
}

/**
 * Extract DWN service endpoints from a DID document.
 */
export function extractDwnEndpoints(didDocument: DidDocument): DwnEndpointInfo[] {
  const endpoints: DwnEndpointInfo[] = [];

  if (!didDocument.service) {
    return endpoints;
  }

  for (const service of didDocument.service) {
    if (service.type !== 'DecentralizedWebNode') {
      continue;
    }

    const epValue = service.serviceEndpoint;

    if (typeof epValue === 'string') {
      // Bare string — implicitly a full node
      endpoints.push({ url: epValue.replace(/\/+$/, ''), isFull: true });
    } else if (Array.isArray(epValue)) {
      for (const entry of epValue) {
        if (typeof entry === 'string') {
          endpoints.push({ url: entry.replace(/\/+$/, ''), isFull: true });
        } else if (entry && typeof entry === 'object') {
          const map = entry as Record<string, unknown>;
          if (typeof map.url === 'string') {
            endpoints.push({
              url    : (map.url as string).replace(/\/+$/, ''),
              isFull : map.dataRetention !== 'cache',
            });
          }
        }
      }
    } else if (epValue && typeof epValue === 'object') {
      // Single map entry
      const map = epValue as Record<string, unknown>;
      if (typeof map.url === 'string') {
        endpoints.push({
          url    : (map.url as string).replace(/\/+$/, ''),
          isFull : map.dataRetention !== 'cache',
        });
      }
      // Legacy format: object with `nodes` array
      if ('nodes' in map && Array.isArray(map.nodes)) {
        for (const node of map.nodes) {
          if (typeof node === 'string') {
            endpoints.push({ url: node.replace(/\/+$/, ''), isFull: true });
          }
        }
      }
    }
  }

  return endpoints;
}

/**
 * Clear the endpoint resolution cache. Useful for testing.
 */
export function clearEndpointCache(): void {
  endpointCache.clear();
}
