import type {
  AsymmetricKeyConverter,
  Jwk,
  KeyImporterExporter,
  KeyManager,
  KmsExportKeyParams,
  KmsImportKeyParams,
  Signer,
} from '@enbox/crypto';
import type { Packet, TxtData } from '@dnsquery/dns-packet';

import { computeJwkThumbprint, LocalKeyManager } from '@enbox/crypto';

import type { PortableDid } from '../types/portable-did.js';
import type { DidCreateVerificationMethod, DidRegistrationResult } from './did-method.js';
import type {
  DidDocument,
  DidResolutionOptions,
  DidResolutionResult,
  DidVerificationMethod,
} from '../types/did-core.js';

import { BearerDid } from '../bearer-did.js';
import { Did } from '../did.js';
import { DidMethod } from './did-method.js';
import { EMPTY_DID_RESOLUTION_RESULT } from '../types/did-resolution.js';
import { extractDidFragment } from '../utils.js';
import { DidError, DidErrorCode } from '../did-error.js';

// Re-export types from the new modules for backward compatibility.
export * from './did-dht-types.js';

// Re-export standalone functions from extracted modules.
export {
  pkarrGet,
  pkarrPut,
  createBep44PutMessage,
  parseBep44GetMessage,
} from './did-dht-pkarr.js';

export {
  AlgorithmToKeyTypeMap,
  chunkDataIfNeeded,
  createTxtRecord,
  DID_DHT_SPECIFICATION_VERSION,
  DNS_RECORD_TTL,
  fromDnsPacket,
  KeyTypeToDefaultAlgorithmMap,
  parseTxtDataToObject,
  parseTxtDataToString,
  PROPERTY_SEPARATOR,
  toDnsPacket,
  VALUE_SEPARATOR,
} from './did-dht-dns.js';

export {
  identifierToIdentityKey,
  identifierToIdentityKeyBytes,
  identityKeyToIdentifier,
  keyConverter,
  validatePreviousDidProof,
} from './did-dht-utils.js';

// Import from extracted modules for use within this file.
import type { Bep44Message, DidDhtCreateOptions, PreviousDidProof } from './did-dht-types.js';

import {
  createBep44PutMessage,
  parseBep44GetMessage,
  pkarrGet,
  pkarrPut,
} from './did-dht-pkarr.js';

import {
  AlgorithmToKeyTypeMap,
  chunkDataIfNeeded,
  fromDnsPacket,
  parseTxtDataToObject,
  parseTxtDataToString,
  toDnsPacket,
} from './did-dht-dns.js';

import {
  identifierToIdentityKey,
  identifierToIdentityKeyBytes,
  identityKeyToIdentifier,
  keyConverter,
  validatePreviousDidProof,
} from './did-dht-utils.js';

/** The default DID DHT Gateway / Pkarr Relay used when no `gatewayUri` is supplied. */
const FALLBACK_GATEWAY_URI = 'https://enbox-did-dht.fly.dev';

type GlobalProcessEnv = {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

function getProcessEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as GlobalProcessEnv).process?.env;
}

/**
 * Returns the default gateway URI, deferring the `DID_DHT_GATEWAY_URI` env lookup until call
 * time so the env var reflects late mutations (e.g. test setup) rather than the value captured
 * at module load.
 *
 * Setting `DID_DHT_GATEWAY_URI` only changes the default *URI*. It deliberately does NOT widen
 * `allowPrivateGatewayUri`: dev/CI workflows that target a private Pkarr relay must opt in via
 * the separate `DID_DHT_ALLOW_PRIVATE_GATEWAY=1` env var, or by passing
 * `allowPrivateGatewayUri: true` per call.
 */
function getDefaultGatewayUri(): string {
  return getProcessEnv()?.DID_DHT_GATEWAY_URI || FALLBACK_GATEWAY_URI;
}

