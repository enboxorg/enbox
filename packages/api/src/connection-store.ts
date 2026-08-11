/**
 * Framework-agnostic, subscribable connection store for Enbox applications.
 *
 * {@link createConnectionStore} composes an `AuthManager` and {@link Enbox}
 * into one observable connection state machine. It owns the generic
 * lifecycle glue every app otherwise hand-rolls around the auth layer —
 * mount-once bootstrap (`restoreSession()` → `Enbox.fromSession()`),
 * connect and vault-connect flows with in-flight and error state, delegated
 * connection monitoring, and disconnect/teardown — and publishes every
 * transition as an immutable {@link ConnectionSnapshot}.
 *
 * The store is headless: it has no framework dependencies and no UI
 * concerns. Wallet selection stays inside the `ConnectHandler` passed
 * through to the `AuthManager` untouched. Framework bindings stay tiny
 * because the store implements both halves of the external-store contract:
 * `subscribe()` for change notification and `getSnapshot()` for synchronous
 * reads with reference-stable snapshots.
 *
 * @example React (`useSyncExternalStore`)
 * ```ts
 * const store = createConnectionStore({ connectHandler: BrowserConnectHandler() });
 *
 * function useConnection(): ConnectionSnapshot {
 *   return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
 * }
 * // On app boot (e.g. a mount-once effect): void store.initialize();
 * ```
 *
 * @example Vue (`customRef`) / Lit (reactive controller) / vanilla
 * ```ts
 * const unsubscribe = store.subscribe((snapshot) => render(snapshot));
 * render(store.getSnapshot());
 * void store.initialize();
 * ```
 *
 * @module
 */

import type { ApplicationManifest } from './application-manifest.js';
import type { DwnEndpointResolution } from '@enbox/dids';
import type { ReplicationCurrentness } from './replication-currentness.js';
import type {
  AuthManagerOptions,
  AuthSession,
  ConnectionMonitorOptions,
  ConnectionStatus,
  ConnectOptions,
  DisconnectOptions,
  GetConnectionStatusOptions,
  HandlerConnectOptions,
  RefreshOptions,
  RestoreSessionOptions,
  VaultConnectOptions,
} from '@enbox/auth';
import type {
  RemoteSyncStatus,
  ReplicationLinkSnapshot,
  SyncConnectivityState,
  SyncIdentityOptions,
} from '@enbox/agent';

import { AuthManager } from '@enbox/auth/auth-manager';
import { isConnectDeniedError } from '@enbox/auth';
import { omitUndefined } from '@enbox/common';
import {
  isServiceConfigNoticeDelivery,
  resolveSyncConnectivityState,
  syncRegistrationCoversProtocol,
} from '@enbox/agent';

import { Enbox } from './enbox.js';
import { getApplicationProtocolRequests } from './application-manifest.js';
import { projectReplicationCurrentness } from './replication-currentness.js';
import { ProtocolReadinessError } from './protocol-readiness.js';
import { WalletReapprovalRequiredError } from './typed-enbox.js';

/**
 * The lifecycle phase of the connection store.
 *
 * - `'initializing'` — the store has been created but {@link ConnectionStore.initialize}
 *   has not completed yet (or is re-running after a failed bootstrap).
 * - `'disconnected'` — no application-ready session is exposed. A delegated
 *   auth session may remain privately repairable when manifest sync coverage
 *   requires wallet reapproval. This is also the resting phase after a
 *   **denied** connect: denial is a user decision, not a failure, so the store
 *   returns here with {@link ConnectionSnapshot.error} set to the `ConnectDeniedError`.
 * - `'connecting'` — a connect, vault-connect, or refresh flow is in flight,
 *   or a replacement session is completing application readiness.
 * - `'disconnecting'` — sign-out has started and the prior session is no longer
 *   available for new application work, while teardown is still completing.
 * - `'connected'` — an active, application-ready session exists; `session`,
 *   `enbox`, and the identity fields are populated.
 * - `'error'` — the last action failed for a reason other than denial and no
 *   application-ready session is exposed; `error` carries the failure.
 */
export type ConnectionPhase =
  | 'initializing'
  | 'disconnected'
  | 'connecting'
  | 'disconnecting'
  | 'connected'
  | 'error';

type SyncStatusContents = Readonly<{
  /** Aggregate connectivity across the selected identity's current replication links. */
  connectivity: SyncConnectivityState;

  /** Latest activity timestamp already recorded by the sync engine, when available. */
  lastActivityAt?: string;

  /** Health rows for the connected DID's currently advertised DWN endpoints. */
  remotes: readonly Readonly<RemoteSyncStatus>[];

  /** Endpoint targeted by the pending fresh-validation and retry action. */
  retryingRemoteEndpoint?: string;
}>;

/** Immutable overall sync status for the selected identity. */
export type SyncStatusSnapshot = SyncStatusContents & Readonly<
  | {
    /** Currentness of the selected identity's replication baseline. */
    state: Exclude<ReplicationCurrentness, 'error'>;
    error?: never;
  }
  | {
    state: 'error';
    /** A paused replication link or failure to read the engine's local status projection. */
    error: Error;
  }
>;

/**
 * An immutable snapshot of the connection state.
 *
 * Snapshots are frozen and reference-stable: {@link ConnectionStore.getSnapshot}
 * returns the **same** object until the state actually changes, satisfying the
 * `useSyncExternalStore` contract (and equivalent bindings in Vue, Lit, Svelte,
 * and friends) without extra memoization.
 */
export type ConnectionSnapshot = {
  /** The current lifecycle phase. */
  phase: ConnectionPhase;

  /** The active auth session. Populated while `phase` is `'connected'`. */
  session?: AuthSession;

  /**
   * The {@link Enbox} instance bound to the active session.
   *
   * This is a borrowed facade: do not close it directly. The store closes it
   * automatically when the session is replaced, disconnected, or disposed.
   */
  enbox?: Enbox;

  /** The connected identity's DID URI. Populated while `phase` is `'connected'`. */
  identityDid?: string;

  /** The connected identity's display name, when one is set. */
  identityName?: string;

  /** Overall sync status for the connected identity. Cleared when the session ends. */
  sync?: SyncStatusSnapshot;

  /**
   * Latest resolution status of the connected DID's advertised remote DWN
   * service. Live changes require read access to `ServiceConfigProtocol`.
   */
  remoteDwn?: DwnEndpointResolution;

  /**
   * Status of the delegated connect approval, for wallet-delegated sessions.
   *
   * Seeded via `AuthManager.getConnectionStatus()` when a delegated session
   * connects and updated by `connection-expiring` / `connection-expired`
   * monitor events. Remains `undefined` for non-delegated (vault) sessions.
   */
  connection?: ConnectionStatus;

  /** Whether the identity vault is locked (a password is required to resume). */
  vaultLocked?: boolean;

  /**
   * Whether delegated grants have expired or been revoked, the wallet's
   * protocol configuration is missing or incompatible, or the session's sync
   * registration no longer covers every application protocol that requested
   * read access. Continuing requires fresh wallet approval. Use
   * {@link ConnectionStore.refresh} while a session survives, or
   * {@link ConnectionStore.connect} after it has ended. Cleared when a session
   * (re)connects with complete coverage or an `'active'` connection status is
   * observed for a session without a sync-coverage failure.
   */
  walletReapprovalRequired?: boolean;

  /**
   * The most recent action failure, including denials.
   *
   * Use `isConnectDeniedError(error)` from `@enbox/auth` to distinguish a
   * user/wallet denial (resting phase `'disconnected'`) from a real failure
   * (phase `'error'`, or `'connected'` when the prior session survived —
   * e.g. a failed or denied refresh). Cleared when the next action starts.
   */
  error?: Error;
};

/** A listener invoked with each new {@link ConnectionSnapshot} after a state change. */
export type ConnectionSnapshotListener = (snapshot: ConnectionSnapshot) => void;

/** Delegated-connect options for a manifest-backed store, whose protocols come only from the manifest. */
export type ApplicationConnectionStoreConnectOptions = Omit<HandlerConnectOptions, 'protocols'> & {
  createIdentity?: never;
  dwnEndpoints?: never;
  identitySyncProtocols?: never;
  metadata?: never;
  protocols?: never;
};

/** Refresh options for a manifest-backed store, whose protocols come only from the manifest. */
export type ApplicationConnectionStoreRefreshOptions = Omit<RefreshOptions, 'protocols'> & {
  protocols?: never;
};

