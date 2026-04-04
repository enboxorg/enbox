import type { PublicKeyJwk } from '@enbox/crypto';
import type {
  DerivedPrivateJwk,
  EncryptionInput,
  RecordsQueryReply,
  RecordsReadReply,
} from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';
import type {
  DwnMessage,
  DwnMessageReply,
  ProcessDwnRequest,
} from './types/dwn.js';

import {
  ContentEncryptionAlgorithm,
  DataStream,
  KeyDerivationScheme,
  Message,
  Protocols,
  Records,
} from '@enbox/dwn-sdk-js';

import { KeyDeliveryProtocolDefinition } from './store-data-protocols.js';
import { buildEncryptionInput, encryptAndComputeCid, getEncryptionKeyDeriver, getKeyDecrypter, ivLength } from './dwn-encryption.js';
import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';

/**
 * Parameters for writeContextKeyRecord.
 */
export type WriteContextKeyParams = {
  tenantDid: string;
  recipientDid: string;
  contextKeyData: DerivedPrivateJwk;
  sourceProtocol: string;
  sourceContextId: string;
  recipientKeyDeliveryPublicKey?: { rootKeyId: string; publicKeyJwk: PublicKeyJwk };
};

/**
 * Parameters for fetchContextKeyRecord.
 */
export type FetchContextKeyParams = {
  ownerDid: string;
  requesterDid: string;
  sourceProtocol: string;
  sourceContextId: string;
};

/** Callback type for processRequest, used by key-delivery functions. */
type ProcessRequestFn = <T extends DwnInterface>(
  request: ProcessDwnRequest<T>
) => Promise<{ reply: DwnMessageReply[T]; message?: DwnMessage[T]; messageCid: string }>;

/**
 * Ensures the key delivery protocol is installed on the given tenant's DWN,
 * with `$encryption` keys injected. Uses the same lazy initialization pattern
 * as `DwnDataStore.initialize()`.
 *
 * @param agent - The platform agent
 * @param tenantDid - The DID of the DWN owner
 * @param processRequest - The agent's processRequest method (bound)
 * @param getProtocolDefinition - Function to get a protocol definition
 * @param installedCache - Cache for installation status
 */
export async function ensureKeyDeliveryProtocol(
  agent: EnboxPlatformAgent,
  tenantDid: string,
  processRequest: ProcessRequestFn,
  getProtocolDefinition: (tenantDid: string, protocolUri: string) => Promise<any>,
  installedCache: { get(key: string): boolean | undefined; set(key: string, value: boolean): void; delete(key: string): void },
  protocolDefinitionCache: { delete(key: string): void },
): Promise<void> {
  if (installedCache.get(tenantDid)) {
    return;
  }

  const protocolUri = KeyDeliveryProtocolDefinition.protocol;
  const existing = await getProtocolDefinition(tenantDid, protocolUri);

  if (!existing) {
    // Derive and inject $encryption keys for each type path
    const keyDeriver = await getEncryptionKeyDeriver(agent, tenantDid);
    const definitionWithKeys = await Protocols.deriveAndInjectPublicEncryptionKeys(
      KeyDeliveryProtocolDefinition,
      keyDeriver,
    );

    const { reply: { status } } = await processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: definitionWithKeys },
    });

    if (status.code !== 202) {
      throw new Error(`AgentDwnApi: Failed to install key delivery protocol: ${status.code} - ${status.detail}`);
    }

    // Invalidate protocol definition cache so subsequent reads pick up the new definition
    protocolDefinitionCache.delete(`${tenantDid}~${protocolUri}`);
  }

  installedCache.set(tenantDid, true);
}

/**
 * Writes a `contextKey` record to the owner's DWN, delivering an encrypted
 * context key to a participant.
 *
 * The payload is encrypted to the **recipient's** ProtocolPath-derived public
 * key on the key-delivery protocol, so only the recipient can decrypt it.
 *
 * @param agent - The platform agent
 * @param params - The write parameters
 * @param processRequest - The agent's processRequest method (bound)
 * @param ensureProtocol - Function to ensure key delivery protocol is installed
 * @param eagerSend - Function to eagerly send the record to the remote DWN
 * @returns The recordId of the written contextKey record
 */
