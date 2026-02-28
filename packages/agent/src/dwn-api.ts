import type {
  DerivedPrivateJwk,
  DwnConfig,
  EncryptionInput,
  EncryptionKeyDeriver,
  GenericMessage,
  KeyDecrypter,
  ProtocolDefinition,
  RecordsWrite,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';
import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { KeyIdentifier, PrivateKeyJwk, PublicKeyJwk } from '@enbox/crypto';

import { TtlCache } from '@enbox/common';
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
import { CryptoUtils, X25519 } from '@enbox/crypto';
import { DidDht, DidJwk, DidResolverCacheLevel, UniversalResolver } from '@enbox/dids';

import type { LocalDwnStrategy } from './local-dwn.js';
import type { Web5PlatformAgent } from './types/agent.js';
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

import { DwnDiscoveryFile } from './dwn-discovery-file.js';
import { KeyDeliveryProtocolDefinition } from './store-data-protocols.js';
import { LocalDwnDiscovery } from './local-dwn.js';
import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';
import { getDwnServiceEndpointUrls, isRecordsWrite } from './utils.js';

// Re-export type guards for backward compatibility
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

// Import extracted record upgrade function
import { upgradeExternalRootRecord as upgradeExternalRootRecordFn } from './dwn-record-upgrade.js';

// Import extracted protocol definition fetching functions
import {
  extractDerivedPublicKey as extractDerivedPublicKeyFn,
  fetchRemoteProtocolDefinition as fetchRemoteProtocolDefinitionFn,
  getProtocolDefinition as getProtocolDefinitionFn,
} from './dwn-protocol-cache.js';

type DwnMessageWithBlob<T extends DwnInterface> = {
  message: DwnMessage[T];
  data?: Blob;
};

type DwnApiParams = {
  agent?: Web5PlatformAgent;
  dwn: Dwn;
  localDwnStrategy?: LocalDwnStrategy;
};

interface DwnApiCreateDwnParams extends Partial<DwnConfig> {
  dataPath?: string;
}

export class AgentDwnApi {
  /**
   * Holds the instance of a `Web5PlatformAgent` that represents the current execution context for
   * the `AgentDwnApi`. This agent is used to interact with other Web5 agent components. It's vital
   * to ensure this instance is set to correctly contextualize operations within the broader Web5
   * Agent framework.
   */
  private _agent?: Web5PlatformAgent;

  /**
   * The DWN instance to use for this API.
   */
  private _dwn: Dwn;

  /**
   * Protocol definition cache — TTL 30 minutes. Protocols rarely change.
   * Keyed by `${tenantDid}~${protocolUri}`.
   */
  private _protocolDefinitionCache = new TtlCache<string, ProtocolDefinition>({
    ttl: 30 * 60 * 1000
  });

  /**
   * Context key cache — stores resolved context encryption key info for
   * multi-party protocols. Keyed by rootContextId. TTL 30 minutes.
   */
  private _contextKeyCache = new TtlCache<string, {
    keyId: string;
    keyUri: KeyIdentifier;
    contextDerivationPath: string[];
  }>({ ttl: 30 * 60 * 1000 });

  /**
   * Context-derived private key cache — stores DerivedPrivateJwk for contexts
   * where the current user is a participant (not the creator).
   * Keyed by `ctx~${authorDid}~${rootContextId}`. TTL 30 minutes.
   */
  private _contextDerivedKeyCache = new TtlCache<string, DerivedPrivateJwk>({
    ttl: 30 * 60 * 1000
  });

  /**
   * Cache of locally-managed DIDs (agent DID + identities). Used to decide
   * whether a target DID should be routed through the local DWN server.
   */
  private _localManagedDidCache = new TtlCache<string, boolean>({
    ttl: 30 * 60 * 1000
  });

  /** Controls local DWN discovery behavior ('prefer' | 'only' | 'off'). */
  private _localDwnStrategy: LocalDwnStrategy;

  /** Lazy-initialized local DWN discovery instance. */
  private _localDwnDiscovery?: LocalDwnDiscovery;

  constructor({ agent, dwn, localDwnStrategy = 'prefer' }: DwnApiParams) {
    // If an agent is provided, set it as the execution context for this API.
    this._agent = agent;

    // Set the DWN instance for this API.
    this._dwn = dwn;

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
   * Retrieves the `Web5PlatformAgent` execution context.
   *
   * @returns The `Web5PlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): Web5PlatformAgent {
    if (this._agent === undefined) {
      throw new Error('AgentDwnApi: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: Web5PlatformAgent) {
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
          `AgentDwnApi: Local DWN strategy is 'only' but no local server is available ` +
          `on localhost/127.0.0.1:{3000,55555-55559}`
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

  /** Lazily retrieves the local DWN server endpoint via discovery. */
  private async getLocalDwnEndpoint(): Promise<string | undefined> {
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
   *   `Web5PlatformAgent`. In other words, so that a developer can call `agent.dwn.node` to access
   *   the DWN instance and not `agent.dwn.dwn`.
   */
  get node(): Dwn {
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
      blockstoreLocation : `${dataPath}/DWN_MESSAGESTORE`,
      indexLocation      : `${dataPath}/DWN_MESSAGEINDEX`
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
    const reply: DwnMessageReply[T] = (request.store !== false)
      ? await this._dwn.processMessage(request.target, message, { dataStream: dataStream as any, subscriptionHandler })
      : { status: { code: 202, detail: 'Accepted' } };


    // Post-write key delivery: detect new participants and write contextKey records.
    await this.postWriteKeyDelivery(request, message, reply);

    // Auto-decrypt reply data if encryption is enabled (Component 7)
    await this.maybeDecryptReply(request, reply);

    // Returns an object containing the reply from processing the message, the original message,
    // and the content identifier (CID) of the message.
    return {
      reply,
      message,
      messageCid: await Message.getCid(message),
    };
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
    let data: Blob | undefined;
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
      ({ message } = await this.constructDwnMessage({ request }));
      if (request.dataStream && !(request.dataStream instanceof Blob)) {
        throw new Error('AgentDwnApi: DataStream must be provided as a Blob');
      }
      data = request.dataStream;
      subscriptionHandler = request.subscriptionHandler;
    }

    // Build a resubscribe factory for subscribe requests. This closure
    // captures the original request so it can reconstruct and re-sign a new
    // subscribe message with a cursor on reconnection.
    let resubscribeFactory: ResubscribeFactory | undefined;
    if (subscriptionHandler !== undefined && !('messageCid' in request)) {
      resubscribeFactory = async (cursor?: string): Promise<GenericMessage> => {
        const resumeParams = cursor !== undefined
          ? { ...request.messageParams, cursor } as DwnMessageParams[T]
          : request.messageParams;

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

      // Reactive root-record upgrade (PR E): if this is an externally-authored
      // root record with only ProtocolPath encryption, the owner upgrades it by
      // appending a ProtocolContext recipient entry so that context key
      // holders (including the external author) can also decrypt.
      const authorDid = Jws.getSignerDid(
        recordsWriteMessage.authorization.signature.signatures[0]
      );
      const isExternallyAuthored = authorDid !== request.target;
      const isRootRecord = !writeParams.parentContextId;
      const rootPathSegment = writeParams.protocolPath.split('/')[0];
      const isMultiParty = isMultiPartyContextFn(protocolDefinition, rootPathSegment);

      if (isExternallyAuthored && isRootRecord && isMultiParty) {
        try {
          await upgradeExternalRootRecordFn(
            this.agent, request.target, recordsWriteMessage,
            this._dwn, this.getSigner.bind(this), this._contextKeyCache,
          );
        } catch (upgradeError: any) {
          console.warn(
            `AgentDwnApi: Reactive root-record upgrade failed for ` +
            `'${recordsWriteMessage.recordId}': ${upgradeError.message}`
          );
        }
      }

      const newParticipants = detectNewParticipantsFn({
        protocolDefinition,
        protocolPath : writeParams.protocolPath,
        recipient    : writeParams.recipient,
        tenantDid    : request.target,
        authorDid    : isExternallyAuthored ? authorDid : undefined,
      });

      if (newParticipants.size > 0) {
        // Derive the context key to deliver to participants
        const rootContextId = recordsWriteMessage.contextId?.split('/')[0]
          || recordsWriteMessage.contextId
          || recordsWriteMessage.recordId;

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
      data?: Blob;
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
    // TODO: Consider refactoring to move data transformations imposed by fetch() limitations to the HTTP transport-related methods.
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

    // Auto-encrypt data on RecordsWrite.
    //
    // Encryption scheme decision (unified key delivery):
    //   | Condition                                    | Scheme          |
    //   |----------------------------------------------|-----------------|
    //   | Local root record, multi-party               | ProtocolContext  | deferred (needs recordId)
    //   | Local non-root record, multi-party           | ProtocolContext  |
    //   | Local single-party                           | ProtocolPath    |
    //   | Cross-DWN root record, multi-party           | ProtocolPath    | target's key; owner upgrades later
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
    // public key. The target's agent reactively upgrades the record to include a
    // ProtocolContext recipient entry. Non-root records extract the context
    // public key (derivedPublicKey) from existing ProtocolContext-encrypted records
    // in the same context on the target's DWN.

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
            request.target, messageParams.protocol,
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
            // Fallback: no ProtocolContext-encrypted record exists yet (owner hasn't
            // upgraded the root record). Use ProtocolPath encryption instead.
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

    // if there is no raw message provided, we need to create the dwn message
    if (!rawMessage) {
      if (request.messageParams === undefined) {
        throw new Error('AgentDwnApi: messageParams must be provided when rawMessage is not given.');
      }

      // If we need to sign as an author delegate or with permissions we need to get the grantee's signer
      // The messageParams should include either a permissionGrantId, or a delegatedGrant message
      const signer = request.granteeDid ?
        await this.getSigner(request.granteeDid) :
        await this.getSigner(request.author);

      dwnMessage = await dwnMessageConstructor.create({
        ...request.messageParams,
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

    } else {
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
    }

    return {
      message    : dwnMessage.message as DwnMessage[T],
      dataStream : readableStream,
    };
  }

  private hasGrantParams<T extends DwnInterface>(params?: DwnMessageParams[T]): boolean {
    return params !== undefined &&
      (('permissionGrantId' in params && params.permissionGrantId !== undefined) ||
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
      // Otherwise, use the author's DID to determine the signing method.
      try {
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
  ): Promise<ProtocolDefinition | undefined> {
    return getProtocolDefinitionFn(
      tenantDid, protocolUri, this._dwn,
      this.getSigner.bind(this), this._protocolDefinitionCache,
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
    );
  }

  private async getDwnMessage<T extends DwnInterface>({ author, messageCid }: {
    author: string;
    messageType: T;
    messageCid: string;
  }): Promise<DwnMessageWithBlob<T>> {
    const signer = await this.getSigner(author);

    // Construct a MessagesRead message to fetch the message.
    const messagesRead = await dwnMessageConstructors[DwnInterface.MessagesRead].create({
      messageCid: messageCid,
      signer
    });

    const result = await this._dwn.processMessage(author, messagesRead.message);

    if (result.status.code !== 200) {
      throw new Error(`AgentDwnApi: Failed to read message, response status: ${result.status.code} - ${result.status.detail}`);
    }

    const messageEntry = result.entry!;
    const message = messageEntry.message as DwnMessage[T];

    const dwnMessageWithBlob: DwnMessageWithBlob<T> = { message };
    // If the message is a RecordsWrite, data will be present in the form of a stream

    if (isRecordsWrite(messageEntry) && messageEntry.data) {
      const dataBytes = await DataStream.toBytes(messageEntry.data);
      dwnMessageWithBlob.data = new Blob([ dataBytes ], { type: messageEntry.message.descriptor.dataFormat });
    }

    return dwnMessageWithBlob;
  }

  // ---------------------------------------------------------------------------
  // Key Delivery Protocol
  // ---------------------------------------------------------------------------

  /**
   * Cache for key delivery protocol installation status per tenant.
   * Once confirmed installed, we skip re-checking for 21 days.
   */
  private _keyDeliveryProtocolInstalledCache = new TtlCache<string, boolean>({
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
      this.getSigner.bind(this),
      this.sendDwnRpcRequest.bind(this),
      this.getDwnEndpointUrlsForTarget.bind(this),
    );
  }
}
