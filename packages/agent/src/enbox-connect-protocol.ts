/**
 * Enbox Connect Protocol
 *
 * A capability delegation protocol for DWN access. Enables apps to request
 * scoped permission grants from a wallet (provider), receiving a delegate DID
 * with the granted permissions.
 *
 * Two transport modes:
 * - Local (`dwn://connect`): same-device, direct HTTP against the local DWN
 * - Remote (`enbox://connect`): cross-device, relay-mediated with QR/deep link
 *
 * The protocol uses JWTs for signing, JWE (XChaCha20-Poly1305) for encryption,
 * and ECDH (Ed25519 → X25519 + HKDF) for key agreement.
 */

import type { EnboxPlatformAgent } from './types/agent.js';
import type { RequireOnly } from '@enbox/common';
import type { DidDocument, PortableDid } from '@enbox/dids';
import type { DwnDataEncodedRecordsWriteMessage, DwnPermissionScope, DwnProtocolDefinition } from './types/dwn.js';

/**
 * The protocols of permissions requested, along with the definition and permission scopes for each protocol.
 */
export type ConnectPermissionRequest = {
  /**
   * The definition of the protocol the permissions are being requested for.
   * In the event that the protocol is not already installed, the wallet will install this given protocol definition.
   */
  protocolDefinition: DwnProtocolDefinition;

  /** The scope of the permissions being requested for the given protocol */
  permissionScopes: DwnPermissionScope[];
};
import type {
  JoseHeaderParams,
  Jwk } from '@enbox/crypto';

import { type BearerDid, DidJwk } from '@enbox/dids';
import { Convert, logger } from '@enbox/common';
import {
  CryptoUtils,
  Ed25519,
  EdDsaAlgorithm,
  Hkdf,
  X25519,
  XChaCha20Poly1305,
} from '@enbox/crypto';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from './permissions-api.js';
import { concatenateUrl } from './utils.js';
import { DwnInterface } from './types/dwn.js';
import { isRecordPermissionScope } from './dwn-api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pushed to the connect server so the wallet can retrieve it later.
 * The request is encrypted (JWE) before being pushed.
 *
 * Inspired by RFC 9126 (Pushed Authorization Requests).
 */
export type ConnectPushedRequest = {
  /** The encrypted JWE containing the signed {@link EnboxConnectRequest} JWT. */
  request: string;
};

/**
 * Returned by the connect server after a {@link ConnectPushedRequest}.
 * Contains a URI the wallet uses to fetch the encrypted request,
 * and the TTL before it expires.
 */
export type ConnectPushedResponse = {
  /** URI where the wallet can fetch the encrypted auth request. */
  request_uri: string;
  /** Seconds until the request expires. */
  expires_in: number;
};

/**
 * A connect request from an app to a wallet, asking for DWN permissions.
 *
 * The app creates this, signs it as a JWT, encrypts it as a JWE, and pushes
 * it to the connect server. The wallet retrieves, decrypts, verifies, and
 * displays it in a consent UI.
 */
export type EnboxConnectRequest = {
  /** Ephemeral DID (did:jwk) used for ECDH key agreement and request signing. */
  clientDid: string;

  /** Human-readable name of the requesting application, shown in the consent UI. */
  appName: string;

  /** DWN protocols and permission scopes being requested. */
  permissionRequests: ConnectPermissionRequest[];

  /** Anti-replay nonce (random base64url). */
  nonce: string;

  /** State correlator for matching request to response (random base64url). */
  state: string;

  /** URL where the wallet should POST the encrypted response. */
  callbackUrl: string;

  /** Response mode — always `direct_post` (wallet POSTs response to callbackUrl). */
  responseMode: 'direct_post';

  /** Supported DID methods for the connected identity. */
  supportedDidMethods: string[];
};

/**
 * A connect response from a wallet, granting DWN permissions.
 *
 * The wallet creates this after user consent, signs it as a JWT with the
 * delegate DID, encrypts it via ECDH, and POSTs it to the connect server.
 * The app retrieves, decrypts (using ECDH + optional PIN), and verifies it.
 */
