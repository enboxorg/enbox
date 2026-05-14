/**
 * @enbox/browser — The Enbox browser SDK.
 *
 * For browser-based dapps, this is the only package you need to import.
 * It re-exports the high-level API from `@enbox/api`, the authentication
 * layer from `@enbox/auth`, and provides browser-specific connect handlers.
 *
 * @example Single-import dapp setup
 * ```ts
 * import {
 *   Enbox, BrowserConnectHandler,
 *   defineProtocol, repository,
 * } from '@enbox/browser';
 *
 * const { enbox, session } = await Enbox.connect({
 *   connectHandler: BrowserConnectHandler({ appName: 'My App' }),
 *   protocols: [MyProtocol],
 * });
 * ```
 *
 * For non-browser environments (Node.js, CLI, desktop), import from
 * `@enbox/api` and `@enbox/auth` directly instead.
 *
 * @packageDocumentation
 */

// ─── Re-exports from @enbox/api ─────────────────────────────────
//
// The high-level Enbox API: DWN records, protocols, repositories.

export {
  Enbox,
  defineProtocol,
  repository,
} from '@enbox/api';

export type {
  EnboxAnonymousOptions,
  EnboxConnectOptions,
  EnboxConnectResult,
  EnboxParams,
  EnboxSessionParams,
} from '@enbox/api';

// ─── Re-exports from @enbox/auth ────────────────────────────────
//
// Authentication lifecycle, session management, connect handlers.

export {
  AuthManager,
  AuthSession,
  normalizeProtocolRequests,
  WalletConnect,
} from '@enbox/auth';

export type {
  AuthEvent,
  AuthEventHandler,
  AuthManagerOptions,
  AuthState,
  ConnectHandler,
  ConnectOptions,
  ConnectResult,
  DisconnectOptions,
  HandlerConnectOptions,
  ImportFromPhraseOptions,
  ImportFromPortableOptions,
  LocalConnectOptions,
  Permission,
  PortableIdentity,
  ProtocolRequest,
  RegistrationOptions,
  StorageAdapter,
  SyncOption,
  WalletConnectOptions,
} from '@enbox/auth';

// ─── Browser-specific exports ───────────────────────────────────
//
// DWeb Connect, wallet selector, DRL polyfills.

export * from './web-features.js';
export { BrowserConnectHandler, DEFAULT_WALLETS } from './browser-connect-handler.js';
export type { BrowserConnectHandlerOptions, WalletOption } from './browser-connect-handler.js';
export { DWebConnect } from './dweb-connect-client.js';
export type { DWebConnectClientOptions } from './dweb-connect-client.js';
export { showWalletSelector } from './ui/wallet-selector.js';
export { encryptPostMessagePayload, generateEphemeralKeyPair } from './dweb-connect-crypto.js';
export type { EncryptedPostMessagePayload } from './dweb-connect-crypto.js';
