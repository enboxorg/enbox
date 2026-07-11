import type { ConnectModalDeps } from '../src/ui/connect-modal.js';
import type { WalletOption } from '../src/browser-connect-handler.js';
import type { ConnectPermissionRequest, ConnectResult, WalletUriHandoff } from '@enbox/connect';

import { afterEach, describe, expect, it } from 'bun:test';

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

const RESULT = {
  delegatePortableDid : { uri: 'did:jwk:delegate' },
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
  requestPin: (attempt: number, previousError?: Error) => Promise<string>;
  resolve: (result: ConnectResult | undefined) => void;
  reject: (error: Error) => void;
};

function createFakeRelay(): { calls: FakeRelayCall[]; runRelay: ConnectModalDeps['runRelay'] } {
  const calls: FakeRelayCall[] = [];

  const runRelay: ConnectModalDeps['runRelay'] = (options) => {
    return new Promise<ConnectResult | undefined>((resolve, reject) => {
      calls.push({
        walletUri        : options.walletUri,
        connectServerUrl : options.connectServerUrl,
        onWalletUriReady : options.onWalletUriReady,
        requestPin       : options.requestPin,
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

    relay.calls[0].onWalletUriReady(HANDOFF);
    expect(shadowRoot().querySelector('.qr-box svg')).not.toBeNull();
    expect(stageText()).toContain('Scan with your phone');

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
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
    expect(stageText()).toContain('Enter the code shown on your phone');

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

  it('renders a deep link instead of a QR on mobile', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay, isMobile: (): boolean => true }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);

    const link = shadowRoot().querySelector<HTMLAnchorElement>('.deep-link');
    expect(link).not.toBeNull();
    expect(link?.href).toBe(HANDOFF.walletUri);
    expect(shadowRoot().querySelector('.qr-box')).toBeNull();
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

  it('re-mints for the newly selected wallet from the switcher', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(1);

    shadowRoot().querySelector<HTMLButtonElement>('.wallet-toggle')?.click();
    const rows = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.wallet-row'));
    rows.find((row) => row.querySelector('.wallet-row-name')?.textContent === 'Prism')?.click();
    await flush();

    expect(relay.calls).toHaveLength(2);
    expect(relay.calls[1].walletUri).toBe('https://wallet-two.example.com/connect/app');
  });
});
