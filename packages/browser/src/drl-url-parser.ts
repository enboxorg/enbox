/**
 * Parses a DRL URL (http(s)://dweb/{did}/{path}) without regex quantifiers.
 * Returns `[did, path]` or `null` if the URL does not match the DRL scheme.
 *
 * Extracted to a standalone module so it can be tested under Node.js (bun:test)
 * in addition to the browser-based vitest suite, ensuring SonarCloud's
 * merged coverage report includes these lines.
 */
export function parseDrlUrl(url: string): [string, string] | null {
  const idx = url.indexOf('://dweb/');
  if (idx === -1) { return null; }
  const prefix = url.slice(0, idx);
  if (prefix !== 'http' && prefix !== 'https') { return null; }
  const rest = url.slice(idx + 8); // '://dweb/'.length === 8
  if (rest.length === 0) { return null; }
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) { return [rest, '']; }
  if (slashIdx === 0) { return null; } // DID segment must be non-empty
  return [rest.slice(0, slashIdx), rest.slice(slashIdx + 1)];
}
