import { CachedResolver } from '@digitalbazaar/did-io';
import { base64ToBytes } from 'did-jwt';
import { DidDht } from '../../../../dids/dist/esm/methods/did-dht.js';

/**
 * @typedef DidResolutionResult
 * @property {Record<string, unknown> | null} didDocument
 * @property {Record<string, unknown>} didDocumentMetadata
 * @property {Record<string, unknown>} didResolutionMetadata
 */

const didIoResolver = new CachedResolver({
  max: 100,
  maxAge: 15_000,
});

/**
 * @returns {typeof fetch}
 */
function getSafeFetch() {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    return window.fetch.bind(window);
  }

  return fetch;
}

/**
 * @param {string} did
 * @returns {string}
 */
function buildDidWebDocumentUrl(did) {
  const segments = did.trim().split(':');
  if (segments.length < 3 || segments[0] !== 'did' || segments[1].toLowerCase() !== 'web') {
    throw new Error('Invalid did:web identifier');
  }

  const methodSpecificId = segments.slice(2);
  if (methodSpecificId.length === 0 || methodSpecificId[0].length === 0) {
    throw new Error('did:web must include a host segment');
  }

  const host = decodeURIComponent(methodSpecificId[0]);
  const pathSegments = methodSpecificId.slice(1).map((segment) => decodeURIComponent(segment));
  const path = pathSegments.map((segment) => encodeURIComponent(segment)).join('/');

  const didDocumentPath = path.length > 0 ? `${path}/did.json` : '.well-known/did.json';
  return `https://${host}/${didDocumentPath}`;
}

