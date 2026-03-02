/**
 * @module @enbox/auth
 * Public types for the authentication and identity management SDK.
 */

import type { ConnectPermissionRequest, EnboxUserAgent, HdIdentityVault, LocalDwnStrategy, PortableIdentity } from '@enbox/agent';

// Re-export types that consumers will need
export type { ConnectPermissionRequest, HdIdentityVault, IdentityVaultBackup, LocalDwnStrategy, PortableIdentity } from '@enbox/agent';

// Re-export EnboxUserAgent so consumers don't need a direct @enbox/agent dep
export type { EnboxUserAgent } from '@enbox/agent';

// ─── Sync ────────────────────────────────────────────────────────

/**
 * Controls DWN synchronisation behaviour.
 *
 * - `'off'`   — Sync disabled entirely.
 * - An interval string such as `'30s'`, `'2m'`, `'1h'` — Poll mode at the
 *   specified interval.
 * - `undefined` (omitted) — Live WebSocket sync (default).
 */
export type SyncOption = 'off' | `${number}${'s' | 'm' | 'h'}`;

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
  | 'uninitialized' // No vault exists, no identities
  | 'locked' // Vault exists but is locked (password required)
  | 'unlocked' // Vault unlocked, no active session
  | 'connected'; // Active session with an identity

// ─── Events ──────────────────────────────────────────────────────

/** All event names emitted by the auth manager. */
export type AuthEvent =
  | 'state-change'
  | 'session-start'
  | 'session-end'
  | 'identity-added'
  | 'identity-removed'
  | 'vault-locked'
  | 'vault-unlocked'
  | 'local-dwn-available'
  | 'local-dwn-unavailable';

/** Payload type for each event, keyed by event name. */
export interface AuthEventMap {
  'state-change': { previous: AuthState; current: AuthState };
  'session-start': { session: AuthSessionInfo };
  'session-end': { did: string };
  'identity-added': { identity: IdentityInfo };
  'identity-removed': { didUri: string };
  'vault-locked': Record<string, never>;
  'vault-unlocked': Record<string, never>;
  /** Emitted when a local DWN server is discovered and validated. */
  'local-dwn-available': { endpoint: string };
  /** Emitted when no local DWN server could be discovered or a previously known one is no longer reachable. */
  'local-dwn-unavailable': Record<string, never>;
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

// ─── Registration ────────────────────────────────────────────────

/** Parameters passed to the onProviderAuthRequired callback. */
export interface ProviderAuthParams {
  /** Full authorize URL to open in a browser (query params already appended). */
  authorizeUrl: string;
  /** The DWN endpoint URL this auth is for (informational). */
  dwnEndpoint: string;
  /** CSRF nonce — the provider will return this unchanged in the redirect. */
  state: string;
}

/** Result returned by the app after the user completes provider auth. */
export interface ProviderAuthResult {
  /** Authorization code from the provider's redirect. */
  code: string;
  /** Must match the state from ProviderAuthParams (CSRF validation). */
  state: string;
}

/** Persisted registration token data for a DWN endpoint. */
export interface RegistrationTokenData {
  /** Opaque registration token for POST /registration. */
  registrationToken: string;
  /** Refresh token for obtaining new registration tokens. */
  refreshToken?: string;
  /** Unix timestamp (ms) when the token expires. Undefined = never expires. */
  expiresAt?: number;
  /** Provider's token exchange URL (needed for code exchange). */
  tokenUrl: string;
  /** Provider's refresh URL (needed for token refresh). */
  refreshUrl?: string;
}

// ─── Options ─────────────────────────────────────────────────────

/**
 * DWN registration configuration.
 *
 * When provided, the agent DID and connected DID will be registered with
 * DWN endpoints after identity creation. Supports two paths:
 *
 * 1. **Provider auth** (`provider-auth-v0`) — the DWN endpoint requires
 *    OAuth-style auth. If {@link onProviderAuthRequired} is provided and
 *    the server advertises provider auth, the app handles the auth flow.
 * 2. **Proof of Work** (default fallback) — the DWN endpoint requires
 *    solving a PoW challenge to register.
 */
export interface RegistrationOptions {
  /** Called when all DWN registrations complete successfully. */
  onSuccess: () => void;

