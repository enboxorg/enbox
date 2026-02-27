/**
 * @enbox/auth — Headless authentication and identity management SDK.
 *
 * Provides composable, multi-identity-aware authentication that works
 * in both browser and CLI environments. Can be used standalone or
 * alongside `@enbox/api` for full DWN protocol operations.
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
 * // Option A: use the convenience getter
 * const web5 = session.web5;
 *
 * // Option B: construct Web5 yourself
 * const web5 = new Web5({ agent: session.agent, connectedDid: session.did });
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
  Web5ConnectResult,
} from './types.js';
