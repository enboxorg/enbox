import type { DidCreateOptions, DidCreateVerificationMethod } from './did-method.js';

import type { DidService } from '../types/did-core.js';

/**
 * Represents a BEP44 message, which is used for storing and retrieving data in the Mainline DHT
 * network.
 *
 * A BEP44 message is used primarily in the context of the DID DHT method for publishing and
 * resolving DID documents in the DHT network. This type encapsulates the data structure required
 * for such operations in accordance with BEP44.
 *
 * @see {@link https://www.bittorrent.org/beps/bep_0044.html | BEP44}
 */
export interface Bep44Message {
  /**
   * The public key bytes of the Identity Key, which serves as the identifier in the DHT network for
   * the corresponding BEP44 message.
   */
  k: Uint8Array;

  /**
   * The sequence number of the message, used to ensure the latest version of the data is retrieved
   * and updated. It's a monotonically increasing number.
   */
  seq: number;

  /**
   * The signature of the message, ensuring the authenticity and integrity of the data. It's
   * computed over the BEP44 encoded sequence number and value.
   */
  sig: Uint8Array;

  /**
   * The actual data being stored or retrieved from the DHT network, typically encoded in a format
   * suitable for DNS packet representation of a DID Document.
   */
  v: Uint8Array;
}

/**
 * Options for creating a Decentralized Identifier (DID) using the DID DHT method.
 */
export interface DidDhtCreateOptions<TKms> extends DidCreateOptions<TKms> {
  /**
   * Optionally specify that the DID Subject is also identified by one or more other DIDs or URIs.
   *
   * A DID subject can have multiple identifiers for different purposes, or at different times.
   * The assertion that two or more DIDs (or other types of URI) refer to the same DID subject can
   * be made using the `alsoKnownAs` property.
   *
   * @see {@link https://www.w3.org/TR/did-core/#also-known-as | DID Core Specification, § Also Known As}
   *
   * @example
   * ```ts
   * const did = await DidDht.create({
   *  options: {
   *   alsoKnownAs: 'did:example:123'
   * };
   * ```
   */
  alsoKnownAs?: string[];

  /**
   * Optionally specify which DID (or DIDs) is authorized to make changes to the DID document.
   *
   * A DID controller is an entity that is authorized to make changes to a DID document. Typically,
   * only the DID Subject (i.e., the value of `id` property in the DID document) is authoritative.
   * However, another DID (or DIDs) can be specified as the DID controller, and when doing so, any
   * verification methods contained in the DID document for the other DID should be accepted as
   * authoritative. In other words, proofs created by the controller DID should be considered
   * equivalent to proofs created by the DID Subject.
   *
   * @see {@link https://www.w3.org/TR/did-core/#did-controller | DID Core Specification, § DID Controller}
   *
   * @example
   * ```ts
   * const did = await DidDht.create({
   *  options: {
   *   controller: 'did:example:123'
   * };
   * ```
   */
  controllers?: string | string[];

  /**
   * Optional. The URI of a server involved in executing DID method operations. In the context of
   * DID creation, the endpoint is expected to be a DID DHT Gateway or Pkarr relay. If not
   * specified, a default gateway node is used.
   */
  gatewayUri?: string;

  /**
   * Allows a private, loopback, or link-local `gatewayUri`.
   *
   * This defaults to `false` and is intended for local development and tests only.
   * Leave unset when the gateway URI is derived from untrusted input.
   */
  allowPrivateGatewayUri?: boolean;

  /**
   * Optional. Determines whether the created DID should be published to the DHT network.
   *
   * If set to `true` or omitted, the DID is publicly discoverable. If `false`, the DID is not
   * published and cannot be resolved by others. By default, newly created DIDs are published.
   *
   * @see {@link https://did-dht.com | DID DHT Method Specification}
   *
   * @example
   * ```ts
   * const did = await DidDht.create({
   *  options: {
   *   publish: false
   * };
   * ```
   */
  publish?: boolean;

  /**
   * Optional. An array of service endpoints associated with the DID.
   *
   * Services are used in DID documents to express ways of communicating with the DID subject or
   * associated entities. A service can be any type of service the DID subject wants to advertise,
   * including decentralized identity management services for further discovery, authentication,
   * authorization, or interaction.
   *
   * @see {@link https://www.w3.org/TR/did-core/#services | DID Core Specification, § Services}
   *
   * @example
   * ```ts
   * const did = await DidDht.create({
   *  options: {
   *   services: [
   *     {
   *       id: 'did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y#dwn',
   *       type: 'DecentralizedWebNode',
   *       serviceEndpoint: ['https://example.com/dwn1', 'https://example/dwn2']
   *     }
   *   ]
   * };
   * ```
   */
  services?: DidService[];

  /**
   * Optionally specify one or more registered DID DHT types to make the DID discovereable.
   *
   * Type indexing is an OPTIONAL feature that enables DIDs to become discoverable. DIDs that wish
   * to be discoverable and resolveable by type can include one or more types when publishing their
   * DID document to a DID DHT Gateway.
   *
   * The registered DID types are published in the {@link https://did-dht.com/registry/index.html#indexed-types | DID DHT Registry}.
   */
  types?: (DidDhtRegisteredDidType | keyof typeof DidDhtRegisteredDidType)[];

