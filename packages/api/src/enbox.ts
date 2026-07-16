/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { EnboxPlatformAgent } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  AuthManagerOptions,
  AuthSession,
  ConnectionStatus,
  ConnectionStatusGrant,
  ConnectOptions,
  GetConnectionStatusOptions,
  HandlerConnectOptions,
  RefreshOptions,
  VaultConnectOptions,
} from '@enbox/auth';

import type {
  EnboxAnonymousApi,
  EnboxAnonymousOptions,
  EnboxConnectOptions,
  EnboxConnectResult,
  EnboxParams,
  EnboxSessionParams,
} from './enbox-types.js';
import type { SchemaMap, TypedProtocol } from './protocol-types.js';

import { AnonymousDwnApi } from '@enbox/agent';
import { AuthManager } from '@enbox/auth/auth-manager';
import { EnboxRpcClient } from '@enbox/dwn-clients';
import { omitUndefined } from '@enbox/common';
import { computeConnectionStatus, reconcileConnectionStatusGrants } from '@enbox/auth';
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';

import { DidApi } from './did-api.js';
import { DwnApi } from './dwn-api.js';
import { DwnReaderApi } from './dwn-reader-api.js';
import { TypedEnbox } from './typed-enbox.js';
import { VcApi } from './vc-api.js';

/**
 * Module-level registry of in-flight {@link Enbox.connect} calls, keyed by
 * the resolved data path (or a sentinel for "default path").
 *
 * `AuthManager.create()` opens LevelDB handles at the agent's `dataPath`;
 * LevelDB enforces an exclusive lock per directory, so two parallel
 * `Enbox.connect()` invocations on the same path would race on the lock
 * and surface a cryptic `LEVEL_LOCKED` error to the caller. The registry
 * detects the race at the API boundary and throws a clear, domain-level
 * error instead. Custom `storage` adapters that don't share a path with
 * the agent's vault can still race below this guard — but for the default
 * path that every dapp uses, this catches the common case.
 */
const DEFAULT_DATA_PATH_KEY = '\x00default\x00';
const inflightConnects = new Map<string, Promise<unknown>>();

/**
 * The main Enbox API interface. It provides protocol-scoped access to
 * Decentralized Web Nodes (DWNs), Decentralized Identifiers (DIDs),
 * and Verifiable Credentials (VCs).
 *
 * For common app flows, use the asynchronous {@link Enbox.connect} helper.
 * For custom auth/session flows, use {@link Enbox.fromSession} with an
 * existing session, or the public constructor with raw `{ agent, connectedDid }`.
 *
 * @example
 * ```ts
 * import { Enbox } from '@enbox/api';
 *
 * const { enbox } = await Enbox.connect({
 *   createIdentity: true,
 *   sync: '15s',
 * });
 *
 * const social = enbox.using(SocialProtocol);
 * ```
 */
export class Enbox {
  /**
   * The {@link EnboxPlatformAgent} this instance is bound to. The platform
   * agent handles DIDs, DWN access, signing keys, and DWN sync — every
   * Enbox session needs all of those, so the type is narrower than the
   * minimal {@link EnboxAgent} interface and the constructor refuses
   * non-platform agents at compile time.
   */
  public agent: EnboxPlatformAgent;

  /** Exposed instance to the DID APIs, allow users to create and resolve DIDs. */
  public did: DidApi;

  /** Internal DWN API instance. Use {@link Enbox.using} for protocol-scoped access. */
  private readonly _dwn: DwnApi;

  /** Connected owner DID used by delegated-session status checks. */
  private readonly _connectedDid: string;

  /** Delegate DID used by this instance, when operating under delegated grants. */
  private readonly _delegateDid?: string;

  /**
   * Cache of {@link TypedEnbox} instances keyed by protocol URI.
   *
   * Ensures that `enbox.using(Protocol)` returns the **same** `TypedEnbox`
   * instance for a given protocol across multiple call sites, avoiding
   * redundant protocol installations and duplicated internal state.
   */
  private readonly _typedInstances = new Map<string, TypedEnbox<ProtocolDefinition, SchemaMap>>();

  /** Exposed instance to the VC APIs, allow users to issue, present and verify VCs. */
  public vc: VcApi;

  /**
   * The `AuthManager` this instance owns and is responsible for tearing down
   * during {@link Enbox.disconnect}. Set only by the async
   * {@link Enbox.connect} factory; never populated by the public constructor
   * or {@link Enbox.fromSession}.
   */
  private _ownedAuth?: AuthManager;

