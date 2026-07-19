/**
 * AuthManager — the primary entry point for `@enbox/auth`.
 *
 * Replaces `Enbox.connect()` (formerly `Web5.connect()`) with a composable,
 * multi-identity-aware auth system that works in both browser and CLI environments.
 *
 * NOTE: this file is also exposed as the `@enbox/auth/auth-manager` subpath
 * export so `@enbox/api` can import the AuthManager class without pulling in
 * the full barrel. The subpath is **internal to the monorepo** — external
 * consumers should import from `@enbox/auth` (or `@enbox/browser`) instead;
 * the subpath's file layout is not part of any stability guarantee.
 *
 * @internal
 * @module
 */

import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { AgentSessionIdentity, BearerIdentity, DwnDataEncodedRecordsWriteMessage, HdIdentityVault, PortableIdentity } from '@enbox/agent';

import type { FlowContext } from './connect/lifecycle.js';
import type { PasswordProvider } from './password-provider.js';
import type {
  AuthEvent,
  AuthEventHandler,
  AuthManagerOptions,
  AuthState,
  ConnectHandler,
  ConnectionMonitorOptions,
  ConnectionStatus,
  ConnectOptions,
  DisconnectOptions,
  GetConnectionStatusOptions,
  HandlerConnectOptions,
  HeadlessConnectOptions,
  IdentitySyncProtocols,
  ImportFromPortableOptions,
  LocalNodeEjectOptions,
  LocalNodeEjectResult,
  RefreshOptions,
  RegistrationOptions,
  RestoreFromPhraseOptions,
  RestoreSessionOptions,
  ShutdownOptions,
  StorageAdapter,
  SyncOption,
  VaultConnectOptions,
  WalletConnectOptions,
} from './types.js';
import type {
  LocalDwnPairingRecord,
  LocalDwnPairingRequestResult,
  LocalDwnProbeResult,
} from './discovery.js';

import { Convert } from '@enbox/common';
import { DataStream } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant, EnboxUserAgent } from '@enbox/agent';

import { AuthEventEmitter } from './events.js';
import { AuthSession } from './identity-session.js';
import { ConnectDeniedError } from './errors.js';
import { createDefaultStorage } from './storage/storage.js';
import { importFromPortable } from './connect/import.js';
import { normalizeProtocolRequests } from './permissions.js';
import { restoreSession } from './connect/restore.js';
import { STORAGE_KEYS } from './types.js';
import { validateConnectResultGrants } from './connect/validate-grants.js';
import { vaultConnect } from './connect/vault.js';
import { walletConnect } from './connect/wallet.js';
import {
  clearLocalDwnEjection,
  createLocalDwnRpcClient,
  discoverLocalDwnPairing,
  persistLocalDwnEjectionRecord,
  probeLocalDwn,
  readLocalDwnEjectionRecordForPairing,
  requestLocalDwnPairing,
} from './discovery.js';
import { computeConnectionStatus, reconcileConnectionStatusGrants } from './connect/status.js';
import { deriveActiveSyncScope, ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, processDelegateGrantsForExistingIdentity, resolveIdentityDids, resolvePassword, startSyncIfEnabled, toSyncIdentityProtocols } from './connect/lifecycle.js';

type ConnectionMonitorState = {
  options: ConnectionMonitorOptions;
  lastStatusKey?: string;
  timer?: ReturnType<typeof setInterval>;
  isPolling: boolean;
  autoRefreshAttempts: Set<string>;
};

type ConnectionAttemptGuard = {
  lifecycleGeneration: number;
  monitor?: ConnectionMonitorState;
};

/**
 * The primary entry point for authentication and identity management.
 *
 * `AuthManager` replaces `Enbox.connect()` (formerly `Web5.connect()`) with a composable, multi-identity-aware
 * system. It manages vault lifecycle, identity CRUD, session persistence,
 * and all connection flows (local DID, wallet connect, import, restore).
 *
 * @example Basic usage
 * ```ts
 * import { AuthManager } from '@enbox/auth';
 *
 * const auth = await AuthManager.create();
 *
 * // First time: creates a new identity
 * // Subsequent times: restores the previous session
 * const session = await auth.restoreSession() ?? await auth.connectVault({ createIdentity: true });
 *
 * // session.agent  — the authenticated Enbox agent
 * // session.did    — the connected DID URI
 * // session.identity — metadata about the connected identity
 * ```
 *
 * @example Wallet connect
 * ```ts
 * const session = await auth.walletConnect({
 *   displayName: 'My App',
 *   connectServerUrl: 'https://enbox-dwn.fly.dev/connect',
 *   permissionRequests: [{ protocolDefinition: MyProtocol.definition }],
 *   onWalletUriReady: (uri) => showQRCode(uri),
 *   validatePin: () => promptUserForPin(),
 * });
 * ```
 */
export class AuthManager {
  private readonly _userAgent: EnboxUserAgent;
  private readonly _emitter: AuthEventEmitter;
  private readonly _storage: StorageAdapter;
  private _session: AuthSession | undefined;
  private _state: AuthState = 'uninitialized';
  private _isConnecting = false;
  private _isShutDown = false;
  private _isShuttingDown = false;
  private _connectionMonitor?: ConnectionMonitorState;
  private _lifecycleGeneration = 0;
  private _lifecycleCommitTail: Promise<void> = Promise.resolve();
  private _shutdownPromise?: Promise<void>;

  // Default options from create()
  private readonly _defaultPassword?: string;
  private readonly _passwordProvider?: PasswordProvider;
  private readonly _defaultSync?: SyncOption;
  private readonly _defaultIdentitySyncProtocols?: IdentitySyncProtocols;
  private readonly _defaultDwnEndpoints?: string[];
  private readonly _registration?: RegistrationOptions;
  private readonly _connectHandler?: ConnectHandler;

  /**
   * The local DWN server endpoint discovered during `create()`, if any.
   * `undefined` means no local server was found. This is set before any
   * event listeners are attached, so consumers should check this property
   * after `create()` returns rather than relying solely on events.
   */
  private _localDwnEndpoint?: string;
  private _localDwnPairing?: LocalDwnPairingRecord;

  private constructor(params: {
    userAgent: EnboxUserAgent;
    emitter: AuthEventEmitter;
    storage: StorageAdapter;
    defaultPassword?: string;
    passwordProvider?: PasswordProvider;
    defaultSync?: SyncOption;
    defaultIdentitySyncProtocols?: IdentitySyncProtocols;
    defaultDwnEndpoints?: string[];
    registration?: RegistrationOptions;
    localDwnEndpoint?: string;
    localDwnPairing?: LocalDwnPairingRecord;
    connectHandler?: ConnectHandler;
  }) {
    this._userAgent = params.userAgent;
    this._emitter = params.emitter;
    this._storage = params.storage;
    this._defaultPassword = params.defaultPassword;
    this._passwordProvider = params.passwordProvider;
    this._defaultSync = params.defaultSync;
    this._defaultIdentitySyncProtocols = params.defaultIdentitySyncProtocols;
    this._defaultDwnEndpoints = params.defaultDwnEndpoints;
    this._registration = params.registration;
    this._localDwnEndpoint = params.localDwnEndpoint;
    this._localDwnPairing = params.localDwnPairing;
    this._connectHandler = params.connectHandler;
  }

