import type {
  DataEncodedRecordsWriteMessage,
  DerivedPrivateJwk,
  EncryptionControlAudiencePayload,
  EncryptionControlDeliveryPayload,
  EncryptionControlSeal,
  EncryptionInput,
  EncryptionKeyDeriver,
  GrantKeyEligibleRecordsScope,
  GrantKeyProtocolPathScope,
  KeyDecrypter,
  KeyDecrypterDerivationScheme,
  PermissionGrant,
  ProtocolDefinition,
  RecordsQueryReply,
  RecordsQueryReplyEntry,
  RecordsReadReply,
  RecordsWriteMessage,
  RoleAudienceKeyMaterial,
  WrappedGrantKeyEnvelope,
} from '@enbox/dwn-sdk-js';
import type { PrivateKeyJwk, PublicKeyJwk } from '@enbox/crypto';

import type { EnboxPlatformAgent } from './types/agent.js';
import type {
  DwnMessageReply,
  DwnResponse,
  ProcessDwnRequest,
  SendDwnRequest,
} from './types/dwn.js';

import { logger } from '@enbox/common';
import {
  assertWrappedGrantKeyEnvelope,
  Cid,
  ContentEncryptionAlgorithm,
  DataStream,
  DwnMethodName,
  PermissionGrant as DwnPermissionGrant,
  Encoder,
  Encryption,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  ENCRYPTION_CONTROL_AUDIENCE_SCHEMA_URI,
  ENCRYPTION_CONTROL_DELIVERY_PATH,
  ENCRYPTION_CONTROL_DELIVERY_SCHEMA_URI,
  EncryptionControlDeliveryRecipientAuthority,
  EncryptionProtocol,
  getGrantKeyDeliveryScopes,
  getRoleAudienceContextId,
  getRoleContextPrefix,
  grantKeyScopeCoversDeliveredScope,
  HdKey,
  isEncryptionControlPath,
  isGrantKeyEligibleRecordsScope,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  Message,
  Records,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
  SEAL_DERIVATION_SCHEME,
  Time,
  WRAPPED_GRANT_KEY_FORMAT,
} from '@enbox/dwn-sdk-js';
import { Ed25519, X25519 } from '@enbox/crypto';

import { DwnInterface } from './types/dwn.js';
import { isDwnRequest } from './dwn-type-guards.js';
import { processDwnRequestWithRemoteFallback as processDwnReadThrough } from './dwn-read-through.js';

const GRANT_KEY_DERIVATION_PATH = [
  KeyDerivationScheme.ProtocolPath,
  EncryptionProtocol.uri,
  EncryptionProtocol.grantKeyPath,
];

type DelegateDecryptionKeyCache = {
  get(key: string): DelegateDecryptionKeyEntry[] | undefined;
  set?(key: string, value: DelegateDecryptionKeyEntry[]): void;
};

type ResolveKeyDecrypterParams = {
  agent: EnboxPlatformAgent;
  authorDid: string;
  recordsWrite: RecordsWriteMessage;
  targetDid: string | undefined;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
  granteeDid?: string;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
};

export type AudienceDecryptionKeyCache = {
  get(key: string): AudienceDecryptionKeyEntry | undefined;
  set?(key: string, value: AudienceDecryptionKeyEntry): void;
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

type GrantKeyPayload = {
  grantId: string;
  scope: GrantKeyProtocolPathScope;
  keyMaterial: X25519ProtocolPathKeyMaterial;
};

type HydrateAudienceKeyParams = {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
  keyId: string;
  granteeDid?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
};

/** The actor a `$encryption/delivery` query is authored as (optionally via a delegated grant). */
export type AudienceDeliveryReadActor = {
  authorDid: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  granteeDid?: string;
};

export type EncodedRecordsWriteMessage = RecordsWriteMessage & { encodedData?: string };


type AudienceRecordCandidate = {
  message: EncodedRecordsWriteMessage;
  payload: EncryptionControlAudiencePayload;
};

export type AudienceKeyPayload = EncryptionControlDeliveryPayload;

export type AudienceDecryptionKeyEntry = {
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
  keyMaterial: RoleAudienceKeyMaterial;
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
      algorithm: KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
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
  keyUri: string;
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
  keyUri: string,
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
      return keyManager.unwrapContentKey({
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
  grantorDid: string;
  protocol: string;
  scope: { kind: 'protocol' } | { kind: 'protocolPath'; protocolPath: string };
  derivedPrivateKey: DerivedPrivateJwk;
};

type GrantKeyDeliveryKey =
  | {
    kind: 'encrypted';
    granteeGrantKeyKeyId: string;
    granteeGrantKeyPublicKey: PublicKeyJwk;
  }
  | {
    kind: 'wrapped';
    granteeRootKeyId: string;
    granteeRootPublicKey: PublicKeyJwk;
  };

type GrantKeyRecordData = {
  dataBytes: Uint8Array;
  dataCid: string;
  dataSize: number;
  encryptionInput?: EncryptionInput;
};

type WrappedGrantKeyRecipient = {
  keyUri: string;
  rootKeyId: string;
};

class WrappedGrantKeyTargetMismatchError extends Error {
  public constructor(actualKeyId: string, expectedKeyId: string) {
    super(`AgentDwnApi: wrapped grantKey targets key '${actualKeyId}', expected '${expectedKeyId}'.`);
  }
}

/**
 * Creates durable grantKey records for read grants that carry encrypted protocol access.
 *
 * The record payload delivers the owner-derived ProtocolPath private key. Wallet-minted
 * delegates receive an encrypted `grantKey` record, while supplied delegates receive a
 * plaintext record carrying a wrapped envelope encrypted to their root X25519 key.
 */
export async function createGrantKeyRecordsForGrants(params: {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  granteeDid: string;
  granteeRootPrivateKey?: PrivateKeyJwk;
  granteeRootPublicKey?: PublicKeyJwk;
  grantMessages: DataEncodedRecordsWriteMessage[];
  protocolDefinitions?: ProtocolDefinition[];
}): Promise<DataEncodedRecordsWriteMessage[]> {
  const grantKeyRecords: DataEncodedRecordsWriteMessage[] = [];
  const protocolDefinitions = new Map(
    (params.protocolDefinitions ?? []).map((definition) => [definition.protocol, definition])
  );
  const deliveryKey = await resolveGrantKeyDeliveryKey(params);

  for (const grantMessage of params.grantMessages) {
    const grant = DwnPermissionGrant.parse(grantMessage);
    if (!isGrantKeyEligibleGrant(grant)) {
      continue;
    }

    const payloads = await buildGrantKeyPayloads(params.agent, params.ownerDid, grant, protocolDefinitions);
    for (const payload of payloads) {
      grantKeyRecords.push(await createGrantKeyRecordForPayload({
        agent      : params.agent,
        deliveryKey,
        grant,
        granteeDid : params.granteeDid,
        ownerDid   : params.ownerDid,
        payload,
      }));
    }
  }

  return grantKeyRecords;
}

async function resolveGrantKeyDeliveryKey(params: {
  granteeRootPrivateKey?: PrivateKeyJwk;
  granteeRootPublicKey?: PublicKeyJwk;
}): Promise<GrantKeyDeliveryKey> {
  if (params.granteeRootPrivateKey !== undefined) {
    if (params.granteeRootPublicKey !== undefined) {
      throw new Error('AgentDwnApi: createGrantKeyRecordsForGrants requires exactly one grantee root key.');
    }

    const granteeGrantKeyPublicKey = await derivePublicKeyFromPrivateKey(
      params.granteeRootPrivateKey,
      GRANT_KEY_DERIVATION_PATH,
    );

    return {
      kind                 : 'encrypted',
      granteeGrantKeyKeyId : await Encryption.getKeyId(granteeGrantKeyPublicKey),
      granteeGrantKeyPublicKey,
    };
  }

  if (params.granteeRootPublicKey === undefined) {
    throw new Error('AgentDwnApi: createGrantKeyRecordsForGrants requires exactly one grantee root key.');
  }

  return {
    kind                 : 'wrapped',
    granteeRootKeyId     : await Encryption.getKeyId(params.granteeRootPublicKey),
    granteeRootPublicKey : params.granteeRootPublicKey,
  };
}

async function createGrantKeyRecordForPayload(params: {
  agent: EnboxPlatformAgent;
  deliveryKey: GrantKeyDeliveryKey;
  grant: PermissionGrant;
  granteeDid: string;
  ownerDid: string;
  payload: GrantKeyPayload;
}): Promise<DataEncodedRecordsWriteMessage> {
  const payloadBytes = Encoder.objectToBytes(params.payload);
  const contentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256CTR;
  const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
  const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(ivLength(contentEncryptionAlgorithm)));
  const recordData = await buildGrantKeyRecordData({
    contentEncryptionAlgorithm,
    dataEncryptionIV,
    dataEncryptionKey,
    deliveryKey: params.deliveryKey,
    payloadBytes,
  });

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
      dataCid      : recordData.dataCid,
      dataSize     : recordData.dataSize,
      ...(recordData.encryptionInput !== undefined ? { encryptionInput: recordData.encryptionInput } : {}),
      tags         : buildGrantKeyRecordTags(params.grant, params.payload),
    },
    dataStream: DataStream.fromBytes(recordData.dataBytes),
  });

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`AgentDwnApi: Failed to create grantKey record: ${reply.status.detail}`);
  }

  return {
    ...message!,
    encodedData: Encoder.bytesToBase64Url(recordData.dataBytes),
  } as DataEncodedRecordsWriteMessage;
}

