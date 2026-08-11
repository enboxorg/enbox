/**
 * Connect modal — the single surface that owns a whole connect session.
 *
 * One Shadow-DOM dialog whose stage morphs in place through the session:
 * QR / deep-link handoff (phone path) → pairing code → connected, with the
 * in-browser popup path and the wallet catalog folded in as in-place
 * alternates. The modal never chains into a second modal and stays mounted
 * until the session resolves (connected / denied / cancelled).
 *
 * Layout: three zones —
 *
 * 1. **Header** — requesting app identity + close.
 * 2. **Stage** — a height-stable region where states crossfade: the
 *    clickable QR (joined by a Continue deep-link button on phones; both
 *    open the wallet in a new tab so this session stays alive underneath),
 *    the pairing-code input, progress, success, and error states.
 * 3. **Footer** — the wallet identity row ("Connecting with" + the selected
 *    wallet and the next catalog wallets as tiles), a More tile that expands
 *    the remaining wallets as a matching grid (search + custom URL) in
 *    place — a wallet is never shown twice — and the alternate-method link.
 *
 * Theming: the stylesheet is static and reads `--ec-*` design tokens.
 * Light/dark follows the visitor's system via `prefers-color-scheme` and
 * updates live; the embedding app can force an appearance or override
 * palette tokens through {@link ConnectModalOptions.theme}. Overrides are
 * applied as inline custom properties — never interpolated into the
 * stylesheet — so a hostile string can't escape its declaration. The QR
 * card alone is theme-invariant (dark modules on white scan most
 * reliably).
 *
 * The phone path drives the `@enbox/connect` relay transport via
 * {@link runRelayConnect}; the browser path drives the popup transport via
 * the kernel `ConnectClient`. Wallet `connectServerUrl`s are discovered
 * from each wallet's `/.well-known/enbox-connect` document unless
 * overridden.
 *
 * @module
 */

import type { PortableDid } from '@enbox/dids';
import type { WalletOption } from '../browser-connect-handler.js';
import type { ConnectPermissionRequest, ConnectRequestType, ConnectResult, WalletUriHandoff } from '@enbox/connect';

import { ConnectClient } from '@enbox/connect';

import { buildWalletIcon } from './wallet-icon.js';
import {
  collectBrowserClientMetadata,
  PopupClientTransport,
  PopupWindowClosedError,
} from '../dweb-connect-client.js';
import { encodeQr, qrToSvg } from './qr.js';
import { fetchWalletWellKnown, probeWalletWellKnown } from './wallet-well-known.js';
import { RelayConnectCancelledError, runRelayConnect } from '../relay-connect-runner.js';

/** How the user carries out the approval. */
export type ConnectMethod = 'phone' | 'browser';

/** localStorage key remembering the last successful method + wallet. */
const LAST_CHOICE_STORAGE_KEY = 'enbox:connect:lastChoice';

/** localStorage key remembering the exact wallet route for each delegate/profile pair. */
const SESSION_CHOICES_STORAGE_KEY = 'enbox:connect:sessionChoices';

/** Bounds local reconnect provenance retained by one dapp origin. */
const MAX_SESSION_CHOICES = 20;

/**
 * Safety margin subtracted from the relay pointer TTL before re-minting.
 *
 * The pointer is single-use and its TTL starts at mint time, but the wallet
 * only dereferences it after the user scans — and, on a locked wallet, after
 * they finish the unlock ceremony. A scanned code must therefore carry
 * enough remaining life to absorb that whole window, so re-mint well before
 * the deadline rather than just ahead of it.
 */
const REMINT_SAFETY_MS = 120_000;

/** Minimum delay before an automatic re-mint. */
const REMINT_MIN_MS = 10_000;

/** Pairing code length (matches the wallet's generated PIN). */
const PIN_LENGTH = 4;

/** Catalog size beyond which the wallet switcher shows its search bar. */
const WALLET_SEARCH_THRESHOLD = 4; // one full row of tiles

/** Wallet tiles shown in the collapsed identity row (plus the More tile). */
const WALLET_ROW_SIZE = 3;

/** Palette overrides for one appearance's design tokens. */
export interface ConnectModalPalette {
  /** Modal surface. */
  background?: string;

  /** Inset surfaces: tiles, inputs, hover fills. */
  surface?: string;

  /** Primary text. */
  text?: string;

  /** Secondary text. */
  textMuted?: string;

  /** Hairline borders and dividers. */
  border?: string;

  /** Brand accent: buttons, links, focus rings, selection. */
  accent?: string;

  /** Text/icon color on accent surfaces. */
  accentContrast?: string;

  /** Error text and invalid-input borders. */
  danger?: string;

  /** Success surfaces (the connected check). */
  success?: string;
}

/** Optional color scheme provided by the embedding app. */
export interface ConnectModalTheme {
  /**
   * Follow the visitor's system appearance (`'auto'`, live-updating) or
   * force one.
   * @default 'auto'
   */
  appearance?: 'auto' | 'light' | 'dark';

  /** Brand accent applied in both appearances (per-scheme palettes win). */
  accent?: string;

  /** Text/icon color on accent surfaces, in both appearances. */
  accentContrast?: string;

  /** Token overrides applied while the light appearance is active. */
  light?: ConnectModalPalette;

  /** Token overrides applied while the dark appearance is active. */
  dark?: ConnectModalPalette;
}

/** Design-token custom property behind each palette key. */
const PALETTE_TOKENS: Record<keyof ConnectModalPalette, string> = {
  background     : '--ec-bg',
  surface        : '--ec-surface',
  text           : '--ec-text',
  textMuted      : '--ec-muted',
  border         : '--ec-border',
  accent         : '--ec-accent',
  accentContrast : '--ec-accent-contrast',
  danger         : '--ec-danger',
  success        : '--ec-success',
};

/** Options for {@link runConnectModal}. */
export interface ConnectModalOptions {
  /** Wallet catalog shown in the wallet switcher. */
  wallets?: WalletOption[];

  /**
   * Explicit wallet URL: hides the catalog switcher and uses this wallet
   * for both methods.
   */
  walletUrl?: string;

  /** User-facing mode. Absent means a normal connect. */
  mode?: ConnectRequestType;

  /** Existing delegate credentials reused by a refresh request. */
  delegatePortableDid?: PortableDid;

  /** Preferred method on open; overrides the remembered choice. */
  preferredMethod?: ConnectMethod;

  /**
   * Remember the successful method + wallet in localStorage. Refreshes reuse
   * the route saved for their delegate DID; new connections use the latest
   * successful route as a convenience.
   * @default true
   */
  rememberChoice?: boolean;

  /** Display name of the requesting application. */
  appName?: string;

  /** Icon URL of the requesting application. */
  appIcon?: string;

  /** Stable application identifier hint available to the wallet during approval. */
  applicationId?: string;

  /** Wallet profile DID that a refresh must renew. */
  expectedProviderDid?: string;

  /**
   * Relay base URL override for the phone path. When omitted, each wallet's
   * `connectServerUrl` is discovered from its `/.well-known/enbox-connect`
   * document.
   */
  connectServerUrl?: string;

  /**
   * Path appended to the wallet origin to form the QR / deep-link target.
   * @default '/connect/app'
   */
  relayWalletPath?: string;

  /** Timeout in milliseconds for either method's handshake. */
  timeout?: number;

  /**
   * Color scheme. By default the modal follows the visitor's system
   * light/dark appearance; apps can force an appearance and/or override
   * palette tokens per scheme to match their brand.
   */
  theme?: ConnectModalTheme;

  /** DWN protocols and permission scopes being requested. */
  permissionRequests: ConnectPermissionRequest[];