export async function writeContextKeyRecord(
  agent: EnboxPlatformAgent,
  params: WriteContextKeyParams,
  processRequest: ProcessRequestFn,
  ensureProtocol: (tenantDid: string) => Promise<void>,
  eagerSend: (tenantDid: string, message: DwnMessage[DwnInterface.RecordsWrite]) => Promise<void>,
): Promise<string> {
  const { tenantDid, recipientDid, contextKeyData, sourceProtocol, sourceContextId, recipientKeyDeliveryPublicKey } = params;

  // Ensure the key delivery protocol is installed on the owner's DWN
  await ensureProtocol(tenantDid);

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
    const algorithm = ContentEncryptionAlgorithm.A256GCM;
    const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(ivLength(algorithm)));

    const { encryptedBytes, dataCid, dataSize, authenticationTag } =
      await encryptAndComputeCid(plaintextBytes, dataEncryptionKey, dataEncryptionIV, algorithm);

    const encryptionInput = {
      ...buildEncryptionInput(
        dataEncryptionKey, dataEncryptionIV,
        recipientKeyDeliveryPublicKey.rootKeyId,
        recipientKeyDeliveryPublicKey.publicKeyJwk,
        KeyDerivationScheme.ProtocolPath,
      ),
      authenticationTag,
    } as EncryptionInput;

    ({ message, reply: { status } } = await processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : { ...contextKeyParams, dataCid, dataSize, encryptionInput },
      dataStream    : new Blob([encryptedBytes as BlobPart]),
    }));
  } else {
    // --- Fallback: encrypt to the owner's key (local self-delivery) ---
    // When no recipient key is provided, use the generic processRequest
    // encryption path which encrypts to the DWN owner's ProtocolPath key.
    ({ message, reply: { status } } = await processRequest({
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
  eagerSend(tenantDid, message).catch((err: Error) => {
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
 *
 * @param agent - The platform agent
 * @param tenantDid - The DWN owner's DID
 * @param contextKeyMessage - The context key message to send
 * @param getDwnMessage - Function to read a full message from local DWN
 * @param sendDwnRpcRequest - Function to send a DWN RPC request
 * @param getDwnEndpointUrlsForTarget - Function to resolve DWN endpoint URLs (with local discovery)
 */
export async function eagerSendContextKeyRecord(
  agent: EnboxPlatformAgent,
  tenantDid: string,
  contextKeyMessage: DwnMessage[DwnInterface.RecordsWrite],
  getDwnMessage: (params: { author: string; messageType: DwnInterface; messageCid: string }) => Promise<{ message: any; data?: Blob }>,
  sendDwnRpcRequest: (params: { targetDid: string; dwnEndpointUrls: string[]; message: any; data?: Blob }) => Promise<any>,
  getDwnEndpointUrlsForTarget: (targetDid: string) => Promise<string[]>,
): Promise<void> {
  let dwnEndpointUrls: string[];
  try {
    dwnEndpointUrls = await getDwnEndpointUrlsForTarget(tenantDid);
  } catch {
    // DID resolution or endpoint lookup failed — not fatal, sync will handle it.
    return;
  }

  if (dwnEndpointUrls.length === 0) {
    return;
  }

  // Read the full message (including data blob) from the local DWN
  const { data } = await getDwnMessage({
    author      : tenantDid,
    messageType : DwnInterface.RecordsWrite,
    messageCid  : await Message.getCid(contextKeyMessage),
  });

  await sendDwnRpcRequest({
    targetDid : tenantDid,
    dwnEndpointUrls,
    message   : contextKeyMessage,
    data,
  });
}

/**
 * Attempts a local DWN fetch for a contextKey record.
 *
 * Queries the owner's tenant on the LOCAL DWN directly (bypassing the
 * `processRequest` routing layer, which may route `target: ownerDid`
 * to a remote DWN when the owner DID is not in the identity store).
 *
 * Works when sync has brought a copy of the contextKey record to the
 * owner's tenant on the requester's local DWN (cross-device scenario),
 * or when the requester IS the owner.
 */
async function tryLocalFetch(
  agent: EnboxPlatformAgent,
  getSigner: (author: string) => Promise<any>,
  requesterDid: string,
  ownerDid: string,
  contextKeyFilter: Record<string, any>,
  parsePayload: (bytes: Uint8Array) => DerivedPrivateJwk,
): Promise<DerivedPrivateJwk | undefined> {
  try {
    let dwn;
    try { dwn = agent.dwn.node; } catch { return undefined; }
    if (!dwn) { return undefined; }

    // Build and sign a RecordsQuery directly against the local DWN.
    const signer = await getSigner(requesterDid);
    const recordsQuery = await dwnMessageConstructors[DwnInterface.RecordsQuery].create({
      signer,
      filter: contextKeyFilter,
    });

    const queryResult = await dwn.processMessage(
      ownerDid, recordsQuery.message,
    );

    if (queryResult.status.code !== 200 || !queryResult.entries?.length) {
      return undefined;
    }

    // Read the full record.
    const recordId = (queryResult.entries[0] as any).recordId;
    const recordsRead = await dwnMessageConstructors[DwnInterface.RecordsRead].create({
      signer,
      filter: { recordId },
    });

    const readResult = await dwn.processMessage(
      ownerDid, recordsRead.message,
    ) as RecordsReadReply;

    if (!readResult.entry?.data || !readResult.entry?.recordsWrite) {
      return undefined;
    }

    // Decrypt using the requester's key-delivery protocol path key.
    const keyDecrypter = await getKeyDecrypter(agent, requesterDid);
    const decryptedStream = await Records.decrypt(
      readResult.entry.recordsWrite,
      keyDecrypter,
      readResult.entry.data as ReadableStream<Uint8Array>,
    );

    return parsePayload(await DataStream.toBytes(decryptedStream));
  } catch {
    return undefined;
  }
}

/**
 * Fetches and decrypts a `contextKey` record from a DWN, returning the
 * `DerivedPrivateJwk` payload.
 *
 * Supports both local reads (tenant queries own DWN) and remote reads
 * (participant queries the context owner's DWN).
 *
 * @param agent - The platform agent
 * @param params - The fetch parameters
 * @param processRequest - The agent's processRequest method (bound)
 * @param getSigner - Function to get a signer for a DID
 * @param sendDwnRpcRequest - Function to send a DWN RPC request
 * @param getDwnEndpointUrlsForTarget - Function to resolve DWN endpoint URLs (with local discovery)
 * @returns The decrypted `DerivedPrivateJwk`, or `undefined` if no matching record found
 */
export async function fetchContextKeyRecord(
  agent: EnboxPlatformAgent,
  params: FetchContextKeyParams,
  processRequest: ProcessRequestFn,
  getSigner: (author: string) => Promise<any>,
  sendDwnRpcRequest: (params: { targetDid: string; dwnEndpointUrls: string[]; message: any; data?: Blob }) => Promise<any>,
  getDwnEndpointUrlsForTarget: (targetDid: string) => Promise<string[]>,
): Promise<DerivedPrivateJwk | undefined> {
  const { ownerDid, requesterDid, sourceProtocol, sourceContextId } = params;
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
    // Local query via processRequest: owner queries their own DWN.
    const { reply } = await processRequest({
      author        : requesterDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: contextKeyFilter },
    });

    if (reply.status.code !== 200 || !reply.entries?.length) {
      return undefined;
    }

    const localRecordId = reply.entries[0].recordId;
    const { reply: readReply } = await processRequest({
      author        : requesterDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: localRecordId } },
      encryption    : true,
    });

    const readResult = readReply as RecordsReadReply;
    if (!readResult.entry?.data) {
      return undefined;
    }

    return parsePayload(await DataStream.toBytes(readResult.entry.data));
  }

  // Cross-device path: the requester is NOT the owner.
  // Try the local DWN first (sync may have brought a copy to the owner's
  // tenant), then fall back to remote RPC.
  const localResult = await tryLocalFetch(
    agent, getSigner, requesterDid, ownerDid, contextKeyFilter, parsePayload,
  );
  if (localResult) {
    return localResult;
  }

  {
    // Remote query: participant queries the context owner's DWN
    const signer = await getSigner(requesterDid);
    const dwnEndpointUrls = await getDwnEndpointUrlsForTarget(ownerDid);

    const recordsQuery = await dwnMessageConstructors[DwnInterface.RecordsQuery].create({
      signer,
      filter: contextKeyFilter,
    });

    const queryReply = await sendDwnRpcRequest({
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

    const readReply = await sendDwnRpcRequest({
      targetDid : ownerDid,
      dwnEndpointUrls,
      message   : recordsRead.message,
    }) as RecordsReadReply;

    if (!readReply.entry?.data || !readReply.entry?.recordsWrite) {
      return undefined;
    }

    // Decrypt the contextKey payload using the requester's key-delivery protocol path key
    const keyDecrypter = await getKeyDecrypter(agent, requesterDid);
    const decryptedStream = await Records.decrypt(
      readReply.entry.recordsWrite,
      keyDecrypter,
      readReply.entry.data as ReadableStream<Uint8Array>,
    );

    return parsePayload(await DataStream.toBytes(decryptedStream));
  }
}
