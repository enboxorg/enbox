/**
 * Returns `true` only when a browser's connectivity hint explicitly reports that it is offline.
 *
 * An absent hint or `onLine === true` does not prove that a particular endpoint is reachable.
 */
export function isExplicitlyOffline(): boolean {
  return globalThis.navigator?.onLine === false;
}
