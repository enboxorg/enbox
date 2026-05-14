/**
 * AuthSession represents an active, authenticated session with a specific identity.
 * @module
 */

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
 *
 * Structurally identical to {@link AgentSession} — it exists as a separate
 * exported class for backwards compatibility and to keep `@enbox/auth`'s
 * public surface self-contained. `IdentityInfo` is an alias for
 * `AgentSessionIdentity`, so the inherited constructor handles every field.
 */
export class AuthSession extends AgentSession {}
