/**
 * @module @enbox/auth
 * Public types for the authentication and identity management SDK.
 */

import type { IdentityVaultBackup, PortableIdentity } from '@enbox/agent';
import type { ConnectPermissionRequest, SyncOption, Web5ConnectResult } from '@enbox/api';

// Re-export types that consumers will need
export type { IdentityVaultBackup, PortableIdentity } from '@enbox/agent';
export type { SyncOption, Web5ConnectResult } from '@enbox/api';

// ─── Auth State Machine ─────────────────────────────────────────

/**
 * The possible states of the auth manager.
 *
 * State transitions:
 * ```
 * uninitialized → locked → unlocked → connected
 *                   ↑          ↑          │
 *                   └──────────┴──────────┘ (disconnect / lock)
 * ```
 */
export type AuthState =
  | 'uninitialized'  // No vault exists, no identities
  | 'locked'         // Vault exists but is locked (password required)
  | 'unlocked'       // Vault unlocked, no active session
  | 'connected';     // Active session with an identity

// ─── Events ──────────────────────────────────────────────────────

/** All event names emitted by the auth manager. */
export type AuthEvent =
  | 'state-change'
  | 'session-start'
  | 'session-end'
  | 'identity-added'
  | 'identity-removed'
  | 'vault-locked'
  | 'vault-unlocked';

/** Payload type for each event, keyed by event name. */
export interface AuthEventMap {
  'state-change':     { previous: AuthState; current: AuthState };
  'session-start':    { session: AuthSessionInfo };
  'session-end':      { did: string };
  'identity-added':   { identity: IdentityInfo };
  'identity-removed': { didUri: string };
  'vault-locked':     Record<string, never>;
  'vault-unlocked':   Record<string, never>;
}

/** A type-safe event handler for a specific event. */
export type AuthEventHandler<E extends AuthEvent = AuthEvent> =
  (payload: AuthEventMap[E]) => void;

// ─── Identity ────────────────────────────────────────────────────

/** Lightweight metadata about a stored identity. */
export interface IdentityInfo {
  /** The DID URI for this identity. */
  didUri: string;

  /** Human-readable name. */
  name: string;

  /**
   * Present when this identity is a delegate of another DID
   * (i.e. connected via wallet connect).
   */
  connectedDid?: string;
}

/** Serializable session info for the `session-start` event. */
export interface AuthSessionInfo {
  did: string;
  delegateDid?: string;
  identity: IdentityInfo;
}

// ─── Options ─────────────────────────────────────────────────────

/** Registration callback configuration for DWN endpoints. */
export interface RegistrationOptions {
  onSuccess: () => void;
  onFailure: (error: unknown) => void;
}

/** Options for {@link AuthManager.create}. */
export interface AuthManagerOptions {
  /**
   * Data path for agent storage.
   * - Browser default: `'DATA/AGENT'`
   * - CLI default: `'~/.enbox'`
   */
  dataPath?: string;

  /** Storage adapter for session persistence. Auto-detected if not provided. */
  storage?: StorageAdapter;

  /**
   * Default password for vault operations.
   * If not provided, an insecure default is used (with a console warning).
   */
  password?: string;

  /**
   * Sync interval for DWN synchronization.
   * - `'off'` — disable sync
   * - `'15s'`, `'1m'`, etc. — poll at interval
   * - `undefined` — live WebSocket sync
   */
  sync?: SyncOption;

  /** Default DWN endpoints for new identities. */
  dwnEndpoints?: string[];

  /** DWN registration configuration. */
  registration?: RegistrationOptions;
}

/** Options for {@link AuthManager.connect}. */
export interface LocalConnectOptions {
  /** Vault password (overrides manager default). */
  password?: string;

  /** Re-derive identity from an existing BIP-39 recovery phrase. */
  recoveryPhrase?: string;

  /** Override manager default sync interval. */
  sync?: SyncOption;

  /** Override manager default DWN endpoints. */
  dwnEndpoints?: string[];

  /** Identity metadata. */
  metadata?: { name?: string };
}

/** Options for {@link AuthManager.walletConnect}. */
export interface WalletConnectOptions {
  /** Display name shown in the wallet during the connect flow. */
  displayName: string;

  /** URL of the connect relay server. */
  connectServerUrl: string;

  /** Wallet URI scheme. Defaults to `'web5://connect'`. */
  walletUri?: string;

  /** Protocol permission requests for the wallet connect flow. */
  permissionRequests: ConnectPermissionRequest[];

  /** Called when the wallet URI is ready (render as QR code). */
  onWalletUriReady: (uri: string) => void;

  /** Called to collect the PIN from the user. */
  validatePin: () => Promise<string>;

  /** Override manager default sync interval. */
  sync?: SyncOption;
}

/** Options for {@link AuthManager.importFromPhrase}. */
export interface ImportFromPhraseOptions {
  /** The BIP-39 recovery phrase. */
  recoveryPhrase: string;

  /** Password to protect the vault. */
  password: string;

  /** Override manager default sync interval. */
  sync?: SyncOption;

  /** Override manager default DWN endpoints. */
  dwnEndpoints?: string[];
}

/** Options for {@link AuthManager.importFromPortable}. */
export interface ImportFromPortableOptions {
  /** The portable identity JSON to import. */
  portableIdentity: PortableIdentity;

  /** Override manager default sync interval. */
  sync?: SyncOption;
}

/** Options for {@link AuthManager.restoreSession}. */
export interface RestoreSessionOptions {
  /** Password to unlock the vault (needed if vault is locked). */
  password?: string;
}

/** Options for {@link AuthManager.disconnect}. */
export interface DisconnectOptions {
  /**
   * If `true`, performs a nuclear wipe: clears all localStorage keys,
   * deletes all IndexedDB databases, and removes persisted session data.
   * Default: `false` (clean disconnect — keeps vault and identities).
   */
  clearStorage?: boolean;

  /**
   * Milliseconds to wait for pending sync operations before disconnecting.
   * Default: `2000`.
   */
  timeout?: number;
}

// ─── Storage ─────────────────────────────────────────────────────

/**
 * Platform-agnostic key-value storage adapter for session persistence.
 * Implementations are provided for browser (localStorage) and CLI (file system).
 */
export interface StorageAdapter {
  /** Get a value by key. Returns `null` if not found. */
  get(key: string): Promise<string | null>;

  /** Set a key-value pair. */
  set(key: string, value: string): Promise<void>;

  /** Remove a key. */
  remove(key: string): Promise<void>;

  /** Clear all stored data. */
  clear(): Promise<void>;
}

// ─── Internal helpers ────────────────────────────────────────────

/** The insecure default password used when none is provided. */
export const INSECURE_DEFAULT_PASSWORD = 'insecure-static-phrase';

/**
 * Storage keys used by the auth manager for session persistence.
 * @internal
 */
export const STORAGE_KEYS = {
  /** Whether a session was previously established. */
  PREVIOUSLY_CONNECTED: 'enbox:auth:previouslyConnected',

  /** The DID URI of the last active identity. */
  ACTIVE_IDENTITY: 'enbox:auth:activeIdentity',

  /** The delegate DID URI (for wallet-connected sessions). */
  DELEGATE_DID: 'enbox:auth:delegateDid',

  /** The connected DID (for wallet-connected sessions). */
  CONNECTED_DID: 'enbox:auth:connectedDid',
} as const;
