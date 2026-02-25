import type { DwnServerConfig } from '../config.js';

import { timingSafeEqual } from 'crypto';

/**
 * Validates the admin bearer token from the `Authorization` header.
 *
 * @returns `null` if authentication succeeds, or a `Response` with the appropriate
 *          error status (404 if admin is disabled, 401 if credentials are missing/invalid).
 */
export function validateAdminAuth(req: Request, config: DwnServerConfig): Response | null {
  const expectedToken = config.adminToken;

  // If no admin token is configured, the admin API is disabled.
  // Return 404 to avoid revealing the endpoint exists.
  if (!expectedToken) {
    return new Response('Not Found', { status: 404 });
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Expect "Bearer <token>" format.
  if (!authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const suppliedToken = authHeader.slice('Bearer '.length);

  if (!constantTimeEquals(expectedToken, suppliedToken)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return null; // auth passed
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
