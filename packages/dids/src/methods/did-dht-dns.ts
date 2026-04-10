import type { DidMetadata } from '../types/portable-did.js';
import type { PreviousDidProof } from './did-dht-types.js';
import type { DidDocument, DidService } from '../types/did-core.js';
import type { Packet, StringAnswer, TxtAnswer, TxtData } from '@dnsquery/dns-packet';

import { AUTHORITATIVE_ANSWER } from '@dnsquery/dns-packet';
import { computeJwkThumbprint } from '@enbox/crypto';
import { Convert } from '@enbox/common';
import { DidVerificationRelationship } from '../types/did-core.js';
import { extractDidFragment } from '../utils.js';
import { DidDhtRegisteredDidType, DidDhtRegisteredKeyType, DidDhtVerificationRelationship } from './did-dht-types.js';
import { DidError, DidErrorCode } from '../did-error.js';
import { keyConverter, validatePreviousDidProof } from './did-dht-utils.js';

/**
 * The version of the DID DHT specification that is implemented by this library.
 */
export const DID_DHT_SPECIFICATION_VERSION = 0;

/**
 * The default TTL for DNS records published to the DHT network.
 *
 * The recommended TTL value is 7200 seconds (2 hours) since it matches the default TTL for
 * Mainline DHT records.
 */
export const DNS_RECORD_TTL = 7200;

/**
 * Character used to separate distinct elements or entries in the DNS packet representation
 * of a DID Document.
 */
export const PROPERTY_SEPARATOR = ';';

/**
 * Character used to separate distinct values within a single element or entry in the DNS packet
 * representation of a DID Document.
 */
export const VALUE_SEPARATOR = ',';

/**
 * Private helper that maps algorithm identifiers to their corresponding DID DHT
 * {@link DidDhtRegisteredKeyType | registered key type}.
 */
export const AlgorithmToKeyTypeMap = {
  Ed25519   : DidDhtRegisteredKeyType.Ed25519,
  ES256K    : DidDhtRegisteredKeyType.secp256k1,
  ES256     : DidDhtRegisteredKeyType.secp256r1,
  'P-256'   : DidDhtRegisteredKeyType.secp256r1,
  secp256k1 : DidDhtRegisteredKeyType.secp256k1,
  secp256r1 : DidDhtRegisteredKeyType.secp256r1,
  X25519    : DidDhtRegisteredKeyType.X25519,
} as const;

/**
 * Private helper that maps DID DHT registered key types to their corresponding default algorithm identifiers.
 */
export const KeyTypeToDefaultAlgorithmMap = {
  [DidDhtRegisteredKeyType.Ed25519]   : 'EdDSA',
  [DidDhtRegisteredKeyType.secp256k1] : 'ES256K',
  [DidDhtRegisteredKeyType.secp256r1] : 'ES256',
  [DidDhtRegisteredKeyType.X25519]    : 'ECDH-ES+A256KW',
};

/**
 * Creates a TXT DNS answer record with the given name and data, using the standard DNS_RECORD_TTL.
 *
 * @param name - The DNS record name.
 * @param data - The TXT record data (string or string array).
 * @returns A TxtAnswer record.
 */
export function createTxtRecord(name: string, data: string | string[]): TxtAnswer {
  return {
    type : 'TXT',
    name,
    ttl  : DNS_RECORD_TTL,
    data,
  };
}

/**
 * Decodes and parses the data value of a DNS TXT record into a string.
 *
 * @param txtData - The data value of a DNS TXT record.
 * @returns A string representation of the TXT record data.
 */
export function parseTxtDataToString(txtData: TxtData): string {
  if (typeof txtData === 'string') {
    return txtData;
  } else if (txtData instanceof Uint8Array) {
    return Convert.uint8Array(txtData).toString();
  } else if (Array.isArray(txtData)) {
    return txtData.map((item: TxtData): string => parseTxtDataToString(item)).join('');
  } else {
    throw new DidError(DidErrorCode.InternalError, 'Pkarr returned DNS TXT record with invalid data type');
  }
}

/**
 * Decodes and parses the data value of a DNS TXT record into a key-value object.
 *
 * @param txtData - The data value of a DNS TXT record.
 * @returns An object containing the key/value pairs of the TXT record data.
 */
