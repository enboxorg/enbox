/**
 * Pure utility functions extracted from `identity-runtime.ts` for
 * testability and reuse.
 */

export type DidResolutionLike = {
  didDocument: Record<string, unknown> | null;
  didDocumentMetadata: Record<string, unknown>;
  didResolutionMetadata: Record<string, unknown>;
};

/**
 * Normalizes an array of DWN endpoint URLs by trimming whitespace,
 * filtering empties, and deduplicating.
 */
export function normalizeEndpointList(endpoints?: string[]): string[] {
  if (!Array.isArray(endpoints)) {
    return [];
  }

  return Array.from(
    new Set(
      endpoints
        .map((endpoint) => endpoint.trim())
        .filter((endpoint) => endpoint.length > 0),
    ),
  );
}

/**
 * Creates a standard DID resolution error result.
 */
export function createResolutionErrorResult(message: string): DidResolutionLike {
  return {
    didDocument           : null,
    didDocumentMetadata   : {},
    didResolutionMetadata : {
      error: 'resolutionError',
      message,
    },
  };
}

/**
 * Trims a string and returns `undefined` if the result is empty.
 */
export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Extracts a human-readable message from an unknown error value.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
