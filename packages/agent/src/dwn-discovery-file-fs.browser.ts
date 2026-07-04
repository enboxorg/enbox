import type { DiscoveryFileFs } from './dwn-discovery-file.js';

/**
 * Browser bundles do not have a default filesystem discovery adapter.
 */
export function createNodeDiscoveryFileFs(): DiscoveryFileFs | undefined {
  return undefined;
}
