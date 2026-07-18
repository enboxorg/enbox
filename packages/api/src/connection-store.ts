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

import type {
  AuthManagerOptions,
  AuthSessionInfo,
  ConnectionMonitorOptions,
  ConnectionStatus,
  ConnectOptions,
  DisconnectOptions,
  GetConnectionStatusOptions,
  RefreshOptions,
  RestoreSessionOptions,
  VaultConnectOptions,
} from '@enbox/auth';

import { AuthManager } from '@enbox/auth/auth-manager';
import { omitUndefined } from '@enbox/common';
import { AuthSession, isConnectDeniedError } from '@enbox/auth';

import { Enbox } from './enbox.js';

/**
 * The lifecycle phase of the connection store.
 *
 * - `'initializing'` — the store has been created but {@link ConnectionStore.initialize}
 *   has not completed yet (or is re-running after a failed bootstrap).
 * - `'disconnected'` — no active session. This is also the resting phase after a
 *   **denied** connect: denial is a user decision, not a failure, so the store
 *   returns here with {@link ConnectionSnapshot.error} set to the `ConnectDeniedError`.
 * - `'connecting'` — a connect, vault-connect, or refresh flow is in flight.
 * - `'connected'` — an active session exists; `session`, `enbox`, and the
 *   identity fields are populated.
 * - `'error'` — the last action failed for a reason other than denial and no
 *   active session survived it; `error` carries the failure.
 */
export type ConnectionPhase =
  | 'initializing'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

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
   * Whether the delegated session's grants have expired or been revoked, so
   * continuing requires a fresh wallet approval ({@link ConnectionStore.refresh}
   * or {@link ConnectionStore.connect}). Cleared when a session (re)connects
   * or an `'active'` connection status is observed.
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

/**
 * Options for {@link createConnectionStore}.
 *
 * Extends `AuthManagerOptions` — everything the store does not consume itself
 * (`connectHandler`, `sync`, `storage`, `password`, …) is forwarded verbatim
 * to `AuthManager.create()` during the first action.
 */
export type ConnectionStoreOptions = AuthManagerOptions & {
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

  /**
   * Options for the delegated-connection monitor the store starts whenever a
   * wallet-delegated session connects, or `false` to disable monitoring.
   * Defaults to `{}` (the `AuthManager` polling defaults).
   */
  monitor?: ConnectionMonitorOptions | false;

  /** Options forwarded to `AuthManager.restoreSession()` during {@link ConnectionStore.initialize}. */
  restore?: RestoreSessionOptions;
};

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
   */
  connect(options?: ConnectOptions): Promise<ConnectionSnapshot>;

  /** Runs `AuthManager.connectVault()` — the explicit local HD-vault flow. */
  connectVault(options?: VaultConnectOptions): Promise<ConnectionSnapshot>;

  /**
   * Runs `AuthManager.refresh()` to re-grant the current delegated session.
   * On success the reapproval flag clears and the connection status reseeds.
   * A denied or failed refresh keeps the surviving session `'connected'`
   * and surfaces the outcome via `error`.
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

/** Snapshot patch that clears every session-derived field. */
const CLEARED_SESSION_FIELDS = {
  connection               : undefined,
  enbox                    : undefined,
  error                    : undefined,
  identityDid              : undefined,
  identityName             : undefined,
  session                  : undefined,
  walletReapprovalRequired : undefined,
} as const;

