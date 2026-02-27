/**
 * @enbox/auth — Headless authentication and identity management SDK.
 *
 * Replaces `Web5.connect()` with a composable, multi-identity-aware
 * auth system that works in both browser and CLI environments.
 *
 * @example
 * ```ts
 * import { AuthManager } from '@enbox/auth';
 *
 * const auth = await AuthManager.create({ sync: '15s' });
 * const session = await auth.restoreSession() ?? await auth.connect();
 *
 * // session.web5 is a standard Web5 instance
 * const protocol = session.web5.using(MyProtocol);
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
