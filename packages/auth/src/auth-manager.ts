/**
 * AuthManager — the primary entry point for `@enbox/auth`.
 *
 * Replaces `Enbox.connect()` (formerly `Web5.connect()`) with a composable,
 * multi-identity-aware auth system that works in both browser and CLI environments.
 * @module
 */

import type { BearerIdentity, HdIdentityVault, PortableIdentity } from '@enbox/agent';

import type { FlowContext } from './connect/lifecycle.js';
import type { PasswordProvider } from './password-provider.js';
import type {
  AuthEvent,
  AuthEventHandler,
  AuthManagerOptions,
  AuthState,
  ConnectHandler,
  ConnectOptions,
  DisconnectOptions,
  HandlerConnectOptions,
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

import type { DwnDataEncodedRecordsWriteMessage } from '@enbox/agent';

import { Convert } from '@enbox/common';
import { DataStream, PermissionsProtocol } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant, EnboxUserAgent } from '@enbox/agent';

import { AuthEventEmitter } from './events.js';
import { AuthSession } from './identity-session.js';
import { createDefaultStorage } from './storage/storage.js';
import { discoverLocalDwn } from './discovery.js';
import { localConnect } from './connect/local.js';
import { normalizeProtocolRequests } from './permissions.js';
import { restoreSession } from './connect/restore.js';
import { STORAGE_KEYS } from './types.js';
import { walletConnect } from './connect/wallet.js';
import { ensureVaultReady, finalizeDelegateSession, importDelegateAndSetupSync, resolveIdentityDids, resolvePassword, startSyncIfEnabled } from './connect/lifecycle.js';
import { importFromPhrase, importFromPortable } from './connect/import.js';

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
  private readonly _userAgent: EnboxUserAgent;
  private readonly _emitter: AuthEventEmitter;
  private readonly _storage: StorageAdapter;
  private _session: AuthSession | undefined;
  private _state: AuthState = 'uninitialized';
  private _isConnecting = false;
  private _isShutDown = false;

  // Default options from create()
  private readonly _defaultPassword?: string;
  private readonly _passwordProvider?: PasswordProvider;
  private readonly _defaultSync?: SyncOption;
  private readonly _defaultDwnEndpoints?: string[];
  private readonly _registration?: RegistrationOptions;
  private readonly _connectHandler?: ConnectHandler;

  /**
   * The local DWN server endpoint discovered during `create()`, if any.
   * `undefined` means no local server was found. This is set before any
   * event listeners are attached, so consumers should check this property
   * after `create()` returns rather than relying solely on events.
   */
  private readonly _localDwnEndpoint?: string;

  private constructor(params: {
    userAgent: EnboxUserAgent;
    emitter: AuthEventEmitter;
    storage: StorageAdapter;
    defaultPassword?: string;
    passwordProvider?: PasswordProvider;
    defaultSync?: SyncOption;
    defaultDwnEndpoints?: string[];
    registration?: RegistrationOptions;
    localDwnEndpoint?: string;
    connectHandler?: ConnectHandler;
  }) {
    this._userAgent = params.userAgent;
    this._emitter = params.emitter;
    this._storage = params.storage;
    this._defaultPassword = params.defaultPassword;
    this._passwordProvider = params.passwordProvider;
    this._defaultSync = params.defaultSync;
    this._defaultDwnEndpoints = params.defaultDwnEndpoints;
    this._registration = params.registration;
    this._localDwnEndpoint = params.localDwnEndpoint;
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
    // zero vault/DWN dependencies — it only checks the URL fragment,
    // reads localStorage, and validates via GET /info.
    //
    // When a local DWN server is available, the agent is created in
    // "remote mode": it skips creating an in-process DWN and routes all
    // DWN operations through RPC to the local server.
    let localDwnEndpoint: string | undefined;
    if (!options.agent && options.localDwnStrategy !== 'off') {
      localDwnEndpoint = await discoverLocalDwn(storage);
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
    });

    const manager = new AuthManager({
      userAgent,
      emitter,
      storage,
      defaultPassword     : options.password,
      passwordProvider    : options.passwordProvider,
      defaultSync         : options.sync,
      defaultDwnEndpoints : options.dwnEndpoints,
      registration        : options.registration,
      localDwnEndpoint,
      connectHandler      : options.connectHandler,
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
   * **Handler-based connect** (dapps): Delegates credential acquisition
   * to a {@link ConnectHandler}. Triggered when `protocols` or
   * `connectHandler` is provided.
   *
   * **Local connect** (wallets / CLI): Creates or unlocks a local vault.
   * Triggered when `password`, `createIdentity`, or `recoveryPhrase`
   * is provided.
   *
   * In both cases, `connect()` first attempts to restore a previous
   * session. If a valid session exists, it is returned immediately
   * without any user interaction.
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
    return this._withConnect(async () => {
      // 1. Try to restore a previous session first.
      const restored = await restoreSession(this._flowContext());
      if (restored) { return restored; }

      // 2. Route to the appropriate flow.
      if (this._isLocalConnect(options)) {
        return localConnect(this._flowContext(), options as LocalConnectOptions);
      }

      return this._handlerConnect(options as HandlerConnectOptions | undefined);
    });
  }

  /**
   * Create or reconnect a local identity (explicit local connect).
   *
   * Use this when you explicitly want the local vault flow, bypassing
   * auto-detection. This is the preferred method for wallet apps.
   *
   * @param options - Local connect options.
   * @returns An active AuthSession.
   * @throws If a connection attempt is already in progress.
   */
  async connectLocal(options?: LocalConnectOptions): Promise<AuthSession> {
    return this._withConnect(() => localConnect(this._flowContext(), options));
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
    return this._withConnect(() => walletConnect(this._flowContext(), options));
  }

  /**
   * Import an identity from a BIP-39 recovery phrase.
   *
   * This re-derives the vault and agent DID from the mnemonic,
   * recovering the identity on this device.
   */
  async importFromPhrase(options: ImportFromPhraseOptions): Promise<AuthSession> {
    return this._withConnect(() => importFromPhrase(this._flowContext(), options));
  }

  /**
   * Import an identity from a PortableIdentity JSON object.
   *
   * The portable identity contains the DID's private keys and metadata.
   */
  async importFromPortable(options: ImportFromPortableOptions): Promise<AuthSession> {
    return this._withConnect(() => importFromPortable(this._flowContext(), options));
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
      const session = await restoreSession(this._flowContext(), options);

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
    let password = options?.password ?? this._defaultPassword;
    const isFirstLaunch = await this._userAgent.firstLaunch();

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
    await ensureVaultReady({
      userAgent : this._userAgent,
      emitter   : this._emitter,
      password,
      isFirstLaunch,
    });

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
    const { clearStorage = false, timeout = 2000 } = options;
    const did = this._session?.did;

    // Revoke delegated session grants BEFORE stopping sync so the
    // revocations can be sent to the owner's remote DWN endpoints.
    // Each revocation grant is contextId-scoped to the specific
    // session grant it can revoke.
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
              if (readReply.status.code !== 200 || !readReply.entry) { continue; }
              // Reconstruct DwnDataEncodedRecordsWriteMessage: RecordsRead returns
              // data as a stream, but PermissionGrant.parse needs encodedData.
              const grantDataBytes = readReply.entry.data
                ? await DataStream.toBytes(readReply.entry.data)
                : new Uint8Array(0);
              const grantMsgWithData = {
                ...readReply.entry.recordsWrite,
                encodedData: Convert.uint8Array(grantDataBytes).toBase64Url(),
              };
              const grant = DwnPermissionGrant.parse(grantMsgWithData as any);

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
                    const { encodedData: revGrantEncoded, ...revGrantRaw } = revGrantReply.entry.recordsWrite as any;
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
                const { encodedData, ...rawMessage } = revocationMessage as any;
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

    // Stop sync AFTER revocations are sent to remote endpoints.
    if (this._session) {
      await this._userAgent.sync.stopSync(timeout);
    }

    this._session = undefined;

    // Always clear the in-memory delegate decryption key cache on disconnect.
    this._userAgent.dwn.clearDelegateDecryptionKeys();

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
      // Clean disconnect: ALWAYS clear all session markers regardless
      // of revocation outcome. Retry context is independent (step below).
      // Delegate keys are removed from both SecretStore and legacy StorageAdapter.
      await Promise.all([
        this._storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED),
        this._storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY),
        this._storage.remove(STORAGE_KEYS.DELEGATE_DID),
        this._storage.remove(STORAGE_KEYS.CONNECTED_DID),
        this._storage.remove(STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS),
        this._storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS),
        this._storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS),
        this._storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS),
        this._userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS).catch(() => {}),
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
    try {
      await this._userAgent.sync.stopSync(timeout);
    } catch {
      // Best-effort — don't block shutdown on sync errors.
    }

    // 2. Clear the active session.
    this._session = undefined;

    // 3. Lock the vault.
    try {
      await this._userAgent.vault.lock();
      this._emitter.emit('vault-locked', {});
    } catch {
      // Vault may already be locked or uninitialised — safe to ignore.
    }

    // 4. Close the sync engine (releases LevelDB handles, timers).
    try {
      await this._userAgent.sync.close();
    } catch {
      // Best-effort.
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

    const { connectedDid, delegateDid } = resolveIdentityDids(identity);

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
      const protocols = delegateDid
        ? await this._deriveProtocolsFromGrants(delegateDid)
        : [];

      await this._registerOrUpdateSyncIdentity(connectedDid, delegateDid, protocols);
      await startSyncIfEnabled(this._userAgent, sync);
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

  // ─── Private helpers ───────────────────────────────────────────

  /**
   * Determine whether the given options indicate a local connect flow.
   *
   * Local connect is indicated by the presence of `password`,
   * `createIdentity`, or `recoveryPhrase` — signals that the caller
   * is managing its own vault/identity lifecycle. In non-browser
   * environments, local connect is the fallback.
   */
  private _isLocalConnect(options?: ConnectOptions): boolean {
    const o = (options ?? {}) as Record<string, unknown>;

    // If any local-connect-specific keys are present, it's definitely local.
    const hasLocalSignals = (
      o.password !== undefined ||
      o.createIdentity !== undefined ||
      o.recoveryPhrase !== undefined ||
      o.dwnEndpoints !== undefined ||
      o.metadata !== undefined
    );
    if (hasLocalSignals) { return true; }

    // If any handler-connect signals are present, use the handler flow.
    const hasHandlerSignals = (
      o.protocols !== undefined ||
      o.connectHandler !== undefined
    );
    if (hasHandlerSignals) { return false; }

    // No explicit signals → default to local connect.
    // Callers that want handler-based connect must provide protocols
    // or a connectHandler.
    return true;
  }

  /**
   * Run a handler-based (delegated) connect flow.
   *
   * 1. Initialize the vault (agent-only, no identity).
   * 2. Normalize protocol permission requests.
   * 3. Delegate to the connect handler for credential acquisition.
   * 4. Import the delegate DID, process grants, set up sync.
   * 5. Finalize and return the AuthSession.
   */
  private async _handlerConnect(
    options?: HandlerConnectOptions,
  ): Promise<AuthSession> {
    const ctx = this._flowContext();
    const { userAgent, emitter, storage } = ctx;
    const sync = options?.sync ?? ctx.defaultSync;

    // 1. Initialize vault (agent-only, no identity).
    const isFirstLaunch = await userAgent.firstLaunch();
    const password = await resolvePassword(ctx, undefined, isFirstLaunch);
    await ensureVaultReady({ userAgent, emitter, password, isFirstLaunch });

    // 2. Normalize protocol requests.
    const permissionRequests = normalizeProtocolRequests(options?.protocols);

    // 3. Resolve the handler.
    const handler = options?.connectHandler ?? this._connectHandler;
    if (!handler) {
      throw new Error(
        '[@enbox/auth] No connect handler provided. ' +
        'Install @enbox/browser and pass BrowserConnectHandler(), ' +
        'or provide a custom ConnectHandler.'
      );
    }

    // 4. Delegate to the handler.
    const result = await handler.requestAccess({ permissionRequests });
    if (!result) {
      throw new Error('[@enbox/auth] Connect was denied or cancelled by the user.');
    }

    // 5. Import delegate DID, process grants, set up sync.
    const {
      delegatePortableDid, connectedDid, delegateGrants, delegateDecryptionKeys,
      delegateContextKeys, delegateMultiPartyProtocols, sessionRevocations,
    } = result;
    const identity = await importDelegateAndSetupSync({
      userAgent, delegatePortableDid, connectedDid, delegateGrants,
      delegateDecryptionKeys, delegateContextKeys, delegateMultiPartyProtocols,
      sessionRevocations,
      flowName: 'Connect',
    });

    // 6. Finalize session.
    return finalizeDelegateSession({
      userAgent, emitter, storage, identity,
      connectedDid, delegateDid: delegatePortableDid.uri, sync,
    });
  }

  /**
   * Build a `FlowContext` from the manager's current state.
   *
   * Replaces the 5 manual inline context constructions that were
   * previously duplicated across `connect()`, `walletConnect()`,
   * `importFromPhrase()`, `importFromPortable()`, and `restoreSession()`.
   */
  private _flowContext(): FlowContext {
    return {
      userAgent           : this._userAgent,
      emitter             : this._emitter,
      storage             : this._storage,
      defaultPassword     : this._defaultPassword,
      passwordProvider    : this._passwordProvider,
      defaultSync         : this._defaultSync,
      defaultDwnEndpoints : this._defaultDwnEndpoints,
      registration        : this._registration,
    };
  }

  /**
   * Template for connection flows that follow the guard → try/finally → setState pattern.
   *
   * Consolidates the duplicated concurrency guard, `_isConnecting` flag management,
   * session assignment, and state transition across `connect()`, `walletConnect()`,
   * `importFromPhrase()`, and `importFromPortable()`.
   */
  private async _withConnect(fn: () => Promise<AuthSession>): Promise<AuthSession> {
    this._guardConcurrency();
    this._isConnecting = true;

    try {
      const session = await fn();
      this._session = session;
      this._setState('connected');
      return session;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Derive the protocol list for a delegate's sync scope by querying
   * stored grant records and extracting their `scope.protocol` fields.
   *
   * Returns a deduplicated array of protocol URIs, excluding the DWN
   * permissions protocol itself (the delegate doesn't need to sync
   * grant records — they're imported locally during the connect flow).
   */
  private async _deriveProtocolsFromGrants(delegateDid: string): Promise<string[]> {
    const response = await this._userAgent.processDwnRequest({
      author        : delegateDid,
      target        : delegateDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : PermissionsProtocol.uri,
          protocolPath : PermissionsProtocol.grantPath,
        },
      },
    });

    const protocols: string[] = [];
    if (response.reply.status.code === 200 && response.reply.entries) {
      for (const entry of response.reply.entries as DwnDataEncodedRecordsWriteMessage[]) {
        const grant = DwnPermissionGrant.parse(entry);
        const scopeProtocol = (grant.scope as any).protocol as string | undefined;
        if (scopeProtocol && scopeProtocol !== PermissionsProtocol.uri) {
          protocols.push(scopeProtocol);
        }
      }
    }

    return [...new Set(protocols)];
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
    protocols: string[],
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