  /**
   * Create a new AuthManager instance.
   *
   * When a pre-built `agent` is provided, it is used as-is and
   * `dataPath`, `agentVault`, and `localDwnStrategy` are ignored.
   * Otherwise, a new `EnboxUserAgent` is created with the given options.
   *
   * @param options - Configuration options for the auth manager.
   * @returns A ready-to-use AuthManager instance.
   */
  static async create(options: AuthManagerOptions = {}): Promise<AuthManager> {
    const emitter = new AuthEventEmitter();
    const storage = options.storage ?? createDefaultStorage();

    // Run local DWN discovery BEFORE creating the agent. Discovery has
    // zero vault/DWN dependencies — it reads the persisted pairing record
    // and validates it via GET /info plus authenticated /local/status.
    //
    // A stored pairing alone is not enough to change the agent's storage mode:
    // pairing establishes trust, while the ejection marker proves the local
    // in-process DWN has drained to the paired node. Only then does the next
    // session boot in remote mode.
    let localDwnEndpoint: string | undefined;
    let localDwnPairing: LocalDwnPairingRecord | undefined;
    if (!options.agent && options.localDwnStrategy !== 'off') {
      localDwnPairing = await discoverLocalDwnPairing(storage);
      if (localDwnPairing !== undefined) {
        const ejection = await readLocalDwnEjectionRecordForPairing(storage, localDwnPairing);
        localDwnEndpoint = ejection === undefined ? undefined : localDwnPairing.endpoint;
      }
      // NOTE: We intentionally do NOT emit 'local-dwn-available' here
      // because event listeners aren't attached yet. Consumers should
      // check `authManager.localDwnEndpoint` after create() returns.
    }

    // Use a pre-built agent or create one with the given options.
    const userAgent = options.agent ?? await EnboxUserAgent.create({
      dataPath         : options.dataPath,
      agentVault       : options.agentVault,
      localDwnStrategy : options.localDwnStrategy,
      localDwnEndpoint,
      rpcClient        : localDwnEndpoint === undefined || localDwnPairing === undefined
        ? undefined
        : createLocalDwnRpcClient(localDwnPairing),
    });

    const manager = new AuthManager({
      userAgent,
      emitter,
      storage,
      defaultPassword              : options.password,
      passwordProvider             : options.passwordProvider,
      defaultSync                  : options.sync,
      defaultIdentitySyncProtocols : options.identitySyncProtocols,
      defaultDwnEndpoints          : options.dwnEndpoints,
      registration                 : options.registration,
      localDwnEndpoint,
      localDwnPairing,
      connectHandler               : options.connectHandler,
    });

    // Determine initial state.
    if (await userAgent.vault.isInitialized()) {
      manager._setState(userAgent.vault.isLocked() ? 'locked' : 'unlocked');
    } else {
      manager._setState('uninitialized');
    }

    return manager;
  }

  // ─── Connection flows ──────────────────────────────────────────

  /**
   * Connect to a wallet or create a local session.
   *
   * This is the primary entry point for dapps. It routes to the
   * appropriate flow based on the options:
   *
   * **Recovery phrase restore** (wallets / CLI): Explicitly restores or
   * re-unlocks a vault. Triggered first when `recoveryPhrase` is provided.
   *
   * **Handler-based connect** (dapps): Delegates credential acquisition
   * to a {@link ConnectHandler}. Triggered when `protocols` or
   * `connectHandler` is provided and no `recoveryPhrase` is present.
   *
   * **Local connect** (wallets / CLI): Creates or unlocks a local vault.
   * Triggered when `password`, `createIdentity`, or `recoveryPhrase`
   * is provided.
   *
   * `connect()` first attempts to restore a previous session unless a
   * recovery phrase is provided. Recovery is an explicit user action and
   * bypasses stored-session restore.
   *
   * @example Dapp (browser)
   * ```ts
   * import { BrowserConnectHandler } from '@enbox/browser';
   *
   * const auth = await AuthManager.create({
   *   connectHandler: BrowserConnectHandler(),
   * });
   * const session = await auth.connect({
   *   protocols: [NotesProtocol],
   * });
   * ```
   *
   * @example Wallet / CLI
   * ```ts
   * const session = await auth.connect({
   *   password: userPin,
   *   createIdentity: true,
   * });
   * ```
   *
   * @param options - Connection options. The shape determines the flow.
   * @returns An active AuthSession.
   * @throws If a connection attempt is already in progress.
   * @throws If handler-based connect is attempted without a handler.
   */
  async connect(options?: ConnectOptions): Promise<AuthSession> {
    return this._withConnect(async (guard) => {
      // Recovery is an explicit user action. Do not let a stale stored session intercept it.
      if (this._isPhraseRestore(options)) {
        return vaultConnect(this._flowContext(guard), options);
      }

      // 1. Try to restore a previous session first.
      const restored = await restoreSession(this._flowContext(guard));
      if (restored) { return restored; }
      this._assertConnectionAttemptActive(guard);

      // 2. Route to the appropriate flow. `_isVaultConnect` is a type guard
      // so the two branches receive correctly narrowed `options` types
      // without casts.
      if (this._isVaultConnect(options)) {
        return vaultConnect(this._flowContext(guard), options);
      }

      return this._handlerConnect(options, guard);
    });
  }

  /**
   * Create or reconnect an identity via the local HD vault.
   *
   * Use this when you explicitly want the vault flow, bypassing
   * auto-detection. This is the preferred method for wallet apps
   * and CLI tools that own the identity vault directly.
   *
   * @param options - Vault connect options.
   * @returns An active AuthSession.
   * @throws If a connection attempt is already in progress.
   */
  async connectVault(options?: VaultConnectOptions): Promise<AuthSession> {
    return this._withConnect((guard) => vaultConnect(this._flowContext(guard), options));
  }

  /**
   * Restore or re-unlock the local vault from a BIP-39 recovery phrase.
   *
   * - Fresh device: initializes the vault from the phrase and recovers remote identities.
   * - Same local vault: verifies the phrase matches, resets the local password, and preserves data.
   * - Different local vault: throws without clearing or replacing the existing vault.
   */
  async restoreFromPhrase(options: RestoreFromPhraseOptions): Promise<AuthSession> {
    return this._withConnect((guard) => vaultConnect(this._flowContext(guard), options));
  }

  /**
   * Connect to an external wallet via the Enbox Connect relay protocol.
   *
   * This runs the full WalletConnect flow: generates a URI for QR display,
   * validates the PIN, imports the delegated DID, and processes grants.
   *
   * @param options - Wallet connect configuration.
   * @returns An active AuthSession with delegated permissions.
   * @throws If sync is disabled (required for wallet connect).
   * @throws If a connection attempt is already in progress.
   */
  async walletConnect(options: WalletConnectOptions): Promise<AuthSession> {
    return this._withConnect((guard) => walletConnect(this._flowContext(guard), options));
  }

  /**
   * Import an identity from a PortableIdentity JSON object.
   *
   * The portable identity contains the DID's private keys and metadata.
   */
  async importFromPortable(options: ImportFromPortableOptions): Promise<AuthSession> {
    return this._withConnect((guard) => importFromPortable(this._flowContext(guard), options));
  }

