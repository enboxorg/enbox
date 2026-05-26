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
 * const session = await auth.connectVault({ password: userPin });
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

// Core classes
export { AuthManager } from './auth-manager.js';
export { AuthSession } from './identity-session.js';
export { AuthEventEmitter } from './events.js';

// Password providers
export { PasswordProvider } from './password-provider.js';
export type { PasswordContext } from './password-provider.js';

// Re-export agent classes so consumers can construct custom agents/vaults
// without a direct @enbox/agent dependency.
export { EnboxUserAgent, HdIdentityVault } from '@enbox/agent';

// Connect helpers
export { processConnectedGrants } from './connect/wallet.js';
export { normalizeProtocolRequests } from './permissions.js';
export { WalletConnect } from './wallet-connect-client.js';
export type { ProtocolPermissionOptions, WalletConnectClientOptions } from './wallet-connect-client.js';

// Registration token storage helpers
export { loadTokensFromStorage, saveTokensToStorage } from './registration.js';

// Local DWN discovery (browser dwn:// protocol integration)
export {
  applyLocalDwnDiscovery,
  checkUrlForDwnDiscoveryPayload,
  clearLocalDwnEndpoint,
  discoverLocalDwn,
  persistLocalDwnEndpoint,
  requestLocalDwnDiscovery,
  restoreLocalDwnEndpoint,
} from './discovery.js';

// Storage adapters
export { BrowserStorage, LevelStorage, MemoryStorage, createDefaultStorage } from './storage/storage.js';

// Revocation retry (exported for cross-package integration testing)
export { retryOrphanedRevocations } from './connect/restore.js';

// Storage keys (exported for cross-package integration testing)
export { STORAGE_KEYS } from './types.js';

// Types
export type {
  AuthEvent,
  AuthEventHandler,
  AuthEventMap,
  AuthManagerOptions,
  AuthSessionInfo,
  AuthState,
  ConnectHandler,
  ConnectOptions,
  ConnectPermissionRequest,
  ConnectResult,
  DisconnectOptions,
  HandlerConnectOptions,
  HeadlessConnectOptions,
  IdentityInfo,
  IdentityVaultBackup,
  ImportFromPhraseOptions,
  ImportFromPortableOptions,
  LocalConnectOptions,
  LocalDwnStrategy,
  VaultConnectOptions,
  Permission,
  PortableIdentity,
  ProtocolRequest,
  ProviderAuthParams,
  ProviderAuthResult,
  RegistrationOptions,
  RegistrationTokenData,
  RestoreSessionOptions,
  ShutdownOptions,
  StorageAdapter,
  SyncOption,
  WalletConnectOptions,
} from './types.js';