/**
 * Returns the default value for `allowPrivateGatewayUri` when the caller does not supply one.
 * Dev/CI shells set `DID_DHT_ALLOW_PRIVATE_GATEWAY=1` to opt in to local Pkarr relays without
 * sprinkling `allowPrivateGatewayUri: true` through every call site; production deployments
 * leave it unset so the documented default of `false` applies.
 *
 * This env var is intentionally *separate* from `DID_DHT_GATEWAY_URI` so that simply pointing
 * at a different (possibly private) relay does not silently disable SSRF protection.
 */
function getDefaultAllowPrivateGatewayUri(): boolean {
  return getProcessEnv()?.DID_DHT_ALLOW_PRIVATE_GATEWAY === '1';
}

/**
 * Applies the default gateway URI when none is supplied. The caller's explicit
 * `allowPrivateGatewayUri` (including an explicit `false`) always wins over the env-driven
 * default — this is the contract pinned by the regression tests in `did-dht.test.ts`.
 */
function resolveGatewayUri(gatewayUri: string | undefined, allowPrivateGatewayUri: boolean | undefined): {
  gatewayUri: string;
  allowPrivateGatewayUri: boolean;
} {
  // Use `??` (not `||`) so an explicit `false` from the caller short-circuits the env-default
  // bypass instead of being OR-ed away.
  return {
    gatewayUri             : gatewayUri ?? getDefaultGatewayUri(),
    allowPrivateGatewayUri : allowPrivateGatewayUri ?? getDefaultAllowPrivateGatewayUri(),
  };
}

/**
 * The `DidDht` class provides an implementation of the `did:dht` DID method.
 *
 * Features:
 * - DID Creation: Create new `did:dht` DIDs.
 * - DID Key Management: Instantiate a DID object from an existing verification method keys or
 *                       or a key in a Key Management System (KMS). If supported by the KMS, a DID's
 *                       key can be exported to a portable DID format.
 * - DID Resolution: Resolve a `did:dht` to its corresponding DID Document stored in the DHT network.
 * - Signature Operations: Sign and verify messages using keys associated with a DID.
 *
 * @remarks
 * The `did:dht` method leverages the distributed nature of the Mainline DHT network for
 * decentralized identity management. This method allows DIDs to be resolved without relying on
 * centralized registries or ledgers, enhancing privacy and control for users. The DID Document is
 * stored and retrieved from the DHT network, and the method includes optional mechanisms for
 * discovering DIDs by type.
 *
 * The DID URI in the `did:dht` method includes a method-specific identifier called the Identity Key
 * which corresponds to the DID's entry in the DHT network. The Identity Key required to make
 * changes to the DID Document since Mainline DHT nodes validate the signature of each message
 * before storing the value in the DHT.
 *
 * @see {@link https://did-dht.com | DID DHT Method Specification}
 *
 * @example
 * ```ts
 * // DID Creation
 * const did = await DidDht.create();
 *
 * // DID Creation with a KMS
 * const keyManager = new LocalKeyManager();
 * const did = await DidDht.create({ keyManager });
 *
 * // DID Resolution
 * const resolutionResult = await DidDht.resolve({ did: did.uri });
 *
 * // Signature Operations
 * const signer = await did.getSigner();
 * const signature = await signer.sign({ data: new TextEncoder().encode('Message') });
 * const isValid = await signer.verify({ data: new TextEncoder().encode('Message'), signature });
 *
 * // Import / Export
 *
 * // Export a BearerDid object to the PortableDid format.
 * const portableDid = await did.export();
 *
 * // Reconstruct a BearerDid object from a PortableDid
 * const did = await DidDht.import(portableDid);
 * ```
 */
export class DidDht extends DidMethod {

  /**
   * Name of the DID method, as defined in the DID DHT specification.
   */
  public static readonly methodName = 'dht';

