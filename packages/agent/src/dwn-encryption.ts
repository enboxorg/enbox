import type {
  DataEncodedRecordsWriteMessage,
  DerivedPrivateJwk,
  EncryptionInput,
  EncryptionKeyDeriver,
  KeyDecrypter,
  KeyDecrypterDerivationScheme,
  PermissionGrant,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';
import type { KeyIdentifier, PrivateKeyJwk, PublicKeyJwk } from '@enbox/crypto';

import type { EnboxPlatformAgent } from './types/agent.js';
import type {
  DwnMessageReply,
  ProcessDwnRequest,
  SendDwnRequest,
} from './types/dwn.js';

import { logger } from '@enbox/common';
import {
  Cid,
  ContentEncryptionAlgorithm,
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  PermissionGrant as DwnPermissionGrant,
  Encoder,
  Encryption,
  EncryptionProtocol,
  HdKey,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  Message,
  Records,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
  Time,
} from '@enbox/dwn-sdk-js';
import { Ed25519, X25519 } from '@enbox/crypto';

import { DwnInterface } from './types/dwn.js';
import { isDwnRequest } from './dwn-type-guards.js';

const GRANT_KEY_DERIVATION_PATH = [
  KeyDerivationScheme.ProtocolPath,
  EncryptionProtocol.uri,
  EncryptionProtocol.grantKeyPath,
];

type DelegateDecryptionKeyCache = {
  get(key: string): DelegateDecryptionKeyEntry[] | undefined;
  set?(key: string, value: DelegateDecryptionKeyEntry[]): void;
};

export type AudienceDecryptionKeyCache = {
  get(key: string): AudienceDecryptionKeyEntry | undefined;
  set?(key: string, value: AudienceDecryptionKeyEntry): void;
};

type GrantKeyScope = {
  scheme: typeof KeyDerivationScheme.ProtocolPath;
  protocol: string;
  protocolPath?: string;
};

type X25519KeyMaterialBase = {
  algorithm: typeof KeyAgreementAlgorithm.X25519HkdfSha256A256Kw;
  derivationScheme: string;
  keyId: string;
  publicKeyJwk: PublicKeyJwk;
  privateKeyJwk: PrivateKeyJwk;
};

type X25519ProtocolPathKeyMaterial = X25519KeyMaterialBase & {
  derivationScheme: typeof KeyDerivationScheme.ProtocolPath;
  derivationPath: string[];
};

type X25519RoleAudienceKeyMaterial = X25519KeyMaterialBase & {
  derivationScheme: typeof ROLE_AUDIENCE_DERIVATION_SCHEME;
};

type GrantKeyPayload = {
  grantId: string;
  scope: GrantKeyScope;
  keyMaterial: X25519ProtocolPathKeyMaterial;
};

export type AudienceEpochPayload = {
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
  publicKeyJwk: PublicKeyJwk;
};

export type AudienceKeyPayload = {
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyMaterial: X25519RoleAudienceKeyMaterial;
};

export type AudienceDecryptionKeyEntry = AudienceKeyPayload & {
  sourceDid: string;
  recipientDid: string;
};

/**
 * Returns the IV/counter byte length for DWN content encryption.
 */
export function ivLength(_algorithm: ContentEncryptionAlgorithm): number {
  return 16;
}

/**
 * Builds a partial EncryptionInput object for a single key-encryption entry.
 */
export function buildEncryptionInput(
  dek: Uint8Array,
  iv: Uint8Array,
  keyId: string,
  publicKey: PublicKeyJwk,
  derivationScheme: typeof KeyDerivationScheme.ProtocolPath,
): EncryptionInput {
  return {
    initializationVector : iv,
    key                  : dek,
    keyEncryptionInputs  : [{
      keyId,
      publicKey,
      derivationScheme,
    }],
  };
}

/**
 * Encrypts plaintext bytes and computes the CID of the resulting ciphertext.
 */
export async function encryptAndComputeCid(
  plaintextBytes: Uint8Array,
  dek: Uint8Array,
  iv: Uint8Array,
  algorithm: ContentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256CTR,
): Promise<{ encryptedBytes: Uint8Array; dataCid: string; dataSize: number }> {
  const ciphertextStream = await Encryption.encryptStream(
    algorithm, dek, iv, DataStream.fromBytes(plaintextBytes),
  );
  const encryptedBytes = await DataStream.toBytes(ciphertextStream as ReadableStream<Uint8Array>);
  const cidStream = DataStream.fromBytes(encryptedBytes);
  const dataCid = await Cid.computeDagPbCidFromStream(cidStream);
  return { encryptedBytes, dataCid, dataSize: encryptedBytes.length };
}

/**
 * Resolves the encryption key info for a given DID.
 * Looks up the keyAgreement verification method in the DID document,
 * then resolves the corresponding KMS key URI.
 *
 * @param agent - The platform agent to use for DID resolution and key management
 * @param didUri - The DID URI to resolve encryption key info for
 * @returns keyId (fully qualified verification method ID), keyUri (KMS reference),
 *          and publicKeyJwk. No private key material is returned.
 * @throws If the DID has no keyAgreement verification method or it's not X25519.
 */
export async function getEncryptionKeyInfo(
  agent: EnboxPlatformAgent,
  didUri: string,
): Promise<{
  keyId: string;
  keyUri: KeyIdentifier;
  publicKeyJwk: PublicKeyJwk;
}> {
  // 1. Resolve the DID document
  const { didDocument, didResolutionMetadata } = await agent.did.resolve(didUri);
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
      `verification method. Create the identity with an X25519 key ` +
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

  // 4. Resolve or derive the X25519 key for encryption.
  // Standard case: the keyAgreement VM already has an X25519 key.
  // Delegate case: did:jwk with Ed25519 only — convert to X25519.
  // The Ed25519→X25519 conversion is a standard cryptographic operation
  // (RFC 8032 / libsodium). The converted X25519 key must already be
  // present in the agent's KMS (imported via the delegate PortableDid).
  let resolvedPublicKeyJwk = verificationMethod.publicKeyJwk;

  if (resolvedPublicKeyJwk.crv === 'Ed25519') {
    resolvedPublicKeyJwk = await Ed25519.convertPublicKeyToX25519({
      publicKey: resolvedPublicKeyJwk,
    });
  } else if (resolvedPublicKeyJwk.crv !== 'X25519') {
    throw new Error(
      `AgentDwnApi: keyAgreement key for '${didUri}' uses curve ` +
      `'${resolvedPublicKeyJwk.crv}', but DWN encryption requires ` +
      `'X25519' (or 'Ed25519' which is auto-converted).`
    );
  }

  // 5. Compute the KMS key URI (does NOT export the key)
  const keyUri = await agent.keyManager.getKeyUri({ key: resolvedPublicKeyJwk });

  return {
    keyId        : verificationMethod.id,
    keyUri,
    publicKeyJwk : resolvedPublicKeyJwk as PublicKeyJwk,
  };
}

/**
 * Builds a KMS-backed key unwrap callback.
 *
 * @param agent - The platform agent with access to the key manager
 * @param keyId - The root key ID
 * @param keyUri - The KMS key URI
 * @param derivationScheme - The key derivation scheme
 */
export function buildKmsDecryptCallback(
  agent: EnboxPlatformAgent,
  keyId: string,
  keyUri: KeyIdentifier,
  derivationScheme: typeof KeyDerivationScheme.ProtocolPath,
): KeyDecrypter {
  const keyManager = agent.keyManager;
  return {
    rootKeyId       : keyId,
    derivationScheme,
    derivePublicKey : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
      return keyManager.derivePublicKey({
        keyUri,
        derivationPath: fullDerivationPath,
      });
    },
    decrypt: async (fullDerivationPath, keyUnwrapPayload): Promise<Uint8Array> => {
      return keyManager.jweKeyUnwrap({
        keyUri,
        derivationPath     : fullDerivationPath,
        encryptedKey       : keyUnwrapPayload.encryptedKey,
        ephemeralPublicKey : keyUnwrapPayload.ephemeralPublicKey,
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
 * @param agent - The platform agent
 * @param didUri - The DID URI to create the key deriver for
 * @returns An EncryptionKeyDeriver callback object
 */
export async function getEncryptionKeyDeriver(
  agent: EnboxPlatformAgent,
  didUri: string,
): Promise<EncryptionKeyDeriver> {
  const { keyId, keyUri } = await getEncryptionKeyInfo(agent, didUri);
  const keyManager = agent.keyManager;

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
 * Constructs a ProtocolPath KeyDecrypter.
 *
 * @param agent - The platform agent
 * @param didUri - The DID URI to create the key decrypter for
 * @returns A KeyDecrypter callback object
 */
export async function getKeyDecrypter(
  agent: EnboxPlatformAgent,
  didUri: string,
): Promise<KeyDecrypter> {
  const { keyId, keyUri } = await getEncryptionKeyInfo(agent, didUri);
  return buildKmsDecryptCallback(agent, keyId, keyUri, KeyDerivationScheme.ProtocolPath);
}

/**
 * Builds a KeyDecrypter from a delivered protocol/path-derived private key.
 *
 * @param key - The delivered derived private key
 */
export function buildProtocolPathSubtreeDecrypter(
  key: DerivedPrivateJwk,
): KeyDecrypter {
  return {
    rootKeyId        : key.rootKeyId,
    derivationScheme : key.derivationScheme,
    derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
      const leafPrivateKeyBytes = await Records.derivePrivateKey(
        key, fullDerivationPath,
      );
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return await X25519.getPublicKey({ key: leafPrivateKeyJwk }) as PublicKeyJwk;
    },
    decrypt: async (fullDerivationPath, keyUnwrapPayload): Promise<Uint8Array> => {
      const leafPrivateKeyBytes = await Records.derivePrivateKey(
        key, fullDerivationPath,
      );
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return Encryption.unwrapKey(leafPrivateKeyJwk as any, keyUnwrapPayload.keyEncryption);
    },
  };
}

export function buildFixedPrivateKeyDecrypter(params: {
  keyId: string;
  derivationScheme: KeyDecrypterDerivationScheme;
  publicKeyJwk: PublicKeyJwk;
  privateKeyJwk: PrivateKeyJwk;
}): KeyDecrypter {
  return {
    rootKeyId        : params.keyId,
    derivationScheme : params.derivationScheme,
    derivePublicKey  : async (): Promise<PublicKeyJwk> => params.publicKeyJwk,
    decrypt          : async (_fullDerivationPath, keyUnwrapPayload): Promise<Uint8Array> => {
      return Encryption.unwrapKey(params.privateKeyJwk as any, keyUnwrapPayload.keyEncryption);
    },
  };
}

/** Cache entry shape for scope-aware delegate decryption keys. */
export type DelegateDecryptionKeyEntry = {
  protocol: string;
  scope: { kind: 'protocol' } | { kind: 'protocolPath'; protocolPath: string };
  derivedPrivateKey: DerivedPrivateJwk;
};

/**
 * Creates durable grantKey records for read grants that carry encrypted protocol access.
 *
 * The record payload delivers the owner-derived ProtocolPath private key. The record
 * itself is encrypted to the grantee's own Encryption Protocol `grantKey` path.
 */
export async function createGrantKeyRecordsForGrants(params: {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  granteeDid: string;
  granteeRootPrivateKey: PrivateKeyJwk;
  grantMessages: DataEncodedRecordsWriteMessage[];
}): Promise<DataEncodedRecordsWriteMessage[]> {
  const grantKeyRecords: DataEncodedRecordsWriteMessage[] = [];

  for (const grantMessage of params.grantMessages) {
    const grant = DwnPermissionGrant.parse(grantMessage);
    if (!isGrantKeyEligibleGrant(grant)) {
      continue;
    }

    const payload = await buildGrantKeyPayload(params.agent, params.ownerDid, grant);
    const payloadBytes = Encoder.objectToBytes(payload);
    const contentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256CTR;
    const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(ivLength(contentEncryptionAlgorithm)));
    const granteeGrantKeyPublicKey = await derivePublicKeyFromPrivateKey(
      params.granteeRootPrivateKey,
      GRANT_KEY_DERIVATION_PATH,
    );
    const granteeGrantKeyKeyId = await Encryption.getKeyId(granteeGrantKeyPublicKey);
    const encryptionInput = buildEncryptionInput(
      dataEncryptionKey,
      dataEncryptionIV,
      granteeGrantKeyKeyId,
      granteeGrantKeyPublicKey,
      KeyDerivationScheme.ProtocolPath,
    );
    const { encryptedBytes, dataCid, dataSize } = await encryptAndComputeCid(
      payloadBytes,
      dataEncryptionKey,
      dataEncryptionIV,
      contentEncryptionAlgorithm,
    );

    const { reply, message } = await params.agent.processDwnRequest({
      author        : params.ownerDid,
      target        : params.ownerDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        recipient    : params.granteeDid,
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.grantKeyPath,
        schema       : EncryptionProtocol.definition.types.grantKey.schema,
        dataFormat   : 'application/json',
        dataCid,
        dataSize,
        encryptionInput,
        tags         : {
          grantId  : grant.id,
          protocol : grant.scope.protocol,
          ...(grant.scope.protocolPath ? { protocolPath: grant.scope.protocolPath } : {}),
          keyId    : payload.keyMaterial.keyId,
        },
      },
      dataStream: DataStream.fromBytes(encryptedBytes),
    });

    if (reply.status.code !== 202 && reply.status.code !== 409) {
      throw new Error(`AgentDwnApi: Failed to create grantKey record: ${reply.status.detail}`);
    }

    grantKeyRecords.push({
      ...message!,
      encodedData: Encoder.bytesToBase64Url(encryptedBytes),
    } as DataEncodedRecordsWriteMessage);
  }

  return grantKeyRecords;
}

export async function createAudienceEpochRecord(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  authorDid: string;
  audienceKey: AudienceKeyPayload;
  protocolRole?: string;
}): Promise<DataEncodedRecordsWriteMessage> {
  const payload: AudienceEpochPayload = {
    protocol     : params.audienceKey.protocol,
    contextId    : params.audienceKey.contextId,
    role         : params.audienceKey.role,
    epoch        : params.audienceKey.epoch,
    keyId        : params.audienceKey.keyMaterial.keyId,
    publicKeyJwk : params.audienceKey.keyMaterial.publicKeyJwk,
  };
  const payloadBytes = Encoder.objectToBytes(payload);

  const { reply, message } = await params.agent.processDwnRequest({
    author        : params.authorDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsWrite,
    messageParams : {
      published    : true,
      protocol     : EncryptionProtocol.uri,
      protocolPath : EncryptionProtocol.audienceEpochPath,
      protocolRole : params.protocolRole,
      schema       : EncryptionProtocol.definition.types.audienceEpoch.schema,
      dataFormat   : 'application/json',
      dataSize     : payloadBytes.length,
      tags         : {
        protocol  : params.audienceKey.protocol,
        contextId : params.audienceKey.contextId,
        role      : params.audienceKey.role,
        epoch     : params.audienceKey.epoch,
        keyId     : params.audienceKey.keyMaterial.keyId,
      },
    },
    dataStream: DataStream.fromBytes(payloadBytes),
  });

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`AgentDwnApi: Failed to create audienceEpoch record: ${reply.status.detail}`);
  }

  return {
    ...message!,
    encodedData: Encoder.bytesToBase64Url(payloadBytes),
  } as DataEncodedRecordsWriteMessage;
}

