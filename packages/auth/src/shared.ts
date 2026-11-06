/**
 * Shared browser-safe exports used by the root and browser auth entrypoints.
 *
 * @module
 */

export { AgentSession } from '@enbox/agent';
export { ConnectAuthenticationError } from '@enbox/connect';
export type { AgentSessionIdentity } from '@enbox/agent';

export { AuthEventEmitter } from './events.js';
export { AuthManager } from './auth-manager.js';
export {
  ConnectDeniedError,
  DwnTenantRegistrationError,
  PasswordProviderUnavailableError,
  RecoveryPhraseMismatchError,
  isConnectDeniedError,
  isRecoveryPhraseMismatchError,
} from './errors.js';

export { processConnectedGrants } from './connect/lifecycle.js';
export {
  SESSION_EXPIRED_ERROR_CODE,
  SESSION_REVOKED_ERROR_CODE,
  computeConnectionStatus,
  fetchConnectionStatus,
  isSessionExpiredError,
  isSessionInvalidError,
  reconcileConnectionStatusGrants,
} from './connect/status.js';
export { normalizePermissionPolicy, normalizeModuleRequests } from './permissions.js';
export { WalletConnect } from './wallet-connect-client.js';
export type { ModulePermissionOptions, WalletAuthenticationClientOptions, WalletConnectClientOptions } from './wallet-connect-client.js';

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
  ConnectAuthenticationFailure,
  ConnectAuthenticationParams,
  ConnectAuthenticationReplayStore,
  ConnectAuthenticationResolver,
  ConnectAuthenticationResult,
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
  DwnTenantRegistrationFailure,
  DwnTenantRegistrationOptions,
  DwnTenantRegistrationPair,
  DwnTenantRegistrationResult,
  HandlerConnectOptions,
  HeadlessConnectOptions,
  IdentityVaultBackup,
  ImportFromPortableOptions,
  LocalNodeEjectOptions,
  LocalNodeEjectResult,
  LocalDwnStrategy,
  Permission,
  PortableIdentity,
  ModuleDefinitionCarrier,
  ModulePermissionRequest,
  ModuleRequest,
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
  VerifiedConnectAuthentication,
  WalletConnectOptions,
} from './types.js';