/** Every key of {@link ConnectionSnapshot}, for shallow change detection. */
const SNAPSHOT_KEYS: readonly (keyof ConnectionSnapshot)[] = [
  'phase',
  'session',
  'enbox',
  'identityDid',
  'identityName',
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
 * of actions those events let the store follow auth flows driven directly on
 * the underlying `AuthManager`.
 */
class HeadlessConnectionStore implements ConnectionStore {
  private readonly _authManagerOptions: AuthManagerOptions;
  private readonly _providedAuth?: AuthManager;
  private readonly _monitor: ConnectionMonitorOptions | false;
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

  public constructor(options: ConnectionStoreOptions) {
    const { auth, monitor, restore, ...authManagerOptions } = options;
    this._providedAuth = auth;
    this._monitor = monitor ?? {};
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
    return this._startConnectFlow((auth: AuthManager): Promise<AuthSession> => auth.connect(options));
  }

  public connectVault(options?: VaultConnectOptions): Promise<ConnectionSnapshot> {
    return this._startConnectFlow((auth: AuthManager): Promise<AuthSession> => auth.connectVault(options));
  }

  public refresh(options: RefreshOptions): Promise<ConnectionSnapshot> {
    return this._startConnectFlow((auth: AuthManager): Promise<AuthSession> => auth.refresh(options));
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

    for (const unsubscribe of this._unsubscribers) {
      unsubscribe();
    }
    this._unsubscribers.length = 0;
    this._listeners.clear();

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

      this._initialized = true;
      if (session === undefined) {
        return this._apply({
          ...CLEARED_SESSION_FIELDS,
          phase       : 'disconnected',
          vaultLocked : auth.state === 'locked',
        });
      }
      return await this._commitConnected(auth, session, generation);
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
      const session = await flow(auth);
      if (this._isStale(generation)) {
        return this._settleSuperseded();
      }

      // A completed connect implies the store is bootstrapped — a later
      // initialize() (e.g. a boot effect firing after an eager connect)
      // must not re-run session restore over the live session.
      this._initialized = true;
      return await this._commitConnected(auth, session, generation);
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

  /** Applies the connected snapshot, restarts the monitor, and seeds the delegated status. */
  private async _commitConnected(auth: AuthManager, session: AuthSession, generation: number): Promise<ConnectionSnapshot> {
    this._apply(this._connectedPatch(session));
    this._restartMonitor(auth, session);
    await this._seedConnectionStatus(auth, session, generation);
    return this._snapshot;
  }

  /** Builds the snapshot patch for a connected session, reusing the current `Enbox` when unchanged. */
  private _connectedPatch(session: AuthSession): Partial<ConnectionSnapshot> {
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
   * - An active auth session that survived the failed action (e.g. a denied
   *   or failed refresh) keeps the store `'connected'`, with `error` set.
   * - A denial without a surviving session rests at `'disconnected'` —
   *   denial is a user decision, not a failure phase.
   * - Anything else is a real failure: phase `'error'`.
   */
  private _applyActionFailure(generation: number, cause: unknown): ConnectionSnapshot {
    if (this._isStale(generation)) {
      return this._snapshot;
    }

    const error = toError(cause);
    const survivingSession = this._auth?.session;
    if (survivingSession !== undefined) {
      if (this._snapshot.session === survivingSession) {
        return this._apply({ error, phase: 'connected' });
      }
      // The store missed this session (it was established outside the store's
      // own actions) — rebuild the connected fields around it.
      return this._apply({ ...this._connectedPatch(survivingSession), error });
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
      auth.on('session-start', ({ session }): void => { this._onSessionStart(auth, session); }),
      auth.on('session-end', (): void => { this._onSessionEnd(); }),
      auth.on('connection-expiring', ({ status }): void => { this._applyConnectionStatus(status); }),
      auth.on('connection-expired', ({ status }): void => { this._applyConnectionStatus(status); }),
      auth.on('vault-locked', (): void => { this._apply({ vaultLocked: true }); }),
      auth.on('vault-unlocked', (): void => { this._apply({ vaultLocked: false }); }),
    );
  }

  /**
   * Follows a session started directly on the `AuthManager` (outside the
   * store's own actions, e.g. `auth.switchIdentity()`); the event payload is
   * used when the manager has not installed the session object yet.
   */
  private _onSessionStart(auth: AuthManager, info: AuthSessionInfo): void {
    if (this._pendingAction !== undefined) {
      return;
    }

    const managed = auth.session;
    const session = managed !== undefined && managed.did === info.did && managed.delegateDid === info.delegateDid
      ? managed
      : new AuthSession({ agent: auth.agent, did: info.did, delegateDid: info.delegateDid, identity: info.identity });
    const generation = this._actionGeneration;
    void this._commitConnected(auth, session, generation).catch((cause: unknown): void => {
      console.error('[@enbox/api] ConnectionStore: failed to apply an externally started session:', cause);
    });
  }

  /** Follows a session ended outside the store's own actions (`auth.lock()`, external disconnect, shutdown). */
  private _onSessionEnd(): void {
    this._stopDelegateMonitor();
    if (this._pendingAction !== undefined) {
      return;
    }
    this._apply({ ...CLEARED_SESSION_FIELDS, phase: 'disconnected' });
  }

  // ─── Delegated connection status ───────────────────────────────

  private _restartMonitor(auth: AuthManager, session: AuthSession): void {
    this._stopDelegateMonitor();
    if (this._monitor === false || session.delegateDid === undefined) {
      return;
    }
    this._stopMonitor = auth.startConnectionMonitor(this._monitor);
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
      if (this._isStale(generation) || this._snapshot.session !== session) {
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

  // ─── Snapshot plumbing ─────────────────────────────────────────

  /**
   * Applies a patch to the snapshot. When nothing changed (shallow equality)
   * the current snapshot is kept — same reference, no notification.
   */
  private _apply(patch: Partial<ConnectionSnapshot>): ConnectionSnapshot {
    const next: ConnectionSnapshot = { ...this._snapshot, ...patch };
    if (snapshotsEqual(this._snapshot, next)) {
      return this._snapshot;
    }

    this._snapshot = Object.freeze(next);
    for (const listener of [...this._listeners]) {
      try {
        listener(this._snapshot);
      } catch (cause: unknown) {
        console.error('[@enbox/api] ConnectionStore: error in snapshot listener:', cause);
      }
    }
    return this._snapshot;
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
export function createConnectionStore(options: ConnectionStoreOptions = {}): ConnectionStore {
  return new HeadlessConnectionStore(options);
}