export function parseTxtDataToObject(txtData: TxtData): Record<string, string> {
  return parseTxtDataToString(txtData).split(PROPERTY_SEPARATOR).reduce((acc: Record<string, string>, pair: string): Record<string, string> => {
    const [key, value] = pair.split('=');
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>);
}

/**
 * Splits a string into chunks of length 255 if the string exceeds length 255.
 *
 * @param data - The string to split into chunks.
 * @returns The original string if its length is less than or equal to 255, otherwise an array of chunked strings.
 */
export function chunkDataIfNeeded(data: string): string | string[] {
  if (data.length <= 255) {
    return data;
  }

  // Split the data into chunks of 255 characters.
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 255) {
    chunks.push(data.slice(i, i + 255)); // end index is ignored if it exceeds the length of the string
  }

  return chunks;
}

/**
 * Converts a DNS packet to a DID document according to the DID DHT specification.
 *
 * @see {@link https://did-dht.com/#dids-as-dns-records | DID DHT Specification, § DIDs as DNS Records}
 *
 * @param params - The parameters to use when converting a DNS packet to a DID document.
 * @param params.didUri - The DID URI of the DID document.
 * @param params.dnsPacket - The DNS packet to convert to a DID document.
 * @returns A Promise resolving to an object containing the DID document and its metadata.
 */