  /**
   * Optional. An array of verification methods to be included in the DID document.
   *
   * By default, a newly created DID DHT document will contain a single Ed25519 verification method,
   * also known as the {@link https://did-dht.com/#term:identity-key | Identity Key}. Additional
   * verification methods can be added to the DID document using the `verificationMethods` property.
   *
   * @see {@link https://www.w3.org/TR/did-core/#verification-methods | DID Core Specification, § Verification Methods}
   *
   * @example
   * ```ts
   * const did = await DidDht.create({
   *  options: {
   *   verificationMethods: [
   *     {
   *       algorithm: 'Ed25519',
   *       purposes: ['authentication', 'assertionMethod']
   *     },
   *     {
   *       algorithm: 'Ed25519',
   *       id: 'dwn-sig',
   *       purposes: ['authentication', 'assertionMethod']
   *     }
   *   ]
   * };
   * ```
   */
  verificationMethods?: DidCreateVerificationMethod<TKms>[];
}

/**
 * Proof to used to construct the `_prv._did.` DNS record as described in https://did-dht.com/#rotation to link a DID to a previous DID.
 */
export type PreviousDidProof = {
  /** The previous DID. */
  previousDid: string;

  /** The signature signed using the private Identity Key of the previous DID in Base64URL format. */
  signature: string;
};

/**
 * Represents an optional extension to a DID Document's DNS packet representation exposed as a
 * type index.
 *
 * Type indexing is an OPTIONAL feature that enables DIDs to become discoverable. DIDs that wish to
 * be discoverable and resolveable by type can include one or more types when publishing their DID
 * document to a DID DHT Gateway.
 *
 * The registered DID types are published in the {@link https://did-dht.com/registry/index.html#indexed-types | DID DHT Registry}.
 */
export enum DidDhtRegisteredDidType {
  /**
   * Type 0 is reserved for DIDs that do not wish to associate themselves with a specific type but
   * wish to make themselves discoverable.
   */
  Discoverable = 0,

  /**
   * Organization
   * @see {@link https://schema.org/Organization | schema definition}
   */
  Organization = 1,

  /**
   * Government Organization
   * @see {@link https://schema.org/GovernmentOrganization | schema definition}
   */
  Government = 2,

  /**
   * Corporation
   * @see {@link https://schema.org/Corporation | schema definition}
   */
  Corporation = 3,

  /**
   * Corporation
   * @see {@link https://schema.org/Corporation | schema definition}
   */
  LocalBusiness = 4,

  /**
   * Software Package
   * @see {@link https://schema.org/SoftwareSourceCode | schema definition}
   */
  SoftwarePackage = 5,

  /**
   * Web App
   * @see {@link https://schema.org/WebApplication | schema definition}
   */
  WebApp = 6,

  /**
   * Financial Institution
   * @see {@link https://schema.org/FinancialService | schema definition}
   */
  FinancialInstitution = 7
}

/**
 * Enumerates the types of keys that can be used in a DID DHT document.
 *
 * The DID DHT method supports various cryptographic key types. These key types are essential for
 * the creation and management of DIDs and their associated cryptographic operations like signing
 * and encryption. The registered key types are published in the DID DHT Registry and each is
 * assigned a unique numerical value for use by client and gateway implementations.
 *
 * The registered key types are published in the {@link https://did-dht.com/registry/index.html#key-type-index | DID DHT Registry}.
 */
export enum DidDhtRegisteredKeyType {
  /**
   * Ed25519: A public-key signature system using the EdDSA (Edwards-curve Digital Signature
   * Algorithm) and Curve25519.
   */
  Ed25519 = 0,

  /**
   * secp256k1: A cryptographic curve used for digital signatures in a range of decentralized
   * systems.
   */
  secp256k1 = 1,

  /**
   * secp256r1: Also known as P-256 or prime256v1, this curve is used for cryptographic operations
   * and is widely supported in various cryptographic libraries and standards.
   */
  secp256r1 = 2,

  /**
   * X25519: A public key used for Diffie-Hellman key exchange using Curve25519.
   */
  X25519 = 3,
}

/**
 * Maps {@link https://www.w3.org/TR/did-core/#verification-relationships | DID Core Verification Relationship}
 * values to the corresponding record name in the DNS packet representation of a DHT DID document.
 */
export enum DidDhtVerificationRelationship {
  /**
   * Specifies how the DID subject is expected to be authenticated.
   */
  authentication = 'auth',

  /**
   * Specifies how the DID subject is expected to express claims, such as for issuing Verifiable
   * Credentials.
   */
  assertionMethod = 'asm',

  /**
   * Specifies a mechanism used by the DID subject to delegate a cryptographic capability to another
   * party
   */
  capabilityDelegation = 'del',

  /**
   * Specifies a verification method used by the DID subject to invoke a cryptographic capability.
   */
  capabilityInvocation = 'inv',

  /**
   * Specifies how an entity can generate encryption material to communicate confidentially with the
   * DID subject.
   */
  keyAgreement = 'agm'
}
