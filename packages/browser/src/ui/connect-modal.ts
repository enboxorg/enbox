/**
 * Connect modal — the single surface that owns a whole connect session.
 *
 * One Shadow-DOM dialog whose stage morphs in place through the session:
 * QR (phone path) → pairing code → connected, with the in-browser popup
 * path and the wallet catalog folded in as in-place alternates. The modal
 * never chains into a second modal and stays mounted until the session
 * resolves (connected / denied / cancelled).
 *
 * Layout: three zones —
 *
 * 1. **Header** — requesting app identity + close.
 * 2. **Stage** — a height-stable region where states crossfade: the QR
 *    (or deep link on phones), the pairing-code input, progress, success,
 *    and error states.
 * 3. **Footer** — one row holding the alternate-method link and the wallet
 *    switcher disclosure (a tile grid with search + custom URL — the
 *    entire legacy selector, demoted to an option).
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

import type { WalletOption } from '../browser-connect-handler.js';
import type { ConnectPermissionRequest, ConnectResult, WalletUriHandoff } from '@enbox/connect';

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

/** Safety margin subtracted from the relay pointer TTL before re-minting. */
const REMINT_SAFETY_MS = 30_000;

/** Minimum delay before an automatic re-mint. */
const REMINT_MIN_MS = 10_000;

/** Pairing code length (matches the wallet's generated PIN). */
const PIN_LENGTH = 4;

