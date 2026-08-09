import type { DidResolver } from './types/did-resolution.js';
import type { DidDocument, DidService } from './types/did-core.js';

import { DidErrorCode } from './did-error.js';

/** Stable failure codes for resolving the DWN endpoints advertised by a DID document. */
export enum DwnEndpointResolutionErrorCode {
  DidResolutionFailed = 'DID_RESOLUTION_FAILED',
  ServiceMissing = 'DWN_SERVICE_MISSING',
  ServiceMalformed = 'DWN_SERVICE_MALFORMED',
  EndpointsMissing = 'DWN_ENDPOINTS_MISSING',
}

/**
 * A machine-readable error raised when a DID does not yield usable, advertised DWN endpoints.
 *
 * Applications should branch on {@link code}, rather than matching the human-readable message.
 * {@link isDwnEndpointResolutionError} is structural so it also works across package copies and
 * browser realms where `instanceof` is not reliable.
 */
export class DwnEndpointResolutionError extends Error {
  public readonly code: DwnEndpointResolutionErrorCode;
  public readonly didUri: string;
  public readonly resolutionError?: string;

  public constructor(params: {
    code: DwnEndpointResolutionErrorCode;
    didUri: string;
    message: string;
    resolutionError?: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'DwnEndpointResolutionError';
    this.code = params.code;
    this.didUri = params.didUri;
    this.resolutionError = params.resolutionError;
  }
}

/** A non-throwing, application-facing view of DWN endpoint resolution. */
export type DwnEndpointResolution =
  | {
    status: 'ready';
    didUri: string;
    endpoints: string[];
  }
  | {
    status: 'resolution-failed' | 'service-missing' | 'service-malformed' | 'endpoints-missing';
    didUri: string;
    error: DwnEndpointResolutionError;
  };

const dwnEndpointResolutionErrorCodes = new Set<string>(Object.values(DwnEndpointResolutionErrorCode));

type DwnServiceCandidate = Record<string, unknown> & {
  type: 'DecentralizedWebNode';
};

/** Matches DWN-typed entries even when their remaining service shape is malformed. */
function isDwnServiceCandidate(service: unknown): service is DwnServiceCandidate {
  return typeof service === 'object'
    && service !== null
    && 'type' in service
    && service.type === 'DecentralizedWebNode';
}

/** Returns whether `error` is a structurally recognizable DWN endpoint resolution error. */
export function isDwnEndpointResolutionError(error: unknown): error is DwnEndpointResolutionError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; didUri?: unknown; message?: unknown; };
  return typeof candidate.code === 'string'
    && dwnEndpointResolutionErrorCodes.has(candidate.code)
    && typeof candidate.didUri === 'string'
    && typeof candidate.message === 'string';
}

/**
 * Resolve every `DecentralizedWebNode` service in a DID document into normalized HTTP(S) URLs.
 *
 * The DID document is authoritative. This helper never supplies a product or deployment default,
 * and it distinguishes DID resolution failures from missing, malformed, and empty services.
 */
export async function resolveDwnServiceEndpointUrls(
  didUri: string,
  resolver: DidResolver,
): Promise<string[]> {
  let resolutionResult;
  try {
    resolutionResult = await resolver.resolve(didUri);
  } catch (cause: unknown) {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.DidResolutionFailed,
      didUri,
      message : `Unable to resolve DID '${didUri}' while locating its DWN service.`,
      cause,
    });
  }

  const resolutionError = resolutionResult.didResolutionMetadata.error;
  if (
    resolutionError !== undefined
    || resolutionResult.didDocument === null
    || resolutionResult.didDocument === undefined
  ) {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.DidResolutionFailed,
      didUri,
      message : resolutionError === DidErrorCode.NotFound
        ? `DID '${didUri}' could not be found, so its DWN service is unavailable.`
        : `Unable to resolve DID '${didUri}' while locating its DWN service${
          resolutionError === undefined ? '.' : `: ${resolutionError}.`
        }`,
      resolutionError,
    });
  }

  return extractDwnServiceEndpointUrls(resolutionResult.didDocument);
}

/** Extract normalized HTTP(S) DWN endpoints from an already-resolved DID document. */
export function extractDwnServiceEndpointUrls(didDocument: DidDocument): string[] {
  const didUri = didDocument.id;
  const dwnServices = didDocument.service?.filter(isDwnServiceCandidate) ?? [];
  if (dwnServices.length === 0) {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.ServiceMissing,
      didUri,
      message : `DID '${didUri}' does not advertise a DecentralizedWebNode service.`,
    });
  }

  const endpointUrls: string[] = [];
  let malformedEndpointFound = false;
  for (const service of dwnServices) {
    const rawEndpoints = typeof service.serviceEndpoint === 'string'
      ? [service.serviceEndpoint]
      : service.serviceEndpoint;

    if (!Array.isArray(rawEndpoints)) {
      malformedEndpointFound = true;
      continue;
    }

    for (const endpoint of rawEndpoints) {
      if (typeof endpoint !== 'string') {
        malformedEndpointFound = true;
        continue;
      }
      try {
        endpointUrls.push(normalizeDwnServiceEndpointUrl(endpoint, didUri));
      } catch (error: unknown) {
        if (!(error instanceof DwnEndpointResolutionError)) {
          throw error;
        }
        malformedEndpointFound = true;
      }
    }
  }

  const uniqueEndpointUrls = [...new Set(endpointUrls)];
  if (uniqueEndpointUrls.length > 0) {
    return uniqueEndpointUrls;
  }

  if (malformedEndpointFound) {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.ServiceMalformed,
      didUri,
      message : `DID '${didUri}' has no valid HTTP(S) DecentralizedWebNode service endpoint.`,
    });
  } else {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.EndpointsMissing,
      didUri,
      message : `DID '${didUri}' advertises a DecentralizedWebNode service with no usable endpoints.`,
    });
  }
}

