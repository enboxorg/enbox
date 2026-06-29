import { testDwnUrl } from './test-config.js';

let reachable: boolean | undefined;

/**
 * Fail fast with an actionable message when the local DWN server that an
 * end-to-end spec depends on is not reachable, instead of letting the spec time
 * out on an opaque connection error.
 *
 * Test-only helper — it never touches production code. Call it as the first
 * statement of the earliest hook (`beforeAll`/`beforeEach`) that runs before any
 * remote DWN operation. A successful probe is cached, so calling it from
 * `beforeEach` does not re-hit the network on every test.
 *
 * @param url - DWN server base URL to probe; defaults to `testDwnUrl`.
 * @throws when the server does not answer `GET /info` within the timeout.
 */
export async function requireDwnServer(url: string = testDwnUrl): Promise<void> {
  if (reachable === true) {
    return;
  }
  let isReachable = false;
  try {
    const response = await fetch(`${url}/info`, { signal: AbortSignal.timeout(2000) });
    isReachable = response.ok;
  } catch {
    isReachable = false;
  }
  if (isReachable) {
    reachable = true;
    return;
  }
  throw new Error(
    `DWN server not reachable at ${url}. Start the local dev environment with ` +
    '`bun run dev:ensure` (or `scripts/dev.sh ensure`) — see docs/TESTING.md.',
  );
}
