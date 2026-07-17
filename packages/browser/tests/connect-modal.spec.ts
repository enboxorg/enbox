import type { ConnectModalDeps } from '../src/ui/connect-modal.js';
import type { PortableDid } from '@enbox/dids';
import type { WalletOption } from '../src/browser-connect-handler.js';
import type { ConnectPermissionRequest, ConnectRequestType, ConnectResult, WalletUriHandoff } from '@enbox/connect';

import { afterEach, describe, expect, it } from 'bun:test';

import { PopupWindowClosedError } from '../src/dweb-connect-client.js';
import { runConnectModal } from '../src/ui/connect-modal.js';

const WALLETS: WalletOption[] = [
  { name: 'Enbox', url: 'https://wallet-one.example.com' },
  { name: 'Prism', url: 'https://wallet-two.example.com' },
];

const PERMISSIONS: ConnectPermissionRequest[] = [
  {
    protocolDefinition : { protocol: 'https://proto.example.com', types: {}, structure: {} },
    permissionScopes   : [{ protocol: 'https://proto.example.com', interface: 'Records', method: 'Write' }],
  } as unknown as ConnectPermissionRequest,
];

const HANDOFF: WalletUriHandoff = {
  walletUri  : 'https://wallet-one.example.com/connect/app#request_uri=r&encryption_key=k',
  requestUri : 'https://relay.example.com/connect/par/r',
  expiresIn  : 600,
};

const DELEGATE_PORTABLE_DID = { uri: 'did:jwk:delegate' } as unknown as PortableDid;

const RESULT = {
  delegatePortableDid : DELEGATE_PORTABLE_DID,
  delegateGrants      : [],
  connectedDid        : 'did:dht:provider',
  sessionRevocations  : [],
} as unknown as ConnectResult;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-memory Storage stand-in. */
function createFakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { dump: () => Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem    : (key: string): string | null => map.get(key) ?? null,
    setItem    : (key: string, value: string): void => { map.set(key, value); },
    removeItem : (key: string): void => { map.delete(key); },
    dump       : (): Record<string, string> => Object.fromEntries(map),
  };
}

/**
 * A controllable relay driver: records its invocations and exposes the
 * callbacks so tests can walk the session through QR → PIN → result.
 */
type FakeRelayCall = {
  walletUri: string;
  connectServerUrl: string;
  onWalletUriReady: (handoff: WalletUriHandoff) => void;
  onClaimed?: () => void;
  requestPin: (attempt: number, previousError?: Error) => Promise<string>;
  delegatePortableDid?: PortableDid;
  requestType?: ConnectRequestType;
  resolve: (result: ConnectResult | undefined) => void;
  reject: (error: Error) => void;
};

function createFakeRelay(): { calls: FakeRelayCall[]; runRelay: ConnectModalDeps['runRelay'] } {
  const calls: FakeRelayCall[] = [];

  const runRelay: ConnectModalDeps['runRelay'] = (options) => {
    return new Promise<ConnectResult | undefined>((resolve, reject) => {
      calls.push({
        walletUri           : options.walletUri,
        connectServerUrl    : options.connectServerUrl,
        onWalletUriReady    : options.onWalletUriReady,
        onClaimed           : options.onClaimed,
        requestPin          : options.requestPin,
        delegatePortableDid : options.delegatePortableDid,
        requestType         : options.requestType,
        resolve,
        reject,
      });
      options.cancelled?.catch((error: Error) => reject(error));
    });
  };

  return { calls, runRelay };
}

function shadowRoot(): ShadowRoot {
  const host = document.querySelector<HTMLDivElement>('#enbox-connect-modal');
  if (host?.shadowRoot == null) {
    throw new Error('expected the connect modal to be mounted');
  }
  return host.shadowRoot;
}

function stageText(): string {
  return shadowRoot().querySelector('.stage')?.textContent ?? '';
}

function rowTiles(): HTMLButtonElement[] {
  return Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.row-tile:not(.more-tile)'));
}

function rowNames(): Array<string | undefined> {
  return rowTiles().map((tile) => tile.querySelector('.row-tile-name')?.textContent ?? undefined);
}

function deps(overrides: Partial<ConnectModalDeps>): Partial<ConnectModalDeps> {
  return {
    discoverConnectServerUrl : async (): Promise<string> => 'https://relay.example.com/connect',
    validateWalletUrl        : async (): Promise<boolean> => true,
    isMobile                 : (): boolean => false,
    storage                  : createFakeStorage(),
    ...overrides,
  };
}

