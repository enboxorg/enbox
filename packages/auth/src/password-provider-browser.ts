/**
 * Browser-safe password provider helpers.
 *
 * Node-only helpers such as environment and TTY prompting stay on
 * `@enbox/auth`; browser code should use callback-based providers or pass
 * passwords directly to auth methods.
 *
 * @module
 */

export { PasswordProvider } from './password-provider-core.js';
export type { PasswordContext } from './password-provider-core.js';
