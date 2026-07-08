function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return false;
  }

  if (parts.some((part: string): boolean => !/^\d+$/.test(part))) {
    return false;
  }

  const octets = parts.map((part: string): number => Number.parseInt(part, 10));
  if (octets.some((octet: number): boolean => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return octets[0] === 127;
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  if (hostname === undefined) {
    return false;
  }

  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost'
    || normalized === '::1'
    || isIpv4Loopback(normalized);
}

export function getHostnameFromHostHeader(hostHeader: string | null): string | undefined {
  if (hostHeader === null) {
    return undefined;
  }

  const trimmedHost = hostHeader.trim();
  if (trimmedHost.length === 0) {
    return undefined;
  }

  if (trimmedHost.startsWith('[')) {
    const closingBracketIndex = trimmedHost.indexOf(']');
    if (closingBracketIndex === -1) {
      return undefined;
    }
    return trimmedHost.slice(1, closingBracketIndex);
  }

  return trimmedHost.split(':')[0];
}

export function isLocalNodeHostHeaderAllowed(hostHeader: string | null): boolean {
  return isLoopbackHostname(getHostnameFromHostHeader(hostHeader));
}

export function assertLocalNodeBindHostname(hostname: string | undefined): void {
  if (!isLoopbackHostname(hostname)) {
    throw new Error('DwnServer local node profile requires a loopback bind hostname.');
  }
}
