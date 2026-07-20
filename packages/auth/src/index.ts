/**
 * @enbox/auth — Headless authentication and identity management SDK.
 *
 * Provides composable, multi-identity-aware authentication that works
 * in both browser and CLI environments. Depends only on `@enbox/agent`
 * and can be used standalone or consumed by `@enbox/api`.
 *
 * @example Standalone auth (wallet app)
 * ```ts
 * import { AuthManager } from '@enbox/auth';
 *
 * const auth = await AuthManager.create();
 * const session = await auth.connectVault({ password: userPin, createIdentity: true });
 * ```
 *
 * @example Dapp with browser connect handler
 * ```ts
 * import { AuthManager } from '@enbox/auth';
 * import { BrowserConnectHandler } from '@enbox/browser';
 *
 * const auth = await AuthManager.create({
 *   connectHandler: BrowserConnectHandler(),
 * });
 * const session = await auth.connect({ protocols: [NotesProtocol] });
 * ```
 *
 * @packageDocumentation
 */

export * from './shared.js';

// Password providers
export { PasswordProvider } from './password-provider.js';
export type { PasswordContext } from './password-provider.js';

// Re-export agent classes so consumers can construct custom agents/vaults
// without a direct @enbox/agent dependency.
export { EnboxUserAgent, HdIdentityVault } from '@enbox/agent';