  /**
   * Creates a new DID using the `did:dht` method formed from a newly generated key.
   *
   * @remarks
   * The DID URI is formed by z-base-32 encoding the Identity Key public key and prefixing with
   * `did:dht:`.
   *
   * Notes:
   * - If no `options` are given, by default a new Ed25519 key will be generated which serves as the
   *   Identity Key.
   *
   * @example
   * ```ts
   * // DID Creation
   * const did = await DidDht.create();
   *
   * // DID Creation with a KMS
   * const keyManager = new LocalKeyManager();
   * const did = await DidDht.create({ keyManager });
   * ```
   *
   * @param params - The parameters for the create operation.
   * @param params.keyManager - Optionally specify a Key Management System (KMS) used to generate
   *                            keys and sign data.
   * @param params.options - Optional parameters that can be specified when creating a new DID.
   * @returns A Promise resolving to a {@link BearerDid} object representing the new DID.
   */
  public static async create<TKms extends KeyManager | undefined = undefined>({
    keyManager = new LocalKeyManager(),
    options = {}
  }: {
    keyManager?: TKms;
    options?: DidDhtCreateOptions<TKms>;
  } = {}): Promise<BearerDid> {
    // Before processing the create operation, validate DID-method-specific requirements to prevent
    // keys from being generated unnecessarily.

    // Check 1: Validate that the algorithm for any given verification method is supported by the
    // DID DHT specification.
    if (options.verificationMethods?.some(vm => !(vm.algorithm in AlgorithmToKeyTypeMap))) {
      throw new Error('One or more verification method algorithms are not supported');
    }

    // Check 2: Validate that the ID for any given verification method is unique.
    const methodIds = options.verificationMethods?.filter(vm => 'id' in vm).map(vm => vm.id);
    if (methodIds && methodIds.length !== new Set(methodIds).size) {
      throw new Error('One or more verification method IDs are not unique');
    }

    // Check 3: Validate that the required properties for any given services are present.
    if (options.services?.some(s => !s.id || !s.type || !s.serviceEndpoint)) {
      throw new Error('One or more services are missing required properties');
    }

    // Generate random key material for the Identity Key.
    const identityKeyUri = await keyManager.generateKey({ algorithm: 'Ed25519' });
    const identityKey = await keyManager.getPublicKey({ keyUri: identityKeyUri });

    // Compute the DID URI from the Identity Key.
    const didUri = await DidDhtUtils.identityKeyToIdentifier({ identityKey });

    // Begin constructing the DID Document.
    const document: DidDocument = {
      id: didUri,
      ...options.alsoKnownAs && { alsoKnownAs: options.alsoKnownAs },
      ...options.controllers && { controller: options.controllers }
    };

    // If the given verification methods do not contain an Identity Key, add one.
    const verificationMethodsToAdd = [...options.verificationMethods ?? []];
    if (!verificationMethodsToAdd?.some(vm => vm.id?.split('#').pop() === '0')) {
      // Add the Identity Key to the beginning of the key set.
      verificationMethodsToAdd.unshift({
        algorithm : 'Ed25519' as DidCreateVerificationMethod<TKms>['algorithm'],
        id        : '0',
        purposes  : ['authentication', 'assertionMethod', 'capabilityDelegation', 'capabilityInvocation']
      });
    }

    // Generate random key material for the Identity Key and any additional verification methods.
    // Add verification methods to the DID document.
    for (const verificationMethod of verificationMethodsToAdd) {
      // Generate a random key for the verification method, or if its the Identity Key's
      // verification method (`id` is 0) use the key previously generated.
      const keyUri = (verificationMethod.id?.split('#').pop() === '0')
        ? identityKeyUri
        : await keyManager.generateKey({ algorithm: verificationMethod.algorithm });

      const publicKey = await keyManager.getPublicKey({ keyUri });

      // Use the given ID, the key's ID, or the key's thumbprint as the verification method ID.
      let methodId = verificationMethod.id ?? publicKey.kid ?? await computeJwkThumbprint({ jwk: publicKey });
      methodId = `${didUri}#${extractDidFragment(methodId)}`; // Remove fragment prefix, if any.

      // Initialize the `verificationMethod` array if it does not already exist.
      document.verificationMethod ??= [];

      // Add the verification method to the DID document.
      document.verificationMethod.push({
        id           : methodId,
        type         : 'JsonWebKey',
        controller   : verificationMethod.controller ?? didUri,
        publicKeyJwk : publicKey,
      });

      // Add the verification method to the specified purpose properties of the DID document.
      for (const purpose of verificationMethod.purposes ?? []) {
        // Initialize the purpose property if it does not already exist.
        document[purpose] ??= [];
        // Add the verification method to the purpose property.
        document[purpose].push(methodId);
      }
    }

    // Add services, if any, to the DID document.
    options.services?.forEach(service => {
      document.service ??= [];
      service.id = `${didUri}#${service.id.split('#').pop()}`; // Remove fragment prefix, if any.
      document.service.push(service);
    });

    // Create the BearerDid object, including the registered DID types (if any), and specify that
    // the DID has not yet been published.
    const did = new BearerDid({
      uri      : didUri,
      document,
      metadata : {
        published: false,
        ...options.types && { types: options.types }
      },
      keyManager
    });

    // By default, publish the DID document to a DHT Gateway unless explicitly disabled.
    if (options.publish ?? true) {
      const registrationResult = await DidDht.publish({
        did,
        gatewayUri             : options.gatewayUri,
        allowPrivateGatewayUri : options.allowPrivateGatewayUri,
      });
      did.metadata = registrationResult.didDocumentMetadata;
    }

    return did;
  }

