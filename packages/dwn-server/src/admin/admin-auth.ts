import type { AdminSessionManager } from './admin-session.js';
import type { DwnServerConfig } from '../config.js';

import { timingSafeEqual } from 'crypto';

/**
 * The result of admin authentication.
 *
 * When authentication succeeds, `authMethod` indicates how the caller
 * authenticated:
 * - `'token'`   — static bearer token (from `DWN_ADMIN_TOKEN`)
 * - `'session'` — passkey-derived session token
 */
export type AdminAuthResult = {
  /** `null` when auth succeeded, or a `Response` to send back on failure. */
  error : Response | null;
  /** How the caller authenticated. Only set when `error` is `null`. */
  authMethod? : 'token' | 'session';
};

/**
 * Validates the admin bearer token from the `Authorization` header.
 *
 * Supports two authentication methods:
 * 1. **Static bearer token** — the original `DWN_ADMIN_TOKEN`
 * 2. **Session token** — issued after a successful WebAuthn passkey login
 *
 * @returns An {@link AdminAuthResult}. When `error` is `null`, auth passed.
 */
export function validateAdminAuth(
  req: Request,
  config: DwnServerConfig,
  sessionManager?: AdminSessionManager,
): AdminAuthResult {
  const expectedToken = config.adminToken;

  // If no admin token is configured, the admin API is disabled.
  // Return 404 to avoid revealing the endpoint exists.
  if (!expectedToken) {
    return { error: new Response('Not Found', { status: 404 }) };
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return { error: new Response('Unauthorized', { status: 401 }) };
  }

  // Expect "Bearer <token>" format.
  if (!authHeader.startsWith('Bearer ')) {
    return { error: new Response('Unauthorized', { status: 401 }) };
  }

  const suppliedToken = authHeader.slice('Bearer '.length);

  // Try static token first.
  if (constantTimeEquals(expectedToken, suppliedToken)) {
    return { error: null, authMethod: 'token' };
  }

  // Try session token if a session manager is available.
  if (sessionManager?.validate(suppliedToken)) {
    return { error: null, authMethod: 'session' };
  }

  return { error: new Response('Unauthorized', { status: 401 }) };
}

/**
 * Compares two strings in constant time to prevent timing attacks.
 * If the strings differ in length, the comparison still takes constant time
 * relative to the expected token length.
 */
function constantTimeEquals(expected: string, supplied: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const suppliedBuf = Buffer.from(supplied, 'utf-8');

  // If lengths differ, we still perform a comparison against the expected buffer
  // to avoid leaking length information through timing.
  if (expectedBuf.length !== suppliedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return timingSafeEqual(expectedBuf, suppliedBuf);
}
