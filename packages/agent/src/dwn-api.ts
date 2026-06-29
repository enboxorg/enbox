import type {
  DerivedPrivateJwk,
  DwnConfig,
  EncryptionKeyDeriver,
  EventLog,
  GenericMessage,
  KeyDecrypter,
  MessageStore,
  ProgressToken,
  ProtocolDefinition,
  ReplicationApplyResult,
} from '@enbox/dwn-sdk-js';
import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { KeyIdentifier, PublicKeyJwk } from '@enbox/crypto';

import { CryptoUtils } from '@enbox/crypto';
import {
  Cid,
  ContentEncryptionAlgorithm,
  DataStoreLevel,
  DataStream,
  DurableEventLog,
  Dwn,
  DwnMethodName,
  Encryption,
  EventEmitterWakePublisher,
  KeyDerivationScheme,
  Message,
  MessageStoreLevel,
  Protocols,
  ResumableTaskStoreLevel,
} from '@enbox/dwn-sdk-js';
import { Convert, TtlCache } from '@enbox/common';
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

type MessageLog = {
  eventLog: EventLog;
  messageStore: MessageStore;
};

type DwnApiCreateDwnParams = Omit<Partial<DwnConfig>, 'eventLog' | 'messageStore'> & {
  dataPath?: string;

  /**
   * Inject a platform-specific message store together with its durable event log.
   * They are coupled because the event log reads the store's replication feed and must
   * share its wake publisher, so they are provided as a pair or omitted for defaults.
   */
  messageLog?: MessageLog;
};

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
    dataPath, dataStore, didResolver, messageLog, tenantGate, resumableTaskStore
  }: DwnApiCreateDwnParams): Promise<Dwn> {
    dataStore ??= new DataStoreLevel({ blockstoreLocation: `${dataPath}/DWN_DATASTORE` });

    didResolver ??= new UniversalResolver({
      didResolvers : [DidDht, DidJwk],
      cache        : new DidResolverCacheLevel({ location: `${dataPath}/DID_RESOLVERCACHE` }),
    });

    resumableTaskStore ??= new ResumableTaskStoreLevel({ location: `${dataPath}/DWN_RESUMABLETASKSTORE` });

    const { eventLog, messageStore } = messageLog ?? AgentDwnApi.createDefaultMessageLog(dataPath);

    return await Dwn.create({ dataStore, didResolver, eventLog, messageStore, tenantGate, resumableTaskStore });
  }

  private static createDefaultMessageLog(dataPath?: string): MessageLog {
    const wakePublisher = new EventEmitterWakePublisher();
    const messageStore = new MessageStoreLevel({
      location: `${dataPath}/DWN_MESSAGESTORE`,
      wakePublisher,
    });

    return { eventLog: new DurableEventLog(messageStore, wakePublisher), messageStore };
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

  /** Current DWN encryption does not emit post-write legacy key-delivery records. */
  private async postWriteKeyDelivery<T extends DwnInterface>(
    request: ProcessDwnRequest<T>,
    message: DwnMessage[T],
    reply: DwnMessageReply[T],
  ): Promise<void> {
    void request;
    void message;
    void reply;
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

    // Cache locally-imported protocol definitions so delegated encrypted
    // writes can resolve `$keyAgreement` keys without re-querying unpublished
    // owner-tenant protocols.
    if (isDwnRequest(request, DwnInterface.ProtocolsConfigure) && !request.encryption) {
      const protocolConfigureMessage = rawMessage as DwnMessage[DwnInterface.ProtocolsConfigure] | undefined;
      const def = protocolConfigureMessage?.descriptor.definition ?? request.messageParams?.definition;
      if (def?.protocol) {
        this._protocolDefinitionCache.set(`${request.target}~${def.protocol}`, def);
      }
    }

    // Auto-encrypt RecordsWrite data to the exact protocol-path `$keyAgreement`
    // key published by the target's installed protocol definition.

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

        // 2. Walk the protocol structure to find $keyAgreement for this protocol path
        const protocolPathSegments = messageParams.protocolPath.split('/');
        let ruleSet: any = protocolDefinition.structure;
        for (const segment of protocolPathSegments) {
          ruleSet = ruleSet[segment];
        }

        if (!ruleSet?.$keyAgreement) {
          throw new Error(
            `AgentDwnApi: Protocol '${messageParams.protocol}' at path ` +
            `'${messageParams.protocolPath}' does not have encryption configured. ` +
            `Configure the protocol with encryption: true.`
          );
        }

        // 3. Get plaintext bytes (normalize from all supported input types)
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

        // 4. Generate random DEK and IV.
        const contentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256CTR;
        const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
        const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(ivLengthFn(contentEncryptionAlgorithm)));

        // 5. Build ProtocolPath encryption input.
        const protocolPathPublicKey = ruleSet.$keyAgreement.publicKeyJwk as PublicKeyJwk;
        const encryptionInput = buildEncryptionInputFn(
          dataEncryptionKey, dataEncryptionIV,
          await Encryption.getKeyId(protocolPathPublicKey), protocolPathPublicKey,
          KeyDerivationScheme.ProtocolPath,
        );

        // 6. Encrypt data and compute CID.
        const { encryptedBytes, dataCid, dataSize } =
          await encryptAndComputeCidFn(plaintextBytes, dataEncryptionKey, dataEncryptionIV, contentEncryptionAlgorithm);

        // 7. Replace plaintext with encrypted data.
        messageParams.dataCid = dataCid;
        messageParams.dataSize = dataSize;
        delete messageParams.data;
        readableStream = DataStream.fromBytes(encryptedBytes);
        request.dataStream = undefined;
        messageParams.encryptionInput = encryptionInput;
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
   * with `$keyAgreement` keys injected.
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
   * for encrypted protocols. Keys are derived only for `Records.Read`
   * scopes — write-only delegates receive no keys.
   *
   * The keys are cached and used by `resolveKeyDecrypter()` to decrypt
   * records when the delegate does not possess the owner's root X25519
   * private key.
   *
   * @param delegateDid - The delegate DID for this session (unique per connect)
   * @param keys - Array of scope-aware decryption key entries
   */

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
   * Clears delegate decryption keys from the in-memory cache.
   *
   * @param delegateDid - If provided, clears keys for that delegate session only.
   *                      If omitted, clears all delegate keys.
   */
  public clearDelegateDecryptionKeys(delegateDid?: string): void {
    if (delegateDid) {
      this._delegateDecryptionKeyCache.delete(`ddk~${delegateDid}`);
    } else {
      this._delegateDecryptionKeyCache.clear();
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