/**
 * Options shared by plain and manifest-backed connection stores.
 *
 * Accepts `AuthManagerOptions` except `agent` — everything the store does not
 * consume itself (`connectHandler`, `sync`, `storage`, `password`, …) is
 * forwarded verbatim to `AuthManager.create()` during the first action. To
 * use a caller-owned agent, create an `AuthManager` around it and pass that
 * manager through `auth`.
 */
type ConnectionStoreSharedOptions = Omit<AuthManagerOptions, 'agent'> & {
  /** Raw agents have ambiguous ownership; pass a caller-owned manager through {@link auth}. */
  agent?: never;

  /**
   * A pre-built `AuthManager` to drive instead of creating one.
   *
   * When provided, all `AuthManagerOptions` fields are ignored and the caller
   * keeps ownership: {@link ConnectionStore.dispose} will not shut the
   * manager down. When omitted, the store creates and owns its manager lazily
   * on the first action.
   */
  auth?: AuthManager;

  /** Options forwarded to `AuthManager.restoreSession()` during {@link ConnectionStore.initialize}. */
  restore?: RestoreSessionOptions;
};

/** Options for a connection store without an application manifest. */
type PlainConnectionStoreOptions = ConnectionStoreSharedOptions & {
  application?: undefined;

  /**
   * Options for the delegated-connection monitor the store starts whenever a
   * wallet-delegated session connects, or `false` to disable monitoring.
   * Defaults to `{}` (the `AuthManager` polling defaults).
   */
  monitor?: ConnectionMonitorOptions | false;

  requireHostedReadiness?: never;
};

/** Options for a connection store backed by one canonical application manifest. */
export type ApplicationConnectionStoreOptions = ConnectionStoreSharedOptions & {
  /** One or more typed protocols used for delegated grants and session-local readiness. */
  application: ApplicationManifest;

  /** Delegated monitor options whose automatic refresh derives protocols from {@link application}. */
  monitor?: (Omit<ConnectionMonitorOptions, 'autoRefresh'> & {
    autoRefresh?: ApplicationConnectionStoreRefreshOptions;
  }) | false;

  /** Require owner protocols to be published and verified at the hosted DWN before connecting. Defaults to `false`. */
  requireHostedReadiness?: boolean;
};

/** Options for {@link createConnectionStore}. */
export type ConnectionStoreOptions = PlainConnectionStoreOptions | ApplicationConnectionStoreOptions;

/**
 * A framework-agnostic observable store over the Enbox connection lifecycle.
 *
 * Actions never reject with flow errors — every outcome (success, denial,
 * failure) lands in the returned {@link ConnectionSnapshot}, so UI bindings
 * only ever read state. The single exception is calling any action on a
 * disposed store, which throws synchronously as a programming error.
 * Keep one store for each application data path and reuse it for the app
 * lifetime; separate store instances intentionally do not coordinate actions.
 *
 * While an action is in flight, additional `initialize`/`connect`/
 * `connectVault`/`refresh`/`refreshDwnEndpoints`/`retryRemote` calls do not start a second
 * auth flow; they return the in-flight action's resulting snapshot.
 * `disconnect()` is exempt so it can supersede (invalidate) an in-flight
 * connect.
 */
export interface ConnectionStore {
  /**
   * The `AuthManager` behind the store, for advanced auth operations
   * (identity CRUD, local-node pairing, extra event subscriptions, …).
   * `undefined` until the first action bootstraps the store, and after
   * {@link dispose}.
   */
  readonly auth: AuthManager | undefined;

  /**
   * Returns the current snapshot. Reference-stable: the same object is
   * returned until the state changes (the `useSyncExternalStore` contract).
   */
  getSnapshot(): ConnectionSnapshot;

  /**
   * Subscribes to snapshot changes. The listener is invoked with each new
   * snapshot **after** a change — not immediately on subscribe; read the
   * current state with {@link getSnapshot}. Returns an unsubscribe function.
   */
  subscribe(listener: ConnectionSnapshotListener): () => void;

  /**
   * Bootstraps the store: creates the `AuthManager` (unless one was
   * provided), attempts `restoreSession()`, and resolves to a `'connected'`
   * or `'disconnected'` snapshot.
   *
   * Idempotent and safe to call once on app boot: repeated calls while
   * in flight return the same promise; calls after a successful bootstrap
   * (including one implied by a completed {@link connect}) resolve with the
   * current snapshot. A failed bootstrap may be retried by calling again.
   */
  initialize(): Promise<ConnectionSnapshot>;

  /**
   * Runs `AuthManager.connect()` — restore, handler (wallet), or vault flow
   * based on the options. Denial resolves to `'disconnected'` with `error`
   * set to the `ConnectDeniedError`; other failures resolve to `'error'`.
   * A registered application supplies protocols to this delegated flow. Use
   * {@link connectVault} for an explicit local-vault connection.
   */
  connect(options?: ConnectOptions): Promise<ConnectionSnapshot>;

  /** Runs `AuthManager.connectVault()` — the explicit local HD-vault flow. */
  connectVault(options?: VaultConnectOptions): Promise<ConnectionSnapshot>;

  /**
   * Runs `AuthManager.refresh()` to re-grant the current delegated session.
   * On success the reapproval flag clears and the connection status reseeds.
   * An auth/approval failure before replacement keeps the surviving session
   * `'connected'` when it was already public. A coverage-hidden session stays
   * hidden, retains `walletReapprovalRequired`, and remains available to retry.
   * A readiness failure keeps the replacement unpublished. These outcomes are
   * surfaced via `error`.
   */
  refresh(options: RefreshOptions): Promise<ConnectionSnapshot>;

  /**
   * Freshly resolves the connected DID's remote DWN status and retries sync
   * routing. Call after changing endpoints through this same agent; remote
   * service-config deliveries trigger the refresh automatically.
   */
  refreshDwnEndpoints(): Promise<ConnectionSnapshot>;

  /**
   * Freshly validates remote routing, then immediately retries quota-blocked
   * messages for `remoteEndpoint` when it is still advertised by the DID.
   */
  retryRemote(remoteEndpoint: string): Promise<ConnectionSnapshot>;

  /**
   * Signs out: stops the connection monitor, runs `AuthManager.disconnect()`
   * (grant revocation + session-marker cleanup), and resolves to a
   * `'disconnected'` snapshot. Allowed while a connect is in flight — the
   * in-flight attempt is invalidated and its outcome discarded.
   */
  disconnect(options?: DisconnectOptions): Promise<ConnectionSnapshot>;

  /**
   * Tears the store down: stops the monitor, detaches all auth event
   * subscriptions, drops all listeners, and — when the store created its own
   * `AuthManager` — shuts it down (locking the vault and closing storage).
   *
   * Unlike {@link disconnect} this is **not** a sign-out: session markers
   * survive, so a new store can restore the session on next boot. Terminal:
   * the store cannot be reused afterwards. Intended for app shutdown, not
   * for framework effect cleanup (create the store once per app lifetime).
   */
  dispose(): Promise<void>;
}

/** A manifest-backed store whose delegated operations derive protocols from that manifest. */
export type ApplicationConnectionStore = Omit<ConnectionStore, 'connect' | 'refresh'> & {
  /** Connect through the delegated handler. Use `connectVault()` for an owner session. */
  connect(options?: ApplicationConnectionStoreConnectOptions): Promise<ConnectionSnapshot>;

  /** Refresh delegated grants using the manifest's canonical protocol requests. */
  refresh(options?: ApplicationConnectionStoreRefreshOptions): Promise<ConnectionSnapshot>;
};

/** Snapshot patch that clears every session-derived field. */
const CLEARED_SESSION_FIELDS = {
  connection               : undefined,
  enbox                    : undefined,
  error                    : undefined,
  identityDid              : undefined,
  identityName             : undefined,
  remoteDwn                : undefined,
  session                  : undefined,
  sync                     : undefined,
  walletReapprovalRequired : undefined,
} as const;

/** Every key of {@link ConnectionSnapshot}, for shallow change detection. */
const SNAPSHOT_KEYS: readonly (keyof ConnectionSnapshot)[] = [
  'phase',
  'session',
  'enbox',
  'identityDid',
  'identityName',
  'sync',
  'remoteDwn',
  'connection',
  'vaultLocked',
  'walletReapprovalRequired',
  'error',
];

const DISPOSED_MESSAGE =
  '[@enbox/api] ConnectionStore has been disposed and cannot be reused. Create a new store with createConnectionStore().';

/**
 * Internal sentinel thrown when an action resumes after being superseded by a
 * newer lifecycle action (`disconnect()` or `dispose()`). Always swallowed by
 * the generation gate in `_applyActionFailure` — it never reaches callers.
 */
const SUPERSEDED_MESSAGE =
  '[@enbox/api] ConnectionStore action was superseded by a newer lifecycle action.';

