/**
 * Wallet selector modal — a self-contained, framework-agnostic UI component.
 *
 * Injected into the DOM as a Shadow DOM element to prevent style conflicts.
 * Inspired by WalletConnect's Web3Modal pattern.
 *
 * @module
 */

import type { WalletOption } from '../browser-connect-handler.js';

/** Shows the wallet selector modal and resolves with the chosen wallet URL. */
export function showWalletSelector(wallets: WalletOption[]): Promise<string> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('[@enbox/auth] Wallet selector is only available in browser environments.');
  }

  return new Promise<string>((resolve, reject) => {
    // Create the host element with Shadow DOM isolation.
    const host = document.createElement('div');
    host.id = 'enbox-wallet-selector';
    const shadow = host.attachShadow({ mode: 'open' });

    const cleanup = (): void => {
      try { document.body.removeChild(host); } catch { /* best effort */ }
    };

    // Detect dark mode.
    const isDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;

    // Build styles.
    const style = document.createElement('style');
    style.textContent = buildStyles(isDark);
    shadow.appendChild(style);

    // Build modal DOM.
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    // Header
    const header = document.createElement('div');
    header.className = 'header';

    const title = document.createElement('h2');
    title.textContent = 'Connect Wallet';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      cleanup();
      reject(new Error('[@enbox/auth] Wallet selection cancelled.'));
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Wallet list
    const list = document.createElement('div');
    list.className = 'wallet-list';

    for (const wallet of wallets) {
      const item = document.createElement('button');
      item.className = 'wallet-item';

      const icon = document.createElement('img');
      icon.src = wallet.icon ?? faviconUrl(wallet.url);
      icon.alt = wallet.name;
      icon.width = 32;
      icon.height = 32;
      icon.onerror = (): void => { icon.style.display = 'none'; };

      const name = document.createElement('span');
      name.className = 'wallet-name';
      name.textContent = wallet.name;

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '\u203A'; // ›

      item.appendChild(icon);
      item.appendChild(name);
      item.appendChild(arrow);

      item.addEventListener('click', () => {
        cleanup();
        resolve(wallet.url);
      });

      list.appendChild(item);
    }

    modal.appendChild(list);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'separator';

    const sepLine1 = document.createElement('div');
    sepLine1.className = 'sep-line';
    const sepText = document.createElement('span');
    sepText.textContent = 'or';
    const sepLine2 = document.createElement('div');
    sepLine2.className = 'sep-line';

    sep.appendChild(sepLine1);
    sep.appendChild(sepText);
    sep.appendChild(sepLine2);
    modal.appendChild(sep);

    // Custom URL input
    const inputGroup = document.createElement('div');
    inputGroup.className = 'input-group';

    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = 'Enter wallet URL...';
    input.className = 'url-input';

    const goBtn = document.createElement('button');
    goBtn.className = 'go-btn';
    goBtn.textContent = 'Connect';
    goBtn.disabled = true;

    input.addEventListener('input', () => {
      goBtn.disabled = !isValidUrl(input.value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isValidUrl(input.value)) {
        cleanup();
        resolve(normalizeUrl(input.value));
      }
    });

    goBtn.addEventListener('click', () => {
      if (isValidUrl(input.value)) {
        cleanup();
        resolve(normalizeUrl(input.value));
      }
    });

    inputGroup.appendChild(input);
    inputGroup.appendChild(goBtn);
    modal.appendChild(inputGroup);

    // Close on overlay click.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        reject(new Error('[@enbox/auth] Wallet selection cancelled.'));
      }
    });

    // Close on Escape.
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKeydown);
        cleanup();
        reject(new Error('[@enbox/auth] Wallet selection cancelled.'));
      }
    };
    document.addEventListener('keydown', onKeydown);

    overlay.appendChild(modal);
    shadow.appendChild(overlay);
    document.body.appendChild(host);

    // Focus the input for keyboard-first users.
    input.focus();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────

function faviconUrl(walletUrl: string): string {
  return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${walletUrl}&size=128`;
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string {
  if (!value.includes('://')) {
    value = `https://${value}`;
  }
  const url = new URL(value);
  // Return origin only (strip path/trailing slash).
  return url.origin;
}

function buildStyles(isDark: boolean): string {
  const bg = isDark ? '#1a1a2e' : '#ffffff';
  const text = isDark ? '#e0e0e0' : '#1a1a2e';
  const muted = isDark ? '#888' : '#666';
  const border = isDark ? '#333' : '#e0e0e0';
  const itemBg = isDark ? '#16213e' : '#f8f9fa';
  const itemHover = isDark ? '#0f3460' : '#e9ecef';
  const accent = isDark ? '#4a9eff' : '#0066cc';
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
      width: 380px;
      max-width: 90vw;
      max-height: 80vh;
      overflow-y: auto;
      padding: 24px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideUp 0.2s ease-out;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    h2 {
      font-size: 18px;
      font-weight: 600;
    }

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

    .wallet-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .wallet-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: ${itemBg};
      border: 1px solid ${border};
      border-radius: 12px;
      cursor: pointer;
      font-size: 15px;
      color: ${text};
      transition: background 0.15s;
      width: 100%;
      text-align: left;
    }
    .wallet-item:hover { background: ${itemHover}; }

    .wallet-name { flex: 1; font-weight: 500; }

    .arrow {
      font-size: 20px;
      color: ${muted};
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

    .input-group {
      display: flex;
      gap: 8px;
    }

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
    .go-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .go-btn:not(:disabled):hover { filter: brightness(1.1); }
  `;
}
