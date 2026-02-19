/** Concatenates a base URL and a path ensuring that there is exactly one slash between them. */
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