/** Shallow-compares two snapshots over the known key set. */
function snapshotsEqual(a: ConnectionSnapshot, b: ConnectionSnapshot): boolean {
  return SNAPSHOT_KEYS.every((key: keyof ConnectionSnapshot): boolean => a[key] === b[key]);
}

/** Compare endpoint projections by meaning so a cache refresh alone does not notify subscribers. */
function dwnEndpointStatusesEqual(
  a: DwnEndpointResolution | undefined,
  b: DwnEndpointResolution | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (a.status !== b.status || a.didUri !== b.didUri) {
    return false;
  }
  if (a.status === 'ready' && b.status === 'ready') {
    return a.endpoints.length === b.endpoints.length
      && a.endpoints.every((endpoint, index): boolean => endpoint === b.endpoints[index]);
  }
  if (a.status !== 'ready' && b.status !== 'ready') {
    return a.message === b.message && a.resolutionError === b.resolutionError;
  }
  return false;
}

/** Freeze an endpoint projection deeply enough to preserve the snapshot's immutable contract. */
function immutableDwnEndpointStatus(status: DwnEndpointResolution): DwnEndpointResolution {
  if (status.status === 'ready') {
    const endpoints = [...status.endpoints];
    Object.freeze(endpoints);
    return Object.freeze({ ...status, endpoints });
  }
  return Object.freeze({ ...status });
}

/** Normalizes an unknown thrown value into an `Error`. */
function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Whether an auth session still owns a usable, unaborted lifetime. */
function isActiveAuthSession(session: AuthSession | undefined): session is AuthSession {
  return session !== undefined && !session.signal.aborted;
}

/** Whether a newly active session must replace the connection currently being published. */
function shouldResetPublishedSession(snapshot: ConnectionSnapshot, activeSession: AuthSession): boolean {
  return snapshot.phase === 'disconnecting'
    || (snapshot.session !== undefined && snapshot.session !== activeSession);
}

/** Whether a candidate remains the auth manager's active, unaborted session. */
function isAuthoritativeActiveSession(
  authoritativeSession: AuthSession | undefined,
  candidate: AuthSession,
): boolean {
  return authoritativeSession === candidate && isActiveAuthSession(candidate);
}

/** Whether readiness rejected a delegated definition that needs fresh wallet approval. */
function requiresWalletReapproval(error: Error): boolean {
  return error instanceof ProtocolReadinessError &&
    error.cause instanceof WalletReapprovalRequiredError;
}

/** Internal actionable failure for an incomplete delegated application sync registration. */
class ManifestSyncRegistrationCoverageError extends Error {
  public constructor(session: AuthSession, requiredProtocols: readonly string[]) {
    super(
      `[@enbox/api] The delegated session for '${session.did}' does not have a sync registration ` +
      `for delegate '${session.delegateDid}' covering every read protocol: ${requiredProtocols.join(', ')}. ` +
      'Refresh the wallet approval to continue.'
    );
    this.name = 'ManifestSyncRegistrationCoverageError';
  }
}

type ManifestCoverageBinding = {
  onAbort: () => void;
  revision: number;
  session: AuthSession;
  unsubscribe?: () => void;
};

/** Whether one exact registration matches the delegate and every manifest read protocol. */
function manifestRegistrationCoversSession(
  session: AuthSession,
  requiredProtocols: readonly string[],
  registration: SyncIdentityOptions | undefined,
): boolean {
  return registration?.delegateDid === session.delegateDid
    && requiredProtocols.every((protocol): boolean => (
      syncRegistrationCoversProtocol(registration, protocol)
    ));
}

type SyncStatusBinding = {
  dwnRefresh?: Promise<Error | boolean>;
  dwnRefreshRequested: boolean;
  onAbort: () => void;
  refresh?: Promise<void>;
  refreshRequested: boolean;
  routedDwn?: DwnEndpointResolution;
  session: AuthSession;
  unsubscribe?: () => void;
};

/**
 * The concrete {@link ConnectionStore} returned by {@link createConnectionStore}.
 *
 * Concurrency model: connect-type actions are single-flighted through
 * `_pendingAction`; every action bumps `_actionGeneration` and applies its
 * outcome only when still current, so a superseding `disconnect()` or
 * `dispose()` silently discards a stale attempt's late result. Staleness is
 * re-checked at every await resumption — in particular before a lazily
 * created `AuthManager` runs any auth flow (`_ensureAuth`), so a superseded
 * initialize can never call `restoreSession()` and resurrect a session the
 * user just disconnected. Manager creation is memoized and adoption is pure
 * resource bookkeeping (performed even for superseded actions) so the
 * materialized manager is always owned by the store — visible to
 * `disconnect()`/`dispose()` — rather than leaked; `disconnect()` awaits an
 * in-flight creation and tears session state down through the materialized
 * manager before reporting `'disconnected'`. While an action is in flight
 * the store trusts that action for phase transitions and ignores
 * `session-start`/`session-end` events (which its own flow raised); outside
 * of actions both events are wake signals that let the store follow the
 * authoritative session on the underlying `AuthManager`. After each awaited
 * readiness or status read, the action reconciles against
 * `AuthManager.session`, so an external lifecycle change that lands while an
 * action is finishing cannot be lost.
 */
class HeadlessConnectionStore implements ConnectionStore {
  private readonly _application?: ApplicationManifest;
  private readonly _authManagerOptions: AuthManagerOptions;
  private readonly _manifestReadProtocols: readonly string[];
  private readonly _providedAuth?: AuthManager;
  private readonly _monitor: Exclude<ConnectionStoreOptions['monitor'], undefined>;
  private readonly _requireHostedReadiness: boolean;
  private readonly _restore?: RestoreSessionOptions;
  private readonly _listeners = new Set<ConnectionSnapshotListener>();
  private readonly _unpublishedEnboxes = new Set<Enbox>();
  private readonly _unsubscribers: (() => void)[] = [];

  private _auth?: AuthManager;
  private _snapshot: ConnectionSnapshot = Object.freeze<ConnectionSnapshot>({ phase: 'initializing' });
  private _stopMonitor?: () => void;
  private _pendingAction?: Promise<ConnectionSnapshot>;
  private _pendingAuthCreation?: Promise<AuthManager>;
  private _initialized = false;
  private _disposed = false;
  private _actionGeneration = 0;
  private _manifestCoverageBinding?: ManifestCoverageBinding;
  private _manifestCoverageMissing = false;
  private _syncBinding?: SyncStatusBinding;

  public constructor(options: ConnectionStoreOptions) {
    if (Object.hasOwn(options, 'agent')) {
      throw new TypeError(
        '[@enbox/api] createConnectionStore: agent is not supported; create an AuthManager and pass it as auth.',
      );
    }
    const { application, auth, monitor, requireHostedReadiness, restore, ...authManagerOptions } = options;
    if (application?.protocols.length === 0) {
      throw new TypeError('[@enbox/api] createConnectionStore requires at least one application protocol.');
    }
    this._application = application;
    this._manifestReadProtocols = application === undefined
      ? []
      : application.protocols.flatMap(({ permissions, protocol }): string[] => (
        permissions === undefined || permissions.includes('read')
          ? [protocol.definition.protocol]
          : []
      ));
    this._providedAuth = auth;
    this._monitor = monitor ?? {};
    this._requireHostedReadiness = requireHostedReadiness ?? false;
    this._restore = restore;
    this._authManagerOptions = authManagerOptions;
  }

  public get auth(): AuthManager | undefined {
    return this._auth;
  }

  public getSnapshot = (): ConnectionSnapshot => {
    return this._snapshot;
  };

  public subscribe = (listener: ConnectionSnapshotListener): () => void => {
    this._listeners.add(listener);
    return (): void => {
      this._listeners.delete(listener);
    };
  };

  public initialize(): Promise<ConnectionSnapshot> {
    this._assertNotDisposed();
    if (this._pendingAction !== undefined) {
      return this._pendingAction;
    }
    // Already bootstrapped — either by a completed initialize/connect action
    // or by a session that was established directly on the AuthManager and
    // followed via `session-start`. Re-running restore would needlessly
    // rebuild the live session.
    if (this._initialized || this._snapshot.phase === 'connected') {
      return Promise.resolve(this._snapshot);
    }
    return this._track((): Promise<ConnectionSnapshot> => this._runInitialize());
  }

  public connect(options?: ConnectOptions): Promise<ConnectionSnapshot> {
    const connectOptions = this._application === undefined
      ? options
      : { ...options, protocols: getApplicationProtocolRequests(this._application) };
    return this._startConnectFlow((auth: AuthManager): Promise<AuthSession> => auth.connect(connectOptions));
  }

