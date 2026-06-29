import type {
  DataEncodedRecordsWriteMessage,
  DerivedPrivateJwk,
  EncryptionInput,
  EncryptionKeyDeriver,
  KeyDecrypter,
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
  KeyDerivationScheme,
  Message,
  Records,
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

type GrantKeyScope = {
  scheme: typeof KeyDerivationScheme.ProtocolPath;
  protocol: string;
  protocolPath?: string;
};

type GrantKeyPayload = {
  grantId: string;
  scope: GrantKeyScope;
  derivationPath: string[];
  keyId: string;
  publicKeyJwk: PublicKeyJwk;
  privateKeyJwk: PrivateKeyJwk;
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
          keyId    : payload.keyId,
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

    throw new Error(
      `AgentDwnApi: no delivered decryption key covers encrypted record ` +
      `'${recordsWrite.recordId}' for delegate '${granteeDid}'.`
    );
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
        delegateDecryptionKeyCache, granteeDid,
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
            delegateDecryptionKeyCache, granteeDid,
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
    derivationPath,
    keyId,
    publicKeyJwk,
    privateKeyJwk,
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
          rootKeyId         : payload.keyId,
          keyId             : payload.keyId,
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          derivationPath    : payload.derivationPath,
          derivedPrivateKey : payload.privateKeyJwk,
        },
      });
    } catch {
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

  if (payload.grantId !== tags.grantId ||
      payload.scope.protocol !== tags.protocol ||
      payload.keyId !== tags.keyId ||
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
  if (!arrayEquals(payload.derivationPath, expectedDerivationPath)) {
    throw new Error('grantKey derivationPath does not match scope.');
  }

  const publicKeyId = await Encryption.getKeyId(payload.publicKeyJwk);
  const publicKeyFromPrivate = await X25519.getPublicKey({ key: payload.privateKeyJwk }) as PublicKeyJwk;
  const privateKeyId = await Encryption.getKeyId(publicKeyFromPrivate);
  if (payload.keyId !== publicKeyId || payload.keyId !== privateKeyId) {
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