  /**
   * Instantiates a {@link BearerDid} object for the DID DHT method from a given {@link PortableDid}.
   *
   * This method allows for the creation of a `BearerDid` object using a previously created DID's
   * key material, DID document, and metadata.
   *
   * @example
   * ```ts
   * // Export an existing BearerDid to PortableDid format.
   * const portableDid = await did.export();
   * // Reconstruct a BearerDid object from the PortableDid.
   * const did = await DidDht.import({ portableDid });
   * ```
   *
   * @param params - The parameters for the import operation.
   * @param params.portableDid - The PortableDid object to import.
   * @param params.keyManager - Optionally specify an external Key Management System (KMS) used to
   *                            generate keys and sign data. If not given, a new
   *                            {@link LocalKeyManager} instance will be created and
   *                            used.
   * @returns A Promise resolving to a `BearerDid` object representing the DID formed from the
   *          provided PortableDid.
   * @throws An error if the PortableDid document does not contain any verification methods, lacks
   *         an Identity Key, or the Identity Key is unavailable in the key manager.
   */
  public static async import({ portableDid, keyManager = new LocalKeyManager() }: {
    keyManager?: KeyManager & KeyImporterExporter<KmsImportKeyParams, string, KmsExportKeyParams>;
    portableDid: PortableDid;
  }): Promise<BearerDid> {
    // Verify the DID method is supported.
    const parsedDid = Did.parse(portableDid.uri);
    if (parsedDid?.method !== DidDht.methodName) {
      throw new DidError(DidErrorCode.MethodNotSupported, `Method not supported`);
    }

    const did = await BearerDid.import({ portableDid, keyManager });

    // Validate that the given verification methods contain an Identity Key.
    const identityMethod = did.document.verificationMethod?.find(vm => vm.id?.split('#').pop() === '0');
    if (identityMethod?.publicKeyJwk === undefined) {
      throw new DidError(DidErrorCode.InvalidDidDocument, `DID document must contain an Identity Key`);
    }

    const identityKeyUri = await keyManager.getKeyUri({ key: identityMethod.publicKeyJwk });
    await keyManager.getPublicKey({ keyUri: identityKeyUri });

    return did;
  }

