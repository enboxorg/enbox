/**
 * AuthSession represents an active, authenticated session with a specific identity.
 * @module
 */

import type { AgentSessionParams } from '@enbox/agent';

import type { IdentityInfo } from './types.js';

import { AgentSession } from '@enbox/agent';

/**
 * An active, authenticated session bound to a specific identity.
 *
 * The session exposes the authenticated **agent**, **did**, and
 * **delegateDid** — the primitives needed to interact with the DWN
 * network. Consumers that use `@enbox/api` can construct an `Enbox`
 * instance from these properties:
 *
 * ```ts
 * import { Enbox } from '@enbox/api';
 *
 * const session = await auth.connect();
 * const enbox = Enbox.fromSession(session);
 * ```
 */
export class AuthSession extends AgentSession {
  public constructor(params: Omit<AgentSessionParams, 'identity'> & { identity: IdentityInfo }) {
    super(params);
  }
}
