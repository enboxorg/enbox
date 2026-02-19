import type {
  DerivedPrivateJwk,
  DwnConfig,
  EncryptionInput,
  EncryptionKeyDeriver,
  GenericMessage,
  KeyDecrypter,
  ProtocolDefinition,
  ProtocolRuleSet,
  ProtocolsQueryReply,
  RecordsQueryReply,
  RecordsQueryReplyEntry,
  RecordsReadReply,
  RecordsWrite,
  RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { KeyIdentifier, PrivateKeyJwk, PublicKeyJwk } from '@enbox/crypto';

import { CryptoUtils } from '@enbox/crypto';
import { TtlCache } from '@enbox/common';
import {
  Cid,
  DataStoreLevel,
  DataStream,
  Dwn,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Encryption,
  EventEmitterStream,
  Jws,
  KeyDerivationScheme,
  Message,
  MessageStoreLevel,
  Protocols,
  Records,
  ResumableTaskStoreLevel,
  Secp256k1,
  StateIndexLevel
} from '@enbox/dwn-sdk-js';
import { DidDht, DidJwk, DidResolverCacheLevel, UniversalResolver } from '@enbox/dids';

import type { Web5PlatformAgent } from './types/agent.js';
import type {
  DwnMessage,
  DwnMessageInstance,
  DwnMessageParams,
  DwnMessageReply,
  DwnMessagesPermissionScope,
  DwnMessageWithData,
  DwnPermissionScope,
  DwnRecordsInterfaces,
  DwnRecordsPermissionScope,
  DwnResponse,
  DwnSigner,
  MessageHandler,
  ProcessDwnRequest,
  SendDwnRequest
} from './types/dwn.js';

import { KeyDeliveryProtocolDefinition } from './store-data-protocols.js';
import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';
import { getDwnServiceEndpointUrls, isRecordsWrite } from './utils.js';

type DwnMessageWithBlob<T extends DwnInterface> = {
  message: DwnMessage[T];
  data?: Blob;
};

type DwnApiParams = {
  agent?: Web5PlatformAgent;
  dwn: Dwn;
};

interface DwnApiCreateDwnParams extends Partial<DwnConfig> {
  dataPath?: string;
}

export function isDwnRequest<T extends DwnInterface>(
  dwnRequest: ProcessDwnRequest<DwnInterface>, messageType: T
): dwnRequest is ProcessDwnRequest<T> {
  return dwnRequest.messageType === messageType;
}

export function isDwnMessage<T extends DwnInterface>(
  messageType: T, message: GenericMessage
): message is DwnMessage[T] {
  const incomingMessageInterfaceName = message.descriptor.interface + message.descriptor.method;
  return incomingMessageInterfaceName === messageType;
}

export function isRecordsType(messageType: DwnInterface): messageType is DwnRecordsInterfaces {
  return messageType === DwnInterface.RecordsDelete ||
    messageType === DwnInterface.RecordsQuery ||
    messageType === DwnInterface.RecordsRead ||
    messageType === DwnInterface.RecordsSubscribe ||
    messageType === DwnInterface.RecordsWrite;
}

export function isRecordPermissionScope(scope: DwnPermissionScope): scope is DwnRecordsPermissionScope {
  return scope.interface === DwnInterfaceName.Records;
}

export function isMessagesPermissionScope(scope: DwnPermissionScope): scope is DwnMessagesPermissionScope {
  return scope.interface === DwnInterfaceName.Messages;
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

  constructor({ agent, dwn }: DwnApiParams) {
    // If an agent is provided, set it as the execution context for this API.
    this._agent = agent;

    // Set the DWN instance for this API.
    this._dwn = dwn;
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
    dataPath, dataStore, didResolver, stateIndex, eventStream, messageStore, tenantGate, resumableTaskStore
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

    eventStream ??= new EventEmitterStream();

    return await Dwn.create({ dataStore, didResolver, stateIndex, eventStream, messageStore, tenantGate, resumableTaskStore });
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
    // This replaces the old roleRecordAutoPush mechanism with the unified key delivery protocol.
    if (
      isDwnRequest(request, DwnInterface.RecordsWrite) &&
      request.encryption &&
      reply.status.code === 202
    ) {
      const writeParams = request.messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
      // Skip key-delivery protocol writes to avoid infinite recursion (contextKey records are themselves encrypted)
      if (writeParams?.protocol && writeParams.protocolPath && writeParams.protocol !== KeyDeliveryProtocolDefinition.protocol) {
        try {
          const protocolDefinition = await this.getProtocolDefinition(
            request.target, writeParams.protocol,
          );
          if (protocolDefinition) {
            const recordsWriteMessage = message as unknown as RecordsWriteMessage;

            // Reactive root-record upgrade (PR E): if this is an externally-authored
            // root record with only ProtocolPath encryption, the owner upgrades it by
            // appending a ProtocolContext keyEncryption entry so that context key
            // holders (including the external author) can also decrypt.
            const authorDid = Jws.getSignerDid(
              recordsWriteMessage.authorization.signature.signatures[0]
            );
            const isExternallyAuthored = authorDid !== request.target;
            const isRootRecord = !writeParams.parentContextId;
            const rootPathSegment = writeParams.protocolPath.split('/')[0];
            const isMultiParty = this.isMultiPartyContext(protocolDefinition, rootPathSegment);

            if (isExternallyAuthored && isRootRecord && isMultiParty) {
              try {
                await this.upgradeExternalRootRecord(request.target, recordsWriteMessage);
              } catch (upgradeError: any) {
                console.warn(
                  `AgentDwnApi: Reactive root-record upgrade failed for ` +
                  `'${recordsWriteMessage.recordId}': ${upgradeError.message}`
                );
              }
            }

            const newParticipants = this.detectNewParticipants({
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

              const { keyId, keyUri } = await this.getEncryptionKeyInfo(request.target);
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
                await Secp256k1.privateKeyToJwk(contextDerivedPrivateKeyBytes);
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
          }
        } catch (detectionError: any) {
          // Participant detection failure is non-fatal — the record is still stored.
          console.warn(
            `AgentDwnApi: Post-write participant detection failed: ` +
            `${detectionError.message}`
          );
        }
      }
    }
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
    // First, confirm the target DID can be dereferenced and extract the DWN service endpoint URLs.
    const dwnEndpointUrls = await getDwnServiceEndpointUrls(request.target, this.agent.did);
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

    // Send the RPC request to the target DID's DWN service endpoint using the Agent's RPC client.
    const reply = await this.sendDwnRpcRequest({
      targetDid: request.target,
      dwnEndpointUrls,
      message,
      data,
      subscriptionHandler
    });

    // Auto-decrypt reply data if encryption is enabled (Component 7)
    await this.maybeDecryptReply(request, reply);

    // If the message CID was not given in the `request`, compute it.
    messageCid ??= await Message.getCid(message);

    // Returns an object containing the reply from processing the message, the original message,
    // and the content identifier (CID) of the message.
    return { reply, message, messageCid };
  }

  private async sendDwnRpcRequest<T extends DwnInterface>({
    targetDid, dwnEndpointUrls, message, data, subscriptionHandler
  }: {
      targetDid: string;
      dwnEndpointUrls: string[];
      message: DwnMessage[T];
      data?: Blob;
      subscriptionHandler?: MessageHandler[T];
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
          subscriptionHandler
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
      const keyDeriver = await this.getEncryptionKeyDeriver(request.author);

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
    // ProtocolContext keyEncryption entry. Non-root records extract the context
    // public key (derivedPublicKey) from existing ProtocolContext-encrypted records
    // in the same context on the target's DWN.














    // Tracks deferred context encryption info for root multi-party records.
    let deferredContextEncryption: {
      dataEncryptionKey: Uint8Array;
      dataEncryptionIV: Uint8Array;
      encryptedBytes: Uint8Array;
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
          : this.isMultiPartyContext(protocolDefinition, rootPathSegment);
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

        // 5. Generate random DEK and IV
        const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
        const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(16));

        // 6. Build EncryptionInput based on the encryption scheme decision
        let encryptionInput: EncryptionInput | undefined;

        const buildProtocolPathInput = (): EncryptionInput => this.buildEncryptionInput(
          dataEncryptionKey, dataEncryptionIV,
          ruleSet.$encryption.rootKeyId, ruleSet.$encryption.publicKeyJwk,
          KeyDerivationScheme.ProtocolPath,
        );

        if (isCrossDwn && isMultiPartyContext && isRootRecord) {
          // --- Cross-DWN root record in multi-party context → Target's ProtocolPath key ---
          // External authors cannot derive the target's context key (HKDF requires
          // the private key). Use the target's ProtocolPath public key from their
          // protocol definition. The target's agent will reactively upgrade the record
          // to include a ProtocolContext keyEncryption entry.
          encryptionInput = buildProtocolPathInput();

        } else if (isCrossDwn && isMultiPartyContext && !isRootRecord) {
          // --- Cross-DWN non-root record in multi-party context → derivedPublicKey ---
          // Read an existing ProtocolContext-encrypted record from the target's DWN
          // and extract the derivedPublicKey (the context public key).
          const rootContextId = messageParams.parentContextId!.split('/')[0]
            || messageParams.parentContextId!;

          const derivedPublicKeyInfo = await this.extractDerivedPublicKey(
            request.target, messageParams.protocol, rootContextId, request.author,
          );

          if (derivedPublicKeyInfo) {
            encryptionInput = this.buildEncryptionInput(
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
          // --- Cross-DWN single-party → Target's ProtocolPath key ---
          encryptionInput = buildProtocolPathInput();

        } else if (isMultiPartyContext && !isRootRecord) {
          // --- Local non-root record in a multi-party context → Context key ---
          const rootContextId = messageParams.parentContextId!.split('/')[0]
            || messageParams.parentContextId!;

          let contextKeyInfo = this._contextKeyCache.get(rootContextId);
          if (!contextKeyInfo) {
            const { keyId, keyUri } = await this.getEncryptionKeyInfo(request.author);
            const contextDerivationPath =
              Records.constructKeyDerivationPathUsingProtocolContextScheme(rootContextId);
            contextKeyInfo = { keyId, keyUri, contextDerivationPath };
            this._contextKeyCache.set(rootContextId, contextKeyInfo);
          }

          const contextPublicKey = await this.agent.keyManager.derivePublicKey({
            keyUri         : contextKeyInfo.keyUri,
            derivationPath : contextKeyInfo.contextDerivationPath,
          });

          encryptionInput = this.buildEncryptionInput(
            dataEncryptionKey, dataEncryptionIV,
            contextKeyInfo.keyId, contextPublicKey,
            KeyDerivationScheme.ProtocolContext,
          );

        } else if (isMultiPartyContext && isRootRecord) {
          // --- Local root record in multi-party context → Deferred context encryption ---
          // contextId = recordId, which is only known after message creation.
          // Skip encryptionInput here; apply it after create() below.
          encryptionInput = undefined;

        } else {
          // --- Local single-party → ProtocolPath key (existing logic) ---
          encryptionInput = buildProtocolPathInput();
        }

        // 7. Encrypt data with AES-256-CTR and compute CID
        const { encryptedBytes, dataCid, dataSize } =
          await this.encryptAndComputeCid(plaintextBytes, dataEncryptionKey, dataEncryptionIV);

        // 8. Replace plaintext with encrypted data
        messageParams.dataCid = dataCid;
        messageParams.dataSize = dataSize;
        delete messageParams.data;
        readableStream = DataStream.fromBytes(encryptedBytes);
        request.dataStream = undefined;

        if (encryptionInput) {
          messageParams.encryptionInput = encryptionInput;
        } else {
          // Deferred — store info for post-creation encryption
          deferredContextEncryption = { dataEncryptionKey, dataEncryptionIV, encryptedBytes };
        }

        // 9. For cross-DWN writes in multi-party contexts, attach the author's
        //    key-delivery ProtocolPath public key so the DWN owner can encrypt
        //    context keys back to the author without querying the author's DWN.
        if (isCrossDwn && isMultiPartyContext) {
          const { keyId: authorKeyId, keyUri: authorKeyUri } =
            await this.getEncryptionKeyInfo(request.author);
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

      // If we need to sign as an author delegate or with permissions we need to get the grantee's signer
      // The messageParams should include either a permissionGrantId, or a delegatedGrant message
      const signer = request.granteeDid ?
        await this.getSigner(request.granteeDid) :
        await this.getSigner(request.author);

      dwnMessage = await dwnMessageConstructor.create({
        // TODO: Implement alternative to type assertion.
        ...request.messageParams!,
        signer
      });

      // Deferred context encryption for root multi-party records (Component 9).
      // Now that the message exists, we know recordId = contextId.
      // Following the SDK two-pass pattern: encryptSymmetricEncryptionKey → sign.
      if (deferredContextEncryption && isDwnRequest(request, DwnInterface.RecordsWrite)) {
        const recordsWriteInstance = dwnMessage as unknown as RecordsWrite;
        const contextId = recordsWriteInstance.message.recordId;

        const { encryptionInput: contextEncryptionInput, keyId, keyUri, contextDerivationPath } =
          await this.deriveContextEncryptionInput(
            request.author, contextId,
            deferredContextEncryption.dataEncryptionKey,
            deferredContextEncryption.dataEncryptionIV,
          );

        await recordsWriteInstance.encryptSymmetricEncryptionKey(contextEncryptionInput);
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
   * Resolves the encryption key info for a given DID.
   * Looks up the keyAgreement verification method in the DID document,
   * then resolves the corresponding KMS key URI.
   *
   * @param didUri - The DID URI to resolve encryption key info for
   * @returns keyId (fully qualified verification method ID), keyUri (KMS reference),
   *          and publicKeyJwk. No private key material is returned.
   * @throws If the DID has no keyAgreement verification method or it's not secp256k1.
   */
  private async getEncryptionKeyInfo(didUri: string): Promise<{
    keyId: string;
    keyUri: KeyIdentifier;
    publicKeyJwk: PublicKeyJwk;
  }> {
    // 1. Resolve the DID document
    const { didDocument, didResolutionMetadata } = await this.agent.did.resolve(didUri);
    if (!didDocument) {
      throw new Error(
        `AgentDwnApi: Failed to resolve DID '${didUri}': ` +
        `${JSON.stringify(didResolutionMetadata)}`
      );
    }

    // 2. Find the keyAgreement verification method
    const keyAgreementRefs = didDocument.keyAgreement;
    if (!keyAgreementRefs || keyAgreementRefs.length === 0) {
      throw new Error(
        `AgentDwnApi: DID '${didUri}' does not have a keyAgreement ` +
        `verification method. Create the identity with a secp256k1 key ` +
        `with keyAgreement purpose to use protocol encryption.`
      );
    }

    // 3. Resolve the verification method (handle both inline and string refs)
    const keyAgreementRef = keyAgreementRefs[0];
    let verificationMethod;
    if (typeof keyAgreementRef === 'string') {
      const fragment = keyAgreementRef.includes('#')
        ? keyAgreementRef.split('#').pop()
        : keyAgreementRef;
      verificationMethod = didDocument.verificationMethod?.find(
        vm => vm.id.endsWith(`#${fragment}`)
      );
    } else {
      verificationMethod = keyAgreementRef;
    }

    if (!verificationMethod?.publicKeyJwk) {
      throw new Error(
        `AgentDwnApi: keyAgreement verification method for '${didUri}' ` +
        `does not contain a public key in JWK format.`
      );
    }

    // 4. Verify it's a secp256k1 key
    const publicKeyJwk = verificationMethod.publicKeyJwk;
    if (publicKeyJwk.crv !== 'secp256k1') {
      throw new Error(
        `AgentDwnApi: keyAgreement key for '${didUri}' uses curve ` +
        `'${publicKeyJwk.crv}', but DWN encryption requires 'secp256k1'.`
      );
    }

    // 5. Compute the KMS key URI (does NOT export the key)
    const keyUri = await this.agent.keyManager.getKeyUri({ key: publicKeyJwk });

    return {
      keyId        : verificationMethod.id,
      keyUri,
      publicKeyJwk : publicKeyJwk as PublicKeyJwk,
    };
  }

  /**
   * Builds an EncryptionInput object for a single key-encryption entry.
   * Consolidates the repeated pattern of assembling DEK, IV, and a single
   * keyEncryptionInputs entry into one place.
   */
  private buildEncryptionInput(
    dek: Uint8Array,
    iv: Uint8Array,
    publicKeyId: string,
    publicKey: PublicKeyJwk,
    derivationScheme: typeof KeyDerivationScheme.ProtocolPath | typeof KeyDerivationScheme.ProtocolContext,
  ): EncryptionInput {
    return {
      initializationVector : iv,
      key                  : dek,
      keyEncryptionInputs  : [{
        publicKeyId,
        publicKey,
        derivationScheme,
      }],
    };
  }

  /**
   * Encrypts plaintext bytes with AES-256-CTR and computes the CID of the
   * resulting ciphertext. Returns everything needed to attach the encrypted
   * data to a DWN message.
   */
  private async encryptAndComputeCid(
    plaintextBytes: Uint8Array,
    dek: Uint8Array,
    iv: Uint8Array,
  ): Promise<{ encryptedBytes: Uint8Array; dataCid: string; dataSize: number }> {
    const plaintextStream = DataStream.fromBytes(plaintextBytes);
    const encryptedStream = await Encryption.aes256CtrEncrypt(dek, iv, plaintextStream);
    const encryptedBytes = await DataStream.toBytes(encryptedStream);
    const cidStream = DataStream.fromBytes(encryptedBytes);
    const dataCid = await Cid.computeDagPbCidFromStream(cidStream);
    return { encryptedBytes, dataCid, dataSize: encryptedBytes.length };
  }

  /**
   * Derives a ProtocolContext public key for a given DID and context ID,
   * then returns a fully-formed EncryptionInput. Consolidates the repeated
   * getEncryptionKeyInfo → constructKeyDerivationPath → derivePublicKey
   * → build EncryptionInput sequence.
   */
  private async deriveContextEncryptionInput(
    didUri: string,
    contextId: string,
    dek: Uint8Array,
    iv: Uint8Array,
  ): Promise<{ encryptionInput: EncryptionInput; keyId: string; keyUri: KeyIdentifier; contextDerivationPath: string[] }> {
    const { keyId, keyUri } = await this.getEncryptionKeyInfo(didUri);
    const contextDerivationPath =
      Records.constructKeyDerivationPathUsingProtocolContextScheme(contextId);
    const contextPublicKey = await this.agent.keyManager.derivePublicKey({
      keyUri,
      derivationPath: contextDerivationPath,
    });

    const encryptionInput = this.buildEncryptionInput(
      dek, iv, keyId, contextPublicKey, KeyDerivationScheme.ProtocolContext,
    );

    return { encryptionInput, keyId, keyUri, contextDerivationPath };
  }

  /**
   * Builds a KMS-backed ECIES decrypt callback. Used for both ProtocolPath
   * and ProtocolContext decryption where the KMS holds the root private key.
   */
  private buildKmsDecryptCallback(
    keyId: string,
    keyUri: KeyIdentifier,
    derivationScheme: typeof KeyDerivationScheme.ProtocolPath | typeof KeyDerivationScheme.ProtocolContext,
  ): KeyDecrypter {
    const keyManager = this.agent.keyManager;
    return {
      rootKeyId : keyId,
      derivationScheme,
      decrypt   : async (fullDerivationPath, eciesPayload): Promise<Uint8Array> => {
        return keyManager.eciesSecp256k1Decrypt({
          keyUri,
          derivationPath            : fullDerivationPath,
          ciphertext                : eciesPayload.ciphertext,
          ephemeralPublicKey        : eciesPayload.ephemeralPublicKey,
          initializationVector      : eciesPayload.initializationVector,
          messageAuthenticationCode : eciesPayload.messageAuthenticationCode,
        });
      },
    };
  }

  /**
   * Constructs an EncryptionKeyDeriver callback for the SDK.
   * The SDK calls derivePublicKey(path), the KMS performs HKDF + public key
   * computation internally. The private key never leaves the KMS.
   *
   * Analogous to getSigner() for signing operations.
   *
   * @param didUri - The DID URI to create the key deriver for
   * @returns An EncryptionKeyDeriver callback object
   */
  public async getEncryptionKeyDeriver(
    didUri: string
  ): Promise<EncryptionKeyDeriver> {
    const { keyId, keyUri } = await this.getEncryptionKeyInfo(didUri);
    const keyManager = this.agent.keyManager;

    return {
      rootKeyId        : keyId,
      derivationScheme : KeyDerivationScheme.ProtocolPath,
      derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
        return keyManager.derivePublicKey({
          keyUri,
          derivationPath: fullDerivationPath,
        });
      },
    };
  }

  /**
   * Constructs a KeyDecrypter callback for the SDK.
   * The SDK calls decrypt(path, eciesParams), the KMS performs HKDF + ECIES
   * decryption internally. The private key never leaves the KMS.
   *
   * Analogous to getSigner() for signing operations.
   *
   * @param didUri - The DID URI to create the key decrypter for
   * @returns A KeyDecrypter callback object
   */
  private async getKeyDecrypter(
    didUri: string
  ): Promise<KeyDecrypter> {
    const { keyId, keyUri } = await this.getEncryptionKeyInfo(didUri);
    return this.buildKmsDecryptCallback(keyId, keyUri, KeyDerivationScheme.ProtocolPath);
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
    protocolUri: string
  ): Promise<ProtocolDefinition | undefined> {
    const cacheKey = `${tenantDid}~${protocolUri}`;

    const cached = this._protocolDefinitionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const signer = await this.getSigner(tenantDid);
    const protocolsQuery = await dwnMessageConstructors[
      DwnInterface.ProtocolsQuery
    ].create({
      filter: { protocol: protocolUri },
      signer,
    });

    const reply = await this._dwn.processMessage(
      tenantDid, protocolsQuery.message,
    );
    if (reply.status.code !== 200 || !reply.entries?.length) {
      return undefined;
    }

    const definition = reply.entries[0].descriptor.definition;
    this._protocolDefinitionCache.set(cacheKey, definition);
    return definition;
  }

  /**
   * Checks if a protocol path represents a multi-party context. Returns true
   * if the root path's subtree contains:
   *   (a) any `$role: true` descendants, OR
   *   (b) any relational `who`/`of` `$actions` rules that grant `read` access
   *       (indicating external authors or recipients need context keys).
   *
   * This generalises the earlier `protocolPathHasRoles()` to cover protocols
   * that use relational access without explicit role definitions.
   */
  private isMultiPartyContext(
    protocolDefinition: ProtocolDefinition,
    rootProtocolPath: string,
  ): boolean {
    const segments = rootProtocolPath.split('/');
    let ruleSet: ProtocolRuleSet | undefined =
      protocolDefinition.structure as unknown as ProtocolRuleSet;
    for (const segment of segments) {
      ruleSet = ruleSet[segment] as ProtocolRuleSet | undefined;
      if (!ruleSet) { return false; }
    }

    // (a) Check for $role descendants in the subtree
    function hasRoleRecursive(rs: ProtocolRuleSet): boolean {
      for (const key in rs) {
        if (!key.startsWith('$')) {
          const child = rs[key] as ProtocolRuleSet;
          if (child.$role === true) { return true; }
          if (hasRoleRecursive(child)) { return true; }
        }
      }
      return false;
    }

    if (hasRoleRecursive(ruleSet)) {
      return true;
    }

    // (b) Check for relational who/of read rules anywhere in the protocol
    //     that reference a path within this subtree. A rule like
    //     { who: 'recipient', of: 'email', can: ['read'] } on any record
    //     type means the email recipient needs a context key.
    return this.hasRelationalReadAccess(
      undefined, rootProtocolPath, protocolDefinition,
    );
  }

  /**
   * Checks whether any relational `who`/`of` rule in the protocol grants
   * `read` access for a given actor type and ancestor path.
   *
   * Walks the *entire* protocol structure looking for any `$actions` rule that:
   *   - Has `who` equal to `actorType` ('recipient' or 'author'), or any actor
   *     type if `actorType` is `undefined`
   *   - Has `of` equal to `ofPath`
   *   - Has `can` including 'read'
   *
   * The search covers all record types in the protocol, since a relational
   * rule can appear at any level (e.g. `{ who: 'recipient', of: 'thread',
   * can: ['read'] }` might be defined on `thread/message`).
   *
   * @param actorType  - 'author' | 'recipient', or undefined for any
   * @param ofPath     - The protocol path to check (e.g. 'thread', 'email')
   * @param protocolDefinition - The full protocol definition
   * @returns true if a matching relational read rule exists
   */
  private hasRelationalReadAccess(
    actorType: 'author' | 'recipient' | undefined,
    ofPath: string,
    protocolDefinition: ProtocolDefinition,
  ): boolean {
    const structure = protocolDefinition.structure as unknown as ProtocolRuleSet;

    function walkRuleSet(rs: ProtocolRuleSet): boolean {
      // Check $actions on this node
      if (rs.$actions) {
        for (const rule of rs.$actions) {
          if (
            rule.who &&
            rule.who !== 'anyone' &&
            (actorType === undefined || rule.who === actorType) &&
            rule.of === ofPath &&
            rule.can?.includes('read')
          ) {
            return true;
          }
        }
      }

      // Recurse into child record types
      for (const key in rs) {
        if (!key.startsWith('$')) {
          if (walkRuleSet(rs[key] as ProtocolRuleSet)) {
            return true;
          }
        }
      }
      return false;
    }

    return walkRuleSet(structure);
  }

  /**
   * Analyses a record write to determine which DIDs need context key delivery.
   *
   * Returns a set of participant DIDs that should receive `contextKey` records.
   * The DWN owner (tenantDid) is always excluded — they have ProtocolPath access.
   *
   * Cases handled:
   *   1. `$role` record with a recipient → recipient is a participant
   *   2. Record has a recipient and a relational read rule grants access
   *      via `{ who: 'recipient', of: '<path>', can: ['read'] }`
   *   3. Record is authored by an external party → if `{ who: 'author', of:
   *      '<path>', can: ['read'] }` rules grant read access, the author needs
   *      a context key.
   *
   * @param params.protocolDefinition - The installed protocol definition
   * @param params.protocolPath       - The written record's protocol path
   * @param params.recipient          - Recipient DID from the record, if any
   * @param params.tenantDid          - The DWN owner's DID (excluded from results)
   * @param params.authorDid          - Author DID if externally authored, undefined otherwise
   * @returns Set of DIDs that need context key delivery
   */
  detectNewParticipants({ protocolDefinition, protocolPath, recipient, tenantDid, authorDid }: {
    protocolDefinition: ProtocolDefinition;
    protocolPath: string;
    recipient?: string;
    tenantDid: string;
    authorDid?: string;
  }): Set<string> {
    const participants = new Set<string>();

    // Navigate to the rule set at the given protocol path
    const pathSegments = protocolPath.split('/');
    let ruleSet: ProtocolRuleSet | undefined =
      protocolDefinition.structure as unknown as ProtocolRuleSet;
    for (const segment of pathSegments) {
      ruleSet = ruleSet[segment] as ProtocolRuleSet | undefined;
      if (!ruleSet) { return participants; }
    }

    // Case 1: $role record → recipient is a participant
    if (ruleSet.$role === true && recipient) {
      participants.add(recipient);
    }

    // Case 2: Record has a recipient → check if relational read rules exist
    if (recipient && recipient !== tenantDid) {
      if (this.hasRelationalReadAccess('recipient', protocolPath, protocolDefinition)) {
        participants.add(recipient);
      }
    }

    // Case 3: External author → check if author-based relational read rules exist.
    // If `{ who: 'author', of: '<path>', can: ['read'] }` is defined anywhere
    // in the protocol, the external author needs a context key to decrypt.
    if (authorDid && authorDid !== tenantDid) {
      if (this.hasRelationalReadAccess('author', protocolPath, protocolDefinition)) {
        participants.add(authorDid);
      }
    }

    // Remove the DWN owner — they always have ProtocolPath access
    participants.delete(tenantDid);

    return participants;
  }

  /**
   * Fetches a protocol definition from a remote DWN.
   * Uses an unsigned ProtocolsQuery (public protocols can be queried anonymously).
   */
  private async fetchRemoteProtocolDefinition(
    targetDid: string,
    protocolUri: string,
  ): Promise<ProtocolDefinition> {
    const cacheKey = `remote~${targetDid}~${protocolUri}`;
    const cached = this._protocolDefinitionCache.get(cacheKey);
    if (cached) { return cached; }

    const protocolsQuery = await dwnMessageConstructors[
      DwnInterface.ProtocolsQuery
    ].create({
      filter: { protocol: protocolUri },
    });

    const reply = await this.sendDwnRpcRequest({
      targetDid,
      dwnEndpointUrls: await getDwnServiceEndpointUrls(
        targetDid, this.agent.did,
      ),
      message: protocolsQuery.message,
    }) as ProtocolsQueryReply;

    if (reply.status.code !== 200 || !reply.entries?.length) {
      throw new Error(
        `AgentDwnApi: Failed to fetch protocol '${protocolUri}' from ` +
        `'${targetDid}'. The recipient may not have the protocol installed.`
      );
    }

    const definition = reply.entries[0].descriptor.definition;
    this._protocolDefinitionCache.set(cacheKey, definition);
    return definition;
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
    const signer = await this.getSigner(requesterDid);

    // Query the target's DWN for any record in this context
    const recordsQuery = await dwnMessageConstructors[DwnInterface.RecordsQuery].create({
      signer,
      filter: {
        protocol  : protocolUri,
        contextId : rootContextId,
      },
    });

    const dwnEndpointUrls = await getDwnServiceEndpointUrls(targetDid, this.agent.did);
    const queryReply = await this.sendDwnRpcRequest<DwnInterface.RecordsQuery>({
      targetDid,
      dwnEndpointUrls,
      message: recordsQuery.message,
    }) as RecordsQueryReply;

    if (queryReply.status.code !== 200 || !queryReply.entries?.length) {
      return undefined;
    }

    // Search entries for one with a ProtocolContext keyEncryption entry
    // that includes derivedPublicKey
    for (const entry of queryReply.entries) {
      if (entry.encryption?.keyEncryption) {
        const contextEntry = entry.encryption.keyEncryption.find(
          (k: { derivationScheme: string; derivedPublicKey?: PublicKeyJwk }) =>
            k.derivationScheme === KeyDerivationScheme.ProtocolContext && k.derivedPublicKey
        );
        if (contextEntry?.derivedPublicKey) {
          return {
            rootKeyId        : contextEntry.rootKeyId,
            derivedPublicKey : contextEntry.derivedPublicKey,
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Reactively upgrades an externally-authored root record that has only
   * ProtocolPath encryption by appending a ProtocolContext keyEncryption entry.
   *
   * After the upgrade, both the owner (ProtocolPath) and context key holders —
   * including the external author (ProtocolContext) — can decrypt the record.
   *
   * Steps:
   *   1. Decrypt the DEK using the owner's ProtocolPath-derived private key
   *   2. Derive the context public key from the owner's #enc key
   *   3. ECIES-encrypt the same DEK to the context public key
   *   4. Append the ProtocolContext keyEncryption entry (using PR 0b append mode)
   *   5. Re-sign the record as owner
   *
   * The author's signature payload includes an `encryptionCid` that becomes
   * stale after step 4. The SDK's `validateIntegrity()` skips the encryptionCid
   * check on the author's signature when an ownerSignature is present (step 5),
   * since the owner vouches for the updated encryption property.
   *
   * NOTE: An alternative design would deliver the DEK out-of-band via the
   * key-delivery protocol (as a field on the contextKey record) instead of
   * mutating the record's encryption property. That avoids the stale
   * encryptionCid concern entirely but adds complexity to the read path and
   * the contextKey schema. We chose the in-record approach because it keeps
   * records self-contained and the read/decrypt path unchanged.
   *
   * @param tenantDid     - The DWN owner's DID
   * @param recordsWrite  - The RecordsWrite message to upgrade
   */
  private async upgradeExternalRootRecord(
    tenantDid: string,
    recordsWrite: RecordsWriteMessage,
  ): Promise<void> {
    const { encryption } = recordsWrite;
    if (!encryption) { return; }

    // Verify: has ProtocolPath but NOT ProtocolContext
    const hasProtocolPath = encryption.keyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === KeyDerivationScheme.ProtocolPath
    );
    const hasProtocolContext = encryption.keyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === KeyDerivationScheme.ProtocolContext
    );
    if (!hasProtocolPath || hasProtocolContext) { return; }

    // 1. Decrypt the DEK using the owner's ProtocolPath key
    const keyDecrypter = await this.getKeyDecrypter(tenantDid);

    // Find the ProtocolPath keyEncryption entry
    const pathEntry = encryption.keyEncryption.find(
      (k: { derivationScheme: string }) => k.derivationScheme === KeyDerivationScheme.ProtocolPath
    )!;

    const fullDerivationPath = Records.constructKeyDerivationPathUsingProtocolPathScheme(
      recordsWrite.descriptor,
    );

    const dataEncryptionKey = await keyDecrypter.decrypt(
      fullDerivationPath,
      {
        ciphertext                : Encoder.base64UrlToBytes(pathEntry.encryptedKey),
        ephemeralPublicKey        : Secp256k1.publicJwkToBytes(pathEntry.ephemeralPublicKey),
        initializationVector      : Encoder.base64UrlToBytes(pathEntry.initializationVector),
        messageAuthenticationCode : Encoder.base64UrlToBytes(pathEntry.messageAuthenticationCode),
      },
    );

    // 2. Derive the context public key — contextId = recordId for root records
    const contextId = recordsWrite.recordId;
    const encryptionIV = Encoder.base64UrlToBytes(encryption.initializationVector);

    // 3 & 4. Append the ProtocolContext keyEncryption entry using append mode.
    // Append mode preserves the author's identity and authorization so that
    // signAsOwner() can be called in step 5.
    const { encryptionInput: contextEncryptionInput, keyId, keyUri, contextDerivationPath } =
      await this.deriveContextEncryptionInput(tenantDid, contextId, dataEncryptionKey, encryptionIV);

    // Parse the message to get a RecordsWrite instance we can mutate
    const recordsWriteInstance = await dwnMessageConstructors[DwnInterface.RecordsWrite].parse(
      recordsWrite,
    ) as unknown as RecordsWrite;

    await recordsWriteInstance.encryptSymmetricEncryptionKey(
      contextEncryptionInput,
      { append: true },
    );

    // 5. Re-sign as owner — the author's signature is preserved but its
    // encryptionCid is now stale; the owner's signature vouches for the
    // updated encryption property.
    const signer = await this.getSigner(tenantDid);
    await recordsWriteInstance.signAsOwner(signer);

    // Store the upgraded message directly via the message store, bypassing
    // the handler's conflict resolution which doesn't support same-timestamp
    // owner-augmented replacements. The data is unchanged — only the encryption
    // metadata and authorization are updated.
    //
    // We must also update the state index and event stream to keep sync and
    // real-time subscribers consistent — without this, the upgraded record
    // would never propagate to remote DWNs or notify subscribers.
    const { messageStore, stateIndex, eventStream } = this._dwn.storage;

    // Validate the upgrade only changed encryption and authorization fields.
    // The descriptor, recordId, contextId, and data must remain identical.
    // Note: parse() may produce a new descriptor object, so we compare by value.
    const upgradedMessage = recordsWriteInstance.message as RecordsQueryReplyEntry;
    if (JSON.stringify(upgradedMessage.descriptor) !== JSON.stringify(recordsWrite.descriptor)) {
      throw new Error('AgentDwnApi: upgradeExternalRootRecord() must not modify the descriptor.');
    }
    if (upgradedMessage.recordId !== recordsWrite.recordId) {
      throw new Error('AgentDwnApi: upgradeExternalRootRecord() must not modify the recordId.');
    }

    // Fetch the stored original (which carries encodedData for small payloads)
    const originalCid = await Message.getCid(recordsWrite);
    const storedOriginal = await messageStore.get(tenantDid, originalCid) as RecordsQueryReplyEntry | undefined;

    // Build indexes for the upgraded message (mark as latest base state)
    const isLatestBaseState = true;
    const upgradedIndexes = await recordsWriteInstance.constructIndexes(isLatestBaseState);

    // Carry over the encoded data from the stored original (the handler
    // base64url-encodes small payloads into encodedData during processMessage)
    if (storedOriginal?.encodedData) {
      upgradedMessage.encodedData = storedOriginal.encodedData;
    }

    // Use put-before-delete ordering: if a crash occurs after the put but
    // before the delete, we end up with a duplicate (recoverable via the
    // isLatestBaseState index) rather than data loss (unrecoverable).
    const upgradedCid = await Message.getCid(upgradedMessage);
    await messageStore.put(tenantDid, upgradedMessage, upgradedIndexes);
    await stateIndex.insert(tenantDid, upgradedCid, upgradedIndexes);

    // Now remove the original message and its state index entry.
    await messageStore.delete(tenantDid, originalCid);
    await stateIndex.delete(tenantDid, [originalCid]);

    // Notify real-time subscribers (mirrors handler behavior)
    if (eventStream !== undefined) {
      eventStream.emit(tenantDid, { message: upgradedMessage }, upgradedIndexes);
    }

    // Cache context key info for subsequent writes in this context
    this._contextKeyCache.set(contextId, { keyId, keyUri, contextDerivationPath });
  }

  /**
   * Resolves the appropriate KeyDecrypter for a record's encryption scheme.
   * Handles both single-party (ProtocolPath) and multi-party (ProtocolContext).
   *
   * For ProtocolContext records:
   *   - Context creator: derives key directly from KMS
   *   - Participant: fetches contextKey via key-delivery protocol, caches it
   */
  private async resolveKeyDecrypter(
    authorDid: string,
    recordsWrite: RecordsWriteMessage,
    targetDid?: string,
  ): Promise<KeyDecrypter> {
    const { encryption } = recordsWrite;

    // Check if the record uses context-derived encryption
    const hasContextKey = encryption?.keyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === KeyDerivationScheme.ProtocolContext
    );

    if (!hasContextKey || !recordsWrite.contextId) {
      // Single-party protocol-path encryption
      return this.getKeyDecrypter(authorDid);
    }

    // --- Multi-party context encryption ---
    const contextKeyEntry = encryption!.keyEncryption.find(
      (k: { derivationScheme: string }) => k.derivationScheme === KeyDerivationScheme.ProtocolContext
    )!;

    const rootContextId = recordsWrite.contextId.split('/')[0];

    // Case 1: I am the context creator — rootKeyId matches my encryption key
    const { keyId, keyUri } = await this.getEncryptionKeyInfo(authorDid);
    if (contextKeyEntry.rootKeyId === keyId) {
      return this.buildKmsDecryptCallback(keyId, keyUri, KeyDerivationScheme.ProtocolContext);
    }

    // Case 2: I am a participant — fetch my context key from the key-delivery protocol
    const cacheKey = `ctx~${authorDid}~${rootContextId}`;
    const cached = this._contextDerivedKeyCache.get(cacheKey);
    if (cached) {
      return this.buildContextKeyDecrypter(cached);
    }

    // Fetch context key via the key-delivery protocol — local first, then remote
    const protocol = recordsWrite.descriptor.protocol!;

    // Try local: I may be the DWN owner with a contextKey addressed to myself
    let contextDerivedPrivateKey = await this.fetchContextKeyRecord({
      ownerDid        : authorDid,
      requesterDid    : authorDid,
      sourceProtocol  : protocol,
      sourceContextId : rootContextId,
    });

    // Try remote: query the DWN owner's DWN for my contextKey record.
    // For cross-DWN records, targetDid is the DWN owner (e.g., Alice) where the
    // contextKey was written. For same-DWN records, fall back to the record's
    // authorization signer.
    if (!contextDerivedPrivateKey) {
      const contextOwnerDid = targetDid ?? Jws.getSignerDid(
        recordsWrite.authorization.signature.signatures[0]
      );
      contextDerivedPrivateKey = await this.fetchContextKeyRecord({
        ownerDid        : contextOwnerDid,
        requesterDid    : authorDid,
        sourceProtocol  : protocol,
        sourceContextId : rootContextId,
      });
    }

    if (!contextDerivedPrivateKey) {
      throw new Error(
        `AgentDwnApi: Failed to decrypt record '${recordsWrite.recordId}'. ` +
        `Record uses context-derived encryption but no contextKey record ` +
        `could be found via the key-delivery protocol.`
      );
    }

    this._contextDerivedKeyCache.set(cacheKey, contextDerivedPrivateKey);
    return this.buildContextKeyDecrypter(contextDerivedPrivateKey);
  }


  /**
   * Builds a KeyDecrypter from a context-derived private key.
   * Uses the raw key directly (since it was shared with us via the key-delivery protocol).
   */
  private buildContextKeyDecrypter(
    contextKey: DerivedPrivateJwk,
  ): KeyDecrypter {
    return {
      rootKeyId        : contextKey.rootKeyId,
      derivationScheme : contextKey.derivationScheme,
      decrypt          : async (fullDerivationPath, eciesPayload): Promise<Uint8Array> => {
        const leafPrivateKey = await Records.derivePrivateKey(
          contextKey, fullDerivationPath,
        );
        return Encryption.eciesSecp256k1Decrypt({
          privateKey                : leafPrivateKey,
          ciphertext                : eciesPayload.ciphertext,
          ephemeralPublicKey        : eciesPayload.ephemeralPublicKey,
          initializationVector      : eciesPayload.initializationVector,
          messageAuthenticationCode : eciesPayload.messageAuthenticationCode,
        });
      },
    };
  }

  /**
   * Post-processes a DWN reply, auto-decrypting data if encryption is enabled.
   * Delegates to the SDK's Records.decrypt() with the appropriate KeyDecrypter —
   * resolveKeyDecrypter() selects between ProtocolPath and ProtocolContext schemes.
   */
  private async maybeDecryptReply<T extends DwnInterface>(
    request: ProcessDwnRequest<T> | SendDwnRequest<T>,
    reply: DwnMessageReply[T],
  ): Promise<void> {
    if (!('encryption' in request) || !request.encryption) {
      return;
    }

    // Auto-decrypt RecordsRead replies
    if (isDwnRequest(request as ProcessDwnRequest<DwnInterface>, DwnInterface.RecordsRead)) {
      const readReply = reply as RecordsReadReply;
      if (readReply.status.code === 200
          && readReply.entry?.recordsWrite?.encryption
          && readReply.entry?.data) {
        const keyDecrypter = await this.resolveKeyDecrypter(
          request.author, readReply.entry.recordsWrite, request.target,
        );

        try {
          readReply.entry.data = await Records.decrypt(
            readReply.entry.recordsWrite,
            keyDecrypter,
            readReply.entry.data,
          );
        } catch (error: any) {
          throw new Error(
            `AgentDwnApi: Failed to decrypt record ` +
            `'${readReply.entry.recordsWrite.recordId}'. ` +
            `Original error: ${error.message}`
          );
        }
      }
    }

    // Auto-decrypt RecordsQuery replies (small records inline as encodedData)
    if (isDwnRequest(request as ProcessDwnRequest<DwnInterface>, DwnInterface.RecordsQuery)) {
      const queryReply = reply as RecordsQueryReply;
      if (queryReply.status.code === 200 && queryReply.entries) {
        for (const entry of queryReply.entries) {
          if (entry.encryption && entry.encodedData) {
            const keyDecrypter = await this.resolveKeyDecrypter(
              request.author, entry as RecordsWriteMessage, request.target,
            );

            try {
              const cipherBytes = Encoder.base64UrlToBytes(entry.encodedData);
              const cipherStream = DataStream.fromBytes(cipherBytes);
              const plainStream = await Records.decrypt(
                entry as RecordsWriteMessage, keyDecrypter, cipherStream,
              );
              const plainBytes = await DataStream.toBytes(plainStream);
              entry.encodedData = Encoder.bytesToBase64Url(plainBytes);
            } catch (error: any) {
              throw new Error(
                `AgentDwnApi: Failed to decrypt record ` +
                `'${entry.recordId}'. Original error: ${error.message}`
              );
            }
          }
        }
      }
    }
  }

  /**
   * FURTHER REFACTORING NEEDED BELOW THIS LINE
   */

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
   * with `$encryption` keys injected. Uses the same lazy initialization pattern
   * as `DwnDataStore.initialize()`.
   *
   * @param tenantDid - The DID of the DWN owner
   */
  async ensureKeyDeliveryProtocol(tenantDid: string): Promise<void> {
    if (this._keyDeliveryProtocolInstalledCache.get(tenantDid)) {
      return;
    }

    const protocolUri = KeyDeliveryProtocolDefinition.protocol;
    const existing = await this.getProtocolDefinition(tenantDid, protocolUri);

    if (!existing) {
      // Derive and inject $encryption keys for each type path
      const keyDeriver = await this.getEncryptionKeyDeriver(tenantDid);
      const definitionWithKeys = await Protocols.deriveAndInjectPublicEncryptionKeys(
        KeyDeliveryProtocolDefinition,
        keyDeriver,
      );

      const { reply: { status } } = await this.processRequest({
        author        : tenantDid,
        target        : tenantDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: definitionWithKeys },
      });

      if (status.code !== 202) {
        throw new Error(`AgentDwnApi: Failed to install key delivery protocol: ${status.code} - ${status.detail}`);
      }

      // Invalidate protocol definition cache so subsequent reads pick up the new definition
      this._protocolDefinitionCache.delete(`${tenantDid}~${protocolUri}`);
    }

    this._keyDeliveryProtocolInstalledCache.set(tenantDid, true);
  }

  /**
   * Writes a `contextKey` record to the owner's DWN, delivering an encrypted
   * context key to a participant.
   *
   * The payload is encrypted to the **recipient's** ProtocolPath-derived public
   * key on the key-delivery protocol, so only the recipient can decrypt it.
   * The recipient's key is supplied via `recipientKeyDeliveryPublicKey` (which
   * the external author attached as `authorKeyDeliveryPublicKey` on the
   * original cross-DWN record).
   *
   * When `recipientKeyDeliveryPublicKey` is not provided (e.g. the owner is
   * writing a contextKey for themselves), the record is encrypted to the
   * owner's own ProtocolPath key using the generic `processRequest` path.
   *
   * @param params.tenantDid      - The DWN owner's DID (who is delivering the key)
   * @param params.recipientDid   - The participant's DID (who will receive the key)
   * @param params.contextKeyData - The `DerivedPrivateJwk` to deliver
   * @param params.sourceProtocol - The URI of the source protocol (tag)
   * @param params.sourceContextId - The root context ID (tag)
   * @param params.recipientKeyDeliveryPublicKey - The recipient's ProtocolPath-
   *        derived public key for `key-delivery/contextKey`. When provided,
   *        the contextKey record is encrypted directly to this key.
   * @returns The recordId of the written contextKey record
   */
  async writeContextKeyRecord({ tenantDid, recipientDid, contextKeyData, sourceProtocol, sourceContextId, recipientKeyDeliveryPublicKey }: {
    tenantDid: string;
    recipientDid: string;
    contextKeyData: DerivedPrivateJwk;
    sourceProtocol: string;
    sourceContextId: string;
    recipientKeyDeliveryPublicKey?: { rootKeyId: string; publicKeyJwk: PublicKeyJwk };
  }): Promise<string> {
    // Ensure the key delivery protocol is installed on the owner's DWN
    await this.ensureKeyDeliveryProtocol(tenantDid);

    const protocolUri = KeyDeliveryProtocolDefinition.protocol;

    // Serialize the payload to JSON bytes
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(contextKeyData));

    // Common contextKey record parameters
    const contextKeyParams = {
      protocol     : protocolUri,
      protocolPath : 'contextKey',
      dataFormat   : 'application/json',
      recipient    : recipientDid,
      tags         : { protocol: sourceProtocol, contextId: sourceContextId },
    };

    let message: any;
    let status: { code: number; detail: string };

    if (recipientKeyDeliveryPublicKey) {
      // --- Encrypt to the recipient's ProtocolPath key (cross-DWN delivery) ---
      // Manually build encryption input targeting the recipient's key so the
      // record is decryptable only by the recipient.
      const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
      const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(16));

      const { encryptedBytes, dataCid, dataSize } =
        await this.encryptAndComputeCid(plaintextBytes, dataEncryptionKey, dataEncryptionIV);

      const encryptionInput = this.buildEncryptionInput(
        dataEncryptionKey, dataEncryptionIV,
        recipientKeyDeliveryPublicKey.rootKeyId,
        recipientKeyDeliveryPublicKey.publicKeyJwk,
        KeyDerivationScheme.ProtocolPath,
      );

      ({ message, reply: { status } } = await this.processRequest({
        author        : tenantDid,
        target        : tenantDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : { ...contextKeyParams, dataCid, dataSize, encryptionInput },
        dataStream    : new Blob([encryptedBytes]),
      }));
    } else {
      // --- Fallback: encrypt to the owner's key (local self-delivery) ---
      // When no recipient key is provided, use the generic processRequest
      // encryption path which encrypts to the DWN owner's ProtocolPath key.
      ({ message, reply: { status } } = await this.processRequest({
        author        : tenantDid,
        target        : tenantDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : contextKeyParams,
        dataStream    : new Blob([plaintextBytes], { type: 'application/json' }),
        encryption    : true,
      }));
    }

    if (!(message && status.code === 202)) {
      throw new Error(
        `AgentDwnApi: Failed to write contextKey record for ${recipientDid}: ${status.code} - ${status.detail}`,
      );
    }

    // Eagerly send the contextKey record to the tenant's remote DWN so that
    // participants can fetch it immediately without waiting for sync.
    // This is fire-and-forget — sync will guarantee eventual consistency.
    this.eagerSendContextKeyRecord(tenantDid, message).catch((err: Error) => {
      console.warn(
        `AgentDwnApi: Eager send of contextKey record '${message.recordId}' ` +
        `to remote DWN failed: ${err.message}. Sync will deliver it later.`
      );
    });

    return message.recordId;
  }

  /**
   * Eagerly sends a contextKey record to the tenant's remote DWN.
   * This is best-effort — sync guarantees eventual consistency regardless.
   */
  private async eagerSendContextKeyRecord(
    tenantDid: string,
    contextKeyMessage: DwnMessage[DwnInterface.RecordsWrite],
  ): Promise<void> {
    let dwnEndpointUrls: string[];
    try {
      dwnEndpointUrls = await getDwnServiceEndpointUrls(tenantDid, this.agent.did);
    } catch {
      // DID resolution or endpoint lookup failed — not fatal, sync will handle it.
      return;
    }

    if (dwnEndpointUrls.length === 0) {
      return;
    }

    // Read the full message (including data blob) from the local DWN
    const { data } = await this.getDwnMessage({
      author      : tenantDid,
      messageType : DwnInterface.RecordsWrite,
      messageCid  : await Message.getCid(contextKeyMessage),
    });

    await this.sendDwnRpcRequest({
      targetDid : tenantDid,
      dwnEndpointUrls,
      message   : contextKeyMessage,
      data,
    });
  }

  /**
   * Fetches and decrypts a `contextKey` record from a DWN, returning the
   * `DerivedPrivateJwk` payload.
   *
   * Supports both local reads (tenant queries own DWN) and remote reads
   * (participant queries the context owner's DWN).
   *
   * @param params.ownerDid       - The DWN owner's DID (where contextKey records live)
   * @param params.requesterDid   - The DID of the requester (used for signing and decryption)
   * @param params.sourceProtocol - The URI of the source protocol (tag filter)
   * @param params.sourceContextId - The root context ID (tag filter)
   * @returns The decrypted `DerivedPrivateJwk`, or `undefined` if no matching record found
   */
  async fetchContextKeyRecord({ ownerDid, requesterDid, sourceProtocol, sourceContextId }: {
    ownerDid: string;
    requesterDid: string;
    sourceProtocol: string;
    sourceContextId: string;
  }): Promise<DerivedPrivateJwk | undefined> {
    const protocolUri = KeyDeliveryProtocolDefinition.protocol;
    const isLocal = ownerDid === requesterDid;

    // Shared query filter for both local and remote paths
    const contextKeyFilter = {
      protocol     : protocolUri,
      protocolPath : 'contextKey',
      recipient    : requesterDid,
      tags         : { protocol: sourceProtocol, contextId: sourceContextId },
    };

    /** Parse decrypted bytes into a DerivedPrivateJwk. */
    const parsePayload = (bytes: Uint8Array): DerivedPrivateJwk =>
      JSON.parse(new TextDecoder().decode(bytes)) as DerivedPrivateJwk;

    if (isLocal) {
      // Local query: owner queries their own DWN
      const { reply } = await this.processRequest({
        author        : requesterDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: contextKeyFilter },
      });

      if (reply.status.code !== 200 || !reply.entries?.length) {
        return undefined;
      }

      // Read the full record to get the data (auto-decrypted by processRequest)
      const recordId = reply.entries[0].recordId;
      const { reply: readReply } = await this.processRequest({
        author        : requesterDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId } },
        encryption    : true,
      });

      const readResult = readReply as RecordsReadReply;
      if (!readResult.entry?.data) {
        return undefined;
      }

      return parsePayload(await DataStream.toBytes(readResult.entry.data));
    } else {
      // Remote query: participant queries the context owner's DWN
      const signer = await this.getSigner(requesterDid);
      const dwnEndpointUrls = await getDwnServiceEndpointUrls(ownerDid, this.agent.did);

      const recordsQuery = await dwnMessageConstructors[DwnInterface.RecordsQuery].create({
        signer,
        filter: contextKeyFilter,
      });

      const queryReply = await this.sendDwnRpcRequest<DwnInterface.RecordsQuery>({
        targetDid : ownerDid,
        dwnEndpointUrls,
        message   : recordsQuery.message,
      }) as RecordsQueryReply;

      if (queryReply.status.code !== 200 || !queryReply.entries?.length) {
        return undefined;
      }

      // Read the full record remotely
      const recordId = queryReply.entries[0].recordId;
      const recordsRead = await dwnMessageConstructors[DwnInterface.RecordsRead].create({
        signer,
        filter: { recordId },
      });

      const readReply = await this.sendDwnRpcRequest<DwnInterface.RecordsRead>({
        targetDid : ownerDid,
        dwnEndpointUrls,
        message   : recordsRead.message,
      }) as RecordsReadReply;

      if (!readReply.entry?.data || !readReply.entry?.recordsWrite) {
        return undefined;
      }

      // Decrypt the contextKey payload using the requester's key-delivery protocol path key
      const keyDecrypter = await this.getKeyDecrypter(requesterDid);
      const decryptedStream = await Records.decrypt(
        readReply.entry.recordsWrite,
        keyDecrypter,
        readReply.entry.data as ReadableStream<Uint8Array>,
      );

      return parsePayload(await DataStream.toBytes(decryptedStream));
    }
  }
}