  /**
   * Given the W3C DID Document of a `did:dht` DID, return the verification method that will be used
   * for signing messages and credentials. If given, the `methodId` parameter is used to select the
   * verification method. If not given, the Identity Key's verification method with an ID fragment
   * of '#0' is used.
   *
   * @param params - The parameters for the `getSigningMethod` operation.
   * @param params.didDocument - DID Document to get the verification method from.
   * @param params.methodId - ID of the verification method to use for signing.
   * @returns Verification method to use for signing.
   */
  public static async getSigningMethod({ didDocument, methodId = '#0' }: {
    didDocument: DidDocument;
    methodId?: string;
  }): Promise<DidVerificationMethod> {
    // Verify the DID method is supported.
    const parsedDid = Did.parse(didDocument.id);
    if (parsedDid && parsedDid.method !== this.methodName) {
      throw new DidError(DidErrorCode.MethodNotSupported, `Method not supported: ${parsedDid.method}`);
    }

    // Attempt to find a verification method that matches the given method ID, or if not given,
    // find the first verification method intended for signing claims.
    const verificationMethod = didDocument.verificationMethod?.find(
      vm => extractDidFragment(vm.id) === (extractDidFragment(methodId) ?? extractDidFragment(didDocument.assertionMethod?.[0]))
    );

    if (!verificationMethod?.publicKeyJwk) {
      throw new DidError(DidErrorCode.InternalError, 'A verification method intended for signing could not be determined from the DID Document');
    }

    return verificationMethod;
  }

  /**
   * Publishes a DID to the DHT, making it publicly discoverable and resolvable.
   *
   * @param params - The parameters for the `publish` operation.
   * @param params.did - The `BearerDid` object representing the DID to be published.
   * @param params.gatewayUri - Optional. The URI of a DID DHT Gateway or Pkarr Relay.
   * @param params.allowPrivateGatewayUri - Optional. Allow the resulting gateway URI to target a
   *                                        private, loopback, or link-local host. See
   *                                        {@link DidDhtCreateOptions} for guidance on safe usage.
   * @returns A promise that resolves to a {@link DidRegistrationResult} object.
   */
  public static async publish({ did, gatewayUri, allowPrivateGatewayUri }: {
    did: BearerDid;
    gatewayUri?: string;
    allowPrivateGatewayUri?: boolean;
  }): Promise<DidRegistrationResult> {
    const resolved = resolveGatewayUri(gatewayUri, allowPrivateGatewayUri);
    return DidDhtDocument.put({ did, ...resolved });
  }

  /**
   * Resolves a `did:dht` identifier to its corresponding DID document.
   *
   * @param didUri - The DID to be resolved.
   * @param options - Optional parameters for resolving the DID. Unused by this DID method.
   * @returns A Promise resolving to a {@link DidResolutionResult} object.
   */
  public static async resolve(didUri: string, options: DidResolutionOptions = {}): Promise<DidResolutionResult> {
    // To execute the read method operation, use the given gateway URI or a default.
    const { gatewayUri, allowPrivateGatewayUri } = resolveGatewayUri(options.gatewayUri, options.allowPrivateGatewayUri);

    try {
      // Attempt to decode the z-base-32-encoded identifier.
      await DidDhtUtils.identifierToIdentityKey({ didUri });

      // Attempt to retrieve the DID document and metadata from the DHT network.
      const { didDocument, didDocumentMetadata } = await DidDhtDocument.get({
        didUri,
        gatewayUri,
        allowPrivateGatewayUri,
      });

      // If the DID document was retrieved successfully, return it.
      return {
        ...EMPTY_DID_RESOLUTION_RESULT,
        didDocument,
        didDocumentMetadata
      };

    } catch (error: any) {
      // Rethrow any unexpected errors that are not a `DidError`.
      if (!(error instanceof DidError)) {throw new Error(error);}

      // Return a DID Resolution Result with the appropriate error code.
      return {
        ...EMPTY_DID_RESOLUTION_RESULT,
        didResolutionMetadata: {
          error: error.code,
          ...error.message && { errorMessage: error.message }
        }
      };
    }
  }
}

