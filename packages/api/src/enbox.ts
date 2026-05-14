/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { EnboxAgent } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { AuthManagerOptions, ConnectOptions } from '@enbox/auth';

import type {
  EnboxAnonymousApi,
  EnboxAnonymousOptions,
  EnboxConnectionInput,
  EnboxConnectOptions,
  EnboxConnectResult,
  EnboxParams,
  EnboxSessionParams,
  EnboxSessionWrapper,
} from './enbox-types.js';
import type { SchemaMap, TypedProtocol } from './protocol-types.js';

import { AnonymousDwnApi } from '@enbox/agent';
import { AuthManager } from '@enbox/auth/auth-manager';
import { EnboxRpcClient } from '@enbox/dwn-clients';
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';

import { DidApi } from './did-api.js';
import { DwnApi } from './dwn-api.js';
import { DwnReaderApi } from './dwn-reader-api.js';
import { TypedEnbox } from './typed-enbox.js';
import { VcApi } from './vc-api.js';

/**
 * The main Enbox API interface. It provides protocol-scoped access to
 * Decentralized Web Nodes (DWNs), Decentralized Identifiers (DIDs),
 * and Verifiable Credentials (VCs).
 *
 * For common app flows, use the asynchronous {@link Enbox.connect} helper.
 * For custom auth/session flows, use {@link Enbox.fromSession} or
 * {@link Enbox.from} with existing session primitives.
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
   * A {@link EnboxAgent} instance that handles DIDs, DWNs and VCs requests. The agent manages the
   * user keys and identities, and is responsible to sign and verify messages.
   */
  public agent: EnboxAgent;

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
   * Stops DWN sync and clears the cached {@link TypedEnbox} instances.
   *
   * Call this when the application is shutting down or the user is
   * disconnecting to cleanly release background resources. After calling
   * `disconnect()`, the `Enbox` instance should not be reused.
   *
   * This method only tears down the Enbox-side state. When the instance was
   * created via the async {@link Enbox.connect} flow, the returned
   * `AuthManager` owns the vault and storage handles — call
   * `auth.shutdown()` (or `auth.disconnect()` to keep the vault) in addition
   * to `enbox.disconnect()` for a clean shutdown.
   *
   * @param timeout - Maximum milliseconds to wait for an in-progress sync
   *   cycle to finish before force-stopping. Defaults to `2000`.
   *
   * @example
   * ```ts
   * // Full teardown when using the async Enbox.connect() flow
   * const { enbox, auth } = await Enbox.connect({ createIdentity: true });
   * // ...
   * await enbox.disconnect();
   * await auth.shutdown();
   * ```
   *
   * @beta
   */
  public async disconnect(timeout?: number): Promise<void> {
    // Stop any active sync.
    if ('sync' in this.agent && typeof (this.agent as any).sync?.stopSync === 'function') {
      await (this.agent as any).sync.stopSync(timeout);
    }

    // Clear cached TypedEnbox instances so they are not accidentally reused.
    this._typedInstances.clear();
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
   * Creates an {@link Enbox} instance from raw agent + DID parameters.
   *
   * Use this when you own the agent and connected DID lifecycle yourself.
   */
  public static from(params: EnboxParams): Enbox {
    return new Enbox(params);
  }

  /**
   * Creates an {@link Enbox} instance from a session-shaped object.
   *
   * Accepts `AuthSession`, `AgentSession`, or any compatible custom session
   * with `{ agent, did, delegateDid? }`.
   */
  public static fromSession(session: EnboxSessionParams): Enbox {
    return new Enbox({
      agent        : session.agent,
      connectedDid : session.did,
      delegateDid  : session.delegateDid,
    });
  }

  /**
   * Creates an {@link Enbox} API from high-level auth options, an existing
   * session, or raw agent parameters.
   *
   * With no existing session/raw parameters, this creates an `AuthManager`,
   * calls `auth.connect()`, and returns `{ auth, session, enbox }`. When the
   * input matches a sync shape, the method returns an `Enbox` instance
   * synchronously without touching `AuthManager`.
   *
   * **Sync vs async dispatch.** Input is routed by checking, in order,
   * `session`, `connectedDid`, and `did`. The first match wins and any
   * unrelated keys on the input are **silently ignored** — for example,
   * `Enbox.connect({ agent, connectedDid, password })` returns synchronously
   * via {@link Enbox.from} and the `password` never reaches `AuthManager`.
   * If you need to combine raw/session inputs with auth options, prefer
   * {@link Enbox.from} / {@link Enbox.fromSession} for the sync case and use
   * the async `Enbox.connect({...})` form (no `session`/`connectedDid`/`did`)
   * with an explicit `connect` slot for the auth case.
   *
   * **Handler vs local routing (async path).** When the input contains both
   * handler signals (`protocols`, `connectHandler`) and local-style defaults
   * (`password`, `dwnEndpoints`, `metadata`, `createIdentity`,
   * `recoveryPhrase`), handler routing wins: the local-only keys are forwarded
   * to `AuthManager.create()` as manager-wide defaults but are stripped from
   * the per-call `auth.connect()` options so the handler flow runs. Pass an
   * explicit `connect` slot to override this normalization.
   *
   * Existing synchronous forms remain supported for compatibility. Prefer
   * {@link Enbox.fromSession} or {@link Enbox.from} in new custom-session code.
   *
   * @example
   * ```ts
   * // Common app flow
   * const { enbox, session, auth } = await Enbox.connect({ createIdentity: true });
   * // ...
   * await enbox.disconnect();
   * await auth.shutdown(); // release vault + storage handles
   *
   * // Existing session
   * const enbox = Enbox.fromSession(session);
   *
   * // Using raw parameters
   * const enbox = Enbox.from({ agent, connectedDid: did });
   * ```
   */
  public static connect(params: EnboxSessionWrapper): Enbox;
  public static connect(params: EnboxParams): Enbox;
  public static connect(session: EnboxSessionParams): Enbox;
  public static connect(options?: EnboxConnectOptions): Promise<EnboxConnectResult>;
  public static connect(params?: EnboxConnectionInput | EnboxConnectOptions): Enbox | Promise<EnboxConnectResult> {
    if (params === undefined) {
      return Enbox.createConnection({});
    }

    if ('session' in params) {
      return Enbox.fromSession(params.session);
    }

    if ('connectedDid' in params) {
      return Enbox.from(params);
    }

    if ('did' in params) {
      return Enbox.fromSession(params);
    }

    return Enbox.createConnection(params);
  }

  private static async createConnection(options: EnboxConnectOptions): Promise<EnboxConnectResult> {
    const auth = await AuthManager.create(Enbox.toAuthManagerOptions(options));

    try {
      const session = await auth.connect(Enbox.toAuthConnectOptions(options));
      const enbox = Enbox.fromSession(session);

      return { auth, enbox, session };
    } catch (error: unknown) {
      try {
        await auth.shutdown();
      } catch {
        // Preserve the original connection failure.
      }
      throw error;
    }
  }

  private static toAuthManagerOptions(options: EnboxConnectOptions): AuthManagerOptions {
    const authOptions: AuthManagerOptions = {};

    Enbox.copyDefined(options, authOptions, [
      'agent',
      'agentVault',
      'localDwnStrategy',
      'dataPath',
      'storage',
      'password',
      'passwordProvider',
      'sync',
      'dwnEndpoints',
      'registration',
      'connectHandler',
    ]);

    return authOptions;
  }

  private static toAuthConnectOptions(options: EnboxConnectOptions): ConnectOptions | undefined {
    if (options.connect !== undefined) {
      return options.connect;
    }

    const connectOptions: Record<string, unknown> = {};

    // When handler signals are present, forward only handler-relevant keys
    // so the per-call options remain minimal and semantically clean. Local
    // defaults like `password`, `dwnEndpoints`, and `metadata` are still
    // forwarded to `AuthManager.create()` as manager-wide defaults via
    // `toAuthManagerOptions`. This also serves as defense in depth against
    // any future regression in `AuthManager._isLocalConnect()` routing
    // precedence: stripping local-only keys here guarantees the handler
    // flow regardless of how the manager interprets mixed signals.
    if (Enbox.hasDefined(options, ['protocols', 'connectHandler'])) {
      Enbox.copyDefined(options, connectOptions, [
        'protocols',
        'connectHandler',
        'sync',
      ]);

      return connectOptions as ConnectOptions;
    }

    // `password`, `sync`, and `dwnEndpoints` are intentionally copied to both
    // `AuthManager.create()` (via toAuthManagerOptions) and local
    // `auth.connect()` calls (here). The former sets manager-wide defaults;
    // the latter applies per-call overrides, which keeps behavior consistent
    // for restored sessions and avoids drift between the active call and the
    // manager's configured defaults.
    Enbox.copyDefined(options, connectOptions, [
      'password',
      'recoveryPhrase',
      'sync',
      'dwnEndpoints',
      'metadata',
      'createIdentity',
    ]);

    return Object.keys(connectOptions).length === 0
      ? undefined
      : connectOptions as ConnectOptions;
  }

  private static copyDefined<TTarget extends object>(
    source: object,
    target: TTarget,
    keys: string[],
  ): void {
    const sourceRecord = source as Record<string, unknown>;
    const targetRecord = target as Record<string, unknown>;

    for (const key of keys) {
      if (sourceRecord[key] !== undefined) {
        targetRecord[key] = sourceRecord[key];
      }
    }
  }

  private static hasDefined(source: object, keys: string[]): boolean {
    const sourceRecord = source as Record<string, unknown>;

    return keys.some(key => sourceRecord[key] !== undefined);
  }
}
