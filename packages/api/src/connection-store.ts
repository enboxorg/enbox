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
import type { ReplicationLinkSnapshot, SyncConnectivityState } from '@enbox/agent';

import { AuthManager } from '@enbox/auth/auth-manager';
import { isConnectDeniedError } from '@enbox/auth';
import { omitUndefined } from '@enbox/common';
import { resolveSyncConnectivityState } from '@enbox/agent';

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
 * - `'disconnected'` — no active session. This is also the resting phase after a
 *   **denied** connect: denial is a user decision, not a failure, so the store
 *   returns here with {@link ConnectionSnapshot.error} set to the `ConnectDeniedError`.
 * - `'connecting'` — a connect, vault-connect, or refresh flow is in flight,
 *   or a replacement session is completing application readiness.
 * - `'connected'` — an active, application-ready session exists; `session`,
 *   `enbox`, and the identity fields are populated.
 * - `'error'` — the last action failed for a reason other than denial and no
 *   application-ready session is exposed; `error` carries the failure.
 */
export type ConnectionPhase =
  | 'initializing'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

type SyncStatusContents = Readonly<{
  /** Aggregate connectivity across the selected identity's current replication links. */
  connectivity: SyncConnectivityState;

  /** Latest activity timestamp already recorded by the sync engine, when available. */
  lastActivityAt?: string;
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

  /** The {@link Enbox} instance bound to the active session. Populated while `phase` is `'connected'`. */
  enbox?: Enbox;

  /** The connected identity's DID URI. Populated while `phase` is `'connected'`. */
  identityDid?: string;

  /** The connected identity's display name, when one is set. */
  identityName?: string;

  /** Overall sync status for the connected identity. Cleared when the session ends. */
  sync?: SyncStatusSnapshot;

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
   * Whether delegated grants have expired or been revoked, or the wallet's
   * protocol configuration is missing or incompatible, so continuing requires
   * fresh wallet approval. Use {@link ConnectionStore.refresh} while a session
   * survives, or {@link ConnectionStore.connect} after it has ended. Cleared
   * when a session (re)connects or an `'active'` connection status is observed.
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
  [Key in 'protocols' | Exclude<keyof VaultConnectOptions, keyof HandlerConnectOptions>]?: never;
};

/** Refresh options for a manifest-backed store, whose protocols come only from the manifest. */
export type ApplicationConnectionStoreRefreshOptions = Omit<RefreshOptions, 'protocols'> & {
  protocols?: never;
};

/**
 * Options shared by plain and manifest-backed connection stores.
 *
 * Extends `AuthManagerOptions` — everything the store does not consume itself
 * (`connectHandler`, `sync`, `storage`, `password`, …) is forwarded verbatim
 * to `AuthManager.create()` during the first action.
 */