export async function fromDnsPacket({ didUri, dnsPacket }: {
  didUri: string;
  dnsPacket: Packet;
}): Promise<{ didDocument: DidDocument; didDocumentMetadata: DidMetadata; didResolutionMetadata: Record<string, never> }> {
  // Begin constructing the DID Document.
  const didDocument: DidDocument = { id: didUri };

  // Since the DID document is being retrieved from the DHT, it is considered published.
  const didDocumentMetadata: DidMetadata = {
    published: true
  };

  const idLookup = new Map<string, string>();

  for (const answer of dnsPacket?.answers ?? []) {
    // DID DHT properties are ONLY present in DNS TXT records.
    if (answer.type !== 'TXT') {continue;}

    // Get the DID DHT record identifier (e.g., k0, aka, did, etc.) from the DNS resource name.
    const dnsRecordId = answer.name.split('.')[0].substring(1);

    switch (true) {
      // Process an also known as record.
      case dnsRecordId.startsWith('aka'): {
        // Decode the DNS TXT record data value to a string.
        const data = parseTxtDataToString(answer.data);

        // Add the 'alsoKnownAs' property to the DID document.
        didDocument.alsoKnownAs = data.split(VALUE_SEPARATOR);

        break;
      }

      // Process a controller record.
      case dnsRecordId.startsWith('cnt'): {
        // Decode the DNS TXT record data value to a string.
        const data = parseTxtDataToString(answer.data);

        // Add the 'controller' property to the DID document.
        didDocument.controller = data.includes(VALUE_SEPARATOR) ? data.split(VALUE_SEPARATOR) : data;

        break;
      }

      // Process verification methods.
      case dnsRecordId.startsWith('k'): {
        // Get the key type (t), Base64URL-encoded public key (k), algorithm (a), and
        // optionally, controller (c) or Verification Method ID (id) from the decoded TXT record data.
        const { id, t, k, c, a: parsedAlg } = parseTxtDataToObject(answer.data);

        // Convert the public key from Base64URL format to a byte array.
        const publicKeyBytes = Convert.base64Url(k).toUint8Array();

        // Use the key type integer to look up the cryptographic curve name.
        const namedCurve = DidDhtRegisteredKeyType[Number(t)];

        // Convert the public key from a byte array to JWK format.
        const publicKey = await keyConverter(namedCurve).bytesToPublicKey({ publicKeyBytes });

        publicKey.alg = parsedAlg || KeyTypeToDefaultAlgorithmMap[Number(t) as DidDhtRegisteredKeyType];

        // TODO: when this is complete https://github.com/enboxorg/enbox/issues/638 then we can add this back and
        // update the test vectors kid back to '0'
        // if(dnsRecordId === 'k0') {
        //   publicKey.kid = '0';
        // }

        // Determine the Verification Method ID: '0' for the identity key,
        // the id from the TXT Data Object, or the JWK thumbprint if an explicity Verification Method ID not defined.
        const vmId = dnsRecordId === 'k0' ? '0' : id === undefined ? await computeJwkThumbprint({ jwk: publicKey }) : id;

        // Initialize the `verificationMethod` array if it does not already exist.
        didDocument.verificationMethod ??= [];

        // Prepend the DID URI to the ID fragment to form the full verification method ID.
        const methodId = `${didUri}#${vmId}`;

        // Add the verification method to the DID document.
        didDocument.verificationMethod.push({
          id           : methodId,
          type         : 'JsonWebKey',
          controller   : c ?? didUri,
          publicKeyJwk : publicKey,
        });

        // Add a mapping from the DNS record ID (e.g., 'k0', 'k1', etc.) to the verification
        // method ID (e.g., 'did:dht:...#0', etc.).
        idLookup.set(dnsRecordId, methodId);

        break;
      }

      // Process services.
      case dnsRecordId.startsWith('s'): {
        // Get the service ID fragment (id), type (t), service endpoint (se), and optionally,
        // other properties from the decoded TXT record data.
        const { id, t, se, ...customProperties } = parseTxtDataToObject(answer.data);

        // if multi-values: 'a,b,c' -> ['a', 'b', 'c'], if single-value: 'a' -> ['a']
        // NOTE: The service endpoint technically can either be a string or an array of strings,
        // we enforce an array for single-value to simplify verification of vector 3 in the spec: https://did-dht.com/#vector-3
        const serviceEndpoint = se.includes(VALUE_SEPARATOR) ? se.split(VALUE_SEPARATOR) : [se];

        // Convert custom property values to either a string or an array of strings.
        const serviceProperties = Object.fromEntries(Object.entries(customProperties).map(
          ([k, v]: [string, string]): [string, string | string[]] => [k, v.includes(VALUE_SEPARATOR) ? v.split(VALUE_SEPARATOR) : v]
        ));

        // Initialize the `service` array if it does not already exist.
        didDocument.service ??= [];

        didDocument.service.push({
          ...serviceProperties,
          id   : `${didUri}#${id}`,
          type : t,
          serviceEndpoint
        });

        break;
      }

      // Process DID DHT types.
      case dnsRecordId.startsWith('typ'): {
        // Decode the DNS TXT record data value to an object.
        const { id: types } = parseTxtDataToObject(answer.data);

        // Add the DID DHT Registered DID Types represented as numbers to DID metadata.
        didDocumentMetadata.types = types.split(VALUE_SEPARATOR).map((typeInteger: string): number => Number(typeInteger));

        break;
      }

      // Process root record.
      case dnsRecordId.startsWith('did'): {
        // Helper function that maps verification relationship values to verification method IDs.
        const recordIdsToMethodIds = (data: string): string[] => data
          .split(VALUE_SEPARATOR)
          .map((dnsRecordId: string): string | undefined => idLookup.get(dnsRecordId))
          .filter((id): id is string => typeof id === 'string');

        // Decode the DNS TXT record data and destructure verification relationship properties.
        const { auth, asm, del, inv, agm } = parseTxtDataToObject(answer.data);

        // Add the verification relationships, if any, to the DID document.
        if (auth) {didDocument.authentication = recordIdsToMethodIds(auth);}
        if (asm) {didDocument.assertionMethod = recordIdsToMethodIds(asm);}
        if (del) {didDocument.capabilityDelegation = recordIdsToMethodIds(del);}
        if (inv) {didDocument.capabilityInvocation = recordIdsToMethodIds(inv);}
        if (agm) {didDocument.keyAgreement = recordIdsToMethodIds(agm);}

        break;
      }
    }
  }

  return { didDocument, didDocumentMetadata, didResolutionMetadata: {} };
}

/**
 * Converts a DID document to a DNS packet according to the DID DHT specification.
 *
 * @see {@link https://did-dht.com/#dids-as-dns-records | DID DHT Specification, § DIDs as DNS Records}
 *
 * @param params - The parameters to use when converting a DID document to a DNS packet.
 * @param params.didDocument - The DID document to convert to a DNS packet.
 * @param params.didMetadata - The DID metadata to include in the DNS packet.
 * @param params.authoritativeGatewayUris - The URIs of the Authoritative Gateways to generate NS records from.
 * @param params.previousDidProof - The signature proof that this DID is linked to the given previous DID.
 * @returns A promise that resolves to a DNS packet.
 */