/**
 * The `DidDhtDocument` class provides functionality for interacting with the DID document stored in
 * Mainline DHT in support of DID DHT method create, resolve, update, and deactivate operations.
 *
 * This class includes methods for retrieving and publishing DID documents to and from the DHT,
 * using DNS packet encoding and DID DHT Gateway or Pkarr Relay servers. Methods delegate to
 * standalone functions extracted into focused modules.
 */
export class DidDhtDocument {
  /**
   * Retrieves a DID document and its metadata from the DHT network.
   *
   * @param params - The parameters for the get operation.
   * @param params.didUri - The DID URI containing the Identity Key.
   * @param params.gatewayUri - The DID DHT Gateway or Pkarr Relay URI.
   * @returns A Promise resolving to a {@link DidResolutionResult} object.
   */
  public static async get({ didUri, gatewayUri, allowPrivateGatewayUri = false }: {
    didUri: string;
    gatewayUri: string;
    allowPrivateGatewayUri?: boolean;
  }): Promise<DidResolutionResult> {
    // Decode the z-base-32 DID identifier to public key as a byte array.
    const publicKeyBytes = DidDhtUtils.identifierToIdentityKeyBytes({ didUri });

    // Retrieve the signed BEP44 message from a DID DHT Gateway or Pkarr relay.
    const bep44Message = await DidDhtDocument.pkarrGet({
      gatewayUri,
      publicKeyBytes,
      allowPrivateGatewayUri,
    });

    // Verify the signature of the BEP44 message and parse the value to a DNS packet.
    const dnsPacket = await DidDhtUtils.parseBep44GetMessage({ bep44Message });

    // Convert the DNS packet to a DID document and metadata.
    const resolutionResult = await DidDhtDocument.fromDnsPacket({ didUri, dnsPacket });

    // Set the version ID of the DID document metadata to the sequence number of the BEP44 message.
    resolutionResult.didDocumentMetadata.versionId = bep44Message.seq.toString();

    return resolutionResult;
  }

  /**
   * Publishes a DID document to the DHT network.
   *
   * @param params - The parameters to use when publishing the DID document to the DHT network.
   * @param params.did - The DID object whose DID document will be published.
   * @param params.gatewayUri - The DID DHT Gateway or Pkarr Relay URI.
   * @returns A promise that resolves to a {@link DidRegistrationResult} object.
   */
  public static async put({ did, gatewayUri, allowPrivateGatewayUri = false }: {
    did: BearerDid;
    gatewayUri: string;
    allowPrivateGatewayUri?: boolean;
  }): Promise<DidRegistrationResult> {
    // Convert the DID document and DID metadata (such as DID types) to a DNS packet.
    const dnsPacket = await DidDhtDocument.toDnsPacket({
      didDocument              : did.document,
      didMetadata              : did.metadata,
      authoritativeGatewayUris : [gatewayUri]
    });

    // Create a signed BEP44 put message from the DNS packet.
    const bep44Message = await DidDhtUtils.createBep44PutMessage({
      dnsPacket,
      publicKeyBytes : DidDhtUtils.identifierToIdentityKeyBytes({ didUri: did.uri }),
      signer         : await did.getSigner({ methodId: '0' })
    });

    // Publish the DNS packet to the DHT network.
    const putResult = await DidDhtDocument.pkarrPut({
      gatewayUri,
      bep44Message,
      allowPrivateGatewayUri,
    });

    // Return the result of processing the PUT operation, including the updated DID metadata with
    // the version ID and the publishing result.
    return {
      didDocument         : did.document,
      didDocumentMetadata : {
        ...did.metadata,
        published : putResult,
        versionId : bep44Message.seq.toString()
      },
      didRegistrationMetadata: {}
    };
  }

  /** Delegates to {@link pkarrGet} from `did-dht-pkarr.js`. */
  private static async pkarrGet(params: {
    publicKeyBytes: Uint8Array;
    gatewayUri: string;
    allowPrivateGatewayUri?: boolean;
  }): Promise<Bep44Message> {
    return pkarrGet(params);
  }