  public connectVault(options?: VaultConnectOptions): Promise<ConnectionSnapshot> {
    return this._startConnectFlow((auth: AuthManager): Promise<AuthSession> => auth.connectVault(options));
  }

  public refresh(options: Partial<RefreshOptions> = {}): Promise<ConnectionSnapshot> {
    return this._startConnectFlow((auth: AuthManager): Promise<AuthSession> => (
      auth.refresh(this._refreshOptions(options))
    ));
  }

  public refreshDwnEndpoints(): Promise<ConnectionSnapshot> {
    this._assertNotDisposed();
    if (this._pendingAction !== undefined) {
      return this._pendingAction;
    }
    return this._track((): Promise<ConnectionSnapshot> => this._runDwnEndpointRefresh());
  }

  public retryRemote(remoteEndpoint: string): Promise<ConnectionSnapshot> {
    this._assertNotDisposed();
    if (this._pendingAction !== undefined) {
      return this._pendingAction;
    }
    return this._track((): Promise<ConnectionSnapshot> => this._runRetryRemote(remoteEndpoint));
  }

  public disconnect(options?: DisconnectOptions): Promise<ConnectionSnapshot> {
    this._assertNotDisposed();
    if (this._snapshot.phase === 'disconnecting' && this._pendingAction !== undefined) {
      return this._pendingAction;
    }
    return this._track((): Promise<ConnectionSnapshot> => this._runDisconnect(options));
  }

  public async dispose(): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._actionGeneration++;
    this._stopDelegateMonitor();
    this._unbindManifestCoverage();
    this._unbindSyncStatus();

