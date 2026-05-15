/**
 * `AuthSession` is an alias for {@link AgentSession} from `@enbox/agent`.
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
 * This is a direct re-export of {@link AgentSession} — `new AuthSession(...)`
 * constructs an `AgentSession`, and `instanceof AuthSession` and
 * `instanceof AgentSession` both succeed on any session created through
 * either name. The alias exists so `@enbox/auth`'s public surface stays
 * self-contained; new code should prefer `AgentSession` directly.
 */
export { AgentSession as AuthSession };
