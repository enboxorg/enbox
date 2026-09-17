import type { EnboxPlatformAgent } from './types/agent.js';

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
 * The underlying operation is allowed to finish so the resolver's
 * single-flight/cache can still benefit a retry. Promise.race attaches a
 * rejection handler to both inputs, preventing a late operation failure from
 * becoming unhandled after the caller has received the timeout.
 */
async function settleConnectNetworkOperation<T>(
  operation: Promise<T>,
  description: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout((): void => {
      reject(new Error(
        `${description} timed out after ${CONNECT_DID_RESOLUTION_TIMEOUT_MS}ms.`,
      ));
    }, CONNECT_DID_RESOLUTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
