import type { ConnectApproval, ConnectPermissionRequest, ConnectResult } from '@enbox/connect';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ConnectProvider } from '@enbox/connect';
import { DidJwk } from '@enbox/dids';
import { X25519 } from '@enbox/crypto';

import { connectViaPopup } from '../src/dweb-connect-client.js';
import { WalletPostMessageTransport } from '../src/dweb-connect-wallet.js';
import {
  DWEB_CONNECT_LOADED_MESSAGE_TYPE,
  DWEB_CONNECT_RESPONSE_MESSAGE_TYPE,
} from '../src/dweb-connect-messages.js';

// ── Test constants ──────────────────────────────────────────────
//
// The wallet "runs" on this page's own origin so that the kernel's `apv`
// origin binding (sealed against the dapp's pinned wallet origin, opened
// against the wallet's `location.origin`) genuinely matches in loopback.
// The dapp origin is a distinct fake origin stamped onto synthetic events.

const WALLET_URL = globalThis.location.origin;
const WALLET_ORIGIN = new URL(WALLET_URL).origin;
const DAPP_ORIGIN = 'https://dapp.example.com';
const EVIL_ORIGIN = 'https://evil.example.com';

/** Minimal ConnectPermissionRequest for tests. */
function stubPermissionRequest(): ConnectPermissionRequest {
  return {
    protocolDefinition : { protocol: 'https://proto.example.com', types: {}, structure: {} },
    permissionScopes   : [{ protocol: 'https://proto.example.com', interface: 'Records', method: 'Write' }],
  } as unknown as ConnectPermissionRequest;
}

type PostedMessage = { data: Record<string, unknown>; targetOrigin: string };

type FakeWindow = Window & { closed: boolean };

/**
 * Creates a window stand-in from a MessagePort (a valid `MessageEvent`
 * source in real browsers) with `postMessage`/`close`/`closed` overridden.
 */
function createFakeWindow(onPost: (data: Record<string, unknown>, targetOrigin: string) => void): FakeWindow {
  const port = new MessageChannel().port1;
  Object.defineProperty(port, 'closed', { configurable: true, value: false, writable: true });
  Object.defineProperty(port, 'close', {
    configurable : true,
    value        : (): void => { (port as unknown as { closed: boolean }).closed = true; },
  });
  Object.defineProperty(port, 'postMessage', { configurable: true, value: onPost });
  return port as unknown as FakeWindow;
}

