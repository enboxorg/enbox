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

import type { Web5PlatformAgent } from './types/agent.js';
import type {
  DwnMessageReply,
  ProcessDwnRequest,
  SendDwnRequest,
} from './types/dwn.js';

import { X25519 } from '@enbox/crypto';
import {
  Cid,
  ContentEncryptionAlgorithm,
  DataStream,
  Encoder,
  Encryption,
  KeyDerivationScheme,
  Records,
} from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { isDwnRequest } from './dwn-type-guards.js';

/**
 * Returns the correct nonce/IV byte length for the given content encryption algorithm.
 * A256GCM uses 96-bit (12-byte) nonces; XC20P uses 192-bit (24-byte) nonces.
 */
export function ivLength(algorithm: ContentEncryptionAlgorithm): number {
  return algorithm === ContentEncryptionAlgorithm.XC20P ? 24 : 12;
}

/**
 * Builds a partial EncryptionInput object for a single key-encryption entry.
 * The `authenticationTag` is NOT set here — the caller must set it after
 * AEAD encryption produces the tag.
 */
export function buildEncryptionInput(
  dek: Uint8Array,
  iv: Uint8Array,
  publicKeyId: string,
  publicKey: PublicKeyJwk,
  derivationScheme: typeof KeyDerivationScheme.ProtocolPath | typeof KeyDerivationScheme.ProtocolContext,
): Omit<EncryptionInput, 'authenticationTag'> {
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
 * Encrypts plaintext bytes with AEAD and computes the CID of the resulting ciphertext.
 * Returns everything needed to attach the encrypted data to a DWN message, including
 * the authentication tag.
 */
export async function encryptAndComputeCid(
  plaintextBytes: Uint8Array,
  dek: Uint8Array,
  iv: Uint8Array,
  algorithm: ContentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256GCM,
): Promise<{ encryptedBytes: Uint8Array; dataCid: string; dataSize: number; authenticationTag: Uint8Array }> {
  const { ciphertextStream, tag: authenticationTag } = await Encryption.aeadEncryptStream(
    algorithm, dek, iv, DataStream.fromBytes(plaintextBytes),
  );
  const encryptedBytes = await DataStream.toBytes(ciphertextStream);
  const cidStream = DataStream.fromBytes(encryptedBytes);
  const dataCid = await Cid.computeDagPbCidFromStream(cidStream);
  return { encryptedBytes, dataCid, dataSize: encryptedBytes.length, authenticationTag };
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
  agent: Web5PlatformAgent,
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

  // 4. Verify it's an X25519 key
  const publicKeyJwk = verificationMethod.publicKeyJwk;
  if (publicKeyJwk.crv !== 'X25519') {
    throw new Error(
      `AgentDwnApi: keyAgreement key for '${didUri}' uses curve ` +
      `'${publicKeyJwk.crv}', but DWN encryption requires 'X25519'.`
    );
  }

  // 5. Compute the KMS key URI (does NOT export the key)
  const keyUri = await agent.keyManager.getKeyUri({ key: publicKeyJwk });

  return {
    keyId        : verificationMethod.id,
    keyUri,
    publicKeyJwk : publicKeyJwk as PublicKeyJwk,
  };
}

/**
 * Derives a ProtocolContext public key for a given DID and context ID,
 * then returns a fully-formed EncryptionInput. Consolidates the repeated
 * getEncryptionKeyInfo -> constructKeyDerivationPath -> derivePublicKey
 * -> build EncryptionInput sequence.
 *
 * @param agent - The platform agent
 * @param didUri - The DID URI to derive encryption key for
 * @param contextId - The context ID
 * @param dek - Data encryption key
 * @param iv - Initialization vector
 */
export async function deriveContextEncryptionInput(
  agent: Web5PlatformAgent,
  didUri: string,
  contextId: string,
  dek: Uint8Array,
  iv: Uint8Array,
): Promise<{
  encryptionInput: Omit<EncryptionInput, 'authenticationTag'>;
  keyId: string;
  keyUri: KeyIdentifier;
  contextDerivationPath: string[];
}> {
  const { keyId, keyUri } = await getEncryptionKeyInfo(agent, didUri);
  const contextDerivationPath =
    Records.constructKeyDerivationPathUsingProtocolContextScheme(contextId);
  const contextPublicKey = await agent.keyManager.derivePublicKey({
    keyUri,
    derivationPath: contextDerivationPath,
  });

  const encryptionInput = buildEncryptionInput(
    dek, iv, keyId, contextPublicKey, KeyDerivationScheme.ProtocolContext,
  );

  return { encryptionInput, keyId, keyUri, contextDerivationPath };
}

/**
 * Builds a KMS-backed JWE key unwrap callback. Used for both ProtocolPath
 * and ProtocolContext decryption where the KMS holds the root private key.
 *
 * @param agent - The platform agent with access to the key manager
 * @param keyId - The root key ID
 * @param keyUri - The KMS key URI
 * @param derivationScheme - The key derivation scheme
 */
export function buildKmsDecryptCallback(
  agent: Web5PlatformAgent,
  keyId: string,
  keyUri: KeyIdentifier,
  derivationScheme: typeof KeyDerivationScheme.ProtocolPath | typeof KeyDerivationScheme.ProtocolContext,
): KeyDecrypter {
  const keyManager = agent.keyManager;
  return {
    rootKeyId : keyId,
    derivationScheme,
    decrypt   : async (fullDerivationPath, jwePayload): Promise<Uint8Array> => {
      return keyManager.jweKeyUnwrap({
        keyUri,
        derivationPath     : fullDerivationPath,
        encryptedKey       : jwePayload.encryptedKey,
        ephemeralPublicKey : jwePayload.ephemeralPublicKey,
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
  agent: Web5PlatformAgent,
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
  agent: Web5PlatformAgent,
  didUri: string,
): Promise<KeyDecrypter> {
  const { keyId, keyUri } = await getEncryptionKeyInfo(agent, didUri);
  return buildKmsDecryptCallback(agent, keyId, keyUri, KeyDerivationScheme.ProtocolPath);
}

/**
 * Builds a KeyDecrypter from a context-derived private key.
 * Uses the raw key directly (since it was shared with us via the key-delivery protocol).
 *
 * @param contextKey - The derived private key for the context
 */
export function buildContextKeyDecrypter(
  contextKey: DerivedPrivateJwk,
): KeyDecrypter {
  return {
    rootKeyId        : contextKey.rootKeyId,
    derivationScheme : contextKey.derivationScheme,
    decrypt          : async (fullDerivationPath, jwePayload): Promise<Uint8Array> => {
      const leafPrivateKeyBytes = await Records.derivePrivateKey(
        contextKey, fullDerivationPath,
      );
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      return Encryption.ecdhEsUnwrapKey(leafPrivateKeyJwk, jwePayload.ephemeralPublicKey, jwePayload.encryptedKey);
    },
  };
}

/**
 * Resolves the appropriate KeyDecrypter for a record's encryption scheme.
 * Handles both single-party (ProtocolPath) and multi-party (ProtocolContext).
 *
 * For ProtocolContext records:
 *   - Context creator: derives key directly from KMS
 *   - Participant: fetches contextKey via key-delivery protocol, caches it
 *
 * @param agent - The platform agent
 * @param authorDid - The DID of the author attempting to decrypt
 * @param recordsWrite - The records write message containing encryption info
 * @param targetDid - The target DID (DWN owner), if known
 * @param contextDerivedKeyCache - Cache for context-derived private keys
 * @param fetchContextKeyRecordFn - Function to fetch context key records from key-delivery protocol
 */
export async function resolveKeyDecrypter(
  agent: Web5PlatformAgent,
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
): Promise<KeyDecrypter> {
  const { encryption } = recordsWrite;

  // Check if the record uses context-derived encryption
  const hasContextKey = encryption?.recipients.some(
    (r: { header: { derivationScheme: string } }) => r.header.derivationScheme === KeyDerivationScheme.ProtocolContext
  );

  if (!hasContextKey || !recordsWrite.contextId) {
    // Single-party protocol-path encryption
    return getKeyDecrypter(agent, authorDid);
  }

  // --- Multi-party context encryption ---
  const contextKeyEntry = encryption!.recipients.find(
    (r: { header: { derivationScheme: string } }) => r.header.derivationScheme === KeyDerivationScheme.ProtocolContext
  )!;

  const rootContextId = recordsWrite.contextId.split('/')[0];

  // Case 1: I am the context creator — rootKeyId matches my encryption key
  const { keyId, keyUri } = await getEncryptionKeyInfo(agent, authorDid);
  if (contextKeyEntry.header.kid === keyId) {
    return buildKmsDecryptCallback(agent, keyId, keyUri, KeyDerivationScheme.ProtocolContext);
  }

  // Case 2: I am a participant — fetch my context key from the key-delivery protocol
  const cacheKey = `ctx~${authorDid}~${rootContextId}`;
  const cached = contextDerivedKeyCache.get(cacheKey);
  if (cached) {
    return buildContextKeyDecrypter(cached);
  }

  // Fetch context key via the key-delivery protocol — local first, then remote
  const protocol = recordsWrite.descriptor.protocol!;

  // Try local: I may be the DWN owner with a contextKey addressed to myself
  let contextDerivedPrivateKey = await fetchContextKeyRecordFn({
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
    const { Jws } = await import('@enbox/dwn-sdk-js');
    const contextOwnerDid = targetDid ?? Jws.getSignerDid(
      recordsWrite.authorization.signature.signatures[0]
    );
    contextDerivedPrivateKey = await fetchContextKeyRecordFn({
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

  contextDerivedKeyCache.set(cacheKey, contextDerivedPrivateKey);
  return buildContextKeyDecrypter(contextDerivedPrivateKey);
}

/**
 * Post-processes a DWN reply, auto-decrypting data if encryption is enabled.
 * Delegates to the SDK's Records.decrypt() with the appropriate KeyDecrypter —
 * resolveKeyDecrypter() selects between ProtocolPath and ProtocolContext schemes.
 *
 * @param request - The original DWN request
 * @param reply - The DWN reply to process
 * @param agent - The platform agent
 * @param contextDerivedKeyCache - Cache for context-derived private keys
 * @param fetchContextKeyRecordFn - Function to fetch context key records
 */
export async function maybeDecryptReply<T extends DwnInterface>(
  request: ProcessDwnRequest<T> | SendDwnRequest<T>,
  reply: DwnMessageReply[T],
  agent: Web5PlatformAgent,
  contextDerivedKeyCache: { get(key: string): DerivedPrivateJwk | undefined; set(key: string, value: DerivedPrivateJwk): void },
  fetchContextKeyRecordFn: (params: {
    ownerDid: string;
    requesterDid: string;
    sourceProtocol: string;
    sourceContextId: string;
  }) => Promise<DerivedPrivateJwk | undefined>,
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
      const keyDecrypter = await resolveKeyDecrypter(
        agent, request.author, readReply.entry.recordsWrite, request.target,
        contextDerivedKeyCache, fetchContextKeyRecordFn,
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
          const keyDecrypter = await resolveKeyDecrypter(
            agent, request.author, entry as RecordsWriteMessage, request.target,
            contextDerivedKeyCache, fetchContextKeyRecordFn,
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
