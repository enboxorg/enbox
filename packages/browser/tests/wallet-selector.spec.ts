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

function inputWalletUrl(value: string): void {
  const input = queryRequired<HTMLInputElement>('.url-input');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('showWalletSelector', () => {
  afterEach(() => {
    document.querySelector('#enbox-wallet-selector')?.remove();
  });

  it('should render wallet choices, resolve selected wallet URL, and clean up the modal', async () => {
    const promise = showWalletSelector(WALLETS);
    const walletItems = Array.from(getShadowRoot().querySelectorAll<HTMLButtonElement>('.wallet-item'));

    expect(walletItems).toHaveLength(2);
    expect(walletItems[0].querySelector('.wallet-name')?.textContent).toBe('Enbox Wallet');
    expect(walletItems[0].querySelector('.wallet-description')?.textContent).toBe('Primary test wallet');
    expect(walletItems[0].querySelector<HTMLImageElement>('img')?.src).toBe(WALLETS[0].icon);

    const fallbackIcon = walletItems[1].querySelector<HTMLImageElement>('img');
    expect(fallbackIcon?.src).toContain('https://t3.gstatic.com/faviconV2');
    expect(fallbackIcon?.src).toContain(`url=${WALLETS[1].url}`);

    fallbackIcon?.onerror?.(new Event('error'));
    expect(fallbackIcon?.style.display).toBe('none');

    walletItems[1].click();

    await expect(promise).resolves.toBe(WALLETS[1].url);
    expect(document.querySelector('#enbox-wallet-selector')).toBeNull();
  });

  it('should enable custom URL submission only for valid URLs and normalize to the origin', async () => {
    const promise = showWalletSelector(WALLETS);
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

  it('should submit a valid custom URL when Enter is pressed', async () => {
    const promise = showWalletSelector(WALLETS);

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
