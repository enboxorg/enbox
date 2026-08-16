/**
 * @module @enbox/auth
 * Public types for the authentication and identity management SDK.
 */

import type { PortableDid } from '@enbox/dids';
import type { AgentSessionIdentity, DwnProtocolDefinition, EnboxUserAgent, HdIdentityVault, LocalDwnStrategy, PortableIdentity, SyncDrainOptions, SyncDrainResult } from '@enbox/agent';
import type { ConnectClientMetadata, ConnectPermissionRequest, ConnectRequestType, ConnectResult, ConnectSessionMetadata } from '@enbox/connect';

import type { PasswordProvider } from './password-provider.js';

// Re-export types that consumers will need
export type { ConnectClientMetadata, ConnectPermissionRequest, ConnectRequestType, ConnectResult } from '@enbox/connect';
export type { HdIdentityVault, IdentityVaultBackup, LocalDwnStrategy, PortableIdentity } from '@enbox/agent';

// Re-export EnboxUserAgent so consumers don't need a direct @enbox/agent dep
export type { EnboxUserAgent } from '@enbox/agent';

// ─── Sync ────────────────────────────────────────────────────────

/** Interval string such as `'30s'`, `'2m'`, `'1h'`. */
export type SyncIntervalString = `${number}${'s' | 'm' | 'h'}`;

/**
 * Controls DWN synchronisation behaviour. Sync is always live (real-time
 * WebSocket delivery); the interval only paces the engine's periodic durable
 * feed settle check (default `'5m'`).
 *
 * - `undefined` (omitted) — Live sync at the default settle-check cadence.
 * - `'off'` — Sync disabled entirely.
 * - `'live'` — Live sync, explicitly, at the default settle-check cadence.
 * - `{ interval? }` or a bare interval string such as `'30s'` — Live sync
 *   with the settle check paced at that interval.
 */
export type SyncOption =
  | 'off'
  | 'live'
  | SyncIntervalString
  | { interval?: SyncIntervalString };

/**
 * Protocol scope used when auth registers a local identity for sync.
 *
 * Auth never chooses `'all'` implicitly. Applications that truly want a
 * full-DWN replica must pass `'all'` explicitly; product-scoped apps should
 * pass the protocol URI list they own.
 */
export type IdentitySyncProtocols = 'all' | [string, ...string[]];

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
  | 'local-dwn-unavailable'
  | 'connection-expiring'
  | 'connection-expired';

/** Payload type for each event, keyed by event name. */
export interface AuthEventMap {
  'state-change': { previous: AuthState; current: AuthState };
  /** Wake indicating that consumers should read the emitting manager's authoritative active session. */
  'session-start': Record<string, never>;
  'session-end': { did: string };
  'identity-added': { identity: IdentityInfo };
  'identity-removed': { didUri: string };
  'vault-locked': Record<string, never>;
  'vault-unlocked': Record<string, never>;
  /** Emitted when a local DWN server is discovered and validated. */
  'local-dwn-available': { endpoint: string; paired?: boolean };
  /** Emitted when no local DWN server could be discovered or a previously known one is no longer reachable. */
  'local-dwn-unavailable': Record<string, never>;
  /** Emitted when the newest delegated connect session enters `expiring-soon`. */
  'connection-expiring': { status: ConnectionStatus };
  /** Emitted when the newest delegated connect session becomes expired or revoked. */
  'connection-expired': { status: ConnectionStatus };
}

/** A type-safe event handler for a specific event. */
export type AuthEventHandler<E extends AuthEvent = AuthEvent> =
  (payload: AuthEventMap[E]) => void;

// ─── Identity ────────────────────────────────────────────────────

/**
 * Lightweight metadata about a stored identity.
 *
 * @deprecated Prefer {@link AgentSessionIdentity} from `@enbox/agent` — this
 *   alias exists for `@enbox/auth`'s self-contained public surface but the
 *   canonical name lives in the agent package. The two are structurally
 *   identical; new code should import `AgentSessionIdentity` directly.
 */
