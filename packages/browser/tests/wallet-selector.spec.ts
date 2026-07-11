import type { WalletOption } from '../src/browser-connect-handler.js';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { showWalletSelector } from '../src/ui/wallet-selector.js';

const WALLETS: WalletOption[] = [
  {
    name        : 'Enbox Wallet',
    url         : 'https://wallet.example.com',
    icon        : 'https://wallet.example.com/icon.png',
    description : 'Primary test wallet',
  },
  {
    name        : 'Fallback Wallet',
    url         : 'https://fallback.example.com/connect',
    description : 'Wallet without a custom icon',
  },
];

const ALWAYS_VALID = { validateWalletUrl: async (): Promise<boolean> => true };
const ALWAYS_INVALID = { validateWalletUrl: async (): Promise<boolean> => false };

function getHost(): HTMLDivElement {
  const host = document.querySelector<HTMLDivElement>('#enbox-wallet-selector');
  if (host === null) {
    throw new Error('expected wallet selector host to exist');
  }

  return host;
}

function getShadowRoot(): ShadowRoot {
  const shadow = getHost().shadowRoot;
  if (shadow === null) {
    throw new Error('expected wallet selector shadow root to exist');
  }

  return shadow;
}

function queryRequired<T extends Element>(selector: string): T {
  const element = getShadowRoot().querySelector<T>(selector);
  if (element === null) {
    throw new Error(`expected selector '${selector}' to match`);
  }

  return element;
}

function walletItems(): HTMLButtonElement[] {
  return Array.from(getShadowRoot().querySelectorAll<HTMLButtonElement>('.wallet-item'));
}