export async function createAudienceKeyRecord(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  authorDid: string;
  recipientDid: string;
  recipientRolePublicKey: PublicKeyJwk;
  audienceKey: AudienceKeyPayload;
  protocolRole?: string;
}): Promise<DataEncodedRecordsWriteMessage> {
  const payloadBytes = Encoder.objectToBytes(params.audienceKey);
  const contentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256CTR;
  const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
  const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(ivLength(contentEncryptionAlgorithm)));
  const recipientRoleKeyId = await Encryption.getKeyId(params.recipientRolePublicKey);
  const encryptionInput = buildEncryptionInput(
    dataEncryptionKey,
    dataEncryptionIV,
    recipientRoleKeyId,
    params.recipientRolePublicKey,
    KeyDerivationScheme.ProtocolPath,
  );
  const { encryptedBytes, dataCid, dataSize } = await encryptAndComputeCid(
    payloadBytes,
    dataEncryptionKey,
    dataEncryptionIV,
    contentEncryptionAlgorithm,
  );

  const { reply, message } = await params.agent.processDwnRequest({
    author        : params.authorDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsWrite,
    messageParams : {
      recipient    : params.recipientDid,
      protocol     : EncryptionProtocol.uri,
      protocolPath : EncryptionProtocol.audienceKeyPath,
      protocolRole : params.protocolRole,
      schema       : EncryptionProtocol.definition.types.audienceKey.schema,
      dataFormat   : 'application/json',
      dataCid,
      dataSize,
      encryptionInput,
      tags         : {
        protocol  : params.audienceKey.protocol,
        contextId : params.audienceKey.contextId,
        role      : params.audienceKey.role,
        epoch     : params.audienceKey.epoch,
        keyId     : params.audienceKey.keyMaterial.keyId,
      },
    },
    dataStream: DataStream.fromBytes(encryptedBytes),
  });

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`AgentDwnApi: Failed to create audienceKey record: ${reply.status.detail}`);
  }

  return {
    ...message!,
    encodedData: Encoder.bytesToBase64Url(encryptedBytes),
  } as DataEncodedRecordsWriteMessage;
}