  /** Delegates to {@link pkarrPut} from `did-dht-pkarr.js`. */
  private static async pkarrPut(params: {
    bep44Message: Bep44Message;
    gatewayUri: string;
    allowPrivateGatewayUri?: boolean;
  }): Promise<boolean> {
    return pkarrPut(params);
  }

  /** Delegates to {@link fromDnsPacket} from `did-dht-dns.js`. */
  public static async fromDnsPacket(params: {
    didUri: string;
    dnsPacket: Packet;
  }): Promise<DidResolutionResult> {
    return fromDnsPacket(params);
  }

  /** Delegates to {@link toDnsPacket} from `did-dht-dns.js`. */
  public static async toDnsPacket(params: {
    didDocument: DidDocument;
    didMetadata: { published?: boolean; types?: (number | string)[] };
    authoritativeGatewayUris?: string[];
    previousDidProof?: PreviousDidProof;
  }): Promise<Packet> {
    return toDnsPacket(params);
  }

  /**
   * Gets the unique portion of the DID identifier after the last `:` character.
   * e.g. `did:dht:example` -> `example`
   *
   * @param did - The DID to extract the unique suffix from.
   */
  private static getUniqueDidSuffix(did: string): string {
    return did.split(':')[2];
  }
}

/**
 * The `DidDhtUtils` class provides utility functions to support operations in the DID DHT method.
 * Methods delegate to standalone functions extracted into focused modules for backward compatibility.
 */
export class DidDhtUtils {
  /** Delegates to {@link createBep44PutMessage} from `did-dht-pkarr.js`. */
  public static async createBep44PutMessage(params: {
    dnsPacket: Packet;
    publicKeyBytes: Uint8Array;
    signer: Signer;
  }): Promise<Bep44Message> {
    return createBep44PutMessage(params);
  }

  /** Delegates to {@link identifierToIdentityKey} from `did-dht-utils.js`. */
  public static async identifierToIdentityKey(params: {
    didUri: string;
  }): Promise<Jwk> {
    return identifierToIdentityKey(params);
  }

  /** Delegates to {@link identifierToIdentityKeyBytes} from `did-dht-utils.js`. */
  public static identifierToIdentityKeyBytes(params: {
    didUri: string;
  }): Uint8Array {
    return identifierToIdentityKeyBytes(params);
  }

  /** Delegates to {@link identityKeyToIdentifier} from `did-dht-utils.js`. */
  public static async identityKeyToIdentifier(params: {
    identityKey: Jwk;
  }): Promise<string> {
    return identityKeyToIdentifier(params);
  }

  /** Delegates to {@link keyConverter} from `did-dht-utils.js`. */
  public static keyConverter(curve: string): AsymmetricKeyConverter {
    return keyConverter(curve);
  }

  /** Delegates to {@link parseBep44GetMessage} from `did-dht-pkarr.js`. */
  public static async parseBep44GetMessage(params: {
    bep44Message: Bep44Message;
  }): Promise<Packet> {
    return parseBep44GetMessage(params);
  }

  /** Delegates to {@link parseTxtDataToObject} from `did-dht-dns.js`. */
  public static parseTxtDataToObject(txtData: TxtData): Record<string, string> {
    return parseTxtDataToObject(txtData);
  }

  /** Delegates to {@link parseTxtDataToString} from `did-dht-dns.js`. */
  public static parseTxtDataToString(txtData: TxtData): string {
    return parseTxtDataToString(txtData);
  }

  /** Delegates to {@link validatePreviousDidProof} from `did-dht-utils.js`. */
  public static async validatePreviousDidProof(params: {
    newDid: string;
    previousDidProof: PreviousDidProof;
  }): Promise<void> {
    return validatePreviousDidProof(params);
  }

  /** Delegates to {@link chunkDataIfNeeded} from `did-dht-dns.js`. */
  public static chunkDataIfNeeded(data: string): string | string[] {
    return chunkDataIfNeeded(data);
  }
}
