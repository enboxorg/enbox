/**
 * Wallet icon builder shared by the connect modal's wallet switcher.
 *
 * Prefers the wallet's own favicon and degrades to a letter badge. We never
 * call a third-party favicon proxy: those 404 for many origins and leak the
 * wallet URL to the proxy.
 *
 * @module
 */

import type { WalletOption } from '../browser-connect-handler.js';

/** Build a wallet icon element (own favicon with a letter-badge fallback). */
export function buildWalletIcon(wallet: WalletOption): HTMLElement {
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
  img.width = 28;
  img.height = 28;

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