export async function cacheAudienceDecryptionKey(params: {
  agent: EnboxPlatformAgent;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
  entry: AudienceDecryptionKeyEntry;
}): Promise<void> {
  await putCachedAudienceKey(params);
}

export async function getCachedAudienceDecryptionKey(params: {
  agent: EnboxPlatformAgent;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
}): Promise<AudienceDecryptionKeyEntry | undefined> {
  return getCachedAudienceKey(params);
}

/**
 * Resolves the appropriate KeyDecrypter for a record's encryption scheme.
 *
 * Owners derive protocol-path keys directly from KMS. Delegates use delivered
 * protocol-wide or path-subtree decryption keys when available.
 *
 * @param agent - The platform agent
 * @param authorDid - The DID of the author attempting to decrypt
 * @param recordsWrite - The records write message containing encryption info
 * @param targetDid - The target DID (DWN owner), if known
 * @param delegateDecryptionKeyCache - Cache for scope-aware delegate decryption keys
 * @param granteeDid - The delegate DID (if this is a delegated request)
 */
export async function resolveKeyDecrypter(
  agent: EnboxPlatformAgent,
  authorDid: string,
  recordsWrite: RecordsWriteMessage,
  targetDid: string | undefined,
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache,
  granteeDid?: string,
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache,
): Promise<KeyDecrypter> {
  if (granteeDid !== undefined) {
    const protocol = recordsWrite.descriptor.protocol;
    const protocolPath = recordsWrite.descriptor.protocolPath;
    if (protocol) {
      const cacheKey = `ddk~${granteeDid}`;
      const cachedKey = findCoveringDelegateKey(delegateDecryptionKeyCache?.get(cacheKey), protocol, protocolPath);
      if (cachedKey !== undefined) {
        return buildProtocolPathSubtreeDecrypter(cachedKey.derivedPrivateKey);
      }

      if (targetDid !== undefined && delegateDecryptionKeyCache?.set !== undefined) {
        const hydratedKeys = await resolveGrantKeyRecords({
          agent,
          grantorDid: targetDid,
          granteeDid,
          protocol,
          protocolPath,
        });

        if (hydratedKeys.length > 0) {
          const mergedKeys = mergeDelegateDecryptionKeys(
            delegateDecryptionKeyCache.get(cacheKey) ?? [],
            hydratedKeys,
          );
          delegateDecryptionKeyCache.set(cacheKey, mergedKeys);

          const hydratedKey = findCoveringDelegateKey(mergedKeys, protocol, protocolPath);
          if (hydratedKey !== undefined) {
            return buildProtocolPathSubtreeDecrypter(hydratedKey.derivedPrivateKey);
          }
        }
      }
    }

    const audienceDecrypter = await resolveRoleAudienceDecrypter({
      agent,
      sourceDid    : targetDid,
      recipientDid : authorDid,
      granteeDid,
      recordsWrite,
      delegateDecryptionKeyCache,
      audienceDecryptionKeyCache,
    });
    if (audienceDecrypter !== undefined) {
      return audienceDecrypter;
    }

    throw new Error(
      `AgentDwnApi: no delivered decryption key covers encrypted record ` +
      `'${recordsWrite.recordId}' for delegate '${granteeDid}'.`
    );
  }

  if (targetDid !== undefined && targetDid !== authorDid) {
    const audienceDecrypter = await resolveRoleAudienceDecrypter({
      agent,
      sourceDid    : targetDid,
      recipientDid : authorDid,
      recordsWrite,
      audienceDecryptionKeyCache,
    });
    if (audienceDecrypter !== undefined) {
      return audienceDecrypter;
    }
  }

  return getKeyDecrypter(agent, authorDid);
}

