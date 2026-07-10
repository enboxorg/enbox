/**
 * Permission request normalization utilities.
 *
 * Converts simplified `ProtocolRequest` entries (just a protocol definition
 * or `{ definition, permissions }`) into agent-level `ConnectPermissionRequest`
 * objects used by connect handlers.
 *
 * @module
 * @internal
 */

import type { ConnectPermissionRequest } from '@enbox/connect';
import type { DwnProtocolDefinition } from '@enbox/agent';

import type { ProtocolRequest } from './types.js';

import { DEFAULT_PERMISSIONS } from './types.js';
import { WalletConnect } from './wallet-connect-client.js';

/**
 * Normalize simplified `ProtocolRequest[]` into agent-level
 * `ConnectPermissionRequest[]`.
 */
export function normalizeProtocolRequests(
  protocols: ProtocolRequest[] | undefined,
): ConnectPermissionRequest[] {
  if (!protocols || protocols.length === 0) { return []; }

  return protocols.map((entry) => {
    let definition: DwnProtocolDefinition;
    let permissions: string[];

    if ('protocol' in entry && 'types' in entry && 'structure' in entry) {
      // Bare protocol definition — use default permissions.
      definition = entry as DwnProtocolDefinition;
      permissions = [...DEFAULT_PERMISSIONS];
    } else {
      // Object with explicit permissions.
      const explicit = entry as { definition: DwnProtocolDefinition; permissions: string[] };
      definition = explicit.definition;
      permissions = explicit.permissions;
    }

    return WalletConnect.createPermissionRequestForProtocol({
      definition,
      permissions: permissions as Parameters<typeof WalletConnect.createPermissionRequestForProtocol>[0]['permissions'],
    });
  });
}