  /** Auth manager backing instances created by {@link Enbox.connect}. */
  private _auth?: AuthManager;

  /**
   * Memoized teardown promise. Two parallel `enbox.disconnect()` calls
   * share the same promise so `agent.sync.stopSync()` (and the optional
   * `auth.shutdown()`) run exactly once even when callers fire the
   * teardown from independent code paths.
   */
  private _disconnecting?: Promise<void>;

  constructor({ agent, connectedDid, delegateDid }: EnboxParams) {
    this.agent = agent;
    this.did = new DidApi({ agent, connectedDid });
    this._dwn = new DwnApi({ agent, connectedDid, delegateDid, permissionsApi: agent.permissions });
    this._connectedDid = connectedDid;
    this._delegateDid = delegateDid;
    this.vc = new VcApi({ agent, connectedDid });
  }

  /**
   * Returns the lifecycle state of the newest delegated connect approval.
   *
   * Expiry is computed from the grants stored locally for the current owner
   * and delegate. Revocation detection is best-effort and reflects revocation
   * records that have reached the local agent.
   */
  public async getConnectionStatus(options: GetConnectionStatusOptions = {}): Promise<ConnectionStatus> {
    const auth = this._auth;
    const authSession = auth?.session;
    if (authSession?.did === this._connectedDid && authSession.delegateDid === this._delegateDid) {
      return auth.getConnectionStatus(options);
    }
    if (this._delegateDid === undefined) {
      return { state: 'none' };
    }

    const query = {
      author  : this._delegateDid,
      grantor : this._connectedDid,
      grantee : this._delegateDid,
    };
    const [ownerGrantEntries, activeOwnerGrantEntries, delegateGrantEntries] = await Promise.all([
      this.agent.permissions.fetchGrants({ ...query, target: this._connectedDid }),
      options.checkRevoked === false
        ? Promise.resolve(undefined)
        : this.agent.permissions.fetchGrants({
          ...query,
          target       : this._connectedDid,
          checkRevoked : true,
        }),
      this.agent.permissions.fetchGrants({ ...query, target: this._delegateDid }),
    ]);
    const activeOwnerGrantIds = activeOwnerGrantEntries === undefined
      ? undefined
      : new Set<string>(activeOwnerGrantEntries.map(({ grant }) => grant.id as string));
    const toStatusGrant = ({ grant }: typeof ownerGrantEntries[number]): ConnectionStatusGrant => ({
      id             : grant.id,
      grantor        : grant.grantor,
      grantee        : grant.grantee,
      dateExpires    : grant.dateExpires,
      connectSession : grant.connectSession,
    });
    const grants = reconcileConnectionStatusGrants({
      ownerGrants    : ownerGrantEntries.map(toStatusGrant),
      delegateGrants : delegateGrantEntries.map(toStatusGrant),
      activeOwnerGrantIds,
    });

    return computeConnectionStatus(grants, {
      expiringSoonThresholdSeconds: options.expiringSoonThresholdSeconds,
    });
  }

  /**
   * Re-grants the current delegated session to the same delegate DID.
   *
   * This convenience method is available on instances returned by
   * {@link Enbox.connect}. Instances created with the constructor or
   * {@link Enbox.fromSession} should call `refresh()` on their owning
   * `AuthManager` instead.
   */
  public async refresh(options: RefreshOptions): Promise<AuthSession> {
    const auth = this._auth;
    if (auth === undefined) {
      throw new Error(
        '[@enbox/api] Enbox.refresh() requires the AuthManager used to create this session. ' +
        'Call auth.refresh(...) on the owning AuthManager.'
      );
    }
    const authSession = auth.session;
    if (authSession?.did !== this._connectedDid || authSession.delegateDid !== this._delegateDid) {
      throw new Error(
        '[@enbox/api] Enbox.refresh() cannot use an AuthManager whose active session no longer matches this Enbox instance.'
      );
    }

    return auth.refresh(options);
  }

