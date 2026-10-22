/**
 * Browser-safe auth surface used by `@enbox/browser`.
 *
 * Exposes the shared auth APIs and browser-safe PasswordProvider helpers.
 * Import the Node root `@enbox/auth` for env and TTY password providers.
 *
 * @module
 */

export * from './shared.js';
export { PasswordProvider } from './password-provider-browser.js';
export type { PasswordContext } from './password-provider-browser.js';