type ConnectionStoreSharedOptions = AuthManagerOptions & {
  /**
   * A pre-built `AuthManager` to drive instead of creating one.
   *
   * When provided, all `AuthManagerOptions` fields are ignored and the caller
   * keeps ownership: {@link ConnectionStore.dispose} will not shut the
   * manager down. When omitted, the store creates its manager lazily on the
   * first action and owns it — unless `agent` is supplied, in which case the
   * caller keeps the agent's lifecycle (matching `Enbox.connect()` ownership
   * semantics) and `dispose()` leaves the manager running.
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

  publishProtocols?: never;
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
  publishProtocols?: boolean;
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
 *
 * While an action is in flight, additional `initialize`/`connect`/
 * `connectVault`/`refresh` calls do not start a second auth flow; they return
 * the in-flight action's resulting snapshot. `disconnect()` is exempt so it
 * can supersede (invalidate) an in-flight connect.
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
   * `'connected'`; a readiness failure keeps the replacement unpublished.
   * Both outcomes are surfaced via `error`.
   */
  refresh(options: RefreshOptions): Promise<ConnectionSnapshot>;

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

/** Normalizes an unknown thrown value into an `Error`. */
function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Whether readiness rejected a delegated definition that needs fresh wallet approval. */
function requiresWalletReapproval(error: Error): boolean {
  return error instanceof ProtocolReadinessError &&
    error.cause instanceof WalletReapprovalRequiredError;
}

type SyncStatusBinding = {
  hasBeenReady: boolean;
  onAbort: () => void;
  refreshRequested: boolean;
  refreshing: boolean;
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
  private readonly _providedAuth?: AuthManager;
  private readonly _monitor: Exclude<ConnectionStoreOptions['monitor'], undefined>;
  private readonly _publishProtocols: boolean;
  private readonly _restore?: RestoreSessionOptions;
  private readonly _listeners = new Set<ConnectionSnapshotListener>();
  private readonly _unsubscribers: (() => void)[] = [];

  private _auth?: AuthManager;
  private _ownsAuth = false;
  private _snapshot: ConnectionSnapshot = Object.freeze<ConnectionSnapshot>({ phase: 'initializing' });
  private _stopMonitor?: () => void;
  private _pendingAction?: Promise<ConnectionSnapshot>;
  private _pendingAuthCreation?: Promise<AuthManager>;
  private _initialized = false;
  private _disposed = false;
  private _actionGeneration = 0;
  private _syncBinding?: SyncStatusBinding;

  public constructor(options: ConnectionStoreOptions) {
    const { application, auth, monitor, publishProtocols, restore, ...authManagerOptions } = options;
    if (application?.protocols.length === 0) {
      throw new TypeError('[@enbox/api] createConnectionStore requires at least one application protocol.');
    }
    this._application = application;
    this._providedAuth = auth;
    this._monitor = monitor ?? {};
    this._publishProtocols = publishProtocols ?? false;
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
    return this._track(this._runInitialize());
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

  public disconnect(options?: DisconnectOptions): Promise<ConnectionSnapshot> {
    this._assertNotDisposed();
    return this._track(this._runDisconnect(options));
  }

  public async dispose(): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._actionGeneration++;
    this._stopDelegateMonitor();
    this._unbindSyncStatus();

    for (const unsubscribe of this._unsubscribers) {
      unsubscribe();
    }
    this._unsubscribers.length = 0;
    this._listeners.clear();
    // Clear the stored status without publishing a teardown notification.
    this._apply({ sync: undefined });

    const auth = this._auth;
    this._auth = undefined;
    if (auth !== undefined && this._ownsAuth) {
      try {
        await auth.shutdown();
      } catch (cause: unknown) {
        console.warn('[@enbox/api] ConnectionStore.dispose: AuthManager.shutdown() failed', cause);
      }
    }
  }

  // ─── Actions ───────────────────────────────────────────────────

  /** Registers `action` as the pending action until it settles. */
  private _track(action: Promise<ConnectionSnapshot>): Promise<ConnectionSnapshot> {
    this._pendingAction = action;
    // Action promises never reject (failures land in the snapshot), so the
    // derived cleanup promise cannot produce an unhandled rejection.
    void action.finally((): void => {
      if (this._pendingAction === action) {
        this._pendingAction = undefined;
      }
    });
    return action;
  }

  /** Single-flight entry point shared by `connect`, `connectVault`, and `refresh`. */
  private _startConnectFlow(flow: (auth: AuthManager) => Promise<AuthSession>): Promise<ConnectionSnapshot> {
    this._assertNotDisposed();
    if (this._pendingAction !== undefined) {
      return this._pendingAction;
    }
    return this._track(this._runConnectFlow(flow));
  }

  private async _runInitialize(): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    this._apply({ error: undefined, phase: 'initializing' });

    try {
      const auth = await this._ensureAuth(generation);
      const session = await auth.restoreSession(this._restore);
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }

      if (session === undefined) {
        this._initialized = true;
        return this._apply({
          ...CLEARED_SESSION_FIELDS,
          phase       : 'disconnected',
          vaultLocked : auth.state === 'locked',
        });
      }
      const snapshot = await this._commitConnected(auth, generation);
      if (!this._isStale(generation)) {
        this._initialized = true;
      }
      return snapshot;
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      return this._applyActionFailure(generation, cause);
    }
  }

  private async _runConnectFlow(flow: (auth: AuthManager) => Promise<AuthSession>): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    this._apply({ error: undefined, phase: 'connecting' });

    try {
      const auth = await this._ensureAuth(generation);
      await flow(auth);
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }

      const snapshot = await this._commitConnected(auth, generation);
      // A completed, ready connect implies the store is bootstrapped — a
      // later initialize() must not re-run restore over the live session.
      if (!this._isStale(generation)) {
        this._initialized = true;
      }
      return snapshot;
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      return this._applyActionFailure(generation, cause);
    }
  }

  private async _runDisconnect(options?: DisconnectOptions): Promise<ConnectionSnapshot> {
    const generation = ++this._actionGeneration;
    this._stopDelegateMonitor();

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
      return this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'disconnected' });
    } catch (cause: unknown) {
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }
      return this._applyActionFailure(generation, cause);
    }
  }

  // ─── Outcome mapping ───────────────────────────────────────────

  /** Apply and seed the authoritative session, repeating if auth changes while status is read. */
  private async _commitConnected(auth: AuthManager, generation: number): Promise<ConnectionSnapshot> {
    // This cannot spin without yielding: each continuation requires a distinct
    // external session replacement during an awaited readiness or status read.
    // Capping it could publish a session the manager has already replaced.
    while (!this._isStale(generation)) {
      const activeSession = auth.session;
      if (activeSession === undefined || activeSession.signal.aborted) {
        return this._publishDisconnected();
      }
      if (this._snapshot.session !== undefined && this._snapshot.session !== activeSession) {
        // Auth aborts the previous lifetime before publishing its replacement.
        // Do not expose that dead session while the replacement is readied.
        this._stopDelegateMonitor();
        this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'connecting' });
      }

      const patch = this._connectedPatch(activeSession);
      const readinessError = this._application === undefined
        ? undefined
        : await this._getApplicationReadinessError(patch.enbox, this._application);

      if (this._isStale(generation)) {
        return this._snapshot;
      }
      const readySession = auth.session;
      if (readySession === undefined || readySession.signal.aborted) {
        return this._publishDisconnected();
      }
      if (readySession !== activeSession) {
        continue;
      }
      if (readinessError !== undefined) {
        this._stopDelegateMonitor();
        // Forget a stale delegated approval so the next connect reaches the
        // wallet instead of restoring it. Other readiness failures retain the
        // underlying session so a retry can recover from a transient outage.
        if (requiresWalletReapproval(readinessError)) {
          // The lifetime is already aborted if cleanup fails; keep the
          // actionable readiness outcome while making that failure visible.
          await auth.disconnect({ clearStorage: false }).catch((cleanupError: unknown): void => {
            console.warn('[@enbox/api] ConnectionStore: failed to clean up a rejected delegate session:', cleanupError);
          });
        }
        throw readinessError;
      }

      this._apply(patch);
      this._restartMonitor(auth, activeSession);
      await this._seedConnectionStatus(auth, activeSession, generation);

      if (this._isStale(generation)) {
        return this._snapshot;
      }

      const authoritativeSession = auth.session;
      if (authoritativeSession === activeSession && !activeSession.signal.aborted) {
        return this._snapshot;
      }
      if (authoritativeSession === undefined || authoritativeSession.signal.aborted) {
        return this._publishDisconnected();
      }
    }

    return this._snapshot;
  }

  /** Run the existing readiness lifecycle while keeping its failure behind the session fence. */
  private async _getApplicationReadinessError(
    enbox: Enbox,
    application: ApplicationManifest,
  ): Promise<Error | undefined> {
    try {
      await enbox.protocols.ensureReady({ application, publish: this._publishProtocols });
      return undefined;
    } catch (cause: unknown) {
      return toError(cause);
    }
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
    if (error instanceof ProtocolReadinessError) {
      const walletReapprovalRequired = requiresWalletReapproval(error)
        ? true
        : undefined;
      return this._apply({
        ...CLEARED_SESSION_FIELDS,
        error,
        phase: walletReapprovalRequired ? 'disconnected' : 'error',
        walletReapprovalRequired,
      });
    }

    const survivingSession = this._auth?.session;
    if (survivingSession !== undefined && !survivingSession.signal.aborted) {
      if (this._snapshot.session === survivingSession) {
        return this._apply({ error, phase: 'connected' });
      }
      if (this._application === undefined) {
        // The store missed this session (it was established outside the
        // store's own actions) — rebuild the connected fields around it.
        return this._apply({ ...this._connectedPatch(survivingSession), error });
      }
    }

    if (isConnectDeniedError(error)) {
      return this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'disconnected', error });
    }

    return this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'error', error });
  }

  // ─── AuthManager wiring ────────────────────────────────────────

  /**
   * Whether {@link dispose} should shut the `AuthManager` down. Mirrors the
   * `Enbox.connect()` ownership rule: the store owns the manager only when it
   * created it AND built the underlying agent itself — a caller-supplied
   * `auth` or `agent` keeps its lifecycle with the caller (shutting the
   * manager down would lock the caller's agent vault).
   */
  private get _wouldOwnAuth(): boolean {
    return this._providedAuth === undefined && this._authManagerOptions.agent === undefined;
  }

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
        if (this._auth === undefined && this._wouldOwnAuth) {
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
    this._ownsAuth = this._wouldOwnAuth;
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
        this._apply({ sync: undefined, vaultLocked: true });
      }),
      auth.on('vault-unlocked', (): void => { this._apply({ vaultLocked: false }); }),
    );
  }

  /** Reconciles a manager lifecycle wake against its authoritative active session. */
  private _onSessionChange(auth: AuthManager): void {
    if (this._pendingAction !== undefined) {
      return;
    }

    const session = auth.session;
    if (session === undefined) {
      this._publishDisconnected();
      return;
    }
    const generation = this._actionGeneration;
    void this._commitConnected(auth, generation).catch((cause: unknown): void => {
      if (this._isStale(generation)) {
        return;
      }
      const error = toError(cause);
      if (error instanceof ProtocolReadinessError) {
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
    let walletReapprovalRequired = this._snapshot.walletReapprovalRequired;
    if (connection.state === 'expired' || connection.state === 'revoked') {
      walletReapprovalRequired = true;
    } else if (connection.state === 'active') {
      walletReapprovalRequired = undefined;
    }
    this._apply({ connection, walletReapprovalRequired });
  }

  // ─── Sync status ────────────────────────────────────────────────

  /** Replace the session-scoped observer and return its fresh status snapshot. */
  private _bindSyncStatus(session: AuthSession | undefined): SyncStatusSnapshot | undefined {
    this._unbindSyncStatus();
    if (session === undefined || session.signal.aborted) {
      return undefined;
    }

    const binding: SyncStatusBinding = {
      hasBeenReady     : false,
      onAbort          : (): void => { this._handleSyncAbort(binding); },
      refreshRequested : false,
      refreshing       : false,
      session,
    };
    this._syncBinding = binding;
    session.signal.addEventListener('abort', binding.onAbort, { once: true });
    binding.unsubscribe = session.agent.sync.on((event): void => {
      if (event.tenantDid !== session.did) {
        return;
      }
      if (event.type === 'identity:registration-change' && event.options !== undefined) {
        binding.hasBeenReady = false;
      }
      this._requestSyncStatus(binding);
    });
    this._requestSyncStatus(binding);

    return immutableSyncStatus({ state: 'loading', connectivity: 'unknown' });
  }

  private _handleSyncAbort(binding: SyncStatusBinding): void {
    if (this._syncBinding !== binding) {
      return;
    }
    this._unbindSyncStatus();
    if (!this._disposed) {
      this._apply({ sync: undefined });
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
  private _requestSyncStatus(binding: SyncStatusBinding): void {
    if (this._syncBinding !== binding) {
      return;
    }

    binding.refreshRequested = true;
    if (binding.refreshing) {
      return;
    }

    binding.refreshing = true;
    void this._drainSyncStatus(binding);
  }

  private async _drainSyncStatus(binding: SyncStatusBinding): Promise<void> {
    try {
      while (this._syncBinding === binding && binding.refreshRequested) {
        binding.refreshRequested = false;
        const snapshot = await this._readSyncStatus(binding);
        if (this._syncBinding !== binding || binding.refreshRequested) {
          continue;
        }
        // A superseded baseline was never published, so it must not make later state stale.
        if (snapshot.state === 'ready') {
          binding.hasBeenReady = true;
        }
        this._publishSyncStatus(binding, snapshot);
      }
    } finally {
      binding.refreshing = false;
    }
  }

  private async _readSyncStatus(binding: SyncStatusBinding): Promise<SyncStatusSnapshot> {
    const { session } = binding;
    try {
      const registration = await session.agent.sync.getIdentityOptions(session.did);
      if (registration === undefined) {
        return immutableSyncStatus({ state: 'ready', connectivity: 'unknown' });
      }
      const links = await session.agent.sync.getReplicationLinks(session.did);
      return projectSyncStatus(links, binding.hasBeenReady, session.agent.sync.connectivityState);
    } catch (cause: unknown) {
      const current = this._snapshot.sync;
      return immutableSyncStatus({
        state          : 'error',
        connectivity   : current?.connectivity ?? 'unknown',
        lastActivityAt : current?.lastActivityAt,
        error          : toError(cause),
      });
    }
  }

  private _publishSyncStatus(binding: SyncStatusBinding, snapshot: SyncStatusSnapshot): void {
    if (this._syncBinding !== binding || syncStatusesEqual(this._snapshot.sync, snapshot)) {
      return;
    }
    this._apply({ sync: snapshot });
  }

  // ─── Snapshot plumbing ─────────────────────────────────────────

  /**
   * Applies a patch to the snapshot. When nothing changed (shallow equality)
   * the current snapshot is kept — same reference, no notification.
   */
  private _apply(patch: Partial<ConnectionSnapshot>): ConnectionSnapshot {
    const next: ConnectionSnapshot = { ...this._snapshot, ...patch };
    if (next.session !== this._snapshot.session) {
      // A changed session also guarantees snapshot inequality, so this binding reaches publication.
      next.sync = this._bindSyncStatus(next.session);
    }
    if (snapshotsEqual(this._snapshot, next)) {
      return this._snapshot;
    }

    this._snapshot = Object.freeze(next);
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
  hasBeenReady: boolean,
  fallbackConnectivity: SyncConnectivityState,
): SyncStatusSnapshot {
  const connectivity = resolveSyncConnectivityState(
    links.map((link): SyncConnectivityState => link.connectivity),
    fallbackConnectivity,
  );
  const lastActivityAt = latestActivityAt(links);
  const state = projectReplicationCurrentness(links, hasBeenReady);
  if (state === 'error') {
    return immutableSyncStatus({
      state : 'error',
      connectivity,
      lastActivityAt,
      error : new Error('Synchronization is paused for the selected identity.'),
    });
  }
  return immutableSyncStatus({
    state,
    connectivity,
    lastActivityAt,
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
  return Object.freeze(snapshot);
}

function syncStatusesEqual(a: SyncStatusSnapshot | undefined, b: SyncStatusSnapshot): boolean {
  return a?.state === b.state &&
    a.connectivity === b.connectivity &&
    a.lastActivityAt === b.lastActivityAt &&
    a.error?.message === b.error?.message;
}

/**
 * Creates a framework-agnostic, subscribable {@link ConnectionStore}.
 *
 * The store is created synchronously (safe at module scope); the
 * `AuthManager` is built lazily by the first action. A typical app creates
 * one store for its lifetime, calls {@link ConnectionStore.initialize} once
 * on boot, and binds its UI to `subscribe`/`getSnapshot`.
 *
 * @param options - `AuthManagerOptions` plus store-specific fields
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
