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
 * // session.agent — the authenticated Web5 agent
 * // session.did   — the connected DID URI
 * ```
 *
 * @example With @enbox/api
 * ```ts
 * import { AuthManager } from '@enbox/auth';
 * import { Web5 } from '@enbox/api';
 *
 * const auth = await AuthManager.create({ sync: '15s' });
 * const session = await auth.connect();
 *
 * const web5 = new Web5({
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

// Storage adapters
export { BrowserStorage, MemoryStorage, createDefaultStorage } from './storage/storage.js';

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
  IdentityInfo,
  IdentityVaultBackup,
  ImportFromPhraseOptions,
  ImportFromPortableOptions,
  LocalConnectOptions,
  PortableIdentity,
  RegistrationOptions,
  RestoreSessionOptions,
  StorageAdapter,
  SyncOption,
  WalletConnectOptions,
} from './types.js';
