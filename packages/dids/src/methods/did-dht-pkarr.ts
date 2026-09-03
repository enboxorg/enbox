import type { Packet } from '@dnsquery/dns-packet';
import type { Signer } from '@enbox/crypto';

import type { Bep44Message } from './did-dht-types.js';

import { Ed25519 } from '@enbox/crypto';
import { Convert, fetchPublicUrl, isExplicitlyOffline, PublicUrlValidationError } from '@enbox/common';
import { DidError, DidErrorCode, DidResolutionErrorCause } from '../did-error.js';
import { decode as dnsPacketDecode, encode as dnsPacketEncode } from '@dnsquery/dns-packet';

const textEncoder = new TextEncoder();

/**
 * Encodes the BEP44 signing payload for a mutable item.
 *
 * BEP44 signs the dictionary body for `{ seq, v }`, without the surrounding `d` and `e` dictionary
 * delimiters. For DID DHT records that body is always:
 * `3:seqi<sequenceNumber>e1:v<valueLength>:<valueBytes>`.
 */
export function encodeBep44SigningPayload({ sequenceNumber, value }: {
  sequenceNumber: number;
  value: Uint8Array;
}): Uint8Array {
  const prefix = textEncoder.encode(`3:seqi${sequenceNumber}e1:v${value.length}:`);
  const encodedPayload = new Uint8Array(prefix.length + value.length);
  encodedPayload.set(prefix);
  encodedPayload.set(value, prefix.length);

  return encodedPayload;
}

/**
 * Constructs a Pkarr URL from public key bytes and a gateway URI.
 *
 * @param publicKeyBytes - The public key bytes to z-base-32 encode.
 * @param gatewayUri - The gateway URI to use as the base URL.
 * @returns The full Pkarr URL.
 */
function pkarrUrl(publicKeyBytes: Uint8Array, gatewayUri: string): string {
  const identifier = Convert.uint8Array(publicKeyBytes).toBase32Z();
  return new URL(identifier, gatewayUri).href;
}

/**
 * Wraps {@link fetchPublicUrl} so URL / redirect-validation failures surface as the typed
 * {@link DidErrorCode.InvalidGatewayUri} regardless of whether the offending host appeared in
 * the original URL or in a redirect `Location` header. Other failures (network errors, fetch
 * timeouts, etc.) propagate unchanged so callers can map them to `internalError` as before.
 *
 * `allowPrivateGatewayUri` widens the validator to accept loopback / private targets — useful
 * for development and CI relays — but native `fetch()` will still refuse non-network schemes
 * for redirect targets, so `file:`, `javascript:`, etc. cannot be smuggled through.
 * Enabling the bypass also disables per-hop redirect validation; only opt in for trusted local relays.
 */
async function pkarrFetch(url: string, init: RequestInit, allowPrivateGatewayUri: boolean): Promise<Response> {
  if (allowPrivateGatewayUri) {
    return fetch(url, init);
  }

  try {
    return await fetchPublicUrl(url, init, { description: 'Pkarr gateway URL' });
  } catch (error: any) {
    if (error instanceof PublicUrlValidationError) {
      throw new DidError(DidErrorCode.InvalidGatewayUri, error.message);
    }
    throw error;
  }
}

/**
 * Retrieves a signed BEP44 message from a DID DHT Gateway or Pkarr Relay server.
 *
 * @see {@link https://github.com/Nuhvi/pkarr/blob/main/design/relays.md | Pkarr Relay design}
 *
 * @param params - The parameters for the get operation.
 * @param params.gatewayUri - The DID DHT Gateway or Pkarr Relay URI.
 * @param params.publicKeyBytes - The public key bytes of the Identity Key, z-base-32 encoded.
 * @returns A promise resolving to a BEP44 message containing the signed DNS packet.
 */
export async function pkarrGet({ gatewayUri, publicKeyBytes, allowPrivateGatewayUri = false }: {
  publicKeyBytes: Uint8Array;
  gatewayUri: string;
  allowPrivateGatewayUri?: boolean;
}): Promise<Bep44Message> {
  // The identifier (key in the DHT) is the z-base-32 encoding of the Identity Key.
  const identifier = Convert.uint8Array(publicKeyBytes).toBase32Z();

  // Concatenate the gateway URI with the identifier to form the full URL.
  const url = pkarrUrl(publicKeyBytes, gatewayUri);

  // Transmit the Get request to the DID DHT Gateway or Pkarr Relay and get the response.
  // Redirects are followed manually so each `Location` is re-validated and cannot smuggle a
  // private host past the initial gateway check.
  let response: Response;
  try {
    if (isExplicitlyOffline()) {
      throw new DidError(
        DidErrorCode.InternalError,
        `Cannot fetch Pkarr record while the browser is offline: ${identifier}`,
        { info: { errorCause: DidResolutionErrorCause.NetworkUnavailable } },
      );
    }

    response = await pkarrFetch(url, { method: 'GET', signal: AbortSignal.timeout(30_000) }, allowPrivateGatewayUri);

    if (!response.ok) {
      throw new DidError(DidErrorCode.NotFound, `Pkarr record not found for: ${identifier}`);
    }

  } catch (error: any) {
    if (error instanceof DidError) {throw error;}
    throw new DidError(DidErrorCode.InternalError, `Failed to fetch Pkarr record: ${error.message}`);
  }

  // Read the Fetch Response stream into a byte array.
  const messageBytes = await response.arrayBuffer();

  if (!messageBytes) {
    throw new DidError(DidErrorCode.NotFound, `Pkarr record not found for: ${identifier}`);
  }

  if (messageBytes.byteLength < 72) {
    throw new DidError(DidErrorCode.InvalidDidDocumentLength, `Pkarr response must be at least 72 bytes but got: ${messageBytes.byteLength}`);
  }

  if (messageBytes.byteLength > 1072) {
    throw new DidError(DidErrorCode.InvalidDidDocumentLength, `Pkarr response exceeds 1000 byte limit: ${messageBytes.byteLength}`);
  }

  // Decode the BEP44 message from the byte array.
  const bep44Message: Bep44Message = {
    k   : publicKeyBytes,
    seq : Number(new DataView(messageBytes).getBigUint64(64)),
    sig : new Uint8Array(messageBytes, 0, 64),
    v   : new Uint8Array(messageBytes, 72)
  };

  return bep44Message;
}