    for (const unsubscribe of this._unsubscribers) {
      unsubscribe();
    }
    this._unsubscribers.length = 0;
    this._listeners.clear();
    // Clear retained session resources without publishing after listeners are gone.
    this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'disconnected', vaultLocked: undefined });

    const auth = this._auth;
    this._auth = undefined;
    if (auth !== undefined && this._providedAuth === undefined) {
      try {
        await auth.shutdown();
      } catch (cause: unknown) {
        console.warn('[@enbox/api] ConnectionStore.dispose: AuthManager.shutdown() failed', cause);
      }
    }
  }

  // ─── Actions ───────────────────────────────────────────────────

  /** Claims the action slot before `start` can synchronously notify re-entrant listeners. */
  private _track(start: () => Promise<ConnectionSnapshot>): Promise<ConnectionSnapshot> {
    let resolveAction!: (snapshot: ConnectionSnapshot) => void;
    let rejectAction!: (cause: unknown) => void;
    const action = new Promise<ConnectionSnapshot>((resolve, reject): void => {
      resolveAction = resolve;
      rejectAction = reject;
    });
    this._pendingAction = action;
    const release = (): void => {
      if (this._pendingAction === action) {
        this._pendingAction = undefined;
      }
    };
    void action.then(release, release);

    let started: Promise<ConnectionSnapshot>;
    try {
      started = start();
    } catch (cause: unknown) {
      rejectAction(cause);
      return action;
    }
    void started.then(resolveAction, rejectAction);
    return action;
  }

  /** Single-flight entry point shared by `connect`, `connectVault`, and `refresh`. */
  private _startConnectFlow(flow: (auth: AuthManager) => Promise<AuthSession>): Promise<ConnectionSnapshot> {
    this._assertNotDisposed();
    if (this._pendingAction !== undefined) {
      return this._pendingAction;
    }
    return this._track((): Promise<ConnectionSnapshot> => this._runConnectFlow(flow));
  }

  private async _runInitialize(): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    if (this._auth === undefined) {
      void this._materializeAuth();
    }
    this._apply({ error: undefined, phase: 'initializing' });

    try {
      const auth = await this._ensureAuth(generation);
      const session = await auth.restoreSession(this._restore);
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }

      if (session === undefined) {
        this._initialized = true;
        this._manifestCoverageMissing = false;
        const snapshot = this._apply({
          ...CLEARED_SESSION_FIELDS,
          phase       : 'disconnected',
          vaultLocked : auth.state === 'locked',
        });
        return this._settlePublication(generation, snapshot);
      }
      const snapshot = await this._commitConnected(auth, generation);
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      this._initialized = true;
      return snapshot;
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      return this._settlePublication(generation, this._applyActionFailure(generation, cause));
    }
  }

  private async _runConnectFlow(flow: (auth: AuthManager) => Promise<AuthSession>): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    if (this._auth === undefined) {
      void this._materializeAuth();
    }
    this._apply({ error: undefined, phase: 'connecting' });

    try {
      const auth = await this._ensureAuth(generation);
      await flow(auth);
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }

      const snapshot = await this._commitConnected(auth, generation);
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      // A completed, ready connect implies the store is bootstrapped — a
      // later initialize() must not re-run restore over the live session.
      this._initialized = true;
      return snapshot;
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      return this._settlePublication(generation, this._applyActionFailure(generation, cause));
    }
  }

  private async _runDisconnect(options?: DisconnectOptions): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    this._stopDelegateMonitor();
    this._unbindManifestCoverage();
    // Auth aborts the session lifetime before teardown can fail. Remove the
    // unusable session immediately while exposing the in-flight transition.
    this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'disconnecting' });

    try {
      // A disconnect must never resolve while a manager it did not clear can
      // still materialize: if a superseded initialize/connect is mid-creation,
      // await the creation and perform the real teardown — clearing persisted
      // session state per `options` — against the materialized manager. (A
      // failed creation leaves nothing to clear.)
      if (this._auth === undefined && this._pendingAuthCreation !== undefined) {
        const materialized = await this._pendingAuthCreation.catch((): undefined => undefined);
        if (materialized !== undefined && this._auth === undefined && !this._disposed) {
          this._adoptAuth(materialized);
        }
      }

      const auth = this._auth;
      if (auth !== undefined) {
        await auth.disconnect(options);
      }
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      return this._settlePublication(
        generation,
        this._publishDisconnected(),
      );
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      if (!isActiveAuthSession(this._auth?.session)) {
        this._manifestCoverageMissing = false;
      }
      return this._settlePublication(generation, this._applyActionFailure(generation, cause));
    }
  }

  // ─── Outcome mapping ───────────────────────────────────────────

  private async _runDwnEndpointRefresh(): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    this._apply({ error: undefined });

    const binding = this._syncBinding;
    if (binding === undefined || !this._isCurrentSession(binding.session)) {
      return this._failStatusAction(
        generation,
        new Error('[@enbox/api] ConnectionStore.refreshDwnEndpoints requires an active session.'),
      );
    }

    try {
      const refreshed = await this._requestDwnEndpointRefresh(binding);
      if (refreshed instanceof Error) {
        throw refreshed;
      }
      return this._settleStatusAction(binding, generation);
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      if (this._syncBinding !== binding || !this._isCurrentSession(binding.session)) {
        return this._settleStatusAction(binding, generation);
      }
      return this._failStatusAction(generation, cause);
    }
  }

  private async _runRetryRemote(remoteEndpoint: string): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    this._apply({ error: undefined });

    const binding = this._syncBinding;
    if (binding === undefined || !this._isCurrentSession(binding.session)) {
      return this._failStatusAction(
        generation,
        new Error('[@enbox/api] ConnectionStore.retryRemote requires an active session.'),
      );
    }

    this._setRetryingEndpoint(binding, remoteEndpoint);
    try {
      const refreshed = await this._requestDwnEndpointRefresh(binding);
      if (refreshed instanceof Error) {
        throw refreshed;
      }
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      if (this._syncBinding !== binding || !this._isCurrentSession(binding.session)) {
        return this._settleStatusAction(binding, generation);
      }

      const remoteDwn = this._snapshot.remoteDwn;
      if (refreshed === true
        && remoteDwn?.status === 'ready'
        && remoteDwn.endpoints.includes(remoteEndpoint)) {
        await binding.session.agent.sync.retryRemoteNow(binding.session.did, remoteEndpoint);
        if (this._syncBinding === binding && this._isCurrentSession(binding.session)) {
          await this._requestSyncStatus(binding);
        }
      }
      this._setRetryingEndpoint(binding, undefined);
      return this._settleStatusAction(binding, generation);
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      this._setRetryingEndpoint(binding, undefined);
      if (this._syncBinding !== binding || !this._isCurrentSession(binding.session)) {
        return this._settleStatusAction(binding, generation);
      }
      return this._failStatusAction(generation, cause);
    }
  }

  /** Reconcile lifecycle events suppressed while a status action owned the single-flight slot. */
  private async _settleStatusAction(
    binding: SyncStatusBinding,
    generation: number,
  ): Promise<ConnectionSnapshot> {
    try {
      if (this._isStale(generation)) {
        return await this._settleSuperseded();
      }
      if (this._syncBinding === binding && this._isCurrentSession(binding.session)) {
        return this._snapshot;
      }

      const auth = this._auth;
      const snapshot = auth === undefined
        ? this._publishDisconnected()
        : await this._commitConnected(auth, generation);
      return this._isStale(generation)
        ? await this._settleSuperseded()
        : snapshot;
    } catch (cause: unknown) {
      return this._failStatusAction(generation, cause);
    }
  }

  /** Publish a status-action failure, then honor a disconnect started by that publication. */
  private async _failStatusAction(generation: number, cause: unknown): Promise<ConnectionSnapshot> {
    const snapshot = this._applyActionFailure(generation, cause);
    return this._settlePublication(generation, snapshot);
  }

  /** Honor a lifecycle action started re-entrantly by a terminal publication. */
  private _settlePublication(
    generation: number,
    snapshot: ConnectionSnapshot,
  ): Promise<ConnectionSnapshot> | ConnectionSnapshot {
    return this._isStale(generation) ? this._settleSuperseded() : snapshot;
  }

  /** Apply and seed the authoritative session, repeating if auth changes while status is read. */
  private async _commitConnected(auth: AuthManager, generation: number): Promise<ConnectionSnapshot> {
    // This cannot spin without yielding: each continuation requires a distinct
    // external session replacement during an awaited readiness or status read.
    // Capping it could publish a session the manager has already replaced.
    while (!this._isStale(generation)) {
      const committed = await this._commitCurrentSession(auth, generation);
      if (committed !== undefined) {
        return committed;
      }
    }

    return this._snapshot;
  }

  /** Ready and publish one session candidate; return `undefined` when auth replaced it mid-flight. */
  private async _commitCurrentSession(
    auth: AuthManager,
    generation: number,
  ): Promise<ConnectionSnapshot | undefined> {
    const activeSession = auth.session;
    if (!isActiveAuthSession(activeSession)) {
      return this._publishDisconnected();
    }
    if (shouldResetPublishedSession(this._snapshot, activeSession)) {
      // Auth aborts the previous lifetime before publishing its replacement.
      // Do not expose that dead session while the replacement is readied.
      this._stopDelegateMonitor();
      this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'connecting' });
    }

    const shouldSeedRemoteDwn = this._snapshot.session !== activeSession || this._snapshot.remoteDwn === undefined;
    const patch = this._connectedPatch(activeSession);
    const coverageBinding = this._bindManifestCoverage(activeSession);
    if (this._snapshot.enbox !== patch.enbox) {
      this._unpublishedEnboxes.add(patch.enbox);
    }
    try {
      const coverageRevision = coverageBinding === undefined
        ? undefined
        : await this._assertManifestSyncCoverage(coverageBinding);
      if (this._isStale(generation)) {
        return this._snapshot;
      }
      if (coverageBinding !== undefined && coverageRevision === undefined) {
        return undefined;
      }
      if (coverageBinding === undefined) {
        // Owner, plain-store, and zero-read manifests vacuously repair only
        // the sync-coverage reason before independent readiness begins.
        this._manifestCoverageMissing = false;
      }

      const readinessError = this._application === undefined
        ? undefined
        : await this._getApplicationReadinessError(patch.enbox, this._application);
      if (this._isStale(generation)) {
        return this._snapshot;
      }

      const readySession = auth.session;
      if (!isActiveAuthSession(readySession)) {
        return this._publishDisconnected();
      }
      if (readySession !== activeSession) {
        return undefined;
      }
      let validatedCoverageRevision = coverageRevision;
      while (coverageBinding !== undefined
        && (this._manifestCoverageBinding !== coverageBinding
          || coverageBinding.revision !== validatedCoverageRevision)) {
        validatedCoverageRevision = await this._assertManifestSyncCoverage(coverageBinding);
        if (validatedCoverageRevision === undefined) {
          return undefined;
        }
      }
      if (this._isStale(generation)) {
        return this._snapshot;
      }

      const coveredSession = auth.session;
      if (!isActiveAuthSession(coveredSession)) {
        return this._publishDisconnected();
      }
      if (coveredSession !== activeSession) {
        return undefined;
      }
      if (readinessError !== undefined) {
        await this._rejectUnreadySession(auth, readinessError);
      }

      this._apply(patch);
      if (this._manifestCoverageBinding === coverageBinding) {
        // `_apply` synchronously installs the published session's permanent
        // sync observer before this provisional read-to-publish guard leaves.
        this._unbindManifestCoverage();
      }
      const binding = this._syncBinding;
      if (shouldSeedRemoteDwn && binding?.session === activeSession) {
        await this._requestDwnEndpointRefresh(binding);
      }
      if (this._isStale(generation)) {
        return this._snapshot;
      }
      if (this._isCurrentSession(activeSession)) {
        this._restartMonitor(auth, activeSession);
        await this._seedConnectionStatus(auth, activeSession, generation);
        if (this._isStale(generation)) {
          return this._snapshot;
        }
      }

      const authoritativeSession = auth.session;
      if (isAuthoritativeActiveSession(authoritativeSession, activeSession)) {
        return this._snapshot;
      }
      if (!isActiveAuthSession(authoritativeSession)) {
        return this._publishDisconnected();
      }
      return undefined;
    } finally {
      this._unpublishedEnboxes.delete(patch.enbox);
      if (this._snapshot.enbox !== patch.enbox) {
        patch.enbox.close();
      }
      if (this._snapshot.session !== activeSession
        && this._manifestCoverageBinding?.session === activeSession) {
        this._unbindManifestCoverage();
      }
    }
  }

  /**
   * Subscribe before the first registration read and retain the observer
   * through readiness/publication so no registration transition can land in a
   * read-to-publish gap.
   */
  private _bindManifestCoverage(session: AuthSession): ManifestCoverageBinding | undefined {
    const existing = this._manifestCoverageBinding;
    if (existing?.session === session) {
      return existing;
    }
    this._unbindManifestCoverage();
    if (session.delegateDid === undefined || this._manifestReadProtocols.length === 0) {
      return undefined;
    }

    const binding: ManifestCoverageBinding = {
      onAbort: (): void => {
        if (this._manifestCoverageBinding === binding) {
          this._unbindManifestCoverage();
        }
      },
      revision: 0,
      session,
    };
    this._manifestCoverageBinding = binding;
    session.signal.addEventListener('abort', binding.onAbort, { once: true });
    binding.unsubscribe = session.agent.sync.on((event): void => {
      if (this._manifestCoverageBinding !== binding
        || event.type !== 'identity:registration-change'
        || event.tenantDid !== session.did) {
        return;
      }

      binding.revision++;
      if (this._isAuthoritativeSession(session)) {
        this._manifestCoverageMissing = !manifestRegistrationCoversSession(
          session,
          this._manifestReadProtocols,
          event.options,
        );
      }
    });
    return binding;
  }

  /** Read until one revision remains stable; registration events request a trailing read. */
  private async _assertManifestSyncCoverage(binding: ManifestCoverageBinding): Promise<number | undefined> {
    while (this._manifestCoverageBinding === binding) {
      const revision = binding.revision;
      let registration: SyncIdentityOptions | undefined;
      try {
        registration = await binding.session.agent.sync.getIdentityOptions(binding.session.did);
      } catch (cause: unknown) {
        if (this._manifestCoverageBinding !== binding
          || !this._isAuthoritativeSession(binding.session)) {
          return undefined;
        }
        throw cause;
      }

      if (this._manifestCoverageBinding !== binding
        || !this._isAuthoritativeSession(binding.session)) {
        return undefined;
      }
      if (binding.revision !== revision) {
        continue;
      }
      const covered = manifestRegistrationCoversSession(
        binding.session,
        this._manifestReadProtocols,
        registration,
      );
      this._manifestCoverageMissing = !covered;
      if (!covered) {
        throw new ManifestSyncRegistrationCoverageError(binding.session, this._manifestReadProtocols);
      }
      return revision;
    }
    return undefined;
  }

  /** Fail closed on missing coverage without ending the repairable auth session. */
  private _publishManifestCoverageFailure(
    error: ManifestSyncRegistrationCoverageError,
    expectedSession?: AuthSession,
  ): ConnectionSnapshot {
    if (expectedSession !== undefined && !this._isCurrentSession(expectedSession)) {
      return this._snapshot;
    }
    this._manifestCoverageMissing = true;
    this._stopDelegateMonitor();
    return this._apply({
      ...CLEARED_SESSION_FIELDS,
      error,
      phase                    : 'disconnected',
      walletReapprovalRequired : true,
    });
  }

  private _unbindManifestCoverage(): void {
    const binding = this._manifestCoverageBinding;
    if (binding === undefined) {
      return;
    }
    this._manifestCoverageBinding = undefined;
    binding.unsubscribe?.();
    binding.session.signal.removeEventListener('abort', binding.onAbort);
  }

  /** Run the existing readiness lifecycle while keeping its failure behind the session fence. */
  private async _getApplicationReadinessError(
    enbox: Enbox,
    application: ApplicationManifest,
  ): Promise<Error | undefined> {
    try {
      await enbox.protocols.ensureReady({ application, publish: this._requireHostedReadiness });
      return undefined;
    } catch (cause: unknown) {
      return toError(cause);
    }
  }

  /** Reject one unready candidate, forgetting only definitions that require fresh wallet approval. */
  private async _rejectUnreadySession(auth: AuthManager, error: Error): Promise<never> {
    this._stopDelegateMonitor();
    if (requiresWalletReapproval(error)) {
      // The lifetime is already aborted if cleanup fails; keep the actionable
      // readiness outcome while making the cleanup failure visible.
      await auth.disconnect({ clearStorage: false }).catch((cleanupError: unknown): void => {
        console.warn('[@enbox/api] ConnectionStore: failed to clean up a rejected delegate session:', cleanupError);
      });
    }
    throw error;
  }

  /** Builds the snapshot patch for a connected session, reusing the current `Enbox` when unchanged. */
  private _connectedPatch(session: AuthSession): Partial<ConnectionSnapshot> & { enbox: Enbox } {
    const sameSession = this._snapshot.session === session;
    const enbox = sameSession && this._snapshot.enbox !== undefined
      ? this._snapshot.enbox
      : Enbox.fromSession(session);

    return {
      connection               : sameSession ? this._snapshot.connection : undefined,
      enbox,
      error                    : undefined,
      identityDid              : session.did,
      identityName             : session.identity?.name,
      phase                    : 'connected',
      remoteDwn                : sameSession ? this._snapshot.remoteDwn : undefined,
      session,
      vaultLocked              : false,
      walletReapprovalRequired : undefined,
    };
  }

  /**
   * Maps an action failure into the snapshot.
   *
   * - An active auth session that survived an auth/approval failure (e.g. a
   *   denied refresh) keeps the store `'connected'`, with `error` set.
   *   Protocol-readiness failures are the fail-closed exception: their
   *   unready session stays unpublished.
   * - A denial without a surviving session rests at `'disconnected'` —
   *   denial is a user decision, not a failure phase.
   * - Anything else is a real failure: phase `'error'`.
   */
  private _applyActionFailure(generation: number, cause: unknown): ConnectionSnapshot {
    if (this._isStale(generation)) {
      return this._snapshot;
    }

    const error = toError(cause);
    if (error instanceof ManifestSyncRegistrationCoverageError) {
      return this._publishManifestCoverageFailure(error);
    }
    if (error instanceof ProtocolReadinessError) {
      const walletReapprovalRequired = requiresWalletReapproval(error)
        ? true
        : this._manifestCoverageMissing || undefined;
      return this._apply({
        ...CLEARED_SESSION_FIELDS,
        error,
        phase: walletReapprovalRequired ? 'disconnected' : 'error',
        walletReapprovalRequired,
      });
    }

    const survivingSession = this._auth?.session;
    if (isActiveAuthSession(survivingSession)) {
      if (this._snapshot.session === survivingSession) {
        return this._apply({ error, phase: 'connected' });
      }
      if (this._application === undefined) {
        // The store missed this session (it was established outside the
        // store's own actions) — rebuild the connected fields around it.
        return this._apply({ ...this._connectedPatch(survivingSession), error });
      }
    }

    return this._apply({
      ...CLEARED_SESSION_FIELDS,
      error,
      phase                    : isConnectDeniedError(error) ? 'disconnected' : 'error',
      walletReapprovalRequired : this._manifestCoverageMissing || undefined,
    });
  }

  // ─── AuthManager wiring ────────────────────────────────────────

  /**
   * Lazily creates (or adopts) the `AuthManager`, then re-checks staleness at
   * the await resumption BEFORE any auth flow can run.
   *
   * The staleness check lives here — after adoption — because a superseded
   * action must release its claim without applying state, while the manager
   * that materialized must still end up owned by the store (never leaked). A
   * stale initialize therefore never reaches `restoreSession()`, which is
   * what would otherwise resurrect a session the user just disconnected.
   */
  private async _ensureAuth(generation: number): Promise<AuthManager> {
    let auth = this._auth;
    if (auth === undefined) {
      const materialized = await this._materializeAuth();

      if (this._disposed) {
        // Disposed while the manager was being created — shut the orphan down
        // (when store-owned) instead of leaking its storage handles.
        if (this._auth === undefined && this._providedAuth === undefined) {
          await materialized.shutdown().catch((): void => {});
        }
        throw new Error(DISPOSED_MESSAGE);
      }

      // Adoption is resource bookkeeping, not state application — it runs
      // even for superseded actions so the manager is owned by the store
      // (visible to `disconnect()`/`dispose()`) rather than dangling. A
      // concurrent disconnect may have adopted it first.
      auth = this._auth ?? this._adoptAuth(materialized);
    }

    if (this._isStale(generation)) {
      throw new Error(SUPERSEDED_MESSAGE);
    }
    return auth;
  }

  /** Memoized manager materialization shared by racing actions. */
  private _materializeAuth(): Promise<AuthManager> {
    this._pendingAuthCreation ??= this._createAuth();
    return this._pendingAuthCreation;
  }

  private async _createAuth(): Promise<AuthManager> {
    try {
      return this._providedAuth ?? await AuthManager.create(this._authManagerOptions);
    } catch (cause: unknown) {
      // Clear the memo so a later action can retry the creation.
      this._pendingAuthCreation = undefined;
      throw cause;
    }
  }

  /** Installs the materialized manager as the store's manager and wires its events. */
  private _adoptAuth(auth: AuthManager): AuthManager {
    this._auth = auth;
    this._wireAuthEvents(auth);
    return auth;
  }

  private _wireAuthEvents(auth: AuthManager): void {
    this._unsubscribers.push(
      auth.on('session-start', (): void => { this._onSessionChange(auth); }),
      auth.on('session-end', (): void => { this._onSessionChange(auth); }),
      auth.on('connection-expiring', ({ status }): void => { this._applyConnectionStatus(status); }),
      auth.on('connection-expired', ({ status }): void => { this._applyConnectionStatus(status); }),
      auth.on('vault-locked', (): void => {
        this._unbindSyncStatus();
        this._apply({ remoteDwn: undefined, sync: undefined, vaultLocked: true });
      }),
      auth.on('vault-unlocked', (): void => { this._apply({ vaultLocked: false }); }),
    );
  }

  /** Reconciles a manager lifecycle wake against its authoritative active session. */
  private _onSessionChange(auth: AuthManager): void {
    if (this._pendingAction !== undefined) {
      return;
    }

    const generation = ++this._actionGeneration;
    const session = auth.session;
    if (session === undefined) {
      this._publishDisconnected();
      return;
    }
    void this._commitConnected(auth, generation).catch((cause: unknown): void => {
      if (this._isStale(generation)) {
        return;
      }
      const error = toError(cause);
      if (error instanceof ProtocolReadinessError
        || error instanceof ManifestSyncRegistrationCoverageError
        || this._snapshot.session !== auth.session) {
        this._applyActionFailure(generation, error);
      } else {
        console.error('[@enbox/api] ConnectionStore: failed to reconcile an externally changed session:', error);
      }
    });
  }

  // ─── Delegated connection status ───────────────────────────────

  private _restartMonitor(auth: AuthManager, session: AuthSession): void {
    this._stopDelegateMonitor();
    if (this._monitor === false || session.delegateDid === undefined) {
      return;
    }
    const { autoRefresh, ...options } = this._monitor;
    this._stopMonitor = auth.startConnectionMonitor(autoRefresh === undefined
      ? options
      : { ...options, autoRefresh: this._refreshOptions(autoRefresh) });
  }

  private _refreshOptions(options: Partial<RefreshOptions>): RefreshOptions {
    const protocols = this._application === undefined
      ? options.protocols
      : getApplicationProtocolRequests(this._application);
    if (protocols === undefined) {
      throw new TypeError(
        '[@enbox/api] ConnectionStore.refresh requires protocols when no application manifest is registered.'
      );
    }
    return { ...options, protocols };
  }

  private _publishDisconnected(): ConnectionSnapshot {
    this._stopDelegateMonitor();
    this._manifestCoverageMissing = false;
    this._unbindManifestCoverage();
    return this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'disconnected' });
  }

  private _stopDelegateMonitor(): void {
    if (this._stopMonitor !== undefined) {
      this._stopMonitor();
      this._stopMonitor = undefined;
    }
  }

  /**
   * Seeds `connection` for a delegated session. The monitor only emits on
   * expiring/expired transitions, so an explicit status read is the only way
   * the snapshot can report a healthy `'active'` connection.
   */
  private async _seedConnectionStatus(auth: AuthManager, session: AuthSession, generation: number): Promise<void> {
    if (session.delegateDid === undefined) {
      return;
    }

    try {
      const options: GetConnectionStatusOptions = this._monitor === false ? {} : omitUndefined({
        checkRevoked                 : this._monitor.checkRevoked,
        expiringSoonThresholdSeconds : this._monitor.expiringSoonThresholdSeconds,
      });
      const connection = await auth.getConnectionStatus(options);
      if (this._isStale(generation) || auth.session !== session || this._snapshot.session !== session) {
        return;
      }
      this._applyConnectionStatus(connection);
    } catch {
      // Best-effort — the monitor (when enabled) still surfaces expiry and
      // revocation transitions as they happen.
    }
  }

  /** Applies a delegated connection status, deriving the wallet-reapproval flag. */
  private _applyConnectionStatus(connection: ConnectionStatus): void {
    if (!isActiveAuthSession(this._snapshot.session)
      || this._snapshot.session.delegateDid === undefined) {
      return;
    }
    let walletReapprovalRequired = this._snapshot.walletReapprovalRequired;
    if (connection.state === 'expired' || connection.state === 'revoked') {
      walletReapprovalRequired = true;
    } else if (connection.state === 'active' && !this._manifestCoverageMissing) {
      walletReapprovalRequired = undefined;
    }
    this._apply({ connection, walletReapprovalRequired });
  }

  // ─── Sync status ────────────────────────────────────────────────

  /** Replace the session-scoped observer and return its initial status projection. */
  private _bindSyncStatus(session: AuthSession | undefined): SyncStatusSnapshot | undefined {
    this._unbindSyncStatus();
    if (!isActiveAuthSession(session)) {
      return undefined;
    }

    const binding: SyncStatusBinding = {
      dwnRefreshRequested : false,
      onAbort             : (): void => { this._handleSyncAbort(binding); },
      refreshRequested    : false,
      session,
    };
    this._syncBinding = binding;
    session.signal.addEventListener('abort', binding.onAbort, { once: true });
    binding.unsubscribe = session.agent.sync.on((event): void => {
      if (event.tenantDid !== session.did) {
        return;
      }
      if (event.type === 'identity:registration-change'
        && session.delegateDid !== undefined
        && this._manifestReadProtocols.length > 0
        && !manifestRegistrationCoversSession(session, this._manifestReadProtocols, event.options)) {
        this._publishManifestCoverageFailure(
          new ManifestSyncRegistrationCoverageError(session, this._manifestReadProtocols),
          session,
        );
        return;
      }
      if (isServiceConfigNoticeDelivery(event, session.did)) {
        void this._requestDwnEndpointRefresh(binding);
      }
      void this._requestSyncStatus(binding);
    });
    void this._requestSyncStatus(binding);

    return immutableSyncStatus({ state: 'syncing', connectivity: 'unknown', remotes: [] });
  }

  private _handleSyncAbort(binding: SyncStatusBinding): void {
    if (this._syncBinding !== binding) {
      return;
    }
    this._unbindSyncStatus();
    if (!this._disposed) {
      // Auth aborts the session lifetime synchronously when an external
      // disconnect or lock starts. Reuse that existing wake to expose teardown
      // immediately; a store-driven refresh already published `connecting` and
      // must keep that replacement phase.
      const phase = this._snapshot.phase === 'connected' && this._snapshot.session === binding.session
        ? 'disconnecting'
        : this._snapshot.phase;
      this._apply({ ...CLEARED_SESSION_FIELDS, phase });
    }
  }

  private _unbindSyncStatus(): void {
    const binding = this._syncBinding;
    if (binding === undefined) {
      return;
    }

    this._syncBinding = undefined;
    binding.unsubscribe?.();
    binding.session.signal.removeEventListener('abort', binding.onAbort);
  }

  /** Coalesce sync wakes into one active local projection read and one trailing read. */
  private _requestSyncStatus(binding: SyncStatusBinding): Promise<void> {
    if (this._syncBinding !== binding) {
      return Promise.resolve();
    }

    binding.refreshRequested = true;
    binding.refresh ??= this._drainSyncStatus(binding);
    return binding.refresh;
  }

  private async _drainSyncStatus(binding: SyncStatusBinding): Promise<void> {
    try {
      while (this._syncBinding === binding && binding.refreshRequested) {
        binding.refreshRequested = false;
        const snapshot = await this._readSyncStatus(binding);
        if (this._syncBinding !== binding || binding.refreshRequested) {
          continue;
        }
        this._publishSyncStatus(binding, snapshot);
      }
    } finally {
      binding.refresh = undefined;
    }
  }

  private async _readSyncStatus(binding: SyncStatusBinding): Promise<SyncStatusSnapshot> {
    const { session } = binding;
    try {
      const status = await session.agent.sync.getIdentitySyncStatus(session.did);
      const remotes = projectRemoteSyncRows(status.remotes, this._snapshot.remoteDwn);
      return status.registration === undefined
        ? immutableSyncStatus({ state: 'caught-up', connectivity: 'unknown', remotes })
        : projectSyncStatus(status.links, session.agent.sync.connectivityState, remotes);
    } catch (cause: unknown) {
      const current = this._snapshot.sync;
      return immutableSyncStatus({
        state          : 'error',
        connectivity   : current?.connectivity ?? 'unknown',
        lastActivityAt : current?.lastActivityAt,
        remotes        : current?.remotes ?? [],
        error          : toError(cause),
      });
    }
  }

  private _publishSyncStatus(binding: SyncStatusBinding, snapshot: SyncStatusSnapshot): void {
    if (this._syncBinding !== binding) {
      return;
    }
    const retryingRemoteEndpoint = this._snapshot.sync?.retryingRemoteEndpoint;
    const next = retryingRemoteEndpoint === undefined
      ? snapshot
      : immutableSyncStatus({ ...snapshot, retryingRemoteEndpoint });
    if (!syncStatusesEqual(this._snapshot.sync, next)) {
      this._apply({ sync: next });
    }
  }

  private _setRetryingEndpoint(binding: SyncStatusBinding, retryingEndpoint: string | undefined): void {
    if (this._syncBinding !== binding || !this._isCurrentSession(binding.session)) {
      return;
    }
    const current = this._snapshot.sync;
    if (current !== undefined && current.retryingRemoteEndpoint !== retryingEndpoint) {
      this._apply({ sync: immutableSyncStatus({ ...current, retryingRemoteEndpoint: retryingEndpoint }) });
    }
  }

  /** Coalesce service-config delivery wakes into one fresh DID resolution and one trailing read. */
  private _requestDwnEndpointRefresh(binding: SyncStatusBinding): Promise<Error | boolean> {
    if (this._syncBinding !== binding) {
      return Promise.resolve(false);
    }

    binding.dwnRefreshRequested = true;
    binding.dwnRefresh ??= this._drainDwnEndpointRefresh(binding);
    return binding.dwnRefresh;
  }

  private async _drainDwnEndpointRefresh(binding: SyncStatusBinding): Promise<Error | boolean> {
    let outcome: Error | boolean = false;
    try {
      while (this._syncBinding === binding && binding.dwnRefreshRequested) {
        binding.dwnRefreshRequested = false;
        outcome = false;
        try {
          await this._refreshDwnEndpointStatus(binding);
          if (this._syncBinding === binding && !binding.dwnRefreshRequested) {
            outcome = true;
          }
        } catch (cause: unknown) {
          if (this._syncBinding === binding && !binding.dwnRefreshRequested) {
            outcome = toError(cause);
            console.error('[@enbox/api] ConnectionStore: failed to refresh remote DWN status:', outcome);
          }
        }
      }
      return outcome;
    } finally {
      binding.dwnRefresh = undefined;
    }
  }

  /** Resolve and publish one exact session's projection, then retarget registered live sync when needed. */
  private async _refreshDwnEndpointStatus(binding: SyncStatusBinding): Promise<void> {
    const { session } = binding;
    const remoteDwn = immutableDwnEndpointStatus(
      await session.agent.identity.getDwnEndpointStatus({ didUri: session.did, refresh: true })
    );
    if (!this._isCurrentSession(session)
      || binding.dwnRefreshRequested) {
      return;
    }
    if (!dwnEndpointStatusesEqual(this._snapshot.remoteDwn, remoteDwn)) {
      const current = this._snapshot.sync;
      this._apply({
        remoteDwn,
        sync: current === undefined
          ? undefined
          : immutableSyncStatus({ ...current, remotes: projectRemoteSyncRows(current.remotes, remoteDwn) }),
      });
    }
    if (remoteDwn.status === 'resolution-failed'
      || !this._isCurrentSession(session)
      || dwnEndpointStatusesEqual(binding.routedDwn, remoteDwn)) {
      if (this._isCurrentSession(session)) {
        void this._requestSyncStatus(binding);
      }
      return;
    }

    if (this._isCurrentSession(session)) {
      await session.agent.sync.refreshIdentityRouting(session.did);
    }
    if (this._syncBinding === binding && this._isCurrentSession(session)) {
      binding.routedDwn = remoteDwn;
    }
    if (this._isCurrentSession(session)) {
      void this._requestSyncStatus(binding);
    }
  }

  // ─── Snapshot plumbing ─────────────────────────────────────────

  /**
   * Applies a patch to the snapshot. When nothing changed (shallow equality)
   * the current snapshot is kept — same reference, no notification.
   */
  private _apply(patch: Partial<ConnectionSnapshot>): ConnectionSnapshot {
    const next: ConnectionSnapshot = { ...this._snapshot, ...patch };
    if (next.session !== this._snapshot.session) {
      if (this._manifestCoverageBinding?.session !== next.session) {
        this._unbindManifestCoverage();
      }
      // A changed session also guarantees snapshot inequality, so this binding reaches publication.
      next.sync = this._bindSyncStatus(next.session);
    }
    if (Object.hasOwn(patch, 'enbox')) {
      for (const enbox of this._unpublishedEnboxes) {
        this._unpublishedEnboxes.delete(enbox);
        if (enbox !== next.enbox) {
          enbox.close();
        }
      }
    }
    if (snapshotsEqual(this._snapshot, next)) {
      return this._snapshot;
    }

    const previousEnbox = this._snapshot.enbox;
    this._snapshot = Object.freeze(next);
    if (previousEnbox !== undefined && previousEnbox !== next.enbox) {
      previousEnbox.close();
    }
    this._notifyListeners(Array.from(this._listeners), this._snapshot);
    return this._snapshot;
  }

  /** Notifies the stable listener snapshot captured by {@link _apply}. */
  private _notifyListeners(listeners: readonly ConnectionSnapshotListener[], snapshot: ConnectionSnapshot): void {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (cause: unknown) {
        console.error('[@enbox/api] ConnectionStore: error in snapshot listener:', cause);
      }
    }
  }

  /** Whether an action outcome is stale — superseded by a newer action or by disposal. */
  private _isStale(generation: number): boolean {
    return this._disposed || generation !== this._actionGeneration;
  }

  /** Whether one exact session still owns both auth and published connection state. */
  private _isCurrentSession(session: AuthSession | undefined): session is AuthSession {
    return !this._disposed
      && isActiveAuthSession(session)
      && this._auth?.session === session
      && this._snapshot.session === session;
  }

  /** Whether one candidate still owns the authoritative auth session before publication. */
  private _isAuthoritativeSession(session: AuthSession | undefined): session is AuthSession {
    return !this._disposed
      && isActiveAuthSession(session)
      && this._auth?.session === session;
  }

  /**
   * Resolves a superseded action with the superseding action's outcome (when
   * one is still pending) so a superseded call never reports an intermediate
   * snapshot. Never self-referential: a non-disposed stale action was
   * superseded by a `disconnect()` whose `_track` already replaced
   * `_pendingAction`, and disposal returns the snapshot directly.
   */
  private _settleSuperseded(): Promise<ConnectionSnapshot> | ConnectionSnapshot {
    if (this._disposed || this._pendingAction === undefined) {
      return this._snapshot;
    }
    return this._pendingAction;
  }

  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error(DISPOSED_MESSAGE);
    }
  }
}

