import type {
  DerivedPrivateJwk,
  DwnConfig,
  EncryptionInput,
  EncryptionKeyDeriver,
  GenericMessage,
  KeyDecrypter,
  ProgressToken,
  ProtocolDefinition,
  RecordsWrite,
  RecordsWriteMessage,
  ReplicationApplyResult,
} from '@enbox/dwn-sdk-js';
import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { KeyIdentifier, PrivateKeyJwk, PublicKeyJwk } from '@enbox/crypto';

import {
  Cid,
  ContentEncryptionAlgorithm,
  DataStoreLevel,
  DataStream,
  Dwn,
  DwnMethodName,
  EventEmitterEventLog,
  Jws,
  KeyDerivationScheme,
  Message,
  MessageStoreLevel,
  Protocols,
  Records,
  ResumableTaskStoreLevel,
  StateIndexLevel,
} from '@enbox/dwn-sdk-js';
import { Convert, TtlCache } from '@enbox/common';
import { CryptoUtils, X25519 } from '@enbox/crypto';
import { DidDht, DidJwk, DidResolverCacheLevel, UniversalResolver } from '@enbox/dids';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { LocalDwnStrategy } from './local-dwn.js';
import type {
  DwnMessage,
  DwnMessageInstance,
  DwnMessageParams,
  DwnMessageReply,
  DwnMessageWithData,
  DwnResponse,
  DwnSigner,
  MessageHandler,
  ProcessDwnRequest,
  SendDwnRequest,
} from './types/dwn.js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnDiscoveryFile } from './dwn-discovery-file.js';
import { KeyDeliveryProtocolDefinition } from './store-data-protocols.js';
import { LocalDwnDiscovery } from './local-dwn.js';
import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';
import { getDwnServiceEndpointUrls, isRecordsWrite } from './utils.js';

// Re-export DWN type guards from the agent API surface.
export { isDwnMessage, isDwnRequest, isMessagesPermissionScope, isRecordPermissionScope, isRecordsType } from './dwn-type-guards.js';

// Import type guards for internal use
import { isDwnRequest } from './dwn-type-guards.js';

// Import extracted encryption functions
import {
  buildEncryptionInput as buildEncryptionInputFn,
  deriveContextEncryptionInput as deriveContextEncryptionInputFn,
  encryptAndComputeCid as encryptAndComputeCidFn,
  getEncryptionKeyDeriver as getEncryptionKeyDeriverFn,
  getEncryptionKeyInfo as getEncryptionKeyInfoFn,
  getKeyDecrypter as getKeyDecrypterFn,
  ivLength as ivLengthFn,
  maybeDecryptReply as maybeDecryptReplyFn,
} from './dwn-encryption.js';

// Import extracted protocol utilities
import {
  detectNewParticipants as detectNewParticipantsFn,
  isMultiPartyContext as isMultiPartyContextFn,
} from './protocol-utils.js';

// Import extracted key delivery functions
import {
  eagerSendContextKeyRecord as eagerSendContextKeyRecordFn,
  ensureKeyDeliveryProtocol as ensureKeyDeliveryProtocolFn,
  fetchContextKeyRecord as fetchContextKeyRecordFn,
  writeContextKeyRecord as writeContextKeyRecordFn,
} from './dwn-key-delivery.js';

// Import extracted protocol definition fetching functions
import {
  extractDerivedPublicKey as extractDerivedPublicKeyFn,
  fetchRemoteProtocolDefinition as fetchRemoteProtocolDefinitionFn,
  getProtocolDefinition as getProtocolDefinitionFn,
} from './dwn-protocol-cache.js';

type DwnRpcData = Blob | ReadableStream<Uint8Array>;

type DwnMessageWithRpcData<T extends DwnInterface> = {
  message: DwnMessage[T];
  data?: DwnRpcData;
};

type DwnApiParams = {
  agent?: EnboxPlatformAgent;
  localDwnStrategy?: LocalDwnStrategy;
} & (
  | { dwn: Dwn; localDwnEndpoint?: never }
  | { dwn?: never; localDwnEndpoint: string }
);

interface DwnApiCreateDwnParams extends Partial<DwnConfig> {
  dataPath?: string;
}