  /** Internal dependency seams (tests). */
  deps?: Partial<ConnectModalDeps>;
}

/** Injectable collaborators, defaulted to the real implementations. */
export interface ConnectModalDeps {
  /** Runs one relay handshake (phone path). */
  runRelay: typeof runRelayConnect;

  /** Runs one popup handshake (browser path); must open the popup synchronously. */
  runPopup: (options: {
    walletUrl: string;
    permissionRequests: ConnectPermissionRequest[];
    appName: string;
    appIcon?: string;
    applicationId?: string;
    timeoutMs?: number;
    delegatePortableDid?: PortableDid;
    requestType?: ConnectRequestType;
    expectedProviderDid?: string;
  }) => Promise<ConnectResult | undefined>;

  /** Resolves a wallet origin to its relay `connectServerUrl` (or undefined). */
  discoverConnectServerUrl: (walletOrigin: string) => Promise<string | undefined>;

  /** Validates a pasted custom wallet URL. */
  validateWalletUrl: (origin: string) => Promise<boolean>;

  /** Whether to present the deep-link (same-device) variant of the phone path. */
  isMobile: () => boolean;

  /** Persistence for the remembered choice. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}

/**
 * Resolves a wallet origin to its relay `connectServerUrl` via the wallet's
 * `/.well-known/enbox-connect` document ({@link fetchWalletWellKnown} — the
 * same machinery the wallet selector uses for custom-URL validation).
 */
export async function discoverWalletConnectServerUrl(walletOrigin: string): Promise<string | undefined> {
  return (await fetchWalletWellKnown(walletOrigin))?.connectServerUrl;
}

/** Runs one popup handshake without collapsing early-close into a denial. */
async function runPopupConnect(options: {
  walletUrl: string;
  permissionRequests: ConnectPermissionRequest[];
  appName: string;
  appIcon?: string;
  applicationId?: string;
  timeoutMs?: number;
  delegatePortableDid?: PortableDid;
  requestType?: ConnectRequestType;
  expectedProviderDid?: string;
}): Promise<ConnectResult | undefined> {
  // The transport constructor calls `window.open` synchronously — callers
  // must invoke this inside the user-gesture call stack.
  const transport = new PopupClientTransport({
    walletUrl : options.walletUrl,
    timeoutMs : options.timeoutMs,
  });
  const client = new ConnectClient({ transport });

  return await client.connect({
    appName             : options.appName,
    appIcon             : options.appIcon,
    applicationId       : options.applicationId,
    clientMetadata      : collectBrowserClientMetadata(),
    permissionRequests  : options.permissionRequests,
    delegatePortableDid : options.delegatePortableDid,
    requestType         : options.requestType,
    expectedProviderDid : options.expectedProviderDid,
  });
}

function defaultIsMobile(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && Math.min(window.innerWidth, window.innerHeight) < 900;
}

function defaultDeps(): ConnectModalDeps {
  return {
    runRelay                 : runRelayConnect,
    runPopup                 : runPopupConnect,
    discoverConnectServerUrl : discoverWalletConnectServerUrl,
    validateWalletUrl        : probeWalletWellKnown,
    isMobile                 : defaultIsMobile,
    storage                  : typeof localStorage === 'undefined' ? undefined : localStorage,
  };
}

/** Remembered method + wallet from a previous successful session. */
interface LastChoice {
  method: ConnectMethod;
  walletUrl: string;
}

/** Stable reconnect provenance for one delegated app session. */
interface SessionChoice extends LastChoice {
  delegateDid: string;
  providerDid: string;
}

function readLastChoice(storage: ConnectModalDeps['storage']): LastChoice | undefined {
  try {
    const raw = storage?.getItem(LAST_CHOICE_STORAGE_KEY);
    if (raw == null) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<LastChoice>;
    if ((parsed.method === 'phone' || parsed.method === 'browser') && isValidRememberedWalletUrl(parsed.walletUrl)) {
      return { method: parsed.method, walletUrl: parsed.walletUrl };
    }
  } catch { /* unreadable storage — behave as first visit */ }
  return undefined;
}

function writeLastChoice(storage: ConnectModalDeps['storage'], choice: LastChoice): void {
  try {
    storage?.setItem(LAST_CHOICE_STORAGE_KEY, JSON.stringify(choice));
  } catch { /* best effort */ }
}

function isSessionChoice(value: unknown): value is SessionChoice {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const choice = value as Partial<SessionChoice>;
  return (choice.method === 'phone' || choice.method === 'browser')
    && isValidRememberedWalletUrl(choice.walletUrl)
    && typeof choice.delegateDid === 'string'
    && choice.delegateDid.length > 0
    && typeof choice.providerDid === 'string'
    && choice.providerDid.length > 0;
}

function readSessionChoices(storage: ConnectModalDeps['storage']): SessionChoice[] {
  try {
    const raw = storage?.getItem(SESSION_CHOICES_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSessionChoice).slice(-MAX_SESSION_CHOICES) : [];
  } catch {
    return [];
  }
}

function readSessionChoice(
  storage: ConnectModalDeps['storage'],
  delegateDid: string | undefined,
  expectedProviderDid: string | undefined,
): SessionChoice | undefined {
  if (delegateDid === undefined) {
    return undefined;
  }
  const choices = readSessionChoices(storage);
  for (let index = choices.length - 1; index >= 0; index--) {
    const choice = choices[index];
    if (choice.delegateDid === delegateDid
      && (expectedProviderDid === undefined || choice.providerDid === expectedProviderDid)) {
      return choice;
    }
  }
  return undefined;
}

function writeSessionChoice(storage: ConnectModalDeps['storage'], choice: SessionChoice): void {
  try {
    const choices = readSessionChoices(storage).filter(entry =>
      entry.delegateDid !== choice.delegateDid || entry.providerDid !== choice.providerDid
    );
    choices.push(choice);
    storage?.setItem(SESSION_CHOICES_STORAGE_KEY, JSON.stringify(choices.slice(-MAX_SESSION_CHOICES)));
  } catch { /* best effort */ }
}

function removeSessionChoice(
  storage: ConnectModalDeps['storage'],
  delegateDid: string,
  providerDid: string,
): void {
  try {
    const choices = readSessionChoices(storage).filter(choice =>
      choice.delegateDid !== delegateDid || choice.providerDid !== providerDid
    );
    if (choices.length === 0) {
      storage?.removeItem(SESSION_CHOICES_STORAGE_KEY);
    } else {
      storage?.setItem(SESSION_CHOICES_STORAGE_KEY, JSON.stringify(choices));
    }
  } catch { /* best effort */ }
}

/** One cancellable relay session. */
interface RelaySession {
  cancelled: Promise<never>;
  cancel: () => void;
  active: boolean;
}

function createRelaySession(): RelaySession {
  let cancel!: () => void;
  const session: Partial<RelaySession> = { active: true };
  const cancelled = new Promise<never>((_, reject) => {
    cancel = (): void => {
      if (session.active === true) {
        session.active = false;
        reject(new RelayConnectCancelledError());
      }
    };
  });
  // Mark handled so an unconsumed cancellation never surfaces as unhandled.
  cancelled.catch((): undefined => undefined);
  session.cancelled = cancelled;
  session.cancel = cancel;
  return session as RelaySession;
}

/**
 * Wraps `settler` so the returned thunk runs it through `settle()`. Defined
 * at module scope — not as an inline closure inside each render function —
 * so the returned closure is lexically nested one level (inside this
 * function), not several levels inside `runConnectModal()`'s own render
 * closures (Sonar S2004). `settle` and `settler` are threaded through
 * unchanged, so behavior is identical to writing `() => settle(settler)`
 * inline.
 */
function settleWith(settle: (settler: () => void) => void, settler: () => void): () => void {
  return () => settle(settler);
}

/**
 * Opens the connect modal and resolves when the session ends.
 *
 * @returns The delegated credentials; `undefined` when the user denied the
 *          request in the wallet (or dismissed after a denial).
 * @throws When the user cancels the modal, or the session fails and the
 *         user dismisses the error.
 */
export function runConnectModal(options: ConnectModalOptions): Promise<ConnectResult | undefined> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('[@enbox/browser] The connect modal is only available in browser environments.');
  }
  if (options.mode === 'refresh' && options.delegatePortableDid === undefined) {
    throw new Error('Connect: refresh requests require an existing `delegatePortableDid`.');
  }

  const deps: ConnectModalDeps = { ...defaultDeps(), ...options.deps };
  const wallets = dedupeWalletsByUrl(options.wallets ?? []);
  const rememberChoice = options.rememberChoice ?? true;
  const appName = options.appName ?? window.location.host;
  const applicationId = options.applicationId ?? window.location.origin;
  const isMobile = deps.isMobile();
  const refreshing = options.mode === 'refresh';

  const lastChoice = rememberChoice ? readLastChoice(deps.storage) : undefined;
  const sessionChoice = rememberChoice && refreshing
    ? readSessionChoice(
      deps.storage,
      options.delegatePortableDid?.uri,
      options.expectedProviderDid,
    )
    : undefined;
  const expectedProviderDid = options.expectedProviderDid ?? sessionChoice?.providerDid;
  const relayWalletPath = options.relayWalletPath ?? '/connect/app';
  const savedRouteEscapeLabel = options.walletUrl === undefined
    ? 'Choose another wallet or method'
    : 'Choose another method';

  // Refresh routes resolve by delegate first; general preferences remain a
  // best-effort fallback for sessions created before route-aware storage.
  const rememberedWalletUrl = lastChoice !== undefined
    && (refreshing || walletInCatalog(wallets, lastChoice.walletUrl))
    ? lastChoice.walletUrl
    : undefined;
  let lockedWallet = sessionChoice !== undefined || options.walletUrl !== undefined;
  let lockedMethod = sessionChoice !== undefined;
  let walletUrl = sessionChoice?.walletUrl
    ?? options.walletUrl
    ?? rememberedWalletUrl
    ?? wallets[0]?.url;

  // An exact refresh route wins over generic handler and global preferences.
  let method: ConnectMethod = sessionChoice?.method ?? options.preferredMethod ?? lastChoice?.method ?? 'phone';

  return new Promise<ConnectResult | undefined>((resolve, reject) => {
    // ── Host + shadow root ─────────────────────────────────────
    const host = document.createElement('div');
    host.id = 'enbox-connect-modal';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = MODAL_STYLES;
    shadow.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const title = refreshing ? `Reconnect to ${appName}` : `Connect to ${appName}`;
    modal.setAttribute('aria-label', title);

    // ── Theme ──────────────────────────────────────────────────
    // System light/dark is pure CSS (`prefers-color-scheme`), so it tracks
    // the visitor live. A forced appearance pins the token block instead.
    const theme = options.theme ?? {};
    const appearance = theme.appearance ?? 'auto';
    if (appearance !== 'auto') {
      modal.dataset.appearance = appearance;
    }

    // Dapp palette overrides land as inline custom properties: setProperty
    // parses each value as a lone declaration, so a hostile string cannot
    // escape into the stylesheet.
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
    const hasPaletteOverrides = theme.accent !== undefined || theme.accentContrast !== undefined
      || theme.light !== undefined || theme.dark !== undefined;
    const applyPaletteTokens = (): void => {
      const systemScheme = systemDark?.matches === true ? 'dark' : 'light';
      const scheme = appearance === 'auto' ? systemScheme : appearance;
      const palette: ConnectModalPalette = {
        accent         : theme.accent,
        accentContrast : theme.accentContrast,
        ...theme[scheme],
      };
      for (const key of Object.keys(PALETTE_TOKENS) as Array<keyof ConnectModalPalette>) {
        const value = palette[key];
        if (typeof value === 'string' && value.trim() !== '') {
          modal.style.setProperty(PALETTE_TOKENS[key], value);
        } else {
          modal.style.removeProperty(PALETTE_TOKENS[key]);
        }
      }
    };
    const onSchemeChange = (): void => applyPaletteTokens();
    if (hasPaletteOverrides) {
      applyPaletteTokens();
      if (appearance === 'auto') {
        systemDark?.addEventListener?.('change', onSchemeChange);
      }
    }

    // ── Session state ──────────────────────────────────────────
    let settled = false;
    let relaySession: RelaySession | undefined;
    let remintTimer: ReturnType<typeof setTimeout> | undefined;
    let remintAt: number | undefined;
    let popupBusy = false;
    let pinResolve: ((pin: string) => void) | undefined;
    // Proxy pinResolve reads/clears for buildPinInputs (module scope), whose
    // per-input closures would otherwise be nested inside renderPin()'s own
    // executor chain too deeply (Sonar S2004).
    const getPinResolve = (): ((pin: string) => void) | undefined => pinResolve;
    const clearPinResolve = (): void => { pinResolve = undefined; };
    const discoveryCache = new Map<string, Promise<string | undefined>>();

    // Collapsed identity row: the selected wallet plus the next catalog
    // wallets, never repeating one. Slots stay stable across in-row
    // switches (only the highlight moves); the row recomposes only when a
    // wallet from outside it — grid pick or custom URL — becomes selected,
    // which puts that wallet in the first slot.
    let rowWallets: WalletOption[] = [];

    /** The catalog entry for `url`, or a synthesized option for custom URLs. */
    const walletByUrl = (url: string): WalletOption =>
      wallets.find((wallet) => wallet.url === url) ?? { name: hostnameOf(url) ?? url, url };

    const composeWalletRow = (): void => {
      if (walletUrl === undefined) {
        rowWallets = wallets.slice(0, WALLET_ROW_SIZE);
        return;
      }
      if (rowWallets.some((wallet) => wallet.url === walletUrl)) {
        return;
      }
      const selected = walletByUrl(walletUrl);
      rowWallets = [selected, ...wallets.filter((wallet) => wallet.url !== selected.url)].slice(0, WALLET_ROW_SIZE);
    };

    const selectWallet = (url: string): void => {
      walletUrl = url;
      renderFooter();
      void startMethod();
    };

    const cleanup = (): void => {
      relaySession?.cancel();
      clearRemint();
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('visibilitychange', onVisibilityReturn);
      systemDark?.removeEventListener?.('change', onSchemeChange);
      try { host.remove(); } catch { /* best effort */ }
    };

    const settle = (settler: () => void): void => {
      if (settled) { return; }
      settled = true;
      cleanup();
      settler();
    };

    const succeed = (result: ConnectResult): void => {
      if (rememberChoice && walletUrl !== undefined) {
        writeLastChoice(deps.storage, { method, walletUrl });
        writeSessionChoice(deps.storage, {
          delegateDid : result.delegatePortableDid.uri,
          providerDid : result.connectedDid,
          method,
          walletUrl,
        });
      }
      renderConnected();
      setTimeout(settleWith(settle, () => resolve(result)), 1_200);
    };

    const cancelModal = (): void => settle(() => reject(new Error('[@enbox/browser] Connect cancelled.')));

    // ── Zones ──────────────────────────────────────────────────
    modal.appendChild(buildHeader(title, options.appIcon, cancelModal));

    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.setAttribute('aria-live', 'polite');
    modal.appendChild(stage);

    const footer = document.createElement('div');
    footer.className = 'footer';
    modal.appendChild(footer);

    // ── Stage renderers (all render in place; nothing navigates) ──
    const setStage = (...nodes: (HTMLElement | SVGElement)[]): void => {
      stage.replaceChildren(...nodes);
      stage.classList.remove('fade-in');
      void stage.offsetWidth; // restart the transition
      stage.classList.add('fade-in');
    };

    const renderBusy = (message: string): void => {
      setStage(el('div', 'spinner'), el('p', 'stage-caption', message));
    };

    /**
     * Schedules the "finish in the wallet" morph after a handoff link is
     * followed. Deferred one tick so the anchor's default new-tab navigation
     * completes before the anchor is replaced, and guarded so a session that
     * moved on meanwhile (re-mint, wallet response, settle) is never
     * overwritten.
     */
    const morphToAway = (walletName: string): void => {
      const session = relaySession;
      setTimeout((): void => {
        if (settled || session !== relaySession || session?.active !== true || pinResolve !== undefined) {
          return;
        }
        renderAway(walletName);
      }, 0);
    };

    /**
     * Builds one same-device handoff anchor for the wallet URI. The wallet
     * opens in a new tab so this modal — and the relay session under it —
     * stays alive, with the pairing-code entry waiting when the user
     * switches back. `noopener` keeps the wallet tab from reaching back into
     * this one.
     */
    const buildHandoffLink = (handoff: WalletUriHandoff, walletName: string, className: string): HTMLAnchorElement => {
      const link = document.createElement('a');
      link.className = className;
      link.href = handoff.walletUri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.addEventListener('click', () => { morphToAway(walletName); });
      return link;
    };

    const renderQr = (handoff: WalletUriHandoff): void => {
      const wallet = walletUrl !== undefined ? walletByUrl(walletUrl) : undefined;
      const walletName = wallet?.name ?? 'your wallet';

      // The QR card is itself a handoff link on every device: opening it on
      // this device runs the exact handshake the camera path runs on another
      // one, and scanning it keeps working either way.
      const qrLink = buildHandoffLink(handoff, walletName, 'qr-box qr-link');
      qrLink.setAttribute('aria-label', `Open ${walletName} on this device`);
      // Fixed colors on the white card: dark-on-light QRs scan reliably in
      // both appearances (inverted codes trip up some camera apps).
      qrLink.replaceChildren(qrToSvg(encodeQr(handoff.walletUri), {
        dark      : '#14141f',
        light     : 'transparent',
        quietZone : 2,
      }));

      // The selected wallet's mark sits at the QR centre — the "this is the
      // wallet you're connecting to" cue. The 44px plate over the ~180px
      // symbol occludes ~5% of modules, well inside ECC level M's 15%
      // recovery budget (the compact variant scales the plate down to
      // match).
      if (wallet !== undefined) {
        const logo = el('div', 'qr-logo');
        logo.appendChild(buildWalletIcon(wallet));
        qrLink.appendChild(logo);
      }

      if (isMobile) {
        const link = buildHandoffLink(handoff, walletName, 'deep-link');
        if (wallet !== undefined) {
          link.appendChild(buildWalletIcon(wallet));
        }
        link.appendChild(el('span', 'deep-link-label', `Continue in ${walletName}`));

        qrLink.classList.add('compact');
        setStage(
          link,
          el('p', 'stage-subline', `${walletName} opens in a new tab — approve there, then come back for your code.`),
          el('div', 'stage-divider', 'or scan with another phone'),
          qrLink,
        );
        return;
      }

      setStage(
        qrLink,
        el('p', 'stage-caption', 'Scan with your phone’s camera'),
        el('p', 'stage-subline', `${walletName} stays on your phone — or click the code to open it here.`),
      );
    };

    /**
     * Shown once a handoff link is followed on this device: the approval is
     * happening in the wallet tab, this one waits for the code. "Start over"
     * mints a fresh pointer — the right recovery, because the pointer the
     * wallet tab carried away is single-use.
     */
    const renderAway = (walletName: string): void => {
      setStage(
        el('div', 'spinner'),
        el('p', 'stage-caption', `Finish in ${walletName}`),
        el('p', 'stage-subline', isMobile
          ? `Approve the connection in the ${walletName} tab, then come back here for your code.`
          : 'Approve the connection in the tab that just opened, then come back here for your code.'),
        stageLinkButton('Start over', () => { void startPhone(); }),
      );
    };

    const renderClaimed = (): void => {
      const walletName = walletUrl !== undefined ? walletByUrl(walletUrl).name : 'your wallet';
      const pulse = document.createElement('div');
      pulse.className = 'claimed-pulse';
      setStage(
        pulse,
        el('p', 'stage-caption', `Request received — approve in ${walletName}`),
        el('p', 'stage-subline', 'Once you approve, you’ll get a code to enter here.'),
      );
    };

    const renderPin = (attempt: number, previousError?: Error): Promise<string> => {
      return new Promise<string>((resolvePin) => {
        pinResolve = resolvePin;
        const walletName = walletUrl !== undefined ? walletByUrl(walletUrl).name : 'your wallet';

        const boxes = document.createElement('div');
        boxes.className = 'pin-row';
        if (previousError !== undefined) {
          boxes.classList.add('shake');
        }

        const inputs = buildPinInputs(boxes, getPinResolve, clearPinResolve, renderBusy);

        setStage(
          el('p', 'stage-caption', `Enter the code shown in ${walletName}`),
          boxes,
          ...(previousError !== undefined
            ? [el('p', 'stage-error', `That code doesn’t match — check ${walletName}.`)]
            : [el('p', 'stage-subline', attempt === 1 ? 'This confirms you’re the one approving.' : '')]),
        );

        inputs[0].focus();
      });
    };

    const renderConnected = (): void => {
      const check = el('div', 'check');
      check.textContent = '✓';
      setStage(check, el('p', 'stage-caption', 'You’re connected.'));
    };

    const renderDenied = (): void => {
      setStage(
        el('p', 'stage-caption', 'No problem — nothing was shared.'),
        stageButton('Start over', () => { void startMethod(); }),
        stageLinkButton('Close', settleWith(settle, () => resolve(undefined))),
      );
    };

    const escapeSavedRoute = (): void => {
      if (sessionChoice === undefined) {
        return;
      }

      relaySession?.cancel();
      relaySession = undefined;
      clearRemint();
      removeSessionChoice(deps.storage, sessionChoice.delegateDid, sessionChoice.providerDid);
      lockedWallet = options.walletUrl !== undefined;
      lockedMethod = false;
      if (options.walletUrl !== undefined) {
        walletUrl = options.walletUrl;
      }
      renderFooter();
      setStage(
        el('p', 'stage-caption', 'Choose another way to reconnect.'),
        el('p', 'stage-subline', 'We’ll still require the same wallet profile used for this session.'),
      );
    };

    const renderError = (message: string, error?: Error): void => {
      setStage(
        el('p', 'stage-caption', message),
        stageButton('Start over', () => { void startMethod(); }),
        ...(sessionChoice !== undefined && lockedMethod
          ? [stageLinkButton(savedRouteEscapeLabel, escapeSavedRoute)]
          : []),
        stageLinkButton('Close', settleWith(settle, () => reject(error ?? new Error(`[@enbox/browser] ${message}`)))),
      );
    };

    const renderPhoneUnavailable = (): void => {
      if (lockedMethod) {
        setStage(
          el('p', 'stage-caption', 'Your saved wallet connection is unavailable right now.'),
          el('p', 'stage-subline', 'Try again in a moment to reconnect the same session.'),
          stageButton('Try again', () => { void startPhone(); }),
          stageLinkButton(savedRouteEscapeLabel, escapeSavedRoute),
        );
        return;
      }
      setStage(
        el('p', 'stage-caption', 'This wallet can’t connect by phone here.'),
        el('p', 'stage-subline', 'You can continue in this browser instead.'),
        stageButton('Use this browser', () => { startPopup(); }),
      );
    };

    // The popup surface is a small window on desktop but a new tab on
    // phones — the copy names whichever the visitor will actually see.
    const popupSurface = isMobile ? 'tab' : 'window';

    const renderPopupPrompt = (): void => {
      const walletName = walletUrl !== undefined ? walletByUrl(walletUrl).name : 'your wallet';
      const exactReconnect = refreshing && lockedMethod;
      setStage(
        el('p', 'stage-caption', exactReconnect
          ? `Reconnect with ${walletName}`
          : 'Connect with a wallet in this browser'),
        el('p', 'stage-subline', exactReconnect
          ? `We’ll open the same ${walletName} profile used for this session.`
          : isMobile
            ? 'Your wallet opens in a new tab to approve this connection — no code needed.'
            : 'Your wallet opens in a small window to approve this connection.'),
        stageButton(exactReconnect
          ? `Open ${walletName} ${popupSurface}`
          : isMobile ? 'Open wallet' : 'Open wallet window', () => { startPopup(); }),
      );
    };

    const renderPopupWaiting = (): void => {
      setStage(
        el('div', 'spinner'),
        el('p', 'stage-caption', `Finish in the wallet ${popupSurface}`),
        el('p', 'stage-subline', 'We’ll wrap up here as soon as you’re done.'),
      );
    };

    const renderPopupInterrupted = (blocked: boolean): void => {
      setStage(
        el('p', 'stage-caption', blocked
          ? `Your browser blocked the wallet ${popupSurface}.`
          : `The wallet ${popupSurface} was closed.`),
        stageButton(blocked ? 'Open it now' : `Reopen ${popupSurface}`, () => { startPopup(); }),
        ...(lockedMethod && sessionChoice !== undefined
          ? [stageLinkButton(savedRouteEscapeLabel, escapeSavedRoute)]
          : [stageLinkButton(isMobile ? 'Use a code instead' : 'Use your phone instead', () => { void switchMethod('phone'); })]),
      );
    };

    const renderPopupFailure = (error: unknown): void => {
      if (settled) { return; }

      const failure = error instanceof Error ? error : new Error(String(error));
      const popupBlocked = /popup blocked/i.test(failure.message);
      if (error instanceof PopupWindowClosedError || popupBlocked) {
        renderPopupInterrupted(popupBlocked);
        return;
      }

      renderError(
        /timed out/i.test(failure.message)
          ? 'That took too long, so we stopped for safety.'
          : 'Something went wrong while connecting.',
        failure,
      );
    };

    // ── Method drivers ─────────────────────────────────────────
    const resolveConnectServerUrl = async (origin: string): Promise<string | undefined> => {
      if (options.connectServerUrl !== undefined) {
        return options.connectServerUrl;
      }
      let cached = discoveryCache.get(origin);
      if (cached === undefined) {
        cached = deps.discoverConnectServerUrl(origin);
        discoveryCache.set(origin, cached);
      }
      return cached;
    };

    const clearRemint = (): void => {
      clearTimeout(remintTimer);
      remintAt = undefined;
    };

    const remintNow = (): void => {
      // Never re-mint once the wallet has responded (pairing in progress).
      if (!settled && pinResolve === undefined && method === 'phone') {
        void startPhone();
      }
    };

    const scheduleRemint = (expiresInSeconds: number): void => {
      clearRemint();
      const delay = Math.max(REMINT_MIN_MS, expiresInSeconds * 1_000 - REMINT_SAFETY_MS);
      // The deadline is kept alongside the timer: background tabs (mobile
      // especially) throttle or freeze timers, so the visibility handler
      // re-checks it when the user returns.
      remintAt = Date.now() + delay;
      remintTimer = setTimeout(remintNow, delay);
    };

    const startPhone = async (): Promise<void> => {
      relaySession?.cancel();
      clearRemint();

      if (walletUrl === undefined) {
        renderError('No wallet is configured.');
        return;
      }

      method = 'phone';
      renderFooter();
      renderBusy('Getting things ready…');

      const origin = new URL(walletUrl).origin;
      const connectServerUrl = await resolveConnectServerUrl(origin);
      if (connectServerUrl === undefined) {
        renderPhoneUnavailable();
        return;
      }

      const session = createRelaySession();
      relaySession = session;

      try {
        const result = await deps.runRelay({
          connectServerUrl,
          walletUri           : new URL(relayWalletPath, origin).toString(),
          appName,
          appIcon             : options.appIcon,
          applicationId,
          clientMetadata      : collectBrowserClientMetadata(),
          permissionRequests  : options.permissionRequests,
          delegatePortableDid : options.delegatePortableDid,
          requestType         : options.mode,
          expectedProviderDid,
          timeoutMs           : options.timeout,
          cancelled           : session.cancelled,
          onWalletUriReady    : (handoff): void => {
            if (session.active && !settled) {
              renderQr(handoff);
              scheduleRemint(handoff.expiresIn);
            }
          },
          onClaimed: (): void => {
            if (session.active && !settled) {
              // The wallet has the request — stop re-minting (a new pointer
              // would orphan the approval in progress) and show progress.
              clearRemint();
              renderClaimed();
            }
          },
          requestPin: (attempt, previousError): Promise<string> => {
            clearRemint();
            return renderPin(attempt, previousError);
          },
        });

        if (!session.active || settled) { return; }

        if (result === undefined) {
          renderDenied();
        } else {
          succeed(result);
        }
      } catch (error) {
        if (!session.active || settled || error instanceof RelayConnectCancelledError) {
          return;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        renderError(
          /timed out/i.test(failure.message)
            ? 'That took too long, so we stopped for safety.'
            : 'Something went wrong while connecting.',
          failure,
        );
      }
    };

    const startPopup = async (): Promise<void> => {
      // Synchronous popup open inside the click's call stack.
      relaySession?.cancel();
      clearRemint();

      if (walletUrl === undefined) {
        renderError('No wallet is configured.');
        return;
      }
      if (popupBusy) { return; }

      method = 'browser';
      renderFooter();

      popupBusy = true;
      renderPopupWaiting();

      // `runPopup(...)` is invoked synchronously (its `window.open` runs before the
      // first `await`), preserving the user-gesture popup open. Awaiting it inside the
      // try means both a synchronous throw (a custom transport) and an async rejection
      // are handled here — no unhandled promise sits inside the try (Sonar S4822).
      try {
        const result = await deps.runPopup({
          walletUrl,
          permissionRequests  : options.permissionRequests,
          appName,
          appIcon             : options.appIcon,
          applicationId,
          timeoutMs           : options.timeout,
          delegatePortableDid : options.delegatePortableDid,
          requestType         : options.mode,
          expectedProviderDid,
        });
        if (settled) { return; }
        if (result === undefined) {
          renderDenied();
        } else {
          succeed(result);
        }
      } catch (error) {
        renderPopupFailure(error);
      } finally {
        popupBusy = false;
      }
    };

    const startMethod = async (): Promise<void> => {
      if (method === 'browser') {
        // window.open must stay inside a user gesture — prompt for the click.
        relaySession?.cancel();
        clearRemint();
        renderFooter();
        renderPopupPrompt();
      } else {
        await startPhone();
      }
    };

    const switchMethod = async (next: ConnectMethod): Promise<void> => {
      method = next;
      await startMethod();
    };

    // ── Footer: identity row (+ catalog panel), method link below ──
    const renderFooter = (): void => {
      footer.replaceChildren();

      if (!lockedWallet) {
        composeWalletRow();
        const switcher = buildWalletSwitcher();
        if (switcher.label !== undefined) {
          footer.appendChild(switcher.label);
        }
        footer.appendChild(switcher.row);
        footer.appendChild(switcher.panel);
      }

      const row = document.createElement('div');
      row.className = 'footer-row';

      if (method === 'phone' && !lockedMethod) {
        const alt = document.createElement('button');
        alt.className = 'footer-link method-link';
        // On a phone both methods open the wallet on this device — what the
        // popup channel actually buys the visitor is skipping the code.
        alt.textContent = isMobile ? 'Or connect without a code →' : 'No phone? Use this browser →';
        // startPopup runs synchronously in this click handler.
        alt.addEventListener('click', () => { startPopup(); });
        row.appendChild(alt);
      } else if (method === 'browser' && !lockedMethod) {
        const alt = document.createElement('button');
        alt.className = 'footer-link method-link';
        alt.textContent = isMobile ? 'Use a code instead →' : 'Use your phone instead →';
        alt.addEventListener('click', () => { void switchMethod('phone'); });
        row.appendChild(alt);
      }

      if (row.childElementCount > 0) {
        footer.appendChild(row);
      }
    };

    const buildWalletSwitcher = (): { label?: HTMLElement; row: HTMLDivElement; panel: HTMLDivElement } => {
      // Identity row: selected wallet + the next catalog wallets, then the
      // More tile expanding the full catalog in place.
      const row = document.createElement('div');
      row.className = 'wallet-row';
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', 'Wallet');

      for (const wallet of rowWallets) {
        const tile = document.createElement('button');
        tile.className = 'row-tile';
        tile.title = wallet.description ?? wallet.name;
        tile.setAttribute('role', 'radio');
        const isSelected = wallet.url === walletUrl;
        tile.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        if (isSelected) {
          tile.classList.add('selected');
        }
        tile.appendChild(buildWalletIcon(wallet));
        tile.appendChild(el('span', 'row-tile-name', wallet.name));
        tile.addEventListener('click', () => {
          if (wallet.url !== walletUrl) {
            selectWallet(wallet.url);
          }
        });
        row.appendChild(tile);
      }

      const panel = document.createElement('div');
      panel.className = 'wallet-panel';
      panel.hidden = true;

      // The panel grid holds only the wallets NOT already visible in the
      // row, so expanding never shows the same wallet twice.
      const gridWallets = wallets.filter((wallet) => !walletInCatalog(rowWallets, wallet.url));

      const more = document.createElement('button');
      more.className = 'row-tile more-tile';
      more.title = 'All wallets';
      more.setAttribute('aria-expanded', 'false');
      more.appendChild(el('span', 'more-count', gridWallets.length > 0 ? `+${gridWallets.length}` : '⋯'));
      more.appendChild(el('span', 'row-tile-name', 'More'));
      more.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        more.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
        if (!panel.hidden) {
          updateScrollHint();
        }
      });
      row.appendChild(more);

      const label = rowWallets.length > 0 ? el('div', 'wallet-row-label', 'Connecting with') : undefined;

      // Search filter — appears once the grid outgrows one row of tiles.
      const tiles: Array<{ wallet: (typeof wallets)[number]; el: HTMLButtonElement }> = [];
      const empty = document.createElement('div');
      empty.className = 'wallet-empty';
      empty.textContent = 'No other wallets match your search.';
      empty.hidden = true;

      if (gridWallets.length > WALLET_SEARCH_THRESHOLD) {
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'wallet-search';
        search.placeholder = 'Search wallets…';
        search.setAttribute('aria-label', 'Search wallets');
        search.addEventListener('input', () => {
          const query = search.value.trim().toLowerCase();
          let visible = 0;
          for (const { wallet, el: tile } of tiles) {
            const match = query === ''
              || wallet.name.toLowerCase().includes(query)
              || wallet.url.toLowerCase().includes(query);
            tile.hidden = !match;
            if (match) { visible += 1; }
          }
          empty.hidden = visible > 0;
          updateScrollHint();
        });
        panel.appendChild(search);
      }

      // Tiles matching the identity row, four per row; past three rows the
      // grid scrolls in place, with a bottom fade hinting at more below.
      const scrollWrap = document.createElement('div');
      scrollWrap.className = 'wallet-scroll-wrap';
      scrollWrap.hidden = gridWallets.length === 0;
      const scroll = document.createElement('div');
      scroll.className = 'wallet-scroll';
      const grid = document.createElement('div');
      grid.className = 'wallet-grid';

      const updateScrollHint = (): void => {
        const overflowing = scroll.scrollHeight - scroll.clientHeight > 1;
        const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
        scrollWrap.classList.toggle('scroll-hint', overflowing && !atEnd);
      };
      scroll.addEventListener('scroll', updateScrollHint);

      for (const wallet of gridWallets) {
        const tile = document.createElement('button');
        tile.className = 'wallet-tile';
        tile.title = wallet.description ?? wallet.name;
        tile.appendChild(buildWalletIcon(wallet));
        const tileName = document.createElement('span');
        tileName.className = 'wallet-tile-name';
        tileName.textContent = wallet.name;
        tile.appendChild(tileName);
        tile.addEventListener('click', () => {
          selectWallet(wallet.url);
        });
        tiles.push({ wallet, el: tile });
        grid.appendChild(tile);
      }
      scroll.appendChild(grid);
      scroll.appendChild(empty);
      scrollWrap.appendChild(scroll);
      panel.appendChild(scrollWrap);

      // Custom wallet URL (the power-user path, demoted to the disclosure).
      const custom = document.createElement('div');
      custom.className = 'wallet-custom';
      const input = document.createElement('input');
      input.className = 'url-input';
      input.type = 'url';
      input.placeholder = 'https://your-wallet.example';
      const go = document.createElement('button');
      go.className = 'url-go';
      go.textContent = 'Use';
      const urlError = document.createElement('div');
      urlError.className = 'url-error';
      urlError.hidden = true;

      // When validation fails we let the user override, since the connect
      // handshake is the ultimate gate — a valid wallet behind strict CORS
      // should not be permanently blocked.
      let allowUnverified = false;

      const submitCustom = async (): Promise<void> => {
        const value = input.value.trim();
        if (value === '') { return; }
        let origin: string;
        try {
          origin = new URL(value.includes('://') ? value : `https://${value}`).origin;
        } catch {
          input.classList.add('invalid');
          return;
        }
        if (allowUnverified) {
          selectWallet(origin);
          return;
        }
        go.disabled = true;
        go.textContent = 'Checking…';
        urlError.hidden = true;
        const valid = await deps.validateWalletUrl(origin);
        go.disabled = false;
        if (valid) {
          go.textContent = 'Use';
          selectWallet(origin);
          return;
        }
        allowUnverified = true;
        go.textContent = 'Use anyway';
        input.classList.add('invalid');
        urlError.textContent = `Couldn't verify a wallet at ${origin}.`;
        urlError.hidden = false;
      };

      input.addEventListener('input', () => {
        allowUnverified = false;
        go.textContent = 'Use';
        input.classList.remove('invalid');
        urlError.hidden = true;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { void submitCustom(); }
      });
      go.addEventListener('click', () => { void submitCustom(); });
      custom.appendChild(input);
      custom.appendChild(go);
      panel.appendChild(custom);
      panel.appendChild(urlError);

      return { label, row, panel };
    };

    // ── Global interactions ────────────────────────────────────
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        cancelModal();
      }
    });

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        cancelModal();
        return;
      }
      if (event.key === 'Tab') {
        trapFocus(shadow, event);
      }
    };
    document.addEventListener('keydown', onKeydown);

    // The visitor typically comes back from the wallet tab mid-session.
    const onVisibilityReturn = (): void => {
      if (document.visibilityState !== 'visible' || settled) {
        return;
      }

      // Background tabs throttle (or freeze) timers, so a re-mint that came
      // due while the user was away fires now instead of never.
      if (remintAt !== undefined && Date.now() >= remintAt) {
        remintNow();
        return;
      }

      // Returning with the code in hand: put the caret in the first empty
      // pairing-code box so they can type it straight away.
      if (pinResolve !== undefined) {
        const inputs = Array.from(shadow.querySelectorAll<HTMLInputElement>('.pin-input'));
        inputs.find((input) => input.value === '')?.focus();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityReturn);

    overlay.appendChild(modal);
    shadow.appendChild(overlay);
    document.body.appendChild(host);

    renderFooter();
    void startMethod();
  });
}

