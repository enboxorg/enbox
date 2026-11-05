import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

export function validateModuleUrlNormalized(url: string): void {
  let normalized: string | undefined;
  try {
    normalized = normalizeModuleUrl(url);
  } catch {
    normalized = undefined;
  }

  if (url !== normalized) {
    throw new DwnError(DwnErrorCode.UrlModuleNotNormalized, `Module URI ${url} must be normalized.`);
  }
}

export function normalizeModuleUrl(url: string): string {
  // Keeping module normalization as a separate function in case
  // module and schema normalization diverge in the future
  return normalizeUrl(url);
}

export function validateSchemaUrlNormalized(url: string): void {
  let normalized: string | undefined;
  try {
    normalized = normalizeSchemaUrl(url);
  } catch {
    normalized = undefined;
  }

  if (url !== normalized) {
    throw new DwnError(DwnErrorCode.UrlSchemaNotNormalized, `Schema URI ${url} must be normalized.`);
  }
}

export function normalizeSchemaUrl(url: string): string {
  // Keeping schema normalization as a separate function in case
  // module and schema normalization diverge in the future
  return normalizeUrl(url);
}

function normalizeUrl(url: string): string {
  let fullUrl: string;
  if (/^[^:]+:(\/{2})?[^/].*/.test(url)) {
    fullUrl = url;
  } else {
    fullUrl = `http://${url}`;
  }

  try {
    const result = new URL(fullUrl);
    result.search = '';
    result.hash = '';
    return removeTrailingSlash(result.href);
  } catch {
    throw new DwnError(DwnErrorCode.UrlModuleNotNormalizable, 'Could not normalize module URI');
  }
}

function removeTrailingSlash(str: string): string {
  // Strip every trailing slash, not just one, so normalization is idempotent:
  // an input like `https://a.example//` must normalize to `https://a.example`,
  // otherwise the normalized form fails `validate*UrlNormalized()`.
  let end = str.length;
  while (end > 0 && str[end - 1] === '/') {
    end -= 1;
  }
  return str.slice(0, end);
}