export type IdentityInfo = AgentSessionIdentity;

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

// `ConnectResult` — the delegated credentials every connect handler (browser
// popup, relay, CLI, etc.) returns on success — is canonical in
// `@enbox/connect` and re-exported above.

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
    /** Existing delegate credentials to re-grant during a refresh flow. */
    delegatePortableDid?: PortableDid;
    /** Explicit wallet UI signal. Omitted for an initial connect. */
    requestType?: ConnectRequestType;
    /** Wallet profile DID that a refresh must renew. */
    expectedProviderDid?: string;
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
   * `'prefer'` (default) uses a paired local DWN first, then falls back to
   * DID-document endpoints. `'only'` requires a local server for locally
   * managed DIDs; foreign DIDs still use their advertised endpoints. `'off'`
   * disables local DWN discovery entirely.
   *
   * Discovery is passive by default: the SDK validates only a persisted
   * local-node pairing or the native discovery file. Browser localhost port
   * probing is explicit via `AuthManager.probeLocalNode()` or
   * `AuthManager.enableLocalNode()`.
   *
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
   * Sync configuration for DWN synchronization. Sync is always live
   * (WebSocket subscriptions); an interval string sets the cadence of the
   * periodic durable-feed settle check, not a polling loop.
   * - `'off'` — disable sync
   * - `'15s'`, `'1m'`, etc. — live sync with this settle-check cadence
   * - `undefined` — live sync with the default settle-check cadence
   */
  sync?: SyncOption;

  /**
   * Protocol scope to register for local identity sync.
   *
   * Omit this to leave local identities unregistered by auth. Use `'all'`
   * only for applications that explicitly mirror the entire identity DWN.
   */
  identitySyncProtocols?: IdentitySyncProtocols;

  /** Default DWN endpoints for new identities. */
  dwnEndpoints?: string[];

  /** DWN registration configuration. */
  registration?: RegistrationOptions;

  /**
   * Default connect handler for delegated connect flows.
   *
   * Used by `connect()` when the caller provides `protocols` (or other
   * non-vault-connect options) but does not pass a per-call handler.
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

export type LocalNodeEjectOptions = SyncDrainOptions;

export type LocalNodeEjectResult =
  | {
    status: 'completed';
    endpoint: string;
    drain: SyncDrainResult;
    nextSessionRemoteMode: true;
  }
  | {
    status: 'incomplete';
    endpoint: string;
    drain: SyncDrainResult;
    nextSessionRemoteMode: false;
  }
  | {
    status: 'unavailable';
    reason: 'not-paired';
    nextSessionRemoteMode: false;
  };

/** Options for {@link AuthManager.connectVault}. */
export interface VaultConnectOptions {
  /** Recovery phrases are accepted only by {@link AuthManager.restoreFromPhrase}. */
  recoveryPhrase?: never;

  /** Vault password (overrides manager default). */
  password?: string;

  /** Override manager default sync interval. */
  sync?: SyncOption;

  /** Override manager default local identity sync scope. */
  identitySyncProtocols?: IdentitySyncProtocols;

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

/** Options for {@link AuthManager.restoreFromPhrase}. */
export interface RestoreFromPhraseOptions extends Omit<VaultConnectOptions, 'dwnEndpoints' | 'password' | 'recoveryPhrase'> {
  /** The BIP-39 recovery phrase for the existing or remote wallet vault. */
  recoveryPhrase: string;

  /**
   * Password to protect the restored vault locally.
   *
   * If the local vault already belongs to this phrase, this becomes the new local unlock password.
   */
  password: string;