  /** Called when any DWN registration fails. */
  onFailure: (error: unknown) => void;

  /**
   * Called when a DWN endpoint requires provider auth (`'provider-auth-v0'`).
   *
   * The app should open the `authorizeUrl` in a browser, capture the
   * redirect with the auth code, and return the result. If not provided,
   * endpoints requiring provider auth fall back to PoW registration.
   */
  onProviderAuthRequired?: (params: ProviderAuthParams) => Promise<ProviderAuthResult>;

  /**
   * Pre-existing registration tokens from a previous session, keyed by
   * DWN endpoint URL. If a valid (non-expired) token exists for an
   * endpoint, it is used directly without re-running the auth flow.
   */
  registrationTokens?: Record<string, RegistrationTokenData>;

  /**
   * Called when new or refreshed registration tokens are obtained.
   * The app should persist these for future sessions.
   */
  onRegistrationTokens?: (tokens: Record<string, RegistrationTokenData>) => void;
}

/** Options for {@link AuthManager.create}. */
export interface AuthManagerOptions {
  /**
   * Provide a pre-built {@link EnboxUserAgent} instance.
   *
   * When provided, `dataPath`, `agentVault`, and `localDwnStrategy` are
   * ignored — the agent is used as-is. This is the escape hatch for
   * advanced scenarios like custom DWN stores (e.g., SQLite-backed DWN).
   *
   * @example
   * ```ts
   * const agent = await EnboxUserAgent.create({ dwnApi: myCustomDwnApi });
   * const auth = await AuthManager.create({ agent });
   * ```
   */
  agent?: EnboxUserAgent;

  /**
   * Provide a custom {@link HdIdentityVault} implementation.
   * Defaults to a LevelDB-backed vault with PBES2-HS512+A256KW encryption.
   * Ignored when `agent` is provided.
   */
  agentVault?: HdIdentityVault;

  /**
   * Controls local DWN discovery behavior for remote-target DWN sends/sync.
   * `'off'` (default) disables local probing, `'prefer'` tries local first
   * then falls back to DID-document endpoints, `'only'` requires a local server.
   * Ignored when `agent` is provided.
   */
  localDwnStrategy?: LocalDwnStrategy;

  /**
   * Data path for agent storage.
   * - Browser default: `'DATA/AGENT'`
   * - CLI default: `'~/.enbox'`
   *
   * Ignored when `agent` is provided.
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

  /**
   * Protocol permission requests for the wallet connect flow.
   *
   * Each entry is a `ConnectPermissionRequest` from `@enbox/agent` containing
   * a `protocolDefinition` and `permissionScopes`. Use
   * `WalletConnect.createPermissionRequestForProtocol()` to build these.
   */
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

  /**
   * Called when the vault is locked and a password is required to proceed.
   *
   * If provided, this callback is invoked instead of falling back to the
   * default password or the insecure static phrase. This is the recommended
   * way to implement interactive password prompts (e.g., a PIN entry dialog
   * or CLI prompt).
   *
   * @returns The password entered by the user.
   *
   * @example Browser PIN dialog
   * ```ts
   * const session = await auth.restoreSession({
   *   onPasswordRequired: async () => {
   *     return await showPinDialog();
   *   },
   * });
   * ```
   */
  onPasswordRequired?: () => Promise<string>;
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

  /**
   * The base URL of the local DWN server discovered via the `dwn://register`
   * browser redirect flow. Persisted so subsequent page loads can skip the
   * redirect and inject the endpoint directly.
   *
   * @see https://github.com/enboxorg/enbox/issues/589
   */
  LOCAL_DWN_ENDPOINT: 'enbox:auth:localDwnEndpoint',
} as const;
