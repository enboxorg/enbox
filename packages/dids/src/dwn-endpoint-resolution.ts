import type { DidDocument } from './types/did-core.js';
import type { DidResolver } from './types/did-resolution.js';

export type DwnEndpointResolution =
  | {
    status: 'ready';
    didUri: string;
    endpoints: string[];
  }
  | {
    status: 'service-missing' | 'service-malformed' | 'resolution-failed';
    didUri: string;
    message: string;
    resolutionError?: string;
  };

type DwnEndpointFailureStatus = Exclude<DwnEndpointResolution['status'], 'ready'>;

function failure(
  status: DwnEndpointFailureStatus,
  didUri: string,
  message: string,
  resolutionError?: string,
): DwnEndpointResolution {
  return { status, didUri, message, ...(resolutionError === undefined ? {} : { resolutionError }) };
}

function isDwnServiceId(id: string, didUri: string): boolean {
  return id === `${didUri}#dwn` || id === '#dwn' || id === 'dwn';
}

function normalizeEndpointUrls(values: unknown): string[] | undefined {
  const candidates = typeof values === 'string' ? [values] : values;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.some(value => typeof value !== 'string')) {
    return undefined;
  }

  try {
    const endpoints = candidates.map(value => {
      const endpoint = new URL(value);
      if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
        || endpoint.search !== '' || endpoint.hash !== '') {
        throw new TypeError();
      }
      return endpoint.toString().replace(/\/$/, '');
    });
    return [...new Set(endpoints)];
  } catch {
    return undefined;
  }
}

/** Read and validate the canonical `#dwn` service from a DID document. */
export function getDwnEndpointStatus(
  didUri: string,
  didDocument: DidDocument,
): DwnEndpointResolution {
  const dwnService = didDocument.service?.find(service => isDwnServiceId(service.id, didUri));

  if (dwnService === undefined) {
    return failure('service-missing', didUri, `DID '${didUri}' does not advertise a #dwn service.`);
  }

  if (dwnService.type !== 'DecentralizedWebNode') {
    return failure('service-malformed', didUri, `DID '${didUri}' has a malformed #dwn service.`);
  }

  const endpoints = normalizeEndpointUrls(dwnService.serviceEndpoint);
  if (endpoints === undefined) {
    return failure('service-malformed', didUri, `DID '${didUri}' has an invalid #dwn service endpoint.`);
  }

  return { status: 'ready', didUri, endpoints };
}

/** Return a cloned DID document with only its canonical `#dwn` endpoint URLs replaced. */
export function replaceDwnServiceEndpointUrls(
  didDocument: DidDocument,
  endpointUrls: string[],
): DidDocument {
  const endpoints = normalizeEndpointUrls(endpointUrls);
  if (endpoints === undefined) {
    throw new TypeError(`DID '${didDocument.id}' has an invalid #dwn service endpoint.`);
  }

  const updated = structuredClone(didDocument);
  const services = updated.service ?? [];
  const existing = services.find(service => isDwnServiceId(service.id, didDocument.id));
  updated.service = [...services.filter(service => !isDwnServiceId(service.id, didDocument.id)), {
    ...existing,
    id              : `${didDocument.id}#dwn`,
    type            : 'DecentralizedWebNode',
    serviceEndpoint : endpoints,
  }];
  return updated;
}

/** Resolve a DID and return a dapp-friendly DWN endpoint status. */
export async function resolveDwnEndpointStatus(
  didUri: string,
  resolver: Pick<DidResolver, 'resolve'>,
): Promise<DwnEndpointResolution> {
  try {
    const result = await resolver.resolve(didUri);
    if (result.didResolutionMetadata.error !== undefined || result.didDocument === null) {
      return failure(
        'resolution-failed',
        didUri,
        result.didResolutionMetadata.errorMessage
          ?? `Unable to resolve DID '${didUri}'.`,
        result.didResolutionMetadata.error,
      );
    }

    return getDwnEndpointStatus(didUri, result.didDocument);
  } catch (error: unknown) {
    return failure(
      'resolution-failed',
      didUri,
      error instanceof Error ? error.message : `Unable to resolve DID '${didUri}'.`,
    );
  }
}
