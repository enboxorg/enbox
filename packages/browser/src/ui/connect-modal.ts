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
 * 3. **Footer** — the alternate-method link and the wallet switcher
 *    disclosure (catalog + custom URL — the entire legacy selector,
 *    demoted to an option).
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

    const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    const style = document.createElement('style');
    style.textContent = buildStyles(isDark);
    shadow.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `Connect to ${appName}`);

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
      qrBox.replaceChildren(qrToSvg(encodeQr(handoff.walletUri), {
        dark      : isDark ? '#e8e8f0' : '#14141f',
        light     : 'transparent',
        quietZone : 2,
      }));

      setStage(
        qrBox,
        el('p', 'stage-caption', 'Scan with your phone’s camera'),
        el('p', 'stage-subline', 'Your wallet stays on your phone, so you can approve things anywhere.'),
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

    // ── Footer: method link + wallet switcher ──────────────────
    const renderFooter = (): void => {
      footer.replaceChildren();

      if (method === 'phone') {
        const alt = document.createElement('button');
        alt.className = 'footer-link method-link';
        alt.textContent = 'No phone handy? Use this browser →';
        // startPopup runs synchronously in this click handler.
        alt.addEventListener('click', () => { startPopup(); });
        footer.appendChild(alt);
      } else if (!isMobile) {
        const alt = document.createElement('button');
        alt.className = 'footer-link method-link';
        alt.textContent = 'Use your phone instead →';
        alt.addEventListener('click', () => { void switchMethod('phone'); });
        footer.appendChild(alt);
      }

      if (!lockedWallet && wallets.length > 0) {
        footer.appendChild(buildWalletSwitcher());
      }
    };

    const buildWalletSwitcher = (): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = 'wallet-switcher';

      const current = wallets.find((wallet) => wallet.url === walletUrl);
      const toggle = document.createElement('button');
      toggle.className = 'footer-link wallet-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = `Wallet: ${current?.name ?? walletUrl ?? 'Choose'} ▾`;

      const panel = document.createElement('div');
      panel.className = 'wallet-panel';
      panel.hidden = true;

      // Search filter — only worth the chrome once the catalog grows.
      const rows: Array<{ wallet: (typeof wallets)[number]; el: HTMLButtonElement }> = [];
      const empty = document.createElement('div');
      empty.className = 'wallet-empty';
      empty.textContent = 'No wallets match your search.';
      empty.hidden = true;

      if (wallets.length > 5) {
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'wallet-search';
        search.placeholder = 'Search wallets…';
        search.addEventListener('input', () => {
          const query = search.value.trim().toLowerCase();
          let visible = 0;
          for (const { wallet, el } of rows) {
            const match = query === ''
              || wallet.name.toLowerCase().includes(query)
              || wallet.url.toLowerCase().includes(query);
            el.hidden = !match;
            if (match) { visible += 1; }
          }
          empty.hidden = visible > 0;
        });
        panel.appendChild(search);
      }

      for (const wallet of wallets) {
        const row = document.createElement('button');
        row.className = 'wallet-row';
        row.appendChild(buildWalletIcon(wallet));
        const rowName = document.createElement('span');
        rowName.className = 'wallet-row-name';
        rowName.textContent = wallet.name;
        row.appendChild(rowName);
        if (wallet.url === walletUrl) {
          row.classList.add('selected');
        }
        row.addEventListener('click', () => {
          walletUrl = wallet.url;
          renderFooter();
          void startMethod();
        });
        rows.push({ wallet, el: row });
        panel.appendChild(row);
      }
      panel.appendChild(empty);

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

      wrap.appendChild(toggle);
      wrap.appendChild(panel);
      return wrap;
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

function buildStyles(isDark: boolean): string {
  const bg = isDark ? '#1a1a2e' : '#ffffff';
  const text = isDark ? '#e0e0e0' : '#1a1a2e';
  const muted = isDark ? '#888' : '#666';
  const border = isDark ? '#333' : '#e0e0e0';
  const itemBg = isDark ? '#16213e' : '#f8f9fa';
  const accent = isDark ? '#4a9eff' : '#0066cc';
  const accentSoft = isDark ? 'rgba(74, 158, 255, 0.16)' : 'rgba(0, 102, 204, 0.1)';
  const danger = isDark ? '#ff6b6b' : '#c0392b';
  const success = isDark ? '#43d17c' : '#1e9e5a';

  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
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

    .modal {
      background: ${bg};
      color: ${text};
      border-radius: 16px;
      width: 400px;
      max-width: 92vw;
      max-height: 88vh;
      overflow-y: auto;
      padding: 20px 24px 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideUp 0.2s ease-out;
      display: flex;
      flex-direction: column;
    }

    .header { display: flex; justify-content: space-between; align-items: center; }
    .header-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .header-icon { border-radius: 6px; }
    h2 { font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .close-btn {
      background: none; border: none; font-size: 24px; cursor: pointer;
      color: ${muted}; padding: 4px 8px; border-radius: 8px; line-height: 1;
    }
    .close-btn:hover { color: ${text}; background: ${itemBg}; }

    .stage {
      min-height: 300px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      text-align: center;
      padding: 16px 0;
    }
    .stage.fade-in > * { animation: stageIn 0.15s ease-out; }

    .qr-box {
      width: 216px;
      height: 216px;
      padding: 12px;
      border-radius: 12px;
      background: ${isDark ? '#10192e' : '#ffffff'};
      border: 1px solid ${border};
    }
    .qr-box svg { width: 100%; height: 100%; display: block; }

    .stage-caption { font-size: 15px; font-weight: 600; }
    .stage-subline { font-size: 13px; color: ${muted}; max-width: 300px; line-height: 1.45; }
    .stage-error { font-size: 13px; color: ${danger}; }

    .deep-link {
      display: block;
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      background: ${accent};
      color: #fff;
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
    }

    .pin-row { display: flex; gap: 10px; }
    .pin-row.shake { animation: shake 0.4s ease-in-out; }
    .pin-input {
      width: 48px; height: 56px;
      text-align: center;
      font-size: 24px; font-weight: 600;
      color: ${text};
      background: ${itemBg};
      border: 1px solid ${border};
      border-radius: 10px;
      outline: none;
    }
    .pin-input:focus { border-color: ${accent}; }

    .check {
      width: 56px; height: 56px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: ${success};
      color: #fff;
      font-size: 28px;
    }

    .spinner {
      width: 32px; height: 32px;
      border-radius: 50%;
      border: 3px solid ${border};
      border-top-color: ${accent};
      animation: spin 0.8s linear infinite;
    }

    .stage-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 10px;
      background: ${accent};
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .stage-btn:hover { filter: brightness(1.1); }

    .footer {
      border-top: 1px solid ${border};
      padding-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: center;
    }

    .footer-link {
      background: none;
      border: none;
      color: ${muted};
      font-size: 13px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 8px;
    }
    .footer-link:hover { color: ${text}; background: ${itemBg}; }
    .method-link { color: ${accent}; }

    .wallet-switcher { width: 100%; display: flex; flex-direction: column; align-items: center; }
    .wallet-panel { width: 100%; padding: 6px 0; display: flex; flex-direction: column; gap: 4px; }
    .wallet-row {
      width: 100%;
      text-align: left;
      padding: 8px 12px;
      background: ${itemBg};
      border: 1px solid ${border};
      border-radius: 10px;
      color: ${text};
      font-size: 13px;
      cursor: pointer;
    }
    .wallet-row:hover, .wallet-row.selected { border-color: ${accent}; }

    .wallet-icon { position: relative; width: 28px; height: 28px; flex-shrink: 0; display: inline-flex; }
    .wallet-badge {
      width: 28px; height: 28px; border-radius: 8px; display: inline-flex;
      align-items: center; justify-content: center; font-size: 13px;
      font-weight: 600; background: ${accentSoft}; color: ${accent};
    }
    .wallet-img { position: absolute; inset: 0; width: 28px; height: 28px; border-radius: 8px; object-fit: cover; }
    .wallet-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wallet-search {
      width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 4px;
      border-radius: 8px; border: 1px solid ${border}; background: transparent;
      color: inherit; font: inherit;
    }
    .wallet-search:focus { outline: none; border-color: ${accent}; }
    .wallet-empty { padding: 8px 10px; font-size: 12px; opacity: 0.7; }
    .url-error { padding: 4px 2px 0; font-size: 12px; color: ${danger}; }
    .wallet-custom { display: flex; gap: 6px; margin-top: 4px; }
    .url-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid ${border};
      border-radius: 10px;
      font-size: 13px;
      background: ${itemBg};
      color: ${text};
      outline: none;
    }
    .url-input:focus { border-color: ${accent}; }
    .url-input.invalid { border-color: ${danger}; }
    .url-go {
      padding: 8px 14px;
      border: none;
      border-radius: 10px;
      background: ${accent};
      color: #fff;
      font-size: 13px;
      cursor: pointer;
    }
  `;
}
