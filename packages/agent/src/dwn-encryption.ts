import type {
  DerivedPrivateJwk,
  EncryptionInput,
  EncryptionKeyDeriver,
  KeyDecrypter,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';
import type { KeyIdentifier, PublicKeyJwk } from '@enbox/crypto';

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
  Encoder,
  Encryption,
  KeyDerivationScheme,
  Records,
} from '@enbox/dwn-sdk-js';
import { Ed25519, X25519 } from '@enbox/crypto';

import { DwnInterface } from './types/dwn.js';
import { isDwnRequest } from './dwn-type-guards.js';

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
 * @param contextKey - The delivered derived private key
 */
export function buildContextKeyDecrypter(
  contextKey: DerivedPrivateJwk,
): KeyDecrypter {
  return {
    rootKeyId        : contextKey.rootKeyId,
    derivationScheme : contextKey.derivationScheme,
    derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
      const leafPrivateKeyBytes = await Records.derivePrivateKey(
        contextKey, fullDerivationPath,
      );
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return await X25519.getPublicKey({ key: leafPrivateKeyJwk }) as PublicKeyJwk;
    },
    decrypt: async (fullDerivationPath, keyUnwrapPayload): Promise<Uint8Array> => {
      const leafPrivateKeyBytes = await Records.derivePrivateKey(
        contextKey, fullDerivationPath,
      );
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return Encryption.unwrapKey(leafPrivateKeyJwk as any, keyUnwrapPayload.keyEncryption);
    },
  };
}

/** Cache entry shape for scope-aware delegate decryption keys. */
export type DelegateDecryptionKeyEntry = {
  protocol: string;
  scope: { kind: 'protocol' } | { kind: 'protocolPath'; protocolPath: string; match: 'exact' };
  derivedPrivateKey: DerivedPrivateJwk;
};

/**
 * Builds a KeyDecrypter for an exact-path delegate key that enforces the
 * record's full derivation path matches the key's path exactly — siblings
 * and descendants are NOT accessible.
 */
export function buildExactProtocolPathDecrypter(
  key: DerivedPrivateJwk,
): KeyDecrypter {
  return {
    rootKeyId        : key.rootKeyId,
    derivationScheme : key.derivationScheme,
    derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
      const leafPrivateKeyBytes = await Records.derivePrivateKey(key, fullDerivationPath);
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return await X25519.getPublicKey({ key: leafPrivateKeyJwk }) as PublicKeyJwk;
    },
    decrypt: async (
      fullDerivationPath: string[],
      keyUnwrapPayload,
    ): Promise<Uint8Array> => {
      const keyPath = key.derivationPath ?? [];
      if (keyPath.length !== fullDerivationPath.length ||
          !keyPath.every((seg: string, i: number) => seg === fullDerivationPath[i])) {
        throw new Error(
          'Delegate decryption key is out of scope for this protocol path. ' +
          `Key path: [${keyPath.join(', ')}], ` +
          `record path: [${fullDerivationPath.join(', ')}].`
        );
      }
      const leafPrivateKeyBytes = await Records.derivePrivateKey(key, fullDerivationPath);
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return Encryption.unwrapKey(leafPrivateKeyJwk as any, keyUnwrapPayload.keyEncryption);
    },
  };
}

/**
 * Resolves the appropriate KeyDecrypter for a record's encryption scheme.
 *
 * Owners derive protocol-path keys directly from KMS. Delegates use delivered
 * protocol-wide or exact-path decryption keys when available.
 *
 * @param agent - The platform agent
 * @param authorDid - The DID of the author attempting to decrypt
 * @param recordsWrite - The records write message containing encryption info
 * @param targetDid - The target DID (DWN owner), if known
 * @param contextDerivedKeyCache - Legacy compatibility cache, ignored
 * @param fetchContextKeyRecordFn - Legacy compatibility fetcher, ignored
 * @param delegateDecryptionKeyCache - Cache for scope-aware delegate decryption keys
 * @param granteeDid - The delegate DID (if this is a delegated request)
 */
export async function resolveKeyDecrypter(
  agent: EnboxPlatformAgent,
  authorDid: string,
  recordsWrite: RecordsWriteMessage,
  targetDid: string | undefined,
  contextDerivedKeyCache: { get(key: string): DerivedPrivateJwk | undefined; set(key: string, value: DerivedPrivateJwk): void },
  fetchContextKeyRecordFn: (params: {
    ownerDid: string;
    requesterDid: string;
    sourceProtocol: string;
    sourceContextId: string;
  }) => Promise<DerivedPrivateJwk | undefined>,
  delegateDecryptionKeyCache?: { get(key: string): DelegateDecryptionKeyEntry[] | undefined },
  granteeDid?: string,
  delegateContextKeyCache?: { get(key: string): DerivedPrivateJwk | undefined; set(key: string, value: DerivedPrivateJwk): void },
): Promise<KeyDecrypter> {
  void targetDid;
  void contextDerivedKeyCache;
  void fetchContextKeyRecordFn;
  void delegateContextKeyCache;

  if (granteeDid !== undefined) {
    const protocol = recordsWrite.descriptor.protocol;
    const protocolPath = recordsWrite.descriptor.protocolPath;
    if (protocol) {
      const cacheKey = `ddk~${granteeDid}`;
      const allKeys = delegateDecryptionKeyCache?.get(cacheKey);
      if (allKeys) {
        const keysForProtocol = allKeys.filter((key) => key.protocol === protocol);

        if (protocolPath) {
          const exactKey = keysForProtocol.find(
            (key) => key.scope.kind === 'protocolPath' && key.scope.protocolPath === protocolPath
          );
          if (exactKey) {
            return buildExactProtocolPathDecrypter(exactKey.derivedPrivateKey);
          }
        }

        const wideKey = keysForProtocol.find((key) => key.scope.kind === 'protocol');
        if (wideKey) {
          return buildContextKeyDecrypter(wideKey.derivedPrivateKey);
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
 * @param contextDerivedKeyCache - Cache for context-derived private keys
 * @param fetchContextKeyRecordFn - Function to fetch context key records
 * @param delegateDecryptionKeyCache - Cache for scope-aware delegate decryption keys
 */
export async function maybeDecryptReply<T extends DwnInterface>(
  request: ProcessDwnRequest<T> | SendDwnRequest<T>,
  reply: DwnMessageReply[T],
  agent: EnboxPlatformAgent,
  contextDerivedKeyCache: { get(key: string): DerivedPrivateJwk | undefined; set(key: string, value: DerivedPrivateJwk): void },
  fetchContextKeyRecordFn: (params: {
    ownerDid: string;
    requesterDid: string;
    sourceProtocol: string;
    sourceContextId: string;
  }) => Promise<DerivedPrivateJwk | undefined>,
  delegateDecryptionKeyCache?: { get(key: string): DelegateDecryptionKeyEntry[] | undefined },
  delegateContextKeyCache?: { get(key: string): DerivedPrivateJwk | undefined; set(key: string, value: DerivedPrivateJwk): void },
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
        contextDerivedKeyCache, fetchContextKeyRecordFn, delegateDecryptionKeyCache,
        granteeDid, delegateContextKeyCache,
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
            contextDerivedKeyCache, fetchContextKeyRecordFn, delegateDecryptionKeyCache,
            granteeDid, delegateContextKeyCache,
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
