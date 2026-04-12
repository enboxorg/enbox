/**
 * @module @enbox/auth
 * Public types for the authentication and identity management SDK.
 */

import type { PortableDid } from '@enbox/dids';
import type { ConnectPermissionRequest, DelegateContextKey, DelegateDecryptionKey, DwnDataEncodedRecordsWriteMessage, DwnProtocolDefinition, EnboxUserAgent, HdIdentityVault, LocalDwnStrategy, PortableIdentity } from '@enbox/agent';

import type { PasswordProvider } from './password-provider.js';

// Re-export types that consumers will need
export type { ConnectPermissionRequest, DelegateContextKey, DelegateDecryptionKey, HdIdentityVault, IdentityVaultBackup, LocalDwnStrategy, PortableIdentity } from '@enbox/agent';

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
   *
   * When {@link persistTokens} is `true`, this field is ignored —
   * tokens are loaded automatically from the agent's vault-backed
   * `SecretStore` (preferred) or the legacy `StorageAdapter` (fallback).
   */
  registrationTokens?: Record<string, RegistrationTokenData>;

  /**
   * Called when new or refreshed registration tokens are obtained.
   * The app should persist these for future sessions.
   *
   * When {@link persistTokens} is `true`, tokens are saved automatically
   * to the agent's vault-backed `SecretStore` (or the legacy
   * `StorageAdapter` when no `SecretStore` is available). This callback
   * is still invoked (if provided) **after** the automatic save, so
   * consumers can observe token changes without handling persistence
   * themselves.
   */
  onRegistrationTokens?: (tokens: Record<string, RegistrationTokenData>) => void;

  /**
   * Automatically persist and restore registration tokens.
   *
   * When `true`, tokens are loaded before registration and saved back
   * after new or refreshed tokens are obtained, removing the need for
   * consumers to implement their own token I/O via
   * {@link registrationTokens} and {@link onRegistrationTokens}.
   *
   * **Storage preference:** tokens are stored in the agent's vault-backed
   * `SecretStore` (encrypted at rest) when available.  On the first run
   * after an upgrade, any tokens left in the legacy plaintext
   * `StorageAdapter` are migrated into the `SecretStore` and the
   * plaintext copy is removed.  If no `SecretStore` is provided, the
   * `StorageAdapter` is used as a fallback.
   *
   * Defaults to `false` for backward compatibility.
   *
   * @example
   * ```ts
   * const auth = await AuthManager.create({
   *   registration: {
   *     onSuccess: () => {},
   *     onFailure: (err) => console.error(err),
   *     persistTokens: true,
   *   },
   * });
   * ```
   */
  persistTokens?: boolean;
}

// ─── Connect Handler ─────────────────────────────────────────────

/**
 * Result of a successful connect handler invocation.
 *
 * Contains the delegated credentials returned by the wallet.
 * All connect handlers (browser popup, relay, CLI, etc.) must
 * return this shape on success.
 */
export interface ConnectResult {
  /** The portable delegate DID (includes private keys). */
  delegatePortableDid: PortableDid;

  /** Permission grants for the requested protocols. */
  delegateGrants: DwnDataEncodedRecordsWriteMessage[];

  /** The DID of the identity the user approved (the wallet owner's DID). */
  connectedDid: string;

  /**
   * Scope-aware decryption keys for encrypted protocols.
   *
   * Derived only for read-like permission scopes (Read/Query/Subscribe) on
   * protocols with `encryptionRequired: true` types. Write-only delegates
   * receive no decryption keys.
   */
  delegateDecryptionKeys?: DelegateDecryptionKey[];

  /**
   * Context-scoped decryption keys for multi-party encrypted protocols.
   * Each key unlocks one rootContextId for records using ProtocolContext encryption.
   */
  delegateContextKeys?: DelegateContextKey[];

  /**
   * Protocol URIs that have multi-party encrypted access patterns.
   * Delivered even when no contexts exist yet (cold-start).
   */
  delegateMultiPartyProtocols?: string[];

  /** Per-grant revocation mappings for session-bound self-revocation on disconnect. */
  sessionRevocations?: { grantId: string; revocationGrantId: string }[];
}