function buildGrantKeyRecordTags(grant: PermissionGrant, payload: GrantKeyPayload): Record<string, string> {
  return {
    grantId  : grant.id,
    protocol : payload.scope.protocol,
    ...(payload.scope.protocolPath !== undefined ? { protocolPath: payload.scope.protocolPath } : {}),
    keyId    : payload.keyMaterial.keyId,
  };
}

async function buildGrantKeyRecordData(params: {
  contentEncryptionAlgorithm: ContentEncryptionAlgorithm;
  dataEncryptionIV: Uint8Array;
  dataEncryptionKey: Uint8Array;
  deliveryKey: GrantKeyDeliveryKey;
  payloadBytes: Uint8Array;
}): Promise<GrantKeyRecordData> {
  if (params.deliveryKey.kind === 'encrypted') {
    return buildEncryptedGrantKeyRecordData({
      contentEncryptionAlgorithm : params.contentEncryptionAlgorithm,
      dataEncryptionIV           : params.dataEncryptionIV,
      dataEncryptionKey          : params.dataEncryptionKey,
      granteeGrantKeyKeyId       : params.deliveryKey.granteeGrantKeyKeyId,
      granteeGrantKeyPublicKey   : params.deliveryKey.granteeGrantKeyPublicKey,
      payloadBytes               : params.payloadBytes,
    });
  }

  return buildWrappedGrantKeyRecordData({
    contentEncryptionAlgorithm : params.contentEncryptionAlgorithm,
    dataEncryptionIV           : params.dataEncryptionIV,
    dataEncryptionKey          : params.dataEncryptionKey,
    granteeRootKeyId           : params.deliveryKey.granteeRootKeyId,
    granteeRootPublicKey       : params.deliveryKey.granteeRootPublicKey,
    payloadBytes               : params.payloadBytes,
  });
}

async function buildEncryptedGrantKeyRecordData(params: {
  contentEncryptionAlgorithm: ContentEncryptionAlgorithm;
  dataEncryptionIV: Uint8Array;
  dataEncryptionKey: Uint8Array;
  granteeGrantKeyKeyId: string;
  granteeGrantKeyPublicKey: PublicKeyJwk;
  payloadBytes: Uint8Array;
}): Promise<GrantKeyRecordData> {
  const encryptionInput = buildEncryptionInput(
    params.dataEncryptionKey,
    params.dataEncryptionIV,
    params.granteeGrantKeyKeyId,
    params.granteeGrantKeyPublicKey,
    KeyDerivationScheme.ProtocolPath,
  );
  const { encryptedBytes, dataCid, dataSize } = await encryptAndComputeCid(
    params.payloadBytes,
    params.dataEncryptionKey,
    params.dataEncryptionIV,
    params.contentEncryptionAlgorithm,
  );

  return {
    dataBytes: encryptedBytes,
    dataCid,
    dataSize,
    encryptionInput,
  };
}

async function buildWrappedGrantKeyRecordData(params: {
  contentEncryptionAlgorithm: ContentEncryptionAlgorithm;
  dataEncryptionIV: Uint8Array;
  dataEncryptionKey: Uint8Array;
  granteeRootKeyId: string;
  granteeRootPublicKey: PublicKeyJwk;
  payloadBytes: Uint8Array;
}): Promise<GrantKeyRecordData> {
  const ciphertext = await Encryption.encrypt(
    params.contentEncryptionAlgorithm,
    params.dataEncryptionKey,
    params.dataEncryptionIV,
    params.payloadBytes,
  );
  const encryption = await Encryption.buildEncryptionProperty({
    algorithm            : params.contentEncryptionAlgorithm,
    initializationVector : params.dataEncryptionIV,
    key                  : params.dataEncryptionKey,
    keyEncryptionInputs  : [{
      algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
      derivationScheme : KeyDerivationScheme.ProtocolPath,
      keyId            : params.granteeRootKeyId,
      publicKey        : params.granteeRootPublicKey,
    }],
  });
  const [{ derivationScheme: _derivationScheme, ...keyEncryption }] = encryption.keyEncryption;
  const envelope: WrappedGrantKeyEnvelope = {
    format            : WRAPPED_GRANT_KEY_FORMAT,
    keyEncryption,
    contentEncryption : {
      algorithm            : encryption.algorithm,
      initializationVector : encryption.initializationVector,
    },
    ciphertext: Encoder.bytesToBase64Url(ciphertext),
  };
  const dataBytes = Encoder.objectToBytes(envelope);
  const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);

  return {
    dataBytes,
    dataCid,
    dataSize: dataBytes.length,
  };
}

/**
 * Writes a durable audience record whose plaintext payload seals the audience private key to the tenant role-path key.
 */
export async function createAudienceRecord(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  authorDid: string;
  protocol: string;
  rolePath: string;
  contextId: string;
  sealingPublicKey: PublicKeyJwk;
  audienceKey?: AudienceKeyPayload;
  granteeDid?: string;
  permissionGrantId?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  protocolRole?: string;
}): Promise<{
  audienceKey: AudienceKeyPayload;
  message: DataEncodedRecordsWriteMessage;
  payload: EncryptionControlAudiencePayload;
}> {
  const audienceKey = params.audienceKey ?? await generateAudienceKey({
    contextId : params.contextId,
    protocol  : params.protocol,
    rolePath  : params.rolePath,
  });
  const { keyMaterial } = audienceKey;
  const { keyId, privateKeyJwk, publicKeyJwk } = keyMaterial;
  const sealedPrivateKey = await sealAudiencePrivateKey({
    audienceKeyId    : keyId,
    contextId        : params.contextId,
    privateKeyJwk,
    protocol         : params.protocol,
    rolePath         : params.rolePath,
    sealingPublicKey : params.sealingPublicKey,
  });
  const payload: EncryptionControlAudiencePayload = {
    protocol  : params.protocol,
    rolePath  : params.rolePath,
    contextId : params.contextId,
    keyId,
    publicKeyJwk,
    sealedPrivateKey,
  };
  const payloadBytes = Encoder.objectToBytes(payload);

  const { reply, message } = await params.agent.processDwnRequest({
    author        : params.authorDid,
    granteeDid    : params.granteeDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsWrite,
    messageParams : {
      delegatedGrant    : params.delegatedGrant,
      permissionGrantId : params.permissionGrantId,
      protocol          : params.protocol,
      protocolPath      : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      protocolRole      : params.protocolRole,
      schema            : ENCRYPTION_CONTROL_AUDIENCE_SCHEMA_URI,
      dataFormat        : 'application/json',
      dataSize          : payloadBytes.length,
      tags              : {
        protocol  : params.protocol,
        rolePath  : params.rolePath,
        contextId : params.contextId,
        keyId,
      },
    },
    dataStream: DataStream.fromBytes(payloadBytes),
  });

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`AgentDwnApi: Failed to create audience record: ${reply.status.detail}`);
  }

  return {
    audienceKey,
    message: {
      ...message!,
      encodedData: Encoder.bytesToBase64Url(payloadBytes),
    } as DataEncodedRecordsWriteMessage,
    payload,
  };
}

/**
 * Generates fresh random role-audience key material for one source-protocol audience tuple.
 */
export async function generateAudienceKey(params: {
  protocol: string;
  rolePath: string;
  contextId: string;
}): Promise<AudienceKeyPayload> {
  const privateKeyJwk = await X25519.generateKey() as PrivateKeyJwk;
  const publicKeyJwk = await X25519.getPublicKey({ key: privateKeyJwk }) as PublicKeyJwk;
  const keyId = await Encryption.getKeyId(publicKeyJwk);
  const keyMaterial: RoleAudienceKeyMaterial = {
    algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
    derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
    keyId,
    privateKeyJwk,
    publicKeyJwk,
  };

  return {
    protocol  : params.protocol,
    rolePath  : params.rolePath,
    contextId : params.contextId,
    keyId,
    keyMaterial,
  };
}