export async function toDnsPacket({ didDocument, didMetadata, authoritativeGatewayUris, previousDidProof }: {
  didDocument: DidDocument;
  didMetadata: DidMetadata;
  authoritativeGatewayUris?: string[];
  previousDidProof?: PreviousDidProof;
}): Promise<Packet> {
  const txtRecords: TxtAnswer[] = [];
  const nsRecords: StringAnswer[] = [];
  const idLookup = new Map<string, string>();
  const serviceIds: string[] = [];
  const verificationMethodIds: string[] = [];

  // Add `_prv._did.` TXT record if previous DID proof is provided and valid.
  if (previousDidProof !== undefined) {
    const { signature, previousDid } = previousDidProof;

    await validatePreviousDidProof({
      newDid: didDocument.id,
      previousDidProof
    });

    txtRecords.push({
      type : 'TXT',
      name : '_prv._did.',
      ttl  : DNS_RECORD_TTL,
      data : `id=${previousDid};s=${signature}`
    });
  }

  // Add DNS TXT records if the DID document contains an `alsoKnownAs` property.
  if (didDocument.alsoKnownAs) {
    txtRecords.push({
      type : 'TXT',
      name : '_aka._did.',
      ttl  : DNS_RECORD_TTL,
      data : didDocument.alsoKnownAs.join(VALUE_SEPARATOR)
    });
  }

  // Add DNS TXT records if the DID document contains a `controller` property.
  if (didDocument.controller) {
    const controller = Array.isArray(didDocument.controller)
      ? didDocument.controller.join(VALUE_SEPARATOR)
      : didDocument.controller;
    txtRecords.push({
      type : 'TXT',
      name : '_cnt._did.',
      ttl  : DNS_RECORD_TTL,
      data : controller
    });
  }

  // Add DNS TXT records for each verification method.
  for (const [index, verificationMethod] of didDocument.verificationMethod?.entries() ?? []) {
    const dnsRecordId = `k${index}`;
    verificationMethodIds.push(dnsRecordId);
    const methodId = verificationMethod.id.split('#').pop()!; // Remove fragment prefix, if any.
    idLookup.set(methodId, dnsRecordId);

    const publicKey = verificationMethod.publicKeyJwk;

    if (!(publicKey?.crv && publicKey.crv in AlgorithmToKeyTypeMap)) {
      throw new DidError(DidErrorCode.InvalidPublicKeyType, `Verification method '${verificationMethod.id}' contains an unsupported key type: ${publicKey?.crv ?? 'undefined'}`);
    }

    // Use the public key's `crv` property to get the DID DHT key type.
    const keyType = DidDhtRegisteredKeyType[publicKey.crv as keyof typeof DidDhtRegisteredKeyType];

    // Convert the public key from JWK format to a byte array.
    const publicKeyBytes = await keyConverter(publicKey.crv).publicKeyToBytes({ publicKey });

    // Convert the public key from a byte array to Base64URL format.
    const publicKeyBase64Url = Convert.uint8Array(publicKeyBytes).toBase64Url();

    // Define the data for the DNS TXT record.
    const txtData = [`t=${keyType}`, `k=${publicKeyBase64Url}`];
    // if the methodId is not the identity key or a thumbprint, explicity define the id within the DNS TXT record.
    // otherwise the id can be inferred from the thumbprint.
    if (methodId !== '0' && await computeJwkThumbprint({ jwk: publicKey }) !== methodId) {
      txtData.unshift(`id=${methodId}`);
    }
    // Only set the algorithm property (`a`) if it differs from the default algorithm for the key type.
    if (publicKey.alg !== KeyTypeToDefaultAlgorithmMap[keyType]) {
      txtData.push(`a=${publicKey.alg}`);
    }

    // Add the controller property, if set to a value other than the Identity Key (DID Subject).
    if (verificationMethod.controller !== didDocument.id) {txtData.push(`c=${verificationMethod.controller}`);}

    // Add a TXT record for the verification method.
    txtRecords.push({
      type : 'TXT',
      name : `_${dnsRecordId}._did.`,
      ttl  : DNS_RECORD_TTL,
      data : txtData.join(PROPERTY_SEPARATOR)
    });
  }

  // Add DNS TXT records for each service.
  didDocument.service?.forEach((service: DidService, index: number): void => {
    const dnsRecordId = `s${index}`;
    serviceIds.push(dnsRecordId);

    let { id, type: t, serviceEndpoint: se, ...customProperties } = service;
    id = extractDidFragment(id)!;
    se = Array.isArray(se) ? se.join(',') : se;

    // Define the data for the DNS TXT record.
    const txtData = Object.entries({ id, t, se, ...customProperties }).map(
      ([key, value]: [string, unknown]): string => `${key}=${value}`
    );

    const txtDataString = txtData.join(PROPERTY_SEPARATOR);
    const data = chunkDataIfNeeded(txtDataString);

    // Add a TXT record for the verification method.
    txtRecords.push({
      type : 'TXT',
      name : `_${dnsRecordId}._did.`,
      ttl  : DNS_RECORD_TTL,
      data
    });
  });

  // Initialize the root DNS TXT record with the DID DHT specification version.
  const rootRecord: string[] = [`v=${DID_DHT_SPECIFICATION_VERSION}`];

  // Add verification methods to the root record.
  if (verificationMethodIds.length) {
    rootRecord.push(`vm=${verificationMethodIds.join(VALUE_SEPARATOR)}`);
  }

  // Add verification relationships to the root record.
  Object.keys(DidVerificationRelationship).forEach((relationship: string): void => {
    // Collect the verification method IDs for the given relationship.
    const dnsRecordIds = (didDocument[relationship as keyof DidDocument] as string[] | undefined)
      ?.map((id: string): string | undefined => idLookup.get(id.split('#').pop()!));

    // If the relationship includes verification methods, add them to the root record.
    if (dnsRecordIds) {
      const recordName = DidDhtVerificationRelationship[relationship as keyof typeof DidDhtVerificationRelationship];
      rootRecord.push(`${recordName}=${dnsRecordIds.join(VALUE_SEPARATOR)}`);
    }
  });

  // Add services to the root record.
  if (serviceIds.length) {
    rootRecord.push(`svc=${serviceIds.join(VALUE_SEPARATOR)}`);
  }

  // If defined, add a DNS TXT record for each registered DID type.
  if (didMetadata.types?.length) {
    // DID types can be specified as either a string or a number, so we need to normalize the
    // values to integers.
    const types = didMetadata.types as (DidDhtRegisteredDidType | keyof typeof DidDhtRegisteredDidType)[];
    const typeIntegers = types.map((type: DidDhtRegisteredDidType | keyof typeof DidDhtRegisteredDidType): DidDhtRegisteredDidType =>
      typeof type === 'string' ? DidDhtRegisteredDidType[type] : type
    );

    txtRecords.push({
      type : 'TXT',
      name : '_typ._did.',
      ttl  : DNS_RECORD_TTL,
      data : `id=${typeIntegers.join(VALUE_SEPARATOR)}`
    });
  }

  // Add a DNS TXT record for the root record.
  txtRecords.push({
    type : 'TXT',
    name : '_did.' + getUniqueDidSuffix(didDocument.id) + '.', // name of a Root Record MUST end in `<ID>.`
    ttl  : DNS_RECORD_TTL,
    data : rootRecord.join(PROPERTY_SEPARATOR)
  });

  // Add an NS record for each authoritative gateway URI.
  for (const gatewayUri of authoritativeGatewayUris || []) {
    nsRecords.push({
      type : 'NS',
      name : '_did.' + getUniqueDidSuffix(didDocument.id) + '.', // name of an NS record a authoritative gateway MUST end in `<ID>.`
      ttl  : DNS_RECORD_TTL,
      data : gatewayUri + '.'
    });
  }

  // Create a DNS response packet with the authoritative answer flag set.
  const dnsPacket: Packet = {
    id      : 0,
    type    : 'response',
    flags   : AUTHORITATIVE_ANSWER,
    answers : [...txtRecords, ...nsRecords]
  };

  return dnsPacket;
}

/**
 * Gets the unique portion of the DID identifier after the last `:` character.
 * e.g. `did:dht:example` -> `example`
 *
 * @param did - The DID to extract the unique suffix from.
 */
function getUniqueDidSuffix(did: string): string {
  return did.split(':')[2];
}