  /**
   * Restore a previous session from persisted storage.
   *
   * Returns `undefined` if no previous session exists.
   * This replaces the manual `previouslyConnected` localStorage pattern.
   */
  async restoreSession(options?: RestoreSessionOptions): Promise<AuthSession | undefined> {
    this._guardShutdown();
    this._guardConcurrency();
    this._isConnecting = true;
    const guard: ConnectionAttemptGuard = {
      lifecycleGeneration: this._lifecycleGeneration,
    };

    try {
      const session = await restoreSession(this._flowContext(guard), options);
      return session;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Inspect the newest locally-visible delegated connect session.
   *
   * A session is considered locally complete only when its user-facing grant
   * IDs match in the owner and delegate partitions. Revocation detection is
   * best-effort: it diffs those grants against the active owner-partition set
   * visible after sync. Pass `checkRevoked: false` to skip that active query.
   */
  async getConnectionStatus(options: GetConnectionStatusOptions = {}): Promise<ConnectionStatus> {
    this._guardShutdown();

    const connectedDid = this._session?.did;
    const delegateDid = this._session?.delegateDid;
    if (connectedDid === undefined || delegateDid === undefined) {
      return { state: 'none' };
    }

    const fetchParams = {
      author  : delegateDid,
      grantee : delegateDid,
      grantor : connectedDid,
    };
    const [ownerGrantEntries, activeOwnerGrantEntries, delegateGrantEntries] = await Promise.all([
      this._userAgent.permissions.fetchGrants({ ...fetchParams, target: connectedDid }),
      options.checkRevoked === false
        ? Promise.resolve(undefined)
        : this._userAgent.permissions.fetchGrants({
          ...fetchParams,
          target       : connectedDid,
          checkRevoked : true,
        }),
      this._userAgent.permissions.fetchGrants({ ...fetchParams, target: delegateDid }),
    ]);
    const activeOwnerGrantIds = activeOwnerGrantEntries === undefined
      ? undefined
      : new Set(activeOwnerGrantEntries.map(({ grant }) => grant.id));

    const ownerGrants = ownerGrantEntries.map(({ grant }) => ({
      id             : grant.id,
      grantor        : grant.grantor,
      grantee        : grant.grantee,
      dateExpires    : grant.dateExpires,
      connectSession : grant.connectSession,
    }));
    const delegateGrants = delegateGrantEntries.map(({ grant }) => ({
      id             : grant.id,
      grantor        : grant.grantor,
      grantee        : grant.grantee,
      dateExpires    : grant.dateExpires,
      connectSession : grant.connectSession,
    }));
    const grants = reconcileConnectionStatusGrants({
      ownerGrants,
      delegateGrants,
      activeOwnerGrantIds,
    });

    return computeConnectionStatus(grants, {
      expiringSoonThresholdSeconds: options.expiringSoonThresholdSeconds,
    });
  }

  /**
   * Add fresh grants for the current delegated session's existing delegate DID.
   *
   * The delegate's local keys and identity record are reused. Prior grants
   * remain valid until they expire or are revoked; local revocation metadata,
   * sync scope, and session markers are updated for the new approval.
   */
  async refresh(options: RefreshOptions): Promise<AuthSession> {
    return this._refresh(options);
  }

  /**
   * Start opt-in polling for delegated connection expiry and revocation.
   *
   * Events are emitted only when the newest session enters a new state.
   * Automatic refresh is attempted at most once per session and state, and is
   * never attempted for a revoked session.
   *
   * @returns A function that stops this monitor instance.
   */
  startConnectionMonitor(options: ConnectionMonitorOptions = {}): () => void {
    this._guardShutdown();

    const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError('Connection monitor interval must be a positive finite number.');
    }

    this.stopConnectionMonitor();

    const monitor: ConnectionMonitorState = {
      options,
      isPolling           : false,
      autoRefreshAttempts : new Set<string>(),
    };
    monitor.timer = setInterval((): void => {
      void this._pollConnectionMonitor(monitor);
    }, intervalMs);
    this._connectionMonitor = monitor;
    void this._pollConnectionMonitor(monitor);

    return (): void => {
      if (this._connectionMonitor === monitor) {
        this.stopConnectionMonitor();
      }
    };
  }

  /** Stop the active delegated connection monitor, if any. */
  stopConnectionMonitor(): void {
    if (this._connectionMonitor?.timer !== undefined) {
      clearInterval(this._connectionMonitor.timer);
    }
    this._connectionMonitor = undefined;
  }

  /**
   * Lightweight vault unlock for one-shot utilities and subprocesses.
   *
   * Unlocks the vault and retrieves the active (or first available)
   * identity **without** starting sync, DWN registration, or persisting
   * session markers. This is the recommended replacement for calling
   * `agent.start({ password })` directly.
   *
   * Typical use cases:
   * - Git credential helpers that need to sign a token and exit
   * - CLI utilities that perform a single operation
   * - Any subprocess that shares a data directory with a long-running daemon
   *
   * @param options - Optional password override.
   * @returns An active AuthSession (with sync disabled).
   *
   * @example
   * ```ts
   * const session = await auth.connectHeadless({ password });
   * const did = session.did; // ready to use
   * await auth.shutdown();   // clean exit
   * ```
   */
  async connectHeadless(options?: HeadlessConnectOptions): Promise<AuthSession> {
    return this._withConnect(async (guard) => {
      let password = options?.password ?? this._defaultPassword;
      this._assertConnectionAttemptActive(guard);
      const isFirstLaunch = await this._userAgent.firstLaunch();
      this._assertConnectionAttemptActive(guard);

      // Try the password provider if no explicit password.
      if (!password && this._passwordProvider) {
        password = await this._passwordProvider.getPassword({
          reason: isFirstLaunch ? 'create' : 'unlock',
        });
      }

      if (!password) {
        throw new Error(
          '[@enbox/auth] connectHeadless() requires a password. ' +
          'Provide one via options.password, a passwordProvider, or the AuthManager default.'
        );
      }

      // Unlock the vault (initialise on first launch, always start).
      await this._runConnectionMutation(guard, () => ensureVaultReady({
        userAgent : this._userAgent,
        emitter   : this._emitter,
        password,
        isFirstLaunch,
      }));

      // Find the active identity.
      const identities = await this._userAgent.identity.list();
      if (identities.length === 0) {
        throw new Error('[@enbox/auth] No identities found in vault.');
      }

      // Prefer the previously-active identity, fall back to first.
      const savedDid = await this._storage.get(STORAGE_KEYS.ACTIVE_IDENTITY);
      const identity = (savedDid
        ? identities.find(id => id.did.uri === savedDid || id.metadata.connectedDid === savedDid)
        : undefined
      ) ?? identities[0];

      const { connectedDid, delegateDid } = resolveIdentityDids(identity);
      const identityInfo: AgentSessionIdentity = {
        didUri       : connectedDid,
        name         : identity.metadata.name,
        connectedDid : identity.metadata.connectedDid,
      };

      // No sync, registration, session markers, or lifecycle events.
      return this._commitConnectionResult(guard, async (): Promise<AuthSession> => new AuthSession({
        agent: this._userAgent, did: connectedDid, delegateDid, identity: identityInfo,
      }));
    });
  }

  // ─── Session management ────────────────────────────────────────

  /** The current active session, or `undefined` if not connected. */
  get session(): AuthSession | undefined {
    return this._session;
  }

  /**
   * Lock the auth manager.
   *
   * Stops sync, clears the active session, and locks the underlying vault
   * so the password must be provided again to resume. Session storage
   * markers are preserved so {@link restoreSession} can reconnect after
   * the vault is unlocked again.
   *
   * After locking, the state transitions to `'locked'`.
   *
   * @param options - Optional lock configuration.
   * @param options.timeout - Milliseconds to wait for sync to stop. Default: `2000`.
   */
  async lock(options: { timeout?: number } = {}): Promise<void> {
    if (this._isShuttingDown || this._isShutDown) {
      await this._shutdownPromise;
      return;
    }

    this._invalidateConnectionAttempts();
    this.stopConnectionMonitor();
    const releaseCommit = await this._acquireLifecycleCommit();
    try {
      await this._lock(options);
    } finally {
      releaseCommit();
    }
  }

  private async _lock(options: { timeout?: number }): Promise<void> {
    const { timeout = 2000 } = options;
    const did = this._session?.did;

    // 1. Stop sync.
    await this._userAgent.sync.stopSync(timeout);

    // 2. Clear the session (but keep storage markers for restore).
    this._session = undefined;

    // 3. Lock the vault.
    await this._userAgent.vault.lock();
    this._emitter.emit('vault-locked', {});

    // 4. Transition state.
    this._setState('locked');

    // 5. Emit session-end if there was an active session.
    if (did) {
      this._emitter.emit('session-end', { did });
    }
  }

  /**
   * Disconnect the current session.
   *
   * @param options - Disconnect options.
   * @param options.clearStorage - If `true`, performs a nuclear wipe:
   *   clears all persisted data (localStorage + IndexedDB). Default: `false`.
   * @param options.timeout - Milliseconds to wait for sync to complete.
   */
  async disconnect(options: DisconnectOptions = {}): Promise<void> {
    if (this._isShuttingDown || this._isShutDown) {
      await this._shutdownPromise;
      return;
    }

    this._invalidateConnectionAttempts();
    this.stopConnectionMonitor();
    const releaseCommit = await this._acquireLifecycleCommit();
    try {
      await this._disconnect(options);
    } finally {
      releaseCommit();
    }
  }

  private async _disconnect(options: DisconnectOptions): Promise<void> {
    const { clearStorage = false, timeout = 2000 } = options;
    const did = this._session?.did;

    // Stop live sync BEFORE revoking. Revocation delivery uses direct RPC
    // (not the sync engine), and revoking while subscriptions and the
    // repair loop still run under the session's grants makes them fail
    // against the delegate's own revocation.
    try {
      await this._userAgent.sync.stopSync(timeout);
    } catch {
      // Best-effort — sync may never have been started.
    }

    // Revoke delegated session grants. Each revocation grant is
    // contextId-scoped to the specific session grant it can revoke.
    const delegateDid = this._session?.delegateDid;
    const connectedDid = this._session?.did;
    let failedRevocations: { grantId: string; revocationGrantId: string }[] = [];

    if (delegateDid && connectedDid) {
      try {
        const revocationsJson = await this._storage.get(STORAGE_KEYS.SESSION_REVOCATIONS);
        if (revocationsJson) {
          const revocations: { grantId: string; revocationGrantId: string }[] = JSON.parse(revocationsJson);

          // Resolve the owner's DWN endpoints for remote delivery.
          // Resolve REMOTE owner DWN endpoints (from DID document, not local
          // discovery). Only remote endpoints count for revocation success.
          let remoteDwnUrls: string[] = [];
          try {
            remoteDwnUrls = await this._userAgent.dwn.getRemoteDwnEndpointUrls(connectedDid);
          } catch {
            // Endpoint resolution failure — revocations will be local-only.
          }

          const succeeded: string[] = [];
          for (const { grantId, revocationGrantId } of revocations) {
            try {
              // Read the specific grant by recordId. Use the delegate DID
              // as author since the delegate agent may not have the owner's
              // signing key. The delegate is the grant's recipient, so the
              // permissions protocol authorizes the read.
              const { reply: readReply } = await this._userAgent.dwn.processRequest({
                author        : delegateDid,
                target        : connectedDid,
                messageType   : DwnInterface.RecordsRead,
                messageParams : { filter: { recordId: grantId } },
              });
              if (readReply.status.code !== 200 || !readReply.entry?.recordsWrite) { continue; }
              // Reconstruct DwnDataEncodedRecordsWriteMessage: RecordsRead returns
              // data as a stream, but PermissionGrant.parse needs encodedData.
              const grantDataBytes = readReply.entry.data
                ? await DataStream.toBytes(readReply.entry.data)
                : new Uint8Array(0);
              const grantMsgWithData: DwnDataEncodedRecordsWriteMessage = {
                ...readReply.entry.recordsWrite,
                encodedData: Convert.uint8Array(grantDataBytes).toBase64Url(),
              };
              const grant = DwnPermissionGrant.parse(grantMsgWithData);

              // Self-healing: ensure the revocation grant is on the remote
              // DWN. The best-effort fanout at connect time may have failed.
              if (remoteDwnUrls.length > 0) {
                try {
                  const { reply: revGrantReply } = await this._userAgent.dwn.processRequest({
                    author        : delegateDid,
                    target        : connectedDid,
                    messageType   : DwnInterface.RecordsRead,
                    messageParams : { filter: { recordId: revocationGrantId } },
                  });
                  if (revGrantReply.status.code === 200 && revGrantReply.entry?.recordsWrite) {
                    // Strip `encodedData` from the wire payload — the
                    // bytes are sent via `data` (Blob) on the next line.
                    // `RecordsWriteMessage` doesn't declare `encodedData`,
                    // but the wire-format reply may include it; widen the
                    // local type to acknowledge that without `any`.
                    // NOSONAR S4325 false positive: the cast is required to
                    // typecheck the destructuring of the undeclared
                    // optional `encodedData` property; removing it fails
                    // TS2339. Sonar reads the intersection-with-optional-
                    // field as a no-op widening, which it isn't here.
                    type RecordsWriteWireMessage = RecordsWriteMessage & { encodedData?: string };
                    const { encodedData: _encoded, ...revGrantRaw } =
                      revGrantReply.entry.recordsWrite as RecordsWriteWireMessage; // NOSONAR
                    const revGrantData = revGrantReply.entry.data
                      ? new Blob([await DataStream.toBytes(revGrantReply.entry.data) as BlobPart])
                      : undefined;
                    for (const dwnUrl of remoteDwnUrls) {
                      try {
                        await this._userAgent.rpc.sendDwnRequest({
                          dwnUrl,
                          targetDid : connectedDid,
                          message   : revGrantRaw,
                          data      : revGrantData,
                        });
                      } catch { /* per-endpoint failure */ }
                    }
                  }
                } catch { /* best-effort */ }
              }

              // Create the revocation locally.
              const { message: revocationMessage } = await this._userAgent.permissions.createRevocation({
                author            : connectedDid,
                store             : true,
                grant,
                granteeDid        : delegateDid,
                permissionGrantId : revocationGrantId,
              });

              // Send the revocation to the owner's remote DWN endpoints.
              // A revocation is only considered successful if at least one
              // remote endpoint confirms it (202/409). Without remote
              // delivery, the owner-side authority source won't see it.
              let remoteDelivered = false;
              if (revocationMessage && remoteDwnUrls.length > 0) {
                const { encodedData, ...rawMessage } = revocationMessage;
                const data = encodedData
                  ? new Blob([Convert.base64Url(encodedData).toUint8Array() as BlobPart])
                  : undefined;
                for (const dwnUrl of remoteDwnUrls) {
                  try {
                    const sendReply = await this._userAgent.rpc.sendDwnRequest({
                      dwnUrl,
                      targetDid : connectedDid,
                      message   : rawMessage,
                      data,
                    });
                    if (sendReply?.status?.code === 202 || sendReply?.status?.code === 409) {
                      remoteDelivered = true;
                    }
                  } catch {
                    // Per-endpoint failure — try the next one.
                  }
                }
              }

              if (remoteDelivered) {
                succeeded.push(grantId);
              }
            } catch {
              // Individual revocation failure.
            }
          }

          failedRevocations = revocations.filter((r) => !succeeded.includes(r.grantId));
        }
      } catch (error: any) {
        console.warn(`AuthManager: Grant revocation on disconnect failed: ${error.message}`);
      }
    }

    this._session = undefined;

    // Always clear the in-memory delegate decryption key cache on disconnect.
    this._userAgent.dwn.clearDelegateDecryptionKeys();

    if (clearStorage) {
      // Nuclear wipe: clear all persisted auth data.
      await this._storage.clear();

      // Wipe all secrets from the vault-backed SecretStore.
      await Promise.all([
        this._userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).catch(() => {}),
        this._userAgent.secrets.delete(STORAGE_KEYS.REGISTRATION_TOKENS).catch(() => {}),
      ]);

      // Also clear non-prefixed localStorage and IndexedDB (browser).
      if (globalThis.localStorage !== undefined) {
        globalThis.localStorage.clear();
      }
      if (globalThis.indexedDB !== undefined) {
        try {
          const databases = await globalThis.indexedDB.databases();
          for (const db of databases) {
            if (db.name) {
              globalThis.indexedDB.deleteDatabase(db.name);
            }
          }
        } catch {
          // indexedDB.databases() not available in all browsers.
        }
      }
    } else {
      // Clean disconnect: ALWAYS clear all session markers regardless
      // of revocation outcome. Retry context is independent (step below).
      await Promise.all([
        this._storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED),
        this._storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY),
        this._storage.remove(STORAGE_KEYS.DELEGATE_DID),
        this._storage.remove(STORAGE_KEYS.CONNECTED_DID),
        this._storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS),
        this._storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS),
        this._storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS),
        this._userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).catch(() => {}),
      ]);
    }

    // Update retry context — but NOT after a nuclear wipe.
    // On failure: merge into existing collection.
    // On success: prune any stale retry entry for this delegate.
    if (!clearStorage && delegateDid && failedRevocations.length > 0 && connectedDid) {
      let entries: { delegateDid: string; connectedDid: string; revocations: { grantId: string; revocationGrantId: string }[] }[] = [];
      try {
        const existing = await this._storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
        if (existing) {
          const parsed = JSON.parse(existing);
          if (Array.isArray(parsed)) {
            entries = parsed;
          } else if (parsed?.delegateDid && parsed?.connectedDid && Array.isArray(parsed?.revocations)) {
            // Legacy single-object format — migrate to array.
            entries = [parsed];
          }
        }
      } catch { /* ignore corrupt data — start fresh */ }

      // Replace or append this session's entry (keyed by delegateDid).
      const idx = entries.findIndex((e) => e.delegateDid === delegateDid);
      const newEntry = { delegateDid, connectedDid, revocations: failedRevocations };
      if (idx >= 0) {
        entries[idx] = newEntry;
      } else {
        entries.push(newEntry);
      }

      await this._storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(entries));
      console.warn(
        `AuthManager: ${failedRevocations.length} grant revocation(s) failed. ` +
        `Retry context persisted in REVOCATION_RETRY_CONTEXT.`
      );
    } else if (!clearStorage && delegateDid && failedRevocations.length === 0) {
      // All revocations succeeded — prune any stale retry entry for this
      // delegate from a previous partial disconnect.
      try {
        const existing = await this._storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
        if (existing) {
          const parsed = JSON.parse(existing);
          const arr = Array.isArray(parsed) ? parsed : [];
          const pruned = arr.filter((e: any) => e.delegateDid !== delegateDid);
          if (pruned.length === 0) {
            await this._storage.remove(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
          } else if (pruned.length < arr.length) {
            await this._storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(pruned));
          }
        }
      } catch { /* best effort */ }
    }

    // A cleanly revoked delegate is dead — connect sessions have no renewal
    // path and its grants are revoked — so remove the identity locally.
    // Otherwise a later restore can select the stale delegate and every
    // call under its revoked grants fails with 401. Keep the identity while
    // revocations are queued for retry: the retry path signs as the delegate.
    if (delegateDid && failedRevocations.length === 0) {
      try {
        const delegateIdentity = await this._userAgent.identity.get({ didUri: delegateDid });
        if (delegateIdentity) {
          try {
            await this._userAgent.did.delete({
              didUri    : delegateIdentity.did.uri,
              tenant    : delegateIdentity.metadata.tenant,
              deleteKey : true,
            });
          } catch { /* best effort */ }
          await this._userAgent.identity.delete({ didUri: delegateIdentity.did.uri });
        }
      } catch {
        // Best-effort — a leftover identity is recoverable by reconnecting.
      }
    }

    this._setState('unlocked');

    if (did) {
      this._emitter.emit('session-end', { did });
    }
  }

  /**
   * Gracefully shut down the auth manager, releasing all resources.
   *
   * This goes beyond {@link disconnect} or {@link lock}: it stops sync,
   * clears the active session, locks the vault, and **closes** the
   * underlying storage handles (e.g. LevelDB) so the process can exit
   * without dangling timers or open file descriptors.
   *
   * After calling `shutdown()`, the `AuthManager` instance should not be
   * reused — create a new one via {@link AuthManager.create} if needed.
   *
   * Idempotent: calling `shutdown()` more than once is safe.
   *
   * @param options - Optional shutdown configuration.
   * @param options.timeout - Milliseconds to wait for sync to stop. Default: `2000`.
   *
   * @example
   * ```ts
   * const session = await auth.connectHeadless({ password });
   * // ... perform work ...
   * await auth.shutdown(); // clean exit, no process.exit() needed
   * ```
   */
  shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this._shutdownPromise !== undefined) {
      return this._shutdownPromise;
    }
    if (this._isShutDown) {
      return Promise.resolve();
    }

    // Mark intent before the first async boundary. Otherwise a new connect or
    // refresh can enter while teardown is waiting for the lifecycle mutex and
    // reach wallet approval against an agent that is closing.
    this._isShuttingDown = true;
    this._invalidateConnectionAttempts();
    this.stopConnectionMonitor();
    this._shutdownPromise = this._runShutdown(options);
    return this._shutdownPromise;
  }

  private async _runShutdown(options: ShutdownOptions): Promise<void> {
    const releaseCommit = await this._acquireLifecycleCommit();
    try {
      if (!this._isShutDown) {
        await this._shutdown(options);
      }
    } finally {
      this._isShuttingDown = false;
      releaseCommit();
    }
  }

  private async _shutdown(options: ShutdownOptions): Promise<void> {
    const { timeout = 2000 } = options;
    const did = this._session?.did;

    // 1. Tear down the agent: stops sync, drains the RPC socket pool, locks
    //    the vault, and closes the DWN stores, DID resolver cache, and vault
    //    and secret stores. Without the full teardown the process cannot
    //    exit (WebSocket heartbeats keep the event loop alive) and the same
    //    dataPath cannot be reopened in-process.
    try {
      await this._userAgent.shutdown({ syncStopTimeoutMs: timeout });
      this._emitter.emit('vault-locked', {});
    } catch {
      // Best-effort — don't block shutdown on teardown errors.
    }

    // 2. Clear the active session.
    this._session = undefined;

    // 3. Close the storage adapter (e.g. LevelDB session store).
    if (typeof this._storage.close === 'function') {
      try {
        await this._storage.close();
      } catch {
        // Best-effort.
      }
    }

    // 4. Mark as shut down and transition state.
    this._isShutDown = true;
    this._setState('locked');

    // 5. Emit session-end if there was an active session.
    if (did) {
      this._emitter.emit('session-end', { did });
    }
  }

  // ─── Multi-identity ────────────────────────────────────────────

  /**
   * List all stored identities.
   *
   * Each identity has a DID URI, name, and optional connected DID
   * (for wallet-connected/delegated identities).
   */
  async listIdentities(): Promise<AgentSessionIdentity[]> {
    const identities = await this._userAgent.identity.list();
    return identities.map((identity: BearerIdentity) => ({
      didUri       : identity.did.uri,
      name         : identity.metadata.name,
      connectedDid : identity.metadata.connectedDid,
    }));
  }

  /**
   * Switch the active identity.
   *
   * Disconnects the current session (if any) and creates a new session
   * for the specified identity.
   */
  async switchIdentity(didUri: string): Promise<AuthSession> {
    // Disconnect current session cleanly (keep data).
    if (this._session) {
      await this.disconnect();
    }

    const identity = await this._userAgent.identity.get({ didUri });
    if (!identity) {
      throw new Error(`[@enbox/auth] Identity not found: ${didUri}`);
    }

    const { connectedDid, delegateDid } = resolveIdentityDids(identity);

    // Persist the switch.
    await this._storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await this._storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);

    const identityInfo: AgentSessionIdentity = {
      didUri       : connectedDid,
      name         : identity.metadata.name,
      connectedDid : identity.metadata.connectedDid,
    };

    // Always repair the sync registration regardless of sync state — a stale
    // registration persists on disk and would take effect when sync is later
    // enabled. This matches restoreSession()'s behavior.
    const derivedProtocols = delegateDid
      ? await this._deriveProtocolsFromGrants(delegateDid)
      : undefined;

    await this._repairSyncRegistration(connectedDid, delegateDid, derivedProtocols);

    await startSyncIfEnabled(this._userAgent, this._defaultSync);

    this._session = new AuthSession({
      agent    : this._userAgent,
      did      : connectedDid,
      delegateDid,
      identity : identityInfo,
    });

    this._setState('connected');

    this._emitter.emit('session-start', {
      session: { did: connectedDid, delegateDid, identity: identityInfo },
    });

    return this._session;
  }

  /**
   * Delete a stored identity.
   *
   * If the identity is currently active, it will be disconnected first.
   *
   * @throws If the identity is not found.
   */
  async deleteIdentity(didUri: string): Promise<void> {
    // Disconnect if this is the active identity.
    if (this._session?.did === didUri) {
      await this.disconnect();
    }

    const identity = await this._userAgent.identity.get({ didUri });
    if (!identity) {
      throw new Error(`[@enbox/auth] Identity not found: ${didUri}`);
    }

    // Delete the DID and keys.  If this fails, do NOT proceed to delete the
    // identity record — that would leave orphaned cryptographic key material
    // with no identity metadata pointing to it.
    await this._userAgent.did.delete({
      didUri    : identity.did.uri,
      tenant    : identity.metadata.tenant,
      deleteKey : true,
    });

    // Delete the identity record.
    await this._userAgent.identity.delete({ didUri });

    this._emitter.emit('identity-removed', { didUri });
  }

  /**
   * Export an identity as a PortableIdentity JSON object.
   *
   * This can be used for backup or transferring the identity
   * to another device.
   */
  async exportIdentity(didUri: string): Promise<PortableIdentity> {
    return this._userAgent.identity.export({ didUri });
  }

  // ─── Vault ─────────────────────────────────────────────────────

  /** Access the underlying identity vault for lock/unlock/backup operations. */
  get vault(): HdIdentityVault {
    return this._userAgent.vault;
  }

  // ─── Events ────────────────────────────────────────────────────

  /**
   * Subscribe to an auth lifecycle event.
   *
   * @param event - The event name.
   * @param handler - The event handler.
   * @returns An unsubscribe function.
   */
  on<E extends AuthEvent>(event: E, handler: AuthEventHandler<E>): () => void {
    return this._emitter.on(event, handler);
  }

  // ─── State ─────────────────────────────────────────────────────

  /** The current auth state. */
  get state(): AuthState {
    return this._state;
  }

  /** Whether an active session exists. */
  get isConnected(): boolean {
    return this._state === 'connected';
  }

  /** Whether the vault is currently locked. */
  get isLocked(): boolean {
    return this._userAgent.vault.isLocked();
  }

  /** Whether a connection attempt is in progress. */
  get isConnecting(): boolean {
    return this._isConnecting;
  }

  /** The underlying EnboxUserAgent (for advanced usage). */
  get agent(): EnboxUserAgent {
    return this._userAgent;
  }

  /**
   * The local DWN server endpoint discovered during `create()`, if any.
   *
   * When set, the agent is operating in remote mode (no in-process DWN).
   * This property is available immediately after `create()` returns,
   * before any event listeners are attached.
   */
  get localDwnEndpoint(): string | undefined {
    return this._localDwnEndpoint;
  }

  /** Current local-node pairing status without exposing the bearer token. */
  get localDwnStatus(): { status: 'paired'; endpoint: string; pairedOrigin: string } | { status: 'unavailable' } {
    if (this._localDwnPairing === undefined) {
      return { status: 'unavailable' };
    }

    return {
      endpoint     : this._localDwnPairing.endpoint,
      pairedOrigin : this._localDwnPairing.pairedOrigin,
      status       : 'paired',
    };
  }

  /**
   * Explicitly probe localhost for an Enbox local-node profile.
   *
   * This method may walk the local-node port list and should be called from a
   * user gesture unless the app is only checking a previously stored pairing.
   */
  async probeLocalNode(): Promise<LocalDwnProbeResult> {
    this._guardShutdown();

    return probeLocalDwn({ storage: this._storage });
  }

  /**
   * Pair this origin with a local node and persist the resulting token.
   *
   * Pairing only establishes trust with the local node. Future
   * `AuthManager.create()` calls boot in authenticated remote mode only after
   * {@link ejectToLocalNode} drains the current in-process DWN and persists the
   * ejection marker. If this manager was already created in remote mode, its
   * RPC client is updated immediately.
   */
  async enableLocalNode(options: {
    endpoint?: string;
    origin?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {}): Promise<LocalDwnPairingRequestResult> {
    this._guardShutdown();

    const result = await requestLocalDwnPairing({
      endpoint       : options.endpoint,
      origin         : options.origin,
      pollIntervalMs : options.pollIntervalMs,
      storage        : this._storage,
      timeoutMs      : options.timeoutMs,
    });

    if (result.status !== 'paired') {
      if (result.status === 'not-found' || result.status === 'unsupported') {
        this._emitter.emit('local-dwn-unavailable', {});
      }
      return result;
    }

    this._localDwnPairing = result.pairing;
    this._userAgent.rpc = createLocalDwnRpcClient(result.pairing, this._userAgent.rpc);

    if (this._userAgent.dwn.isRemoteMode) {
      this._localDwnEndpoint = result.endpoint;
      await this._userAgent.dwn.setCachedLocalDwnEndpoint(result.endpoint);
    } else {
      this._localDwnEndpoint = undefined;
      await clearLocalDwnEjection(this._storage);
    }

    this._emitter.emit('local-dwn-available', { endpoint: result.endpoint, paired: true });

    return result;
  }

  /**
   * Drain the current in-process DWN to the paired local node and mark the
   * next session for remote-mode boot.
   *
   * This method deliberately does not mutate the active agent into remote mode.
   * The local/remote switch happens only at the next `AuthManager.create()`
   * boundary, which keeps the running agent's DWN handles and sync state stable.
   */
  async ejectToLocalNode(options: LocalNodeEjectOptions = {}): Promise<LocalNodeEjectResult> {
    this._guardShutdown();

    const pairing = this._localDwnPairing ?? await discoverLocalDwnPairing(this._storage);
    if (pairing === undefined) {
      await clearLocalDwnEjection(this._storage);
      this._emitter.emit('local-dwn-unavailable', {});
      return {
        nextSessionRemoteMode : false,
        reason                : 'not-paired',
        status                : 'unavailable',
      };
    }

    this._localDwnPairing = pairing;

    if (this._userAgent.dwn.isRemoteMode) {
      throw new Error('[@enbox/auth] Local node eject requires an in-process DWN. The current agent is already in remote mode.');
    }

    this._userAgent.rpc = createLocalDwnRpcClient(pairing, this._userAgent.rpc);
    const drain = await this._userAgent.sync.drainTo(pairing.endpoint, options);
    if (!drain.completed) {
      await clearLocalDwnEjection(this._storage);
      return {
        drain,
        endpoint              : drain.endpoint,
        nextSessionRemoteMode : false,
        status                : 'incomplete',
      };
    }

    await persistLocalDwnEjectionRecord(this._storage, {
      completedAt : Date.now(),
      endpoint    : drain.endpoint,
      version     : 1,
    });

    return {
      drain,
      endpoint              : drain.endpoint,
      nextSessionRemoteMode : true,
      status                : 'completed',
    };
  }

  // ─── Private helpers ───────────────────────────────────────────

  /**
   * Determine whether the given options indicate a vault connect flow.
   *
   * Handler intent is asserted by the presence of a non-empty `protocols`
   * array OR a non-null `connectHandler`; everything else (including the
   * no-options case, an empty `protocols: []`, and `null` values from JS
   * callers) routes to vault connect. An empty `protocols` array is
   * intentionally NOT a handler signal — it carries no permission scopes
   * for the handler to authorize, so treating it as handler-flow would
   * produce a zero-grant "connected" session indistinguishable from a
   * denied connect.
   *
   * Acts as a TypeScript type guard: a `true` return narrows `options` to
   * `VaultConnectOptions | undefined` at call sites, so the routing in
   * {@link AuthManager.connect} can dispatch without unsafe casts.
   */
  private _isVaultConnect(options?: ConnectOptions): options is VaultConnectOptions | undefined {
    if (options === undefined || options === null) { return true; }
    if ('protocols' in options && Array.isArray(options.protocols) && options.protocols.length > 0) { return false; }
    if ('connectHandler' in options && options.connectHandler !== undefined && options.connectHandler !== null) { return false; }
    return true;
  }

  private _isPhraseRestore(options?: ConnectOptions): options is RestoreFromPhraseOptions {
    return options !== undefined
      && options !== null
      && typeof (options as { recoveryPhrase?: unknown }).recoveryPhrase === 'string';
  }

  /**
   * Run a handler-based (delegated) connect flow.
   *
   * Handler resolution happens BEFORE any vault I/O so a misconfigured call
   * (no handler reachable) fails fast without mutating on-disk state.
   *
   * 1. Resolve the connect handler (fast-fail when none is reachable).
   * 2. Initialize the vault (agent-only, no identity).
   * 3. Normalize protocol permission requests.
   * 4. Delegate to the connect handler for credential acquisition.
   * 5. Import the delegate DID, process grants, set up sync.
   * 6. Finalize and return the AuthSession.
   */
  private async _handlerConnect(
    options: HandlerConnectOptions | undefined,
    guard: ConnectionAttemptGuard,
  ): Promise<AuthSession> {
    const ctx = this._flowContext();
    const { userAgent, emitter, storage } = ctx;
    const sync = options?.sync ?? ctx.defaultSync;

    // 1. Resolve the handler FIRST. Anything past this point may mutate the
    //    vault on disk, so misconfiguration must fail before that happens.
    const handler = options?.connectHandler ?? this._connectHandler;
    if (!handler) {
      throw new Error(
        '[@enbox/auth] No connect handler provided. ' +
        'Install @enbox/browser and pass BrowserConnectHandler(), ' +
        'or provide a custom ConnectHandler.'
      );
    }
    this._assertConnectionAttemptActive(guard);

    // 2. Initialize vault (agent-only, no identity). The per-call password
    //    (when supplied via `HandlerConnectOptions.password`) wins over the
    //    manager default, matching the behavior of the vault-connect flow.
    const isFirstLaunch = await userAgent.firstLaunch();
    this._assertConnectionAttemptActive(guard);
    const password = await resolvePassword(ctx, options?.password, isFirstLaunch);
    this._assertConnectionAttemptActive(guard);
    await this._runConnectionMutation(
      guard,
      () => ensureVaultReady({ userAgent, emitter, password, isFirstLaunch }),
    );

    // 3. Normalize protocol requests.
    const permissionRequests = normalizeProtocolRequests(options?.protocols);

    // 4. Delegate to the handler.
    const result = await handler.requestAccess({ permissionRequests });
    this._assertConnectionAttemptActive(guard);
    if (!result) {
      throw new ConnectDeniedError('[@enbox/auth] Connect was denied or cancelled by the user.');
    }

    return this._commitConnectionResult(guard, async (): Promise<AuthSession> => {
      // 5. Validate the returned grants against the request before importing
      //    anything — grantee must be the delegate DID and every scope must
      //    have been requested.
      validateConnectResultGrants(result, permissionRequests);

      // 6. Import delegate DID, process grants, set up sync.
      const {
        delegatePortableDid, connectedDid, delegateGrants, sessionRevocations,
      } = result;
      const identity = await importDelegateAndSetupSync({
        userAgent, delegatePortableDid, connectedDid, delegateGrants,
        flowName: 'Connect',
      });

      // 7. Finalize session. Pass the transient delegate state explicitly
      // so `persistOrClearDelegateSecrets` doesn't need to read it back
      // off the identity (which was the old `(identity as any)._foo`
      // smuggling pattern).
      return finalizeDelegateSession({
        userAgent, emitter, storage, identity,
        connectedDid, delegateDid   : delegatePortableDid.uri, sync,
        delegateState : {
          sessionRevocations,
        },
      });
    });
  }

  /** Re-grant the current delegated session without replacing its local DID. */
  private async _refresh(
    options: RefreshOptions,
    monitor?: ConnectionMonitorState,
  ): Promise<AuthSession> {
    return this._withConnect(
      (guard) => this._handlerRefresh(options, guard),
      monitor,
    );
  }

  private async _handlerRefresh(
    options: RefreshOptions,
    guard: ConnectionAttemptGuard,
  ): Promise<AuthSession> {
    const currentSession = this._session;
    const connectedDid = currentSession?.did;
    const delegateDid = currentSession?.delegateDid;
    if (connectedDid === undefined || delegateDid === undefined) {
      throw new Error('[@enbox/auth] refresh() requires an active delegated session.');
    }

    if (!Array.isArray(options?.protocols) || options.protocols.length === 0) {
      throw new Error('[@enbox/auth] refresh() requires at least one protocol request.');
    }

    const handler = options.connectHandler ?? this._connectHandler;
    if (handler === undefined) {
      throw new Error(
        '[@enbox/auth] No connect handler provided. ' +
        'Install @enbox/browser and pass BrowserConnectHandler(), ' +
        'or provide a custom ConnectHandler.'
      );
    }

    const identity = await this._userAgent.identity.get({ didUri: delegateDid });
    this._assertConnectionAttemptActive(guard);
    if (identity === undefined || identity.metadata.connectedDid !== connectedDid) {
      throw new Error(
        `[@enbox/auth] Active delegate identity '${delegateDid}' is not connected to '${connectedDid}'.`
      );
    }

    const delegatePortableDid = await this._userAgent.did.export({
      didUri : delegateDid,
      tenant : identity.metadata.tenant,
    });
    this._assertConnectionAttemptActive(guard);
    if (delegatePortableDid.uri !== delegateDid) {
      throw new Error(
        `[@enbox/auth] Exported delegate DID '${delegatePortableDid.uri}', expected '${delegateDid}'.`
      );
    }
    const permissionRequests = normalizeProtocolRequests(options.protocols);
    const result = await handler.requestAccess({
      permissionRequests,
      delegatePortableDid,
      requestType: 'refresh',
    });
    this._assertConnectionAttemptActive(guard);
    if (result === undefined) {
      throw new ConnectDeniedError('[@enbox/auth] Refresh was denied or cancelled by the user.');
    }

    if (result.connectedDid !== connectedDid) {
      throw new Error(
        `[@enbox/auth] Refresh returned connected DID '${result.connectedDid}', expected '${connectedDid}'.`
      );
    }
    if (result.delegatePortableDid.uri !== delegateDid) {
      throw new Error(
        `[@enbox/auth] Refresh returned delegate DID '${result.delegatePortableDid.uri}', expected '${delegateDid}'.`
      );
    }

    return this._commitConnectionResult(guard, async (): Promise<AuthSession> => {
      validateConnectResultGrants(result, permissionRequests);
      await processDelegateGrantsForExistingIdentity({
        userAgent      : this._userAgent,
        connectedDid,
        delegateDid,
        delegateGrants : result.delegateGrants,
      });
      await this._userAgent.permissions.clear();

      return finalizeDelegateSession({
        userAgent         : this._userAgent,
        emitter           : this._emitter,
        storage           : this._storage,
        identity,
        connectedDid,
        delegateDid,
        sync              : this._defaultSync,
        delegateState     : { sessionRevocations: result.sessionRevocations },
        startSync         : false,
        emitIdentityAdded : false,
        emitSessionStart  : false,
      });
    });
  }

  /** Run one serialized connection-monitor poll. */
  private async _pollConnectionMonitor(monitor: ConnectionMonitorState): Promise<void> {
    if (this._connectionMonitor !== monitor || monitor.isPolling || this._isConnecting) {
      return;
    }

    monitor.isPolling = true;
    try {
      const status = await this.getConnectionStatus({
        checkRevoked                 : monitor.options.checkRevoked,
        expiringSoonThresholdSeconds : monitor.options.expiringSoonThresholdSeconds,
      });
      if (this._connectionMonitor !== monitor || this._isConnecting) {
        return;
      }

      await this._handleConnectionMonitorStatus(monitor, status);
    } catch (error: unknown) {
      this._handleConnectionMonitorError(monitor, error);
    } finally {
      monitor.isPolling = false;
    }
  }

  /** Emit lifecycle events for a resolved connection-status snapshot and trigger auto-refresh when eligible. */
  private async _handleConnectionMonitorStatus(
    monitor: ConnectionMonitorState,
    status: ConnectionStatus,
  ): Promise<void> {
    const statusKey = `${status.connectSessionId ?? 'none'}:${status.state}`;
    if (statusKey === monitor.lastStatusKey) {
      return;
    }
    monitor.lastStatusKey = statusKey;

    if (status.state === 'expiring-soon') {
      this._emitter.emit('connection-expiring', { status });
    } else if (status.state === 'expired' || status.state === 'revoked') {
      this._emitter.emit('connection-expired', { status });
    }

    const autoRefresh = monitor.options.autoRefresh;
    if (autoRefresh === undefined || this._isConnecting ||
      (status.state !== 'expiring-soon' && status.state !== 'expired')) {
      return;
    }

    const attemptKey = `${status.connectSessionId ?? status.delegateDid ?? 'unknown'}:${status.state}`;
    if (monitor.autoRefreshAttempts.has(attemptKey)) {
      return;
    }
    monitor.autoRefreshAttempts.add(attemptKey);
    await this._refresh(autoRefresh, monitor);
  }

  /** Handle an error thrown while polling a connection monitor. */
  private _handleConnectionMonitorError(monitor: ConnectionMonitorState, error: unknown): void {
    if (this._connectionMonitor !== monitor) {
      return;
    }

    if (monitor.options.onError !== undefined) {
      try {
        monitor.options.onError(error);
      } catch (callbackError: unknown) {
        console.error('[@enbox/auth] Connection monitor error callback failed:', callbackError);
      }
    } else {
      console.error('[@enbox/auth] Connection monitor failed:', error);
    }
  }

  /**
   * Build a `FlowContext` from the manager's current state.
   *
   * Replaces the 5 manual inline context constructions that were
   * previously duplicated across `connect()`, `walletConnect()`,
   * `restoreFromPhrase()`, `importFromPortable()`, and `restoreSession()`.
   */
  private _flowContext(guard?: ConnectionAttemptGuard): FlowContext {
    return {
      userAgent                    : this._userAgent,
      emitter                      : this._emitter,
      storage                      : this._storage,
      defaultPassword              : this._defaultPassword,
      passwordProvider             : this._passwordProvider,
      defaultSync                  : this._defaultSync,
      defaultIdentitySyncProtocols : this._defaultIdentitySyncProtocols,
      defaultDwnEndpoints          : this._defaultDwnEndpoints,
      registration                 : this._registration,
      ...(guard === undefined ? {} : {
        assertActive  : (): void => this._assertConnectionAttemptActive(guard),
        runMutation   : <T>(operation: () => Promise<T>): Promise<T> => this._runConnectionMutation(guard, operation),
        commitSession : (operation: () => Promise<AuthSession>): Promise<AuthSession> =>
          this._commitConnectionResult(guard, operation),
      }),
    };
  }

  /**
   * Template for connection flows that follow the guard → try/finally → setState pattern.
   *
   * Consolidates the duplicated concurrency guard, `_isConnecting` flag management,
   * session assignment, and state transition across `connect()`, `walletConnect()`,
   * `restoreFromPhrase()`, and `importFromPortable()`.
   *
   * Also short-circuits if the manager has already been shut down — using
   * a closed manager would otherwise fail deep inside sync/storage with an
   * unhelpful error.
   */
  private async _withConnect(
    fn: (guard: ConnectionAttemptGuard) => Promise<AuthSession>,
    monitor?: ConnectionMonitorState,
  ): Promise<AuthSession> {
    this._guardShutdown();
    this._guardConcurrency();
    this._isConnecting = true;
    const guard: ConnectionAttemptGuard = {
      lifecycleGeneration: this._lifecycleGeneration,
      monitor,
    };

    try {
      return await fn(guard);
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Derive the sync scope for a delegate by querying stored grants and
   * revocations.
   *
   * Returns `'all'` when any active `Messages.Read` grant is unscoped
   * (authorizing a full replica), otherwise a deduplicated array of
   * protocol URIs derived from scoped `Messages.Read` grants. The DWN
   * permissions protocol itself is excluded because grant records are
   * imported locally during connect rather than replicated via sync.
   *
   * Delegates to {@link deriveActiveSyncScope}.
   */
  private async _deriveProtocolsFromGrants(delegateDid: string): Promise<'all' | string[]> {
    return deriveActiveSyncScope(this._userAgent, delegateDid);
  }

  /**
   * Register an identity for sync, or update an existing registration.
   *
   * If the identity is already registered (e.g. from a prior session),
   * `updateIdentityOptions` is used instead of throwing.
   */
  private async _registerOrUpdateSyncIdentity(
    connectedDid: string,
    delegateDid: string | undefined,
    protocols: 'all' | [string, ...string[]],
  ): Promise<void> {
    const options = { delegateDid, protocols };
    try {
      await this._userAgent.sync.registerIdentity({ did: connectedDid, options });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('already registered')) {
        await this._userAgent.sync.updateIdentityOptions({ did: connectedDid, options });
      } else {
        throw error;
      }
    }
  }

  private async _unregisterSyncIdentityIfRegistered(connectedDid: string): Promise<void> {
    try {
      await this._userAgent.sync.unregisterIdentity(connectedDid);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '';
      if (!msg.includes('is not registered')) { throw error; }
    }
  }

  /**
   * Repair the sync registration for a connected DID based on derived protocols.
   * - `'all'` or non-empty list → register or update
   * - Empty list (zero grants) for a delegate → unregister stale registration
   * - Non-delegate with no explicit local sync scope → leave app-owned registration unchanged
   */
  private async _repairSyncRegistration(
    connectedDid: string,
    delegateDid: string | undefined,
    derivedProtocols: 'all' | string[] | undefined,
  ): Promise<void> {
    if (delegateDid === undefined) {
      if (this._defaultIdentitySyncProtocols !== undefined) {
        await this._registerOrUpdateSyncIdentity(connectedDid, delegateDid, this._defaultIdentitySyncProtocols);
      }
      return;
    }

    if (derivedProtocols === undefined) {
      return;
    }

    const narrowed = toSyncIdentityProtocols(derivedProtocols);
    if (narrowed === undefined) {
      await this._unregisterSyncIdentityIfRegistered(connectedDid);
      return;
    }

    await this._registerOrUpdateSyncIdentity(connectedDid, delegateDid, narrowed);
  }

  /** Serialize connection mutations against teardown without locking user waits. */
  private async _acquireLifecycleCommit(): Promise<() => void> {
    const previous = this._lifecycleCommitTail;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    this._lifecycleCommitTail = previous.then(() => gate);
    await previous;

    let released = false;
    return (): void => {
      if (!released) {
        released = true;
        releaseGate();
      }
    };
  }

  /** Run a non-terminal connection mutation at the lifecycle linearization point. */
  private async _runConnectionMutation<T>(
    guard: ConnectionAttemptGuard,
    operation: () => Promise<T>,
  ): Promise<T> {
    const releaseCommit = await this._acquireLifecycleCommit();
    try {
      this._assertConnectionAttemptActive(guard);
      const result = await operation();
      this._assertConnectionAttemptActive(guard);
      return result;
    } finally {
      releaseCommit();
    }
  }

  /** Finalize and install a connection session before queued teardown can run. */
  private async _commitConnectionResult<T extends AuthSession | undefined>(
    guard: ConnectionAttemptGuard,
    operation: () => Promise<T>,
  ): Promise<T> {
    const releaseCommit = await this._acquireLifecycleCommit();
    try {
      this._assertConnectionAttemptActive(guard);
      const session = await operation();
      if (session !== undefined) {
        const previousDelegateDid = this._session?.delegateDid;
        if (previousDelegateDid !== undefined && previousDelegateDid !== session.delegateDid) {
          this._userAgent.dwn.clearDelegateDecryptionKeys(previousDelegateDid);
        }

        this._session = session;
        this._setState('connected');
      }
      return session;
    } finally {
      releaseCommit();
    }
  }

  private _assertConnectionAttemptActive(guard: ConnectionAttemptGuard): void {
    const monitorInvalidated = guard.monitor !== undefined && this._connectionMonitor !== guard.monitor;
    if (this._lifecycleGeneration !== guard.lifecycleGeneration || this._isShuttingDown || this._isShutDown || monitorInvalidated) {
      throw new Error('[@enbox/auth] Connection attempt was invalidated by a session lifecycle change.');
    }
  }

  private _invalidateConnectionAttempts(): void {
    this._lifecycleGeneration++;
  }

  private _setState(state: AuthState): void {
    if (state === this._state) {return;}
    const previous = this._state;
    this._state = state;
    this._emitter.emit('state-change', { previous, current: state });
  }

  private _guardConcurrency(): void {
    if (this._isConnecting) {
      throw new Error(
        '[@enbox/auth] A connection attempt is already in progress. ' +
        'Wait for it to complete before starting another.'
      );
    }
  }

  private _guardShutdown(): void {
    if (this._isShuttingDown || this._isShutDown) {
      throw new Error(
        '[@enbox/auth] AuthManager is shutting down or has been shut down and cannot be reused. ' +
        'Create a new instance via AuthManager.create().'
      );
    }
  }
}
