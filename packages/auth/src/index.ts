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
 * const auth = await AuthManager.create({ sync: '15s' });
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

// Re-export the service-config announcement protocol so apps can add it to a
// connect request (see `serviceConfigProtocolRequest`) and inspect announcements
// without a direct @enbox/agent dependency.
export {
  ServiceConfigProtocolDefinition,
  SERVICE_CONFIG_PROTOCOL_URI,
  SERVICE_CONFIG_PROTOCOL_PATH,
} from '@enbox/agent';
export type { ServiceConfig } from '@enbox/agent';
