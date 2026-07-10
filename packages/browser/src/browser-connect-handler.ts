/**
 * Browser connect handler for `@enbox/auth`.
 *
 * Implements the {@link ConnectHandler} interface using browser-native
 * DWeb Connect (popup + postMessage) with a wallet selector modal.
 *
 * @module
 */

import type { ConnectPermissionRequest } from '@enbox/connect';
import type { ConnectHandler, ConnectResult } from '@enbox/auth';

import { connectViaPopup } from './dweb-connect-client.js';
import { showWalletSelector } from './ui/wallet-selector.js';

/** A wallet entry shown in the wallet selector modal. */
export interface WalletOption {
  /** Display name (e.g. "Enbox Wallet"). */
  name: string;

  /** Base URL of the wallet app (e.g. "https://enbox-wallet.pages.dev"). */
  url: string;

  /** Optional icon URL. If omitted, the wallet's favicon is used. */
  icon?: string;

  /** Short description shown below the wallet name in the selector. */
  description?: string;
}

/** Default wallets shown in the selector when no overrides are provided. */
export const DEFAULT_WALLETS: WalletOption[] = [
  {
    name        : 'Enbox Wallet',
    url         : 'https://enbox-wallet.pages.dev',
    description : 'Your digital identity wallet',
  },
  {
    name        : 'Blue Enbox Wallet',
    url         : 'https://blue-enbox-wallet.pages.dev',
    description : 'Your digital identity wallet',
  },
];

/** Options for creating a BrowserConnectHandler. */
export interface BrowserConnectHandlerOptions {
  /**
   * Known wallets shown in the wallet selector modal.
   * If omitted, {@link DEFAULT_WALLETS} is used.
   */
  wallets?: WalletOption[];

  /**
   * Explicit wallet URL. If provided, the wallet selector is skipped
   * and this URL is used directly.
   */
  walletUrl?: string;

  /**
   * Timeout in milliseconds for the wallet popup flow.
   * @default 300_000 (5 minutes)
   */
  timeout?: number;

  /**
   * Display name of the requesting application.
   * Shown in the wallet's permission consent screen.
   */
  appName?: string;

  /**
   * Icon URL of the requesting application.
   * Shown alongside the app name in the wallet's consent screen.
   * Defaults to `${window.location.origin}/favicon.ico` if omitted.
   */
  appIcon?: string;

}

/**
 * Create a browser-native connect handler using DWeb Connect
 * (popup + postMessage).
 *
 * This handler:
 * 1. Shows a wallet selector modal (or uses a provided walletUrl).
 * 2. Opens the selected wallet as a popup window.
 * 3. Runs the DWeb Connect postMessage protocol.
 * 4. Returns the delegate credentials on success.
 *
 * @example
 * ```ts
 * import { AuthManager, BrowserConnectHandler } from '@enbox/browser';
 *
 * const auth = await AuthManager.create({
 *   connectHandler: BrowserConnectHandler({
 *     appName: 'My Dapp',
 *   }),
 * });
 *
 * const session = await auth.connect({ protocols: [NotesProtocol] });
 * ```
 */
export function BrowserConnectHandler(
  options: BrowserConnectHandlerOptions = {},
): ConnectHandler {
  const {
    wallets = DEFAULT_WALLETS,
    walletUrl: fixedWalletUrl,
    timeout,
    appName,
    appIcon,
  } = options;

  return {
    async requestAccess(params: {
      permissionRequests: ConnectPermissionRequest[];
    }): Promise<ConnectResult | undefined> {
      // 1. Determine wallet URL.
      let walletUrl = fixedWalletUrl;
      if (!walletUrl) {
        walletUrl = await showWalletSelector(wallets);
      }

      // 2. Run the DWeb Connect popup flow over the connect kernel.
      return connectViaPopup({
        walletUrl,
        permissionRequests: params.permissionRequests,
        timeout,
        appName,
        appIcon,
      });
    },
  };
}