didIoResolver.use({
  method: 'web',
  /**
   * @param {{ did: string }} options
   * @returns {Promise<Record<string, unknown>>}
   */
  async get({ did }) {
    let didDocumentUrl = '';
    try {
      didDocumentUrl = buildDidWebDocumentUrl(did);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid did:web identifier';
      throw new Error(message);
    }

    const safeFetch = getSafeFetch();
    const response = await safeFetch(didDocumentUrl, {
      headers: {
        accept: 'application/did+ld+json, application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`DID document request failed with status ${response.status}`);
    }

    const didDocument = await response.json();
    if (!didDocument || typeof didDocument !== 'object') {
      throw new Error('DID document payload was empty or malformed');
    }

    if (typeof didDocument.id !== 'string' || didDocument.id !== did) {
      throw new Error('DID document id does not match requested DID');
    }

    return /** @type {Record<string, unknown>} */ (didDocument);
  },
});

/**
 * @param {string} message
 * @param {string} [errorCode]
 * @param {Record<string, unknown>} [extraMetadata]
 * @returns {DidResolutionResult}
 */
function createErrorResult(message, errorCode = 'resolutionError', extraMetadata = {}) {
  return {
    didDocument: null,
    didDocumentMetadata: {},
    didResolutionMetadata: {
      error: errorCode,
      message,
      ...extraMetadata,
    },
  };
}

/**
 * @returns {string | undefined}
 */
function getDidDhtGatewayUri() {
  const configuredGatewayUri = typeof process !== 'undefined'
    && typeof process.env?.DID_DHT_GATEWAY_URI === 'string'
    ? process.env.DID_DHT_GATEWAY_URI.trim()
    : '';

  if (configuredGatewayUri.length === 0) {
    return undefined;
  }

  return configuredGatewayUri;
}

/**
 * @param {string} did
 * @returns {string | null}
 */
export function getDidMethodPrefix(did) {
  const normalizedDid = did.trim().toLowerCase();
  if (!normalizedDid.startsWith('did:')) {
    return null;
  }

  const segments = normalizedDid.split(':');
  if (segments.length < 3 || segments[1].length === 0) {
    return null;
  }

  return `did:${segments[1]}`;
}

/**
 * @param {string} did
 * @returns {Promise<DidResolutionResult>}
 */
async function resolveDidWeb(did) {
  try {
    const didDocument = await didIoResolver.get({ did });

    return {
      didDocument,
      didDocumentMetadata: {},
      didResolutionMetadata: {
        resolver: '@digitalbazaar/did-io',
        method: 'did:web',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown did:web resolution error';
    return createErrorResult(message, 'didWebResolutionError', {
      resolver: '@digitalbazaar/did-io',
      method: 'did:web',
    });
  }
}

/**
 * @param {string} did
 * @returns {Promise<DidResolutionResult>}
 */
async function resolveDidJwk(did) {
  const segments = did.trim().split(':');
  if (segments.length !== 3 || segments[0] !== 'did' || segments[1].toLowerCase() !== 'jwk') {
    return createErrorResult('Invalid did:jwk identifier', 'invalidDid');
  }

  const encodedJwk = segments[2];
  if (encodedJwk.length === 0) {
    return createErrorResult('Missing did:jwk method-specific identifier', 'invalidDid');
  }

  let publicKeyJwk;
  try {
    const jwkBytes = base64ToBytes(encodedJwk);
    const jwkString = new TextDecoder().decode(jwkBytes);
    const decodedJwk = JSON.parse(jwkString);

    if (!decodedJwk || typeof decodedJwk !== 'object' || Array.isArray(decodedJwk)) {
      return createErrorResult('did:jwk payload must decode to a JSON object', 'invalidDidDocument');
    }

    publicKeyJwk = /** @type {Record<string, unknown>} */ (decodedJwk);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to decode did:jwk payload';
    return createErrorResult(`Failed to decode did:jwk payload: ${message}`, 'invalidDid');
  }

  if (typeof publicKeyJwk.kty !== 'string' || publicKeyJwk.kty.length === 0) {
    return createErrorResult('did:jwk payload is missing required "kty"', 'invalidDidDocument');
  }

  const verificationMethodId = `${did}#0`;
  const didDocument = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [
      {
        id: verificationMethodId,
        type: 'JsonWebKey2020',
        controller: did,
        publicKeyJwk,
      },
    ],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
    capabilityInvocation: [verificationMethodId],
    capabilityDelegation: [verificationMethodId],
  };

  return {
    didDocument,
    didDocumentMetadata: {},
    didResolutionMetadata: {
      resolver: 'did-jwt',
      method: 'did:jwk',
    },
  };
}

/**
 * @param {string} did
 * @returns {Promise<DidResolutionResult>}
 */
async function resolveDidDht(did) {
  const gatewayUri = getDidDhtGatewayUri();

  try {
    const didResolutionResult = gatewayUri
      ? await DidDht.resolve(did, { gatewayUri })
      : await DidDht.resolve(did);
    const didResolutionMetadata = {
      ...(didResolutionResult.didResolutionMetadata ?? {}),
      resolver: '@enbox/dids',
      method: 'did:dht',
      ...(gatewayUri ? { gatewayUri } : {}),
    };

    // Normalize error shape for UI consistency across resolver implementations.
    if (
      typeof didResolutionMetadata.message !== 'string'
      && typeof didResolutionMetadata.errorMessage === 'string'
    ) {
      didResolutionMetadata.message = didResolutionMetadata.errorMessage;
    }

    return {
      didDocument: didResolutionResult.didDocument ?? null,
      didDocumentMetadata: didResolutionResult.didDocumentMetadata ?? {},
      didResolutionMetadata,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown did:dht resolution error';
    return createErrorResult(message, 'didDhtResolutionError', {
      resolver: '@enbox/dids',
      method: 'did:dht',
      ...(gatewayUri ? { gatewayUri } : {}),
    });
  }
}

export const supportedDidMethods = {
  'did:dht': {
    resolve: resolveDidDht,
  },
  'did:web': {
    resolve: resolveDidWeb,
  },
  'did:jwk': {
    resolve: resolveDidJwk,
  },
};

/**
 * @param {string} did
 */
export function getDidResolverDefinition(did) {
  const methodPrefix = getDidMethodPrefix(did);
  if (!methodPrefix) {
    return null;
  }

  return supportedDidMethods[methodPrefix] ?? null;
}

export function createDidResolverRuntime() {
  return {
    supportedDidMethods,
    getDidMethodPrefix,
    getDidResolverDefinition,
  };
}