/**
 * Writes a durable encrypted delivery record that wraps audience private key material to one recipient.
 */
export async function createAudienceDeliveryRecord(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  authorDid: string;
  recipientDid: string;
  recipientRolePublicKey: PublicKeyJwk;
  audienceKey: AudienceKeyPayload;
  recipientAuthority: EncryptionControlDeliveryRecipientAuthority;
  granteeDid?: string;
  permissionGrantId?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  protocolRole?: string;
}): Promise<DataEncodedRecordsWriteMessage> {
  const payload: EncryptionControlDeliveryPayload = {
    protocol    : params.audienceKey.protocol,
    rolePath    : params.audienceKey.rolePath,
    contextId   : params.audienceKey.contextId,
    keyId       : params.audienceKey.keyId,
    keyMaterial : params.audienceKey.keyMaterial,
  };
  const payloadBytes = Encoder.objectToBytes(payload);
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
    granteeDid    : params.granteeDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsWrite,
    messageParams : {
      delegatedGrant    : params.delegatedGrant,
      permissionGrantId : params.permissionGrantId,
      recipient         : params.recipientDid,
      protocol          : params.audienceKey.protocol,
      protocolPath      : ENCRYPTION_CONTROL_DELIVERY_PATH,
      protocolRole      : params.protocolRole,
      schema            : ENCRYPTION_CONTROL_DELIVERY_SCHEMA_URI,
      dataFormat        : 'application/json',
      dataCid,
      dataSize,
      encryptionInput,
      tags              : {
        protocol           : params.audienceKey.protocol,
        rolePath           : params.audienceKey.rolePath,
        contextId          : params.audienceKey.contextId,
        keyId              : params.audienceKey.keyId,
        recipientAuthority : params.recipientAuthority,
      },
    },
    dataStream: DataStream.fromBytes(encryptedBytes),
  });

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`AgentDwnApi: Failed to create audience delivery record: ${reply.status.detail}`);
  }

  return {
    ...message!,
    encodedData: Encoder.bytesToBase64Url(encryptedBytes),
  } as DataEncodedRecordsWriteMessage;
}

/**
 * Opens an audience seal and verifies the recovered private key against the audience record payload.
 */
export async function unsealAudienceKey(params: {
  payload: EncryptionControlAudiencePayload;
  sealingPrivateKey: PrivateKeyJwk;
}): Promise<RoleAudienceKeyMaterial> {
  const privateKeyBytes = await unwrapAudienceSeal({
    audienceKeyId     : params.payload.keyId,
    contextId         : params.payload.contextId,
    protocol          : params.payload.protocol,
    rolePath          : params.payload.rolePath,
    seal              : params.payload.sealedPrivateKey,
    sealingPrivateKey : params.sealingPrivateKey,
  });
  const privateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes }) as PrivateKeyJwk;
  const keyMaterial: RoleAudienceKeyMaterial = {
    algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
    derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
    keyId            : params.payload.keyId,
    privateKeyJwk,
    publicKeyJwk     : params.payload.publicKeyJwk,
  };

  await verifyAudienceKeyMaterial({
    keyMaterial,
    payload: {
      contextId : params.payload.contextId,
      keyId     : params.payload.keyId,
      protocol  : params.payload.protocol,
      rolePath  : params.payload.rolePath,
    },
    publicKeyJwk: params.payload.publicKeyJwk,
  });

  return keyMaterial;
}

/**
 * Verifies that delivered or unsealed audience key material matches the accepted audience record.
 */
export async function verifyAudienceKeyMaterial(params: {
  keyMaterial: RoleAudienceKeyMaterial;
  payload: {
    protocol: string;
    rolePath: string;
    contextId: string;
    keyId: string;
  };
  publicKeyJwk: PublicKeyJwk;
}): Promise<void> {
  const publicKeyId = await Encryption.getKeyId(params.keyMaterial.publicKeyJwk);
  const publicKeyFromPrivate = await X25519.getPublicKey({ key: params.keyMaterial.privateKeyJwk }) as PublicKeyJwk;
  const privateKeyId = await Encryption.getKeyId(publicKeyFromPrivate);

  if (params.keyMaterial.algorithm !== KeyAgreementAlgorithm.X25519HkdfSha256A256Kw ||
      params.keyMaterial.derivationScheme !== ROLE_AUDIENCE_DERIVATION_SCHEME ||
      params.keyMaterial.keyId !== params.payload.keyId ||
      params.keyMaterial.keyId !== publicKeyId ||
      params.keyMaterial.keyId !== privateKeyId ||
      !isPublicKeyJwkEqual(params.keyMaterial.publicKeyJwk, params.publicKeyJwk) ||
      !isPublicKeyJwkEqual(publicKeyFromPrivate, params.publicKeyJwk)) {
    throw new Error('audience key material does not match the audience record.');
  }
}

async function sealAudiencePrivateKey(params: {
  audienceKeyId: string;
  contextId: string;
  privateKeyJwk: PrivateKeyJwk;
  protocol: string;
  rolePath: string;
  sealingPublicKey: PublicKeyJwk;
}): Promise<EncryptionControlSeal> {
  return Encryption.wrapSeal({
    privateKeyBytes : await X25519.privateKeyToBytes({ privateKey: params.privateKeyJwk }),
    keyInput        : {
      algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
      audienceKeyId    : params.audienceKeyId,
      contextId        : params.contextId,
      derivationScheme : SEAL_DERIVATION_SCHEME,
      keyId            : await Encryption.getKeyId(params.sealingPublicKey),
      protocol         : params.protocol,
      publicKey        : params.sealingPublicKey,
      rolePath         : params.rolePath,
    },
  });
}

async function unwrapAudienceSeal(params: {
  audienceKeyId: string;
  contextId: string;
  protocol: string;
  rolePath: string;
  seal: EncryptionControlSeal;
  sealingPrivateKey: PrivateKeyJwk;
}): Promise<Uint8Array> {
  return Encryption.unwrapSeal({
    audienceKeyId       : params.audienceKeyId,
    contextId           : params.contextId,
    protocol            : params.protocol,
    recipientPrivateKey : params.sealingPrivateKey,
    rolePath            : params.rolePath,
    seal                : params.seal,
  });
}

/**
 * Attempts to resolve a delegate's decryption key from the scope-aware cache: first
 * a covering key already cached, then — if the cache supports writes — freshly
 * hydrated grant-key records merged into the cache and re-checked. Returns
 * `undefined` when no covering key is found by either path (the caller falls back
 * to role-audience delivery).
 */