  /**
   * Re-resolve the connected identity's DID document and apply any change to
   * its DWN service endpoints — without a disconnect/reconnect.
   *
   * Forces a fresh resolution of the connected DID (bypassing the resolver
   * cache), invalidates the sync engine's memoized endpoint list, and — when
   * the endpoint set changed — causes the owning `AuthManager` to emit
   * `connection-endpoints-changed`. Unlike {@link Enbox.refresh}, no grants are
   * re-issued and there is no wallet round-trip.
   *
   * Available on instances returned by {@link Enbox.connect}. Instances created
   * with the constructor or {@link Enbox.fromSession} should call
   * `refreshConnection()` on their owning `AuthManager` instead.
   *
   * @returns The freshly resolved DWN endpoint set for the connected identity.
   */
  public async refreshConnection(): Promise<string[]> {
    const auth = this._auth;
    if (auth === undefined) {
      throw new Error(
        '[@enbox/api] Enbox.refreshConnection() requires the AuthManager used to create this session. ' +
        'Call auth.refreshConnection() on the owning AuthManager.'
      );
    }
    const authSession = auth.session;
    if (authSession?.did !== this._connectedDid || authSession.delegateDid !== this._delegateDid) {
      throw new Error(
        '[@enbox/api] Enbox.refreshConnection() cannot use an AuthManager whose active session no longer matches this Enbox instance.'
      );
    }

    return auth.refreshConnection();
  }

  /**
   * Returns a {@link TypedEnbox} instance scoped to the given protocol.
   *
   * This is the **primary developer interface** for interacting with
   * protocol-backed records. It auto-injects the protocol URI, protocolPath,
   * and schema into every operation, and provides compile-time path
   * autocompletion plus typed data payloads via the schema map.
   *
   * Instances are **cached by protocol URI** — calling `using()` multiple
   * times with the same protocol returns the same `TypedEnbox` instance,
   * so auto-configure only runs once and all call sites share state.
   *
   * @param protocol - A typed protocol created via `defineProtocol()`.
   * @returns A `TypedEnbox` instance bound to the given protocol.
   *
   * @example
   * ```ts
   * const social = enbox.using(SocialProtocol);
   *
   * await social.configure();
   *
   * const { record } = await social.records.write('friend', {
   *   data: { did: 'did:example:alice', alias: 'Alice' },
   * });
   *
   * const { records } = await social.records.query('friend');
   * ```
   */
  public using<D extends ProtocolDefinition, M extends SchemaMap>(
    protocol: TypedProtocol<D, M>,
  ): TypedEnbox<D, M> {
    const uri = protocol.definition.protocol;
    const cached = this._typedInstances.get(uri);

    if (cached) {
      // The map stores a type-erased instance; restore the caller's generics.
      return cached as unknown as TypedEnbox<D, M>;
    }

    const instance = new TypedEnbox<D, M>(this._dwn, protocol);
    // Store with erased generics so the map value type stays uniform.
    this._typedInstances.set(uri, instance as unknown as TypedEnbox<ProtocolDefinition, SchemaMap>);
    return instance;
  }

  /**
   * Signs the user out and releases resources held by this Enbox instance.
   *
   * When this instance owns the underlying `AuthManager` (i.e. it was
   * created via `Enbox.connect()` with no caller-supplied `agent`), the
   * disconnect proceeds in three phases:
   *
   *   1. **Stop sync** — `agent.sync.stopSync(timeout)` halts the DWN
   *      sync engine. Always runs, regardless of ownership.
   *   2. **Sign out** — `AuthManager.disconnect()` sends delegate-grant
   *      revocations to the connected DWN endpoints, clears session
   *      restore markers (PREVIOUSLY_CONNECTED, ACTIVE_IDENTITY,
   *      delegate keys, etc.) from the StorageAdapter, and clears the
   *      in-memory delegate decryption key cache. **Without this step
   *      a later `Enbox.connect()` would silently restore the
   *      supposedly signed-out session from the persisted markers.**
   *   3. **Release resources** — `AuthManager.shutdown()` locks the
   *      vault, closes the sync engine, and closes the StorageAdapter.
   *
   * When the instance was created from a caller-owned session
   * ({@link Enbox.fromSession}), a raw agent (the public constructor),
   * or `Enbox.connect({ agent })`, only step 1 (stop sync) runs — the
   * caller's AuthManager / agent keep their lifecycle. The caller is
   * responsible for calling `auth.disconnect()` and `auth.shutdown()`
   * on their own handle when they're done.
   *
   * Idempotent: parallel calls share the same teardown promise. After
   * calling `disconnect()`, the `Enbox` instance should not be reused.
   *
   * @param timeout - Maximum milliseconds to wait for an in-progress sync
   *   cycle to finish before force-stopping. Defaults to `2000`.
   *
   * @example
   * ```ts
   * // High-level flow: a single disconnect() does sign-out + teardown.
   * const { enbox } = await Enbox.connect({ createIdentity: true });
   * // ... user uses the app ...
   * await enbox.disconnect();   // revoke grants, clear markers, close vault
   *
   * // Caller-owned auth: enbox.disconnect() only stops Enbox-side state.
   * const auth = await AuthManager.create({...});
   * const session = await auth.connectVault({ createIdentity: true });
   * const enbox = Enbox.fromSession(session);
   * await enbox.disconnect();   // stops sync + clears typed-enbox cache
   * await auth.disconnect();    // sign-out: caller's responsibility
   * await auth.shutdown();      // close resources: caller's responsibility
   * ```
   *
   * @beta
   */
  public async disconnect(timeout?: number): Promise<void> {
    // Memoize so parallel calls share the same teardown promise. Without
    // this, two concurrent disconnect()s would each invoke
    // agent.sync.stopSync (idempotent, but redundant) and could race on
    // _ownedAuth ownership transfer.
    if (this._disconnecting !== undefined) {
      return this._disconnecting;
    }
    this._disconnecting = this._doDisconnect(timeout);
    return this._disconnecting;
  }

