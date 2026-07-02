import { DidDht, DidJwk, DidWeb } from '@enbox/dids';

/**
 * @typedef DidResolutionResult
 * @property {Record<string, unknown> | null} didDocument
 * @property {Record<string, unknown>} didDocumentMetadata
 * @property {Record<string, unknown>} didResolutionMetadata
 */

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
    const didResolutionResult = await DidWeb.resolve(did);
    const didDocument = didResolutionResult.didDocument;

    if (didDocument === null || didDocument === undefined) {
      const message = didResolutionResult.didResolutionMetadata?.errorMessage
        ?? didResolutionResult.didResolutionMetadata?.message
        ?? 'DID document not found';
      return createErrorResult(message, 'didWebResolutionError', {
        resolver: '@enbox/dids',
        method: 'did:web',
      });
    }

    if (didDocument.id !== did) {
      throw new Error('DID document id does not match requested DID');
    }

    return {
      didDocument,
      didDocumentMetadata: {},
      didResolutionMetadata: {
        ...(didResolutionResult.didResolutionMetadata ?? {}),
        resolver: '@enbox/dids',
        method: 'did:web',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown did:web resolution error';
    return createErrorResult(message, 'didWebResolutionError', {
      resolver: '@enbox/dids',
      method: 'did:web',
    });
  }
}

/**
 * @param {string} did
 * @returns {Promise<DidResolutionResult>}
 */
async function resolveDidJwk(did) {
  try {
    const didResolutionResult = await DidJwk.resolve(did);
    const didDocument = didResolutionResult.didDocument;

    if (didDocument === null || didDocument === undefined) {
      const message = didResolutionResult.didResolutionMetadata?.errorMessage
        ?? didResolutionResult.didResolutionMetadata?.message
        ?? 'DID document not found';
      return createErrorResult(message, 'invalidDid', {
        resolver: '@enbox/dids',
        method: 'did:jwk',
      });
    }

    return {
      didDocument,
      didDocumentMetadata: didResolutionResult.didDocumentMetadata ?? {},
      didResolutionMetadata: {
        ...(didResolutionResult.didResolutionMetadata ?? {}),
        resolver: '@enbox/dids',
        method: 'did:jwk',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown did:jwk resolution error';
    return createErrorResult(message, 'invalidDid', {
      resolver: '@enbox/dids',
      method: 'did:jwk',
    });
  }
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