export type EnboxConnectResponse = {
  /** The wallet owner's real DID that authorised the delegation. */
  providerDid: string;

  /** The newly created delegate DID identifier. */
  delegateDid: string;

  /** Audience — must match the `clientDid` from the request. */
  aud: string;

  /** Issued-at timestamp (Unix seconds). */
  iat: number;

  /** Expiration timestamp (Unix seconds). */
  exp: number;

  /** Echo of the request nonce. */
  nonce?: string;

  /** DWN permission grant messages (serialised RecordsWrite with encoded data). */
  delegateGrants: DwnDataEncodedRecordsWriteMessage[];

  /** The delegate DID's full portable form, including private keys. */
  delegatePortableDid: PortableDid;
};

/** The connect server endpoint types. */
export type ConnectEndpoint =
  | 'pushedAuthorizationRequest'
  | 'authorize'
  | 'callback'
  | 'token';

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/**
 * Builds the URL for a connect server endpoint.
 *
 * @param options.baseURL - The connect server base URL (e.g. `http://localhost:3000/connect/`)
 * @param options.endpoint - The endpoint type
 * @param options.authParam - Required for `authorize` endpoint (the request ID)
 * @param options.tokenParam - Required for `token` endpoint (the state value)
 */
function buildConnectUrl({
  baseURL,
  endpoint,
  authParam,
  tokenParam,
}: {
  baseURL: string;
  endpoint: ConnectEndpoint;
  authParam?: string;
  tokenParam?: string;
}): string {
  switch (endpoint) {
    case 'pushedAuthorizationRequest':
      return concatenateUrl(baseURL, 'par');
    case 'authorize':
      if (!authParam) {
        throw new Error('authParam must be provided when building an authorize URL');
      }
      return concatenateUrl(baseURL, `authorize/${authParam}.jwt`);
    case 'callback':
      return concatenateUrl(baseURL, 'callback');
    case 'token':
      if (!tokenParam) {
        throw new Error('tokenParam must be provided when building a token URL');
      }
      return concatenateUrl(baseURL, `token/${tokenParam}.jwt`);
    default:
      throw new Error(`Unknown connect endpoint: ${endpoint}`);
  }
}

// ---------------------------------------------------------------------------
// JWT signing and verification
// ---------------------------------------------------------------------------

/** Signs an object as a JWT using an Ed25519 DID key. */
async function signJwt({
  did,
  data,
}: {
  did: BearerDid;
  data: Record<string, unknown>;
}): Promise<string> {
  const header = Convert.object({
    alg : 'EdDSA',
    kid : did.document.verificationMethod![0].id,
    typ : 'JWT',
  }).toBase64Url();

  const payload = Convert.object(data).toBase64Url();

  const signer = await did.getSigner();
  const signature = await signer.sign({
    data: Convert.string(`${header}.${payload}`).toUint8Array(),
  });

  const signatureBase64Url = Convert.uint8Array(signature).toBase64Url();
  return `${header}.${payload}.${signatureBase64Url}`;
}