  private async _doDisconnect(timeout?: number): Promise<void> {
    await this.agent.sync.stopSync(timeout);

    // Clear cached TypedEnbox instances so they are not accidentally reused.
    this._typedInstances.clear();
    this._auth = undefined;

    // If this Enbox owns the AuthManager (created via Enbox.connect), the
    // sign-out + resource-teardown both fall on us:
    //
    //   1. `auth.disconnect()` — sign-out semantics: revoke delegate
    //      grants on the remote DWN, clear session restore markers
    //      (PREVIOUSLY_CONNECTED, ACTIVE_IDENTITY, delegate keys, etc.)
    //      from the StorageAdapter, and clear the in-memory delegate
    //      decryption key cache. MUST run while the agent's resources
    //      are still open (revocations need DWN access). Without this,
    //      a later `Enbox.connect()` would restore the supposedly
    //      signed-out session from the persisted markers.
    //   2. `auth.shutdown()` — resource teardown: lock the vault,
    //      close the sync engine, close the storage adapter. Runs
    //      after disconnect so revocation traffic completes first.
    //
    // Both are idempotent and best-effort; failures are logged but do
    // not propagate. We always attempt shutdown() even if disconnect()
    // throws, so resources still close.
    if (this._ownedAuth !== undefined) {
      const owned = this._ownedAuth;
      this._ownedAuth = undefined;
      try {
        await owned.disconnect({ timeout });
      } catch (error: unknown) {
        console.warn('[@enbox/api] Enbox.disconnect: AuthManager.disconnect() failed', error);
      }
      try {
        await owned.shutdown({ timeout });
      } catch (error: unknown) {
        console.warn('[@enbox/api] Enbox.disconnect: AuthManager.shutdown() failed', error);
      }
    }
  }

  /**
   * Creates a lightweight, read-only Enbox instance for querying public DWN data.
   *
   * No identity, vault, password, or signing keys are required. The returned
   * API supports querying and reading published records and protocols from any
   * remote DWN, using **unsigned** (anonymous) DWN messages.
   *
   * @param options - Optional configuration overrides.
   * @returns An {@link EnboxAnonymousApi} with a read-only `dwn` property.
   *
   * @example
   * ```ts
   * const { dwn } = Enbox.anonymous();
   *
   * const { records } = await dwn.records.query({
   *   from: 'did:dht:alice...',
   *   filter: { protocol: 'https://social.example/posts', protocolPath: 'post' },
   * });
   *
   * for (const record of records) {
   *   console.log(record.id, await record.data.text());
   * }
   * ```
   *
   * @beta
   */
  public static anonymous(options?: EnboxAnonymousOptions): EnboxAnonymousApi {
    const didResolver = new UniversalResolver({
      didResolvers : options?.didResolvers ?? [DidDht, DidJwk, DidKey, DidWeb],
      cache        : new DidResolverCacheMemory(),
    });

    const rpcClient = new EnboxRpcClient();
    const anonymousDwn = new AnonymousDwnApi({ didResolver, rpcClient });

    return {
      dwn: new DwnReaderApi(anonymousDwn),
    };
  }