// ─── Small DOM helpers ───────────────────────────────────────────

function walletInCatalog(wallets: WalletOption[], url: string): boolean {
  return wallets.some((wallet) => wallet.url === url);
}

function isValidRememberedWalletUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Drops catalog entries that repeat an earlier wallet's URL. */
function dedupeWalletsByUrl(wallets: WalletOption[]): WalletOption[] {
  return wallets.filter((wallet, index) => wallets.findIndex((candidate) => candidate.url === wallet.url) === index);
}

/** Compact display form of a wallet URL for the switcher toggle. */
function hostnameOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function stageButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'stage-btn';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function stageLinkButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'footer-link';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function buildHeader(titleText: string, appIcon: string | undefined, onCancel: () => void): HTMLDivElement {
  const header = document.createElement('div');
  header.className = 'header';

  const identity = document.createElement('div');
  identity.className = 'header-identity';

  if (appIcon !== undefined) {
    const icon = document.createElement('img');
    icon.className = 'header-icon';
    icon.src = appIcon;
    icon.alt = '';
    icon.width = 24;
    icon.height = 24;
    icon.addEventListener('error', () => icon.remove());
    identity.appendChild(icon);
  }

  const title = document.createElement('h2');
  title.textContent = titleText;
  identity.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', onCancel);

  header.appendChild(identity);
  header.appendChild(closeBtn);
  return header;
}