/** Verifies a JWT signature using the DID in the `kid` header. Returns the parsed payload. */
async function verifyJwt({ jwt }: { jwt: string }): Promise<Record<string, unknown>> {
  const [headerB64U, payloadB64U, signatureB64U] = jwt.split('.');

  const header: JoseHeaderParams = Convert.base64Url(headerB64U).toObject();

  if (!header.kid) {
    throw new Error('Connect: JWT missing required "kid" header value.');
  }

  const { didDocument } = await DidJwk.resolve(header.kid.split('#')[0]);

  if (!didDocument) {
    throw new Error('Connect: JWT verification failed — could not resolve DID.');
  }

  const { publicKeyJwk } =
    didDocument.verificationMethod?.find((method: any) => {
      return method.id === header.kid;
    }) ?? {};

  if (!publicKeyJwk) {
    throw new Error('Connect: JWT verification failed — public key not found in DID document.');
  }

  const EdDsa = new EdDsaAlgorithm();
  const isValid = await EdDsa.verify({
    key       : publicKeyJwk,
    signature : Convert.base64Url(signatureB64U).toUint8Array(),
    data      : Convert.string(`${headerB64U}.${payloadB64U}`).toUint8Array(),
  });

  if (!isValid) {
    throw new Error('Connect: JWT verification failed — invalid signature.');
  }

  return Convert.base64Url(payloadB64U).toObject() as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Encryption: request (symmetric key via QR/deep link)
// ---------------------------------------------------------------------------

/** Encrypts the connect request JWT with a symmetric key (shared via QR code or deep link). */
async function encryptRequest({
  jwt,
  encryptionKey,
}: {
  jwt: string;
  encryptionKey: Uint8Array;
}): Promise<string> {
  const protectedHeader = {
    alg : 'dir',
    cty : 'JWT',
    enc : 'XC20P',
    typ : 'JWT',
  };
  const nonce = CryptoUtils.randomBytes(24);
  const additionalData = Convert.object(protectedHeader).toUint8Array();
  const jwtBytes = Convert.string(jwt).toUint8Array();
  const ciphertextAndTag = await XChaCha20Poly1305.encryptRaw({ data: jwtBytes, keyBytes: encryptionKey, nonce, additionalData });

  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const authenticationTag = ciphertextAndTag.subarray(-16);

  return [
    Convert.object(protectedHeader).toBase64Url(),
    '', // No wrapped key (direct encryption).
    Convert.uint8Array(nonce).toBase64Url(),
    Convert.uint8Array(ciphertext).toBase64Url(),
    Convert.uint8Array(authenticationTag).toBase64Url(),
  ].join('.');
}

/** Decrypts an encrypted connect request JWE using the symmetric key from the QR/deep link. */
async function decryptRequest({
  jwe,
  encryptionKey,
}: {
  jwe: string;
  encryptionKey: string;
}): Promise<string> {
  const [
    protectedHeaderB64U,
    ,
    nonceB64U,
    ciphertextB64U,
    authenticationTagB64U,
  ] = jwe.split('.');

  const encryptionKeyBytes = Convert.base64Url(encryptionKey).toUint8Array();
  const additionalData = Convert.base64Url(protectedHeaderB64U).toUint8Array();
  const nonce = Convert.base64Url(nonceB64U).toUint8Array();
  const ciphertext = Convert.base64Url(ciphertextB64U).toUint8Array();
  const authenticationTag = Convert.base64Url(authenticationTagB64U).toUint8Array();

  const ciphertextAndTag = new Uint8Array([...ciphertext, ...authenticationTag]);
  const decryptedJwtBytes = await XChaCha20Poly1305.decryptRaw({ data: ciphertextAndTag, keyBytes: encryptionKeyBytes, nonce, additionalData });

  return Convert.uint8Array(decryptedJwtBytes).toString();
}

// ---------------------------------------------------------------------------
// Encryption: response (ECDH shared key + optional PIN)
// ---------------------------------------------------------------------------

/** Derives a shared ECDH key for encrypting/decrypting the connect response. */
async function deriveSharedKey(
  privateKeyDid: BearerDid,
  publicKeyDid: DidDocument
): Promise<Uint8Array> {
  const privatePortableDid = await privateKeyDid.export();

  const publicJwk = publicKeyDid.verificationMethod?.[0].publicKeyJwk!;
  const privateJwk = privatePortableDid.privateKeys?.[0]!;
  publicJwk.alg = 'EdDSA';

  const publicX25519 = await Ed25519.convertPublicKeyToX25519({ publicKey: publicJwk });
  const privateX25519 = await Ed25519.convertPrivateKeyToX25519({ privateKey: privateJwk });

  const sharedKey = await X25519.sharedSecret({
    privateKeyA : privateX25519,
    publicKeyB  : publicX25519,
  });

  return Hkdf.deriveKeyBytes({
    baseKeyBytes : new Uint8Array(sharedKey),
    hash         : 'SHA-256',
    salt         : new Uint8Array(),
    info         : new Uint8Array(),
    length       : 256,
  });
}

/**
 * Encrypts the connect response JWT.
 *
 * For remote (relay-mediated) flows, `pin` is required — it is added to the
 * AAD to prevent MITM attacks via the untrusted relay.
 *
 * For local (same-device) flows, `pin` may be omitted — the ECDH encryption
 * alone is sufficient when there is no untrusted intermediary.
 */
async function encryptResponse({
  jwt,
  encryptionKey,
  delegateDidKeyId,
  pin,
}: {
  jwt: string;
  encryptionKey: Uint8Array;
  delegateDidKeyId: string;
  pin?: string;
}): Promise<string> {
  const protectedHeader = {
    alg : 'dir',
    cty : 'JWT',
    enc : 'XC20P',
    typ : 'JWT',
    kid : delegateDidKeyId,
  };
  const nonce = CryptoUtils.randomBytes(24);

  // Build AAD — include PIN if provided (remote flows).
  const aadObject = pin
    ? { ...protectedHeader, pin }
    : { ...protectedHeader };
  const additionalData = Convert.object(aadObject).toUint8Array();

  const jwtBytes = Convert.string(jwt).toUint8Array();
  const ciphertextAndTag = await XChaCha20Poly1305.encryptRaw({ data: jwtBytes, keyBytes: encryptionKey, nonce, additionalData });

  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const authenticationTag = ciphertextAndTag.subarray(-16);

  return [
    Convert.object(protectedHeader).toBase64Url(),
    '', // No wrapped key (direct encryption).
    Convert.uint8Array(nonce).toBase64Url(),
    Convert.uint8Array(ciphertext).toBase64Url(),
    Convert.uint8Array(authenticationTag).toBase64Url(),
  ].join('.');
}

/**
 * Decrypts the connect response JWE using ECDH + optional PIN.
 *
 * @param clientDid - The ephemeral DID used at connect initiation (for ECDH).
 * @param jwe - The encrypted response JWE.
 * @param pin - The PIN entered by the user (required for remote flows, omit for local).
 */
async function decryptResponse(
  clientDid: BearerDid,
  jwe: string,
  pin?: string
): Promise<string> {
  const [
    protectedHeaderB64U,
    ,
    nonceB64U,
    ciphertextB64U,
    authenticationTagB64U,
  ] = jwe.split('.');

  const header = Convert.base64Url(protectedHeaderB64U).toObject() as Jwk;
  if (!header.kid) {
    throw new Error('Connect: JWE protected header is missing required "kid" property.');
  }
  const delegateResolvedDid = await DidJwk.resolve(header.kid.split('#')[0]);

  const sharedKey = await EnboxConnectProtocol.deriveSharedKey(
    clientDid,
    delegateResolvedDid.didDocument!
  );

  // Build AAD — include PIN if provided (must match what was used during encryption).
  const aadObject = pin
    ? { ...header, pin }
    : { ...header };
  const AAD = Convert.object(aadObject).toUint8Array();

  const nonce = Convert.base64Url(nonceB64U).toUint8Array();
  const ciphertext = Convert.base64Url(ciphertextB64U).toUint8Array();
  const authenticationTag = Convert.base64Url(authenticationTagB64U).toUint8Array();

  const ciphertextAndTag = new Uint8Array([...ciphertext, ...authenticationTag]);
  const decryptedJwtBytes = await XChaCha20Poly1305.decryptRaw({ data: ciphertextAndTag, keyBytes: sharedKey, nonce, additionalData: AAD });

  return Convert.uint8Array(decryptedJwtBytes).toString();
}

// ---------------------------------------------------------------------------
// Request creation and retrieval
// ---------------------------------------------------------------------------

/** Creates an {@link EnboxConnectRequest}. */
async function createConnectRequest(
  options: RequireOnly<
    EnboxConnectRequest,
    'clientDid' | 'callbackUrl' | 'permissionRequests' | 'appName'
  >
): Promise<EnboxConnectRequest> {
  const stateBytes = CryptoUtils.randomBytes(16);
  const nonceBytes = CryptoUtils.randomBytes(16);

  return {
    ...options,
    nonce               : Convert.uint8Array(nonceBytes).toBase64Url(),
    responseMode        : 'direct_post',
    state               : Convert.uint8Array(stateBytes).toBase64Url(),
    supportedDidMethods : options.supportedDidMethods ?? ['did:dht', 'did:jwk'],
  };
}

/**
 * Fetches an encrypted connect request from the authorize endpoint
 * and decrypts it using the encryption key from the QR/deep link.
 */
async function getConnectRequest(requestUri: string, encryptionKey: string): Promise<EnboxConnectRequest> {
  const response = await fetch(requestUri, { signal: AbortSignal.timeout(30_000) });
  const jwe = await response.text();
  const jwt = await decryptRequest({ jwe, encryptionKey });
  return (await verifyJwt({ jwt })) as unknown as EnboxConnectRequest;
}

// ---------------------------------------------------------------------------
// Response creation
// ---------------------------------------------------------------------------

/** Creates an {@link EnboxConnectResponse} with timestamps. */
async function createConnectResponse(
  options: RequireOnly<
    EnboxConnectResponse,
    'providerDid' | 'delegateDid' | 'aud' | 'delegateGrants' | 'delegatePortableDid'
  >
): Promise<EnboxConnectResponse> {
  const currentTimeInSeconds = Math.floor(Date.now() / 1000);

  return {
    ...options,
    iat : currentTimeInSeconds,
    exp : currentTimeInSeconds + 600, // 10 minutes
  };
}

// ---------------------------------------------------------------------------
// Permission grants
// ---------------------------------------------------------------------------

function shouldUseDelegatePermission(scope: DwnPermissionScope): boolean {
  if (isRecordPermissionScope(scope)) {
    return true;
  } else if (scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Configure) {
    return true;
  }
  return false;
}

/**
 * Creates permission grants that assign the requested scopes to a delegate DID.
 */
async function createPermissionGrants(
  selectedDid: string,
  delegateBearerDid: BearerDid,
  agent: EnboxPlatformAgent,
  scopes: DwnPermissionScope[],
): Promise<DwnDataEncodedRecordsWriteMessage[]> {
  const permissionsApi = new AgentPermissionsApi({ agent });

  logger.log(`Creating permission grants for ${scopes.length} scopes...`);
  const permissionGrants = await Promise.all(
    scopes.map((scope) => {
      const delegated = shouldUseDelegatePermission(scope);
      return permissionsApi.createGrant({
        delegated,
        store       : true,
        grantedTo   : delegateBearerDid.uri,
        scope,
        dateExpires : '2040-06-25T16:09:16.693356Z', // TODO: make dateExpires configurable
        author      : selectedDid,
      });
    })
  );

  // Resolve all DWN endpoints for the selected DID.  `sendDwnRequest` only
  // sends to the first reachable endpoint, but the sync engine may connect
  // to a different one and needs the grant to authenticate.  We send each
  // grant to every endpoint so that sync works regardless of which DWN the
  // agent contacts first.
  const dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
  logger.log(`Sending ${permissionGrants.length} permission grants to ${dwnEndpointUrls.length} DWN endpoint(s)...`);

  const messagePromises = permissionGrants.map(async (grant) => {
    const { encodedData, ...rawMessage } = grant.message;
    const data = Convert.base64Url(encodedData).toUint8Array();

    // The rawMessage is already signed by createGrant(), so we send it
    // directly to each endpoint without re-constructing.
    let atLeastOneSuccess = false;
    for (const dwnUrl of dwnEndpointUrls) {
      try {
        const reply = await agent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid : selectedDid,
          message   : rawMessage,
          data      : new Blob([data as BlobPart]),
        });

        if (reply.status.code === 202 || reply.status.code === 409) {
          atLeastOneSuccess = true;
        } else {
          logger.error(`Grant send to ${dwnUrl} returned ${reply.status.code}: ${reply.status.detail}`);
        }
      } catch (error: any) {
        logger.error(`Grant send to ${dwnUrl} failed: ${error.message}`);
      }
    }

    if (!atLeastOneSuccess) {
      throw new Error('Could not send permission grant to any DWN endpoint.');
    }

    return grant.message;
  });

  try {
    return await Promise.all(messagePromises);
  } catch (error) {
    logger.error(`Error during batch-send of permission grants: ${error}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Protocol installation
// ---------------------------------------------------------------------------

/**
 * Installs a DWN protocol on the provider's DWN if it doesn't already exist.
 * Ensures the protocol is available on both the local and remote DWN.
 */
async function prepareProtocol(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition
): Promise<void> {
  const queryMessage = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ProtocolsQuery,
    target        : selectedDid,
    messageParams : { filter: { protocol: protocolDefinition.protocol } },
  });

  if (queryMessage.reply.status.code !== 200) {
    throw new Error(`Could not fetch protocol: ${queryMessage.reply.status.detail}`);
  } else if (queryMessage.reply.entries === undefined || queryMessage.reply.entries.length === 0) {
    logger.log(`Protocol does not exist, creating: ${protocolDefinition.protocol}`);

    const { reply: sendReply, message: configureMessage } = await agent.sendDwnRequest({
      author        : selectedDid,
      target        : selectedDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: protocolDefinition },
    });

    if (sendReply.status.code !== 202 && sendReply.status.code !== 409) {
      throw new Error(`Could not send protocol: ${sendReply.status.detail}`);
    }

    await agent.processDwnRequest({
      author      : selectedDid,
      target      : selectedDid,
      messageType : DwnInterface.ProtocolsConfigure,
      rawMessage  : configureMessage
    });
  } else {
    logger.log(`Protocol already exists: ${protocolDefinition.protocol}`);

    const configureMessage = queryMessage.reply.entries![0];
    const { reply: sendReply } = await agent.sendDwnRequest({
      author      : selectedDid,
      target      : selectedDid,
      messageType : DwnInterface.ProtocolsConfigure,
      rawMessage  : configureMessage,
    });

    if (sendReply.status.code !== 202 && sendReply.status.code !== 409) {
      throw new Error(`Could not send protocol: ${sendReply.status.detail}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Full wallet-side flow (provider submits response)
// ---------------------------------------------------------------------------

/**
 * Executes the full wallet-side (provider) flow:
 * 1. Creates a delegate DID
 * 2. Installs requested protocols
 * 3. Creates permission grants
 * 4. Builds, signs, and encrypts the response
 * 5. POSTs the encrypted response to the callback URL
 *
 * @param selectedDid - The provider's DID that is granting access.
 * @param connectRequest - The decoded connect request from the app.
 * @param pin - The PIN for response encryption AAD (required for remote flows).
 * @param agent - The agent instance for DWN operations.
 */
async function submitConnectResponse(
  selectedDid: string,
  connectRequest: EnboxConnectRequest,
  pin: string | undefined,
  agent: EnboxPlatformAgent
): Promise<void> {
  const delegateBearerDid = await DidJwk.create();
  const delegatePortableDid = await delegateBearerDid.export();

  const delegateGrantPromises = connectRequest.permissionRequests.map(
    async (permissionRequest) => {
      const { protocolDefinition, permissionScopes } = permissionRequest;

      const grantsMatchProtocolUri = permissionScopes.every(
        scope => 'protocol' in scope && scope.protocol === protocolDefinition.protocol
      );
      if (!grantsMatchProtocolUri) {
        throw new Error('All permission scopes must match the protocol URI they are provided with.');
      }

      await prepareProtocol(selectedDid, agent, protocolDefinition);

      return EnboxConnectProtocol.createPermissionGrants(
        selectedDid,
        delegateBearerDid,
        agent,
        permissionScopes
      );
    }
  );

  const delegateGrants = (await Promise.all(delegateGrantPromises)).flat();

  logger.log('Building connect response...');
  const responseObject = await EnboxConnectProtocol.createConnectResponse({
    providerDid : selectedDid,
    delegateDid : delegateBearerDid.uri,
    aud         : connectRequest.clientDid,
    nonce       : connectRequest.nonce,
    delegateGrants,
    delegatePortableDid,
  });

  logger.log('Signing connect response...');
  const responseObjectJwt = await EnboxConnectProtocol.signJwt({
    did  : delegateBearerDid,
    data : responseObject as unknown as Record<string, unknown>,
  });

  const clientDid = await DidJwk.resolve(connectRequest.clientDid);

  const sharedKey = await EnboxConnectProtocol.deriveSharedKey(
    delegateBearerDid,
    clientDid?.didDocument!
  );

  logger.log('Encrypting connect response...');
  const encryptedResponse = await EnboxConnectProtocol.encryptResponse({
    jwt              : responseObjectJwt!,
    encryptionKey    : sharedKey,
    delegateDidKeyId : delegateBearerDid.document.verificationMethod![0].id,
    pin,
  });

  const formEncodedRequest = new URLSearchParams({
    id_token : encryptedResponse,
    state    : connectRequest.state,
  }).toString();

  logger.log(`Sending connect response to: ${connectRequest.callbackUrl}`);
  await fetch(connectRequest.callbackUrl, {
    body    : formEncodedRequest,
    method  : 'POST',
    headers : {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    signal: AbortSignal.timeout(30_000),
  });
}

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

export const EnboxConnectProtocol = {
  buildConnectUrl,
  signJwt,
  verifyJwt,
  encryptRequest,
  decryptRequest,
  encryptResponse,
  decryptResponse,
  deriveSharedKey,
  createConnectRequest,
  getConnectRequest,
  createConnectResponse,
  createPermissionGrants,
  submitConnectResponse,
};