/** Catalog size beyond which the wallet switcher shows its search bar. */
const WALLET_SEARCH_THRESHOLD = 4; // one full row of tiles

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

  /** Preferred method on open; overrides the remembered choice. */
  preferredMethod?: ConnectMethod;

  /**
   * Remember the successful method + wallet in localStorage and pre-shape
   * the next session accordingly.
   * @default true
   */
  rememberChoice?: boolean;

  /** Display name of the requesting application. */
  appName?: string;

  /** Icon URL of the requesting application. */
  appIcon?: string;

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
    timeoutMs?: number;
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
  timeoutMs?: number;
}): Promise<ConnectResult | undefined> {
  // The transport constructor calls `window.open` synchronously — callers
  // must invoke this inside the user-gesture call stack.
  const transport = new PopupClientTransport({
    walletUrl : options.walletUrl,
    timeoutMs : options.timeoutMs,
  });
  const client = new ConnectClient({ transport });

  return await client.connect({
    appName            : options.appName,
    appIcon            : options.appIcon,
    clientMetadata     : collectBrowserClientMetadata(),
    permissionRequests : options.permissionRequests,
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

function readLastChoice(storage: ConnectModalDeps['storage']): LastChoice | undefined {
  try {
    const raw = storage?.getItem(LAST_CHOICE_STORAGE_KEY);
    if (raw == null) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<LastChoice>;
    if ((parsed.method === 'phone' || parsed.method === 'browser') && typeof parsed.walletUrl === 'string') {
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

  const deps: ConnectModalDeps = { ...defaultDeps(), ...options.deps };
  const wallets = options.wallets ?? [];
  const rememberChoice = options.rememberChoice ?? true;
  const appName = options.appName ?? window.location.host;
  const relayWalletPath = options.relayWalletPath ?? '/connect/app';
  const isMobile = deps.isMobile();

  const lastChoice = rememberChoice ? readLastChoice(deps.storage) : undefined;

  // Wallet resolution order: explicit option → remembered → catalog head.
  const lockedWallet = options.walletUrl !== undefined;
  let walletUrl = options.walletUrl
    ?? (lastChoice !== undefined && (lockedWallet || walletInCatalog(wallets, lastChoice.walletUrl)) ? lastChoice.walletUrl : undefined)
    ?? wallets[0]?.url;

  // Method resolution order: explicit option → remembered → phone.
  let method: ConnectMethod = options.preferredMethod ?? lastChoice?.method ?? 'phone';

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
    modal.setAttribute('aria-label', `Connect to ${appName}`);

    // ── Theme ──────────────────────────────────────────────────
    // System light/dark is pure CSS (`prefers-color-scheme`), so it tracks
    // the visitor live. A forced appearance pins the token block instead.
    const theme = options.theme ?? {};
    const appearance = theme.appearance ?? 'auto';
    if (appearance !== 'auto') {
      modal.setAttribute('data-appearance', appearance);
    }

    // Dapp palette overrides land as inline custom properties: setProperty
    // parses each value as a lone declaration, so a hostile string cannot
    // escape into the stylesheet.
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
    const hasPaletteOverrides = theme.accent !== undefined || theme.accentContrast !== undefined
      || theme.light !== undefined || theme.dark !== undefined;
    const applyPaletteTokens = (): void => {
      const scheme = appearance === 'auto'
        ? (systemDark?.matches === true ? 'dark' : 'light')
        : appearance;
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
    let popupBusy = false;
    let pinResolve: ((pin: string) => void) | undefined;
    const discoveryCache = new Map<string, Promise<string | undefined>>();

    const cleanup = (): void => {
      relaySession?.cancel();
      clearTimeout(remintTimer);
      document.removeEventListener('keydown', onKeydown);
      systemDark?.removeEventListener?.('change', onSchemeChange);
      try { document.body.removeChild(host); } catch { /* best effort */ }
    };

    const settle = (settler: () => void): void => {
      if (settled) { return; }
      settled = true;
      cleanup();
      settler();
    };

    const succeed = (result: ConnectResult): void => {
      if (rememberChoice) {
        writeLastChoice(deps.storage, { method, walletUrl: walletUrl ?? '' });
      }
      renderConnected();
      const finish = (): void => settle(() => resolve(result));
      setTimeout(finish, 1_200);
    };

    const cancelModal = (): void => settle(() => reject(new Error('[@enbox/browser] Connect cancelled.')));

    // ── Zones ──────────────────────────────────────────────────
    modal.appendChild(buildHeader(appName, options.appIcon, cancelModal));

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

    const renderQr = (handoff: WalletUriHandoff): void => {
      if (isMobile) {
        const link = document.createElement('a');
        link.className = 'deep-link';
        link.href = handoff.walletUri;
        link.textContent = 'Continue in your wallet';
        setStage(
          link,
          el('p', 'stage-caption', 'Your wallet opens to approve this connection.'),
          el('p', 'stage-subline', 'Come back here when you’re done.'),
        );
        return;
      }

      const qrBox = document.createElement('div');
      qrBox.className = 'qr-box';
      // Fixed colors on the white card: dark-on-light QRs scan reliably in
      // both appearances (inverted codes trip up some camera apps).
      qrBox.replaceChildren(qrToSvg(encodeQr(handoff.walletUri), {
        dark      : '#14141f',
        light     : 'transparent',
        quietZone : 2,
      }));

      setStage(
        qrBox,
        el('p', 'stage-caption', 'Scan with your phone’s camera'),
        el('p', 'stage-subline', 'Your wallet stays on your phone.'),
      );
    };

    const renderClaimed = (): void => {
      const pulse = document.createElement('div');
      pulse.className = 'claimed-pulse';
      setStage(
        pulse,
        el('p', 'stage-caption', 'Phone connected — finish there'),
        el('p', 'stage-subline', 'Approve the request on your phone, then come back here.'),
      );
    };

    const renderPin = (attempt: number, previousError?: Error): Promise<string> => {
      return new Promise<string>((resolvePin) => {
        pinResolve = resolvePin;

        const boxes = document.createElement('div');
        boxes.className = 'pin-row';
        if (previousError !== undefined) {
          boxes.classList.add('shake');
        }

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
          if (code.length === PIN_LENGTH && pinResolve !== undefined) {
            const resolveOnce = pinResolve;
            pinResolve = undefined;
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

        setStage(
          el('p', 'stage-caption', 'Enter the code shown on your phone'),
          boxes,
          ...(previousError !== undefined
            ? [el('p', 'stage-error', 'That code doesn’t match — check your phone.')]
            : [el('p', 'stage-subline', attempt === 1 ? 'Phone connected.' : '')]),
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
        stageLinkButton('Close', () => settle(() => resolve(undefined))),
      );
    };

    const renderError = (message: string, error?: Error): void => {
      setStage(
        el('p', 'stage-caption', message),
        stageButton('Start over', () => { void startMethod(); }),
        stageLinkButton('Close', () => settle(() => reject(error ?? new Error(`[@enbox/browser] ${message}`)))),
      );
    };

    const renderPhoneUnavailable = (): void => {
      setStage(
        el('p', 'stage-caption', 'This wallet can’t connect by phone here.'),
        el('p', 'stage-subline', 'You can continue in this browser instead.'),
        stageButton('Use this browser', () => { startPopup(); }),
      );
    };

    const renderPopupPrompt = (): void => {
      setStage(
        el('p', 'stage-caption', 'Connect with a wallet in this browser'),
        el('p', 'stage-subline', 'Your wallet opens in a small window to approve this connection.'),
        stageButton('Open wallet window', () => { startPopup(); }),
      );
    };

    const renderPopupWaiting = (): void => {
      setStage(
        el('div', 'spinner'),
        el('p', 'stage-caption', 'Finish in the wallet window'),
        el('p', 'stage-subline', 'We’ll wrap up here as soon as you’re done.'),
      );
    };

    const renderPopupInterrupted = (blocked: boolean): void => {
      setStage(
        el('p', 'stage-caption', blocked
          ? 'Your browser blocked the wallet window.'
          : 'The wallet window was closed.'),
        stageButton(blocked ? 'Open it now' : 'Reopen window', () => { startPopup(); }),
        ...(isMobile ? [] : [stageLinkButton('Use your phone instead', () => { void switchMethod('phone'); })]),
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

    const scheduleRemint = (expiresInSeconds: number): void => {
      clearTimeout(remintTimer);
      const delay = Math.max(REMINT_MIN_MS, expiresInSeconds * 1_000 - REMINT_SAFETY_MS);
      remintTimer = setTimeout(() => {
        // Never re-mint once the wallet has responded (pairing in progress).
        if (!settled && pinResolve === undefined && method === 'phone') {
          void startPhone();
        }
      }, delay);
    };

    const startPhone = async (): Promise<void> => {
      relaySession?.cancel();
      clearTimeout(remintTimer);

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
          walletUri          : new URL(relayWalletPath, origin).toString(),
          appName,
          appIcon            : options.appIcon,
          clientMetadata     : collectBrowserClientMetadata(),
          permissionRequests : options.permissionRequests,
          timeoutMs          : options.timeout,
          cancelled          : session.cancelled,
          onWalletUriReady   : (handoff): void => {
            if (session.active && !settled) {
              renderQr(handoff);
              scheduleRemint(handoff.expiresIn);
            }
          },
          onClaimed: (): void => {
            if (session.active && !settled) {
              // The phone has the request — stop re-minting (a new pointer
              // would orphan the approval in progress) and show progress.
              clearTimeout(remintTimer);
              renderClaimed();
            }
          },
          requestPin: (attempt, previousError): Promise<string> => {
            clearTimeout(remintTimer);
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

    const startPopup = (): void => {
      // Synchronous popup open inside the click's call stack.
      relaySession?.cancel();
      clearTimeout(remintTimer);

      if (walletUrl === undefined) {
        renderError('No wallet is configured.');
        return;
      }
      if (popupBusy) { return; }

      method = 'browser';
      renderFooter();

      let flow: Promise<ConnectResult | undefined>;
      try {
        flow = deps.runPopup({
          walletUrl,
          permissionRequests : options.permissionRequests,
          appName,
          appIcon            : options.appIcon,
          timeoutMs          : options.timeout,
        });
      } catch (error) {
        const blocked = error instanceof Error && /popup blocked/i.test(error.message);
        renderPopupInterrupted(blocked);
        return;
      }

      popupBusy = true;
      renderPopupWaiting();

      flow
        .then((result) => {
          if (settled) { return; }
          if (result === undefined) {
            renderDenied();
          } else {
            succeed(result);
          }
        })
        .catch((error: unknown) => {
          if (settled) { return; }
          if (error instanceof PopupWindowClosedError) {
            renderPopupInterrupted(false);
            return;
          }
          const failure = error instanceof Error ? error : new Error(String(error));
          renderError(
            /timed out/i.test(failure.message)
              ? 'That took too long, so we stopped for safety.'
              : 'Something went wrong while connecting.',
            failure,
          );
        })
        .finally(() => { popupBusy = false; });
    };

    const startMethod = async (): Promise<void> => {
      if (method === 'browser') {
        // window.open must stay inside a user gesture — prompt for the click.
        relaySession?.cancel();
        clearTimeout(remintTimer);
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

    // ── Footer: one row (method link + wallet toggle), panel below ──
    const renderFooter = (): void => {
      footer.replaceChildren();

      const row = document.createElement('div');
      row.className = 'footer-row';

      if (method === 'phone') {
        const alt = document.createElement('button');
        alt.className = 'footer-link method-link';
        alt.textContent = 'No phone? Use this browser →';
        // startPopup runs synchronously in this click handler.
        alt.addEventListener('click', () => { startPopup(); });
        row.appendChild(alt);
      } else if (!isMobile) {
        const alt = document.createElement('button');
        alt.className = 'footer-link method-link';
        alt.textContent = 'Use your phone instead →';
        alt.addEventListener('click', () => { void switchMethod('phone'); });
        row.appendChild(alt);
      }

      let panel: HTMLElement | undefined;
      if (!lockedWallet && wallets.length > 0) {
        const switcher = buildWalletSwitcher();
        row.appendChild(switcher.toggle);
        panel = switcher.panel;
      }

      if (row.childElementCount > 0) {
        footer.appendChild(row);
      }
      if (panel !== undefined) {
        footer.appendChild(panel);
      }
    };

    const buildWalletSwitcher = (): { toggle: HTMLButtonElement; panel: HTMLDivElement } => {
      const current = wallets.find((wallet) => wallet.url === walletUrl);
      const toggle = document.createElement('button');
      toggle.className = 'footer-link wallet-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = `Wallet: ${current?.name ?? hostnameOf(walletUrl) ?? 'Choose'} ▾`;

      const panel = document.createElement('div');
      panel.className = 'wallet-panel';
      panel.hidden = true;

      // Search filter — appears once the catalog outgrows one grid row.
      const tiles: Array<{ wallet: (typeof wallets)[number]; el: HTMLButtonElement }> = [];
      const empty = document.createElement('div');
      empty.className = 'wallet-empty';
      empty.textContent = 'No wallets match your search.';
      empty.hidden = true;

      if (wallets.length > WALLET_SEARCH_THRESHOLD) {
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
        });
        panel.appendChild(search);
      }

      // Square tiles, three per row; past two rows the grid scrolls in
      // place so a large catalog never stretches the modal.
      const scroll = document.createElement('div');
      scroll.className = 'wallet-scroll';
      const grid = document.createElement('div');
      grid.className = 'wallet-grid';

      for (const wallet of wallets) {
        const tile = document.createElement('button');
        tile.className = 'wallet-tile';
        tile.title = wallet.name;
        tile.appendChild(buildWalletIcon(wallet));
        const tileName = document.createElement('span');
        tileName.className = 'wallet-tile-name';
        tileName.textContent = wallet.name;
        tile.appendChild(tileName);
        if (wallet.url === walletUrl) {
          tile.classList.add('selected');
          tile.setAttribute('aria-pressed', 'true');
        }
        tile.addEventListener('click', () => {
          walletUrl = wallet.url;
          renderFooter();
          void startMethod();
        });
        tiles.push({ wallet, el: tile });
        grid.appendChild(tile);
      }
      scroll.appendChild(grid);
      scroll.appendChild(empty);
      panel.appendChild(scroll);

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

      const useWallet = (origin: string): void => {
        walletUrl = origin;
        renderFooter();
        void startMethod();
      };

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
          useWallet(origin);
          return;
        }
        go.disabled = true;
        go.textContent = 'Checking…';
        urlError.hidden = true;
        const valid = await deps.validateWalletUrl(origin);
        go.disabled = false;
        if (valid) {
          go.textContent = 'Use';
          useWallet(origin);
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

      toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
      });

      return { toggle, panel };
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

function buildHeader(appName: string, appIcon: string | undefined, onCancel: () => void): HTMLDivElement {
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
  title.textContent = `Connect to ${appName}`;
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
      width: 200px;
      height: 200px;
      padding: 10px;
      border-radius: 12px;
      background: #ffffff;
      border: 1px solid #e3e4e9;
    }
    .qr-box svg { width: 100%; height: 100%; display: block; }

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
      display: block;
      width: 100%;
      padding: 13px 16px;
      border-radius: 12px;
      background: var(--ec-accent);
      color: var(--ec-accent-contrast);
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
    }

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
    .wallet-toggle { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .wallet-panel { width: 100%; padding: 4px 0 2px; display: flex; flex-direction: column; gap: 8px; }
    .wallet-search {
      width: 100%; padding: 8px 12px;
      border-radius: 10px; border: 1px solid var(--ec-border); background: transparent;
      color: inherit; font: inherit; font-size: 13px;
    }
    .wallet-search:focus { outline: none; border-color: var(--ec-accent); }

    .wallet-scroll { max-height: 260px; overflow-y: auto; }
    .wallet-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .wallet-tile {
      aspect-ratio: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px;
      min-width: 0;
      background: var(--ec-surface);
      border: 1px solid var(--ec-border);
      border-radius: 12px;
      color: var(--ec-text);
      font-size: 12px;
      cursor: pointer;
    }
    .wallet-tile:hover { border-color: var(--ec-accent); }
    .wallet-tile.selected {
      border-color: var(--ec-accent);
      background: var(--ec-accent-soft);
      box-shadow: inset 0 0 0 1px var(--ec-accent);
    }
    .wallet-tile-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .wallet-icon { position: relative; width: 28px; height: 28px; flex-shrink: 0; display: inline-flex; }
    .wallet-tile .wallet-icon { width: 40px; height: 40px; }
    .wallet-badge {
      width: 100%; height: 100%; border-radius: 8px; display: inline-flex;
      align-items: center; justify-content: center; font-size: 13px;
      font-weight: 600; background: var(--ec-accent-soft); color: var(--ec-accent);
    }
    .wallet-tile .wallet-badge { border-radius: 10px; font-size: 17px; }
    .wallet-img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 8px; object-fit: cover; }
    .wallet-tile .wallet-img { border-radius: 10px; }

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
