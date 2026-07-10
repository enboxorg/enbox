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
} from '@enbox/auth/browser';

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
  ImportFromPortableOptions,
  VaultConnectOptions,
  Permission,
  PortableIdentity,
  ProtocolRequest,
  RegistrationOptions,
  StorageAdapter,
  SyncOption,
  WalletConnectOptions,
} from '@enbox/auth/browser';

// ─── Re-exports from @enbox/connect ─────────────────────────────
//
// The connect kernel pieces wallet apps need alongside the popup
// transports: opening/sealing envelopes and the deny token.

export { CONNECT_DENIED_TOKEN, ConnectProvider } from '@enbox/connect';
export type { ConnectApproval, ConnectPermissionRequest, ConnectRequest } from '@enbox/connect';

// ─── Browser-specific exports ───────────────────────────────────
//
// DWeb Connect popup transports, wallet selector, DRL polyfills.

export * from './web-features.js';
export { BrowserConnectHandler, DEFAULT_WALLETS } from './browser-connect-handler.js';
export type { BrowserConnectHandlerOptions, WalletOption } from './browser-connect-handler.js';
export { connectViaPopup, PopupClientTransport, PopupWindowClosedError } from './dweb-connect-client.js';
export type { PopupClientTransportOptions, PopupConnectOptions } from './dweb-connect-client.js';
export { WalletPostMessageTransport } from './dweb-connect-wallet.js';
export type { WalletPostMessageTransportOptions } from './dweb-connect-wallet.js';
export {
  DWEB_CONNECT_LOADED_MESSAGE_TYPE,
  DWEB_CONNECT_PATH,
  DWEB_CONNECT_REQUEST_MESSAGE_TYPE,
  DWEB_CONNECT_RESPONSE_MESSAGE_TYPE,
} from './dweb-connect-messages.js';
export type {
  DWebConnectLoadedMessage,
  DWebConnectRequestMessage,
  DWebConnectResponseMessage,
} from './dweb-connect-messages.js';
export { showWalletSelector } from './ui/wallet-selector.js';
