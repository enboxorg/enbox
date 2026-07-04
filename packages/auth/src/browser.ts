/**
 * Browser-safe auth surface used by `@enbox/browser`.
 *
 * This intentionally omits `PasswordProvider`, whose env and TTY helpers are
 * Node-only. Import those helpers from `@enbox/auth` in CLI/server code.
 *
 * @module
 */

export { AuthManager } from './auth-manager.js';
export { AuthSession } from './identity-session.js';
export { AuthEventEmitter } from './events.js';
export { RecoveryPhraseMismatchError, isRecoveryPhraseMismatchError } from './errors.js';

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

export { BrowserStorage, MemoryStorage, createDefaultStorage } from './storage/storage.js';

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
