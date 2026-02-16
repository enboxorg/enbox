import type { Readable } from '@enbox/common';
import type { KeyIdentifier, PublicJwk } from '@enbox/crypto';

import type {
  DwnConfig,
  EncryptionKeyDeriver,
  GenericMessage,
  KeyDecrypter,
  ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { CryptoUtils } from '@enbox/crypto';
import {
  Cid,
  DataStoreLevel,
  Dwn,
  DwnInterfaceName,
  DwnMethodName,
  EventEmitterStream,
  EventLogLevel,
  KeyDerivationScheme,
  Message,
  MessageStoreLevel,
  ResumableTaskStoreLevel
} from '@enbox/dwn-sdk-js';
import { DidDht, DidJwk, DidResolverCacheLevel, UniversalResolver } from '@enbox/dids';
import { NodeStream, TtlCache } from '@enbox/common';

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

import { blobToIsomorphicNodeReadable, getDwnServiceEndpointUrls, isRecordsWrite, webReadableToIsomorphicNodeReadable } from './utils.js';
import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';

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
    // Constructs a DWN message. and if there is a data payload, transforms the data to a Node
    // Readable stream.
    const { message, dataStream } = await this.constructDwnMessage({ request });

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
    let readableStream: Readable | undefined;
    // TODO: Consider refactoring to move data transformations imposed by fetch() limitations to the HTTP transport-related methods.
    // if the request is a RecordsWrite message, we need to handle the data stream and update the messageParams accordingly
    if (isDwnRequest(request, DwnInterface.RecordsWrite)) {
      const messageParams = request.messageParams;

      if (request.dataStream && !messageParams?.data) {
        const { dataStream } = request;
        let isomorphicNodeReadable: Readable;

        if (dataStream instanceof Blob) {
          isomorphicNodeReadable = blobToIsomorphicNodeReadable(dataStream);
          readableStream = blobToIsomorphicNodeReadable(dataStream);

        } else if (dataStream instanceof ReadableStream) {
          const [ forCid, forProcessMessage ] = dataStream.tee();
          isomorphicNodeReadable = webReadableToIsomorphicNodeReadable(forCid);
          readableStream = webReadableToIsomorphicNodeReadable(forProcessMessage);
        }

        if (!rawMessage) {
          // @ts-ignore
          messageParams.dataCid = await Cid.computeDagPbCidFromStream(isomorphicNodeReadable);
          // @ts-ignore
          messageParams.dataSize ??= isomorphicNodeReadable['bytesRead'];
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

    return { message: dwnMessage.message as DwnMessage[T], dataStream: readableStream };
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
    publicKeyJwk: PublicJwk;
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
      publicKeyJwk : publicKeyJwk as PublicJwk,
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
      derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicJwk> => {
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
      const dataBytes = await NodeStream.consumeToBytes({ readable: messageEntry.data });
      dwnMessageWithBlob.data = new Blob([ dataBytes ], { type: messageEntry.message.descriptor.dataFormat });
    }

    return dwnMessageWithBlob;
  }
}