function projectSyncStatus(
  links: readonly ReplicationLinkSnapshot[],
  fallbackConnectivity: SyncConnectivityState,
  remotes: readonly Readonly<RemoteSyncStatus>[],
): SyncStatusSnapshot {
  const connectivity = resolveSyncConnectivityState(
    links.map((link): SyncConnectivityState => link.connectivity),
    fallbackConnectivity,
  );
  const lastActivityAt = latestActivityAt(links);
  const state = projectReplicationCurrentness(links);
  if (state === 'error') {
    return immutableSyncStatus({
      state : 'error',
      connectivity,
      lastActivityAt,
      remotes,
      error : new Error('Synchronization is paused for the selected identity.'),
    });
  }
  return immutableSyncStatus({
    state,
    connectivity,
    lastActivityAt,
    remotes,
  });
}

function projectRemoteSyncRows(
  rows: readonly Readonly<RemoteSyncStatus>[],
  remoteDwn: DwnEndpointResolution | undefined,
): readonly Readonly<RemoteSyncStatus>[] {
  if (remoteDwn?.status !== 'ready') {
    return [];
  }

  const byEndpoint = new Map(rows.map((row): [string, Readonly<RemoteSyncStatus>] => [row.remoteEndpoint, row]));
  return remoteDwn.endpoints.flatMap((endpoint): Readonly<RemoteSyncStatus>[] => {
    const row = byEndpoint.get(endpoint);
    return row === undefined ? [] : [Object.freeze({ ...row })];
  });
}

