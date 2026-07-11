/**
 * Wallet selector modal — a self-contained, framework-agnostic UI component.
 *
 * Injected into the DOM as a Shadow DOM element to prevent style conflicts.
 * Inspired by WalletConnect's Web3Modal pattern.
 *
 * The modal is a single view with three zones:
 *
 * 1. **Quick connect** — a one-tap button that connects with the recommended
 *    (first) wallet without scrolling the grid.
 * 2. **Wallet grid** — a scrollable grid of wallet tiles with a search filter.
 *    Each tile renders the wallet's own favicon, falling back to a letter
 *    badge (never a third-party favicon proxy).
 * 3. **Custom URL** — paste any wallet URL; it is validated against the
 *    wallet's `/.well-known/enbox-connect` discovery document before the
 *    selection resolves.
 *
 * @module
 */

import type { WalletOption } from '../browser-connect-handler.js';

/** Path of the wallet's connect discovery document, relative to its origin. */
export const WALLET_WELL_KNOWN_PATH = '/.well-known/enbox-connect';

/** Timeout applied to the well-known validation fetch. */
const WELL_KNOWN_FETCH_TIMEOUT_MS = 6_000;

/** Options controlling {@link showWalletSelector} behavior. */
export interface WalletSelectorOptions {
  /**
   * Validate a pasted wallet origin before resolving with it.
   *
   * Defaults to {@link probeWalletWellKnown}, which fetches the wallet's
   * `/.well-known/enbox-connect` document. Injectable for testing.
   */
  validateWalletUrl?: (origin: string) => Promise<boolean>;
}

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

/** Shows the wallet selector modal and resolves with the chosen wallet URL. */
export function showWalletSelector(
  wallets: WalletOption[],
  options: WalletSelectorOptions = {},
): Promise<string> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('[@enbox/browser] Wallet selector is only available in browser environments.');
  }

  const validateWalletUrl = options.validateWalletUrl ?? probeWalletWellKnown;

  return new Promise<string>((resolve, reject) => {
    // Create the host element with Shadow DOM isolation.
    const host = document.createElement('div');
    host.id = 'enbox-wallet-selector';
    const shadow = host.attachShadow({ mode: 'open' });

    let onKeydown: ((e: KeyboardEvent) => void) | undefined;
    const cleanup = (): void => {
      if (onKeydown !== undefined) {
        document.removeEventListener('keydown', onKeydown);
        onKeydown = undefined;
      }

      try { document.body.removeChild(host); } catch { /* best effort */ }
    };

    const settleResolve = (url: string): void => {
      cleanup();
      resolve(url);
    };

    const settleReject = (): void => {
      cleanup();
      reject(new Error('[@enbox/browser] Wallet selection cancelled.'));
    };

    // Detect dark mode.
    const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

    // Build styles.
    const style = document.createElement('style');
    style.textContent = buildStyles(isDark);
    shadow.appendChild(style);

    // Build modal DOM.
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    modal.appendChild(buildHeader(settleReject));

    const recommended = wallets[0];
    if (recommended !== undefined) {
      modal.appendChild(buildQuickConnect(recommended, settleResolve));
    }

    modal.appendChild(buildWalletGrid(wallets, settleResolve));
    modal.appendChild(buildSeparator());
    modal.appendChild(buildCustomUrl(validateWalletUrl, settleResolve));

    // Close on overlay click.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        settleReject();
      }
    });

    // Close on Escape.
    onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        settleReject();
      }
    };
    document.addEventListener('keydown', onKeydown);

    overlay.appendChild(modal);
    shadow.appendChild(overlay);
    document.body.appendChild(host);

    // Focus the search box for keyboard-first users.
    shadow.querySelector<HTMLInputElement>('.wallet-search')?.focus();
  });
}

// ─── DOM builders ────────────────────────────────────────────────

function buildHeader(onCancel: () => void): HTMLDivElement {
  const header = document.createElement('div');
  header.className = 'header';

  const title = document.createElement('h2');
  title.textContent = 'Connect a wallet';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', onCancel);

  header.appendChild(title);
  header.appendChild(closeBtn);
  return header;
}

function buildQuickConnect(recommended: WalletOption, onSelect: (url: string) => void): HTMLButtonElement {
  const quick = document.createElement('button');
  quick.className = 'quick-connect';

  const bolt = document.createElement('span');
  bolt.className = 'quick-bolt';
  bolt.textContent = '⚡'; // ⚡

  const text = document.createElement('span');
  text.className = 'quick-text';

  const label = document.createElement('span');
  label.className = 'quick-label';
  label.textContent = 'Quick connect';

  const sub = document.createElement('span');
  sub.className = 'quick-sub';
  sub.textContent = `Connect with ${recommended.name}`;

  text.appendChild(label);
  text.appendChild(sub);
  quick.appendChild(bolt);
  quick.appendChild(text);
  quick.addEventListener('click', () => onSelect(recommended.url));
  return quick;
}