/**
 * Builds the PIN-entry boxes, wires their input/keydown/paste behavior, and
 * returns the input elements in order. Module-level — `renderPin()`'s own
 * `new Promise` executor already nests two levels deep inside
 * `runConnectModal()`, so a per-input closure defined there would sit too
 * deep for Sonar's S2004 nesting-depth check.
 *
 * `getPinResolve`/`clearPinResolve` proxy the `pinResolve` state kept in
 * `runConnectModal()`'s closure: a completed code needs it read once, then
 * cleared — in that order, before the busy state renders and the pending
 * promise resolves — exactly as it was inline.
 */
function buildPinInputs(
  boxes: HTMLDivElement,
  getPinResolve: () => ((pin: string) => void) | undefined,
  clearPinResolve: () => void,
  renderBusy: (message: string) => void,
): HTMLInputElement[] {
  const inputs: HTMLInputElement[] = [];
  for (let i = 0; i < PIN_LENGTH; i++) {
    const input = document.createElement('input');
    input.className = 'pin-input';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.maxLength = 1;
    input.setAttribute('aria-label', `Code digit ${i + 1}`);
    inputs.push(input);
    boxes.appendChild(input);
  }

  const submitIfComplete = (): void => {
    const code = inputs.map((i) => i.value).join('');
    const pinResolve = getPinResolve();
    if (code.length === PIN_LENGTH && pinResolve !== undefined) {
      const resolveOnce = pinResolve;
      clearPinResolve();
      renderBusy('Checking the code…');
      resolveOnce(code);
    }
  };

  inputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value !== '' && index + 1 < inputs.length) {
        inputs[index + 1].focus();
      }
      submitIfComplete();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && input.value === '' && index > 0) {
        inputs[index - 1].focus();
      }
    });
    input.addEventListener('paste', (event) => {
      const digits = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, PIN_LENGTH);
      if (digits.length === 0) { return; }
      event.preventDefault();
      digits.split('').forEach((digit, digitIndex) => {
        if (inputs[digitIndex] !== undefined) {
          inputs[digitIndex].value = digit;
        }
      });
      inputs[Math.min(digits.length, PIN_LENGTH) - 1]?.focus();
      submitIfComplete();
    });
  });

  return inputs;
}