/** Polls until `predicate` is true, failing after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) { throw new Error('waitFor timed out'); }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── Loopback harness ────────────────────────────────────────────

describe('DWeb Connect popup flow (kernel loopback)', () => {
  let windowOpenSpy: ReturnType<typeof spyOn>;
  let fakePopup: FakeWindow;
  let fakeOpener: FakeWindow;
  let dappToWallet: PostedMessage[];
  let walletToDapp: PostedMessage[];
  let walletTransports: WalletPostMessageTransport[];

  beforeEach(() => {
    dappToWallet = [];
    walletToDapp = [];
    walletTransports = [];

    // Dapp → popup: recorded, then surfaced to the wallet transport as an
    // event from the dapp's origin with the opener window as source.
    fakePopup = createFakeWindow((data, targetOrigin): void => {
      dappToWallet.push({ data, targetOrigin });
      window.dispatchEvent(new MessageEvent('message', { data, origin: DAPP_ORIGIN, source: fakeOpener }));
    });

    // Wallet → opener: recorded, then surfaced to the dapp transport as an
    // event from the wallet's origin with the popup window as source.
    fakeOpener = createFakeWindow((data, targetOrigin): void => {
      walletToDapp.push({ data, targetOrigin });
      window.dispatchEvent(new MessageEvent('message', { data, origin: WALLET_ORIGIN, source: fakePopup }));
    });

    windowOpenSpy = spyOn(window, 'open').mockReturnValue(fakePopup);
  });

  afterEach(() => {
    for (const transport of walletTransports) { transport.close(); }
    windowOpenSpy.mockRestore();
  });

  /**
   * Starts the dapp flow and waits until the popup has been "opened".
   * The flow promise is returned wrapped in an object so the async helper
   * does not flatten it into the helper's own settlement.
   */
  async function startDappFlow(options: { timeout?: number; appName?: string } = {}): Promise<{ flow: Promise<ConnectResult | undefined> }> {
    const flow = connectViaPopup({
      walletUrl          : WALLET_URL,
      permissionRequests : [stubPermissionRequest()],
      timeout            : options.timeout ?? 10_000,
      appName            : options.appName,
    });
    // Mark rejections as observed until each test attaches its own handlers.
    flow.catch((): undefined => undefined);
    await waitFor(() => windowOpenSpy.mock.calls.length > 0);
    return { flow };
  }

  /** Creates the wallet-side transport wired to the fake opener window. */
  async function createWalletTransport(options: { timeoutMs?: number } = {}): Promise<WalletPostMessageTransport> {
    const transport = await WalletPostMessageTransport.create({
      dappOrigin : DAPP_ORIGIN,
      dappWindow : fakeOpener,
      timeoutMs  : options.timeoutMs,
    });
    walletTransports.push(transport);
    return transport;
  }

  /** Runs the wallet-side approval ceremony stub and seals the response. */
  async function approveRequest(transport: WalletPostMessageTransport): Promise<{
    providerDidUri: string;
    delegateDidUri: string;
    sessionRevocations: NonNullable<ConnectApproval['sessionRevocations']>;
  }> {
    const request = await transport.awaitRequest();
    const providerDid = await DidJwk.create();
    const delegateDid = await DidJwk.create();
    const sessionRevocations = [{ grantId: 'grant-1', revocationGrantId: 'revocation-1' }];
    const approval: ConnectApproval = {
      delegateDid         : delegateDid.uri,
      delegatePortableDid : await delegateDid.export(),
      delegateGrants      : [{ recordId: 'grant-1' } as unknown as ConnectApproval['delegateGrants'][number]],
      sessionRevocations,
    };

    const idToken = await ConnectProvider.sealApprovedResponse({
      request,
      providerDid : providerDid.uri,
      approval,
      signer      : delegateDid,
    });
    transport.sendResponse(idToken);

    return { providerDidUri: providerDid.uri, delegateDidUri: delegateDid.uri, sessionRevocations };
  }

  // ── Full handshake ──────────────────────────────────────────

  describe('full handshake', () => {
    it('should complete an approved handshake end-to-end with real kernel crypto', async () => {
      const { flow } = await startDappFlow({ appName: 'Loopback Dapp' });
      const walletTransport = await createWalletTransport();

      const request = await walletTransport.awaitRequest();
      expect(request.appName).toBe('Loopback Dapp');
      expect(request.reply).toEqual({ mode: 'post_message' });
      expect(request.permissionRequests).toHaveLength(1);
      expect(request.clientMetadata?.origin).toBe(globalThis.location.origin);
      expect(request.responseKey.crv).toBe('X25519');

      const { providerDidUri, delegateDidUri, sessionRevocations } = await approveRequest(walletTransport);

      const result = await flow;
      expect(result).toBeDefined();
      expect(result!.delegatePortableDid.uri).toBe(delegateDidUri);
      expect(result!.connectedDid).toBe(providerDidUri);
      expect(result!.delegateGrants).toHaveLength(1);
      expect(result!.sessionRevocations).toEqual(sessionRevocations);
    });

    it('should post only ciphertext with pinned target origins in both directions', async () => {
      const { flow } = await startDappFlow();
      const walletTransport = await createWalletTransport();
      await approveRequest(walletTransport);
      await flow;

      // Dapp → wallet: exactly one message, carrying only a Compact JWE.
      expect(dappToWallet).toHaveLength(1);
      expect(Object.keys(dappToWallet[0].data).sort()).toEqual(['jwe', 'type']);
      expect((dappToWallet[0].data.jwe as string).split('.')).toHaveLength(5);
      expect(dappToWallet[0].targetOrigin).toBe(WALLET_ORIGIN);

      // Wallet → dapp: the loaded beacon (public key only) and the sealed response.
      expect(walletToDapp).toHaveLength(2);
      const [beacon, response] = walletToDapp;
      expect(beacon.data.type).toBe(DWEB_CONNECT_LOADED_MESSAGE_TYPE);
      expect(beacon.data.walletEpk).not.toHaveProperty('d');
      expect(beacon.targetOrigin).toBe(DAPP_ORIGIN);
      expect(response.data.type).toBe(DWEB_CONNECT_RESPONSE_MESSAGE_TYPE);
      expect((response.data.payload as string).split('.')).toHaveLength(5);
      expect(response.targetOrigin).toBe(DAPP_ORIGIN);
    });

    it('should resolve undefined when the wallet denies the request', async () => {
      const { flow } = await startDappFlow();
      const walletTransport = await createWalletTransport();

      await walletTransport.awaitRequest();
      walletTransport.deny();

      await expect(flow).resolves.toBeUndefined();
    });
  });

  // ── Origin and source pinning ───────────────────────────────

  describe('origin and source pinning', () => {
    it('should ignore loaded beacons from non-wallet origins', async () => {
      const { flow } = await startDappFlow();

      // A valid-looking beacon from a hostile origin must be ignored; if it
      // were accepted, the request would be sealed to the attacker's key and
      // the genuine wallet below could never open it.
      const evilKey = await X25519.generateKey();
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type         : DWEB_CONNECT_LOADED_MESSAGE_TYPE,
          walletEpk    : { kty: 'OKP', crv: 'X25519', x: evilKey.x },
          walletOrigin : WALLET_ORIGIN,
        },
        origin : EVIL_ORIGIN,
        source : fakePopup,
      }));

      const walletTransport = await createWalletTransport();
      const { delegateDidUri } = await approveRequest(walletTransport);

      const result = await flow;
      expect(result!.delegatePortableDid.uri).toBe(delegateDidUri);
    });

    it('should ignore loaded beacons from an unexpected source window', async () => {
      const { flow } = await startDappFlow();

      const strangerWindow = createFakeWindow((): void => undefined);
      const evilKey = await X25519.generateKey();
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type         : DWEB_CONNECT_LOADED_MESSAGE_TYPE,
          walletEpk    : { kty: 'OKP', crv: 'X25519', x: evilKey.x },
          walletOrigin : WALLET_ORIGIN,
        },
        origin : WALLET_ORIGIN,
        source : strangerWindow,
      }));

      const walletTransport = await createWalletTransport();
      const { delegateDidUri } = await approveRequest(walletTransport);

      const result = await flow;
      expect(result!.delegatePortableDid.uri).toBe(delegateDidUri);
    });

    it('should ignore response messages from non-wallet origins', async () => {
      const { flow } = await startDappFlow();
      const walletTransport = await createWalletTransport();
      await walletTransport.awaitRequest();

      // A spoofed deny from a hostile origin must not settle the flow.
      window.dispatchEvent(new MessageEvent('message', {
        data   : { type: DWEB_CONNECT_RESPONSE_MESSAGE_TYPE, payload: 'DENIED' },
        origin : EVIL_ORIGIN,
        source : fakePopup,
      }));

      const { delegateDidUri } = await approveRequest(walletTransport);
      const result = await flow;
      expect(result!.delegatePortableDid.uri).toBe(delegateDidUri);
    });

    it('should ignore response messages from an unexpected source window', async () => {
      const { flow } = await startDappFlow();
      const walletTransport = await createWalletTransport();
      await walletTransport.awaitRequest();

      const strangerWindow = createFakeWindow((): void => undefined);
      window.dispatchEvent(new MessageEvent('message', {
        data   : { type: DWEB_CONNECT_RESPONSE_MESSAGE_TYPE, payload: 'DENIED' },
        origin : WALLET_ORIGIN,
        source : strangerWindow,
      }));

      const { delegateDidUri } = await approveRequest(walletTransport);
      const result = await flow;
      expect(result!.delegatePortableDid.uri).toBe(delegateDidUri);
    });

    it('should ignore request messages from non-dapp origins on the wallet side', async () => {
      const { flow } = await startDappFlow();
      const walletTransport = await createWalletTransport();

      // A garbled request from a hostile origin must be ignored; the genuine
      // request that the dapp already posted (or posts next) must still open.
      window.dispatchEvent(new MessageEvent('message', {
        data   : { type: 'enbox-connect-request', jwe: 'not.a.real.jwe.value' },
        origin : EVIL_ORIGIN,
        source : fakeOpener,
      }));

      const request = await walletTransport.awaitRequest();
      expect(request.reply).toEqual({ mode: 'post_message' });

      walletTransport.deny();
      await expect(flow).resolves.toBeUndefined();
    });

    it('should fail closed when the genuine popup sends a beacon with private key material', async () => {
      const { flow } = await startDappFlow();

      const leakyKey = await X25519.generateKey();
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type         : DWEB_CONNECT_LOADED_MESSAGE_TYPE,
          walletEpk    : leakyKey, // includes `d`
          walletOrigin : WALLET_ORIGIN,
        },
        origin : WALLET_ORIGIN,
        source : fakePopup,
      }));

      await expect(flow).rejects.toThrow('did not carry a valid X25519 public key');
    });

    it('should fail closed when the beacon walletOrigin does not match the pinned origin', async () => {
      const { flow } = await startDappFlow();

      const key = await X25519.generateKey();
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type         : DWEB_CONNECT_LOADED_MESSAGE_TYPE,
          walletEpk    : { kty: 'OKP', crv: 'X25519', x: key.x },
          walletOrigin : 'https://other-wallet.example.com',
        },
        origin : WALLET_ORIGIN,
        source : fakePopup,
      }));

      await expect(flow).rejects.toThrow('does not match the configured wallet origin');
    });
  });

  // ── Failure modes ───────────────────────────────────────────

  describe('failure modes', () => {
    it('should throw when the popup is blocked', async () => {
      windowOpenSpy.mockReturnValue(null);

      await expect(connectViaPopup({
        walletUrl          : WALLET_URL,
        permissionRequests : [stubPermissionRequest()],
      })).rejects.toThrow('Popup blocked');
    });

    it('should resolve undefined when the user closes the popup before the wallet loads', async () => {
      const { flow } = await startDappFlow();

      fakePopup.closed = true;

      await expect(flow).resolves.toBeUndefined();
    });

    it('should treat closing the popup after the handshake as a denial', async () => {
      const { flow } = await startDappFlow();
      const walletTransport = await createWalletTransport();
      await walletTransport.awaitRequest();

      fakePopup.closed = true;

      await expect(flow).resolves.toBeUndefined();
    });

    it('should reject on timeout when the wallet never responds', async () => {
      const { flow } = await startDappFlow({ timeout: 300 });

      await expect(flow).rejects.toThrow('timed out waiting for wallet response');
    });

    it('should reject the wallet transport when the request ciphertext cannot be opened', async () => {
      const walletTransport = await createWalletTransport();

      window.dispatchEvent(new MessageEvent('message', {
        data   : { type: 'enbox-connect-request', jwe: 'AAAA.BBBB.CCCC.DDDD.EEEE' },
        origin : DAPP_ORIGIN,
        source : fakeOpener,
      }));

      await expect(walletTransport.awaitRequest()).rejects.toThrow();
    });
  });

  // ── Wallet-side origin resolution ───────────────────────────

  describe('wallet dapp-origin resolution', () => {
    it('should derive the dapp origin from document.referrer when not supplied', async () => {
      const referrerSpy = spyOn(document, 'referrer', 'get').mockReturnValue(`${DAPP_ORIGIN}/some/page?q=1`);

      try {
        const transport = await WalletPostMessageTransport.create({ dappWindow: fakeOpener });
        walletTransports.push(transport);

        expect(transport.dappOrigin).toBe(DAPP_ORIGIN);
        expect(walletToDapp).toHaveLength(1);
        expect(walletToDapp[0].targetOrigin).toBe(DAPP_ORIGIN);
      } finally {
        referrerSpy.mockRestore();
      }
    });

    it('should throw when no dapp origin is supplied and the referrer is empty', async () => {
      const referrerSpy = spyOn(document, 'referrer', 'get').mockReturnValue('');

      try {
        await expect(WalletPostMessageTransport.create({ dappWindow: fakeOpener }))
          .rejects.toThrow('Unable to determine the dapp origin');
      } finally {
        referrerSpy.mockRestore();
      }
    });
  });
});