function inputWalletUrl(value: string): void {
  const input = queryRequired<HTMLInputElement>('.url-input');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('showWalletSelector', () => {
  afterEach(() => {
    document.querySelector('#enbox-wallet-selector')?.remove();
  });

  it('should quick-connect with the first (recommended) wallet', async () => {
    const promise = showWalletSelector(WALLETS);

    const quick = queryRequired<HTMLButtonElement>('.quick-connect');
    expect(quick.querySelector('.quick-sub')?.textContent).toBe('Connect with Enbox Wallet');
    quick.click();

    await expect(promise).resolves.toBe(WALLETS[0].url);
    expect(document.querySelector('#enbox-wallet-selector')).toBeNull();
  });

  it('should render a wallet tile grid and resolve the clicked wallet URL', async () => {
    const promise = showWalletSelector(WALLETS);
    const items = walletItems();

    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.wallet-name')?.textContent).toBe('Enbox Wallet');
    expect(items[1].querySelector('.wallet-name')?.textContent).toBe('Fallback Wallet');

    items[1].click();

    await expect(promise).resolves.toBe(WALLETS[1].url);
    expect(document.querySelector('#enbox-wallet-selector')).toBeNull();
  });

  it('should filter the wallet grid by the search query', async () => {
    const promise = showWalletSelector(WALLETS);
    const search = queryRequired<HTMLInputElement>('.wallet-search');

    search.value = 'fallback';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const items = walletItems();
    expect(items[0].style.display).toBe('none');
    expect(items[1].style.display).toBe('');

    search.value = 'nonexistent-wallet';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(queryRequired<HTMLDivElement>('.grid-empty').style.display).toBe('');

    queryRequired<HTMLButtonElement>('.close-btn').click();
    await expect(promise).rejects.toThrow('Wallet selection cancelled');
  });

  it('should use the wallet own-favicon (never a third-party proxy) with a letter-badge fallback', async () => {
    const promise = showWalletSelector(WALLETS);
    const items = walletItems();

    // Explicit icon is used as-is.
    expect(items[0].querySelector<HTMLImageElement>('.wallet-img')?.src).toBe(WALLETS[0].icon);

    // No icon → the wallet's own origin favicon, not a gstatic/Google proxy.
    const fallbackImg = items[1].querySelector<HTMLImageElement>('.wallet-img');
    expect(fallbackImg?.src).toBe('https://fallback.example.com/favicon.svg');
    expect(fallbackImg?.src).not.toContain('gstatic');

    // Every tile carries a letter-badge fallback beneath the image.
    expect(items[1].querySelector('.wallet-badge')?.textContent).toBe('F');

    // On repeated load errors the image is dropped, leaving the badge.
    fallbackImg?.dispatchEvent(new Event('error')); // → favicon.ico
    expect(items[1].querySelector<HTMLImageElement>('.wallet-img')?.src).toBe('https://fallback.example.com/favicon.ico');

    queryRequired<HTMLButtonElement>('.close-btn').click();
    await expect(promise).rejects.toThrow('Wallet selection cancelled');
  });

  it('should validate a custom URL, normalize to origin, and resolve when the wallet checks out', async () => {
    const promise = showWalletSelector(WALLETS, ALWAYS_VALID);
    const goButton = queryRequired<HTMLButtonElement>('.go-btn');

    expect(goButton.disabled).toBe(true);

    inputWalletUrl('ftp://wallet.example.com');
    expect(goButton.disabled).toBe(true);

    inputWalletUrl('wallet.example.com/path?ignored=true');
    expect(goButton.disabled).toBe(false);

    goButton.click();

    await expect(promise).resolves.toBe('https://wallet.example.com');
    expect(document.querySelector('#enbox-wallet-selector')).toBeNull();
  });

  it('should surface a validation failure and allow an explicit override', async () => {
    const promise = showWalletSelector(WALLETS, ALWAYS_INVALID);
    const goButton = queryRequired<HTMLButtonElement>('.go-btn');

    inputWalletUrl('https://not-a-wallet.example');
    goButton.click();
    await flush();

    expect(queryRequired<HTMLDivElement>('.url-error').style.display).toBe('');
    expect(goButton.textContent).toBe('Connect anyway');

    goButton.click();
    await expect(promise).resolves.toBe('https://not-a-wallet.example');
  });

  it('should submit a valid custom URL when Enter is pressed', async () => {
    const promise = showWalletSelector(WALLETS, ALWAYS_VALID);

    inputWalletUrl('http://localhost:3000/wallet');
    queryRequired<HTMLInputElement>('.url-input').dispatchEvent(new KeyboardEvent('keydown', {
      bubbles : true,
      key     : 'Enter',
    }));

    await expect(promise).resolves.toBe('http://localhost:3000');
  });

  it('should reject and clean up when the close button is clicked', async () => {
    const promise = showWalletSelector(WALLETS);

    queryRequired<HTMLButtonElement>('.close-btn').click();

    await expect(promise).rejects.toThrow('Wallet selection cancelled');
    expect(document.querySelector('#enbox-wallet-selector')).toBeNull();
  });

  it('should reject and clean up when the overlay is clicked', async () => {
    const promise = showWalletSelector(WALLETS);

    queryRequired<HTMLDivElement>('.overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await expect(promise).rejects.toThrow('Wallet selection cancelled');
    expect(document.querySelector('#enbox-wallet-selector')).toBeNull();
  });

  it('should reject and clean up when Escape is pressed', async () => {
    const promise = showWalletSelector(WALLETS);

    document.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles : true,
      key     : 'Escape',
    }));

    await expect(promise).rejects.toThrow('Wallet selection cancelled');
    expect(document.querySelector('#enbox-wallet-selector')).toBeNull();
  });

  it('should use dark mode styles when the browser prefers a dark color scheme', () => {
    const matchMediaSpy = spyOn(window, 'matchMedia').mockReturnValue({
      addEventListener    : () => undefined,
      addListener         : () => undefined,
      dispatchEvent       : () => false,
      matches             : true,
      media               : '(prefers-color-scheme: dark)',
      onchange            : null,
      removeEventListener : () => undefined,
      removeListener      : () => undefined,
    });

    const promise = showWalletSelector(WALLETS);
    const styles = queryRequired<HTMLStyleElement>('style').textContent;
    queryRequired<HTMLButtonElement>('.close-btn').click();

    matchMediaSpy.mockRestore();

    expect(styles).toContain('background: #1a1a2e');
    return expect(promise).rejects.toThrow('Wallet selection cancelled');
  });
});