  /** Deliberately replace owned DID endpoints after recovery; omitted to preserve advertised endpoints. */
  dwnEndpoints?: string[];
}

// ─── DWeb Connect ────────────────────────────────────────────────

/** Shorthand permission names for DWN protocol scopes. */
export type Permission = 'write' | 'read' | 'delete';

/** Default permissions granted when only a protocol definition is provided. */
export const DEFAULT_PERMISSIONS: Permission[] = ['read', 'write', 'delete'];

/**
 * Dependency-neutral structural shape for an object that carries a protocol
 * definition.
 *
 * Higher-level packages can add their own fields (for example runtime codecs)
 * without `@enbox/auth` depending on those packages. Only `definition` crosses
 * the auth/connect boundary.
 */
export type ProtocolDefinitionCarrier = {
  readonly definition: DwnProtocolDefinition;
};

/** A protocol request with an explicit permission policy. */
export type ProtocolPermissionRequest =
  | {
    /** A raw definition, preserving the original explicit request shape. */
    readonly definition: DwnProtocolDefinition | ProtocolDefinitionCarrier;
    readonly permissions: readonly Permission[];
  }
  | {
    /** A raw definition or higher-level definition carrier. */
    readonly protocol: DwnProtocolDefinition | ProtocolDefinitionCarrier;
    readonly permissions: readonly Permission[];
  };

/**
 * A protocol permission request in simplified form.
 *
 * Dapp developers can pass a raw definition or any structural
 * {@link ProtocolDefinitionCarrier} with default permissions, or pair either
 * form with an explicit permission policy.
 */
export type ProtocolRequest =
  | DwnProtocolDefinition
  | ProtocolDefinitionCarrier
  | ProtocolPermissionRequest;

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
   * Each entry can be a raw definition or a structural definition carrier
   * (uses default permissions), or an object with explicit permissions.
   *
   * @example
   * ```ts
   * // Default permissions (read, write, delete)
   * protocols: [NotesDefinition, NotesProtocol]
   *
   * // Explicit permissions
   * protocols: [
   *   { definition: NotesDefinition, permissions: ['read', 'write'] },
   *   { protocol: PhotosProtocol, permissions: ['read'] },
   * ]
   * ```
   */
  protocols?: readonly ProtocolRequest[];

  /**
   * Connect handler for this call. Overrides the default handler set
   * on `AuthManager.create()`.
   */
  connectHandler?: ConnectHandler;

  /**
   * Vault password for this call (overrides the manager default).
   *
   * The handler flow still needs to unlock the local agent's vault to receive
   * delegated grants — passing `password` per-call lets callers override the
   * default supplied to `AuthManager.create()`.
   */
  password?: string;

  /** Override manager default sync interval. */
  sync?: SyncOption;
}

// ─── Delegated connection status + refresh ───────────────────────

/** Lifecycle state of the newest delegated connect approval. */
export type ConnectionState =
  | 'active'
  | 'expiring-soon'
  | 'expired'
  | 'revoked'
  | 'none';

/** Status of the current delegated connect approval. */
export type ConnectionStatus = {
  state: ConnectionState;
  connectSessionId?: string;
  connectedDid?: string;
  delegateDid?: string;
  /** Earliest enforcing `dateExpires` among the session's grants. */
  expiresAt?: string;
  secondsUntilExpiry?: number;
};

/** Minimal grant shape consumed by {@link computeConnectionStatus}. */
export type ConnectionStatusGrant = {
  id: string;
  grantor: string;
  grantee: string;
  dateExpires: string;
  connectSession?: ConnectSessionMetadata;
  revoked?: boolean;
};

/** Options for the pure connection-status computation. */
export type ComputeConnectionStatusOptions = {
  /**
   * Seconds before expiry at which the state becomes `expiring-soon`.
   * Defaults to the smaller of one hour or 10% of the approval lifetime.
   */
  expiringSoonThresholdSeconds?: number;
  /** DWN timestamp used as the clock. Defaults to the current time. */
  now?: string;
};

/** Options for {@link AuthManager.getConnectionStatus}. */
export type GetConnectionStatusOptions = Omit<ComputeConnectionStatusOptions, 'now'> & {
  /** Check revocations visible in the connected identity's local partition. Defaults to `true`. */
  checkRevoked?: boolean;
};

/** Options for adding fresh grants to an existing delegated session. */
export type RefreshOptions = {
  /** Non-empty protocol list. Pass the same protocol requests used for the initial connect. */
  protocols: readonly ProtocolRequest[];
  /** Per-call handler override. Defaults to the manager's configured handler. */
  connectHandler?: ConnectHandler;
};

