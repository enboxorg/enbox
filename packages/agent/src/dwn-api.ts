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
  RecordsReadReply ,
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
  EventLogLevel,
  Jws,
  KeyDerivationScheme,
  Message,
  MessageStoreLevel,
  Protocols,
  Records,
  ResumableTaskStoreLevel,
  Secp256k1
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

import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';
import { getDwnServiceEndpointUrls, isRecordsWrite } from './utils.js';

export type DwnMessageWithBlob<T extends DwnInterface> = {
  message: DwnMessage[T];
  data?: Blob;
};

export type DwnApiParams = {
  agent?: Web5PlatformAgent;
  dwn: Dwn;
};

export interface DwnApiCreateDwnParams extends Partial<DwnConfig> {
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
    dataPath, dataStore, didResolver, eventLog, eventStream, messageStore, tenantGate, resumableTaskStore
  }: DwnApiCreateDwnParams): Promise<Dwn> {
    dataStore ??= new DataStoreLevel({ blockstoreLocation: `${dataPath}/DWN_DATASTORE` });

    didResolver ??= new UniversalResolver({
      didResolvers : [DidDht, DidJwk],
      cache        : new DidResolverCacheLevel({ location: `${dataPath}/DID_RESOLVERCACHE` }),
    });

    eventLog ??= new EventLogLevel({ location: `${dataPath}/DWN_EVENTLOG` });

    messageStore ??= new MessageStoreLevel(({
      blockstoreLocation : `${dataPath}/DWN_MESSAGESTORE`,
      indexLocation      : `${dataPath}/DWN_MESSAGEINDEX`
    }));

    resumableTaskStore ??= new ResumableTaskStoreLevel({ location: `${dataPath}/DWN_RESUMABLETASKSTORE` });

    eventStream ??= new EventEmitterStream();

    return await Dwn.create({ dataStore, didResolver, eventLog, eventStream, messageStore, tenantGate, resumableTaskStore });
  }

  public async processRequest<T extends DwnInterface>(
    request: ProcessDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    // Constructs a DWN message. and if there is a data payload, prepares the data as a
    // Web ReadableStream.
    const { message, dataStream, roleRecordAutoPush } =
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

    // Auto-push role record to recipient's DWN (Component 11).
    // The dataStream was consumed by processMessage(), so we use the saved encryptedBytes.
    if (roleRecordAutoPush) {
      try {
        const recipientDwnUrls = await getDwnServiceEndpointUrls(
          roleRecordAutoPush.recipient, this.agent.did,
        );
        await this.sendDwnRpcRequest({
          targetDid       : roleRecordAutoPush.recipient,
          dwnEndpointUrls : recipientDwnUrls,
          message,
          data            : new Blob([roleRecordAutoPush.encryptedBytes]),
        });
      } catch (error: any) {
        // Auto-push failure is non-fatal — the record is stored locally.
        // The recipient can fetch it later via remote fallback (Component 12).
        console.warn(
          `AgentDwnApi: Auto-push of role record to ` +
          `'${roleRecordAutoPush.recipient}' failed: ${error.message}. ` +
          `The recipient will need to fetch the record remotely.`
        );
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
          // @ts-ignore — dataCid is set dynamically
          messageParams.dataCid = await Cid.computeDagPbCidFromStream(forCid!);
          // Compute data size by consuming forCid (already consumed by computeDagPbCidFromStream)
          // and using the Blob/stream size if available.
          if (messageParams.dataSize === undefined) {
            if (dataStream instanceof Blob) {
              // @ts-ignore — dataSize is set dynamically
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

    // Auto-encrypt data on RecordsWrite (Components 6, 9, 10, 11)
    //
    // Encryption scheme decision:
    //   | Condition                              | Scheme          |
    //   |----------------------------------------|-----------------|
    //   | $role record with recipient            | ProtocolPath    | ← key delivery
    //   | Root record + protocol has $role        | ProtocolContext  | ← deferred (needs recordId)
    //   | Non-root record in multi-party context | ProtocolContext  |
    //   | Single-party (no $role)                | ProtocolPath    | ← existing logic
    //
    // For root multi-party records, encryption is deferred until after message
    // creation because contextId = recordId, which is only known after create().
    // Follows the SDK's two-pass pattern: create → encryptSymmetricEncryptionKey → sign.

    // Tracks encrypted bytes + recipient for auto-push of role records.
    let roleRecordAutoPush: { encryptedBytes: Uint8Array; recipient: string } | undefined;
    // Tracks deferred context encryption info for root multi-party records.
    let deferredContextEncryption: {
      dataEncryptionKey: Uint8Array;
      dataEncryptionIV: Uint8Array;
      encryptedBytes: Uint8Array;
    } | undefined;

    if (isDwnRequest(request, DwnInterface.RecordsWrite) && request.encryption && !rawMessage) {
      const messageParams = request.messageParams;
      if (messageParams?.protocol && messageParams.protocolPath) {
        // 1. Fetch the installed protocol definition (cached)
        const protocolDefinition = await this.getProtocolDefinition(
          request.target,
          messageParams.protocol
        );

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
        const isRoleRecord = ruleSet.$role === true;
        const rootPathSegment = messageParams.protocolPath.split('/')[0];
        const isMultiPartyContext = this.protocolPathHasRoles(
          protocolDefinition, rootPathSegment,
        );
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

        if (isRoleRecord && messageParams.recipient) {
          // --- Key Delivery (Component 11) ---
          // Replace user data with the serialized context key for the recipient.
          const rootContextId = messageParams.parentContextId!.split('/')[0]
            || messageParams.parentContextId!;

          const { keyId: authorKeyId, keyUri: authorKeyUri } =
            await this.getEncryptionKeyInfo(request.author);

          const contextDerivationPath = [
            KeyDerivationScheme.ProtocolContext,
            rootContextId,
          ];

          // Derive the context private key bytes from KMS
          const contextDerivedPrivateKeyBytes =
            await this.agent.keyManager.derivePrivateKeyBytes({
              keyUri         : authorKeyUri,
              derivationPath : contextDerivationPath,
            });
          const contextDerivedPrivateJwk =
            await Secp256k1.privateKeyToJwk(contextDerivedPrivateKeyBytes);

          const contextDerivedKeyPayload: DerivedPrivateJwk = {
            rootKeyId         : authorKeyId,
            derivationScheme  : KeyDerivationScheme.ProtocolContext,
            derivationPath    : contextDerivationPath,
            derivedPrivateKey : contextDerivedPrivateJwk as PrivateKeyJwk,
          };

          // Fetch the recipient's protocol definition for their public key
          const recipientProtocolDef = await this.fetchRemoteProtocolDefinition(
            messageParams.recipient,
            messageParams.protocol!,
          );

          const rolePathSegments = messageParams.protocolPath!.split('/');
          let recipientRuleSet: any = recipientProtocolDef.structure;
          for (const seg of rolePathSegments) {
            recipientRuleSet = recipientRuleSet[seg];
          }

          const recipientPublicKey = recipientRuleSet?.$encryption?.publicKeyJwk;
          if (!recipientPublicKey) {
            throw new Error(
              `AgentDwnApi: Recipient '${messageParams.recipient}' does not have ` +
              `encryption configured for '${messageParams.protocolPath}'. ` +
              `The recipient must configure the protocol with encryption: true.`
            );
          }

          // Replace user data with the serialized context key
          plaintextBytes = Encoder.objectToBytes(contextDerivedKeyPayload);

          encryptionInput = {
            initializationVector : dataEncryptionIV,
            key                  : dataEncryptionKey,
            keyEncryptionInputs  : [{
              publicKeyId      : recipientRuleSet.$encryption!.rootKeyId,
              publicKey        : recipientPublicKey,
              derivationScheme : KeyDerivationScheme.ProtocolPath,
            }]
          };

        } else if (isMultiPartyContext && !isRootRecord) {
          // --- Non-root record in a multi-party context → Context key ---
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

          encryptionInput = {
            initializationVector : dataEncryptionIV,
            key                  : dataEncryptionKey,
            keyEncryptionInputs  : [{
              publicKeyId      : contextKeyInfo.keyId,
              publicKey        : contextPublicKey,
              derivationScheme : KeyDerivationScheme.ProtocolContext,
            }]
          };

        } else if (isMultiPartyContext && isRootRecord) {
          // --- Root record in multi-party context → Deferred context encryption ---
          // contextId = recordId, which is only known after message creation.
          // Skip encryptionInput here; apply it after create() below.
          encryptionInput = undefined;

        } else {
          // --- Single-party → ProtocolPath key (existing logic) ---
          encryptionInput = {
            initializationVector : dataEncryptionIV,
            key                  : dataEncryptionKey,
            keyEncryptionInputs  : [{
              publicKeyId      : ruleSet.$encryption.rootKeyId,
              publicKey        : ruleSet.$encryption.publicKeyJwk,
              derivationScheme : KeyDerivationScheme.ProtocolPath,
            }]
          };
        }

        // 7. Encrypt data with AES-256-CTR
        const plaintextStream = DataStream.fromBytes(plaintextBytes);
        const encryptedStream = await Encryption.aes256CtrEncrypt(
          dataEncryptionKey, dataEncryptionIV, plaintextStream
        );
        const encryptedBytes = await DataStream.toBytes(encryptedStream);

        // 8. Replace plaintext with encrypted data
        const encryptedCidStream = DataStream.fromBytes(encryptedBytes);
        // @ts-ignore — dataCid is set dynamically above
        messageParams.dataCid = await Cid.computeDagPbCidFromStream(encryptedCidStream);
        // @ts-ignore — dataSize is set dynamically above
        messageParams.dataSize = encryptedBytes.length;
        delete messageParams.data;
        readableStream = DataStream.fromBytes(encryptedBytes);
        request.dataStream = undefined;

        if (encryptionInput) {
          messageParams.encryptionInput = encryptionInput;
        } else {
          // Deferred — store info for post-creation encryption
          deferredContextEncryption = { dataEncryptionKey, dataEncryptionIV, encryptedBytes };
        }

        // Track role record for auto-push (Component 11)
        if (isRoleRecord && messageParams.recipient) {
          roleRecordAutoPush = {
            encryptedBytes,
            recipient: messageParams.recipient,
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

        const { keyId, keyUri } = await this.getEncryptionKeyInfo(request.author);
        const contextDerivationPath =
          Records.constructKeyDerivationPathUsingProtocolContextScheme(contextId);
        const contextPublicKey = await this.agent.keyManager.derivePublicKey({
          keyUri,
          derivationPath: contextDerivationPath,
        });

        const contextEncryptionInput: EncryptionInput = {
          initializationVector : deferredContextEncryption.dataEncryptionIV,
          key                  : deferredContextEncryption.dataEncryptionKey,
          keyEncryptionInputs  : [{
            publicKeyId      : keyId,
            publicKey        : contextPublicKey,
            derivationScheme : KeyDerivationScheme.ProtocolContext,
          }]
        };

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
      roleRecordAutoPush,
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
   * Constructs an EncryptionKeyDeriver callback for the SDK.
   * The SDK calls derivePublicKey(path), the KMS performs HKDF + public key
   * computation internally. The private key never leaves the KMS.
   *
   * Analogous to getSigner() for signing operations.
   *
   * @param didUri - The DID URI to create the key deriver for
   * @returns An EncryptionKeyDeriver callback object
   */
  private async getEncryptionKeyDeriver(
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
    const keyManager = this.agent.keyManager;

    return {
      rootKeyId        : keyId,
      derivationScheme : KeyDerivationScheme.ProtocolPath,
      decrypt          : async (fullDerivationPath, eciesPayload): Promise<Uint8Array> => {
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
   * Checks if a protocol path has $role descendants, indicating multi-party intent.
   * Recurses into the full sub-tree — handles deeply nested roles.
   */
  private protocolPathHasRoles(
    protocolDefinition: ProtocolDefinition,
    protocolPath: string,
  ): boolean {
    const segments = protocolPath.split('/');
    let ruleSet: ProtocolRuleSet | undefined =
      protocolDefinition.structure as unknown as ProtocolRuleSet;
    for (const segment of segments) {
      ruleSet = ruleSet[segment] as ProtocolRuleSet | undefined;
      if (!ruleSet) { return false; }
    }

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

    return hasRoleRecursive(ruleSet);
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
   * Resolves the appropriate KeyDecrypter for a record's encryption scheme.
   * Handles both single-party (ProtocolPath) and multi-party (ProtocolContext).
   *
   * For ProtocolContext records:
   *   - Context creator: derives key directly from KMS
   *   - Participant: finds role record, decrypts context key, caches it
   */
  private async resolveKeyDecrypter(
    authorDid: string,
    recordsWrite: RecordsWriteMessage,
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
      const keyManager = this.agent.keyManager;
      return {
        rootKeyId        : keyId,
        derivationScheme : KeyDerivationScheme.ProtocolContext,
        decrypt          : async (fullDerivationPath, eciesPayload): Promise<Uint8Array> => {
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

    // Case 2: I am a participant — need to find and decrypt my role record
    const cacheKey = `ctx~${authorDid}~${rootContextId}`;
    const cached = this._contextDerivedKeyCache.get(cacheKey);
    if (cached) {
      return this.buildContextKeyDecrypter(cached);
    }

    // Find participant record — local first, then remote fallback
    const protocol = recordsWrite.descriptor.protocol!;
    const signer = await this.getSigner(authorDid);

    let participantEntry = await this.findParticipantRecord(
      authorDid, protocol, rootContextId, signer, 'local',
    );

    if (!participantEntry) {
      const contextOwnerDid = Jws.getSignerDid(
        recordsWrite.authorization.signature.signatures[0]
      );
      participantEntry = await this.findParticipantRecord(
        authorDid, protocol, rootContextId, signer, 'remote',
        contextOwnerDid,
      );

      // Store locally for future lookups
      if (participantEntry) {
        await this._dwn.processMessage(
          authorDid, participantEntry, { dataStream: undefined }
        );
      }
    }

    if (!participantEntry || !participantEntry.encodedData
        || !participantEntry.encryption) {
      throw new Error(
        `AgentDwnApi: Failed to decrypt record '${recordsWrite.recordId}'. ` +
        `Record uses context-derived encryption but no participant record ` +
        `could be found for this context.`
      );
    }

    // Decrypt the participant record with our protocol-path key
    const pathKeyDecrypter = await this.getKeyDecrypter(authorDid);
    const cipherBytes = Encoder.base64UrlToBytes(participantEntry.encodedData);
    const plainStream = await Records.decrypt(
      participantEntry as RecordsWriteMessage,
      pathKeyDecrypter,
      DataStream.fromBytes(cipherBytes),
    );
    const plainBytes = await DataStream.toBytes(plainStream);

    const contextDerivedPrivateKey = Encoder.bytesToObject(
      plainBytes,
    ) as DerivedPrivateJwk;

    this._contextDerivedKeyCache.set(cacheKey, contextDerivedPrivateKey);
    return this.buildContextKeyDecrypter(contextDerivedPrivateKey);
  }

  /**
   * Queries for a participant record (role record addressed to the user)
   * in a given context. Supports both local and remote DWN queries.
   */
  private async findParticipantRecord(
    recipientDid: string,
    protocol: string,
    contextId: string,
    signer: DwnSigner,
    target: 'local' | 'remote',
    remoteDid?: string,
  ): Promise<(RecordsWriteMessage & { encodedData?: string }) | undefined> {
    const query = await dwnMessageConstructors[
      DwnInterface.RecordsQuery
    ].create({
      filter: {
        protocol,
        recipient: recipientDid,
        contextId,
      },
      signer,
    });

    let reply: RecordsQueryReply;
    if (target === 'local') {
      reply = await this._dwn.processMessage(
        recipientDid, query.message,
      ) as RecordsQueryReply;
    } else {
      reply = await this.sendDwnRpcRequest({
        targetDid       : remoteDid!,
        dwnEndpointUrls : await getDwnServiceEndpointUrls(
          remoteDid!, this.agent.did,
        ),
        message: query.message,
      }) as RecordsQueryReply;
    }

    if (reply.status.code !== 200 || !reply.entries?.length) {
      return undefined;
    }

    return reply.entries[0] as RecordsWriteMessage & { encodedData?: string };
  }

  /**
   * Builds a KeyDecrypter from a context-derived private key.
   * Uses the raw key directly (since it was shared with us via role record).
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
          request.author, readReply.entry.recordsWrite,
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
              request.author, entry as RecordsWriteMessage,
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
}