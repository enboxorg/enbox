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
 * const session = await auth.connect();
 * const enbox = Enbox.fromSession(session);
 * ```
 *
 * @module
 */

export { AgentSession as AuthSession } from '@enbox/agent';
