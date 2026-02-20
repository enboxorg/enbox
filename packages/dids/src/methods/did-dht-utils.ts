import type { AsymmetricKeyConverter, Jwk } from '@enbox/crypto';

import { Convert } from '@enbox/common';
import { Ed25519, Secp256k1, Secp256r1, X25519 } from '@enbox/crypto';

import type { PreviousDidProof } from './did-dht-types.js';

import { Did } from '../did.js';
import { DidError, DidErrorCode } from '../did-error.js';

/**
 * The DID DHT method name.
 */
const DID_DHT_METHOD_NAME = 'dht';

/**
 * Converts a DID URI to a JSON Web Key (JWK) representing the Identity Key.
 *
 * @param params - The parameters to use for the conversion.
 * @param params.didUri - The DID URI containing the Identity Key.
 * @returns A promise that resolves to a JWK representing the Identity Key.
 */
export async function identifierToIdentityKey({ didUri }: {
  didUri: string;
}): Promise<Jwk> {
  // Decode the method-specific identifier from z-base-32 to a byte array.
  const identityKeyBytes = identifierToIdentityKeyBytes({ didUri });

  // Convert the byte array to a JWK.
  const identityKey = await Ed25519.bytesToPublicKey({ publicKeyBytes: identityKeyBytes });

  return identityKey;
}

/**
 * Converts a DID URI to the byte array representation of the Identity Key.
 *
 * @param params - The parameters to use for the conversion.
 * @param params.didUri - The DID URI containing the Identity Key.
 * @returns A byte array representation of the Identity Key.
 */
export function identifierToIdentityKeyBytes({ didUri }: {
  didUri: string;
}): Uint8Array {
  // Parse the DID URI.
  const parsedDid = Did.parse(didUri);

  // Verify that the DID URI is valid.
  if (!parsedDid) {
    throw new DidError(DidErrorCode.InvalidDid, `Invalid DID URI: ${didUri}`);
  }

  // Verify the DID method is supported.
  if (parsedDid.method !== DID_DHT_METHOD_NAME) {
    throw new DidError(DidErrorCode.MethodNotSupported, `Method not supported: ${parsedDid.method}`);
  }

  // Decode the method-specific identifier from z-base-32 to a byte array.
  let identityKeyBytes: Uint8Array;
  try {
    identityKeyBytes = Convert.base32Z(parsedDid.id).toUint8Array();
  } catch {
    throw new DidError(DidErrorCode.InvalidPublicKey, `Failed to decode method-specific identifier`);
  }

  if (identityKeyBytes.length !== 32) {
    throw new DidError(DidErrorCode.InvalidPublicKeyLength, `Invalid public key length: ${identityKeyBytes.length}`);
  }

  return identityKeyBytes;
}

/**
 * Encodes a DID DHT Identity Key into a DID identifier.
 *
 * This method first z-base-32 encodes the Identity Key. The resulting string is prefixed with
 * `did:dht:` to form the DID identifier.
 *
 * @param params - The parameters to use for the conversion.
 * @param params.identityKey The Identity Key from which the DID identifier is computed.
 * @returns A promise that resolves to a string containing the DID identifier.
 */
export async function identityKeyToIdentifier({ identityKey }: {
  identityKey: Jwk;
}): Promise<string> {
  // Convert the key from JWK format to a byte array.
  const publicKeyBytes = await Ed25519.publicKeyToBytes({ publicKey: identityKey });

  // Encode the byte array as a z-base-32 string.
  const identifier = Convert.uint8Array(publicKeyBytes).toBase32Z();

  return `did:${DID_DHT_METHOD_NAME}:${identifier}`;
}

/**
 * Returns the appropriate key converter for the specified cryptographic curve.
 *
 * @param curve - The cryptographic curve to use for the key conversion.
 * @returns An `AsymmetricKeyConverter` for the specified curve.
 */
export function keyConverter(curve: string): AsymmetricKeyConverter {
  const converters: Record<string, AsymmetricKeyConverter> = {
    'Ed25519' : Ed25519,
    'P-256'   : {
      // Wrap the key converter which produces uncompressed public key bytes to produce compressed key bytes as required by the DID DHT spec.
      // See https://did-dht.com/#representing-keys for more info.
      publicKeyToBytes: async ({ publicKey }: { publicKey: Jwk }): Promise<Uint8Array> => {
        const publicKeyBytes = await Secp256r1.publicKeyToBytes({ publicKey });
        const compressedPublicKey = await Secp256r1.compressPublicKey({ publicKeyBytes });
        return compressedPublicKey;
      },
      bytesToPublicKey  : Secp256r1.bytesToPublicKey,
      privateKeyToBytes : Secp256r1.privateKeyToBytes,
      bytesToPrivateKey : Secp256r1.bytesToPrivateKey,
    },
    'secp256k1': {
      // Wrap the key converter which produces uncompressed public key bytes to produce compressed key bytes as required by the DID DHT spec.
      // See https://did-dht.com/#representing-keys for more info.
      publicKeyToBytes: async ({ publicKey }: { publicKey: Jwk }): Promise<Uint8Array> => {
        const publicKeyBytes = await Secp256k1.publicKeyToBytes({ publicKey });
        const compressedPublicKey = await Secp256k1.compressPublicKey({ publicKeyBytes });
        return compressedPublicKey;
      },
      bytesToPublicKey  : Secp256k1.bytesToPublicKey,
      privateKeyToBytes : Secp256k1.privateKeyToBytes,
      bytesToPrivateKey : Secp256k1.bytesToPrivateKey,
    },
    X25519: X25519,
  };

  const converter = converters[curve];

  if (!converter) {throw new DidError(DidErrorCode.InvalidPublicKeyType, `Unsupported curve: ${curve}`);}

  return converter;
}

/**
 * Validates the proof of previous DID given.
 *
 * @param params - The parameters to validate the previous DID proof.
 * @param params.newDid - The new DID that the previous DID is linking to.
 * @param params.previousDidProof - The proof of the previous DID, containing the previous DID and signature signed by the previous DID.
 */
export async function validatePreviousDidProof({ newDid, previousDidProof }: {
  newDid: string;
  previousDidProof: PreviousDidProof;
}): Promise<void> {
  const key = await identifierToIdentityKey({ didUri: previousDidProof.previousDid });
  const data = identifierToIdentityKeyBytes({ didUri: newDid });
  const signature = Convert.base64Url(previousDidProof.signature).toUint8Array();
  const isValid = await Ed25519.verify({ key, data, signature });

  if (!isValid) {
    throw new DidError(DidErrorCode.InvalidPreviousDidProof, 'The previous DID proof is invalid.');
  }
}
