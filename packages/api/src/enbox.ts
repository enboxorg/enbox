/// <reference types="@enbox/dwn-sdk-js" />

import type { DwnEndpointResolution } from '@enbox/dids';
import type { EnboxPlatformAgent } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { ProtocolReadinessApi } from './protocol-readiness.js';
import type { RecordCodecMap } from './record-codec.js';
import type { RoleDeliveryState } from './typed-enbox.js';
import type { ContextRoleGroups, TypedProtocol } from './protocol-types.js';
import type {
  EnboxAnonymousApi,
  EnboxAnonymousOptions,
  EnboxParams,
  EnboxSessionParams,
} from './enbox-types.js';

import { AnonymousDwnApi } from '@enbox/agent';
import { EnboxRpcClient } from '@enbox/dwn-clients';
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';

import { createProtocolReadinessApi } from './protocol-readiness.js';
import { DidApi } from './did-api.js';
import { DwnApi } from './dwn-api.js';
import { DwnReaderApi } from './dwn-reader-api.js';
import { TypedEnbox } from './typed-enbox.js';
import { collectProtocolPaths, isEncryptedRoleAudiencePath } from './protocol-paths.js';

/**
 * The main Enbox API interface. It provides protocol-scoped access to
 * Decentralized Web Nodes (DWNs) and Decentralized Identifiers (DIDs).
 *
 * Applications normally receive an instance from a connection store snapshot.
 * Custom auth flows can use {@link Enbox.fromSession} with an existing session,
 * or the public constructor with raw `{ agent, connectedDid }`.
 *
 * @example
 * ```ts
 * import { createConnectionStore } from '@enbox/api';
 *
 * const store = createConnectionStore();
 * const snapshot = await store.connectVault({ createIdentity: true });
 * if (snapshot.enbox === undefined) {
 *   throw snapshot.error ?? new Error('Connection failed.');
 * }
 *
 * const notes = snapshot.enbox.using(NotesProtocol);
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

  /** Tenant DID bound to this facade. */
  private readonly _connectedDid: string;

  /** Delegate DID used by this instance, when operating under delegated grants. */
  private readonly _delegateDid?: string;

  /** Instance-owned half of the lifetime used by session-scoped resources. */
  private readonly _lifetimeController = new AbortController();

  /** Combined owning-session and instance lifetime. */
  private readonly _lifetimeSignal: AbortSignal;

  /**
   * Cache of {@link TypedEnbox} instances keyed by typed-protocol identity.
   *
   * Ensures that `enbox.using(Protocol)` returns the **same** `TypedEnbox`
   * instance for the same protocol object across multiple call sites, avoiding
   * redundant protocol installations and duplicated internal state.
   */
  private readonly _typedInstances = new Map<object, unknown>();

  /** Application protocol installation and hosted-publication lifecycle. */
  public protocols: ProtocolReadinessApi;

  public constructor({ agent, connectedDid, delegateDid, signal }: EnboxParams) {
    this.agent = agent;
    this._lifetimeSignal = signal === undefined
      ? this._lifetimeController.signal
      : AbortSignal.any([signal, this._lifetimeController.signal]);
    this.did = new DidApi({ agent, connectedDid });
    this._dwn = new DwnApi({ agent, connectedDid, delegateDid, permissionsApi: agent.permissions });
    this._connectedDid = connectedDid;
    this._delegateDid = delegateDid;
    this.protocols = createProtocolReadinessApi({
      agent,
      connectedDid,
      delegateDid,
      using: this.using.bind(this),
    });
  }

  /**
   * The underlying untyped {@link DwnApi} this instance operates through.
   *
   * This is the supported escape hatch to the raw DWN layer — use it when an
   * operation is not (yet) surfaced by {@link Enbox.using}'s typed API, e.g.
   * a low-level `records.write` with explicit message params. Prefer
   * `enbox.using(protocol)` for everything the typed surface covers.
   */
  public get dwn(): DwnApi {
    this._lifetimeSignal.throwIfAborted();
    return this._dwn;
  }

  /**
   * The DID of the connected DWN tenant all operations are scoped to.
   *
   * In a delegated session this is the OWNER's DID (the tenant), not the
   * delegate's — see {@link Enbox.delegateDid}.
   */
  public get connectedDid(): string {
    return this._connectedDid;
  }

  /** Resolve the connected DID's advertised DWN endpoints without applying product defaults. */
  public getDwnEndpointStatus(options: { refresh?: boolean } = {}): Promise<DwnEndpointResolution> {
    this._lifetimeSignal.throwIfAborted();
    return this.agent.identity.getDwnEndpointStatus({
      didUri  : this._connectedDid,
      refresh : options.refresh,
    });
  }

  /**
   * The delegate DID this instance signs with when operating under delegated
   * grants, or `undefined` for owner (non-delegated) sessions.
   */
  public get delegateDid(): string | undefined {
    return this._delegateDid;
  }

  /**
   * Returns a {@link TypedEnbox} instance scoped to the given protocol.
   *
   * This is the **primary developer interface** for interacting with
   * protocol-backed records. It auto-injects the protocol URI, protocolPath,
   * and schema into every operation, and provides compile-time path
   * autocompletion plus typed application values via runtime codecs.
   *
   * Instances are cached by the typed protocol object's identity. Calling
   * `using()` repeatedly with the same exported protocol constant returns the
   * same instance, while independently declared codec maps never alias merely
   * because they use the same protocol URI.
   *
   * @param protocol - A typed protocol created via `defineProtocol()`.
   * @returns A `TypedEnbox` instance bound to the given protocol.
   *
   * @example
   * ```ts
   * const notes = enbox.using(NotesProtocol);
   *
   * const record = await notes.records.create('note', {
   *   data: { title: 'Hello', body: 'Typed data' },
   * });
   *
   * const { records } = await notes.records.query('note');
   * ```
   */
  public using<
    D extends ProtocolDefinition,
    C extends RecordCodecMap,
    G extends ContextRoleGroups,
  >(
    protocol: TypedProtocol<D, C, G>,
  ): TypedEnbox<D, C, G> {
    this._lifetimeSignal.throwIfAborted();
    const cached = this._typedInstances.get(protocol);

    if (cached) {
      // Object identity ties the erased cache value back to this exact typed protocol.
      return cached as TypedEnbox<D, C, G>;
    }

    const deliverySession = {
      protocol : protocol.definition.protocol,
      signal   : this._lifetimeSignal,
      target   : this._connectedDid,
    };
    const instance = new TypedEnbox<D, C, G>(this._dwn, protocol, {
      roleDelivery: {
        get: (roleRecordId): Promise<RoleDeliveryState | undefined> => this.agent.dwn.getAudienceKeyDeliveryState({
          ...deliverySession,
          roleRecordId,
        }),
        retry: (roleRecordId): Promise<RoleDeliveryState | undefined> => this.agent.dwn.retryAudienceKeyDeliveryState({
          ...deliverySession,
          roleRecordId,
        }),
        subscribe: (listener): (() => void) => this.agent.dwn.subscribeAudienceKeyDeliveryChanges({
          ...deliverySession,
          listener,
        }),
      },
      signal : this._lifetimeSignal,
      sync   : this.agent.sync,
    });
    const rolePaths = [...collectProtocolPaths(protocol.definition.structure)]
      .filter(path => isEncryptedRoleAudiencePath(protocol.definition, path));
    if (rolePaths.length > 0) {
      this.agent.dwn.registerAudienceKeyDeliveryProtocol({
        ...deliverySession,
        granteeDid: this._delegateDid,
        rolePaths,
      });
    }
    this._typedInstances.set(protocol, instance);
    return instance;
  }

  /**
   * Ends this facade's lifetime, fences its typed record operations, and
   * initiates release of every session-scoped view and delivery subscription
   * it owns. Idempotent and synchronous; it does not stop shared sync, sign
   * out, lock the vault, or otherwise mutate the owning session.
   *
   * Closing cannot revoke shared escape hatches already retained by the
   * caller, such as `agent`, `did`, or a raw `dwn` reference obtained before
   * close. Their lifetime remains with their owner and they must not be used
   * as though this facade still authorizes application work.
   *
   * Applications using a connection store normally do not call this method:
   * the store closes replaced and disconnected facades automatically.
   * Direct callers must treat the facade as terminal after closing it.
   */
  public close(): void {
    this._lifetimeController.abort();
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
   *   filter: { protocol: 'https://blog.example/posts', protocolPath: 'post' },
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
   * with `{ agent, did, delegateDid?, signal }`. This is the right entry point
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
      signal       : session.signal,
    });
  }
}
