/**
 * AuthManager — the primary entry point for `@enbox/auth`.
 *
 * Replaces `Enbox.connect()` (formerly `Web5.connect()`) with a composable,
 * multi-identity-aware auth system that works in both browser and CLI environments.
 * @module
 */

import { EnboxUserAgent } from '@enbox/agent';
import type { BearerIdentity, PortableIdentity } from '@enbox/agent';

import { AuthEventEmitter } from './events.js';
import { AuthSession } from './identity-session.js';
import { createDefaultStorage } from './storage/storage.js';
import { localConnect } from './flows/local-connect.js';
import { restoreSession } from './flows/session-restore.js';
import { STORAGE_KEYS } from './types.js';
import { VaultManager } from './vault/vault-manager.js';
import { walletConnect } from './flows/wallet-connect.js';
import type {
  AuthEvent,
  AuthEventHandler,
  AuthManagerOptions,
  AuthState,
  DisconnectOptions,
  HeadlessConnectOptions,
  IdentityInfo,
  ImportFromPhraseOptions,
  ImportFromPortableOptions,
  LocalConnectOptions,
  RegistrationOptions,
  RestoreSessionOptions,
  ShutdownOptions,
  StorageAdapter,
  SyncOption,
  WalletConnectOptions,
} from './types.js';
import { importFromPhrase, importFromPortable } from './flows/import-identity.js';

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
 * const auth = await AuthManager.create({ sync: '15s' });
 *
 * // First time: creates a new identity
 * // Subsequent times: restores the previous session
 * const session = await auth.restoreSession() ?? await auth.connect();
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
  private _userAgent: EnboxUserAgent;
  private _emitter: AuthEventEmitter;
  private _storage: StorageAdapter;
  private _vault: VaultManager;
  private _session: AuthSession | undefined;
  private _state: AuthState = 'uninitialized';
  private _isConnecting = false;
  private _isShutDown = false;

  // Default options from create()
  private _defaultPassword?: string;
  private _defaultSync?: SyncOption;
  private _defaultDwnEndpoints?: string[];
  private _registration?: RegistrationOptions;

  private constructor(params: {
    userAgent: EnboxUserAgent;
    emitter: AuthEventEmitter;
    storage: StorageAdapter;
    vault: VaultManager;
    defaultPassword?: string;
    defaultSync?: SyncOption;
    defaultDwnEndpoints?: string[];
    registration?: RegistrationOptions;
  }) {
    this._userAgent = params.userAgent;
    this._emitter = params.emitter;
    this._storage = params.storage;
    this._vault = params.vault;
    this._defaultPassword = params.defaultPassword;
    this._defaultSync = params.defaultSync;
    this._defaultDwnEndpoints = params.defaultDwnEndpoints;
    this._registration = params.registration;
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

    // Use a pre-built agent or create one with the given options.
    const userAgent = options.agent ?? await EnboxUserAgent.create({
      dataPath         : options.dataPath,
      agentVault       : options.agentVault,
      localDwnStrategy : options.localDwnStrategy,
    });

    const vault = new VaultManager(userAgent.vault, emitter);

    const manager = new AuthManager({
      userAgent,
      emitter,
      storage,
      vault,
      defaultPassword     : options.password,
      defaultSync         : options.sync,
      defaultDwnEndpoints : options.dwnEndpoints,
      registration        : options.registration,
    });

    // Determine initial state.
    if (await vault.isInitialized()) {
      manager._setState(vault.isLocked ? 'locked' : 'unlocked');
    } else {
      manager._setState('uninitialized');
    }

    return manager;
  }

  // ─── Connection flows ──────────────────────────────────────────

  /**
   * Create or reconnect a local identity.
   *
   * On first use, this creates a new vault, agent DID, and user identity.
   * On subsequent uses, it unlocks the vault and reconnects.
   *
   * @param options - Optional overrides for password, sync, DWN endpoints.
   * @returns An active AuthSession.
   * @throws If a connection attempt is already in progress.
   */
  async connect(options?: LocalConnectOptions): Promise<AuthSession> {
    this._guardConcurrency();
    this._isConnecting = true;

    try {
      const session = await localConnect(
        {
          userAgent           : this._userAgent,
          emitter             : this._emitter,
          storage             : this._storage,
          defaultPassword     : this._defaultPassword,
          defaultSync         : this._defaultSync,
          defaultDwnEndpoints : this._defaultDwnEndpoints,
          registration        : this._registration,
        },
        options,
      );

      this._session = session;
      this._setState('connected');
      return session;
    } finally {
      this._isConnecting = false;
    }
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
    this._guardConcurrency();
    this._isConnecting = true;

    try {
      // Ensure the agent is initialized and started before wallet connect.
      const password = this._defaultPassword ?? 'insecure-static-phrase';
      if (await this._userAgent.firstLaunch()) {
        await this._userAgent.initialize({ password });
      }
      await this._userAgent.start({ password });
      this._emitter.emit('vault-unlocked', {});

      const session = await walletConnect(
        {
          userAgent           : this._userAgent,
          emitter             : this._emitter,
          storage             : this._storage,
          defaultSync         : this._defaultSync,
          defaultDwnEndpoints : this._defaultDwnEndpoints,
          registration        : this._registration,
        },
        options,
      );

      this._session = session;
      this._setState('connected');
      return session;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Import an identity from a BIP-39 recovery phrase.
   *
   * This re-derives the vault and agent DID from the mnemonic,
   * recovering the identity on this device.
   */
  async importFromPhrase(options: ImportFromPhraseOptions): Promise<AuthSession> {
    this._guardConcurrency();
    this._isConnecting = true;

    try {
      const session = await importFromPhrase(
        {
          userAgent           : this._userAgent,
          emitter             : this._emitter,
          storage             : this._storage,
          defaultSync         : this._defaultSync,
          defaultDwnEndpoints : this._defaultDwnEndpoints,
          registration        : this._registration,
        },
        options,
      );

      this._session = session;
      this._setState('connected');
      return session;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Import an identity from a PortableIdentity JSON object.
   *
   * The portable identity contains the DID's private keys and metadata.
   */
  async importFromPortable(options: ImportFromPortableOptions): Promise<AuthSession> {
    this._guardConcurrency();
    this._isConnecting = true;

    try {
      const session = await importFromPortable(
        {
          userAgent           : this._userAgent,
          emitter             : this._emitter,
          storage             : this._storage,
          defaultSync         : this._defaultSync,
          defaultDwnEndpoints : this._defaultDwnEndpoints,
          registration        : this._registration,
        },
        options,
      );

      this._session = session;
      this._setState('connected');
      return session;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Restore a previous session from persisted storage.
   *
   * Returns `undefined` if no previous session exists.
   * This replaces the manual `previouslyConnected` localStorage pattern.
   */
  async restoreSession(options?: RestoreSessionOptions): Promise<AuthSession | undefined> {
    this._guardConcurrency();
    this._isConnecting = true;

    try {
      const session = await restoreSession(
        {
          userAgent       : this._userAgent,
          emitter         : this._emitter,
          storage         : this._storage,
          defaultPassword : this._defaultPassword,
          defaultSync     : this._defaultSync,
        },
        options,
      );

      if (session) {
        this._session = session;
        this._setState('connected');
      }
      return session;
    } finally {
      this._isConnecting = false;
    }
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
    const password = options?.password ?? this._defaultPassword;

    if (!password) {
      throw new Error(
        '[@enbox/auth] connectHeadless() requires a password. ' +
        'Provide one via options.password or the AuthManager default.'
      );
    }

    // Unlock the vault (initialise on first launch).
    if (await this._userAgent.firstLaunch()) {
      await this._userAgent.initialize({ password });
    } else {
      await this._userAgent.start({ password });
    }
    this._emitter.emit('vault-unlocked', {});

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

    const connectedDid = identity.metadata.connectedDid ?? identity.did.uri;
    const delegateDid = identity.metadata.connectedDid ? identity.did.uri : undefined;

    const identityInfo: IdentityInfo = {
      didUri       : connectedDid,
      name         : identity.metadata.name,
      connectedDid : identity.metadata.connectedDid,
    };

    // No sync, no registration, no session persistence markers.
    this._session = new AuthSession({
      agent    : this._userAgent,
      did      : connectedDid,
      delegateDid,
      identity : identityInfo,
    });

    this._setState('connected');

    return this._session;
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
    const { timeout = 2000 } = options;
    const did = this._session?.did;

    // 1. Stop sync.
    if ('sync' in this._userAgent && typeof (this._userAgent as any).sync?.stopSync === 'function') {
      await (this._userAgent as any).sync.stopSync(timeout);
    }

    // 2. Clear the session (but keep storage markers for restore).
    this._session = undefined;

    // 3. Lock the vault (also emits 'vault-locked').
    await this._vault.lock();

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
    const { clearStorage = false, timeout = 2000 } = options;
    const did = this._session?.did;

    // Stop sync.
    if (this._session) {
      if ('sync' in this._userAgent && typeof (this._userAgent as any).sync?.stopSync === 'function') {
        await (this._userAgent as any).sync.stopSync(timeout);
      }
    }

    this._session = undefined;

    if (clearStorage) {
      // Nuclear wipe: clear all persisted auth data.
      await this._storage.clear();

      // Also clear non-prefixed localStorage and IndexedDB (browser).
      if (typeof globalThis.localStorage !== 'undefined') {
        globalThis.localStorage.clear();
      }
      if (typeof globalThis.indexedDB !== 'undefined') {
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
      // Clean disconnect: remove session markers but keep vault/identities.
      await this._storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
      await this._storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY);
      await this._storage.remove(STORAGE_KEYS.DELEGATE_DID);
      await this._storage.remove(STORAGE_KEYS.CONNECTED_DID);
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
  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this._isShutDown) {
      return;
    }

    const { timeout = 2000 } = options;
    const did = this._session?.did;

    // 1. Stop sync.
    if ('sync' in this._userAgent &&
        typeof (this._userAgent as any).sync?.stopSync === 'function') {
      try {
        await (this._userAgent as any).sync.stopSync(timeout);
      } catch {
        // Best-effort — don't block shutdown on sync errors.
      }
    }

    // 2. Clear the active session.
    this._session = undefined;

    // 3. Lock the vault (emits 'vault-locked').
    try {
      await this._vault.lock();
    } catch {
      // Vault may already be locked or uninitialised — safe to ignore.
    }

    // 4. Close the sync engine (releases LevelDB handles, timers).
    if ('sync' in this._userAgent &&
        typeof (this._userAgent as any).sync?.close === 'function') {
      try {
        await (this._userAgent as any).sync.close();
      } catch {
        // Best-effort.
      }
    }

    // 5. Close the storage adapter (e.g. LevelDB session store).
    if (typeof this._storage.close === 'function') {
      try {
        await this._storage.close();
      } catch {
        // Best-effort.
      }
    }

    // 6. Mark as shut down and transition state.
    this._isShutDown = true;
    this._setState('locked');

    // 7. Emit session-end if there was an active session.
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
  async listIdentities(): Promise<IdentityInfo[]> {
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

    const connectedDid = identity.metadata.connectedDid ?? identity.did.uri;
    const delegateDid = identity.metadata.connectedDid ? identity.did.uri : undefined;

    // Persist the switch.
    await this._storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
    await this._storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);

    const identityInfo: IdentityInfo = {
      didUri       : connectedDid,
      name         : identity.metadata.name,
      connectedDid : identity.metadata.connectedDid,
    };

    // Register the identity for sync and restart sync.
    const sync = this._defaultSync;
    if (sync !== 'off') {
      // Register the identity for sync (idempotent — ignores "already registered" errors).
      try {
        await this._userAgent.sync.registerIdentity({
          did     : connectedDid,
          options : { delegateDid, protocols: [] },
        });
      } catch {
        // Already registered — safe to ignore.
      }

      const syncMode = sync === undefined ? 'live' : 'poll';
      const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
      this._userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
        .catch((err: unknown) => console.error('[@enbox/auth] Sync failed:', err));
    }

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

    // Delete the DID and keys.
    try {
      await this._userAgent.did.delete({
        didUri    : identity.did.uri,
        tenant    : identity.metadata.tenant,
        deleteKey : true,
      });
    } catch (err: unknown) {
      console.error(`[@enbox/auth] Failed to delete DID ${didUri}:`, err);
    }

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

  /** Access the vault manager for lock/unlock/backup operations. */
  get vault(): VaultManager {
    return this._vault;
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
    return this._vault.isLocked;
  }

  /** Whether a connection attempt is in progress. */
  get isConnecting(): boolean {
    return this._isConnecting;
  }

  /** The underlying EnboxUserAgent (for advanced usage). */
  get agent(): EnboxUserAgent {
    return this._userAgent;
  }

  // ─── Private helpers ───────────────────────────────────────────

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
}