  /**
   * Creates an {@link Enbox} instance from a session-shaped object.
   *
   * Accepts `AuthSession`, `AgentSession`, or any compatible custom session
   * with `{ agent, did, delegateDid? }`. This is the right entry point
   * whenever you already hold an active session — including ones produced by
   * a caller-managed `AuthManager`.
   *
   * For raw `{ agent, connectedDid }` access (no session shape), use the
   * public constructor directly: `new Enbox({ agent, connectedDid })`.
   */
  public static fromSession(session: EnboxSessionParams): Enbox {
    return new Enbox({
      agent        : session.agent,
      connectedDid : session.did,
      delegateDid  : session.delegateDid,
    });
  }

  /**
   * High-level entry point that creates an {@link AuthManager}, runs
   * `auth.connect()`, and returns the resulting `{ auth, session, enbox }`.
   *
   * For callers that already own an agent and DID, use the dedicated
   * synchronous entry points instead:
   * - `new Enbox({ agent, connectedDid })` for raw parameters
   * - {@link Enbox.fromSession} for session-shaped objects
   *
   * Routing happens at runtime inside `AuthManager.connect`: a recovery phrase
   * is treated as an explicit vault-restore action; otherwise, a non-empty
   * `protocols` array or a `connectHandler` selects the handler flow and
   * everything else routes to local. Local-style fields (`password`,
   * `dwnEndpoints`, etc.) are forwarded to both the manager (as defaults) and
   * the per-call payload, so behavior is consistent with restored sessions.
   *
   * If you need exact control of the `AuthManager.connect()` payload,
   * drop down one layer: create the `AuthManager` yourself with
   * `AuthManager.create()`, call `auth.connect(...)` with your exact
   * options, and pass the resulting session to `Enbox.fromSession`.
   *
   * @example
   * ```ts
   * const { enbox, session, auth } = await Enbox.connect({ createIdentity: true });
   * // ...
   * await enbox.disconnect();
   * await auth.shutdown(); // release vault + storage handles
   * ```
   */
  public static async connect(options: EnboxConnectOptions = {}): Promise<EnboxConnectResult> {
    // Cross-instance concurrency guard. `AuthManager.create()` opens the
    // agent's LevelDB at `options.dataPath` (or the platform default), and
    // LevelDB enforces an exclusive `LOCK` file per directory — two
    // parallel calls on the same path would otherwise race and surface
    // `LEVEL_LOCKED` as a low-level error. The guard / ownership flag
    // tracks one question only: did we build the underlying agent? If
    // `options.agent` is supplied the caller owns the agent's lifecycle
    // and on-disk handles, so we skip both the guard (no new dataPath
    // race) and ownership cleanup (`disconnect()` must not tear down
    // the caller's agent). A custom `storage` adapter alone is NOT a
    // basis for skipping — Enbox still builds an agent that opens
    // LevelDB handles at `dataPath`, and the storage adapter governs
    // session-persistence keys, not the agent vault.
    //
    // Limitation: the key is the raw `options.dataPath` string, not its
    // resolved on-disk location. Two callers — one with `dataPath`
    // omitted and another passing the explicit platform default
    // ('DATA/AGENT' in browser, '~/.enbox' in CLI) — refer to the same
    // directory but produce different keys, so the guard won't catch
    // that race. Resolving the path here would require pulling in the
    // platform-default logic from `@enbox/agent`, which we deliberately
    // avoid to keep the helper layered above the agent. Pick one
    // convention per app: always omit `dataPath`, or always set it
    // explicitly.
    const shouldGuard = options.agent === undefined;
    const key = options.dataPath ?? DEFAULT_DATA_PATH_KEY;

    if (shouldGuard && inflightConnects.has(key)) {
      throw new Error(
        `[@enbox/api] Enbox.connect() is already in progress for dataPath '${
          options.dataPath ?? '<default>'
        }'. Await the in-flight call before starting another, or pass a custom dataPath.`
      );
    }

    const run = async (): Promise<EnboxConnectResult> => {
      const auth = await AuthManager.create(Enbox.toAuthManagerOptions(options));

      try {
        const session = await auth.connect(Enbox.toAuthConnectOptions(options));
        const enbox = Enbox.fromSession(session);
        enbox._auth = auth;
        // Take AuthManager ownership ONLY when we built the agent
        // ourselves — `auth.shutdown()` will lock that agent's vault
        // and close its sync engine. If the caller supplied
        // `options.agent`, they retain agent ownership and must not
        // have its lifecycle resources torn down by
        // `enbox.disconnect()`. Callers that want explicit control
        // (e.g. their own storage adapter without their own agent)
        // can still grab the `auth` handle from the result and call
        // `auth.shutdown()` themselves; we always include it in the
        // returned `EnboxConnectResult`.
        if (shouldGuard) {
          enbox._ownedAuth = auth;
        }

        return { auth, enbox, session };
      } catch (error: unknown) {
        try {
          await auth.shutdown();
        } catch (shutdownError: unknown) {
          // Surface the recovery failure for diagnosis but preserve the
          // original connect rejection on the rethrow path below.
          console.warn(
            '[@enbox/api] Enbox.connect: auth.shutdown() failed during error recovery',
            shutdownError,
          );
        }
        throw error;
      }
    };

    if (!shouldGuard) {
      return run();
    }

    const promise = run();
    inflightConnects.set(key, promise);
    try {
      return await promise;
    } finally {
      inflightConnects.delete(key);
    }
  }