function trapFocus(shadow: ShadowRoot, event: KeyboardEvent): void {
  const focusables = Array.from(
    shadow.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])'),
  ).filter((node) => !node.hasAttribute('disabled') && node.offsetParent !== null);

  if (focusables.length === 0) {
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = shadow.activeElement as HTMLElement | null;

  if (event.shiftKey && (active === first || active === null)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// ─── Styles ──────────────────────────────────────────────────────
//
// One static sheet; every color reads a `--ec-*` token. Light values sit on
// `.modal`, dark values apply under `prefers-color-scheme` (so the system
// appearance tracks live) and under a forced `data-appearance`. Dapp
// palette overrides land as inline custom properties, which outrank all of
// these — nothing user-provided is ever concatenated into this string.

/** Light-appearance design tokens. */
const LIGHT_TOKENS = `
      --ec-bg: #ffffff;
      --ec-surface: #f5f6f8;
      --ec-text: #17171f;
      --ec-muted: #63636e;
      --ec-border: #e3e4e9;
      --ec-accent: #0a62d0;
      --ec-accent-contrast: #ffffff;
      --ec-danger: #c0392b;
      --ec-success: #1e9e5a;`;

/** Dark-appearance design tokens. */
const DARK_TOKENS = `
      --ec-bg: #181822;
      --ec-surface: #23232f;
      --ec-text: #e9e9f0;
      --ec-muted: #9a9aa6;
      --ec-border: #33333f;
      --ec-accent: #58a6ff;
      --ec-accent-contrast: #0b1526;
      --ec-danger: #ff7a7a;
      --ec-success: #43d17c;`;

const MODAL_STYLES = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* Keep the hidden attribute authoritative: author display values (e.g.
       the panel's flex) would otherwise override the UA's [hidden] rule and
       leave "collapsed" sections permanently expanded. */
    [hidden] { display: none !important; }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes stageIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-6px); }
      40%, 80% { transform: translateX(6px); }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes claimedPulse {
      0%, 100% { transform: scale(0.85); opacity: 0.7; }
      50% { transform: scale(1); opacity: 1; }
    }

    .modal {${LIGHT_TOKENS}
      --ec-accent-soft: color-mix(in srgb, var(--ec-accent) 14%, transparent);
      background: var(--ec-bg);
      color: var(--ec-text);
      border-radius: 16px;
      width: 400px;
      max-width: 100%;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      padding: 16px 20px 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      animation: slideUp 0.2s ease-out;
      display: flex;
      flex-direction: column;
    }
    @media (prefers-color-scheme: dark) {
      .modal {${DARK_TOKENS}
      }
    }
    .modal[data-appearance='light'] {${LIGHT_TOKENS}
    }
    .modal[data-appearance='dark'] {${DARK_TOKENS}
    }

    button, input { font-family: inherit; }
    button:focus-visible, a:focus-visible {
      outline: 2px solid var(--ec-accent);
      outline-offset: 2px;
    }

    .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .header-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .header-icon { border-radius: 6px; flex-shrink: 0; }
    h2 { font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .close-btn {
      background: none; border: none; font-size: 24px; cursor: pointer;
      color: var(--ec-muted); padding: 4px 8px; border-radius: 8px; line-height: 1;
      flex-shrink: 0;
    }
    .close-btn:hover { color: var(--ec-text); background: var(--ec-surface); }

    .stage {
      min-height: 240px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      text-align: center;
      padding: 12px 0 10px;
    }
    .stage.fade-in > * { animation: stageIn 0.15s ease-out; }

    .qr-box {
      position: relative;
      width: 200px;
      height: 200px;
      padding: 10px;
      border-radius: 12px;
      background: #ffffff;
      border: 1px solid #e3e4e9;
    }
    .qr-box svg { width: 100%; height: 100%; display: block; }

    /* Selected wallet's mark on the QR centre. Like the card, the plate is
       theme-invariant white so the logo sits on a scannable ground. */
    .qr-logo {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 44px;
      height: 44px;
      border-radius: 10px;
      background: #ffffff;
      border: 1px solid #e3e4e9;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .qr-logo .wallet-icon { width: 30px; height: 30px; }
    .qr-logo .wallet-badge { border-radius: 8px; font-size: 15px; }

    /* The QR card doubles as the same-device handoff link. */
    a.qr-box { display: block; cursor: pointer; }
    .qr-box.qr-link:hover {
      border-color: var(--ec-accent);
      box-shadow: 0 0 0 3px var(--ec-accent-soft);
    }
    .qr-box.compact { width: 160px; height: 160px; }
    .qr-box.compact .qr-logo { width: 36px; height: 36px; }
    .qr-box.compact .qr-logo .wallet-icon { width: 24px; height: 24px; }

    .stage-divider {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      color: var(--ec-muted);
      font-size: 12px;
    }
    .stage-divider::before, .stage-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--ec-border);
    }

    .claimed-pulse {
      width: 64px; height: 64px; border-radius: 50%;
      background: var(--ec-accent-soft); position: relative;
    }
    .claimed-pulse::after {
      content: ''; position: absolute; inset: 18px; border-radius: 50%;
      background: var(--ec-accent);
      animation: claimedPulse 1.6s ease-in-out infinite;
    }

    .stage-caption { font-size: 15px; font-weight: 600; }
    .stage-subline { font-size: 13px; color: var(--ec-muted); max-width: 300px; line-height: 1.45; }
    .stage-error { font-size: 13px; color: var(--ec-danger); }

    .deep-link {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 13px 16px;
      border-radius: 12px;
      background: var(--ec-accent);
      color: var(--ec-accent-contrast);
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
    }
    .deep-link .wallet-icon { width: 24px; height: 24px; }
    .deep-link .wallet-badge {
      border-radius: 6px;
      font-size: 12px;
      background: var(--ec-accent-contrast);
    }
    .deep-link .wallet-img { border-radius: 6px; }

    .pin-row { display: flex; gap: 10px; }
    .pin-row.shake { animation: shake 0.4s ease-in-out; }
    .pin-input {
      width: 46px; height: 54px;
      text-align: center;
      font-size: 24px; font-weight: 600;
      color: var(--ec-text);
      background: var(--ec-surface);
      border: 1px solid var(--ec-border);
      border-radius: 10px;
      outline: none;
    }
    .pin-input:focus { border-color: var(--ec-accent); }

    .check {
      width: 56px; height: 56px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: var(--ec-success);
      color: #ffffff;
      font-size: 28px;
    }

    .spinner {
      width: 32px; height: 32px;
      border-radius: 50%;
      border: 3px solid var(--ec-border);
      border-top-color: var(--ec-accent);
      animation: spin 0.8s linear infinite;
    }

    .stage-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 10px;
      background: var(--ec-accent);
      color: var(--ec-accent-contrast);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .stage-btn:hover { filter: brightness(1.08); }

    .footer {
      border-top: 1px solid var(--ec-border);
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .footer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 2px 8px;
    }
    .footer-row > * { min-width: 0; }
    .footer-row > :only-child { margin-inline: auto; }

    .footer-link {
      background: none;
      border: none;
      color: var(--ec-muted);
      font-size: 13px;
      cursor: pointer;
      padding: 5px 8px;
      border-radius: 8px;
    }
    .footer-link:hover { color: var(--ec-text); background: var(--ec-surface); }
    .method-link { color: var(--ec-accent); }

    .wallet-row-label { font-size: 12px; color: var(--ec-muted); padding: 2px 2px 0; }

    .wallet-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .row-tile, .wallet-tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 6px;
      min-width: 0;
      background: var(--ec-surface);
      border: 1px solid var(--ec-border);
      border-radius: 12px;
      color: var(--ec-text);
      font-size: 11px;
      cursor: pointer;
    }
    .row-tile:hover, .wallet-tile:hover { border-color: var(--ec-accent); }
    .row-tile.selected {
      border-color: var(--ec-accent);
      background: var(--ec-accent-soft);
      box-shadow: inset 0 0 0 1px var(--ec-accent);
    }
    .row-tile.selected .row-tile-name { font-weight: 600; }
    .row-tile .wallet-icon, .wallet-tile .wallet-icon { width: 28px; height: 28px; }
    .row-tile-name, .wallet-tile-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .more-tile { color: var(--ec-muted); }
    .more-tile:hover { color: var(--ec-text); }
    .more-tile[aria-expanded='true'] { border-color: var(--ec-accent); }
    .more-count {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      background: var(--ec-accent-soft);
      color: var(--ec-accent);
    }

    .wallet-panel { width: 100%; padding: 4px 0 2px; display: flex; flex-direction: column; gap: 8px; }
    .wallet-search {
      width: 100%; padding: 8px 12px;
      border-radius: 10px; border: 1px solid var(--ec-border); background: transparent;
      color: inherit; font: inherit; font-size: 13px;
    }
    .wallet-search:focus { outline: none; border-color: var(--ec-accent); }

    /* Cap the grid at three rows of tiles; past that it scrolls in place,
       and the wrapper's bottom fade hints that more wallets are below. */
    .wallet-scroll-wrap { position: relative; }
    .wallet-scroll { max-height: 220px; overflow-y: auto; }
    .wallet-scroll-wrap.scroll-hint::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 28px;
      background: linear-gradient(to bottom, transparent, var(--ec-bg));
      pointer-events: none;
    }
    .wallet-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }

    .wallet-icon { position: relative; width: 28px; height: 28px; flex-shrink: 0; display: inline-flex; }
    .wallet-badge {
      width: 100%; height: 100%; border-radius: 8px; display: inline-flex;
      align-items: center; justify-content: center; font-size: 13px;
      font-weight: 600; background: var(--ec-accent-soft); color: var(--ec-accent);
    }
    .wallet-img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 8px; object-fit: cover; }

    .wallet-empty { padding: 10px 4px; font-size: 12px; color: var(--ec-muted); text-align: center; }

    .wallet-custom { display: flex; gap: 6px; }
    .url-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--ec-border);
      border-radius: 10px;
      font-size: 13px;
      background: var(--ec-surface);
      color: var(--ec-text);
      outline: none;
    }
    .url-input:focus { border-color: var(--ec-accent); }
    .url-input.invalid { border-color: var(--ec-danger); }
    .url-go {
      padding: 8px 14px;
      border: none;
      border-radius: 10px;
      background: var(--ec-accent);
      color: var(--ec-accent-contrast);
      font-size: 13px;
      cursor: pointer;
    }
    .url-error { font-size: 12px; color: var(--ec-danger); }

    @media (prefers-reduced-motion: reduce) {
      .overlay, .modal, .stage.fade-in > *, .pin-row.shake { animation: none; }
      .claimed-pulse::after { animation: none; }
    }
`;