/**
 * Post-processes a DWN reply, auto-decrypting data if encryption is enabled.
 * Delegates to the SDK's Records.decrypt() with the appropriate KeyDecrypter —
 * resolveKeyDecrypter() selects either a delivered delegate key or KMS.
 *
 * @param request - The original DWN request
 * @param reply - The DWN reply to process
 * @param agent - The platform agent
 * @param delegateDecryptionKeyCache - Cache for scope-aware delegate decryption keys
 */
export async function maybeDecryptReply<T extends DwnInterface>(
  request: ProcessDwnRequest<T> | SendDwnRequest<T>,
  reply: DwnMessageReply[T],
  agent: EnboxPlatformAgent,
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache,
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache,
): Promise<void> {
  if (!('encryption' in request) || !request.encryption) {
    return;
  }

  // `request` here is the encrypted-write variant — `'encryption' in` has
  // eliminated the `{ messageCid }`-only arm of `SendDwnRequest`, leaving
  // the `ProcessDwnRequest<T>` shape which declares the optional
  // `granteeDid` field. Narrow once at the top so neither branch below
  // needs to repeat the cast.
  const encryptedRequest = request as ProcessDwnRequest<T>;
  const granteeDid = encryptedRequest.granteeDid;

  // Auto-decrypt RecordsRead replies
  if (isDwnRequest(encryptedRequest as ProcessDwnRequest<DwnInterface>, DwnInterface.RecordsRead)) {
    const readReply = reply as RecordsReadReply;
    if (readReply.status.code === 200
        && readReply.entry?.recordsWrite?.encryption
        && readReply.entry?.data) {
      const keyDecrypter = await resolveKeyDecrypter(
        agent, encryptedRequest.author, readReply.entry.recordsWrite, encryptedRequest.target,
        delegateDecryptionKeyCache, granteeDid, audienceDecryptionKeyCache,
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
  if (isDwnRequest(encryptedRequest as ProcessDwnRequest<DwnInterface>, DwnInterface.RecordsQuery)) {
    const queryReply = reply as RecordsQueryReply;
    if (queryReply.status.code === 200 && queryReply.entries) {
      for (const entry of queryReply.entries) {
        if (entry.encryption && entry.encodedData) {
          const keyDecrypter = await resolveKeyDecrypter(
            agent, encryptedRequest.author, entry as RecordsWriteMessage, encryptedRequest.target,
            delegateDecryptionKeyCache, granteeDid, audienceDecryptionKeyCache,
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

async function resolveRoleAudienceDecrypter(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string | undefined;
  recipientDid: string;
  recordsWrite: RecordsWriteMessage;
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
}): Promise<KeyDecrypter | undefined> {
  if (params.sourceDid === undefined || params.recordsWrite.encryption === undefined) {
    return undefined;
  }

  const roleAudienceEntries = params.recordsWrite.encryption.keyEncryption.filter((entry): entry is typeof entry & {
    derivationScheme: typeof ROLE_AUDIENCE_DERIVATION_SCHEME;
    protocol: string;
    role: string;
    epoch: number;
  } => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME);

  for (const entry of roleAudienceEntries) {
    const contextId = getRoleAudienceContextId(params.recordsWrite, entry.role);
    if (contextId === undefined) {
      continue;
    }

    const cachedKey = await getCachedAudienceKey({
      agent                      : params.agent,
      audienceDecryptionKeyCache : params.audienceDecryptionKeyCache,
      sourceDid                  : params.sourceDid,
      recipientDid               : params.recipientDid,
      protocol                   : entry.protocol,
      contextId,
      role                       : entry.role,
      epoch                      : entry.epoch,
      keyId                      : entry.keyId,
    });
    if (cachedKey !== undefined) {
      return buildAudienceContentDecrypter(cachedKey);
    }

    const hydratedKey = await hydrateAudienceKey({
      agent                      : params.agent,
      sourceDid                  : params.sourceDid,
      recipientDid               : params.recipientDid,
      granteeDid                 : params.granteeDid,
      delegateDecryptionKeyCache : params.delegateDecryptionKeyCache,
      protocol                   : entry.protocol,
      contextId,
      role                       : entry.role,
      epoch                      : entry.epoch,
      keyId                      : entry.keyId,
    });
    if (hydratedKey !== undefined) {
      await putCachedAudienceKey({
        agent                      : params.agent,
        audienceDecryptionKeyCache : params.audienceDecryptionKeyCache,
        entry                      : hydratedKey,
      });
      return buildAudienceContentDecrypter(hydratedKey);
    }
  }

  return undefined;
}

function buildAudienceContentDecrypter(entry: AudienceDecryptionKeyEntry): KeyDecrypter {
  return buildFixedPrivateKeyDecrypter({
    derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
    keyId            : entry.keyMaterial.keyId,
    privateKeyJwk    : entry.keyMaterial.privateKeyJwk,
    publicKeyJwk     : entry.keyMaterial.publicKeyJwk,
  });
}

async function hydrateAudienceKey(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<AudienceDecryptionKeyEntry | undefined> {
  const { reply } = await params.agent.processDwnRequest({
    author        : params.granteeDid ?? params.recipientDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        recipient    : params.recipientDid,
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.audienceKeyPath,
        tags         : {
          protocol  : params.protocol,
          contextId : params.contextId,
          role      : params.role,
          epoch     : params.epoch,
          keyId     : params.keyId,
        },
      },
    },
  });

  if (reply.status.code !== 200 || reply.entries === undefined || reply.entries.length === 0) {
    return undefined;
  }

  const rolePathDecrypter = await buildRecipientRolePathDecrypter({
    agent                      : params.agent,
    recipientDid               : params.recipientDid,
    granteeDid                 : params.granteeDid,
    delegateDecryptionKeyCache : params.delegateDecryptionKeyCache,
    protocol                   : params.protocol,
    role                       : params.role,
  });
  if (rolePathDecrypter === undefined) {
    return undefined;
  }

  for (const entry of reply.entries) {
    const audienceKeyMessage = entry as RecordsWriteMessage & { encodedData?: string };
    const encryptedData = await getAudienceKeyEncryptedData(
      params.agent, params.granteeDid ?? params.recipientDid, params.sourceDid, audienceKeyMessage,
    );
    if (encryptedData === undefined) {
      continue;
    }

    try {
      const decryptedStream = await Records.decrypt(
        audienceKeyMessage,
        rolePathDecrypter,
        DataStream.fromBytes(encryptedData),
      );
      const payload = Encoder.bytesToObject(await DataStream.toBytes(decryptedStream)) as AudienceKeyPayload;
      await verifyAudienceKeyPayload({
        agent        : params.agent,
        payload,
        audienceKeyMessage,
        sourceDid    : params.sourceDid,
        recipientDid : params.recipientDid,
        protocol     : params.protocol,
        contextId    : params.contextId,
        role         : params.role,
        epoch        : params.epoch,
        keyId        : params.keyId,
      });

      return {
        ...payload,
        sourceDid    : params.sourceDid,
        recipientDid : params.recipientDid,
      };
    } catch (error) {
      logger.log(
        `AgentDwnApi: skipped audienceKey '${audienceKeyMessage.recordId}' while resolving role-audience key: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
  }

  return undefined;
}

async function buildRecipientRolePathDecrypter(params: {
  agent: EnboxPlatformAgent;
  recipientDid: string;
  protocol: string;
  role: string;
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<KeyDecrypter | undefined> {
  const derivationPath = getScopeDerivationPath(params.protocol, params.role);
  const privateKeyJwk = await getRecipientRolePathPrivateKey({
    ...params,
    derivationPath,
  });
  if (privateKeyJwk === undefined) {
    return undefined;
  }

  const publicKeyJwk = await X25519.getPublicKey({ key: privateKeyJwk }) as PublicKeyJwk;
  return buildFixedPrivateKeyDecrypter({
    derivationScheme : KeyDerivationScheme.ProtocolPath,
    keyId            : await Encryption.getKeyId(publicKeyJwk),
    privateKeyJwk,
    publicKeyJwk,
  });
}

async function getRecipientRolePathPrivateKey(params: {
  agent: EnboxPlatformAgent;
  recipientDid: string;
  protocol: string;
  role: string;
  derivationPath: string[];
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<PrivateKeyJwk | undefined> {
  if (params.granteeDid === undefined) {
    const { keyUri } = await getEncryptionKeyInfo(params.agent, params.recipientDid);
    const privateKeyBytes = await params.agent.keyManager.derivePrivateKeyBytes({
      keyUri,
      derivationPath: params.derivationPath,
    });
    return X25519.bytesToPrivateKey({ privateKeyBytes }) as Promise<PrivateKeyJwk>;
  }

  const cacheKey = `ddk~${params.granteeDid}`;
  let delegateKeys = params.delegateDecryptionKeyCache?.get(cacheKey) ?? [];
  let coveringKey = findCoveringDelegateKey(delegateKeys, params.protocol, params.role);

  if (coveringKey === undefined && params.delegateDecryptionKeyCache?.set !== undefined) {
    const hydratedKeys = await resolveGrantKeyRecords({
      agent        : params.agent,
      grantorDid   : params.recipientDid,
      granteeDid   : params.granteeDid,
      protocol     : params.protocol,
      protocolPath : params.role,
    });
    delegateKeys = mergeDelegateDecryptionKeys(delegateKeys, hydratedKeys);
    params.delegateDecryptionKeyCache.set(cacheKey, delegateKeys);
    coveringKey = findCoveringDelegateKey(delegateKeys, params.protocol, params.role);
  }

  if (coveringKey === undefined) {
    return undefined;
  }

  const privateKeyBytes = await Records.derivePrivateKey(coveringKey.derivedPrivateKey, params.derivationPath);
  return X25519.bytesToPrivateKey({ privateKeyBytes }) as Promise<PrivateKeyJwk>;
}

async function getAudienceKeyEncryptedData(
  agent: EnboxPlatformAgent,
  authorDid: string,
  sourceDid: string,
  audienceKeyMessage: RecordsWriteMessage & { encodedData?: string },
): Promise<Uint8Array | undefined> {
  if (audienceKeyMessage.encodedData !== undefined) {
    return Encoder.base64UrlToBytes(audienceKeyMessage.encodedData);
  }

  const { reply } = await agent.processDwnRequest({
    author        : authorDid,
    target        : sourceDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId: audienceKeyMessage.recordId } },
  });

  if (reply.status.code !== 200 || reply.entry?.data === undefined) {
    return undefined;
  }

  return DataStream.toBytes(reply.entry.data);
}

async function verifyAudienceKeyPayload(params: {
  agent: EnboxPlatformAgent;
  payload: AudienceKeyPayload;
  audienceKeyMessage: RecordsWriteMessage;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
}): Promise<void> {
  const { payload, audienceKeyMessage } = params;
  const tags = audienceKeyMessage.descriptor.tags ?? {};

  assertAudienceKeyPayload(payload);
  const keyMaterial = payload.keyMaterial;

  if (audienceKeyMessage.descriptor.recipient !== params.recipientDid ||
      payload.protocol !== tags.protocol ||
      payload.contextId !== tags.contextId ||
      payload.role !== tags.role ||
      payload.epoch !== tags.epoch ||
      keyMaterial.keyId !== tags.keyId ||
      payload.protocol !== params.protocol ||
      payload.contextId !== params.contextId ||
      payload.role !== params.role ||
      payload.epoch !== params.epoch ||
      keyMaterial.keyId !== params.keyId) {
    throw new Error('audienceKey payload does not match record tags.');
  }

  const publicKeyId = await Encryption.getKeyId(keyMaterial.publicKeyJwk);
  const publicKeyFromPrivate = await X25519.getPublicKey({ key: keyMaterial.privateKeyJwk }) as PublicKeyJwk;
  const privateKeyId = await Encryption.getKeyId(publicKeyFromPrivate);
  if (keyMaterial.keyId !== publicKeyId || keyMaterial.keyId !== privateKeyId) {
    throw new Error('audienceKey keyId does not match delivered key material.');
  }

  await verifyAudienceKeyEpoch(params);
  await verifyAudienceKeyRoleAssignment(params);
}

function assertAudienceKeyPayload(payload: unknown): asserts payload is AudienceKeyPayload {
  if (!isObject(payload) ||
      typeof payload.protocol !== 'string' ||
      typeof payload.contextId !== 'string' ||
      typeof payload.role !== 'string' ||
      !Number.isInteger(payload.epoch) ||
      !isRoleAudienceKeyMaterial(payload.keyMaterial)) {
    throw new Error('audienceKey payload is malformed.');
  }
}

function assertGrantKeyPayload(payload: unknown): asserts payload is GrantKeyPayload {
  if (!isObject(payload) ||
      typeof payload.grantId !== 'string' ||
      !isObject(payload.scope) ||
      payload.scope.scheme !== KeyDerivationScheme.ProtocolPath ||
      typeof payload.scope.protocol !== 'string' ||
      (payload.scope.protocolPath !== undefined && typeof payload.scope.protocolPath !== 'string') ||
      !isProtocolPathKeyMaterial(payload.keyMaterial)) {
    throw new Error('grantKey payload is malformed.');
  }
}

function isProtocolPathKeyMaterial(value: unknown): value is X25519ProtocolPathKeyMaterial {
  if (!isX25519KeyMaterial(value) || value.derivationScheme !== KeyDerivationScheme.ProtocolPath) {
    return false;
  }

  return Array.isArray(value.derivationPath) &&
    value.derivationPath.every((segment): boolean => typeof segment === 'string');
}

function isRoleAudienceKeyMaterial(value: unknown): value is X25519RoleAudienceKeyMaterial {
  return isX25519KeyMaterial(value) &&
    value.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME;
}

function isX25519KeyMaterial(value: unknown): value is Record<string, unknown> & X25519KeyMaterialBase {
  return isObject(value) &&
    value.algorithm === KeyAgreementAlgorithm.X25519HkdfSha256A256Kw &&
    typeof value.derivationScheme === 'string' &&
    typeof value.keyId === 'string' &&
    isObject(value.publicKeyJwk) &&
    isObject(value.privateKeyJwk);
}

async function verifyAudienceKeyEpoch(params: {
  agent: EnboxPlatformAgent;
  payload: AudienceKeyPayload;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
}): Promise<void> {
  const { reply } = await params.agent.processDwnRequest({
    author        : params.recipientDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.audienceEpochPath,
        tags         : {
          protocol  : params.protocol,
          contextId : params.contextId,
          role      : params.role,
          epoch     : params.epoch,
          keyId     : params.keyId,
        },
      },
    },
  });

  const entries = reply.status.code === 200 ? reply.entries ?? [] : [];
  for (const entry of entries.filter((entry): boolean => audienceTagsMatch(entry as RecordsWriteMessage, params))) {
    const dataBytes = await getAudienceEpochData(
      params.agent,
      params.recipientDid,
      params.sourceDid,
      entry as RecordsWriteMessage & { encodedData?: string },
    );
    if (dataBytes === undefined) {
      continue;
    }

    const epochPayload = Encoder.bytesToObject(dataBytes) as Partial<AudienceEpochPayload>;
    if (epochPayload.protocol === params.payload.protocol &&
        epochPayload.contextId === params.payload.contextId &&
        epochPayload.role === params.payload.role &&
        epochPayload.epoch === params.payload.epoch &&
        epochPayload.keyId === params.payload.keyMaterial.keyId &&
        isPublicKeyJwkEqual(epochPayload.publicKeyJwk, params.payload.keyMaterial.publicKeyJwk)) {
      return;
    }
  }

  throw new Error('audienceKey does not match an accepted audienceEpoch.');
}

function audienceTagsMatch(entry: RecordsWriteMessage, expected: {
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
}): boolean {
  const tags = entry.descriptor.tags ?? {};
  return String(tags.protocol) === expected.protocol &&
    String(tags.contextId) === expected.contextId &&
    String(tags.role) === expected.role &&
    String(tags.epoch) === String(expected.epoch) &&
    String(tags.keyId) === expected.keyId;
}

async function getAudienceEpochData(
  agent: EnboxPlatformAgent,
  authorDid: string,
  sourceDid: string,
  audienceEpochMessage: RecordsWriteMessage & { encodedData?: string },
): Promise<Uint8Array | undefined> {
  if (audienceEpochMessage.encodedData !== undefined) {
    return Encoder.base64UrlToBytes(audienceEpochMessage.encodedData);
  }

  const { reply } = await agent.processDwnRequest({
    author        : authorDid,
    target        : sourceDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId: audienceEpochMessage.recordId } },
  });

  if (reply.status.code !== 200 || reply.entry?.data === undefined) {
    return undefined;
  }

  return DataStream.toBytes(reply.entry.data);
}

async function verifyAudienceKeyRoleAssignment(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  role: string;
}): Promise<void> {
  const contextIdPrefix = params.contextId === '' ? undefined : params.contextId;
  const { reply } = await params.agent.processDwnRequest({
    author        : params.recipientDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        ...(contextIdPrefix === undefined ? {} : { contextId: contextIdPrefix }),
        recipient    : params.recipientDid,
        protocol     : params.protocol,
        protocolPath : params.role,
      },
    },
  });

  const entries = reply.status.code === 200 ? reply.entries ?? [] : [];
  const hasRoleRecord = entries.some((entry): boolean => {
    const roleRecord = entry as RecordsWriteMessage;
    return roleRecord.descriptor.recipient === params.recipientDid &&
      roleRecord.descriptor.protocol === params.protocol &&
      roleRecord.descriptor.protocolPath === params.role &&
      matchesContextIdPrefix(roleRecord.contextId, contextIdPrefix);
  });

  if (!hasRoleRecord) {
    throw new Error('audienceKey recipient is not an active holder of the referenced role.');
  }
}

function matchesContextIdPrefix(contextId: string | undefined, contextIdPrefix: string | undefined): boolean {
  if (contextIdPrefix === undefined) {
    return true;
  }

  return contextId === contextIdPrefix || contextId?.startsWith(`${contextIdPrefix}/`) === true;
}

function isPublicKeyJwkEqual(left: unknown, right: PublicKeyJwk): boolean {
  if (!isObject(left)) {
    return false;
  }

  const rightRecord = right as Record<string, unknown>;
  return left.kty === right.kty &&
    left.crv === rightRecord.crv &&
    left.x === rightRecord.x;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getCachedAudienceKey(params: {
  agent: EnboxPlatformAgent;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
}): Promise<AudienceDecryptionKeyEntry | undefined> {
  const cacheKey = getAudienceDecryptionKeyCacheKey(params);
  const cached = params.audienceDecryptionKeyCache?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const secretBytes = await params.agent.secrets.get(cacheKey);
  if (secretBytes === undefined) {
    return undefined;
  }

  const entry = Encoder.bytesToObject(secretBytes) as AudienceDecryptionKeyEntry;
  params.audienceDecryptionKeyCache?.set?.(cacheKey, entry);
  return entry;
}

async function putCachedAudienceKey(params: {
  agent: EnboxPlatformAgent;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
  entry: AudienceDecryptionKeyEntry;
}): Promise<void> {
  const cacheKey = getAudienceDecryptionKeyCacheKey({
    ...params.entry,
    keyId: params.entry.keyMaterial.keyId,
  });
  params.audienceDecryptionKeyCache?.set?.(cacheKey, params.entry);
  await params.agent.secrets.put(cacheKey, Encoder.objectToBytes(params.entry));
}

function getAudienceDecryptionKeyCacheKey(input: {
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  role: string;
  epoch: number;
  keyId: string;
}): string {
  return `audience-key~${Encoder.stringToBase64Url(JSON.stringify([
    input.sourceDid,
    input.recipientDid,
    input.protocol,
    input.contextId,
    input.role,
    input.epoch,
    input.keyId,
  ]))}`;
}

function getRoleAudienceContextId(
  recordsWrite: RecordsWriteMessage,
  rolePath: string,
): string | undefined {
  const parentDepth = rolePath.split('/').length - 1;
  if (parentDepth === 0) {
    return '';
  }

  const contextId = recordsWrite.contextId;
  if (typeof contextId !== 'string') {
    return undefined;
  }

  const contextSegments = contextId.split('/');
  if (contextSegments.length < parentDepth) {
    return undefined;
  }

  return contextSegments.slice(0, parentDepth).join('/');
}

function isGrantKeyEligibleGrant(grant: PermissionGrant): grant is PermissionGrant & {
  scope: PermissionGrant['scope'] & {
    interface: typeof DwnInterfaceName.Records;
    method: typeof DwnMethodName.Read;
    protocol: string;
    protocolPath?: string;
  };
} {
  return grant.scope.interface === DwnInterfaceName.Records &&
    grant.scope.method === DwnMethodName.Read &&
    'protocol' in grant.scope &&
    typeof grant.scope.protocol === 'string' &&
    !('contextId' in grant.scope && grant.scope.contextId !== undefined);
}

async function buildGrantKeyPayload(
  agent: EnboxPlatformAgent,
  ownerDid: string,
  grant: PermissionGrant & {
    scope: PermissionGrant['scope'] & {
      protocol: string;
      protocolPath?: string;
    };
  },
): Promise<GrantKeyPayload> {
  const { keyUri } = await getEncryptionKeyInfo(agent, ownerDid);
  const derivationPath = getScopeDerivationPath(grant.scope.protocol, grant.scope.protocolPath);
  const privateKeyBytes = await agent.keyManager.derivePrivateKeyBytes({
    keyUri,
    derivationPath,
  });
  const privateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes }) as PrivateKeyJwk;
  const publicKeyJwk = await X25519.getPublicKey({ key: privateKeyJwk }) as PublicKeyJwk;
  const keyId = await Encryption.getKeyId(publicKeyJwk);

  return {
    grantId : grant.id,
    scope   : {
      scheme   : KeyDerivationScheme.ProtocolPath,
      protocol : grant.scope.protocol,
      ...(grant.scope.protocolPath ? { protocolPath: grant.scope.protocolPath } : {}),
    },
    keyMaterial: {
      algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
      derivationPath,
      derivationScheme : KeyDerivationScheme.ProtocolPath,
      keyId,
      privateKeyJwk,
      publicKeyJwk,
    },
  };
}

async function derivePublicKeyFromPrivateKey(
  privateKey: PrivateKeyJwk,
  derivationPath: string[],
): Promise<PublicKeyJwk> {
  const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey });
  const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, derivationPath);
  const derivedPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedPrivateKeyBytes });
  return X25519.getPublicKey({ key: derivedPrivateKeyJwk }) as Promise<PublicKeyJwk>;
}

function getScopeDerivationPath(protocol: string, protocolPath?: string): string[] {
  return [
    KeyDerivationScheme.ProtocolPath,
    protocol,
    ...(protocolPath ? protocolPath.split('/') : []),
  ];
}

function findCoveringDelegateKey(
  allKeys: DelegateDecryptionKeyEntry[] | undefined,
  protocol: string,
  protocolPath: string | undefined,
): DelegateDecryptionKeyEntry | undefined {
  if (allKeys === undefined) {
    return undefined;
  }

  const keysForProtocol = allKeys.filter((key) => key.protocol === protocol);

  if (protocolPath !== undefined) {
    const exactKey = keysForProtocol.find(
      (key) => key.scope.kind === 'protocolPath' && key.scope.protocolPath === protocolPath
    );
    if (exactKey !== undefined) {
      return exactKey;
    }

    const ancestorKey = keysForProtocol
      .filter((key): key is DelegateDecryptionKeyEntry & {
        scope: { kind: 'protocolPath'; protocolPath: string }
      } =>
        key.scope.kind === 'protocolPath' &&
        protocolPath.startsWith(key.scope.protocolPath + '/')
      )
      .sort((a, b): number => b.scope.protocolPath.length - a.scope.protocolPath.length)[0];
    if (ancestorKey !== undefined) {
      return ancestorKey;
    }
  }

  return keysForProtocol.find((key) => key.scope.kind === 'protocol');
}

function mergeDelegateDecryptionKeys(
  existingKeys: DelegateDecryptionKeyEntry[],
  newKeys: DelegateDecryptionKeyEntry[],
): DelegateDecryptionKeyEntry[] {
  const merged = new Map<string, DelegateDecryptionKeyEntry>();
  for (const key of existingKeys) {
    merged.set(getDelegateDecryptionKeyCacheKey(key), key);
  }
  for (const key of newKeys) {
    merged.set(getDelegateDecryptionKeyCacheKey(key), key);
  }
  return [...merged.values()];
}

function getDelegateDecryptionKeyCacheKey(key: DelegateDecryptionKeyEntry): string {
  return key.scope.kind === 'protocol'
    ? `${key.protocol}~protocol`
    : `${key.protocol}~protocolPath~${key.scope.protocolPath}`;
}

async function resolveGrantKeyRecords(params: {
  agent: EnboxPlatformAgent;
  grantorDid: string;
  granteeDid: string;
  protocol: string;
  protocolPath?: string;
}): Promise<DelegateDecryptionKeyEntry[]> {
  const { reply } = await params.agent.processDwnRequest({
    author        : params.granteeDid,
    target        : params.grantorDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        recipient    : params.granteeDid,
        protocol     : EncryptionProtocol.uri,
        protocolPath : EncryptionProtocol.grantKeyPath,
        tags         : { protocol: params.protocol },
      },
    },
  });

  if (reply.status.code !== 200 || reply.entries === undefined || reply.entries.length === 0) {
    return [];
  }

  const granteeDecrypter = await getKeyDecrypter(params.agent, params.granteeDid);
  const resolvedKeys: DelegateDecryptionKeyEntry[] = [];

  for (const entry of reply.entries) {
    const grantKeyMessage = entry as RecordsWriteMessage & { encodedData?: string };
    if (Message.getAuthor(grantKeyMessage) !== params.grantorDid) {
      continue;
    }

    const encryptedData = await getGrantKeyEncryptedData(params.agent, params.granteeDid, params.grantorDid, grantKeyMessage);
    if (encryptedData === undefined) {
      continue;
    }

    try {
      const decryptedStream = await Records.decrypt(
        grantKeyMessage,
        granteeDecrypter,
        DataStream.fromBytes(encryptedData),
      );
      const payload = Encoder.bytesToObject(await DataStream.toBytes(decryptedStream)) as GrantKeyPayload;
      const grant = await readPermissionGrant(params.agent, params.granteeDid, params.grantorDid, payload.grantId);
      await verifyPermissionGrantActive(params.agent, params.granteeDid, params.grantorDid, grant);

      await verifyGrantKeyPayload({
        payload,
        grant,
        grantKeyMessage,
        grantorDid   : params.grantorDid,
        granteeDid   : params.granteeDid,
        protocol     : params.protocol,
        protocolPath : params.protocolPath,
      });

      resolvedKeys.push({
        protocol : payload.scope.protocol,
        scope    : payload.scope.protocolPath === undefined
          ? { kind: 'protocol' }
          : { kind: 'protocolPath', protocolPath: payload.scope.protocolPath },
        derivedPrivateKey: {
          rootKeyId         : payload.keyMaterial.keyId,
          keyId             : payload.keyMaterial.keyId,
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          derivationPath    : payload.keyMaterial.derivationPath,
          derivedPrivateKey : payload.keyMaterial.privateKeyJwk,
        },
      });
    } catch (error) {
      logger.log(
        `AgentDwnApi: skipped grantKey '${grantKeyMessage.recordId}' while resolving delegate decryption key: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
  }

  return resolvedKeys;
}

async function getGrantKeyEncryptedData(
  agent: EnboxPlatformAgent,
  granteeDid: string,
  grantorDid: string,
  grantKeyMessage: RecordsWriteMessage & { encodedData?: string },
): Promise<Uint8Array | undefined> {
  if (grantKeyMessage.encodedData !== undefined) {
    return Encoder.base64UrlToBytes(grantKeyMessage.encodedData);
  }

  const { reply } = await agent.processDwnRequest({
    author        : granteeDid,
    target        : grantorDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId: grantKeyMessage.recordId } },
  });

  if (reply.status.code !== 200 || reply.entry?.data === undefined) {
    return undefined;
  }

  return DataStream.toBytes(reply.entry.data);
}

async function readPermissionGrant(
  agent: EnboxPlatformAgent,
  granteeDid: string,
  grantorDid: string,
  grantId: string,
): Promise<PermissionGrant> {
  const { reply } = await agent.processDwnRequest({
    author        : granteeDid,
    target        : grantorDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId: grantId } },
  });

  if (reply.status.code !== 200 || reply.entry?.recordsWrite === undefined || reply.entry.data === undefined) {
    throw new Error(`AgentDwnApi: unable to read permission grant '${grantId}'.`);
  }

  const grantData = await DataStream.toBytes(reply.entry.data);
  return DwnPermissionGrant.parse({
    ...reply.entry.recordsWrite,
    encodedData: Encoder.bytesToBase64Url(grantData),
  } as DataEncodedRecordsWriteMessage);
}

async function verifyPermissionGrantActive(
  agent: EnboxPlatformAgent,
  granteeDid: string,
  grantorDid: string,
  grant: PermissionGrant,
): Promise<void> {
  const now = Time.getCurrentTimestamp();
  if (now < grant.dateGranted || now >= grant.dateExpires) {
    throw new Error('grantKey references an inactive permission grant.');
  }

  const revoked = await agent.permissions.isGrantRevoked({
    author        : granteeDid,
    target        : grantorDid,
    grantRecordId : grant.id,
  });
  if (revoked) {
    throw new Error('grantKey references a revoked permission grant.');
  }
}

async function verifyGrantKeyPayload(params: {
  payload: GrantKeyPayload;
  grant: PermissionGrant;
  grantKeyMessage: RecordsWriteMessage;
  grantorDid: string;
  granteeDid: string;
  protocol: string;
  protocolPath?: string;
}): Promise<void> {
  const { payload, grant, grantKeyMessage } = params;
  const tags = grantKeyMessage.descriptor.tags ?? {};

  assertGrantKeyPayload(payload);

  if (payload.grantId !== tags.grantId ||
      payload.scope.protocol !== tags.protocol ||
      payload.keyMaterial.keyId !== tags.keyId ||
      payload.scope.protocolPath !== tags.protocolPath) {
    throw new Error('grantKey payload does not match record tags.');
  }

  if (grant.id !== payload.grantId ||
      grant.grantor !== params.grantorDid ||
      grant.grantee !== params.granteeDid ||
      !grantScopeCoversPayload(grant, payload)) {
    throw new Error('grantKey payload is not covered by the referenced grant.');
  }

  if (payload.scope.scheme !== KeyDerivationScheme.ProtocolPath ||
      payload.scope.protocol !== params.protocol ||
      !scopeCoversRecord(payload.scope, params.protocol, params.protocolPath)) {
    throw new Error('grantKey scope does not cover encrypted record.');
  }

  const expectedDerivationPath = getScopeDerivationPath(payload.scope.protocol, payload.scope.protocolPath);
  if (!arrayEquals(payload.keyMaterial.derivationPath, expectedDerivationPath)) {
    throw new Error('grantKey derivationPath does not match scope.');
  }

  const publicKeyId = await Encryption.getKeyId(payload.keyMaterial.publicKeyJwk);
  const publicKeyFromPrivate = await X25519.getPublicKey({ key: payload.keyMaterial.privateKeyJwk }) as PublicKeyJwk;
  const privateKeyId = await Encryption.getKeyId(publicKeyFromPrivate);
  if (payload.keyMaterial.keyId !== publicKeyId || payload.keyMaterial.keyId !== privateKeyId) {
    throw new Error('grantKey keyId does not match delivered key material.');
  }
}

function grantScopeCoversPayload(grant: PermissionGrant, payload: GrantKeyPayload): boolean {
  if (!isGrantKeyEligibleGrant(grant)) {
    return false;
  }

  if (grant.scope.protocol !== payload.scope.protocol) {
    return false;
  }

  if (grant.scope.protocolPath === undefined) {
    return true;
  }

  return payload.scope.protocolPath !== undefined &&
    isBoundaryAwareSubtree(grant.scope.protocolPath, payload.scope.protocolPath);
}

function scopeCoversRecord(scope: GrantKeyScope, protocol: string, protocolPath: string | undefined): boolean {
  if (scope.protocol !== protocol) {
    return false;
  }

  if (scope.protocolPath === undefined) {
    return true;
  }

  return protocolPath !== undefined && isBoundaryAwareSubtree(scope.protocolPath, protocolPath);
}

function isBoundaryAwareSubtree(scopePath: string, candidatePath: string): boolean {
  return candidatePath === scopePath || candidatePath.startsWith(scopePath + '/');
}

function arrayEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
