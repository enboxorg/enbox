/**
 * Shared browser-safe exports used by the root and browser auth entrypoints.
 *
 * @module
 */

export { AuthManager } from './auth-manager.js';
export { AuthSession } from './identity-session.js';
export { AuthEventEmitter } from './events.js';
export { ConnectDeniedError, RecoveryPhraseMismatchError, isConnectDeniedError, isRecoveryPhraseMismatchError } from './errors.js';

export { processConnectedGrants } from './connect/wallet.js';
export {
  SESSION_EXPIRED_ERROR_CODE,
  SESSION_REVOKED_ERROR_CODE,
  computeConnectionStatus,
  fetchConnectionStatus,
  isSessionExpiredError,
  isSessionInvalidError,
  reconcileConnectionStatusGrants,
} from './connect/status.js';
export { normalizePermissionPolicy, normalizeProtocolRequests } from './permissions.js';
export { WalletConnect } from './wallet-connect-client.js';
export type { ProtocolPermissionOptions, WalletConnectClientOptions } from './wallet-connect-client.js';

export { loadTokensFromStorage, saveTokensToStorage } from './registration.js';

export {
  applyLocalDwnDiscovery,
  clearLocalDwnEjection,
  clearLocalDwnEndpoint,
  createLocalDwnRpcClient,
  discoverEjectedLocalDwnPairing,
  discoverLocalDwn,
  discoverLocalDwnPairing,
  initiateLocalDwnPairing,
  persistLocalDwnEjectionRecord,
  persistLocalDwnPairingRecord,
  pollLocalDwnPairing,
  probeLocalDwn,
  readLocalDwnEjectionRecord,
  readLocalDwnPairingRecord,
  requestLocalDwnPairing,
  restoreLocalDwnEndpoint,
} from './discovery.js';

export type {
  InitiateLocalDwnPairingOptions,
  LocalDwnEjectionRecord,
  LocalDwnPairingInitiateResult,
  LocalDwnPairingPollResult,
  LocalDwnPairingRecord,
  LocalDwnPairingRequestResult,
  LocalDwnProbeResult,
  LocalDwnUnsupportedReason,
  PollLocalDwnPairingOptions,
  ProbeLocalDwnOptions,
  RequestLocalDwnPairingOptions,
} from './discovery.js';

export { BrowserStorage, LevelStorage, MemoryStorage, createDefaultStorage } from './storage/storage.js';

export { retryOrphanedRevocations } from './connect/restore.js';
export { STORAGE_KEYS } from './types.js';

export type {
  AuthEvent,
  AuthEventHandler,
  AuthEventMap,
  AuthManagerOptions,
  AuthState,
  ConnectClientMetadata,
  ConnectHandler,
  ConnectOptions,
  ConnectPermissionRequest,
  ConnectRequestType,
  ConnectResult,
  ComputeConnectionStatusOptions,
  ConnectionMonitorOptions,
  ConnectionState,
  ConnectionStatus,
  ConnectionStatusGrant,
  DisconnectOptions,
  HandlerConnectOptions,
  HeadlessConnectOptions,
  IdentityInfo,
  IdentityVaultBackup,
  ImportFromPortableOptions,
  LocalNodeEjectOptions,
  LocalNodeEjectResult,
  LocalDwnStrategy,
  Permission,
  PortableIdentity,
  ProtocolDefinitionCarrier,
  ProtocolPermissionRequest,
  ProtocolRequest,
  ProviderAuthParams,
  ProviderAuthResult,
  RegistrationOptions,
  RegistrationTokenData,
  RefreshOptions,
  GetConnectionStatusOptions,
  RestoreFromPhraseOptions,
  RestoreSessionOptions,
  ShutdownOptions,
  StorageAdapter,
  SyncIntervalString,
  SyncOption,
  VaultConnectOptions,
  WalletConnectOptions,
} from './types.js';
