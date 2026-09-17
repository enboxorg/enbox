import type { EnboxPlatformAgent } from './types/agent.js';

import { executeUnlessAborted } from '@enbox/dwn-sdk-js';

import { getEncryptionKeyInfo } from './dwn-encryption.js';

/** Maximum time an interactive connect approval waits for DID-backed network discovery. */
export const CONNECT_DID_RESOLUTION_TIMEOUT_MS = 10_000;

type ConnectEndpointResolutionAgent = Pick<EnboxPlatformAgent, 'dwn'>;

/**
 * Resolves an owner's remote DWN endpoints within the interactive connect
 * budget.
 */
export function resolveConnectDwnEndpointUrls(
  agent: ConnectEndpointResolutionAgent,
  did: string,
): Promise<string[]> {
  return settleConnectNetworkOperation(
    agent.dwn.getRemoteDwnEndpointUrls(did),
    `Connect DWN endpoint resolution for '${did}'`,
  );
}

/** Resolves a requester-supplied delegate's encryption key within the same budget. */
export function resolveConnectDelegateEncryptionKeyInfo(
  agent: EnboxPlatformAgent,
  did: string,
): ReturnType<typeof getEncryptionKeyInfo> {
  return settleConnectNetworkOperation(
    getEncryptionKeyInfo(agent, did),
    `Connect delegate encryption key resolution for '${did}'`,
  );
}

/**
 * DID method resolvers have longer transport timeouts, so awaiting them
 * directly can leave the wallet on "Authorizing…" for tens of seconds.
 *
 * The shared abort fence stops only the caller's wait. The underlying operation
 * remains attached and can finish so the resolver's single-flight/cache still
 * benefits a retry.
 */
async function settleConnectNetworkOperation<T>(
  operation: Promise<T>,
  description: string,
): Promise<T> {
  const timeout = AbortSignal.timeout(CONNECT_DID_RESOLUTION_TIMEOUT_MS);

  try {
    return await executeUnlessAborted(operation, timeout);
  } catch (error) {
    if (timeout.aborted && error === timeout.reason) {
      throw new Error(
        `${description} timed out after ${CONNECT_DID_RESOLUTION_TIMEOUT_MS}ms.`,
      );
    }
    throw error;
  }
}
