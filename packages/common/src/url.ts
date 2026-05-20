/**
 * URL helpers shared across packages.
 *
 * @module
 */

/**
 * Concatenates a base URL and a path ensuring that there is exactly one slash
 * between them. Handles every combination of trailing/leading slashes on the
 * inputs.
 *
 * @example
 * ```ts
 * concatenateUrl('https://example.com',  'api/v1');  // 'https://example.com/api/v1'
 * concatenateUrl('https://example.com/', 'api/v1');  // 'https://example.com/api/v1'
 * concatenateUrl('https://example.com',  '/api/v1'); // 'https://example.com/api/v1'
 * concatenateUrl('https://example.com/', '/api/v1'); // 'https://example.com/api/v1'
 * ```
 */
export function concatenateUrl(baseUrl: string, path: string): string {
  // Remove trailing slash from baseUrl if it exists
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }

  // Remove leading slash from path if it exists
  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  return `${baseUrl}/${path}`;
}