/**
 * Return a copy of a DID document whose advertised DWN service contains exactly `endpoints`.
 *
 * Existing non-DWN services and the first DWN service's identifier and extension properties are
 * preserved. Additional DWN services are removed so stale endpoints cannot remain advertised.
 */
export function setDwnServiceEndpointUrls({ didDocument, endpoints }: {
  didDocument: DidDocument;
  endpoints: string[];
}): DidDocument {
  const normalizedEndpoints = validateDwnServiceEndpointUrls({ didUri: didDocument.id, endpoints });

  const services = didDocument.service ?? [];
  const existingDwnService = services.find(isDwnServiceCandidate);
  const updatedDwnService: DidService = {
    ...existingDwnService,
    id: typeof existingDwnService?.id === 'string'
      ? existingDwnService.id
      : `${didDocument.id}#dwn`,
    type            : 'DecentralizedWebNode',
    serviceEndpoint : normalizedEndpoints,
  };

  const updatedServices: DidService[] = [];
  let insertedDwnService = false;
  for (const service of services) {
    if (isDwnServiceCandidate(service)) {
      if (!insertedDwnService) {
        updatedServices.push(updatedDwnService);
        insertedDwnService = true;
      }
      continue;
    }
    updatedServices.push(service);
  }

  if (!insertedDwnService) {
    updatedServices.push(updatedDwnService);
  }

  return { ...didDocument, service: updatedServices };
}

/** Validate, normalize, and deduplicate an explicit non-empty DWN endpoint list. */
export function validateDwnServiceEndpointUrls({ didUri, endpoints }: {
  didUri: string;
  endpoints: string[];
}): string[] {
  const normalizedEndpoints = normalizeDwnServiceEndpointUrls(endpoints, didUri);
  if (normalizedEndpoints.length === 0) {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.EndpointsMissing,
      didUri,
      message : `At least one HTTP or HTTPS DWN endpoint is required for DID '${didUri}'.`,
    });
  }
  return normalizedEndpoints;
}

/** Resolve advertised DWN endpoints without requiring application code to catch expected absence. */
export async function resolveDwnEndpointStatus(
  didUri: string,
  resolver: DidResolver,
): Promise<DwnEndpointResolution> {
  try {
    return {
      status    : 'ready',
      didUri,
      endpoints : await resolveDwnServiceEndpointUrls(didUri, resolver),
    };
  } catch (error: unknown) {
    if (!isDwnEndpointResolutionError(error)) {
      throw error;
    }

    return {
      status: endpointErrorStatus(error.code),
      didUri,
      error,
    };
  }
}

function endpointErrorStatus(
  code: DwnEndpointResolutionErrorCode,
): Exclude<DwnEndpointResolution['status'], 'ready'> {
  switch (code) {
    case DwnEndpointResolutionErrorCode.DidResolutionFailed:
      return 'resolution-failed';
    case DwnEndpointResolutionErrorCode.ServiceMissing:
      return 'service-missing';
    case DwnEndpointResolutionErrorCode.ServiceMalformed:
      return 'service-malformed';
    case DwnEndpointResolutionErrorCode.EndpointsMissing:
      return 'endpoints-missing';
  }

  throw new Error(`Unsupported DWN endpoint resolution error code: ${code}`);
}

function normalizeDwnServiceEndpointUrls(endpoints: string[], didUri: string): string[] {
  return [...new Set(endpoints.map((endpoint) => normalizeDwnServiceEndpointUrl(endpoint, didUri)))];
}

function normalizeDwnServiceEndpointUrl(endpoint: string, didUri: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (cause: unknown) {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.ServiceMalformed,
      didUri,
      message : `DID '${didUri}' advertises an invalid DWN endpoint URL: '${endpoint}'.`,
      cause,
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.ServiceMalformed,
      didUri,
      message : `DID '${didUri}' advertises a DWN endpoint that does not use HTTP or HTTPS: '${endpoint}'.`,
    });
  }

  if (url.username !== '' || url.password !== '') {
    throw new DwnEndpointResolutionError({
      code    : DwnEndpointResolutionErrorCode.ServiceMalformed,
      didUri,
      message : `DID '${didUri}' advertises a DWN endpoint containing URL credentials: '${endpoint}'.`,
    });
  }

  url.hash = '';
  url.search = '';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