/**
 * Publishes a signed BEP44 message to a DID DHT Gateway or Pkarr Relay server.
 *
 * @see {@link https://github.com/Nuhvi/pkarr/blob/main/design/relays.md | Pkarr Relay design}
 *
 * @param params - The parameters to use when publishing a signed BEP44 message to a Pkarr relay server.
 * @param params.gatewayUri - The DID DHT Gateway or Pkarr Relay URI.
 * @param params.bep44Message - The BEP44 message to be published, containing the signed DNS packet.
 * @returns A promise resolving to `true` if the message was successfully published, otherwise `false`.
 */
export async function pkarrPut({ gatewayUri, bep44Message, allowPrivateGatewayUri = false }: {
  bep44Message: Bep44Message;
  gatewayUri: string;
  allowPrivateGatewayUri?: boolean;
}): Promise<boolean> {
  // The identifier (key in the DHT) is the z-base-32 encoding of the Identity Key.
  const identifier = Convert.uint8Array(bep44Message.k).toBase32Z();

  // Concatenate the gateway URI with the identifier to form the full URL.
  const url = pkarrUrl(bep44Message.k, gatewayUri);

  // Construct the body of the request according to the Pkarr relay specification.
  const body = new Uint8Array(bep44Message.v.length + 72);
  body.set(bep44Message.sig, 0);
  new DataView(body.buffer).setBigUint64(bep44Message.sig.length, BigInt(bep44Message.seq));
  body.set(bep44Message.v, bep44Message.sig.length + 8);

  // Transmit the Put request to the Pkarr relay and get the response. Redirects are followed
  // manually so each `Location` is re-validated.
  let response: Response;
  try {
    response = await pkarrFetch(url, {
      method  : 'PUT',
      headers : { 'Content-Type': 'application/octet-stream' },
      body,
      signal  : AbortSignal.timeout(30_000),
    }, allowPrivateGatewayUri);

  } catch (error: any) {
    if (error instanceof DidError) {throw error;}
    throw new DidError(DidErrorCode.InternalError, `Failed to put Pkarr record for identifier ${identifier}: ${error.message}`);
  }

  // Return `true` if the DHT request was successful, otherwise return `false`.
  return response.ok;
}

/**
 * Creates a BEP44 put message, which is used to publish a DID document to the DHT network.
 *
 * @param params - The parameters to use when creating the BEP44 put message.
 * @param params.dnsPacket - The DNS packet to encode in the BEP44 message.
 * @param params.publicKeyBytes - The public key bytes of the Identity Key.
 * @param params.signer - Signer that can sign and verify data using the Identity Key.
 * @returns A promise that resolves to a BEP44 put message.
 */
export async function createBep44PutMessage({ dnsPacket, publicKeyBytes, signer }: {
  dnsPacket: Packet;
  publicKeyBytes: Uint8Array;
  signer: Signer;
}): Promise<Bep44Message> {
  // BEP44 requires that the sequence number be a monotoically increasing integer, so we use the
  // current time in seconds since Unix epoch as a simple solution. Higher precision is not
  // recommended since DID DHT documents are not expected to change frequently and there are
  // small differences in system clocks that can cause issues if multiple clients are publishing
  // updates to the same DID document.
  const sequenceNumber = Math.ceil(Date.now() / 1000);

  // Encode the DNS packet into a byte array containing a UDP payload.
  const encodedDnsPacket = dnsPacketEncode(dnsPacket);

  // Encode the sequence and DNS byte array to the BEP44 signing payload.
  const signingPayload = encodeBep44SigningPayload({ sequenceNumber, value: encodedDnsPacket });

  if (signingPayload.length > 1000) {
    throw new DidError(DidErrorCode.InvalidDidDocumentLength, `DNS packet exceeds the 1000 byte maximum size: ${signingPayload.length} bytes`);
  }

  // Sign the BEP44 message.
  const signature = await signer.sign({ data: signingPayload });

  return { k: publicKeyBytes, seq: sequenceNumber, sig: signature, v: encodedDnsPacket };
}

/**
 * Parses and verifies a BEP44 Get message, converting it to a DNS packet.
 *
 * @param params - The parameters to use when verifying and parsing the BEP44 Get response message.
 * @param params.bep44Message - The BEP44 message to verify and parse.
 * @returns A promise that resolves to a DNS packet.
 */
export async function parseBep44GetMessage({ bep44Message }: {
  bep44Message: Bep44Message;
}): Promise<Packet> {
  // Convert the public key byte array to JWK format.
  const publicKey = await Ed25519.bytesToPublicKey({ publicKeyBytes: bep44Message.k });

  // Encode the sequence and DNS byte array to the BEP44 signing payload.
  const signingPayload = encodeBep44SigningPayload({ sequenceNumber: bep44Message.seq, value: bep44Message.v });

  // Verify the signature of the BEP44 message.
  const isValid = await Ed25519.verify({
    key       : publicKey,
    signature : bep44Message.sig,
    data      : signingPayload
  });

  if (!isValid) {
    throw new DidError(DidErrorCode.InvalidSignature, `Invalid signature for DHT BEP44 message`);
  }

  return dnsPacketDecode(bep44Message.v);
}
