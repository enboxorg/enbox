import type { EnboxPlatformAgent } from './types/agent.js';

/** Maximum time an interactive connect approval waits for DWN endpoint discovery. */
export const CONNECT_ENDPOINT_RESOLUTION_TIMEOUT_MS = 10_000;

type ConnectEndpointResolutionAgent = Pick<EnboxPlatformAgent, 'dwn'>;

/**
 * Resolves an owner's remote DWN endpoints within the interactive connect
 * budget. DID method resolvers have longer transport timeouts, so awaiting
 * them directly can leave the wallet on "Authorizing…" for tens of seconds.
 *
 * The underlying resolution is allowed to finish so the resolver's
 * single-flight/cache can still benefit a retry. Attaching both settlement
 * handlers also prevents a late rejection from becoming unhandled after the
 * caller has received the timeout.
 */
export async function resolveConnectDwnEndpointUrls(
  agent: ConnectEndpointResolutionAgent,
  did: string,
): Promise<string[]> {
  const resolution = agent.dwn.getRemoteDwnEndpointUrls(did);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout((): void => {
      reject(new Error(
        `Connect DWN endpoint resolution for '${did}' timed out after ${CONNECT_ENDPOINT_RESOLUTION_TIMEOUT_MS}ms.`,
      ));
    }, CONNECT_ENDPOINT_RESOLUTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([resolution, timedOut]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
