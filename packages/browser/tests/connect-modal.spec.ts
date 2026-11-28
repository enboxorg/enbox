import type { ConnectModalDeps } from '../src/ui/connect-modal.js';
import type { PortableDid } from '@enbox/dids';
import type { WalletOption } from '../src/browser-connect-handler.js';
import type { ConnectPermissionRequest, ConnectRequestType, ConnectResult, ConnectVerificationSymbol, WalletUriHandoff } from '@enbox/connect';

import { afterEach, describe, expect, it } from 'bun:test';

import { CONNECT_VERIFICATION_SYMBOLS } from '@enbox/connect';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { PopupWindowClosedError } from '../src/dweb-connect-client.js';
import { runConnectModal } from '../src/ui/connect-modal.js';

const WALLETS: WalletOption[] = [
  { name: 'Enbox', url: 'https://wallet-one.example.com' },
  { name: 'Prism', url: 'https://wallet-two.example.com' },
];

const PERMISSIONS: ConnectPermissionRequest[] = [
  {
    moduleDefinition : { module: 'https://modules.example.com', published: false, types: {}, structure: {} },
    permissionScopes : [{ module: 'https://modules.example.com', interface: DwnInterfaceName.Records, method: DwnMethodName.Write }],
  },
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
 * callbacks so tests can walk the session through QR → SAS verification → result.
 */
type FakeRelayCall = {
  walletUri: string;
  connectServerUrl: string;
  onWalletUriReady: (handoff: WalletUriHandoff) => void;
  onClaimed?: () => void;
  onVerificationReady?: (symbols: readonly ConnectVerificationSymbol[]) => void;
  delegatePortableDid?: PortableDid;
  requestType?: ConnectRequestType;
  applicationId?: string;
  expectedProviderDid?: string;
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
        onVerificationReady : options.onVerificationReady,
        delegatePortableDid : options.delegatePortableDid,
        requestType         : options.requestType,
        applicationId       : options.applicationId,
        expectedProviderDid : options.expectedProviderDid,
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
    isIosStandalonePwa       : (): boolean => false,
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
    expect(relay.calls[0].applicationId).toBe(window.location.origin);

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

  it('locks a refresh to the delegate session wallet and phone route', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage({
      'enbox:connect:lastChoice'     : JSON.stringify({ method: 'browser', walletUrl: WALLETS[0].url }),
      'enbox:connect:sessionChoices' : JSON.stringify([
        {
          delegateDid : 'did:jwk:another-session',
          providerDid : RESULT.connectedDid,
          method      : 'browser',
          walletUrl   : WALLETS[0].url,
        },
        {
          delegateDid : DELEGATE_PORTABLE_DID.uri,
          providerDid : RESULT.connectedDid,
          method      : 'phone',
          walletUrl   : WALLETS[1].url,
        },
      ]),
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
    expect(relay.calls[0].connectServerUrl).toBe('https://relay.example.com/connect');
    expect(relay.calls[0].delegatePortableDid).toBe(DELEGATE_PORTABLE_DID);
    expect(relay.calls[0].requestType).toBe('refresh');
    expect(relay.calls[0].expectedProviderDid).toBe(RESULT.connectedDid);
    expect(shadowRoot().querySelector('.method-link')).toBeNull();

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('lets a failed saved route choose another wallet while keeping the profile pinned', async () => {
    const relay = createFakeRelay();
    const otherChoice = {
      delegateDid : 'did:jwk:another-session',
      providerDid : 'did:dht:another-provider',
      method      : 'browser',
      walletUrl   : WALLETS[0].url,
    };
    const storage = createFakeStorage({
      'enbox:connect:sessionChoices': JSON.stringify([
        otherChoice,
        {
          delegateDid : DELEGATE_PORTABLE_DID.uri,
          providerDid : RESULT.connectedDid,
          method      : 'phone',
          walletUrl   : WALLETS[1].url,
        },
      ]),
    });
    const promise = runConnectModal({
      wallets             : WALLETS,
      appName             : 'Test Dapp',
      mode                : 'refresh',
      delegatePortableDid : DELEGATE_PORTABLE_DID,
      permissionRequests  : PERMISSIONS,
      deps                : deps({
        runRelay                 : relay.runRelay,
        storage,
        discoverConnectServerUrl : async (origin): Promise<string | undefined> =>
          origin === new URL(WALLETS[1].url).origin
            ? undefined
            : 'https://relay.example.com/connect',
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(0);
    expect(stageText()).toContain('saved wallet connection is unavailable');
    expect(shadowRoot().querySelector('.wallet-row')).toBeNull();

    const escapeButton = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'))
      .find(button => button.textContent === 'Choose another wallet or method');
    escapeButton?.click();

    expect(stageText()).toContain('Choose another way to reconnect');
    expect(stageText()).toContain('same wallet profile');
    expect(shadowRoot().querySelector('.wallet-row')).not.toBeNull();
    expect(shadowRoot().querySelector('.method-link')).not.toBeNull();
    expect(JSON.parse(storage.dump()['enbox:connect:sessionChoices'])).toEqual([otherChoice]);

    rowTiles().find(tile => tile.textContent?.includes('Enbox'))?.click();
    await flush();

    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0].walletUri).toBe('https://wallet-one.example.com/connect/app');
    expect(relay.calls[0].expectedProviderDid).toBe(RESULT.connectedDid);

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('threads a refresh through the delegate session popup after a user gesture', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage({
      'enbox:connect:lastChoice'     : JSON.stringify({ method: 'phone', walletUrl: WALLETS[0].url }),
      'enbox:connect:sessionChoices' : JSON.stringify([{
        delegateDid : DELEGATE_PORTABLE_DID.uri,
        providerDid : RESULT.connectedDid,
        method      : 'browser',
        walletUrl   : WALLETS[1].url,
      }]),
    });
    const popupCalls: Parameters<ConnectModalDeps['runPopup']>[0][] = [];
    const promise = runConnectModal({
      wallets             : WALLETS,
      appName             : 'Test Dapp',
      mode                : 'refresh',
      delegatePortableDid : DELEGATE_PORTABLE_DID,
      expectedProviderDid : RESULT.connectedDid,
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
    expect(shadowRoot().querySelector('.method-link')).toBeNull();
    expect(stageText()).toContain('Reconnect with Prism');
    expect(stageText()).toContain('same Prism profile');

    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();

    expect(popupCalls).toHaveLength(1);
    expect(popupCalls[0].walletUrl).toBe(WALLETS[1].url);
    expect(popupCalls[0].delegatePortableDid).toBe(DELEGATE_PORTABLE_DID);
    expect(popupCalls[0].requestType).toBe('refresh');
    expect(popupCalls[0].expectedProviderDid).toBe(RESULT.connectedDid);

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

  it('renders SAS verification symbols through to success and remembers the choice', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage();
    const sampleSymbols = [
      CONNECT_VERIFICATION_SYMBOLS[5],
      CONNECT_VERIFICATION_SYMBOLS[36],
      CONNECT_VERIFICATION_SYMBOLS[45],
    ] as const;
    const promise = runConnectModal({
      wallets            : WALLETS,
      appName            : 'Test Dapp',
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay, storage }),
    });

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);

    // Wallet published its handshake key — the modal displays the 3 SAS symbols.
    relay.calls[0].onVerificationReady?.(sampleSymbols);
    const verifyRow = shadowRoot().querySelector<HTMLElement>('.verify-row');
    expect(verifyRow?.getAttribute('role')).toBe('group');
    expect(verifyRow?.getAttribute('aria-label')).toContain('Fox, Rocket, Guitar');
    const cards = Array.from(shadowRoot().querySelectorAll<HTMLElement>('.verify-card'));
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.querySelector('.verify-label')?.textContent)).toEqual(['Fox', 'Rocket', 'Guitar']);
    expect(cards.map((card) => card.querySelector('.verify-emoji')?.textContent)).toEqual(['🦊', '🚀', '🎸']);
    expect(cards.every((card) => card.querySelector('.verify-emoji')?.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(stageText()).toContain('Confirm in Enbox');
    expect(stageText()).toContain('Tap these 3 symbols in Enbox');
    const verifyStartOver = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'))
      .find((button) => button.textContent === 'Start over');
    expect(verifyStartOver).toBeDefined();

    relay.calls[0].resolve(RESULT);
    await flush();
    expect(stageText()).toContain('You’re connected.');

    await sleep(1_300);
    await expect(promise).resolves.toBe(RESULT);
    expect(JSON.parse(storage.dump()['enbox:connect:lastChoice'])).toEqual({
      method    : 'phone',
      walletUrl : 'https://wallet-one.example.com',
    });
    expect(JSON.parse(storage.dump()['enbox:connect:sessionChoices'])).toEqual([{
      delegateDid : DELEGATE_PORTABLE_DID.uri,
      providerDid : RESULT.connectedDid,
      method      : 'phone',
      walletUrl   : 'https://wallet-one.example.com',
    }]);
  });

  it('restores the route for one delegate after another session uses a different wallet', async () => {
    const relay = createFakeRelay();
    const storage = createFakeStorage();
    const secondResult = {
      ...RESULT,
      delegatePortableDid: { uri: 'did:jwk:second-delegate' } as PortableDid,
    };

    const firstConnect = runConnectModal({
      wallets            : WALLETS,
      walletUrl          : WALLETS[0].url,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay, storage }),
    });
    await flush();
    relay.calls[0].resolve(RESULT);
    await sleep(1_300);
    await expect(firstConnect).resolves.toBe(RESULT);

    const secondConnect = runConnectModal({
      wallets            : WALLETS,
      walletUrl          : WALLETS[1].url,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay, storage }),
    });
    await flush();
    relay.calls[1].resolve(secondResult);
    await sleep(1_300);
    await expect(secondConnect).resolves.toBe(secondResult);

    const refresh = runConnectModal({
      wallets             : WALLETS,
      mode                : 'refresh',
      delegatePortableDid : DELEGATE_PORTABLE_DID,
      permissionRequests  : PERMISSIONS,
      deps                : deps({ runRelay: relay.runRelay, storage }),
    });
    refresh.catch((): undefined => undefined);
    await flush();

    expect(relay.calls[2].walletUri).toBe('https://wallet-one.example.com/connect/app');
    expect(relay.calls[2].expectedProviderDid).toBe(RESULT.connectedDid);
    expect(shadowRoot().querySelector('.wallet-row')).toBeNull();

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(refresh).rejects.toThrow(/cancelled/i);
  });

  it('does not overwrite verification symbols when a late claimed notification arrives', async () => {
    const relay = createFakeRelay();
    const sampleSymbols = [
      CONNECT_VERIFICATION_SYMBOLS[0],
      CONNECT_VERIFICATION_SYMBOLS[1],
      CONNECT_VERIFICATION_SYMBOLS[2],
    ] as const;
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({ runRelay: relay.runRelay }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    relay.calls[0].onWalletUriReady(HANDOFF);
    relay.calls[0].onVerificationReady?.(sampleSymbols);
    relay.calls[0].onClaimed?.();
    await flush();
    expect(shadowRoot().querySelectorAll('.verify-card')).toHaveLength(3);
    expect(stageText()).toContain('Confirm in Enbox');
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

  it('defaults mobile browsers to the direct popup path when no redirectUri is configured', async () => {
    const relay = createFakeRelay();
    let popupCalls = 0;
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      deps               : deps({
        runRelay : relay.runRelay,
        isMobile : (): boolean => true,
        runPopup : (): Promise<ConnectResult | undefined> => {
          popupCalls += 1;
          return new Promise<ConnectResult | undefined>(() => { /* pending */ });
        },
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(0);
    expect(stageText()).toContain('Open wallet');

    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();
    expect(popupCalls).toBe(1);

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('defaults mobile browsers to same-tab redirect when redirectUri is configured', async () => {
    const relay = createFakeRelay();
    const redirectCalls: Parameters<ConnectModalDeps['startRedirect']>[0][] = [];
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      redirectUri        : 'https://app.example/connect/callback',
      deps               : deps({
        runRelay      : relay.runRelay,
        isMobile      : (): boolean => true,
        startRedirect : async (opts): ReturnType<ConnectModalDeps['startRedirect']> => {
          redirectCalls.push(opts);
          return {} as Awaited<ReturnType<ConnectModalDeps['startRedirect']>>;
        },
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(0);
    expect(stageText()).toContain('Continue in Enbox');

    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();
    await flush();
    expect(redirectCalls).toHaveLength(1);
    expect(redirectCalls[0].redirectUri).toBe('https://app.example/connect/callback');
    expect(redirectCalls[0].walletUri).toBe('https://wallet-one.example.com/connect/app');

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('handles redirect startup errors and switching between redirect and phone methods', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      redirectUri        : 'https://app.example/connect/callback',
      deps               : deps({
        runRelay      : relay.runRelay,
        isMobile      : (): boolean => true,
        startRedirect : async (): Promise<never> => { throw new Error('PAR failed'); },
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    // Switch from redirect to phone via footer link, then back to redirect.
    shadowRoot().querySelector<HTMLButtonElement>('.method-link')?.click();
    await flush();
    expect(relay.calls).toHaveLength(1);

    shadowRoot().querySelector<HTMLButtonElement>('.method-link')?.click();
    await flush();
    expect(stageText()).toContain('Continue in Enbox');

    // Triggering redirect error renders recovery stage.
    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();
    await flush();
    expect(stageText()).toContain('Something went wrong while opening the wallet.');

    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it('resets on bfcache pageshow, aborts in-flight redirect on cancel, and degrades without sessionStorage or relay', async () => {
    const relay = createFakeRelay();
    const capturedSignals: (AbortSignal | undefined)[] = [];
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      redirectUri        : 'https://app.example/connect/callback',
      deps               : deps({
        runRelay      : relay.runRelay,
        isMobile      : (): boolean => true,
        startRedirect : async (opts): ReturnType<ConnectModalDeps['startRedirect']> => {
          capturedSignals.push(opts.signal);
          return new Promise(() => { /* stays pending until cancelled or bfcache return */ });
        },
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();
    await flush();
    expect(stageText()).toContain('Opening Enbox…');
    expect(capturedSignals[0]?.aborted).toBe(false);

    // Simulating bfcache Back navigation restores the redirect prompt and aborts the stale attempt.
    const pageShow = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(pageShow, 'persisted', { value: true });
    window.dispatchEvent(pageShow);
    expect(capturedSignals[0]?.aborted).toBe(true);
    expect(stageText()).toContain('Continue in Enbox');

    // Starting redirect again and cancelling the modal aborts the second in-flight attempt.
    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();
    await flush();
    expect(capturedSignals[1]?.aborted).toBe(false);
    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    expect(capturedSignals[1]?.aborted).toBe(true);
    await expect(promise).rejects.toThrow(/cancelled/i);

    // Restricted WebView without writable sessionStorage degrades to browser popup on mobile.
    const degraded = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      redirectUri        : 'https://app.example/connect/callback',
      deps               : deps({
        runRelay          : relay.runRelay,
        isMobile          : (): boolean => true,
        hasSessionStorage : (): boolean => false,
      }),
    });
    degraded.catch((): undefined => undefined);
    await flush();
    expect(stageText()).toContain('Open wallet');
    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(degraded).rejects.toThrow(/cancelled/i);

    // Redirect relay unavailable shows distinct redirect copy.
    const unavailable = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      redirectUri        : 'https://app.example/connect/callback',
      deps               : deps({
        runRelay                 : relay.runRelay,
        isMobile                 : (): boolean => true,
        discoverConnectServerUrl : async (): Promise<undefined> => undefined,
      }),
    });
    unavailable.catch((): undefined => undefined);
    await flush();
    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();
    await flush();
    expect(stageText()).toContain('can’t connect by redirect here');
    shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
    await expect(unavailable).rejects.toThrow(/cancelled/i);
  });

  it('keeps iOS standalone PWAs on the phone relay path even when redirectUri is configured', async () => {
    const relay = createFakeRelay();
    const promise = runConnectModal({
      wallets            : WALLETS,
      permissionRequests : PERMISSIONS,
      redirectUri        : 'https://app.example/connect/callback',
      deps               : deps({
        runRelay           : relay.runRelay,
        isMobile           : (): boolean => true,
        isIosStandalonePwa : (): boolean => true,
      }),
    });
    promise.catch((): undefined => undefined);

    await flush();
    expect(relay.calls).toHaveLength(1);
    relay.calls[0].onWalletUriReady(HANDOFF);

    // The primary action opens the wallet in a NEW tab: the modal — and the
    // relay session under it — stays alive for the SAS verification step.
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

    expect(stageText()).toContain('Open Enbox');
    expect(stageText()).toContain('match the 3 verification symbols shown here before approving.');

    // Start over mints a fresh pointer — the one the wallet tab carried away
    // is single-use.
    Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'))
      .find((button) => button.textContent === 'Start over')
      ?.click();
    await flush();
    expect(relay.calls).toHaveLength(2);
  });

  it('routes an interrupted mobile popup back to the phone path', async () => {
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

    // On mobile without redirectUri, the modal opens on the browser popup prompt.
    shadowRoot().querySelector<HTMLButtonElement>('.stage-btn')?.click();
    await flush();

    expect(stageText()).toContain('The wallet tab was closed.');
    const back = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'))
      .find((button) => button.textContent === 'Use another device instead');
    expect(back).toBeDefined();
    back?.click();
    await flush();

    expect(relay.calls).toHaveLength(1);
  });

  const popupRoutes = [
    { name: 'phone alternative', method: 'phone', unavailable: false, retry: false, selector: '.method-link' },
    { name: 'browser prompt', method: 'browser', unavailable: false, retry: false, selector: '.stage-btn' },
    { name: 'unavailable relay fallback', method: 'phone', unavailable: true, retry: false, selector: '.stage-btn' },
    { name: 'blocked popup retry', method: 'browser', unavailable: false, retry: true, selector: '.stage-btn' },
  ] as const;

  for (const route of popupRoutes) {
    it(`starts the ${route.name} popup in the click stack and ignores completion after cancellation`, async (): Promise<void> => {
      const relay = createFakeRelay();
      let popupCalls = 0;
      let rejectPopup: ((error: Error) => void) | undefined;
      const promise = runConnectModal({
        wallets            : WALLETS,
        permissionRequests : PERMISSIONS,
        preferredMethod    : route.method,
        deps               : deps({
          runRelay                 : relay.runRelay,
          discoverConnectServerUrl : async (): Promise<string | undefined> => route.unavailable ? undefined : 'https://relay.example.com/connect',
          runPopup                 : (): Promise<ConnectResult | undefined> => {
            popupCalls++;
            if (route.retry && popupCalls === 1) {
              return Promise.reject(new Error('Popup blocked by browser'));
            }
            return new Promise<ConnectResult | undefined>((_resolve, reject): void => { rejectPopup = reject; });
          },
        }),
      });
      promise.catch((): void => {});

      try {
        await flush();
        const launch = shadowRoot().querySelector<HTMLButtonElement>(route.selector);
        if (launch === null) { throw new Error('expected popup launch button'); }
        launch.click();
        // No await before this assertion: the popup must open in this user gesture.
        expect(popupCalls).toBe(1);
        let activeLaunch = launch;
        if (route.retry) {
          await flush();
          const retry = shadowRoot().querySelector<HTMLButtonElement>('.stage-btn');
          if (retry === null) { throw new Error('expected popup retry button'); }
          activeLaunch = retry;
          activeLaunch.click();
          expect(popupCalls).toBe(2);
        }
        // A second click while the handshake is pending must not start another popup.
        activeLaunch.click();
        expect(popupCalls).toBe(route.retry ? 2 : 1);
        shadowRoot().querySelector<HTMLButtonElement>('.close-btn')?.click();
        await expect(promise).rejects.toThrow(/cancelled/i);
        rejectPopup?.(new Error('popup completed after modal cancellation'));
        await flush();
        expect(document.querySelector('#enbox-connect-modal')).toBeNull();
      } finally {
        document.querySelector('#enbox-connect-modal')?.shadowRoot?.querySelector<HTMLButtonElement>('.close-btn')?.click();
        rejectPopup?.(new Error('popup test cleanup'));
        await flush();
      }
    });
  }

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

    expect(stageText()).toContain('Request received — unlock Enbox');
    expect(stageText()).toContain('Verification symbols will appear here');
    const claimedStartOver = Array.from(shadowRoot().querySelectorAll<HTMLButtonElement>('.stage .footer-link'))
      .find((button) => button.textContent === 'Start over');
    expect(claimedStartOver).toBeDefined();

    // The approval still lands normally after the progress beat.
    relay.calls[0].resolve(RESULT);
    await flush();
    expect(stageText()).toContain('You’re connected');
  });
});
