/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { EnboxPlatformAgent } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { AuthManagerOptions, ConnectOptions } from '@enbox/auth';

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
    this._dwn = new DwnApi({ agent, connectedDid, delegateDid });
    this.vc = new VcApi({ agent, connectedDid });
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
   * Stops DWN sync, clears the cached {@link TypedEnbox} instances, and (if
   * this instance was created via the async {@link Enbox.connect} factory)
   * shuts down the underlying `AuthManager` so vault and storage handles are
   * released. After calling `disconnect()`, the `Enbox` instance should not
   * be reused.
   *
   * **`agent.sync.stopSync()` is always called**, even when the instance
   * was created from a caller-owned session ({@link Enbox.fromSession}),
   * a raw agent (the public constructor), or a pre-built agent passed to
   * `Enbox.connect({ agent })`. Stopping sync is the work Enbox does
   * with the agent; the caller-supplied case still needs that work
   * undone. The `auth.shutdown()` step (vault + storage handles) is
   * **only** invoked when Enbox built the agent itself — caller-supplied
   * agents and storage adapters keep their lifecycle.
   *
   * Idempotent: parallel calls share the same teardown promise.
   *
   * @param timeout - Maximum milliseconds to wait for an in-progress sync
   *   cycle to finish before force-stopping. Defaults to `2000`.
   *
   * @example
   * ```ts
   * // High-level flow: a single disconnect() does the full teardown.
   * const { enbox } = await Enbox.connect({ createIdentity: true });
   * await enbox.disconnect();
   *
   * // Caller-owned auth: enbox.disconnect() stops sync + clears cache.
   * // The caller-built AuthManager is NOT shut down by enbox.disconnect()
   * // — call auth.shutdown() yourself when you're done.
   * const auth = await AuthManager.create({...});
   * const session = await auth.connect();
   * const enbox = Enbox.fromSession(session);
   * await enbox.disconnect();   // Enbox-side only (incl. agent.sync.stopSync)
   * await auth.shutdown();      // caller's responsibility
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

    // If this Enbox owns the AuthManager (created via Enbox.connect), tear
    // it down too — the caller has no other handle to release vault /
    // storage / sync handles. shutdown() is idempotent and best-effort, so
    // a failure here doesn't propagate; we surface it for diagnosis.
    if (this._ownedAuth !== undefined) {
      const owned = this._ownedAuth;
      this._ownedAuth = undefined;
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
   * Routing happens at runtime inside `AuthManager._isLocalConnect`:
   * presence of a non-empty `protocols` array or a `connectHandler` selects
   * the handler flow; everything else routes to local. Local-style fields
   * (`password`, `dwnEndpoints`, etc.) are forwarded to both the manager
   * (as defaults) and the per-call payload, so behavior is consistent with
   * restored sessions.
   *
   * Pass an explicit {@link EnboxConnectOptions.connectOverride} (non-empty)
   * to fully replace the auto-derived per-call payload.
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
    // `LEVEL_LOCKED` as a low-level error. Skip the guard when a custom
    // `storage` adapter is provided (it may use a different on-disk
    // surface than the agent vault) or a pre-built `agent` is supplied
    // (no new handles are opened).
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
    const shouldGuard = options.agent === undefined && options.storage === undefined;
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
        // Take AuthManager ownership ONLY when we built the agent and
        // storage ourselves — those are the lifecycle resources
        // `auth.shutdown()` will tear down. If the caller supplied
        // either `options.agent` or `options.storage`, they retain
        // ownership; `enbox.disconnect()` must not lock their vault or
        // close their storage handles behind their back. Callers using
        // a pre-built agent can still call `result.auth.shutdown()`
        // explicitly when they're done.
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
   * `AuthManager.create()` consumes by stripping out per-call signals.
   *
   * Implemented as a **denylist** rather than an allowlist: any new
   * field added to {@link AuthManagerOptions} flows through automatically
   * without needing a corresponding edit here. The fields removed below
   * are the only ones that don't belong on `AuthManagerOptions`.
   */
  private static toAuthManagerOptions(options: EnboxConnectOptions): AuthManagerOptions {
    const {
      // Per-call connect signals (handled by `toAuthConnectOptions`).
      protocols      : _protocols,
      recoveryPhrase : _recoveryPhrase,
      createIdentity : _createIdentity,
      metadata       : _metadata,
      // Override slot (handled by `toAuthConnectOptions`).
      connectOverride: _connectOverride,
      ...managerOptions
    } = options;
    return omitUndefined<AuthManagerOptions>(managerOptions);
  }

  /**
   * Split `EnboxConnectOptions` into the per-call payload that
   * `AuthManager.connect()` consumes.
   *
   * Honors an explicit {@link EnboxConnectOptions.connectOverride}
   * (non-empty after `undefined` keys are dropped) verbatim; otherwise
   * strips manager-only fields and forwards the rest. Routing between
   * local and handler flow happens inside `AuthManager._isLocalConnect`,
   * so this function intentionally doesn't pre-split — that lets new
   * connect options flow through without a coordinated edit here.
   *
   * An empty `connectOverride: {}` (or one whose keys are all
   * `undefined`) is treated as "no override" so callers can't
   * accidentally bypass a manager-level handler with a placeholder slot.
   */
  private static toAuthConnectOptions(options: EnboxConnectOptions): ConnectOptions | undefined {
    if (options.connectOverride !== undefined) {
      const overrideCleaned = omitUndefined(options.connectOverride);
      if (Object.keys(overrideCleaned).length > 0) {
        return overrideCleaned as ConnectOptions;
      }
      // All-`undefined` override → fall through to auto-derived routing.
    }

    const {
      // Manager-only fields are forwarded via `toAuthManagerOptions`.
      agent            : _agent,
      agentVault       : _agentVault,
      localDwnStrategy : _localDwnStrategy,
      dataPath         : _dataPath,
      storage          : _storage,
      passwordProvider : _passwordProvider,
      registration     : _registration,
      // Override slot (handled above).
      connectOverride  : _connectOverride,
      ...rest
    } = options;

    // Drop `protocols: []` — an empty array carries no handler intent
    // and would otherwise produce a zero-grant "connected" handler
    // session. Done by spreading into a new object with `protocols`
    // overridden to `undefined`, which `omitUndefined` then strips.
    // Keeps the helper purely functional (no `delete`).
    const restNormalized = (Array.isArray(rest.protocols) && rest.protocols.length === 0)
      ? { ...rest, protocols: undefined }
      : rest;

    const cleaned = omitUndefined(restNormalized);
    return Object.keys(cleaned).length === 0 ? undefined : (cleaned as ConnectOptions);
  }
}