  /**
   * Split `EnboxConnectOptions` into the manager-wide defaults that
   * `AuthManager.create()` consumes.
   *
   * Implemented as an **explicit allowlist** for the same reason as
   * `toAuthConnectOptions`: a denylist would silently leak future
   * `HandlerConnectOptions` / `VaultConnectOptions` fields into the
   * manager-default record. The `satisfies Partial<AuthManagerOptions>`
   * annotation makes the compiler verify every key in the allowlist
   * exists on `AuthManagerOptions`, so a misspelled or stale field name
   * is a type error.
   */
  private static toAuthManagerOptions(options: EnboxConnectOptions): AuthManagerOptions {
    // Explicit allowlist — every key must exist on `AuthManagerOptions`
    // (verified by `satisfies` below).
    const allowlisted = {
      agent                 : options.agent,
      agentVault            : options.agentVault,
      localDwnStrategy      : options.localDwnStrategy,
      dataPath              : options.dataPath,
      storage               : options.storage,
      password              : options.password,
      passwordProvider      : options.passwordProvider,
      sync                  : options.sync,
      identitySyncProtocols : options.identitySyncProtocols,
      dwnEndpoints          : options.dwnEndpoints,
      registration          : options.registration,
      connectHandler        : options.connectHandler,
    } satisfies Partial<AuthManagerOptions>;
    return omitUndefined(allowlisted);
  }

  /**
   * Split `EnboxConnectOptions` into the per-call payload that
   * `AuthManager.connect()` consumes.
   *
   * Implemented as an **explicit allowlist** of the fields declared on
   * {@link HandlerConnectOptions} ∪ {@link VaultConnectOptions}. A
   * denylist (strip manager-only fields, forward the rest) would
   * silently leak any future `AuthManagerOptions` field into
   * `AuthManager.connect()`; the allowlist makes the type boundary
   * explicit and the leak impossible. The trade-off is symmetric:
   * any new connect-options field requires an edit here. That's
   * acceptable — it's the same edit the public `ConnectOptions` type
   * already needs, just on one extra line.
   *
   * The `satisfies Partial<ConnectOptions>` annotation makes the
   * compiler verify every key in the allowlist exists on `ConnectOptions`,
   * so misspelling a field name is a type error rather than a silent
   * drop. Routing between restore, local, and handler flow happens inside
   * `AuthManager.connect`.
   *
   * `protocols: []` is normalized away — an empty array carries no
   * permission intent and would otherwise produce a zero-grant
   * "connected" handler session indistinguishable from a denied connect.
   */
  private static toAuthConnectOptions(options: EnboxConnectOptions): ConnectOptions | undefined {
    // Explicit allowlist — every key must exist on the
    // `ConnectOptions` union (verified by `satisfies` below).
    const allowlisted = {
      // Shared across handler + local
      password              : options.password,
      sync                  : options.sync,
      identitySyncProtocols : options.identitySyncProtocols,
      dwnEndpoints          : options.dwnEndpoints,
      // Handler-only
      protocols             : options.protocols,
      connectHandler        : options.connectHandler,
      // Local-only
      recoveryPhrase        : options.recoveryPhrase,
      createIdentity        : options.createIdentity,
      metadata              : options.metadata,
    } satisfies Partial<HandlerConnectOptions & VaultConnectOptions>;

    // Normalize `protocols: []` to undefined so omitUndefined strips it.
    const normalized = (Array.isArray(allowlisted.protocols) && allowlisted.protocols.length === 0)
      ? { ...allowlisted, protocols: undefined }
      : allowlisted;

    const cleaned = omitUndefined(normalized);
    return Object.keys(cleaned).length === 0 ? undefined : cleaned;
  }
}
