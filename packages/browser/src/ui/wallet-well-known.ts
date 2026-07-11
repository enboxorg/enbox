/**
 * Wallet discovery via the `/.well-known/enbox-connect` document.
 *
 * Shared by the connect modal (relay discovery + custom-URL validation)
 * and exported for dapps rolling their own wallet selection UI.
 *
 * @module
 */

/** Path of the wallet's connect discovery document, relative to its origin. */
export const WALLET_WELL_KNOWN_PATH = '/.well-known/enbox-connect';

/** Timeout applied to the well-known validation fetch. */
const WELL_KNOWN_FETCH_TIMEOUT_MS = 6_000;

/** The wallet's `/.well-known/enbox-connect` discovery document. */
export interface WalletWellKnownDocument {
  /** Base URL of the relay that brokers this wallet's remote connects. */
  connectServerUrl: string;
}

/**
 * Fetch a wallet's `/.well-known/enbox-connect` discovery document.
 *
 * Resolves the parsed document when it is reachable and names a
 * `connectServerUrl`; resolves `undefined` for unreachable origins, non-2xx
 * responses, CORS failures, and malformed documents.
 */
export async function fetchWalletWellKnown(origin: string): Promise<WalletWellKnownDocument | undefined> {
  try {
    const wellKnownUrl = new URL(WALLET_WELL_KNOWN_PATH, origin).toString();
    const response = await fetch(wellKnownUrl, { signal: AbortSignal.timeout(WELL_KNOWN_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return undefined;
    }

    const payload = await response.json() as { connectServerUrl?: unknown } | null;
    if (typeof payload?.connectServerUrl !== 'string') {
      return undefined;
    }
    return { connectServerUrl: payload.connectServerUrl };
  } catch {
    return undefined;
  }
}

/**
 * Fetch a wallet's `/.well-known/enbox-connect` discovery document to confirm
 * the origin hosts an Enbox-compatible wallet.
 *
 * Resolves `true` only when the document is reachable and names a
 * `connectServerUrl`. Unreachable origins, non-2xx responses, CORS failures,
 * and malformed documents resolve `false`.
 */
export async function probeWalletWellKnown(origin: string): Promise<boolean> {
  return (await fetchWalletWellKnown(origin)) !== undefined;
}
