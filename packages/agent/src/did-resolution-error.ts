import { DidResolutionErrorCause } from '@enbox/dids';

const structuredErrorChildren = ['cause', 'info', 'reply', 'status'] as const;

/** Returns whether an error chain reports transient DID-resolution network unavailability. */
export function isDidResolutionUnavailableError(input: unknown): boolean {
  const pending: unknown[] = [input];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate !== 'object' || candidate === null || visited.has(candidate)) {
      continue;
    }

    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (record.errorCause === DidResolutionErrorCause.NetworkUnavailable) {
      return true;
    }

    for (const child of structuredErrorChildren) {
      pending.push(record[child]);
    }
  }

  return false;
}
