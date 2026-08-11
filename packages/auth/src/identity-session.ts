/**
 * `AuthSession` is an alias for {@link AgentSession} from `@enbox/agent`.
 *
 * The alias exists so `@enbox/auth`'s public surface stays self-contained.
 * `new AuthSession(...)` constructs an `AgentSession`, and `instanceof
 * AuthSession` and `instanceof AgentSession` both succeed on any session
 * created through either name. New code should prefer `AgentSession`
 * directly.
 *
 * @example
 * ```ts
 * import { Enbox } from '@enbox/api';
 *
 * const session = await auth.connectVault({ createIdentity: true });
 * const enbox = Enbox.fromSession(session);
 *
 * // Release the session facade before ending the caller-owned auth lifecycle.
 * enbox.close();
 * await auth.disconnect();
 * await auth.shutdown();
 * ```
 *
 * @module
 */

export { AgentSession as AuthSession } from '@enbox/agent';