function buildWalletGrid(wallets: WalletOption[], onSelect: (url: string) => void): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'grid-section';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'wallet-search';
  search.placeholder = 'Search wallets…';

  const grid = document.createElement('div');
  grid.className = 'wallet-grid';

  const empty = document.createElement('div');
  empty.className = 'grid-empty';
  empty.textContent = 'No wallets match your search.';
  empty.style.display = 'none';

  const tiles = wallets.map((wallet) => {
    const tile = buildWalletTile(wallet, onSelect);
    grid.appendChild(tile);
    return { name: wallet.name.toLowerCase(), tile };
  });

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const { name, tile } of tiles) {
      const match = name.includes(query);
      tile.style.display = match ? '' : 'none';
      if (match) {
        visible += 1;
      }
    }
    empty.style.display = visible === 0 ? '' : 'none';
  });

  section.appendChild(search);
  section.appendChild(grid);
  section.appendChild(empty);
  return section;
}

function buildWalletTile(wallet: WalletOption, onSelect: (url: string) => void): HTMLButtonElement {
  const tile = document.createElement('button');
  tile.className = 'wallet-item';
  tile.title = wallet.description ?? wallet.name;

  tile.appendChild(buildWalletIcon(wallet));

  const name = document.createElement('span');
  name.className = 'wallet-name';
  name.textContent = wallet.name;
  tile.appendChild(name);

  tile.addEventListener('click', () => onSelect(wallet.url));
  return tile;
}

/**
 * Build a wallet icon that prefers the wallet's own favicon and degrades to a
 * letter badge. We never call a third-party favicon proxy: those 404 for many
 * origins and leak the wallet URL to the proxy.
 */
function buildWalletIcon(wallet: WalletOption): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'wallet-icon';

  const badge = document.createElement('span');
  badge.className = 'wallet-badge';
  badge.textContent = wallet.name.charAt(0).toUpperCase();
  wrap.appendChild(badge);

  const sources = iconCandidates(wallet);
  if (sources.length === 0) {
    return wrap;
  }

  const img = document.createElement('img');
  img.className = 'wallet-img';
  img.alt = '';
  img.width = 40;
  img.height = 40;

  let index = 0;
  img.addEventListener('error', () => {
    index += 1;
    if (index < sources.length) {
      img.src = sources[index];
    } else {
      img.remove(); // fall back to the letter badge
    }
  });

  img.src = sources[index];
  wrap.appendChild(img);
  return wrap;
}

/** Ordered favicon URLs to try for a wallet, most specific first. */
function iconCandidates(wallet: WalletOption): string[] {
  if (wallet.icon !== undefined) {
    return [wallet.icon];
  }

  let origin: string;
  try {
    origin = new URL(wallet.url).origin;
  } catch {
    return [];
  }

  return [`${origin}/favicon.svg`, `${origin}/favicon.ico`, `${origin}/favicon.png`];
}

function buildSeparator(): HTMLDivElement {
  const sep = document.createElement('div');
  sep.className = 'separator';

  const line1 = document.createElement('div');
  line1.className = 'sep-line';
  const sepText = document.createElement('span');
  sepText.textContent = 'or';
  const line2 = document.createElement('div');
  line2.className = 'sep-line';

  sep.appendChild(line1);
  sep.appendChild(sepText);
  sep.appendChild(line2);
  return sep;
}

function buildCustomUrl(
  validateWalletUrl: (origin: string) => Promise<boolean>,
  onSelect: (url: string) => void,
): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'custom-section';

  const label = document.createElement('label');
  label.className = 'custom-label';
  label.textContent = 'Have a wallet URL?';

  const inputGroup = document.createElement('div');
  inputGroup.className = 'input-group';

  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://your-wallet.example';
  input.className = 'url-input';

  const goBtn = document.createElement('button');
  goBtn.className = 'go-btn';
  goBtn.textContent = 'Connect';
  goBtn.disabled = true;

  const errorLine = document.createElement('div');
  errorLine.className = 'url-error';
  errorLine.style.display = 'none';

  // When validation fails we let the user override, since the popup handshake
  // is the ultimate gate — a valid wallet behind strict CORS should not be
  // permanently blocked.
  let allowUnverified = false;

  const resetState = (): void => {
    allowUnverified = false;
    goBtn.textContent = 'Connect';
    errorLine.style.display = 'none';
    goBtn.disabled = !isValidUrl(input.value);
  };

  const submit = async (): Promise<void> => {
    if (!isValidUrl(input.value)) {
      return;
    }

    const origin = normalizeUrl(input.value);
    if (allowUnverified) {
      onSelect(origin);
      return;
    }

    goBtn.disabled = true;
    goBtn.textContent = 'Verifying…';
    errorLine.style.display = 'none';

    const valid = await validateWalletUrl(origin);
    if (valid) {
      onSelect(origin);
      return;
    }

    allowUnverified = true;
    goBtn.disabled = false;
    goBtn.textContent = 'Connect anyway';
    errorLine.textContent = `Couldn't verify an Enbox wallet at ${origin}.`;
    errorLine.style.display = '';
  };

  input.addEventListener('input', resetState);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      void submit();
    }
  });
  goBtn.addEventListener('click', () => void submit());

  inputGroup.appendChild(input);
  inputGroup.appendChild(goBtn);
  section.appendChild(label);
  section.appendChild(inputGroup);
  section.appendChild(errorLine);
  return section;
}