/**
 * A connect handler obtains delegated credentials from a wallet.
 *
 * Different environments provide different implementations:
 * - **Browser**: popup + postMessage (`BrowserConnectHandler` from `@enbox/browser`)
 * - **Relay**: QR/PIN relay flow (`WalletConnect.initClient` from `@enbox/auth`)
 * - **CLI**: terminal QR/URL + polling (custom handler)
 * - **Desktop**: native window management (custom handler)
 *
 * @example
 * ```ts
 * import { BrowserConnectHandler } from '@enbox/browser';
 * const auth = await AuthManager.create({
 *   connectHandler: BrowserConnectHandler(),
 * });
 * ```
 */
export interface ConnectHandler {
  /**
   * Obtain delegated credentials from a wallet.
   *
   * @param params.permissionRequests - Agent-level permission requests.
   * @returns The delegate credentials, or `undefined` if the user denied.
   */
  requestAccess(params: {
    permissionRequests: ConnectPermissionRequest[];
  }): Promise<ConnectResult | undefined>;
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
   *
   * For more flexible password acquisition (env vars, TTY prompts,
   * chained fallbacks), use {@link passwordProvider} instead.
   */
  password?: string;

  /**
   * A composable password provider for obtaining the vault password.
   *
   * When set, this provider is consulted by `connect()`,
   * `restoreSession()`, and `connectHeadless()` whenever a password
   * is needed and none was given explicitly. It takes precedence over
   * the static {@link password} option.
   *
   * @example
   * ```ts
   * import { AuthManager, PasswordProvider } from '@enbox/auth';
   *
   * const auth = await AuthManager.create({
   *   passwordProvider: PasswordProvider.chain([
   *     PasswordProvider.fromEnv('ENBOX_PASSWORD'),
   *     PasswordProvider.fromTty(),
   *   ]),
   * });
   * ```
   */
  passwordProvider?: PasswordProvider;

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

  /**
   * Default connect handler for delegated connect flows.
   *
   * Used by `connect()` when the caller provides `protocols` (or other
   * non-local-connect options) but does not pass a per-call handler.
   *
   * @example
   * ```ts
   * import { BrowserConnectHandler } from '@enbox/browser';
   *
   * const auth = await AuthManager.create({
   *   connectHandler: BrowserConnectHandler(),
   * });
   *
   * // Later — uses the default handler automatically
   * const session = await auth.connect({ protocols: [NotesProtocol] });
   * ```
   */
  connectHandler?: ConnectHandler;
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

  /**
   * Whether to create a default identity if none exist.
   *
   * - `false` (default) — Skip automatic identity creation. The session is
   *   returned with the **agent DID** as the connected DID and no identity
   *   metadata. Use this when the app manages identity creation separately
   *   (e.g. a web wallet with an explicit "Create Identity" flow after
   *   vault setup).
   *
   * - `true` — If no identities exist after vault initialisation, a new
   *   `did:dht` identity is created automatically. Use this when vault
   *   setup and identity creation are combined into a single step (e.g.
   *   Electrobun's create wizard).
   *
   * @default false
   */
  createIdentity?: boolean;
}

// ─── DWeb Connect ────────────────────────────────────────────────

/**
 * A protocol permission request in simplified form.
 *
 * Dapp developers can pass just a protocol definition (default permissions:
 * `['read', 'write', 'query', 'subscribe']`), or an object with explicit
 * permissions.
 */
export type ProtocolRequest =
  | DwnProtocolDefinition
  | { definition: DwnProtocolDefinition; permissions: Permission[] };

/** Shorthand permission names for DWN protocol scopes. */
export type Permission = 'write' | 'read' | 'delete' | 'query' | 'subscribe' | 'configure';

/** Default permissions granted when only a protocol definition is provided. */
export const DEFAULT_PERMISSIONS: Permission[] = ['read', 'write', 'delete', 'query', 'subscribe', 'configure'];

/**
 * Options for a handler-based (delegated) connect flow.
 *
 * Used when `connect()` delegates credential acquisition to a
 * {@link ConnectHandler}. The handler is responsible for the
 * environment-specific transport (popup, relay, CLI, etc.).
 */
export interface HandlerConnectOptions {
  /**
   * Protocols to request access to.
   *
   * Each entry can be either a protocol definition (uses default permissions)
   * or an object with `{ definition, permissions }` for explicit control.
   *
   * @example
   * ```ts
   * // Default permissions (read, write, query, subscribe)
   * protocols: [NotesProtocol]
   *
   * // Explicit permissions
   * protocols: [
   *   { definition: NotesProtocol, permissions: ['read', 'write'] },
   *   { definition: PhotosProtocol, permissions: ['read'] },
   * ]
   * ```
   */
  protocols?: ProtocolRequest[];