/** Options for the opt-in delegated connection monitor. */
export type ConnectionMonitorOptions = GetConnectionStatusOptions & {
  /** Poll interval in milliseconds. Defaults to five minutes. */
  intervalMs?: number;
  /** Automatically refresh expiring or expired grants. Revoked grants are never auto-refreshed. */
  autoRefresh?: RefreshOptions;
  /** Receives polling or automatic-refresh failures. */
  onError?: (error: unknown) => void;
};

/**
 * Unified options for {@link AuthManager.connect}.
 *
 * `connect()` routes to the appropriate flow based on the options:
 *
 * - **Handler-based connect** (dapps): triggered when `protocols` or
 *   `connectHandler` is provided.
 *   Delegates to the connect handler for credential acquisition.
 *
 * - **Vault connect** (wallets / CLI): triggered otherwise.
 *
 * `connect()` first attempts to restore a previous session from storage.
 * Use {@link AuthManager.restoreFromPhrase} for explicit recovery.
 */
export type ConnectOptions = HandlerConnectOptions | VaultConnectOptions;

/** Options for {@link AuthManager.walletConnect}. */
export interface WalletConnectOptions {
  /** Display name shown in the wallet during the connect flow. */
  displayName: string;

  /** Optional icon URL shown in the wallet during the connect flow. */
  appIcon?: string;

  /** Stable application identifier hint available to the wallet during approval. */
  applicationId?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /**
   * Advisory preferred session TTL in seconds. The provider-approved lifetime
   * is authoritative and may be shorter or longer, subject to provider policy.
   */
  requestedSessionTtlSeconds?: number;

  /**
   * Generate a local delegate DID and request wallet grants to that DID.
   *
   * If omitted, the wallet mints and returns the delegate DID as before.
   */
  preSupplyDelegateDid?: boolean;

  /**
   * Existing local delegate DID to request grants for. Takes precedence over
   * `preSupplyDelegateDid` and must include private keys.
   */
  delegatePortableDid?: PortableDid;

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
  onWalletUriReady: (uri: string) => Promise<void> | void;

  /** Called to collect the PIN from the user. */
  validatePin: () => Promise<string>;

  /**
   * Milliseconds to wait for wallet approval.
   * Defaults to the relay client's 300 second poll TTL.
   */
  timeoutMs?: number;

  /**
   * Milliseconds between relay polling attempts.
   * Defaults to 3000.
   */
  pollIntervalMs?: number;

  /** Override manager default sync interval. */
  sync?: SyncOption;
}

/** Options for {@link AuthManager.importFromPortable}. */
export interface ImportFromPortableOptions {
  /** The portable identity JSON to import. */
  portableIdentity: PortableIdentity;

  /** Override manager default sync interval. */
  sync?: SyncOption;

  /** Override manager default local identity sync scope. */
  identitySyncProtocols?: IdentitySyncProtocols;
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

  /** Legacy context key cache key, retained for cleanup during session restore. */
  DELEGATE_CONTEXT_KEYS: 'enbox:auth:delegateContextKeys',

  /** Legacy multi-party protocol cache key, retained for cleanup during session restore. */
  DELEGATE_MULTI_PARTY_PROTOCOLS: 'enbox:auth:delegateMultiPartyProtocols',

  /** Versioned local-node pairing record: endpoint, bearer token, origin, and metadata. */
  LOCAL_DWN_ENDPOINT: 'enbox:auth:localDwnEndpoint',

  /** Versioned marker that allows a paired local node to become the next-session local DWN. */
  LOCAL_DWN_EJECTION: 'enbox:auth:localDwnEjection',

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
   * Self-contained for remote retry. During restore, an exact match with the
   * persisted delegate and connected DID also proves an interrupted disconnect
   * whose local session teardown must be completed before restoration.
   */
  REVOCATION_RETRY_CONTEXT: 'enbox:auth:revocationRetryContext',
} as const;