describe('runConnectModal', () => {
  afterEach(() => {
    document.querySelector('#enbox-connect-modal')?.remove();
  });

  it('renders the QR stage for the phone path by default', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      appName            : 'Test Dapp',
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0].walletUri).toBe('https://wallet-one.example.com/connect/app');
    expect(relay.calls[0].connectServerUrl).toBe('https://relay.example.com/connect');
    expect(relay.calls[0].delegatePortableDid).toBeUndefined();
    expect(relay.calls[0].requestType).toBeUndefined();

    relay.calls[0].onWalletUriReady(HANDOFF);
    expect(shadowRoot().querySelector('.qr-box svg')).not.toBeNull();
    expect(stageText()).toContain('Scan with your phone');

    // The QR card is itself a same-device handoff link into a new tab.
    const qr = shadowRoot().querySelector<HTMLAnchorElement>('a.qr-box');
    expect(qr?.href).toBe(HANDOFF.walletUri);
    expect(qr?.target).toBe('_blank');
    expect(qr?.rel).toContain('noopener');
    expect(stageText()).toContain('or click the code to open it here');

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('locks a refresh to the remembered wallet and threads the relay request', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage({
      'enbox:connect:lastChoice': JSON.stringify({ method: 'phone', walletUrl: WALLETS[1].url }),
    });
    const promise = runConnectModal({
      wallets             : WALLETS,
      appName             : 'Test Dapp',
      mode                : 'refresh',
      delegatePortableDid : DELEGATE_PORTABLE_DID,
      permissionRequests  : PERMISSIONS,
      deps                : deps({ runRelay: relay.runRelay, storage }),
    });
    promise.catch((): undefined => undefined);

    await flush();

    expect(shadowRoot().querySelector('.header h2')?.textContent).toBe('Reconnect to Test Dapp');
    expect(shadowRoot().querySelector('.modal')?.getAttribute('aria-label')).toBe('Reconnect to Test Dapp');
    expect(shadowRoot().querySelector('.wallet-row')).toBeNull();
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0].walletUri).toBe('https://wallet-two.example.com/connect/app');
    expect(relay.calls[0].delegatePortableDid).toBe(DELEGATE_PORTABLE_DID);
    expect(relay.calls[0].requestType).toBe('refresh');

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('threads a refresh through the remembered popup wallet after a user gesture', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage({
      'enbox:connect:lastChoice': JSON.stringify({ method: 'browser', walletUrl: WALLETS[1].url }),
    });
    const popupCalls: Parameters<ConnectModalDeps['runPopup']>[0][] = [];
    const promise = runConnectModal({
      wallets             : WALLETS,
      appName             : 'Test Dapp',
      mode                : 'refresh',
      delegatePortableDid : DELEGATE_PORTABLE_DID,
      permissionRequests  : PERMISSIONS,
      deps                : deps({
        runRelay : relay.runRelay,
        runPopup : (options): Promise<ConnectResult | undefined> => {
          popupCalls.push(options);
          return new Promise<ConnectResult | undefined>(() => { /* pending */ });
        },
        storage,
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(popupCalls).toHaveLength(0);
    expect(shadowRoot().querySelector('.wallet-row')).toBeNull();

    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();

    expect(popupCalls).toHaveLength(1);
    expect(popupCalls[0].walletUrl).toBe(WALLETS[1].url);
    expect(popupCalls[0].delegatePortableDid).toBe(DELEGATE_PORTABLE_DID);
    expect(popupCalls[0].requestType).toBe('refresh');

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('keeps the wallet switcher available when a remembered refresh wallet is invalid', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage({
      'enbox:connect:lastChoice': JSON.stringify({ method: 'phone', walletUrl: 'not a wallet URL' }),
    });
    const promise = runConnectModal({
      wallets             : WALLETS,
      mode                : 'refresh',
      delegatePortableDid : DELEGATE_PORTABLE_DID,
      permissionRequests  : PERMISSIONS,
      deps                : deps({ runRelay: relay.runRelay, storage }),
    });
    promise.catch((): undefined => undefined);

    await flush();

    expect(shadowRoot().querySelector('.wallet-row')).not.toBeNull();
    expect(relay.calls[0].walletUri).toBe('https://wallet-one.example.com/connect/app');

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('rejects refresh mode without an existing delegate', () => {
    expect(() => runConnectModal({
      wallets            : WALLETS,
      mode               : 'refresh',
      permissionRequests : PERMISSIONS,
    })).toThrow('refresh requests require an existing `delegatePortableDid`');
  });

  it('walks pairing-code entry through to success and remembers the choice', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage();
    const promise = runConnectModal({
      wallets            : WALLETS,
      appName            : 'Test Dapp',
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay, storage }),
    });

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);

    // Wallet responded — the runner asks for the pairing code.
    const pinPromise = relay.calls[0].requestPin(1);
    const inputs = Array.from(shadowRoot().querySelectorAll<HTMLInputElement>('.pin-input'));
    expect(inputs).toHaveLength(4);
    expect(stageText()).toContain('Enter the code shown in Enbox');

    ['1', '2', '3', '4'].forEach((digit, index) => {
      inputs[index].value = digit;
      inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(pinPromise).resolves.toBe('1234');

    relay.calls[0].resolve(RESULT);
    await flush();
    expect(stageText()).toContain('You’re connected.');

    await sleep(1_300);
    await expect(promise).resolves.toBe(RESULT);
    expect(JSON.parse(storage.dump()['enbox:connect:lastChoice'])).toEqual({
      method    : 'phone',
      walletUrl : 'https://wallet-one.example.com',
    });
  });

  it('shakes and retries on a mistyped pairing code', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);

    void relay.calls[0].requestPin(2, new Error('decrypt failed'));
    await flush();
    expect(shadowRoot().querySelector('.pin-row.shake')).not.toBeNull();
    expect(stageText()).toContain('That code doesn’t match');
  });

  it('shows the denial stage and resolves undefined on Close', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });

    await flush();
    relay.calls[0].resolve(undefined);
    await flush();

    expect(stageText()).toContain('No problem — nothing was shared.');
    const closeButtons = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'));
    closeButtons.find((button) => button.textContent === 'Close')?.click();

    await expect(promise).resolves.toBeUndefined();
  });

  it('renders a new-tab deep link alongside a clickable compact QR on mobile', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay, isMobile: (): boolean => true }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);

    // The primary action opens the wallet in a NEW tab: the modal — and the
    // relay session under it — stays alive for the pairing-code entry.
    const link = shadowRoot().querySelector<HTMLAnchorElement>('.deep-link');
    expect(link).not.toBeNull();
    expect(link?.href).toBe(HANDOFF.walletUri);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
    expect(link?.textContent).toContain('Continue in Enbox');

    // The QR stays for cross-device auth, compact and itself a handoff link.
    const qr = shadowRoot().querySelector<HTMLAnchorElement>('a.qr-box');
    expect(qr).not.toBeNull();
    expect(qr?.classList.contains('compact')).toBe(true);
    expect(qr?.href).toBe(HANDOFF.walletUri);
    expect(qr?.target).toBe('_blank');
    expect(qr?.querySelector('svg')).not.toBeNull();
    expect(stageText()).toContain('or scan with another phone');
  });

  it('morphs to the away stage when a handoff link is followed and recovers via Start over', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);

    const qr = shadowRoot().querySelector<HTMLAnchorElement>('a.qr-box');
    if (qr == null) { throw new Error('expected the QR handoff link'); }
    // Keep the test tab put — the modal's own listener still runs.
    qr.addEventListener('click', (event) => { event.preventDefault(); });
    qr.click();
    await flush();

    expect(stageText()).toContain('Finish in Enbox');
    expect(stageText()).toContain('come back here for your code');

    // Start over mints a fresh pointer — the one the wallet tab carried away
    // is single-use.
    Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'))
      .find((button) => button.textContent === 'Start over')
      ?.click();
    await flush();
    expect(relay.calls).toHaveLength(2);
  });

  it('routes an interrupted mobile popup back to the code path', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay : relay.runRelay,
        isMobile : (): boolean => true,
        runPopup : (): Promise<ConnectResult | undefined> => Promise.reject(new PopupWindowClosedError()),
      }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    // On a phone the popup alternative is pitched as skipping the code.
    const methodLink = shadowRoot().querySelector<HTMLButtonElement>('.method-link');
    expect(methodLink?.textContent).toContain('without a code');
    methodLink?.click();
    await flush();

    expect(stageText()).toContain('The wallet tab was closed.');
    const back = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'))
      .find((button) => button.textContent === 'Use a code instead');
    expect(back).toBeDefined();
    back?.click();
    await flush();

    expect(relay.calls).toHaveLength(2);
  });

  it('offers popup recovery when the browser rejects the popup open', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay : relay.runRelay,
        runPopup : (): Promise<ConnectResult | undefined> => Promise.reject(new Error('Popup blocked by browser')),
      }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    shadowRoot().querySelector<HTMLButtonElement>('.method-link')?.click();
    await flush();

    expect(stageText()).toContain('Your browser blocked the wallet window.');
    const retry = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage button'))
      .find((button) => button.textContent === 'Open it now');
    expect(retry).toBeDefined();
  });

  it('shows the timeout message when popup connection times out', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay : relay.runRelay,
        runPopup : (): Promise<ConnectResult | undefined> => Promise.reject(new Error('Popup connection timed out')),
      }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    shadowRoot().querySelector<HTMLButtonElement>('.method-link')?.click();
    await flush();

    expect(stageText()).toContain('That took too long, so we stopped for safety.');
  });

  it('shows the generic error when popup launch throws synchronously', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay : relay.runRelay,
        runPopup : (): Promise<ConnectResult | undefined> => { throw new Error('Popup launch failed'); },
      }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    shadowRoot().querySelector<HTMLButtonElement>('.method-link')?.click();
    await flush();

    expect(stageText()).toContain('Something went wrong while connecting.');
  });

  it('centres the selected wallet’s mark on the QR and names it in the caption', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);

    const logo = shadowRoot().querySelector('.qr-logo');
    expect(logo).not.toBeNull();
    expect(logo?.querySelector('.wallet-badge')?.textContent).toBe('E');
    expect(stageText()).toContain('Enbox stays on your phone');
  });

  it('invokes the popup path synchronously from the footer link', async () => {
    const relay = createFakeRelay();
    let popupCalls = 0;
    let popupCalledSynchronously = false;

    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay : relay.runRelay,
        runPopup : (options): Promise<ConnectResult | undefined> => {
          popupCalls++;
          popupCalledSynchronously = true;
          expect(options.walletUrl).toBe('https://wallet-one.example.com');
          return Promise.resolve(RESULT);
        },
      }),
    });

    await flush();
    const methodLink = shadowRoot().querySelector<HTMLButtonElement>('.method-link');
    expect(methodLink?.textContent).toContain('Use this browser');

    methodLink?.click();
    // The popup runner must have been entered inside the click dispatch.
    expect(popupCalledSynchronously).toBe(true);
    expect(popupCalls).toBe(1);

    await sleep(1_300);
    await expect(promise).resolves.toBe(RESULT);
  });

  it('prompts (never auto-opens) when the remembered method is the browser popup', async () => {
    const relay = createFakeRelay();
    let popupCalls = 0;
    const storage = createFakeStorage({
      'enbox:connect:lastChoice': JSON.stringify({ method: 'browser', walletUrl: WALLETS[0].url }),
    });

    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay : relay.runRelay,
        runPopup : (): Promise<ConnectResult | undefined> => { popupCalls++; return Promise.resolve(RESULT); },
        storage,
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(popupCalls).toBe(0);
    expect(relay.calls).toHaveLength(0);
    expect(stageText()).toContain('Open wallet window');
  });

  it('falls back gracefully when the wallet publishes no connectServerUrl', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay                 : relay.runRelay,
        discoverConnectServerUrl : async (): Promise<undefined> => undefined,
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(0);
    expect(stageText()).toContain('can’t connect by phone');
  });

  it('re-mints for a wallet picked from the identity row without reordering it', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(1);

    rowTiles().find((tile) => tile.querySelector('.row-tile-name')?.textContent === 'Prism')?.click();
    await flush();

    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[1].walletUri).toBe('https://wallet-two.example.com/connect/app');

    // In-row switch: the slots stay stable, only the highlight moves.
    expect(rowNames()).toEqual(['Enbox', 'Prism']);
    expect(rowTiles()[1].getAttribute('aria-checked')).toBe('true');
    expect(rowTiles()[0].getAttribute('aria-checked')).toBe('false');
  });

  it('adopts a wallet picked from the expanded grid into the row’s first slot', async () => {
    const relay = createFakeRelay();
    const many: WalletOption[] = ['Aurora', 'Basalt', 'Cinder', 'Dune', 'Ember', 'Fjord']
      .map((name) => ({ name, url: `https://${name.toLowerCase()}.example.com` }));
    const promise = runConnectModal({
      wallets            : many,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    expect(rowNames()).toEqual(['Aurora', 'Basalt', 'Cinder']);
    expect(shadowRoot().querySelector('.more-count')?.textContent).toBe('+3');

    const gridNames = (): Array<string | null> => Array.from(
      shadowRoot().querySelectorAll('.wallet-tile .wallet-tile-name'),
    ).map((name) => name.textContent);

    // The expanded grid holds only the wallets not already in the row.
    shadowRoot().querySelector<HTMLButtonElement>('.more-tile')?.click();
    expect(gridNames()).toEqual(['Dune', 'Ember', 'Fjord']);

    const tiles = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.wallet-tile'));
    tiles.find((tile) => tile.querySelector('.wallet-tile-name')?.textContent === 'Fjord')?.click();
    await flush();

    // Fjord takes the first slot, the rest refill by catalog priority, and
    // no wallet appears twice; picking collapses the panel and re-mints.
    expect(rowNames()).toEqual(['Fjord', 'Aurora', 'Basalt']);
    expect(shadowRoot().querySelector('.row-tile.selected .row-tile-name')?.textContent).toBe('Fjord');
    expect(shadowRoot().querySelector<HTMLElement>('.wallet-panel')?.hidden).toBe(true);
    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[1].walletUri).toBe('https://fjord.example.com/connect/app');

    // Re-expanding still shows only the wallets outside the recomposed row.
    shadowRoot().querySelector<HTMLButtonElement>('.more-tile')?.click();
    expect(gridNames()).toEqual(['Cinder', 'Dune', 'Ember']);
  });

  it('adopts a validated custom wallet URL into the row and re-mints', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    shadowRoot().querySelector<HTMLButtonElement>('.more-tile')?.click();
    const input = shadowRoot().querySelector<HTMLInputElement>('.url-input');
    if (input == null) { throw new Error('expected the custom URL input'); }
    input.value = 'custom-wallet.example/path';
    shadowRoot().querySelector<HTMLButtonElement>('.url-go')?.click();
    await flush();
    await flush();

    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[1].walletUri).toBe('https://custom-wallet.example/connect/app');
    expect(rowNames()).toEqual(['custom-wallet.example', 'Enbox', 'Prism']);
    expect(shadowRoot().querySelector('.row-tile.selected .row-tile-name')?.textContent).toBe('custom-wallet.example');
  });

  it('injects a well-formed stylesheet with the claimed pulse as its own rule', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    const css = shadowRoot().querySelector('style')?.textContent ?? '';
    // Balanced braces — a nesting slip once swallowed whole rules silently.
    expect(css.match(/\{/g) ?? []).toHaveLength((css.match(/\}/g) ?? []).length);
    expect(css).toMatch(/\}\s*\.claimed-pulse\s*\{/);
    // The QR card keeps its scannable white ground in both appearances.
    const qrRule = /\.qr-box\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(qrRule).toContain('background: #ffffff');
  });

  it('shows the identity row with the selected wallet and expands the catalog from the More tile', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    // The identity row names the selected wallet and highlights it.
    expect(shadowRoot().querySelector('.wallet-row-label')?.textContent).toBe('Connecting with');
    expect(rowNames()).toEqual(['Enbox', 'Prism']);
    expect(rowTiles()[0].getAttribute('aria-checked')).toBe('true');
    expect(rowTiles()[0].classList.contains('selected')).toBe(true);
    expect(rowTiles()[1].getAttribute('aria-checked')).toBe('false');

    // Nothing hidden beyond the row — the More tile still reaches the panel.
    const more = shadowRoot().querySelector<HTMLButtonElement>('.more-tile');
    expect(more?.querySelector('.more-count')?.textContent).toBe('⋯');

    // The catalog starts collapsed for real: the panel's flex display must
    // not defeat the hidden attribute (it once left the panel always open).
    const panel = shadowRoot().querySelector<HTMLElement>('.wallet-panel');
    expect(panel?.hidden).toBe(true);
    expect(panel === null ? '' : getComputedStyle(panel).display).toBe('none');

    more?.click();
    expect(more?.getAttribute('aria-expanded')).toBe('true');
    expect(panel === null ? '' : getComputedStyle(panel).display).not.toBe('none');
    // Both wallets already sit in the row, so the panel repeats neither —
    // it offers only the custom URL entry.
    expect(shadowRoot().querySelectorAll('.wallet-tile')).toHaveLength(0);
    expect(shadowRoot().querySelector<HTMLElement>('.wallet-scroll-wrap')?.hidden).toBe(true);
    expect(shadowRoot().querySelector('.wallet-search')).toBeNull();
    expect(shadowRoot().querySelector('.url-input')).not.toBeNull();
    // The method link keeps its own row beneath the switcher.
    expect(shadowRoot().querySelector('.footer-row .method-link')).not.toBeNull();
  });

  it('shows the search bar past one row of grid tiles and filters the remainder', async () => {
    const relay = createFakeRelay();
    const many: WalletOption[] = ['Aurora', 'Basalt', 'Cinder', 'Dune', 'Ember', 'Fjord', 'Grove', 'Hazel', 'Iris']
      .map((name) => ({ name, url: `https://${name.toLowerCase()}.example.com` }));
    const promise = runConnectModal({
      wallets            : many,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    shadowRoot().querySelector<HTMLButtonElement>('.more-tile')?.click();
    const search = shadowRoot().querySelector<HTMLInputElement>('.wallet-search');
    expect(search).not.toBeNull();
    if (search == null) { return; }

    // The grid holds only the six wallets not shown in the row.
    const tiles = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.wallet-tile'));
    expect(tiles).toHaveLength(6);

    search.value = 'fjord';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(tiles.filter((tile) => !tile.hidden)).toHaveLength(1);
    expect(tiles.find((tile) => !tile.hidden)?.textContent).toContain('Fjord');
    expect(shadowRoot().querySelector<HTMLElement>('.wallet-empty')?.hidden).toBe(true);

    search.value = 'zzz';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(tiles.filter((tile) => !tile.hidden)).toHaveLength(0);
    expect(shadowRoot().querySelector<HTMLElement>('.wallet-empty')?.hidden).toBe(false);

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(tiles.filter((tile) => !tile.hidden)).toHaveLength(6);
  });

  it('caps the grid height and fades its bottom edge until the user scrolls to the end', async () => {
    const relay = createFakeRelay();
    const many: WalletOption[] = Array.from({ length: 19 }, (_, i) => ({
      name : `Wallet ${String(i + 1).padStart(2, '0')}`,
      url  : `https://wallet-${i + 1}.example.com`,
    }));
    const promise = runConnectModal({
      wallets            : many,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    shadowRoot().querySelector<HTMLButtonElement>('.more-tile')?.click();

    // 16 grid tiles at 4 per row overflow the three-row cap, so the fade
    // hint shows; scrolling to the end clears it.
    const wrap = shadowRoot().querySelector<HTMLElement>('.wallet-scroll-wrap');
    const scroll = shadowRoot().querySelector<HTMLElement>('.wallet-scroll');
    if (wrap == null || scroll == null) { throw new Error('expected the wallet grid scroller'); }
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(wrap.classList.contains('scroll-hint')).toBe(true);

    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event('scroll'));
    expect(wrap.classList.contains('scroll-hint')).toBe(false);
  });

  it('forces an appearance and applies the dapp palette as inline tokens', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      theme              : {
        appearance : 'dark',
        accent     : '#ff00aa',
        dark       : { background: '#101014', textMuted: '#8899aa' },
      },
      deps: deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    const modal = shadowRoot().querySelector<HTMLElement>('.modal');
    expect(modal?.getAttribute('data-appearance')).toBe('dark');
    expect(modal?.style.getPropertyValue('--ec-accent')).toBe('#ff00aa');
    expect(modal?.style.getPropertyValue('--ec-bg')).toBe('#101014');
    expect(modal?.style.getPropertyValue('--ec-muted')).toBe('#8899aa');
    // Untouched tokens stay on the stylesheet defaults.
    expect(modal?.style.getPropertyValue('--ec-text')).toBe('');
  });

  it('follows the system appearance by default and picks that scheme’s palette', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      theme              : {
        light : { accent: '#123456' },
        dark  : { accent: '#654321' },
      },
      deps: deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    const modal = shadowRoot().querySelector<HTMLElement>('.modal');
    // No forced appearance — the attribute is absent and CSS follows the OS.
    expect(modal?.hasAttribute('data-appearance')).toBe(false);
    // The test environment reports a light scheme, so the light accent wins.
    expect(modal?.style.getPropertyValue('--ec-accent')).toBe('#123456');
  });

  it('shows approval progress when the relay reports the claim', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);
    await flush();

    relay.calls[0].onWalletUriReady(HANDOFF);
    await flush();
    expect(stageText()).toContain('Scan with your phone');

    relay.calls[0].onClaimed?.();
    await flush();

    expect(stageText()).toContain('Request received — approve in Enbox');
    expect(stageText()).toContain('you’ll get a code to enter here');

    // The approval still lands normally after the progress beat.
    relay.calls[0].resolve(RESULT);
    await flush();
    expect(stageText()).toContain('You’re connected');
  });
});