// ─── Helpers ─────────────────────────────────────────────────────

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  const withScheme = value.includes('://') ? value : `https://${value}`;
  // Return origin only (strip path/trailing slash).
  return new URL(withScheme).origin;
}

function buildStyles(isDark: boolean): string {
  const bg = isDark ? '#1a1a2e' : '#ffffff';
  const text = isDark ? '#e0e0e0' : '#1a1a2e';
  const muted = isDark ? '#888' : '#666';
  const border = isDark ? '#333' : '#e0e0e0';
  const itemBg = isDark ? '#16213e' : '#f8f9fa';
  const itemHover = isDark ? '#0f3460' : '#e9ecef';
  const accent = isDark ? '#4a9eff' : '#0066cc';
  const accentAlt = isDark ? '#7b5cff' : '#5b8def';
  const danger = isDark ? '#ff6b6b' : '#c0392b';
  const overlayBg = 'rgba(0, 0, 0, 0.5)';

  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${overlayBg};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .modal {
      background: ${bg};
      color: ${text};
      border-radius: 16px;
      width: 420px;
      max-width: 92vw;
      max-height: 86vh;
      overflow-y: auto;
      padding: 24px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideUp 0.2s ease-out;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
    }

    h2 { font-size: 18px; font-weight: 600; }

    .close-btn {
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: ${muted};
      padding: 4px 8px;
      border-radius: 8px;
      line-height: 1;
    }
    .close-btn:hover { color: ${text}; background: ${itemBg}; }

    .quick-connect {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      text-align: left;
      padding: 14px 16px;
      margin-bottom: 18px;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      color: #fff;
      background: linear-gradient(135deg, ${accent}, ${accentAlt});
      transition: filter 0.15s;
    }
    .quick-connect:hover { filter: brightness(1.08); }
    .quick-bolt { font-size: 22px; line-height: 1; }
    .quick-text { display: flex; flex-direction: column; gap: 2px; }
    .quick-label { font-weight: 600; font-size: 15px; }
    .quick-sub { font-size: 12px; opacity: 0.85; }

    .wallet-search {
      width: 100%;
      padding: 10px 14px;
      margin-bottom: 12px;
      border: 1px solid ${border};
      border-radius: 10px;
      font-size: 14px;
      background: ${itemBg};
      color: ${text};
      outline: none;
    }
    .wallet-search:focus { border-color: ${accent}; }
    .wallet-search::placeholder { color: ${muted}; }

    .wallet-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      max-height: 216px;
      overflow-y: auto;
      padding: 2px;
    }

    .wallet-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 8px;
      background: ${itemBg};
      border: 1px solid ${border};
      border-radius: 12px;
      cursor: pointer;
      color: ${text};
      transition: background 0.15s, border-color 0.15s;
    }
    .wallet-item:hover { background: ${itemHover}; border-color: ${accent}; }

    .wallet-icon {
      position: relative;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .wallet-badge {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      background: ${itemHover};
      color: ${text};
      font-size: 18px;
      font-weight: 600;
    }
    .wallet-img {
      position: relative;
      width: 40px;
      height: 40px;
      border-radius: 10px;
      object-fit: cover;
      background: ${bg};
    }

    .wallet-name {
      font-size: 13px;
      font-weight: 500;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .grid-empty {
      grid-column: 1 / -1;
      padding: 16px;
      text-align: center;
      color: ${muted};
      font-size: 13px;
    }

    .separator {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 20px 0;
      color: ${muted};
      font-size: 13px;
    }
    .sep-line { flex: 1; height: 1px; background: ${border}; }

    .custom-label {
      display: block;
      font-size: 13px;
      color: ${muted};
      margin-bottom: 8px;
    }

    .input-group { display: flex; gap: 8px; }

    .url-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid ${border};
      border-radius: 10px;
      font-size: 14px;
      background: ${itemBg};
      color: ${text};
      outline: none;
    }
    .url-input:focus { border-color: ${accent}; }
    .url-input::placeholder { color: ${muted}; }

    .go-btn {
      padding: 10px 18px;
      border: none;
      border-radius: 10px;
      background: ${accent};
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .go-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .go-btn:not(:disabled):hover { filter: brightness(1.1); }

    .url-error {
      margin-top: 8px;
      font-size: 12px;
      color: ${danger};
    }
  `;
}
