/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { AuthManagerOptions, ConnectOptions, HandlerConnectOptions, LocalConnectOptions } from '@enbox/auth';
import type { EnboxAgent, SyncEngine } from '@enbox/agent';

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
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';

import { DidApi } from './did-api.js';
import { DwnApi } from './dwn-api.js';
import { DwnReaderApi } from './dwn-reader-api.js';
import { TypedEnbox } from './typed-enbox.js';
import { VcApi } from './vc-api.js';

/**
 * Returns a new object containing only the entries of `input` whose values
 * are not `undefined`. Pure — never mutates the input.
 */
function omitUndefined<T extends object>(input: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(input) as (keyof T)[]) {
    const value = input[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Subset of {@link EnboxPlatformAgent} required to stop background sync. */
type AgentWithSync = { sync: Pick<SyncEngine, 'stopSync'> };

/**
 * Type guard for agents that expose the sync engine. The narrow
 * {@link EnboxAgent} interface does not declare `sync`, but every
 * platform agent shipped in this repo does. Isolating the duck-type check
 * here keeps the call site in {@link Enbox.disconnect} typed and cast-free.
 */
function hasSync(agent: EnboxAgent): agent is EnboxAgent & AgentWithSync {
  const sync = (agent as Partial<AgentWithSync>).sync;
  return typeof sync?.stopSync === 'function';
}

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
    if (hasSync(this.agent)) {
      await this.agent.sync.stopSync(timeout);
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
   * High-level entry point that creates an {@link AuthManager}, runs
   * `auth.connect()`, and returns the resulting `{ auth, session, enbox }`.
   *
   * For callers that already own an agent and DID, use the dedicated
   * synchronous factories instead:
   * - {@link Enbox.from} for raw `{ agent, connectedDid }` parameters
   * - {@link Enbox.fromSession} for session-shaped objects
   *
   * When `options` contains handler signals (`protocols` or `connectHandler`)
   * alongside local-style defaults (`password`, `dwnEndpoints`, `metadata`,
   * `createIdentity`, `recoveryPhrase`), handler routing wins: the local-only
   * keys are still forwarded to `AuthManager.create()` as manager-wide
   * defaults, but the per-call `auth.connect()` payload contains only the
   * handler-relevant keys. Pass an explicit `connect` slot to override that
   * normalization.
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
    return omitUndefined<AuthManagerOptions>({
      agent            : options.agent,
      agentVault       : options.agentVault,
      localDwnStrategy : options.localDwnStrategy,
      dataPath         : options.dataPath,
      storage          : options.storage,
      password         : options.password,
      passwordProvider : options.passwordProvider,
      sync             : options.sync,
      dwnEndpoints     : options.dwnEndpoints,
      registration     : options.registration,
      connectHandler   : options.connectHandler,
    });
  }

  private static toAuthConnectOptions(options: EnboxConnectOptions): ConnectOptions | undefined {
    if (options.connect !== undefined) {
      return options.connect;
    }

    const hasHandlerSignals =
      options.protocols !== undefined || options.connectHandler !== undefined;

    // Handler flow: forward only handler-relevant keys so the per-call
    // options stay semantically clean. Local-style keys are still forwarded
    // to `AuthManager.create()` via `toAuthManagerOptions` as manager-wide
    // defaults. This is also defense in depth against a future regression
    // in `AuthManager._isLocalConnect()` routing precedence.
    if (hasHandlerSignals) {
      return omitUndefined<HandlerConnectOptions>({
        protocols      : options.protocols,
        connectHandler : options.connectHandler,
        sync           : options.sync,
      });
    }

    // Local flow: `password`, `sync`, and `dwnEndpoints` are intentionally
    // forwarded to both `AuthManager.create()` (manager-wide defaults) and
    // here (per-call overrides), keeping behavior consistent for restored
    // sessions.
    const local = omitUndefined<LocalConnectOptions>({
      password       : options.password,
      recoveryPhrase : options.recoveryPhrase,
      sync           : options.sync,
      dwnEndpoints   : options.dwnEndpoints,
      metadata       : options.metadata,
      createIdentity : options.createIdentity,
    });

    return Object.keys(local).length === 0 ? undefined : local;
  }
}