async function resolveCachedDelegateDecryptionKey(params: {
  agent: EnboxPlatformAgent;
  targetDid: string;
  granteeDid: string;
  protocol: string;
  protocolPath: string | undefined;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<KeyDecrypter | undefined> {
  const { agent, targetDid, granteeDid, protocol, protocolPath, delegateDecryptionKeyCache } = params;
  const cacheKey = `ddk~${granteeDid}`;
  const cachedKey = findCoveringDelegateKey(delegateDecryptionKeyCache?.get(cacheKey), targetDid, protocol, protocolPath);
  if (cachedKey !== undefined) {
    return buildProtocolPathSubtreeDecrypter(cachedKey.derivedPrivateKey);
  }

  if (delegateDecryptionKeyCache?.set === undefined) {
    return undefined;
  }

  const hydratedKeys = await resolveGrantKeyRecords({
    agent,
    grantorDid: targetDid,
    granteeDid,
    protocol,
    protocolPath,
  });

  if (hydratedKeys.length === 0) {
    return undefined;
  }

  const mergedKeys = mergeDelegateDecryptionKeys(
    delegateDecryptionKeyCache.get(cacheKey) ?? [],
    hydratedKeys,
  );
  delegateDecryptionKeyCache.set(cacheKey, mergedKeys);

  const hydratedKey = findCoveringDelegateKey(mergedKeys, targetDid, protocol, protocolPath);
  return hydratedKey !== undefined ? buildProtocolPathSubtreeDecrypter(hydratedKey.derivedPrivateKey) : undefined;
}

/**
 * Resolves the appropriate KeyDecrypter for a record's encryption scheme.
 *
 * Owners derive protocol-path keys directly from KMS. Delegates use delivered
 * protocol-wide or path-subtree decryption keys when available.
 *
 * @param params - Decryption resolution inputs.
 */
export async function resolveKeyDecrypter(params: ResolveKeyDecrypterParams): Promise<KeyDecrypter> {
  const {
    agent,
    audienceDecryptionKeyCache,
    authorDid,
    delegatedGrant,
    delegateDecryptionKeyCache,
    granteeDid,
    recordsWrite,
    targetDid,
  } = params;

  if (granteeDid !== undefined) {
    const protocol = recordsWrite.descriptor.protocol;
    const protocolPath = recordsWrite.descriptor.protocolPath;
    if (protocol && targetDid !== undefined) {
      const cachedDecrypter = await resolveCachedDelegateDecryptionKey({
        agent,
        targetDid,
        granteeDid,
        protocol,
        protocolPath,
        delegateDecryptionKeyCache,
      });
      if (cachedDecrypter !== undefined) {
        return cachedDecrypter;
      }
    }

    const audienceDecrypter = await resolveRoleAudienceDecrypter({
      agent,
      sourceDid    : targetDid,
      recipientDid : authorDid,
      granteeDid,
      delegatedGrant,
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
      delegatedGrant,
      recordsWrite,
      audienceDecryptionKeyCache,
    });
    if (audienceDecrypter !== undefined) {
      return audienceDecrypter;
    }
  }

  return getKeyDecrypter(agent, authorDid);
}

/** Bundled `resolveKeyDecrypter` inputs shared by every entry decrypted within one `maybeDecryptReply` call. */
type RecordDecryptionContext = {
  agent: EnboxPlatformAgent;
  authorDid: string;
  targetDid: string;
  granteeDid: string | undefined;
  delegatedGrant: DataEncodedRecordsWriteMessage | undefined;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
};

/**
 * Auto-decrypts a `RecordsRead` reply's data in place, when the entry is
 * encrypted, carries data, and is not itself an encryption-control record.
 *
 * @throws Error wrapping the underlying decryption failure with the record ID.
 */
async function decryptRecordsReadReply(
  readReply: RecordsReadReply,
  context: RecordDecryptionContext,
): Promise<void> {
  const { agent, authorDid, targetDid, granteeDid, delegatedGrant, delegateDecryptionKeyCache, audienceDecryptionKeyCache } = context;

  if (readReply.status.code !== 200
      || !readReply.entry?.recordsWrite?.encryption
      || !readReply.entry?.data
      || isEncryptionControlPath(readReply.entry.recordsWrite.descriptor.protocolPath)) {
    return;
  }

  const keyDecrypter = await resolveKeyDecrypter({
    agent,
    audienceDecryptionKeyCache,
    authorDid,
    delegatedGrant,
    delegateDecryptionKeyCache,
    granteeDid,
    recordsWrite: readReply.entry.recordsWrite,
    targetDid,
  });

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

/**
 * Auto-decrypts one `RecordsQuery` reply entry's `encodedData` in place, when the
 * entry is encrypted, carries `encodedData`, and is not itself an
 * encryption-control record.
 *
 * @throws Error wrapping the underlying decryption failure with the record ID.
 */
async function decryptRecordsQueryEntry(
  entry: RecordsQueryReplyEntry,
  context: RecordDecryptionContext,
): Promise<void> {
  const { agent, authorDid, targetDid, granteeDid, delegatedGrant, delegateDecryptionKeyCache, audienceDecryptionKeyCache } = context;

  if (!entry.encryption || !entry.encodedData || isEncryptionControlPath(entry.descriptor.protocolPath)) {
    return;
  }

  const keyDecrypter = await resolveKeyDecrypter({
    agent,
    audienceDecryptionKeyCache,
    authorDid,
    delegatedGrant,
    delegateDecryptionKeyCache,
    granteeDid,
    recordsWrite: entry as RecordsWriteMessage,
    targetDid,
  });

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

/** Auto-decrypts every eligible entry of a `RecordsQuery` reply (small records inline as `encodedData`), in place. */
async function decryptRecordsQueryReply(
  queryReply: RecordsQueryReply,
  context: RecordDecryptionContext,
): Promise<void> {
  if (queryReply.status.code !== 200 || !queryReply.entries) {
    return;
  }

  for (const entry of queryReply.entries) {
    await decryptRecordsQueryEntry(entry, context);
  }
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
  const context: RecordDecryptionContext = {
    agent,
    authorDid      : encryptedRequest.author,
    targetDid      : encryptedRequest.target,
    granteeDid     : encryptedRequest.granteeDid,
    delegatedGrant : getDelegatedGrantFromRequest(encryptedRequest),
    delegateDecryptionKeyCache,
    audienceDecryptionKeyCache,
  };

  // Auto-decrypt RecordsRead replies
  if (isDwnRequest(encryptedRequest as ProcessDwnRequest<DwnInterface>, DwnInterface.RecordsRead)) {
    await decryptRecordsReadReply(reply as RecordsReadReply, context);
  }

  // Auto-decrypt RecordsQuery replies (small records inline as encodedData)
  if (isDwnRequest(encryptedRequest as ProcessDwnRequest<DwnInterface>, DwnInterface.RecordsQuery)) {
    await decryptRecordsQueryReply(reply as RecordsQueryReply, context);
  }
}

function getDelegatedGrantFromRequest<T extends DwnInterface>(
  request: ProcessDwnRequest<T>,
): DataEncodedRecordsWriteMessage | undefined {
  const messageParams = request.messageParams as { delegatedGrant?: DataEncodedRecordsWriteMessage } | undefined;
  return messageParams?.delegatedGrant;
}

async function resolveRoleAudienceDecrypter(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string | undefined;
  recipientDid: string;
  recordsWrite: RecordsWriteMessage;
  granteeDid?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
}): Promise<KeyDecrypter | undefined> {
  if (params.sourceDid === undefined || params.recordsWrite.encryption === undefined) {
    return undefined;
  }

  const roleAudienceEntries = params.recordsWrite.encryption.keyEncryption.filter((entry): entry is typeof entry & {
    derivationScheme: typeof ROLE_AUDIENCE_DERIVATION_SCHEME;
    protocol: string;
    rolePath: string;
  } => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME && 'rolePath' in entry);

  for (const entry of roleAudienceEntries) {
    const contextId = getRoleAudienceContextId(entry.rolePath, params.recordsWrite.contextId);
    if (contextId === undefined) {
      continue;
    }

    const cachedKey = getAudienceKeyFromMemoryCache({
      audienceDecryptionKeyCache : params.audienceDecryptionKeyCache,
      sourceDid                  : params.sourceDid,
      recipientDid               : params.recipientDid,
      protocol                   : entry.protocol,
      contextId,
      rolePath                   : entry.rolePath,
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
      delegatedGrant             : params.delegatedGrant,
      delegateDecryptionKeyCache : params.delegateDecryptionKeyCache,
      protocol                   : entry.protocol,
      contextId,
      rolePath                   : entry.rolePath,
      keyId                      : entry.keyId,
    });
    if (hydratedKey !== undefined) {
      putAudienceKeyInMemoryCache({
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

export async function resolveAudienceDecryptionKey(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
  keyId: string;
  granteeDid?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
}): Promise<AudienceDecryptionKeyEntry | undefined> {
  const cached = getAudienceKeyFromMemoryCache(params);
  if (cached !== undefined) {
    return cached;
  }

  const hydrated = await hydrateAudienceKey(params);
  if (hydrated !== undefined) {
    putAudienceKeyInMemoryCache({
      audienceDecryptionKeyCache : params.audienceDecryptionKeyCache,
      entry                      : hydrated,
    });
    return hydrated;
  }

  return undefined;
}

async function hydrateAudienceKey(params: HydrateAudienceKeyParams): Promise<AudienceDecryptionKeyEntry | undefined> {
  const audienceRecord = await fetchAudienceRecord({
    agent     : params.agent,
    authorDid : params.granteeDid ?? params.recipientDid,
    contextId : params.contextId,
    keyId     : params.keyId,
    protocol  : params.protocol,
    rolePath  : params.rolePath,
    sourceDid : params.sourceDid,
  });
  if (audienceRecord === undefined) {
    return undefined;
  }

  const sealedKey = await hydrateAudienceKeyFromSeal(params, audienceRecord);
  if (sealedKey !== undefined) {
    return sealedKey;
  }

  const deliveryReadActor = getAudienceDeliveryReadActor(params);
  const deliveryMessages = await queryAudienceDeliveryMessages(params, deliveryReadActor);
  if (deliveryMessages.length === 0) {
    return undefined;
  }

  const deliveryDecrypters = await buildAudienceDeliveryDecrypters({
    agent                      : params.agent,
    recipientDid               : params.recipientDid,
    granteeDid                 : params.granteeDid,
    delegateDecryptionKeyCache : params.delegateDecryptionKeyCache,
    protocol                   : params.protocol,
    rolePath                   : params.rolePath,
  });
  if (deliveryDecrypters.length === 0) {
    return undefined;
  }

  return hydrateAudienceKeyFromDeliveries({
    audienceRecord,
    deliveryDecrypters,
    deliveryMessages,
    deliveryReadActor,
    params,
  });
}

async function hydrateAudienceKeyFromSeal(
  params: HydrateAudienceKeyParams,
  audienceRecord: AudienceRecordCandidate,
): Promise<AudienceDecryptionKeyEntry | undefined> {
  try {
    return await tryUnsealAudienceKey({
      ...params,
      audiencePayload: audienceRecord.payload,
    });
  } catch (error) {
    logger.log(
      `AgentDwnApi: skipped audience seal '${audienceRecord.message.recordId}' while resolving role-audience key: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  return undefined;
}

/**
 * Queries the source tenant for `$encryption/delivery` records that wrap ONE
 * exact audience tuple (protocol, rolePath, contextId, keyId) to `recipientDid`.
 * Matching on the audience `keyId` is what distinguishes a delivery of the
 * CURRENT audience key from a stale delivery of a superseded one.
 *
 * Visibility caveat: the DWN filters delivery records for non-tenant actors — a
 * delegate querying its grantor's tenant can never see a third-party
 * collaborator's delivery, so an empty result under a delegate actor is
 * structural, not evidence of non-delivery.
 */
export async function queryAudienceDeliveryMessages(
  params: {
    agent: EnboxPlatformAgent;
    sourceDid: string;
    recipientDid: string;
    protocol: string;
    rolePath: string;
    contextId: string;
    keyId: string;
  },
  deliveryReadActor: AudienceDeliveryReadActor,
): Promise<EncodedRecordsWriteMessage[]> {
  const { reply } = await processDwnRequestWithRemoteFallback(params.agent, {
    author        : deliveryReadActor.authorDid,
    granteeDid    : deliveryReadActor.granteeDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      delegatedGrant : deliveryReadActor.delegatedGrant,
      filter         : {
        recipient    : params.recipientDid,
        protocol     : params.protocol,
        protocolPath : ENCRYPTION_CONTROL_DELIVERY_PATH,
        tags         : {
          protocol  : params.protocol,
          rolePath  : params.rolePath,
          contextId : params.contextId,
          keyId     : params.keyId,
        },
      },
    },
  }, hasRecordsQueryEntries);

  if (reply.status.code !== 200 || reply.entries === undefined || reply.entries.length === 0) {
    return [];
  }

  return reply.entries as EncodedRecordsWriteMessage[];
}

async function hydrateAudienceKeyFromDeliveries(input: {
  audienceRecord: AudienceRecordCandidate;
  deliveryDecrypters: KeyDecrypter[];
  deliveryMessages: EncodedRecordsWriteMessage[];
  deliveryReadActor: AudienceDeliveryReadActor;
  params: HydrateAudienceKeyParams;
}): Promise<AudienceDecryptionKeyEntry | undefined> {
  for (const deliveryMessage of input.deliveryMessages) {
    const hydrated = await hydrateAudienceKeyFromDelivery({
      audienceRecord     : input.audienceRecord,
      deliveryDecrypters : input.deliveryDecrypters,
      deliveryMessage,
      deliveryReadActor  : input.deliveryReadActor,
      params             : input.params,
    });
    if (hydrated !== undefined) {
      return hydrated;
    }
  }

  return undefined;
}

async function hydrateAudienceKeyFromDelivery(input: {
  audienceRecord: AudienceRecordCandidate;
  deliveryDecrypters: KeyDecrypter[];
  deliveryMessage: EncodedRecordsWriteMessage;
  deliveryReadActor: AudienceDeliveryReadActor;
  params: HydrateAudienceKeyParams;
}): Promise<AudienceDecryptionKeyEntry | undefined> {
  const { audienceRecord, deliveryDecrypters, deliveryMessage, deliveryReadActor, params } = input;
  const encryptedData = await getAudienceDeliveryEncryptedData(
    params.agent, deliveryReadActor, params.sourceDid, deliveryMessage,
  );
  if (encryptedData === undefined) {
    return undefined;
  }

  for (const decrypter of deliveryDecrypters) {
    try {
      return await decryptAudienceDelivery({
        audienceRecord,
        decrypter,
        deliveryMessage,
        deliveryReadActor,
        encryptedData,
        params,
      });
    } catch (error) {
      logger.log(
        `AgentDwnApi: skipped audience delivery '${deliveryMessage.recordId}' while resolving role-audience key: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return undefined;
}

async function decryptAudienceDelivery(input: {
  audienceRecord: AudienceRecordCandidate;
  decrypter: KeyDecrypter;
  deliveryMessage: EncodedRecordsWriteMessage;
  deliveryReadActor: AudienceDeliveryReadActor;
  encryptedData: Uint8Array;
  params: HydrateAudienceKeyParams;
}): Promise<AudienceDecryptionKeyEntry> {
  const { audienceRecord, decrypter, deliveryMessage, encryptedData, params } = input;
  const decryptedStream = await Records.decrypt(
    deliveryMessage,
    decrypter,
    DataStream.fromBytes(encryptedData),
  );
  const payload = Encoder.bytesToObject(await DataStream.toBytes(decryptedStream)) as EncryptionControlDeliveryPayload;
  await verifyAudienceKeyPayload({
    agent             : params.agent,
    audiencePayload   : audienceRecord.payload,
    deliveryMessage,
    deliveryReadActor : input.deliveryReadActor,
    payload,
    sourceDid         : params.sourceDid,
    recipientDid      : params.recipientDid,
    protocol          : params.protocol,
    contextId         : params.contextId,
    rolePath          : params.rolePath,
    keyId             : params.keyId,
  });

  return {
    contextId    : payload.contextId,
    keyMaterial  : payload.keyMaterial,
    protocol     : payload.protocol,
    recipientDid : params.recipientDid,
    rolePath     : payload.rolePath,
    sourceDid    : params.sourceDid,
  };
}

function getAudienceDeliveryReadActor(params: {
  recipientDid: string;
  granteeDid?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
}): AudienceDeliveryReadActor {
  if (params.granteeDid !== undefined &&
      params.granteeDid !== params.recipientDid &&
      params.delegatedGrant !== undefined) {
    return {
      authorDid      : params.recipientDid,
      delegatedGrant : params.delegatedGrant,
      granteeDid     : params.granteeDid,
    };
  }

  return { authorDid: params.granteeDid ?? params.recipientDid };
}

async function getAudienceDeliveryEncryptedData(
  agent: EnboxPlatformAgent,
  actor: AudienceDeliveryReadActor,
  sourceDid: string,
  deliveryMessage: EncodedRecordsWriteMessage,
): Promise<Uint8Array | undefined> {
  return readRecordDataWithRemoteFallback({
    agent,
    authorDid      : actor.authorDid,
    delegatedGrant : actor.delegatedGrant,
    encodedData    : deliveryMessage.encodedData,
    granteeDid     : actor.granteeDid,
    recordId       : deliveryMessage.recordId,
    targetDid      : sourceDid,
  });
}

async function buildAudienceDeliveryDecrypters(params: {
  agent: EnboxPlatformAgent;
  recipientDid: string;
  protocol: string;
  rolePath: string;
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<KeyDecrypter[]> {
  const decrypters: KeyDecrypter[] = [];
  const decrypter = await buildRecipientProtocolPathDecrypter({
    ...params,
    protocolPath: params.rolePath,
  });
  if (decrypter !== undefined) {
    decrypters.push(decrypter);
  }

  return decrypters;
}

/**
 * Returns whether the actor can derive the tenant role-path private key that opens audience seals.
 */
export async function hasAudienceSealCoverage(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  protocol: string;
  rolePath: string;
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<boolean> {
  try {
    const sealingPrivateKey = await getRecipientProtocolPathPrivateKey({
      agent                      : params.agent,
      delegateDecryptionKeyCache : params.delegateDecryptionKeyCache,
      derivationPath             : getScopeDerivationPath(params.protocol, params.rolePath),
      granteeDid                 : params.granteeDid,
      protocol                   : params.protocol,
      protocolPath               : params.rolePath,
      recipientDid               : params.sourceDid,
    });
    return sealingPrivateKey !== undefined;
  } catch {
    return false;
  }
}

async function buildRecipientProtocolPathDecrypter(params: {
  agent: EnboxPlatformAgent;
  recipientDid: string;
  protocol: string;
  protocolPath: string;
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<KeyDecrypter | undefined> {
  const derivationPath = getScopeDerivationPath(params.protocol, params.protocolPath);
  const privateKeyJwk = await getRecipientProtocolPathPrivateKey({
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

async function getRecipientProtocolPathPrivateKey(params: {
  agent: EnboxPlatformAgent;
  recipientDid: string;
  protocol: string;
  protocolPath: string;
  derivationPath: string[];
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<PrivateKeyJwk | undefined> {
  if (params.granteeDid === undefined || params.recipientDid === params.granteeDid) {
    const { keyUri } = await getEncryptionKeyInfo(params.agent, params.recipientDid);
    const privateKeyBytes = await params.agent.keyManager.derivePrivateKeyBytes({
      keyUri,
      derivationPath: params.derivationPath,
    });
    return X25519.bytesToPrivateKey({ privateKeyBytes }) as Promise<PrivateKeyJwk>;
  }

  const cacheKey = `ddk~${params.granteeDid}`;
  let delegateKeys = params.delegateDecryptionKeyCache?.get(cacheKey) ?? [];
  let coveringKey = findCoveringDelegateKey(delegateKeys, params.recipientDid, params.protocol, params.protocolPath);

  if (coveringKey === undefined && params.delegateDecryptionKeyCache?.set !== undefined) {
    const hydratedKeys = await resolveGrantKeyRecords({
      agent        : params.agent,
      grantorDid   : params.recipientDid,
      granteeDid   : params.granteeDid,
      protocol     : params.protocol,
      protocolPath : params.protocolPath,
    });
    delegateKeys = mergeDelegateDecryptionKeys(delegateKeys, hydratedKeys);
    params.delegateDecryptionKeyCache.set(cacheKey, delegateKeys);
    coveringKey = findCoveringDelegateKey(delegateKeys, params.recipientDid, params.protocol, params.protocolPath);
  }

  if (coveringKey === undefined) {
    return undefined;
  }

  const privateKeyBytes = await Records.derivePrivateKey(coveringKey.derivedPrivateKey, params.derivationPath);
  return X25519.bytesToPrivateKey({ privateKeyBytes }) as Promise<PrivateKeyJwk>;
}

async function tryUnsealAudienceKey(params: {
  agent: EnboxPlatformAgent;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  rolePath: string;
  contextId: string;
  keyId: string;
  audiencePayload: EncryptionControlAudiencePayload;
  granteeDid?: string;
  delegateDecryptionKeyCache?: DelegateDecryptionKeyCache;
}): Promise<AudienceDecryptionKeyEntry | undefined> {
  if (params.recipientDid !== params.sourceDid && params.granteeDid === undefined) {
    return undefined;
  }

  const sealingPrivateKey = await getRecipientProtocolPathPrivateKey({
    agent                      : params.agent,
    delegateDecryptionKeyCache : params.delegateDecryptionKeyCache,
    derivationPath             : getScopeDerivationPath(params.protocol, params.rolePath),
    granteeDid                 : params.granteeDid,
    protocol                   : params.protocol,
    protocolPath               : params.rolePath,
    recipientDid               : params.sourceDid,
  });
  if (sealingPrivateKey === undefined) {
    return undefined;
  }

  const keyMaterial = await unsealAudienceKey({
    payload: params.audiencePayload,
    sealingPrivateKey,
  });

  return {
    contextId    : params.contextId,
    keyMaterial,
    protocol     : params.protocol,
    recipientDid : params.recipientDid,
    rolePath     : params.rolePath,
    sourceDid    : params.sourceDid,
  };
}

async function fetchAudienceRecord(params: {
  agent: EnboxPlatformAgent;
  authorDid: string;
  sourceDid: string;
  protocol: string;
  rolePath: string;
  contextId: string;
  keyId: string;
}): Promise<{
  message: RecordsWriteMessage & { encodedData?: string };
  payload: EncryptionControlAudiencePayload;
} | undefined> {
  const { reply } = await processDwnRequestWithRemoteFallback(params.agent, {
    author        : params.authorDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        protocol     : params.protocol,
        protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        tags         : {
          protocol  : params.protocol,
          rolePath  : params.rolePath,
          contextId : params.contextId,
          keyId     : params.keyId,
        },
      },
    },
  }, hasRecordsQueryEntries);

  if (reply.status.code !== 200 || reply.entries === undefined || reply.entries.length === 0) {
    return undefined;
  }

  for (const entry of reply.entries) {
    const audienceMessage = entry as RecordsWriteMessage & { encodedData?: string };
    const dataBytes = await getAudienceRecordData(
      params.agent,
      params.authorDid,
      params.sourceDid,
      audienceMessage,
    );
    if (dataBytes === undefined) {
      continue;
    }

    const payload = Encoder.bytesToObject(dataBytes) as EncryptionControlAudiencePayload;
    if (audiencePayloadMatches(payload, audienceMessage, params)) {
      return { message: audienceMessage, payload };
    }
  }

  return undefined;
}

async function getAudienceRecordData(
  agent: EnboxPlatformAgent,
  authorDid: string,
  sourceDid: string,
  audienceMessage: RecordsWriteMessage & { encodedData?: string },
): Promise<Uint8Array | undefined> {
  return readRecordDataWithRemoteFallback({
    agent,
    authorDid,
    encodedData : audienceMessage.encodedData,
    recordId    : audienceMessage.recordId,
    targetDid   : sourceDid,
  });
}

function audiencePayloadMatches(payload: EncryptionControlAudiencePayload, audienceMessage: RecordsWriteMessage, expected: {
  protocol: string;
  rolePath: string;
  contextId: string;
  keyId: string;
}): boolean {
  const tags = audienceMessage.descriptor.tags ?? {};
  return payload.protocol === expected.protocol &&
    payload.rolePath === expected.rolePath &&
    payload.contextId === expected.contextId &&
    payload.keyId === expected.keyId &&
    payload.protocol === tags.protocol &&
    payload.rolePath === tags.rolePath &&
    payload.contextId === tags.contextId &&
    payload.keyId === tags.keyId &&
    isObject(payload.publicKeyJwk) &&
    isObject(payload.sealedPrivateKey);
}

async function verifyAudienceKeyPayload(params: {
  agent: EnboxPlatformAgent;
  payload: EncryptionControlDeliveryPayload;
  audiencePayload: EncryptionControlAudiencePayload;
  deliveryMessage: RecordsWriteMessage;
  deliveryReadActor: AudienceDeliveryReadActor;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
  keyId: string;
}): Promise<void> {
  const { payload, deliveryMessage } = params;
  const tags = deliveryMessage.descriptor.tags ?? {};

  assertAudienceKeyPayload(payload);
  const keyMaterial = payload.keyMaterial;

  if (deliveryMessage.descriptor.recipient !== params.recipientDid ||
      payload.protocol !== tags.protocol ||
      payload.rolePath !== tags.rolePath ||
      payload.contextId !== tags.contextId ||
      keyMaterial.keyId !== tags.keyId ||
      payload.protocol !== params.protocol ||
      payload.contextId !== params.contextId ||
      payload.rolePath !== params.rolePath ||
      keyMaterial.keyId !== params.keyId) {
    throw new Error('audience delivery payload does not match record tags.');
  }

  await verifyAudienceKeyMaterial({
    keyMaterial,
    payload: {
      contextId : params.contextId,
      keyId     : params.keyId,
      protocol  : params.protocol,
      rolePath  : params.rolePath,
    },
    publicKeyJwk: params.audiencePayload.publicKeyJwk,
  });
  await verifyAudienceKeyRecipientAuthority(params);
}

function assertAudienceKeyPayload(payload: unknown): asserts payload is EncryptionControlDeliveryPayload {
  if (!isObject(payload) ||
      typeof payload.protocol !== 'string' ||
      typeof payload.contextId !== 'string' ||
      typeof payload.rolePath !== 'string' ||
      typeof payload.keyId !== 'string' ||
      !isRoleAudienceKeyMaterial(payload.keyMaterial)) {
    throw new Error('audience delivery payload is malformed.');
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

function isRoleAudienceKeyMaterial(value: unknown): value is RoleAudienceKeyMaterial {
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

async function verifyAudienceKeyRoleAssignment(params: {
  agent: EnboxPlatformAgent;
  deliveryReadActor: AudienceDeliveryReadActor;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
}): Promise<void> {
  const contextIdPrefix = getRoleContextPrefix(params.rolePath, params.contextId);
  if (contextIdPrefix === undefined && params.rolePath.includes('/')) {
    throw new Error('audience delivery recipient is not an active holder of the referenced role.');
  }

  const { reply } = await processDwnRequestWithRemoteFallback(params.agent, {
    author        : params.deliveryReadActor.authorDid,
    granteeDid    : params.deliveryReadActor.granteeDid,
    target        : params.sourceDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      delegatedGrant : params.deliveryReadActor.delegatedGrant,
      filter         : {
        ...(contextIdPrefix === undefined ? {} : { contextId: contextIdPrefix }),
        recipient    : params.recipientDid,
        protocol     : params.protocol,
        protocolPath : params.rolePath,
      },
    },
  }, hasRecordsQueryEntries);

  const entries = reply.status.code === 200 ? reply.entries ?? [] : [];
  const hasRoleRecord = entries.some((entry): boolean => {
    const roleRecord = entry as RecordsWriteMessage;
    return roleRecord.descriptor.recipient === params.recipientDid &&
      roleRecord.descriptor.protocol === params.protocol &&
      roleRecord.descriptor.protocolPath === params.rolePath &&
      matchesContextIdPrefix(roleRecord.contextId, contextIdPrefix);
  });

  if (!hasRoleRecord) {
    throw new Error('audience delivery recipient is not an active holder of the referenced role.');
  }
}

async function verifyAudienceKeyRecipientAuthority(params: {
  agent: EnboxPlatformAgent;
  audiencePayload: EncryptionControlAudiencePayload;
  deliveryReadActor: AudienceDeliveryReadActor;
  deliveryMessage: RecordsWriteMessage;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
}): Promise<void> {
  const tags = params.deliveryMessage.descriptor.tags ?? {};
  const recipientAuthority = tags.recipientAuthority;

  if (recipientAuthority !== EncryptionControlDeliveryRecipientAuthority.RoleHolder) {
    throw new Error('audience delivery recipient authority is invalid.');
  }

  await verifyAudienceKeyRoleAssignment(params);
}

async function processDwnRequestWithRemoteFallback<T extends DwnInterface>(
  agent: EnboxPlatformAgent,
  request: ProcessDwnRequest<T>,
  hasUsableReply: (reply: DwnMessageReply[T]) => boolean,
): Promise<DwnResponse<T>> {
  return processDwnReadThrough({
    process : agent.processDwnRequest.bind(agent),
    send    : agent.sendDwnRequest.bind(agent),
  }, request, hasUsableReply);
}

function hasRecordsQueryEntries(reply: DwnMessageReply[DwnInterface.RecordsQuery]): boolean {
  return reply.status.code === 200 && reply.entries !== undefined && reply.entries.length > 0;
}

function hasRecordsReadData(reply: DwnMessageReply[DwnInterface.RecordsRead]): boolean {
  return reply.status.code === 200 && reply.entry?.data !== undefined;
}

async function readRecordDataWithRemoteFallback(params: {
  agent: EnboxPlatformAgent;
  authorDid: string;
  targetDid: string;
  recordId: string;
  encodedData?: string;
  granteeDid?: string;
  delegatedGrant?: DataEncodedRecordsWriteMessage;
}): Promise<Uint8Array | undefined> {
  if (params.encodedData !== undefined) {
    return Encoder.base64UrlToBytes(params.encodedData);
  }

  const { reply } = await processDwnRequestWithRemoteFallback(params.agent, {
    author        : params.authorDid,
    granteeDid    : params.granteeDid,
    target        : params.targetDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : {
      delegatedGrant : params.delegatedGrant,
      filter         : { recordId: params.recordId },
    },
  }, hasRecordsReadData);

  if (reply.status.code !== 200 || reply.entry?.data === undefined) {
    return undefined;
  }

  return DataStream.toBytes(reply.entry.data);
}

function hasProtocolsQueryDefinition(reply: DwnMessageReply[DwnInterface.ProtocolsQuery]): boolean {
  return reply.status.code === 200 && reply.entries?.[0]?.descriptor.definition !== undefined;
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

function getAudienceKeyFromMemoryCache(params: {
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
  keyId: string;
}): AudienceDecryptionKeyEntry | undefined {
  const cacheKey = getAudienceDecryptionKeyCacheKey(params);
  return params.audienceDecryptionKeyCache?.get(cacheKey);
}

function putAudienceKeyInMemoryCache(params: {
  audienceDecryptionKeyCache?: AudienceDecryptionKeyCache;
  entry: AudienceDecryptionKeyEntry;
}): void {
  const cacheKey = getAudienceDecryptionKeyCacheKey({
    ...params.entry,
    keyId: params.entry.keyMaterial.keyId,
  });
  params.audienceDecryptionKeyCache?.set?.(cacheKey, params.entry);
}

export function getAudienceDecryptionKeyCacheKey(input: {
  sourceDid: string;
  recipientDid: string;
  protocol: string;
  contextId: string;
  rolePath: string;
  keyId: string;
}): string {
  return `audience-key~${Encoder.stringToBase64Url(JSON.stringify([
    input.sourceDid,
    input.recipientDid,
    input.protocol,
    input.contextId,
    input.rolePath,
    input.keyId,
  ]))}`;
}


function isGrantKeyEligibleGrant(grant: PermissionGrant): grant is PermissionGrant & {
  scope: GrantKeyEligibleRecordsScope;
} {
  return isGrantKeyEligibleRecordsScope(grant.scope);
}

async function buildGrantKeyPayloads(
  agent: EnboxPlatformAgent,
  ownerDid: string,
  grant: PermissionGrant & {
    scope: GrantKeyEligibleRecordsScope;
  },
  protocolDefinitions: Map<string, ProtocolDefinition>,
): Promise<GrantKeyPayload[]> {
  const grantScope = grant.scope;
  let scopes: GrantKeyProtocolPathScope[];
  if (grantScope.method === DwnMethodName.Read) {
    const protocolDefinition = grantScope.protocolPath === undefined
      ? undefined
      : await readProtocolDefinition(agent, ownerDid, ownerDid, grantScope.protocol, protocolDefinitions, 'grantKey coverage');
    scopes = getGrantKeyDeliveryScopes(grantScope, protocolDefinition);
  } else {
    const protocolDefinition = await readProtocolDefinition(agent, ownerDid, ownerDid, grantScope.protocol, protocolDefinitions, 'grantKey coverage');
    scopes = getGrantKeyDeliveryScopes(grantScope, protocolDefinition);
  }

  if (scopes.length === 0) {
    return [];
  }

  const { keyUri } = await getEncryptionKeyInfo(agent, ownerDid);
  const payloads: GrantKeyPayload[] = [];
  for (const scope of scopes) {
    payloads.push(await buildGrantKeyPayload(agent, keyUri, grant.id, scope));
  }

  return payloads;
}

async function buildGrantKeyPayload(
  agent: EnboxPlatformAgent,
  keyUri: string,
  grantId: string,
  scope: GrantKeyProtocolPathScope,
): Promise<GrantKeyPayload> {
  const derivationPath = getScopeDerivationPath(scope.protocol, scope.protocolPath);
  const privateKeyBytes = await agent.keyManager.derivePrivateKeyBytes({
    keyUri,
    derivationPath,
  });
  const privateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes }) as PrivateKeyJwk;
  const publicKeyJwk = await X25519.getPublicKey({ key: privateKeyJwk }) as PublicKeyJwk;
  const keyId = await Encryption.getKeyId(publicKeyJwk);

  return {
    grantId,
    scope: {
      scheme   : KeyDerivationScheme.ProtocolPath,
      protocol : scope.protocol,
      ...(scope.protocolPath ? { protocolPath: scope.protocolPath } : {}),
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

async function readProtocolDefinition(
  agent: EnboxPlatformAgent,
  authorDid: string,
  targetDid: string,
  protocol: string,
  protocolDefinitions: Map<string, ProtocolDefinition>,
  purpose: string,
): Promise<ProtocolDefinition> {
  const cachedDefinition = protocolDefinitions.get(protocol);
  if (cachedDefinition !== undefined) {
    return cachedDefinition;
  }

  const { reply } = await processDwnRequestWithRemoteFallback(agent, {
    author        : authorDid,
    target        : targetDid,
    messageType   : DwnInterface.ProtocolsQuery,
    messageParams : { filter: { protocol } },
  }, hasProtocolsQueryDefinition);
  const definition = reply.entries?.[0]?.descriptor.definition;
  if (reply.status.code !== 200 || definition === undefined) {
    throw new Error(`AgentDwnApi: unable to resolve protocol definition '${protocol}' for ${purpose}.`);
  }

  protocolDefinitions.set(protocol, definition);
  return definition;
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
  grantorDid: string,
  protocol: string,
  protocolPath: string | undefined,
): DelegateDecryptionKeyEntry | undefined {
  if (allKeys === undefined) {
    return undefined;
  }

  const keysForProtocol = allKeys.filter((key) => key.grantorDid === grantorDid && key.protocol === protocol);

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
    ? `${key.grantorDid}~${key.protocol}~protocol`
    : `${key.grantorDid}~${key.protocol}~protocolPath~${key.scope.protocolPath}`;
}

type ResolveGrantKeyRecordsParams = {
  agent: EnboxPlatformAgent;
  grantorDid: string;
  granteeDid: string;
  protocol: string;
  protocolPath?: string;
};

type ResolveGrantKeyRecordParams = ResolveGrantKeyRecordsParams & {
  grantKeyMessage: RecordsWriteMessage & { encodedData?: string };
  granteeDecrypter: KeyDecrypter;
  granteeWrappedGrantKeyRecipient: WrappedGrantKeyRecipient;
};

async function resolveGrantKeyRecords(params: ResolveGrantKeyRecordsParams): Promise<DelegateDecryptionKeyEntry[]> {
  const { reply } = await processDwnRequestWithRemoteFallback(params.agent, {
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
  }, hasRecordsQueryEntries);

  if (reply.status.code !== 200 || reply.entries === undefined || reply.entries.length === 0) {
    return [];
  }

  const granteeKeyInfo = await getEncryptionKeyInfo(params.agent, params.granteeDid);
  const granteeWrappedGrantKeyRecipient: WrappedGrantKeyRecipient = {
    keyUri    : granteeKeyInfo.keyUri,
    rootKeyId : await Encryption.getKeyId(granteeKeyInfo.publicKeyJwk),
  };
  const granteeDecrypter = buildKmsDecryptCallback(
    params.agent,
    granteeKeyInfo.keyId,
    granteeKeyInfo.keyUri,
    KeyDerivationScheme.ProtocolPath,
  );
  const resolvedKeys: DelegateDecryptionKeyEntry[] = [];
  const targetMismatches: WrappedGrantKeyTargetMismatchError[] = [];

  for (const entry of reply.entries) {
    const grantKeyMessage = entry as RecordsWriteMessage & { encodedData?: string };
    try {
      const resolvedKey = await resolveGrantKeyRecord({
        ...params,
        grantKeyMessage,
        granteeDecrypter,
        granteeWrappedGrantKeyRecipient,
      });
      if (resolvedKey !== undefined) {
        resolvedKeys.push(resolvedKey);
      }
    } catch (error) {
      collectGrantKeyRecordResolutionError(error, grantKeyMessage, targetMismatches);
    }
  }

  if (resolvedKeys.length === 0 && targetMismatches.length > 0) {
    throw targetMismatches[0];
  }

  return resolvedKeys;
}

async function resolveGrantKeyRecord(params: ResolveGrantKeyRecordParams): Promise<DelegateDecryptionKeyEntry | undefined> {
  const { grantKeyMessage } = params;
  if (Message.getAuthor(grantKeyMessage) !== params.grantorDid) {
    return undefined;
  }

  const encryptedData = await getGrantKeyEncryptedData(params.agent, params.granteeDid, params.grantorDid, grantKeyMessage);
  if (encryptedData === undefined) {
    return undefined;
  }

  const payload = await readGrantKeyPayload(params, encryptedData);
  const grant = await readPermissionGrant(params.agent, params.granteeDid, params.grantorDid, payload.grantId);
  await verifyPermissionGrantActive(params.agent, params.granteeDid, params.grantorDid, grant);

  await verifyGrantKeyPayload({
    agent        : params.agent,
    payload,
    grant,
    grantKeyMessage,
    grantorDid   : params.grantorDid,
    granteeDid   : params.granteeDid,
    protocol     : params.protocol,
    protocolPath : params.protocolPath,
  });

  return buildDelegateDecryptionKeyEntry(params.grantorDid, payload);
}

async function readGrantKeyPayload(
  params: ResolveGrantKeyRecordParams,
  encryptedData: Uint8Array,
): Promise<GrantKeyPayload> {
  return params.grantKeyMessage.encryption === undefined
    ? unwrapGrantKeyPayload(params.agent, params.granteeWrappedGrantKeyRecipient, encryptedData)
    : decryptGrantKeyPayload(params.grantKeyMessage, params.granteeDecrypter, encryptedData);
}

function buildDelegateDecryptionKeyEntry(grantorDid: string, payload: GrantKeyPayload): DelegateDecryptionKeyEntry {
  return {
    grantorDid,
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
  };
}

function collectGrantKeyRecordResolutionError(
  error: unknown,
  grantKeyMessage: RecordsWriteMessage,
  targetMismatches: WrappedGrantKeyTargetMismatchError[],
): void {
  if (error instanceof WrappedGrantKeyTargetMismatchError) {
    targetMismatches.push(error);
  }

  logger.log(
    `AgentDwnApi: skipped grantKey '${grantKeyMessage.recordId}' while resolving delegate decryption key: ` +
    `${error instanceof Error ? error.message : String(error)}`
  );
}

async function decryptGrantKeyPayload(
  grantKeyMessage: RecordsWriteMessage,
  granteeDecrypter: KeyDecrypter,
  encryptedData: Uint8Array,
): Promise<GrantKeyPayload> {
  const decryptedStream = await Records.decrypt(
    grantKeyMessage,
    granteeDecrypter,
    DataStream.fromBytes(encryptedData),
  );
  return Encoder.bytesToObject(await DataStream.toBytes(decryptedStream)) as GrantKeyPayload;
}

async function unwrapGrantKeyPayload(
  agent: EnboxPlatformAgent,
  recipient: WrappedGrantKeyRecipient,
  envelopeBytes: Uint8Array,
): Promise<GrantKeyPayload> {
  const envelope = Encoder.bytesToObject(envelopeBytes);
  assertWrappedGrantKeyEnvelope(envelope);

  if (envelope.keyEncryption.keyId !== recipient.rootKeyId) {
    throw new WrappedGrantKeyTargetMismatchError(envelope.keyEncryption.keyId, recipient.rootKeyId);
  }

  const dataEncryptionKey = await agent.keyManager.unwrapContentKey({
    keyUri             : recipient.keyUri,
    derivationPath     : [],
    encryptedKey       : Encoder.base64UrlToBytes(envelope.keyEncryption.encryptedKey),
    ephemeralPublicKey : envelope.keyEncryption.ephemeralPublicKey,
  });
  const plaintext = await Encryption.decrypt(
    envelope.contentEncryption.algorithm,
    dataEncryptionKey,
    Encoder.base64UrlToBytes(envelope.contentEncryption.initializationVector),
    Encoder.base64UrlToBytes(envelope.ciphertext),
  );

  return Encoder.bytesToObject(plaintext) as GrantKeyPayload;
}

async function getGrantKeyEncryptedData(
  agent: EnboxPlatformAgent,
  granteeDid: string,
  grantorDid: string,
  grantKeyMessage: RecordsWriteMessage & { encodedData?: string },
): Promise<Uint8Array | undefined> {
  return readRecordDataWithRemoteFallback({
    agent,
    authorDid   : granteeDid,
    encodedData : grantKeyMessage.encodedData,
    recordId    : grantKeyMessage.recordId,
    targetDid   : grantorDid,
  });
}

async function readPermissionGrant(
  agent: EnboxPlatformAgent,
  granteeDid: string,
  grantorDid: string,
  grantId: string,
): Promise<PermissionGrant> {
  const { reply } = await processDwnRequestWithRemoteFallback(agent, {
    author        : granteeDid,
    target        : grantorDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId: grantId } },
  }, hasRecordsReadData);

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
  agent: EnboxPlatformAgent;
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
      !await grantScopeCoversPayload(params.agent, params.granteeDid, params.grantorDid, grant, payload)) {
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

async function grantScopeCoversPayload(
  agent: EnboxPlatformAgent,
  requesterDid: string,
  ownerDid: string,
  grant: PermissionGrant,
  payload: GrantKeyPayload,
): Promise<boolean> {
  if (!isGrantKeyEligibleGrant(grant)) {
    return false;
  }

  if (grantKeyScopeCoversDeliveredScope({
    grantScope     : grant.scope,
    deliveredScope : payload.scope,
  })) {
    return true;
  }

  if (payload.scope.protocolPath === undefined) {
    return false;
  }

  const protocolDefinition = await readProtocolDefinition(agent, requesterDid, ownerDid, grant.scope.protocol, new Map(), 'grantKey coverage');
  return grantKeyScopeCoversDeliveredScope({
    grantScope     : grant.scope,
    deliveredScope : payload.scope,
    protocolDefinition,
  });
}

function scopeCoversRecord(scope: GrantKeyProtocolPathScope, protocol: string, protocolPath: string | undefined): boolean {
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
