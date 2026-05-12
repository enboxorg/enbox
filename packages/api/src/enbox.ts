/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { DidMethodResolver } from '@enbox/dids';
import type { EnboxAgent } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { AuthManagerOptions, AuthSession, ConnectOptions } from '@enbox/auth';

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
 * Options for creating an anonymous (read-only) Enbox instance via {@link Enbox.anonymous}.
 *
 * @beta
 */
export type EnboxAnonymousOptions = {
  /** Override the default DID method resolvers. Defaults to `[DidDht, DidJwk, DidKey, DidWeb]`. */
  didResolvers?: DidMethodResolver[];
};

/**
 * The result of calling {@link Enbox.anonymous}.
 *
 * Contains only a read-only `dwn` property — no `did`, `vc`, or `agent`.
 *
 * @beta
 */
export type EnboxAnonymousApi = {
  /** A read-only DWN API for querying public data on remote DWNs. */
  dwn: DwnReaderApi;
};

/**
 * Parameters for constructing an {@link Enbox} instance.
 *
 * These are the minimal primitives needed to interact with the DWN network.
 * Typically obtained from an agent session via `@enbox/auth`.
 */
export type EnboxParams = {
  /**
   * A {@link EnboxAgent} instance that handles DIDs, DWNs and VCs requests. The agent manages the
   * user keys and identities, and is responsible to sign and verify messages.
   */
  agent: EnboxAgent;

  /** The DID of the tenant under which all DID, DWN, and VC requests are being performed. */
  connectedDid: string;

  /** The DID that will be signing messages using grants from the connectedDid. */
  delegateDid?: string;
};

/**
 * Session-shaped parameters accepted by {@link Enbox.fromSession} and
 * {@link Enbox.connect}.
 *
 * This is structural so callers can pass an `AuthSession` from `@enbox/auth`,
 * an `AgentSession` from `@enbox/agent`, or any compatible custom session.
 */
export type EnboxSessionParams = {
  /** The authenticated Enbox agent managing keys, DIDs, and DWN access. */
  agent: EnboxAgent;

  /** The DID of the tenant under which all requests are performed. */
  did: string;

  /** The DID that will sign messages using grants from the connected DID. */
  delegateDid?: string;
};

/** Legacy object wrapper for passing a session into {@link Enbox.connect}. */
export type EnboxSessionWrapper = {
  /** An active agent/auth session. */
  session: EnboxSessionParams;
};

/** Existing connection inputs that can be adapted synchronously. */
export type EnboxConnectionInput = EnboxParams | EnboxSessionParams | EnboxSessionWrapper;

/**
 * High-level connection options for {@link Enbox.connect}.
 *
 * Options are split internally between `AuthManager.create()` and
 * `auth.connect()`. For advanced flows, pass an explicit `connect` object to
 * control the exact `AuthManager.connect()` options.
 */
export type EnboxConnectOptions = AuthManagerOptions & ConnectOptions & {
  /** Explicit options to pass to `AuthManager.connect()`. */
  connect?: ConnectOptions;
};

/** The result of a high-level asynchronous {@link Enbox.connect} call. */
export type EnboxConnectResult = {
  /** The AuthManager that owns the session lifecycle. */
  auth: AuthManager;

  /** The high-level Enbox API instance. */
  enbox: Enbox;

  /** The active session returned by `AuthManager.connect()`. */
  session: AuthSession;
};

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
   * @param timeout - Maximum milliseconds to wait for an in-progress sync
   *   cycle to finish before force-stopping. Defaults to `2000`.
   *
   * @example
   * ```ts
   * await enbox.disconnect();
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
   * calls `auth.connect()`, and returns `{ auth, session, enbox }`.
   *
   * Existing synchronous forms remain supported for compatibility. Prefer
   * {@link Enbox.fromSession} or {@link Enbox.from} in new custom-session code.
   *
   * @example
   * ```ts
   * // Common app flow
   * const { enbox, session } = await Enbox.connect({ createIdentity: true });
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
    const session = await auth.connect(Enbox.toAuthConnectOptions(options));
    const enbox = Enbox.fromSession(session);

    return { auth, enbox, session };
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

    Enbox.copyDefined(options, connectOptions, [
      'password',
      'recoveryPhrase',
      'sync',
      'dwnEndpoints',
      'metadata',
      'createIdentity',
      'protocols',
      'connectHandler',
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
}
