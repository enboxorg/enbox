/**
 * @enbox/auth — Headless authentication and identity management SDK.
 *
 * Provides composable, multi-identity-aware authentication that works
 * in both browser and CLI environments. Depends only on `@enbox/agent`
 * and can be used standalone or consumed by `@enbox/api`.
 *
 * @example Standalone auth
 * ```ts
 * import { AuthManager } from '@enbox/auth';
 *
 * const auth = await AuthManager.create({ sync: '15s' });
 * const session = await auth.restoreSession() ?? await auth.connect();
 *
 * // session.agent — the authenticated Enbox agent
 * // session.did   — the connected DID URI
 * ```
 *
 * @example With @enbox/api
 * ```ts
 * import { AuthManager } from '@enbox/auth';
 * import { Enbox } from '@enbox/api';
 *
 * const auth = await AuthManager.create({ sync: '15s' });
 * const session = await auth.connect();
 *
 * const enbox = Enbox.connect({
 *   agent: session.agent,
 *   connectedDid: session.did,
 *   delegateDid: session.delegateDid,
 * });
 * ```
 *
 * @packageDocumentation
 */

// Core classes
export { AuthManager } from './auth-manager.js';
export { AuthSession } from './identity-session.js';
export { VaultManager } from './vault/vault-manager.js';
export { AuthEventEmitter } from './events.js';

// Password providers
export { PasswordProvider } from './password-provider.js';
export type { PasswordContext } from './password-provider.js';

// Re-export agent classes so consumers can construct custom agents/vaults
// without a direct @enbox/agent dependency.
export { EnboxUserAgent, HdIdentityVault } from '@enbox/agent';

// Wallet-connect helpers
export { processConnectedGrants } from './flows/wallet-connect.js';

// Registration token storage helpers
export { loadTokensFromStorage, saveTokensToStorage } from './flows/dwn-registration.js';

// Local DWN discovery (browser dwn:// protocol integration)
export {
  applyLocalDwnDiscovery,
  checkUrlForDwnDiscoveryPayload,
  clearLocalDwnEndpoint,
  persistLocalDwnEndpoint,
  probeLocalDwn,
  requestLocalDwnDiscovery,
  restoreLocalDwnEndpoint,
} from './flows/dwn-discovery.js';

// Storage adapters
export { BrowserStorage, LevelStorage, MemoryStorage, createDefaultStorage } from './storage/storage.js';

// Types
export type {
  AuthEvent,
  AuthEventHandler,
  AuthEventMap,
  AuthManagerOptions,
  AuthSessionInfo,
  AuthState,
  ConnectPermissionRequest,
  DisconnectOptions,
  HeadlessConnectOptions,
  IdentityInfo,
  IdentityVaultBackup,
  ImportFromPhraseOptions,
  ImportFromPortableOptions,
  LocalConnectOptions,
  LocalDwnStrategy,
  PortableIdentity,
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
