/**
 * Browser-safe auth surface used by `@enbox/browser`.
 *
 * This intentionally exposes only the browser-safe PasswordProvider helpers.
 * Import the Node root `@enbox/auth` for env and TTY password providers.
 *
 * @module
 */

export { AuthManager } from './auth-manager.js';
export { AuthSession } from './identity-session.js';
export { AuthEventEmitter } from './events.js';
export { RecoveryPhraseMismatchError, isRecoveryPhraseMismatchError } from './errors.js';
export { PasswordProvider } from './password-provider-browser.js';
export type { PasswordContext } from './password-provider-browser.js';

export { processConnectedGrants } from './connect/wallet.js';
export { normalizeProtocolRequests } from './permissions.js';
export { WalletConnect } from './wallet-connect-client.js';
export type { ProtocolPermissionOptions, WalletConnectClientOptions } from './wallet-connect-client.js';

export { loadTokensFromStorage, saveTokensToStorage } from './registration.js';

export {
  applyLocalDwnDiscovery,
  checkUrlForDwnDiscoveryPayload,
  clearLocalDwnEndpoint,
  discoverLocalDwn,
  persistLocalDwnEndpoint,
  requestLocalDwnDiscovery,
  restoreLocalDwnEndpoint,
} from './discovery.js';

export { BrowserStorage, LevelStorage, MemoryStorage, createDefaultStorage } from './storage/storage.js';

export { retryOrphanedRevocations } from './connect/restore.js';
export { STORAGE_KEYS } from './types.js';

export type {
  AuthEvent,
  AuthEventHandler,
  AuthEventMap,
  AuthManagerOptions,
  AuthSessionInfo,
  AuthState,
  ConnectClientMetadata,
  ConnectHandler,
  ConnectOptions,
  ConnectPermissionRequest,
  ConnectResult,
  DisconnectOptions,
  HandlerConnectOptions,
  HeadlessConnectOptions,
  IdentityInfo,
  IdentityVaultBackup,
  ImportFromPortableOptions,
  LocalDwnStrategy,
  Permission,
  PortableIdentity,
  ProtocolRequest,
  ProviderAuthParams,
  ProviderAuthResult,
  RegistrationOptions,
  RegistrationTokenData,
  RestoreFromPhraseOptions,
  RestoreSessionOptions,
  ShutdownOptions,
  StorageAdapter,
  SyncOption,
  VaultConnectOptions,
  WalletConnectOptions,
} from './types.js';