  /**
   * Connect handler for this call. Overrides the default handler set
   * on `AuthManager.create()`.
   */
  connectHandler?: ConnectHandler;

  /** Override manager default sync interval. */
  sync?: SyncOption;
}

/**
 * Unified options for {@link AuthManager.connect}.
 *
 * `connect()` routes to the appropriate flow based on the options:
 *
 * - **Handler-based connect** (dapps): triggered when `protocols` or
 *   `connectHandler` is provided. Delegates to the connect handler
 *   for credential acquisition.
 *
 * - **Local connect** (wallets / CLI): triggered when `password`,
 *   `createIdentity`, or `recoveryPhrase` is provided.
 *
 * In both cases, `connect()` first attempts to restore a previous session
 * from storage. If a valid session exists, it is returned immediately
 * without any user interaction.
 */
export type ConnectOptions = HandlerConnectOptions | LocalConnectOptions;

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
   * Each entry is a `ConnectPermissionRequest` containing a
   * `protocolDefinition` and `permissionScopes`. Use
   * `WalletConnect.createPermissionRequestForProtocol()` from `@enbox/auth`
   * to build these.
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

/** Options for {@link AuthManager.connectHeadless}. */
export interface HeadlessConnectOptions {
  /** Vault password (overrides manager default). */
  password?: string;
}

/** Options for {@link AuthManager.shutdown}. */
export interface ShutdownOptions {
  /**
   * Milliseconds to wait for pending sync operations before shutting down.
   * Default: `2000`.
   */
  timeout?: number;
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

  /**
   * Close the underlying storage resources (e.g. LevelDB handles).
   *
   * Optional — not all adapters need cleanup. Called by
   * {@link AuthManager.shutdown} to release resources so the process
   * can exit cleanly.
   */
  close?(): Promise<void>;
}

// ─── Internal helpers ────────────────────────────────────────────

/** The insecure default password used when none is provided. */
export const INSECURE_DEFAULT_PASSWORD = 'insecure-static-phrase';

/** Default DWN endpoints for new identities when none are configured. */
export const DEFAULT_DWN_ENDPOINTS = ['https://enbox-dwn.fly.dev'];

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
   * JSON-serialised `DelegateDecryptionKey[]` for delegate decryption of
   * encrypted protocol records. Persisted so session restore can re-populate
   * the delegate decryption key cache without requiring a new connect flow.
   */
  DELEGATE_DECRYPTION_KEYS: 'enbox:auth:delegateDecryptionKeys',

  /**
   * JSON-serialised `DelegateContextKey[]` for multi-party encrypted protocol
   * records. Persisted for session restore.
   */
  DELEGATE_CONTEXT_KEYS: 'enbox:auth:delegateContextKeys',

  /**
   * JSON-serialised `string[]` of multi-party protocol URIs for delegate
   * context key eligibility. Persisted for session restore so cold-start
   * delegates (who connected with zero contexts) still receive future keys.
   */
  DELEGATE_MULTI_PARTY_PROTOCOLS: 'enbox:auth:delegateMultiPartyProtocols',

  /**
   * The base URL of the local DWN server discovered via the `dwn://connect`
   * browser redirect flow. Persisted so subsequent page loads can skip the
   * redirect and inject the endpoint directly.
   *
   * @see https://github.com/enboxorg/enbox/issues/589
   */
  LOCAL_DWN_ENDPOINT: 'enbox:auth:localDwnEndpoint',

  /**
   * JSON-serialised `Record<string, RegistrationTokenData>` for DWN endpoint
   * registration tokens. Automatically loaded before registration and saved
   * after new/refreshed tokens are obtained when `persistTokens` is enabled.
   *
   * @see https://github.com/enboxorg/enbox/issues/690
   */
  REGISTRATION_TOKENS: 'enbox:auth:registrationTokens',

  /**
   * JSON-serialised `SessionRevocationEntry[]` mapping session grant IDs to
   * their corresponding revocation grant IDs for disconnect.
   */
  SESSION_REVOCATIONS: 'enbox:auth:sessionRevocations',

  /**
   * Self-contained collection of revocation retry entries from previous
   * partial disconnects. JSON-serialised array of
   * `{ delegateDid, connectedDid, revocations }` entries, one per
   * session. Keyed by `delegateDid` (unique per session).
   *
   * Completely independent from active session state.
   */
  REVOCATION_RETRY_CONTEXT: 'enbox:auth:revocationRetryContext',
} as const;