function latestActivityAt(links: readonly ReplicationLinkSnapshot[]): string | undefined {
  let latest: string | undefined;
  for (const { lastActivityAt } of links) {
    if (lastActivityAt !== undefined && (latest === undefined || lastActivityAt > latest)) {
      latest = lastActivityAt;
    }
  }
  return latest;
}

function immutableSyncStatus(snapshot: SyncStatusSnapshot): SyncStatusSnapshot {
  const remotes = Object.freeze([...snapshot.remotes]);
  return Object.freeze({ ...snapshot, remotes });
}

function syncStatusesEqual(a: SyncStatusSnapshot | undefined, b: SyncStatusSnapshot): boolean {
  return a?.state === b.state &&
    a.connectivity === b.connectivity &&
    a.lastActivityAt === b.lastActivityAt &&
    a.error?.message === b.error?.message &&
    a.retryingRemoteEndpoint === b.retryingRemoteEndpoint &&
    a.remotes.length === b.remotes.length
    && a.remotes.every((remote, index): boolean => remoteSyncRowsEqual(remote, b.remotes[index]));
}

function remoteSyncRowsEqual(a: Readonly<RemoteSyncStatus>, b: Readonly<RemoteSyncStatus>): boolean {
  return a.tenantDid === b.tenantDid
    && a.remoteEndpoint === b.remoteEndpoint
    && a.state === b.state
    && a.connectivity === b.connectivity
    && a.quotaBlockedMessageCount === b.quotaBlockedMessageCount
    && a.failedMessageCount === b.failedMessageCount
    && a.nextProbeAt === b.nextProbeAt
    && a.lastError === b.lastError
    && a.lastActivityAt === b.lastActivityAt;
}

/**
 * Creates a framework-agnostic, subscribable {@link ConnectionStore}.
 *
 * The store is created synchronously (safe at module scope); the
 * `AuthManager` is built lazily by the first action. A typical app creates
 * one store for its lifetime, calls {@link ConnectionStore.initialize} once
 * on boot, and binds its UI to `subscribe`/`getSnapshot`.
 *
 * @param options - `AuthManagerOptions` except `agent`, plus store-specific fields
 *   ({@link ConnectionStoreOptions.auth}, {@link ConnectionStoreOptions.monitor},
 *   {@link ConnectionStoreOptions.restore}).
 * @returns A new {@link ConnectionStore}.
 */
export function createConnectionStore(options: ApplicationConnectionStoreOptions): ApplicationConnectionStore;
export function createConnectionStore(options?: PlainConnectionStoreOptions): ConnectionStore;
export function createConnectionStore(options: ConnectionStoreOptions): ConnectionStore | ApplicationConnectionStore;
export function createConnectionStore(
  options: ConnectionStoreOptions = {},
): ConnectionStore | ApplicationConnectionStore {
  return new HeadlessConnectionStore(options);
}
