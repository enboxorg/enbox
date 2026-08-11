/**
 * Browser connect handler for `@enbox/auth`.
 *
 * Implements the {@link ConnectHandler} interface using browser-native
 * DWeb Connect (popup + postMessage) with a wallet selector modal.
 *
 * @module
 */

import type { PortableDid } from '@enbox/dids';
import type { ConnectHandler, ConnectResult } from '@enbox/auth';
import type { ConnectPermissionRequest, ConnectRequestType } from '@enbox/connect';

import { runConnectModal } from './ui/connect-modal.js';

import type { ConnectMethod, ConnectModalTheme } from './ui/connect-modal.js';

/** A wallet entry shown in the wallet selector modal. */
export interface WalletOption {
  /** Display name (e.g. "Enbox"). */
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
    name        : 'Enbox',
    url         : 'https://enbox-wallet.pages.dev',
    description : 'Manage your digital identity and data',
  },
  {
    name        : 'Prism',
    url         : 'https://prism-wallet.pages.dev',
    description : 'A clear view into your digital identity',
  },
  {
    name        : 'Matcha',
    url         : 'https://matcha-wallet.pages.dev',
    description : 'A fresh approach to digital identity',
  },
  {
    name        : 'Sumi',
    url         : 'https://sumi-wallet.pages.dev',
    description : 'A refined home for your digital identity',
  },
  {
    name        : 'Taffy',
    url         : 'https://taffy-wallet.pages.dev',
    description : 'A playful take on your digital identity',
  },
  {
    name        : 'Astoria',
    url         : 'https://astoria-wallet.pages.dev',
    description : 'A grand home for your digital identity',
  },
  {
    name        : 'Quay',
    url         : 'https://quay-id.pages.dev',
    description : 'A safe harbor for your digital identity',
  },
  {
    name        : 'Quoin',
    url         : 'https://quoin-id.pages.dev',
    description : 'A cornerstone for your digital identity',
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

  /**
   * Stable application identifier hint available to the wallet during approval.
   * Defaults to the browser's canonical origin.
   */
  applicationId?: string;

  /**
   * Preferred connect method on open: `'phone'` (QR / deep link via the
   * relay) or `'browser'` (wallet popup on this device). Overrides the
   * remembered choice.
   * @default 'phone'
   */
  preferredMethod?: ConnectMethod;

  /**
   * Remember the successful method + wallet in localStorage. Refreshes reuse
   * the route saved for their delegate DID; new connections use the latest
   * successful route as a convenience.
   * @default true
   */
  rememberChoice?: boolean;

  /**
   * Relay base URL override for the phone path. When omitted, each wallet's
   * `connectServerUrl` is discovered from its `/.well-known/enbox-connect`
   * document.
   */
  connectServerUrl?: string;

  /**
   * Path appended to the wallet origin to form the phone path's QR /
   * deep-link target.
   * @default '/connect/app'
   */
  relayWalletPath?: string;

  /**
   * Color scheme for the connect modal. By default it follows the
   * visitor's system light/dark appearance; apps can force an appearance
   * and/or override palette tokens (accent, surfaces, text) per scheme to
   * match their brand.
   */
  theme?: ConnectModalTheme;
}

/**
 * Create a browser-native connect handler over the connect modal.
 *
 * The modal owns the whole session on one surface: the phone path (a QR /
 * deep link over the relay, with pairing-code entry) is the default, the
 * in-browser wallet popup is the alternate, and the wallet catalog plus
 * custom-URL entry live in a disclosure. It resolves with the delegate
 * credentials on success and `undefined` when the user denies.
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
    walletUrl,
    timeout,
    appName,
    appIcon,
    applicationId,
    preferredMethod,
    rememberChoice,
    connectServerUrl,
    relayWalletPath,
    theme,
  } = options;

  return {
    async requestAccess(params: {
      permissionRequests: ConnectPermissionRequest[];
      delegatePortableDid?: PortableDid;
      requestType?: ConnectRequestType;
      expectedProviderDid?: string;
    }): Promise<ConnectResult | undefined> {
      return runConnectModal({
        wallets,
        walletUrl,
        preferredMethod,
        rememberChoice,
        appName,
        appIcon             : appIcon ?? `${window.location.origin}/favicon.ico`,
        applicationId,
        connectServerUrl,
        relayWalletPath,
        timeout,
        theme,
        mode                : params.requestType,
        delegatePortableDid : params.delegatePortableDid,
        expectedProviderDid : params.expectedProviderDid,
        permissionRequests  : params.permissionRequests,
      });
    },
  };
}