export class AgentDwnApi {
  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentDwnApi`. This agent is used to interact with other Enbox agent components. It's vital
   * to ensure this instance is set to correctly contextualize operations within the broader Enbox
   * Agent framework.
   */
  private _agent?: EnboxPlatformAgent;

  /**
   * The DWN instance to use for this API.
   * `undefined` in remote mode — all operations route through RPC to
   * the local DWN server endpoint.
   */
  private readonly _dwn?: Dwn;

  /**
   * The local DWN server endpoint for remote mode.
   * When set, `_dwn` is `undefined` and `processRequest()` routes
   * through `sendDwnRpcRequest()`.
   */
  private readonly _localDwnEndpoint?: string;

  /**
   * Protocol definition cache — TTL 30 minutes. Protocols rarely change.
   * Keyed by `${tenantDid}~${protocolUri}`.
   */
  private readonly _protocolDefinitionCache = new TtlCache<string, ProtocolDefinition>({
    ttl: 30 * 60 * 1000
  });

  /**
   * Context key cache — stores resolved context encryption key info for
   * multi-party protocols. Keyed by rootContextId. TTL 30 minutes.
   */
  private readonly _contextKeyCache = new TtlCache<string, {
    keyId: string;
    keyUri: KeyIdentifier;
    contextDerivationPath: string[];
  }>({ ttl: 30 * 60 * 1000 });

  /**
   * Context-derived private key cache — stores DerivedPrivateJwk for contexts
   * where the current user is a participant (not the creator).
   * Keyed by `ctx~${authorDid}~${rootContextId}`. TTL 30 minutes.
   */
  private readonly _contextDerivedKeyCache = new TtlCache<string, DerivedPrivateJwk>({
    ttl: 30 * 60 * 1000
  });

  /**
   * Delegate decryption key cache — stores scope-aware decryption keys
   * delivered to delegates during the connect flow. These keys enable
   * delegates to decrypt encrypted records without possessing the owner's
   * root X25519 private key.
   *
   * Keyed by `ddk~${delegateDid}`. Each entry is an array covering all
   * granted read scopes for that delegate session.
   * TTL 24 hours (keys are re-populated on session restore).
   */
  private readonly _delegateDecryptionKeyCache = new TtlCache<string, {
    protocol: string;
    scope: { kind: 'protocol' } | { kind: 'protocolPath'; protocolPath: string; match: 'exact' };
    derivedPrivateKey: DerivedPrivateJwk;
  }[]>({
    ttl: 24 * 60 * 60 * 1000
  });

  /**
   * Delegate context key cache — stores ProtocolContext decryption keys for
   * multi-party encrypted protocols. Each key is scoped to one rootContextId.
   * Keyed by `dctx~${delegateDid}~${protocol}~${rootContextId}`.
   * TTL 24 hours (re-populated on session restore).
   */
  private readonly _delegateContextKeyCache = new TtlCache<string, DerivedPrivateJwk>({
    ttl: 24 * 60 * 60 * 1000
  });

  /** Tracks which context key cache entries belong to which delegate DID. */
  private readonly _delegateContextKeyCacheIndex = new Map<string, string[]>();

  /**
   * Explicit registry of which multi-party protocols each delegate has
   * protocol-wide read-like access to. Populated at connect time (even
   * when zero contexts exist) and used by postWriteKeyDelivery() to
   * decide whether to deliver new context keys.
   *
   * Keyed by delegateDid. Each entry is a Set of protocol URIs.
   * Unlike the context key cache, this registry is NOT time-limited —
   * it persists for the lifetime of the session.
   */
  private readonly _delegateMultiPartyProtocols = new Map<string, Set<string>>();

  /**
   * Optional callback invoked when post-connect context keys are delivered
   * to a delegate. The auth layer sets this to persist updated keys.
   */
  private _onDelegateContextKeysChanged?: (delegateDid: string) => void;

  /**
   * Cache of locally-managed DIDs (agent DID + identities). Used to decide
   * whether a target DID should be routed through the local DWN server.
   */
  private readonly _localManagedDidCache = new TtlCache<string, boolean>({
    ttl: 30 * 60 * 1000
  });

  /** Controls local DWN discovery behavior ('prefer' | 'only' | 'off'). */
  private _localDwnStrategy: LocalDwnStrategy;

  /** Lazy-initialized local DWN discovery instance. */
  private _localDwnDiscovery?: LocalDwnDiscovery;

  /**
   * Tracks fire-and-forget eager-send promises dispatched by
   * `writeContextKeyRecord`. The set is consumed by `drainPendingEagerSends()`
   * during test-harness teardown so orphan promises cannot outlive the agent
   * and touch closed LevelDB handles or nulled state.
   *
   * Entries auto-remove on settlement via the `.finally` attached in
   * `trackEagerSend`.
   */
  private readonly _pendingEagerSends: Set<Promise<void>> = new Set();

  constructor(params: DwnApiParams) {
    const { agent, localDwnStrategy = 'prefer' } = params;

    // If an agent is provided, set it as the execution context for this API.
    this._agent = agent;

    // Set the DWN instance (undefined in remote mode).
    this._dwn = 'dwn' in params ? params.dwn : undefined;

    // Set the remote endpoint (undefined in local mode).
    this._localDwnEndpoint = 'localDwnEndpoint' in params ? params.localDwnEndpoint : undefined;

    // Set the local DWN discovery strategy.
    this._localDwnStrategy = localDwnStrategy;

    // If agent is already available, eagerly initialize the discovery instance.
    if (agent) {
      this._localDwnDiscovery = new LocalDwnDiscovery(
        agent.rpc,
        10_000,
        AgentDwnApi._tryCreateDiscoveryFile(),
      );
    }
  }

  /**
   * Whether the API is operating in remote mode (no in-process DWN).
   * In remote mode, all DWN operations are routed through RPC.
   */
  get isRemoteMode(): boolean {
    return this._dwn === undefined;
  }

  /**
   * Retrieves the `EnboxPlatformAgent` execution context.
   *
   * @returns The `EnboxPlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): EnboxPlatformAgent {
    if (this._agent === undefined) {
      throw new Error('AgentDwnApi: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
    // Re-initialize local DWN discovery with the new agent's RPC client.
    this._localDwnDiscovery = new LocalDwnDiscovery(
      agent.rpc,
      10_000,
      AgentDwnApi._tryCreateDiscoveryFile(),
    );
    this._localManagedDidCache.clear();
  }

  get localDwnStrategy(): LocalDwnStrategy {
    return this._localDwnStrategy;
  }

  public setLocalDwnStrategy(strategy: LocalDwnStrategy): void {
    this._localDwnStrategy = strategy;
  }

  /**
   * Inject a cached local DWN endpoint (e.g. from a `dwn://connect`
   * browser redirect or from persisted storage). The endpoint is validated
   * via `GET /info` before being accepted.
   *
   * @param endpoint - The local DWN server base URL.
   * @returns `true` if the endpoint was validated and cached, `false` otherwise.
   * @see https://github.com/enboxorg/enbox/issues/589
   */
  public async setCachedLocalDwnEndpoint(endpoint: string): Promise<boolean> {
    this._localDwnDiscovery ??= new LocalDwnDiscovery(
      this.agent.rpc,
      10_000,
      AgentDwnApi._tryCreateDiscoveryFile(),
    );
    return this._localDwnDiscovery.setCachedEndpoint(endpoint);
  }

  /**
   * Resolves the DWN service endpoint URLs for the given target DID, optionally
   * prepending a local DWN server endpoint when local discovery is enabled and
   * the target is a locally-managed DID.
   *
   * @param targetDid - The DID whose DWN endpoints should be resolved.
   * @returns An array of endpoint URLs.
   * @throws When strategy is `'only'` and no local server is available.
   */
  public async getDwnEndpointUrlsForTarget(targetDid: string): Promise<string[]> {
    const shouldUseLocalDwn = await this.shouldUseLocalDwnForTarget(targetDid);

    if (!shouldUseLocalDwn) {
      return getDwnServiceEndpointUrls(targetDid, this.agent.did);
    }

    const localDwnEndpoint = await this.getLocalDwnEndpoint();
    if (this._localDwnStrategy === 'only') {
      if (!localDwnEndpoint) {
        throw new Error(
          `AgentDwnApi: Local DWN strategy is 'only' but no local DWN endpoint was discovered. ` +
          `Ensure the local DWN server is running and discoverable via the discovery file (~/.enbox/dwn.json) or dwn://connect.`
        );
      }

      return [localDwnEndpoint];
    }

    let dwnEndpointUrls: string[] = [];
    try {
      dwnEndpointUrls = await getDwnServiceEndpointUrls(targetDid, this.agent.did);
    } catch (error) {
      if (!localDwnEndpoint) {
        throw error;
      }
    }

    if (!localDwnEndpoint) {
      return dwnEndpointUrls;
    }

    const uniqueEndpoints = new Set<string>([
      localDwnEndpoint,
      ...dwnEndpointUrls,
    ]);

    return [...uniqueEndpoints];
  }

  /**
   * Returns only the DWN service endpoints from the DID document (no local
   * discovery endpoint). Use this when you need to confirm that a message
   * reached the owner's actual remote DWN, not just the delegate's local server.
   */
  public async getRemoteDwnEndpointUrls(targetDid: string): Promise<string[]> {
    return getDwnServiceEndpointUrls(targetDid, this.agent.did);
  }

  /** Lazily retrieves the local DWN server endpoint via discovery. */
  private async getLocalDwnEndpoint(): Promise<string | undefined> {
    // In remote mode, the endpoint is always known.
    if (this._localDwnEndpoint) {
      return this._localDwnEndpoint;
    }

    this._localDwnDiscovery ??= new LocalDwnDiscovery(
      this.agent.rpc,
      10_000,
      AgentDwnApi._tryCreateDiscoveryFile(),
    );
    return this._localDwnDiscovery.getEndpoint();
  }

  /**
   * Attempt to create a {@link DwnDiscoveryFile} for file-based local DWN
   * discovery. Returns `undefined` in environments where the filesystem
   * is not available (e.g. browsers).
   */
  private static _tryCreateDiscoveryFile(): DwnDiscoveryFile | undefined {
    try {
      return new DwnDiscoveryFile();
    } catch {
      // Browser environment — node:fs/promises not available.
      return undefined;
    }
  }

  /**
   * Determines whether the given target DID should be routed through the
   * local DWN server. Returns `true` if the DID is the agent DID or one
   * of the locally-managed identity DIDs.
   */
  private async shouldUseLocalDwnForTarget(targetDid: string): Promise<boolean> {
    if (this._localDwnStrategy === 'off') {
      return false;
    }

    const cached = this._localManagedDidCache.get(targetDid);
    if (cached !== undefined) {
      return cached;
    }

    if (targetDid === this.agent.agentDid.uri) {
      this._localManagedDidCache.set(targetDid, true);
      return true;
    }

    const identities = await this.agent.identity.list();
    const localManagedDids = new Set<string>();

    for (const identity of identities) {
      localManagedDids.add(identity.did.uri);
      if (identity.metadata.connectedDid) {
        localManagedDids.add(identity.metadata.connectedDid);
      }
    }

    for (const localDid of localManagedDids) {
      this._localManagedDidCache.set(localDid, true);
    }

    const isLocalManaged = localManagedDids.has(targetDid);
    if (!isLocalManaged) {
      this._localManagedDidCache.set(targetDid, false);
    }

    return isLocalManaged;
  }

  /**
   * Public getter for the DWN instance used by this API.
   *
   * Notes:
   * - This getter is public to allow advanced developers to access the DWN instance directly.
   *   However, it is recommended to use the `processRequest` method to interact with the DWN
   *   instance to ensure that the DWN message is constructed correctly.
   * - The getter is named `node` to avoid confusion with the `dwn` property of the
   *   `EnboxPlatformAgent`. In other words, so that a developer can call `agent.dwn.node` to access
   *   the DWN instance and not `agent.dwn.dwn`.
   */
  get node(): Dwn {
    if (!this._dwn) {
      throw new Error(
        'AgentDwnApi: The in-process DWN instance is not available. ' +
        'The agent is operating in remote mode (local DWN server at ' +
        `'${this._localDwnEndpoint}'). Use processRequest() instead ` +
        'of accessing the DWN node directly.'
      );
    }
    return this._dwn;
  }

  public static async createDwn({
    dataPath, dataStore, didResolver, stateIndex, eventLog, messageStore, tenantGate, resumableTaskStore
  }: DwnApiCreateDwnParams): Promise<Dwn> {
    dataStore ??= new DataStoreLevel({ blockstoreLocation: `${dataPath}/DWN_DATASTORE` });

    didResolver ??= new UniversalResolver({
      didResolvers : [DidDht, DidJwk],
      cache        : new DidResolverCacheLevel({ location: `${dataPath}/DID_RESOLVERCACHE` }),
    });

    stateIndex ??= new StateIndexLevel({ location: `${dataPath}/DWN_STATEINDEX` });

    messageStore ??= new MessageStoreLevel(({
      location: `${dataPath}/DWN_MESSAGESTORE`
    }));

    resumableTaskStore ??= new ResumableTaskStoreLevel({ location: `${dataPath}/DWN_RESUMABLETASKSTORE` });

    eventLog ??= new EventEmitterEventLog();

    return await Dwn.create({ dataStore, didResolver, stateIndex, eventLog, messageStore, tenantGate, resumableTaskStore });
  }

  public async processRequest<T extends DwnInterface>(
    request: ProcessDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    // Constructs a DWN message. and if there is a data payload, prepares the data as a
    // Web ReadableStream.
    const { message, dataStream } =
      await this.constructDwnMessage({ request });

    // Extracts the optional subscription handler from the request to pass into `processMessage.
    const { subscriptionHandler } = request;

    // Conditionally processes the message with the DWN instance:
    // - If `store` is not explicitly set to false, it sends the message to the DWN node for
    //   processing, passing along the target DID, the message, and any associated data stream.
    // - If `store` is set to false, it immediately returns a simulated 'accepted' status without
    //   storing the message/data in the DWN node.
    let reply: DwnMessageReply[T];

    if (request.store === false) {
      reply = { status: { code: 202, detail: 'Accepted' } };
    } else if (this._dwn) {
      // Local mode: process directly with the in-process DWN.
      reply = await this._dwn.processMessage(
        request.target, message,
        { dataStream: dataStream as any, subscriptionHandler },
      );
    } else {
      // Remote mode: route through RPC to the local DWN server.
      reply = await this.sendDwnRpcRequest({
        targetDid       : request.target,
        dwnEndpointUrls : [this._localDwnEndpoint!],
        message,
        data            : dataStream,
        subscriptionHandler,
      });
    }

    // Post-write key delivery and reply decryption are independent — run in parallel.
    await Promise.all([
      this.postWriteKeyDelivery(request, message, reply),
      this.maybeAssertProtocolSelfReference(request, message, reply),
      this.maybeDecryptReply(request, reply),
    ]);

    // Returns an object containing the reply from processing the message, the original message,
    // and the content identifier (CID) of the message.
    return {
      reply,
      message,
      messageCid: await Message.getCid(message),
    };
  }

  /**
   * Process a pre-constructed DWN message against the local DWN (in-process
   * or remote server). Used by the sync engine to store messages that were
   * already fetched from a remote DWN.
   *
   * Unlike {@link processRequest}, this method does NOT construct a new
   * message — it takes an already-signed `GenericMessage` and routes it
   * to the appropriate backend.
   *
   * @param tenant - The DID of the DWN tenant (target).
   * @param message - The pre-constructed DWN message.
   * @param options - Optional data stream and subscription handler.
   * @returns The reply from processing the message.
   */
  public async processRawMessage(
    tenant: string,
    message: GenericMessage,
    options?: { dataStream?: ReadableStream<Uint8Array> },
  ): Promise<{ status: { code: number; detail: string } }> {
    if (this._dwn) {
      return this._dwn.processMessage(tenant, message, { dataStream: options?.dataStream });
    }

    return this.sendDwnRpcRequest({
      targetDid       : tenant,
      dwnEndpointUrls : [this._localDwnEndpoint!],
      message         : message as DwnMessage[DwnInterface],
      data            : options?.dataStream,
    });
  }

  /**
   * Applies a replicated message to the local DWN and returns a structured sync
   * outcome. In-process DWNs call the native entry point directly. Local DWN
   * server mode calls the server's matching replication RPC so duplicate replay
   * and replication-index repair stay server-side instead of falling back to the
   * normal authoring path.
   */
  public async applyReplicatedMessage(
    tenant: string,
    message: GenericMessage,
    options?: { dataStream?: ReadableStream<Uint8Array> },
  ): Promise<ReplicationApplyResult> {
    if (this._dwn) {
      return this._dwn.applyReplicatedMessage(tenant, message, options);
    }

    return this.agent.rpc.applyReplicatedMessage({
      targetDid : tenant,
      dwnUrl    : this._localDwnEndpoint!,
      message,
      data      : options?.dataStream,
    });
  }

  public async sendRequest<T extends DwnInterface>(
    request: SendDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    // Resolve DWN service endpoint URLs, with local DWN discovery if enabled.
    const dwnEndpointUrls = await this.getDwnEndpointUrlsForTarget(request.target);
    if (dwnEndpointUrls.length === 0) {
      throw new Error(`AgentDwnApi: DID Service is missing or malformed: ${request.target}#dwn`);
    }

    let messageCid: string | undefined;
    let message: DwnMessage[T];
    let data: DwnRpcData | undefined;
    let subscriptionHandler: MessageHandler[T] | undefined;

    // If `messageCid` is given, retrieve message and data, if any.
    if ('messageCid' in request) {
      ({ message, data } = await this.getDwnMessage({
        author      : request.author,
        messageCid  : request.messageCid,
        messageType : request.messageType
      }));
      messageCid = request.messageCid;

    } else {
      // Otherwise, construct a new message.
      ({ message, dataStream: data } = await this.constructDwnMessage({ request }));
      subscriptionHandler = request.subscriptionHandler;
    }

    // Build a resubscribe factory for subscribe requests. This closure
    // captures the original request so it can reconstruct and re-sign a new
    // subscribe message with a cursor on reconnection.
    let resubscribeFactory: ResubscribeFactory | undefined;
    if (subscriptionHandler !== undefined && !('messageCid' in request)) {
      resubscribeFactory = async (cursor?: ProgressToken): Promise<GenericMessage> => {
        const resumeParams = cursor === undefined
          ? request.messageParams
          : { ...request.messageParams, cursor } as DwnMessageParams[T];

        const resumeRequest: ProcessDwnRequest<T> = { ...request, messageParams: resumeParams };
        const { message: resumeMessage } = await this.constructDwnMessage({ request: resumeRequest });
        return resumeMessage;
      };
    }

    // Send the RPC request to the target DID's DWN service endpoint using the Agent's RPC client.
    const reply = await this.sendDwnRpcRequest({
      targetDid: request.target,
      dwnEndpointUrls,
      message,
      data,
      subscriptionHandler,
      resubscribeFactory,
    });

    // Auto-decrypt reply data if encryption is enabled (Component 7)
    await this.maybeDecryptReply(request, reply);

    // If the message CID was not given in the `request`, compute it.
    messageCid ??= await Message.getCid(message);

    // Returns an object containing the reply from processing the message, the original message,
    // and the content identifier (CID) of the message.
    return { reply, message, messageCid };
  }

  private async maybeAssertProtocolSelfReference<T extends DwnInterface>(
    request: ProcessDwnRequest<T>,
    message: DwnMessage[T],
    reply: DwnMessageReply[T],
  ): Promise<void> {
    if (
      !isDwnRequest(request, DwnInterface.ProtocolsConfigure) ||
      request.store === false ||
      reply.status.code < 200 ||
      reply.status.code >= 300
    ) {
      return;
    }
    if (this._agent === undefined) {
      return;
    }

    const definition = (message.descriptor as { definition?: unknown }).definition;
    if (!this.isProtocolDefinition(definition)) {
      return;
    }

    await this._agent.sync.assertProtocolSelfReference({
      definition,
      identity : request.target,
      protocol : definition.protocol,
    });
  }

  private isProtocolDefinition(value: unknown): value is ProtocolDefinition {
    return typeof value === 'object' &&
      value !== null &&
      typeof (value as { protocol?: unknown }).protocol === 'string';
  }

  /**
   * Post-write key delivery: after a successful encrypted `RecordsWrite`,
   * detect new participants and write `contextKey` records so they can
   * decrypt records in the context.
   *
   * This is a non-fatal operation — if participant detection or key delivery
   * fails, the record is still stored and a warning is logged.
   */
  private async postWriteKeyDelivery<T extends DwnInterface>(
    request: ProcessDwnRequest<T>,
    message: DwnMessage[T],
    reply: DwnMessageReply[T],
  ): Promise<void> {
    if (
      !isDwnRequest(request, DwnInterface.RecordsWrite) ||
      !request.encryption ||
      reply.status.code !== 202
    ) {
      return;
    }

    const writeParams = request.messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
    // Skip key-delivery protocol writes to avoid infinite recursion (contextKey records are themselves encrypted)
    if (writeParams.protocol === KeyDeliveryProtocolDefinition.protocol) {
      return;
    }

    try {
      const protocolDefinition = await this.getProtocolDefinition(
        request.target, writeParams.protocol,
      );
      if (!protocolDefinition) {
        return;
      }

      const recordsWriteMessage = message as unknown as RecordsWriteMessage;

      const authorDid = Jws.getSignerDid(
        recordsWriteMessage.authorization.signature.signatures[0]
      );
      const isExternallyAuthored = authorDid !== request.target;
      const isRootRecord = !writeParams.parentContextId;
      const rootPathSegment = writeParams.protocolPath.split('/')[0];
      const isMultiParty = isMultiPartyContextFn(protocolDefinition, rootPathSegment);

      // Owner-authored multi-party root records get context-key delivery below
      // (participant, delegate, and cross-device paths). The externally-authored
      // multi-party root record is the open gap: it lands ProtocolPath-encrypted to
      // the owner only, so other context-key holders cannot decrypt it. Closing this
      // needs a normal authored DWN write because a signed message cannot be rewritten
      // by the owner; the mechanism is still open.
      // Open issue https://github.com/enboxorg/enbox/issues/923: resolve externally-authored
      // multi-party root-record context-key access.
      const newParticipants = detectNewParticipantsFn({
        protocolDefinition,
        protocolPath : writeParams.protocolPath,
        recipient    : writeParams.recipient,
        tenantDid    : request.target,
        authorDid    : isExternallyAuthored ? authorDid : undefined,
      });

      // Compute rootContextId for both participant and delegate delivery.
      const rootContextId = recordsWriteMessage.contextId?.split('/')[0]
        || recordsWriteMessage.contextId
        || recordsWriteMessage.recordId;

      // Determine if delegate delivery is needed: new multi-party root
      // record created by the owner with active delegate sessions.
      const needsDelegateDelivery = isMultiParty && isRootRecord
        && !isExternallyAuthored
        && this.hasEligibleDelegatesForProtocol(writeParams.protocol);

      // Cross-device delegate delivery (via DWN) runs whenever the owner
      // creates a root record in a multi-party context, regardless of
      // whether same-process delegates exist.
      const needsCrossDeviceDelivery = isMultiParty && isRootRecord && !isExternallyAuthored;

      // Derive the context key once and share it across all delivery paths.
      if (newParticipants.size > 0 || needsDelegateDelivery || needsCrossDeviceDelivery) {
        const { keyId, keyUri } = await getEncryptionKeyInfoFn(this.agent, request.target);
        const contextDerivationPath = [
          KeyDerivationScheme.ProtocolContext,
          rootContextId,
        ];
        const contextDerivedPrivateKeyBytes =
          await this.agent.keyManager.derivePrivateKeyBytes({
            keyUri,
            derivationPath: contextDerivationPath,
          });
        const contextDerivedPrivateJwk =
          await X25519.bytesToPrivateKey({ privateKeyBytes: contextDerivedPrivateKeyBytes });
        const contextKeyPayload: DerivedPrivateJwk = {
          rootKeyId         : keyId,
          derivationScheme  : KeyDerivationScheme.ProtocolContext,
          derivationPath    : contextDerivationPath,
          derivedPrivateKey : contextDerivedPrivateJwk as PrivateKeyJwk,
        };

        // --- Participant key delivery (existing) ---
        if (newParticipants.size > 0) {
          // Extract the author's key delivery public key from the record
          // so we can encrypt the contextKey directly to the external author.
          const authorKeyDeliveryPubKey =
            recordsWriteMessage.authorization?.authorKeyDeliveryPublicKey;

          for (const participantDid of newParticipants) {
            try {
              // Use the author's key delivery public key when delivering
              // to the external author; for other participants (e.g.
              // recipient, role holders) fall back to owner-key encryption.
              const recipientKey = (participantDid === authorDid && authorKeyDeliveryPubKey)
                ? authorKeyDeliveryPubKey
                : undefined;

              await this.writeContextKeyRecord({
                tenantDid                     : request.target,
                recipientDid                  : participantDid,
                contextKeyData                : contextKeyPayload,
                sourceProtocol                : writeParams.protocol,
                sourceContextId               : rootContextId,
                recipientKeyDeliveryPublicKey : recipientKey,
              });
            } catch (keyDeliveryError: any) {
              console.warn(
                `AgentDwnApi: Key delivery to '${participantDid}' for context ` +
                `'${rootContextId}' failed: ${keyDeliveryError.message}. ` +
                `The participant may not be able to decrypt records in this context.`
              );
            }
          }
        }

        // --- Post-connect delegate context key delivery (#824) ---
        // Same-process: direct cache injection (fast, no network).
        if (needsDelegateDelivery) {
          this.deliverContextKeyToDelegates(
            writeParams.protocol, rootContextId, contextKeyPayload,
          );
        }

        // --- Cross-device delegate context key delivery (#826) ---
        // Query grants to find ALL eligible delegates (including those on
        // other agents) and write contextKey records to the DWN.
        // This is separate from same-process delivery: it discovers delegates
        // from the owner's DWN grants, not just in-memory caches. It must
        // run even when no same-process delegates or participants exist.
        if (needsCrossDeviceDelivery) {
          await this.deliverContextKeyToDelegatesViaDwn(
            request.target, writeParams.protocol, rootContextId, contextKeyPayload,
          );
        }
      }
    } catch (detectionError: any) {
      // Participant detection failure is non-fatal — the record is still stored.
      console.warn(
        `AgentDwnApi: Post-write participant detection failed: ` +
        `${detectionError.message}`
      );
    }
  }

  private async sendDwnRpcRequest<T extends DwnInterface>({
    targetDid, dwnEndpointUrls, message, data, subscriptionHandler, resubscribeFactory
  }: {
      targetDid: string;
      dwnEndpointUrls: string[];
      message: DwnMessage[T];
      data?: DwnRpcData;
      subscriptionHandler?: MessageHandler[T];
      resubscribeFactory?: ResubscribeFactory;
    }
  ): Promise<DwnMessageReply[T]> {
    const errorMessages: { url: string, message: string }[] = [];

    if (message.descriptor.method === DwnMethodName.Subscribe && subscriptionHandler === undefined) {
      throw new Error('AgentDwnApi: Subscription handler is required for subscription requests.');
    }

    // Try sending to author's publicly addressable DWNs until the first request succeeds.
    for (let dwnUrl of dwnEndpointUrls) {
      try {
        if (subscriptionHandler !== undefined) {
          // we get the server info to check if the server supports WebSocket for subscription requests
          const serverInfo = await this.agent.rpc.getServerInfo(dwnUrl);
          if (!serverInfo.webSocketSupport) {
            // If the server does not support WebSocket, add an error message and continue to the next URL.
            errorMessages.push({
              url     : dwnUrl,
              message : 'WebSocket support is not enabled on the server.'
            });
            continue;
          }

          // If the server supports WebSocket, replace the subscription URL with a socket transport.
          // For `http` we use the unsecured `ws` protocol, and for `https` we use the secured `wss` protocol.
          const parsedUrl = new URL(dwnUrl);
          parsedUrl.protocol = parsedUrl.protocol === 'http:' ? 'ws:' : 'wss:';
          dwnUrl = parsedUrl.toString();
        }

        const dwnReply = await this.agent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid,
          message,
          data,
          subscription: subscriptionHandler ? {
            handler: subscriptionHandler as DwnSubscriptionHandler,
            resubscribeFactory,
          } : undefined,
        });

        return dwnReply;
      } catch (error: any) {
        errorMessages.push({
          url     : dwnUrl,
          message : (error instanceof Error) ? error.message : 'Unknown error',
        });
      }
    }

    throw new Error(`Failed to send DWN RPC request: ${JSON.stringify(errorMessages)}`);
  }

  private async constructDwnMessage<T extends DwnInterface>({ request }: {
    request: ProcessDwnRequest<T>
  }): Promise<DwnMessageWithData<T>> {
    // if the request has a granteeDid, ensure the messageParams include the proper grant parameters
    if (request.granteeDid && !this.hasGrantParams(request.messageParams)) {
      throw new Error('AgentDwnApi: Requested to sign with a permission but no grant messageParams were provided in the request');
    }

    const rawMessage = request.rawMessage;
    let readableStream: ReadableStream<Uint8Array> | undefined;
    // if the request is a RecordsWrite message, we need to handle the data stream and update the messageParams accordingly
    if (isDwnRequest(request, DwnInterface.RecordsWrite)) {
      const messageParams = request.messageParams;

      if (request.dataStream && !messageParams?.data) {
        const { dataStream } = request;
        let forCid: ReadableStream<Uint8Array>;

        if (dataStream instanceof Blob) {
          const [ cidCopy, processCopy ] = (dataStream.stream() as ReadableStream<Uint8Array>).tee();
          forCid = cidCopy;
          readableStream = processCopy;

        } else if (dataStream instanceof ReadableStream) {
          const [ cidCopy, processCopy ] = dataStream.tee();
          forCid = cidCopy;
          readableStream = processCopy;
        }

        if (!rawMessage && messageParams) {
          messageParams.dataCid = await Cid.computeDagPbCidFromStream(forCid!);
          // Compute data size by consuming forCid (already consumed by computeDagPbCidFromStream)
          // and using the Blob/stream size if available.
          if (messageParams.dataSize === undefined) {
            if (dataStream instanceof Blob) {
              messageParams.dataSize = dataStream.size;
            }
            // For ReadableStream without known size, the SDK will compute it during processMessage.
          }
        }
      }
    }

    // Auto-inject encryption keys into protocol definition (Component 5)
    if (isDwnRequest(request, DwnInterface.ProtocolsConfigure) && request.encryption && !rawMessage) {
      const messageParams = request.messageParams!;
      const keyDeriver = await getEncryptionKeyDeriverFn(this.agent, request.author);

      // SDK walks the protocol structure and calls our callback for each path.
      // The KMS performs HKDF derivation + public key computation internally.
      messageParams.definition = await Protocols.deriveAndInjectPublicEncryptionKeys(
        messageParams.definition,
        keyDeriver,
      );

      // Invalidate cache for this protocol
      this._protocolDefinitionCache.delete(
        `${request.target}~${messageParams.definition.protocol}`
      );
    }

    // When a ProtocolsConfigure is processed WITHOUT the encryption flag
    // (e.g. a delegate installing the owner's protocol definition that
    // already contains `$encryption` keys from the remote DWN), cache the
    // definition so that subsequent RecordsWrite encryption can find it
    // without re-querying the local DWN (which would fail for delegates
    // because the query author doesn't match the unpublished protocol's
    // tenant).
    if (isDwnRequest(request, DwnInterface.ProtocolsConfigure) && !request.encryption && !rawMessage) {
      const def = request.messageParams?.definition;
      if (def?.protocol) {
        this._protocolDefinitionCache.set(`${request.target}~${def.protocol}`, def);
      }
    }

    // Auto-encrypt data on RecordsWrite.
    //
    // Encryption scheme decision (unified key delivery):
    //   | Condition                                    | Scheme          |
    //   |----------------------------------------------|-----------------|
    //   | Local root record, multi-party               | ProtocolContext  | deferred (needs recordId)
    //   | Local non-root record, multi-party           | ProtocolContext  |
    //   | Local single-party                           | ProtocolPath    |
    //   | Cross-DWN root record, multi-party           | ProtocolPath    | target's key
    //   | Cross-DWN non-root record, multi-party       | ProtocolContext  | uses derivedPublicKey from existing records
    //   | Cross-DWN single-party                       | ProtocolPath    | target's key
    //
    // Key delivery happens as a post-write step in processRequest() via
    // detectNewParticipants() + writeContextKeyRecord(). Role records no
    // longer carry encrypted key payloads — they preserve user data.
    //
    // For local root multi-party records, encryption is deferred until after
    // message creation because contextId = recordId, which is only known after
    // create(). Follows the SDK two-pass pattern: create -> encryptSymmetricEncryptionKey -> sign.
    //
    // For cross-DWN writes (target !== author), the external author cannot
    // derive the target's context key. Root records use the target's ProtocolPath
    // public key. Non-root records extract the context public key (derivedPublicKey)
    // from existing ProtocolContext-encrypted records in the same context on the
    // target's DWN.

    // Tracks deferred context encryption info for root multi-party records.
    let deferredContextEncryption: {
      dataEncryptionKey: Uint8Array;
      dataEncryptionIV: Uint8Array;
      encryptedBytes: Uint8Array;
      authenticationTag: Uint8Array;
    } | undefined;

    if (isDwnRequest(request, DwnInterface.RecordsWrite) && request.encryption && !rawMessage) {
      const messageParams = request.messageParams;
      if (messageParams?.protocol && messageParams.protocolPath) {
        const isCrossDwn = request.target !== request.author;

        // 1. Fetch the protocol definition — local for same-DWN, remote for cross-DWN
        let protocolDefinition: ProtocolDefinition | undefined;
        if (isCrossDwn) {
          protocolDefinition = await this.fetchRemoteProtocolDefinition(
            request.target, messageParams.protocol,
          );
        } else {
          protocolDefinition = await this.getProtocolDefinition(
            request.target, messageParams.protocol, request.granteeDid,
          );
        }

        if (!protocolDefinition) {
          throw new Error(
            `AgentDwnApi: Protocol '${messageParams.protocol}' is not installed ` +
            `for '${request.target}'. Install the protocol before writing ` +
            `encrypted records.`
          );
        }

        // 2. Walk the protocol structure to find $encryption for this protocol path
        const protocolPathSegments = messageParams.protocolPath.split('/');
        let ruleSet: any = protocolDefinition.structure;
        for (const segment of protocolPathSegments) {
          ruleSet = ruleSet[segment];
        }

        if (!ruleSet?.$encryption) {
          throw new Error(
            `AgentDwnApi: Protocol '${messageParams.protocol}' at path ` +
            `'${messageParams.protocolPath}' does not have encryption configured. ` +
            `Configure the protocol with encryption: true.`
          );
        }

        // 3. Classify the record
        const rootPathSegment = messageParams.protocolPath.split('/')[0];
        // The key-delivery protocol must always use ProtocolPath encryption so
        // that recipients can decrypt contextKey records with their own derived
        // key.  Treating it as multi-party would trigger ProtocolContext
        // encryption, but no one delivers context keys FOR the key-delivery
        // protocol itself (excluded at line 246 to prevent infinite recursion),
        // making the records undecryptable by recipients.
        const isKeyDeliveryProtocol =
          messageParams.protocol === KeyDeliveryProtocolDefinition.protocol;
        const isMultiPartyContext = isKeyDeliveryProtocol
          ? false
          : isMultiPartyContextFn(protocolDefinition, rootPathSegment);
        const isRootRecord = !messageParams.parentContextId;

        // 4. Get plaintext bytes (normalize from all supported input types)
        let plaintextBytes: Uint8Array;
        if (messageParams.data) {
          plaintextBytes = messageParams.data instanceof Uint8Array
            ? messageParams.data
            : new TextEncoder().encode(String(messageParams.data));
        } else if (request.dataStream instanceof Blob) {
          plaintextBytes = new Uint8Array(await request.dataStream.arrayBuffer());
        } else if (request.dataStream instanceof ReadableStream) {
          plaintextBytes = await DataStream.toBytes(request.dataStream);
        } else {
          throw new Error('AgentDwnApi: Data must be provided for encrypted records.');
        }

        // 5. Generate random DEK and IV (IV size depends on content encryption algorithm)
        const contentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256GCM;
        const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
        const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(ivLengthFn(contentEncryptionAlgorithm)));

        // 6. Build partial EncryptionInput (authenticationTag added after AEAD encryption)
        let encryptionInput: (Omit<EncryptionInput, 'authenticationTag'> & { authenticationTag?: Uint8Array }) | undefined;

        const buildProtocolPathInput = (): Omit<EncryptionInput, 'authenticationTag'> => buildEncryptionInputFn(
          dataEncryptionKey, dataEncryptionIV,
          ruleSet.$encryption.rootKeyId, ruleSet.$encryption.publicKeyJwk,
          KeyDerivationScheme.ProtocolPath,
        );

        if (isCrossDwn && isMultiPartyContext && isRootRecord) {
          // --- Cross-DWN root record in multi-party context -> Target's ProtocolPath key ---
          encryptionInput = buildProtocolPathInput();

        } else if (isCrossDwn && isMultiPartyContext && !isRootRecord) {
          // --- Cross-DWN non-root record in multi-party context -> derivedPublicKey ---
          const rootContextId = messageParams.parentContextId!.split('/')[0]
            || messageParams.parentContextId!;

          const derivedPublicKeyInfo = await this.extractDerivedPublicKey(
            request.target, messageParams.protocol, rootContextId, request.author,
          );

          if (derivedPublicKeyInfo) {
            encryptionInput = buildEncryptionInputFn(
              dataEncryptionKey, dataEncryptionIV,
              derivedPublicKeyInfo.rootKeyId, derivedPublicKeyInfo.derivedPublicKey,
              KeyDerivationScheme.ProtocolContext,
            );
          } else {
            // Fallback: no ProtocolContext-encrypted record exists yet. Use
            // ProtocolPath encryption instead.
            encryptionInput = buildProtocolPathInput();
          }

        } else if (isCrossDwn) {
          // --- Cross-DWN single-party -> Target's ProtocolPath key ---
          encryptionInput = buildProtocolPathInput();

        } else if (isMultiPartyContext && !isRootRecord) {
          // --- Local non-root record in a multi-party context -> Context key ---
          const rootContextId = messageParams.parentContextId!.split('/')[0]
            || messageParams.parentContextId!;

          let contextKeyInfo = this._contextKeyCache.get(rootContextId);
          if (!contextKeyInfo) {
            const { keyId, keyUri } = await getEncryptionKeyInfoFn(this.agent, request.author);
            const contextDerivationPath =
              Records.constructKeyDerivationPathUsingProtocolContextScheme(rootContextId);
            contextKeyInfo = { keyId, keyUri, contextDerivationPath };
            this._contextKeyCache.set(rootContextId, contextKeyInfo);
          }

          const contextPublicKey = await this.agent.keyManager.derivePublicKey({
            keyUri         : contextKeyInfo.keyUri,
            derivationPath : contextKeyInfo.contextDerivationPath,
          });

          encryptionInput = buildEncryptionInputFn(
            dataEncryptionKey, dataEncryptionIV,
            contextKeyInfo.keyId, contextPublicKey,
            KeyDerivationScheme.ProtocolContext,
          );

        } else if (isMultiPartyContext && isRootRecord) {
          // --- Local root record in multi-party context -> Deferred context encryption ---
          // contextId = recordId, which is only known after message creation.
          // Skip encryptionInput here; apply it after create() below.
          encryptionInput = undefined;

        } else {
          // --- Local single-party -> ProtocolPath key (existing logic) ---
          encryptionInput = buildProtocolPathInput();
        }

        // 7. Encrypt data with AEAD and compute CID
        const { encryptedBytes, dataCid, dataSize, authenticationTag } =
          await encryptAndComputeCidFn(plaintextBytes, dataEncryptionKey, dataEncryptionIV, contentEncryptionAlgorithm);

        // 8. Replace plaintext with encrypted data
        messageParams.dataCid = dataCid;
        messageParams.dataSize = dataSize;
        delete messageParams.data;
        readableStream = DataStream.fromBytes(encryptedBytes);
        request.dataStream = undefined;

        if (encryptionInput) {
          encryptionInput.authenticationTag = authenticationTag;
          messageParams.encryptionInput = encryptionInput as EncryptionInput;
        } else {
          // Deferred — store info for post-creation encryption
          deferredContextEncryption = { dataEncryptionKey, dataEncryptionIV, encryptedBytes, authenticationTag };
        }

        // 9. For cross-DWN writes in multi-party contexts, attach the author's
        //    key-delivery ProtocolPath public key so the DWN owner can encrypt
        //    context keys back to the author without querying the author's DWN.
        if (isCrossDwn && isMultiPartyContext) {
          const { keyId: authorKeyId, keyUri: authorKeyUri } =
            await getEncryptionKeyInfoFn(this.agent, request.author);
          const keyDeliveryDerivationPath = [
            KeyDerivationScheme.ProtocolPath,
            KeyDeliveryProtocolDefinition.protocol,
            'contextKey',
          ];
          const authorKeyDeliveryPubKey = await this.agent.keyManager.derivePublicKey({
            keyUri         : authorKeyUri,
            derivationPath : keyDeliveryDerivationPath,
          });
          messageParams.authorKeyDeliveryPublicKey = {
            rootKeyId    : authorKeyId,
            publicKeyJwk : authorKeyDeliveryPubKey,
          };
        }
      }
    }

    let dwnMessage: DwnMessageInstance[T];
    const dwnMessageConstructor = dwnMessageConstructors[request.messageType];

    // if a raw message is provided, parse it; otherwise create a new dwn message
    if (rawMessage) {
      dwnMessage = await dwnMessageConstructor.parse(rawMessage);
      if (isRecordsWrite(dwnMessage) && request.signAsOwner) {
        // if we are signing as owner, we use the author's signer
        const signer = await this.getSigner(request.author);
        await dwnMessage.signAsOwner(signer);
      } else if (request.granteeDid && isRecordsWrite(dwnMessage) && request.signAsOwnerDelegate) {
        // if we are signing as owner delegate, we use the grantee's signer and the provided delegated grant
        const signer = await this.getSigner(request.granteeDid);

        //if we have reached here, the presence of the grant params has already been checked
        const messageParams = request.messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
        await dwnMessage.signAsOwnerDelegate(signer, messageParams.delegatedGrant!);
      }
    } else {
      if (request.messageParams === undefined) {
        throw new Error('AgentDwnApi: messageParams must be provided when rawMessage is not given.');
      }

      // If we need to sign as an author delegate or with permissions we need to get the grantee's signer.
      // The messageParams should include either a permission grant invocation or a delegatedGrant message.
      const signer = request.granteeDid ?
        await this.getSigner(request.granteeDid) :
        await this.getSigner(request.author);

      // When signing as a delegate with a permissionGrantId, fetch the full
      // grant message and pass it as `delegatedGrant` so the DWN SDK correctly
      // sets `authorization.authorDelegatedGrant` and resolves the logical
      // author to the grantor (owner) rather than the signer (delegate).
      const params = { ...request.messageParams } as any;
      if (request.granteeDid && params.permissionGrantId && !params.delegatedGrant
        && isDwnRequest(request, DwnInterface.RecordsWrite)) {
        // Read as the grantee (delegate), not the owner. The delegate is
        // the grant's recipient so the permissions protocol authorizes the
        // read. The owner's signing key may not be available on the
        // delegate agent in real wallet-connect flows.
        const { reply: grantReply } = await this.processRequest({
          author        : request.granteeDid,
          target        : request.author,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: params.permissionGrantId } },
        });
        if (grantReply.status.code === 200 && grantReply.entry?.recordsWrite && grantReply.entry?.data) {
          const grantDataBytes = await DataStream.toBytes(grantReply.entry.data);
          params.delegatedGrant = {
            ...grantReply.entry.recordsWrite,
            encodedData: Convert.uint8Array(grantDataBytes).toBase64Url(),
          };
        }
      }

      dwnMessage = await dwnMessageConstructor.create({
        ...params,
        signer
      });

      // Deferred context encryption for root multi-party records (Component 9).
      // Now that the message exists, we know recordId = contextId.
      // Following the SDK two-pass pattern: encryptSymmetricEncryptionKey -> sign.
      if (deferredContextEncryption && isDwnRequest(request, DwnInterface.RecordsWrite)) {
        const recordsWriteInstance = dwnMessage as unknown as RecordsWrite;
        const contextId = recordsWriteInstance.message.recordId;

        const { encryptionInput: contextEncryptionInput, keyId, keyUri, contextDerivationPath } =
          await deriveContextEncryptionInputFn(
            this.agent, request.author, contextId,
            deferredContextEncryption.dataEncryptionKey,
            deferredContextEncryption.dataEncryptionIV,
          );

        const fullContextInput = { ...contextEncryptionInput, authenticationTag: deferredContextEncryption.authenticationTag };
        await recordsWriteInstance.encryptSymmetricEncryptionKey(fullContextInput as EncryptionInput);
        await recordsWriteInstance.sign({ signer });

        // Cache context key info for subsequent writes in this context
        this._contextKeyCache.set(contextId, { keyId, keyUri, contextDerivationPath });
      }
    }

    return {
      message    : dwnMessage.message as DwnMessage[T],
      dataStream : readableStream,
    };
  }

  private hasGrantParams<T extends DwnInterface>(params?: DwnMessageParams[T]): boolean {
    return params !== undefined &&
      (('permissionGrantId' in params && params.permissionGrantId !== undefined) ||
      ('permissionGrantIds' in params && params.permissionGrantIds !== undefined) ||
      ('delegatedGrant' in params && params.delegatedGrant !== undefined));
  }

  private async getSigner(author: string): Promise<DwnSigner> {
    // If the author is the Agent's DID, use the Agent's signer.
    if (author === this.agent.agentDid.uri) {
      const signer = await this.agent.agentDid.getSigner();

      return {
        algorithm : signer.algorithm,
        keyId     : signer.keyId,
        sign      : async (data: Uint8Array): Promise<Uint8Array> => {
          return await signer.sign({ data });
        }
      };

    } else {
      // Prefer a locally-stored BearerDid when the agent controls this DID.
      // This avoids an unnecessary DID resolution round-trip during signing,
      // which can fail if the resolver path encounters malformed cached data.
      try {
        const localDid = await this.agent.did.get({ didUri: author });
        if (localDid) {
          const signer = await localDid.getSigner();

          return {
            algorithm : signer.algorithm,
            keyId     : signer.keyId,
            sign      : async (data: Uint8Array): Promise<Uint8Array> => {
              return await signer.sign({ data });
            }
          };
        }

        // Otherwise, use the author's DID to determine the signing method.
        const signingMethod = await this.agent.did.getSigningMethod({ didUri: author });

        if (!signingMethod.publicKeyJwk) {
          throw new Error(`Verification method '${signingMethod.id}' does not contain a public key in JWK format`);
        }

        // Compute the key URI of the verification method's public key.
        const keyUri = await this.agent.keyManager.getKeyUri({ key: signingMethod.publicKeyJwk });

        // Verify that the key is present in the key manager. If not, an error is thrown.
        const publicKey = await this.agent.keyManager.getPublicKey({ keyUri });

        // Bind the Agent's Key Manager to the signer.
        const keyManager = this.agent.keyManager;

        return {
          algorithm : CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey),
          keyId     : signingMethod.id,
          sign      : async (data: Uint8Array): Promise<Uint8Array> => {
            return await keyManager.sign({ data, keyUri: keyUri! });
          }
        };
      } catch (error: any) {
        throw new Error(`AgentDwnApi: Unable to get signer for author '${author}': ${error.message}`);
      }
    }
  }

  /**
   * Constructs an EncryptionKeyDeriver callback for the SDK.
   * Delegates to the standalone function in `dwn-encryption.ts`.
   *
   * @param didUri - The DID URI to create the key deriver for
   * @returns An EncryptionKeyDeriver callback object
   */
  public async getEncryptionKeyDeriver(
    didUri: string
  ): Promise<EncryptionKeyDeriver> {
    return getEncryptionKeyDeriverFn(this.agent, didUri);
  }

  /**
   * Resolves the keyAgreement verification method for the given DID and returns
   * the key ID, key URI, and public key JWK.
   *
   * @param didUri - The DID URI to look up
   */
  private async getEncryptionKeyInfo(
    didUri: string
  ): Promise<{ keyId: string; keyUri: KeyIdentifier; publicKeyJwk: PublicKeyJwk }> {
    return getEncryptionKeyInfoFn(this.agent, didUri);
  }

  /**
   * Constructs a ProtocolPath KeyDecrypter for the given DID.
   *
   * @param didUri - The DID URI to build a decrypter for
   */
  private async getKeyDecrypter(
    didUri: string
  ): Promise<KeyDecrypter> {
    return getKeyDecrypterFn(this.agent, didUri);
  }

  /**
   * Analyses a record write to determine which DIDs need context key delivery.
   *
   * @param params - Parameters for participant detection
   * @returns Set of DIDs that need context key delivery
   */
  public detectNewParticipants(params: {
    protocolDefinition: ProtocolDefinition;
    protocolPath: string;
    recipient?: string;
    tenantDid: string;
    authorDid?: string;
  }): Set<string> {
    return detectNewParticipantsFn(params);
  }

  /**
   * Fetches a protocol definition from the local DWN, with caching.
   * Returns undefined if the protocol is not installed.
   *
   * @param tenantDid - The tenant DID to query
   * @param protocolUri - The protocol URI to fetch
   * @returns The protocol definition, or undefined if not found
   */
  private async getProtocolDefinition(
    tenantDid: string,
    protocolUri: string,
    granteeDid?: string,
  ): Promise<ProtocolDefinition | undefined> {
    if (!this._dwn) {
      // Remote mode: query via RPC (same as fetchRemoteProtocolDefinition,
      // but for locally-managed DIDs). The remote protocol definition
      // cache uses a different key prefix, so we use a dedicated call.
      try {
        return await this.fetchRemoteProtocolDefinition(tenantDid, protocolUri);
      } catch (error: unknown) {
        // Only treat "not found" responses as missing protocols.  Transient
        // errors (network timeouts, auth failures) are rethrown so the
        // caller does not silently skip encryption or other protocol-
        // required behaviours.
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('not found') || msg.includes('404') || msg.includes('No protocol')) {
          return undefined;
        }
        throw error;
      }
    }
    // When operating as a delegate, resolve the ProtocolsQuery grant so
    // the local DWN authorises the query for unpublished protocols.
    let permissionGrantId: string | undefined;
    if (granteeDid) {
      try {
        const permissionsApi = new AgentPermissionsApi({ agent: this.agent });
        const { grant } = await permissionsApi.getPermissionForRequest({
          connectedDid : tenantDid,
          delegateDid  : granteeDid,
          protocol     : protocolUri,
          cached       : true,
          messageType  : DwnInterface.ProtocolsQuery,
        });
        permissionGrantId = grant.id;
      } catch {
        // No grant found — try without (works for published protocols).
      }
    }

    return getProtocolDefinitionFn(
      tenantDid, protocolUri, this._dwn,
      this.getSigner.bind(this), this._protocolDefinitionCache,
      granteeDid, permissionGrantId,
    );
  }

  /**
   * Fetches a protocol definition from a remote DWN.
   * Uses an unsigned ProtocolsQuery (public protocols can be queried anonymously).
   */
  private async fetchRemoteProtocolDefinition(
    targetDid: string,
    protocolUri: string,
  ): Promise<ProtocolDefinition> {
    return fetchRemoteProtocolDefinitionFn(
      targetDid, protocolUri, this.getDwnEndpointUrlsForTarget.bind(this),
      this.sendDwnRpcRequest.bind(this), this._protocolDefinitionCache,
    );
  }

  /**
   * Extracts the `derivedPublicKey` from an existing ProtocolContext-encrypted
   * record in a context on a remote DWN. This key allows an external author to
   * encrypt new records in the same context without knowing the context private key.
   *
   * @param targetDid      - The DWN owner's DID
   * @param protocolUri    - The protocol URI to search
   * @param rootContextId  - The root context ID
   * @param requesterDid   - The DID of the requester (used for signing the query)
   * @returns The rootKeyId and derivedPublicKey, or undefined if no ProtocolContext
   *          record exists yet
   */
  private async extractDerivedPublicKey(
    targetDid: string,
    protocolUri: string,
    rootContextId: string,
    requesterDid: string,
  ): Promise<{ rootKeyId: string; derivedPublicKey: PublicKeyJwk } | undefined> {
    return extractDerivedPublicKeyFn(
      targetDid, protocolUri, rootContextId, requesterDid,
      this.getDwnEndpointUrlsForTarget.bind(this), this.getSigner.bind(this),
      this.sendDwnRpcRequest.bind(this),
    );
  }

  /**
   * Post-processes a DWN reply, auto-decrypting data if encryption is enabled.
   * Delegates to the standalone function in `dwn-encryption.ts`.
   */
  private async maybeDecryptReply<T extends DwnInterface>(
    request: ProcessDwnRequest<T> | SendDwnRequest<T>,
    reply: DwnMessageReply[T],
  ): Promise<void> {
    return maybeDecryptReplyFn(
      request, reply, this.agent,
      this._contextDerivedKeyCache,
      this.fetchContextKeyRecord.bind(this),
      this._delegateDecryptionKeyCache,
      this._delegateContextKeyCache,
    );
  }

  private async getDwnMessage<T extends DwnInterface>({ author, messageCid }: {
    author: string;
    messageType: T;
    messageCid: string;
  }): Promise<DwnMessageWithRpcData<T>> {
    const signer = await this.getSigner(author);

    // Construct a MessagesRead message to fetch the message.
    const messagesRead = await dwnMessageConstructors[DwnInterface.MessagesRead].create({
      messageCid: messageCid,
      signer
    });

    let result: any;

    if (this._dwn) {
      // Local mode: process directly with the in-process DWN.
      result = await this._dwn.processMessage(author, messagesRead.message);
    } else {
      // Remote mode: route through RPC to the local DWN server.
      result = await this.sendDwnRpcRequest({
        targetDid       : author,
        dwnEndpointUrls : [this._localDwnEndpoint!],
        message         : messagesRead.message,
      });
    }

    if (result.status.code !== 200) {
      throw new Error(`AgentDwnApi: Failed to read message, response status: ${result.status.code} - ${result.status.detail}`);
    }

    const messageEntry = result.entry!;
    const message = messageEntry.message as DwnMessage[T];

    const dwnMessageWithData: DwnMessageWithRpcData<T> = { message };
    // If the message is a RecordsWrite, data will be present in the form of a stream

    if (isRecordsWrite(messageEntry)) {
      // The processMessage result attaches a `data` ReadableStream to
      // RecordsWrite entries, but the declared type doesn't include it.
      // Narrow structurally to the runtime shape rather than going via
      // `Record<string, unknown>` (which loses the value type entirely).
      const entryData = (messageEntry as { data?: ReadableStream<Uint8Array> }).data;
      if (entryData) {
        dwnMessageWithData.data = entryData;
      }
    }

    return dwnMessageWithData;
  }

  // ---------------------------------------------------------------------------
  // Key Delivery Protocol
  // ---------------------------------------------------------------------------

  /**
   * Cache for key delivery protocol installation status per tenant.
   * Once confirmed installed, we skip re-checking for 21 days.
   */
  private readonly _keyDeliveryProtocolInstalledCache = new TtlCache<string, boolean>({
    ttl : 21 * 24 * 60 * 60 * 1000,
    max : 1000,
  });

  /**
   * Ensures the key delivery protocol is installed on the given tenant's DWN,
   * with `$encryption` keys injected.
   *
   * @param tenantDid - The DID of the DWN owner
   */
  public async ensureKeyDeliveryProtocol(tenantDid: string): Promise<void> {
    return ensureKeyDeliveryProtocolFn(
      this.agent, tenantDid,
      this.processRequest.bind(this),
      this.getProtocolDefinition.bind(this),
      this._keyDeliveryProtocolInstalledCache,
      this._protocolDefinitionCache,
    );
  }

  /**
   * Imports scope-aware decryption keys for delegate sessions.
   *
   * Called during the connect flow when the wallet delivers decryption keys
   * for encrypted protocols. Keys are derived only for read-like scopes
   * (Read/Query/Subscribe) — write-only delegates receive no keys.
   *
   * The keys are cached and used by `resolveKeyDecrypter()` to decrypt
   * records when the delegate does not possess the owner's root X25519
   * private key.
   *
   * @param delegateDid - The delegate DID for this session (unique per connect)
   * @param keys - Array of scope-aware decryption key entries
   */

  /**
   * Sets a callback invoked whenever post-connect context keys are
   * delivered to a delegate. The auth layer uses this to persist
   * updated context keys so they survive restart.
   *
   * @param callback - Called with the delegateDid that received new keys.
   *                   Set to `undefined` to unregister.
   */
  public set onDelegateContextKeysChanged(
    callback: ((delegateDid: string) => void) | undefined,
  ) {
    this._onDelegateContextKeysChanged = callback;
  }

  public importDelegateDecryptionKeys(
    delegateDid: string,
    keys: {
      protocol: string;
      scope: { kind: 'protocol' } | { kind: 'protocolPath'; protocolPath: string; match: 'exact' };
      derivedPrivateKey: DerivedPrivateJwk;
    }[],
  ): void {
    const cacheKey = `ddk~${delegateDid}`;
    this._delegateDecryptionKeyCache.set(cacheKey, keys);
  }

  /**
   * Imports ProtocolContext decryption keys for multi-party encrypted protocols.
   * Each key is scoped to one rootContextId within one protocol.
   *
   * @param delegateDid - The delegate DID for this session
   * @param keys - Array of `{ protocol, contextId, derivedPrivateKey }` entries
   */
  public importDelegateContextKeys(
    delegateDid: string,
    keys: {
      protocol: string;
      contextId: string;
      derivedPrivateKey: DerivedPrivateJwk;
    }[],
    multiPartyProtocols?: string[],
  ): void {
    // Clear any previously indexed entries for this delegate first,
    // so a re-import (e.g. session restore) doesn't leave stale entries.
    const previousKeys = this._delegateContextKeyCacheIndex.get(delegateDid);
    if (previousKeys) {
      for (const ck of previousKeys) { this._delegateContextKeyCache.delete(ck); }
    }

    const cacheKeys: string[] = [];
    for (const key of keys) {
      const ck = `dctx~${delegateDid}~${key.protocol}~${key.contextId}`;
      this._delegateContextKeyCache.set(ck, key.derivedPrivateKey);
      cacheKeys.push(ck);
    }
    this._delegateContextKeyCacheIndex.set(delegateDid, cacheKeys);

    // Populate the explicit multi-party protocol registry.
    // Sources: explicit parameter (always wins) + protocols from delivered keys.
    const protocols = new Set<string>(multiPartyProtocols ?? []);
    for (const key of keys) { protocols.add(key.protocol); }
    if (protocols.size > 0) {
      this._delegateMultiPartyProtocols.set(delegateDid, protocols);
    } else {
      this._delegateMultiPartyProtocols.delete(delegateDid);
    }
  }

  /**
   * Clears all delegate decryption keys (both ProtocolPath and ProtocolContext)
   * from the in-memory cache. Called on disconnect to prevent stale keys from
   * persisting across sessions.
   *
   * @param delegateDid - If provided, clears keys for that delegate session only.
   *                      If omitted, clears all delegate keys.
   */
  public clearDelegateDecryptionKeys(delegateDid?: string): void {
    if (delegateDid) {
      this._delegateDecryptionKeyCache.delete(`ddk~${delegateDid}`);
      // Delete only context keys belonging to this delegate.
      const cacheKeys = this._delegateContextKeyCacheIndex.get(delegateDid);
      if (cacheKeys) {
        for (const ck of cacheKeys) { this._delegateContextKeyCache.delete(ck); }
        this._delegateContextKeyCacheIndex.delete(delegateDid);
      }
      this._delegateMultiPartyProtocols.delete(delegateDid);
    } else {
      this._delegateDecryptionKeyCache.clear();
      this._delegateContextKeyCache.clear();
      this._delegateContextKeyCacheIndex.clear();
      this._delegateMultiPartyProtocols.clear();
    }
  }

  /**
   * Exports the current set of delegate context keys for a specific delegate.
   * Returns an array of `{ protocol, contextId, derivedPrivateKey }` entries
   * suitable for serialization and persistence.
   *
   * Called by the auth layer to persist context keys (including keys delivered
   * post-connect) so they survive agent restarts.
   *
   * @param delegateDid - The delegate DID whose context keys to export
   * @returns Array of context key entries (may be empty)
   */
  public exportDelegateContextKeys(
    delegateDid: string,
  ): { protocol: string; contextId: string; derivedPrivateKey: DerivedPrivateJwk }[] {
    const cacheKeys = this._delegateContextKeyCacheIndex.get(delegateDid);
    if (!cacheKeys) { return []; }

    const result: { protocol: string; contextId: string; derivedPrivateKey: DerivedPrivateJwk }[] = [];
    const prefix = `dctx~${delegateDid}~`;

    for (const ck of cacheKeys) {
      const key = this._delegateContextKeyCache.get(ck);
      if (!key || !ck.startsWith(prefix)) { continue; }

      // Parse protocol and contextId from cache key:
      // format is `dctx~<delegateDid>~<protocol>~<contextId>`
      // contextId is always the last segment; protocol is everything between.
      const rest = ck.slice(prefix.length);
      const lastTilde = rest.lastIndexOf('~');
      if (lastTilde === -1) { continue; }

      result.push({
        protocol          : rest.slice(0, lastTilde),
        contextId         : rest.slice(lastTilde + 1),
        derivedPrivateKey : key,
      });
    }

    return result;
  }

  /**
   * Exports the registered multi-party protocol URIs for a delegate.
   * Used by the auth layer for persistence.
   */
  public exportDelegateMultiPartyProtocols(delegateDid: string): string[] {
    const protocols = this._delegateMultiPartyProtocols.get(delegateDid);
    return protocols ? [...protocols] : [];
  }

  /**
   * Checks whether any active delegate session has context keys for the
   * given protocol. Used by `postWriteKeyDelivery()` to determine if
   * delegate delivery is needed.
   */
  private hasEligibleDelegatesForProtocol(protocol: string): boolean {
    for (const [, protocols] of this._delegateMultiPartyProtocols) {
      if (protocols.has(protocol)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Delivers a newly created multi-party context key to all active delegate
   * sessions that have existing context keys for the given protocol.
   *
   * This is same-process delivery: the context key is injected directly
   * into `_delegateContextKeyCache`. It works when the delegate cache is
   * on the same agent instance that creates the root record.
   *
   * Cross-device DWN-based delivery (where the owner's agent and the
   * delegate's agent are separate processes) is a documented follow-up.
   *
   * @param protocol - The protocol URI
   * @param rootContextId - The root context ID of the new context
   * @param contextKey - The derived context key (`DerivedPrivateJwk`)
   */
  private deliverContextKeyToDelegates(
    protocol: string,
    rootContextId: string,
    contextKey: DerivedPrivateJwk,
  ): void {
    for (const [delegateDid, protocols] of this._delegateMultiPartyProtocols) {
      if (!protocols.has(protocol)) { continue; }

      // Skip if this delegate already has a key for this context (idempotent).
      const newCacheKey = `dctx~${delegateDid}~${protocol}~${rootContextId}`;
      if (this._delegateContextKeyCache.get(newCacheKey)) { continue; }

      this._delegateContextKeyCache.set(newCacheKey, contextKey);
      const indexKeys = this._delegateContextKeyCacheIndex.get(delegateDid) ?? [];
      indexKeys.push(newCacheKey);
      this._delegateContextKeyCacheIndex.set(delegateDid, indexKeys);

      // Notify the auth layer so it can persist the updated keys.
      this._onDelegateContextKeysChanged?.(delegateDid);
    }
  }

  /**
   * Delivers a newly created multi-party context key to eligible delegates
   * by writing `contextKey` records to the owner's DWN via the key-delivery
   * protocol. This enables cross-device delivery: the delegate can later
   * fetch the record from the owner's DWN and decrypt it.
   *
   * Eligible delegates are discovered by querying the owner's DWN for
   * active permission grants with read-like scopes on the given protocol.
   *
   * The contextKey record is encrypted using the delegate's pre-derived
   * key-delivery leaf public key, which is stored in the grant's tags
   * during `submitConnectResponse()`.
   *
   * @param tenantDid - The owner's DID
   * @param protocol - The protocol URI
   * @param rootContextId - The root context ID of the new context
   * @param contextKey - The derived context key (`DerivedPrivateJwk`)
   */
  private async deliverContextKeyToDelegatesViaDwn(
    tenantDid: string,
    protocol: string,
    rootContextId: string,
    contextKey: DerivedPrivateJwk,
  ): Promise<void> {
    try {
      const permissionsApi = new AgentPermissionsApi({ agent: this.agent });
      const grants = await permissionsApi.fetchGrants({
        author       : tenantDid,
        target       : tenantDid,
        grantor      : tenantDid,
        protocol,
        checkRevoked : true,
      });

      const readMethods = new Set(['Read', 'Query', 'Subscribe']);
      const nowMs = Date.now();

      // Deduplicate: one contextKey per delegate, not per grant.
      // Multiple grants (Read, Query, Subscribe) for the same delegate
      // should produce exactly one contextKey record.
      // IMPORTANT: dedup happens AFTER tag validation so that an older
      // untagged grant doesn't shadow a valid tagged grant for the same delegate.
      const deliveredDelegates = new Set<string>();

      for (const grant of grants) {
        // Only delegated grants are eligible. Non-delegated grants (direct
        // access without a delegate session) should not trigger cross-device
        // context key delivery.
        if (!grant.grant.delegated) { continue; }

        // Filter expired grants. fetchGrants checks revocation but does
        // NOT filter by dateExpires. Use numeric comparison for safety.
        if (new Date(grant.grant.dateExpires).getTime() <= nowMs) { continue; }

        const scope = grant.grant.scope as any;
        if (scope.interface !== 'Records' || !readMethods.has(scope.method)) { continue; }

        // Narrow scopes (protocolPath, contextId) are not supported for
        // multi-party delegate delivery — skip them silently.
        if (scope.protocolPath || scope.contextId) { continue; }

        const delegateDid = grant.grant.grantee;

        // Read the pre-derived key-delivery leaf public key from the
        // grant data payload. This was computed during submitConnectResponse()
        // and stored alongside the grant's standard fields.
        const keyDelivery = grant.grant.delegateKeyDelivery;
        if (!keyDelivery?.rootKeyId || !keyDelivery?.publicKeyJwk) {
          // Grant was created before key-delivery was supported, or
          // is not a read-like grant. Skip — do NOT dedup yet.
          continue;
        }

        // Dedup check — skip if already delivered via an earlier grant.
        if (deliveredDelegates.has(delegateDid)) { continue; }

        const leafPublicKeyJwk = keyDelivery.publicKeyJwk as PublicKeyJwk;

        try {
          await this.writeContextKeyRecord({
            tenantDid,
            recipientDid                  : delegateDid,
            contextKeyData                : contextKey,
            sourceProtocol                : protocol,
            sourceContextId               : rootContextId,
            recipientKeyDeliveryPublicKey : {
              rootKeyId    : keyDelivery.rootKeyId,
              publicKeyJwk : leafPublicKeyJwk,
            },
          });

          // Mark as delivered ONLY after the write succeeds. If the write
          // fails, a later valid grant for the same delegate can still try.
          deliveredDelegates.add(delegateDid);
        } catch (delegateError: any) {
          console.warn(
            `AgentDwnApi: Cross-device key delivery to delegate ` +
            `'${delegateDid}' for context '${rootContextId}' failed: ` +
            `${delegateError.message}. The delegate may need to reconnect.`
          );
        }
      }
    } catch (discoveryError: any) {
      // Grant discovery failure is non-fatal — same-process delivery may
      // still have succeeded, and sync will eventually deliver the record.
      console.warn(
        `AgentDwnApi: Delegate grant discovery for protocol ` +
        `'${protocol}' failed: ${discoveryError.message}`
      );
    }
  }

  /**
   * Registers a fire-and-forget eager-send promise in the in-flight tracker so
   * it can be awaited by `drainPendingEagerSends()` during teardown. The entry
   * auto-removes on settlement via `.finally`.
   *
   * The promise is returned **unchanged** so callers can still chain `.catch`
   * on it for observability (e.g. the existing `console.warn` on failure).
   *
   * @param p - The eager-send promise to track. Must always resolve (callers
   *   are expected to attach a `.catch` handler before passing).
   * @returns The same `p`, unchanged.
   */
  private trackEagerSend(p: Promise<void>): Promise<void> {
    this._pendingEagerSends.add(p);
    p.finally((): void => { this._pendingEagerSends.delete(p); });
    return p;
  }

  /**
   * Waits for all currently-tracked eager-send promises to settle. Used by
   * the test harness during teardown (`clearStorage()`/`closeStorage()`) to
   * prevent orphan promises from touching closed stores or nulled state.
   *
   * Snapshot semantics: awaits only the sends tracked at the moment of
   * invocation. Sends registered **after** this call begins are not joined
   * into its drain — a subsequent `drainPendingEagerSends()` is needed to
   * await them.
   *
   * Fast path: when no sends are tracked, resolves immediately without
   * invoking `Promise.allSettled([])`.
   *
   * @returns A promise that resolves to `undefined` once all snapshotted
   *   sends have settled. Never rejects (uses `allSettled` semantics).
   */
  public async drainPendingEagerSends(): Promise<void> {
    if (this._pendingEagerSends.size === 0) {
      return;
    }
    const snapshot = [...this._pendingEagerSends];
    await Promise.allSettled(snapshot);
  }

  /**
   * Writes a `contextKey` record to the owner's DWN, delivering an encrypted
   * context key to a participant.
   *
   * @param params - The write parameters
   * @returns The recordId of the written contextKey record
   */
  public async writeContextKeyRecord(params: {
    tenantDid: string;
    recipientDid: string;
    contextKeyData: DerivedPrivateJwk;
    sourceProtocol: string;
    sourceContextId: string;
    recipientKeyDeliveryPublicKey?: { rootKeyId: string; publicKeyJwk: PublicKeyJwk };
  }): Promise<string> {
    return writeContextKeyRecordFn(
      this.agent, params,
      this.processRequest.bind(this),
      this.ensureKeyDeliveryProtocol.bind(this),
      this.eagerSendContextKeyRecord.bind(this),
      this.trackEagerSend.bind(this),
    );
  }

  /**
   * Eagerly sends a contextKey record to the tenant's remote DWN.
   * This is best-effort — sync guarantees eventual consistency regardless.
   */
  private async eagerSendContextKeyRecord(
    tenantDid: string,
    contextKeyMessage: DwnMessage[DwnInterface.RecordsWrite],
  ): Promise<void> {
    return eagerSendContextKeyRecordFn(
      this.agent, tenantDid, contextKeyMessage,
      this.getDwnMessage.bind(this),
      this.sendDwnRpcRequest.bind(this),
      this.getDwnEndpointUrlsForTarget.bind(this),
    );
  }

  /**
   * Fetches and decrypts a `contextKey` record from a DWN, returning the
   * `DerivedPrivateJwk` payload.
   *
   * @param params - The fetch parameters
   * @returns The decrypted `DerivedPrivateJwk`, or `undefined` if no matching record found
   */
  public async fetchContextKeyRecord(params: {
    ownerDid: string;
    requesterDid: string;
    sourceProtocol: string;
    sourceContextId: string;
  }): Promise<DerivedPrivateJwk | undefined> {
    return fetchContextKeyRecordFn(
      this.agent, params,
      this.processRequest.bind(this),
    );
  }
}
