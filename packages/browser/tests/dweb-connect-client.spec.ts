import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { DWebConnect } from '../src/dweb-connect-client.js';

// ── Helpers ─────────────────────────────────────────────────────

const WALLET_URL = 'https://wallet.example.com';
const WALLET_ORIGIN = 'https://wallet.example.com';
const TEST_DID = 'did:jwk:test123';

/** Minimal ConnectPermissionRequest for tests. */
function stubPermissionRequest(): any {
  return {
    protocolDefinition : { protocol: 'https://proto.example.com', types: {}, structure: {} },
    permissionScopes   : [{ protocol: 'https://proto.example.com', interface: 'Records', method: 'Write' }],
  };
}

/** Creates a fake popup window returned by window.open(). */
function createFakePopup(): { closed: boolean; close: ReturnType<typeof mock>; postMessage: ReturnType<typeof mock> } {
  return {
    closed      : false,
    close       : mock(() => undefined),
    postMessage : mock(() => undefined),
  };
}

/**
 * Dispatch a MessageEvent on `window` from the wallet origin.
 * Uses the real window.dispatchEvent so the listener registered
 * by initClient receives it.
 */
function dispatchWalletMessage(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: WALLET_ORIGIN }));
}

// ── Tests ───────────────────────────────────────────────────────

describe('DWebConnect.initClient', () => {
  let windowOpenSpy: ReturnType<typeof spyOn>;
  let fakePopup: ReturnType<typeof createFakePopup>;

  beforeEach(() => {
    fakePopup = createFakePopup();
    windowOpenSpy = spyOn(window, 'open').mockReturnValue(fakePopup as any);
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
  });

  // ── Encryption required ─────────────────────────────────────

  describe('encryption required', () => {
    it('should throw and close popup when ephemeral key generation fails', async () => {
      // Stub crypto.subtle.generateKey to simulate non-secure context.
      const generateKeySpy = spyOn(crypto.subtle, 'generateKey')
        .mockRejectedValue(new Error('not available'));

      try {
        await expect(
          DWebConnect.initClient({
            walletUrl          : WALLET_URL,
            did                : TEST_DID,
            permissionRequests : [stubPermissionRequest()],
            timeout            : 1000,
          }),
        ).rejects.toThrow('requires a secure context');

        expect(fakePopup.close).toHaveBeenCalled();
      } finally {
        generateKeySpy.mockRestore();
      }
    });

    it('should throw when popup is blocked', async () => {
      windowOpenSpy.mockReturnValue(null as any);

      await expect(
        DWebConnect.initClient({
          walletUrl          : WALLET_URL,
          did                : TEST_DID,
          permissionRequests : [stubPermissionRequest()],
        }),
      ).rejects.toThrow('Popup blocked');
    });
  });

  // ── Response handling ───────────────────────────────────────

  describe('response handling', () => {
    it('should reject plaintext responses (no encryptedPayload)', async () => {
      const promise = DWebConnect.initClient({
        walletUrl          : WALLET_URL,
        did                : TEST_DID,
        permissionRequests : [stubPermissionRequest()],
        timeout            : 5000,
      });

      // Wait for the listener to be registered.
      await new Promise((r) => setTimeout(r, 100));

      // Simulate wallet loaded.
      dispatchWalletMessage({ type: 'dweb-connect-loaded' });
      await new Promise((r) => setTimeout(r, 50));

      // Simulate a plaintext response (the old vulnerable path).
      dispatchWalletMessage({
        type        : 'dweb-connect-authorization-response',
        delegateDid : { uri: 'did:jwk:delegate', privateKeys: [{ kty: 'OKP' }] },
        grants      : [{ fake: true }],
      });

      const result = await promise;
      // Plaintext response must be rejected — resolved as undefined (denied).
      expect(result).toBeUndefined();
    });

    it('should treat wallet error response as denied', async () => {
      const promise = DWebConnect.initClient({
        walletUrl          : WALLET_URL,
        did                : TEST_DID,
        permissionRequests : [stubPermissionRequest()],
        timeout            : 5000,
      });

      await new Promise((r) => setTimeout(r, 100));
      dispatchWalletMessage({ type: 'dweb-connect-loaded' });
      await new Promise((r) => setTimeout(r, 50));

      // Wallet sends an explicit error.
      dispatchWalletMessage({
        type   : 'dweb-connect-authorization-response',
        error  : 'encryption_required',
        reason : 'Wallet requires an encrypted channel.',
      });

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('should treat decryption failure as denied', async () => {
      const promise = DWebConnect.initClient({
        walletUrl          : WALLET_URL,
        did                : TEST_DID,
        permissionRequests : [stubPermissionRequest()],
        timeout            : 5000,
      });

      await new Promise((r) => setTimeout(r, 100));
      dispatchWalletMessage({ type: 'dweb-connect-loaded' });
      await new Promise((r) => setTimeout(r, 50));

      // Send an encryptedPayload that cannot be decrypted (garbled data).
      dispatchWalletMessage({
        type             : 'dweb-connect-authorization-response',
        encryptedPayload : {
          ciphertext      : 'AAAA',
          iv              : 'BBBB',
          walletPublicKey : 'CCCC',
        },
      });

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('should decrypt a valid encrypted response', async () => {
      // Import the encrypt helper to build a real encrypted payload.
      const { encryptPostMessagePayload } = await import('../src/dweb-connect-crypto.js');

      // Intercept the ephemeral public key the client sends to the wallet.
      let dappPublicKey: string | undefined;
      fakePopup.postMessage = mock((msg: any) => {
        if (msg?.type === 'dweb-connect-authorization-request') {
          dappPublicKey = msg.ephemeralPublicKey;
        }
      });

      const promise = DWebConnect.initClient({
        walletUrl          : WALLET_URL,
        did                : TEST_DID,
        permissionRequests : [stubPermissionRequest()],
        timeout            : 10_000,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Wallet loaded — triggers the auth request postMessage.
      dispatchWalletMessage({ type: 'dweb-connect-loaded' });
      await new Promise((r) => setTimeout(r, 100));

      expect(dappPublicKey).toBeDefined();

      // Generate a wallet keypair with 'deriveBits' usage (needed by
      // encryptPostMessagePayload → deriveSharedKey → deriveBits).
      const walletKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
      );
      const walletPubRaw = await crypto.subtle.exportKey('raw', walletKeyPair.publicKey);
      const walletPubB64 = btoa(String.fromCharCode(...new Uint8Array(walletPubRaw)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const responsePayload = {
        delegateDid  : { uri: 'did:jwk:delegate', privateKeys: [{ kty: 'OKP' }] },
        connectedDid : TEST_DID,
        grants       : [{ recordId: 'grant1' }],
      };

      const encrypted = await encryptPostMessagePayload(
        responsePayload,
        walletKeyPair,
        walletPubB64,
        dappPublicKey!,
      );

      dispatchWalletMessage({
        type             : 'dweb-connect-authorization-response',
        encryptedPayload : encrypted,
      });

      const result = await promise;
      expect(result).toBeDefined();
      expect(result!.delegatePortableDid.uri).toBe('did:jwk:delegate');
      expect(result!.connectedDid).toBe(TEST_DID);
      expect(result!.delegateGrants).toHaveLength(1);
    });

    it('should resolve undefined for encrypted response missing delegateDid', async () => {
      const { encryptPostMessagePayload } = await import('../src/dweb-connect-crypto.js');

      let dappPublicKey: string | undefined;
      fakePopup.postMessage = mock((msg: any) => {
        if (msg?.type === 'dweb-connect-authorization-request') {
          dappPublicKey = msg.ephemeralPublicKey;
        }
      });

      const promise = DWebConnect.initClient({
        walletUrl          : WALLET_URL,
        did                : TEST_DID,
        permissionRequests : [stubPermissionRequest()],
        timeout            : 10_000,
      });

      await new Promise((r) => setTimeout(r, 100));
      dispatchWalletMessage({ type: 'dweb-connect-loaded' });
      await new Promise((r) => setTimeout(r, 100));

      const walletKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
      );
      const walletPubRaw = await crypto.subtle.exportKey('raw', walletKeyPair.publicKey);
      const walletPubB64 = btoa(String.fromCharCode(...new Uint8Array(walletPubRaw)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      // Payload is missing delegateDid and grants (user denied in wallet).
      const encrypted = await encryptPostMessagePayload(
        { someOtherField: true },
        walletKeyPair,
        walletPubB64,
        dappPublicKey!,
      );

      dispatchWalletMessage({
        type             : 'dweb-connect-authorization-response',
        encryptedPayload : encrypted,
      });

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('should always include ephemeralPublicKey in the auth request', async () => {
      let sentMessage: any;
      fakePopup.postMessage = mock((msg: any) => {
        if (msg?.type === 'dweb-connect-authorization-request') {
          sentMessage = msg;
        }
      });

      const promise = DWebConnect.initClient({
        walletUrl          : WALLET_URL,
        did                : TEST_DID,
        permissionRequests : [stubPermissionRequest()],
        timeout            : 5000,
      });

      await new Promise((r) => setTimeout(r, 100));
      dispatchWalletMessage({ type: 'dweb-connect-loaded' });
      await new Promise((r) => setTimeout(r, 100));

      expect(sentMessage).toBeDefined();
      expect(sentMessage.ephemeralPublicKey).toBeDefined();
      expect(typeof sentMessage.ephemeralPublicKey).toBe('string');
      expect(sentMessage.ephemeralPublicKey.length).toBeGreaterThan(0);

      // Clean up: send an error response so the promise resolves.
      dispatchWalletMessage({
        type  : 'dweb-connect-authorization-response',
        error : 'test_cleanup',
      });

      await promise;
    });

    it('should ignore messages from non-wallet origins', async () => {
      const promise = DWebConnect.initClient({
        walletUrl          : WALLET_URL,
        did                : TEST_DID,
        permissionRequests : [stubPermissionRequest()],
        timeout            : 5000,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Message from wrong origin — should be ignored.
      window.dispatchEvent(new MessageEvent('message', {
        data   : { type: 'dweb-connect-authorization-response', error: 'should_be_ignored' },
        origin : 'https://evil.example.com',
      }));

      await new Promise((r) => setTimeout(r, 50));

      // Correct origin — terminates the flow.
      dispatchWalletMessage({
        type  : 'dweb-connect-authorization-response',
        error : 'encryption_required',
      });

      const result = await promise;
      expect(result).toBeUndefined();
    });
  });
});

describe('DWebConnect.probeWalletSupport', () => {
  const probeWalletUrl = `${globalThis.location.origin}/wallet-support`;
  const probeWalletOrigin = globalThis.location.origin;

  afterEach(() => {
    document.querySelectorAll('iframe').forEach((iframe) => iframe.remove());
  });

  it('should post a support request to the wallet iframe and resolve true when supported', async () => {
    const promise = DWebConnect.probeWalletSupport(probeWalletUrl, TEST_DID, 1000);
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;

    expect(iframe).toBeDefined();
    expect(iframe.style.display).toBe('none');
    expect(iframe.src).toBe(probeWalletUrl);

    const postMessageSpy = spyOn(iframe.contentWindow!, 'postMessage');
    iframe.dispatchEvent(new Event('load'));

    expect(postMessageSpy).toHaveBeenCalledWith({
      type : 'dweb-connect-support-request',
      did  : TEST_DID,
    }, probeWalletOrigin);

    window.dispatchEvent(new MessageEvent('message', {
      data   : { type: 'dweb-connect-support-response', supported: true },
      origin : probeWalletOrigin,
    }));

    await expect(promise).resolves.toBe(true);
    expect(document.querySelector('iframe')).toBeNull();

    postMessageSpy.mockRestore();
  });

  it('should resolve false when the wallet reports unsupported DID', async () => {
    const promise = DWebConnect.probeWalletSupport(probeWalletUrl, TEST_DID, 1000);

    window.dispatchEvent(new MessageEvent('message', {
      data   : { type: 'dweb-connect-support-response', supported: false },
      origin : probeWalletOrigin,
    }));

    await expect(promise).resolves.toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('should ignore support responses from other origins', async () => {
    const promise = DWebConnect.probeWalletSupport(probeWalletUrl, TEST_DID, 1000);

    window.dispatchEvent(new MessageEvent('message', {
      data   : { type: 'dweb-connect-support-response', supported: true },
      origin : 'https://evil.example.com',
    }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('iframe')).not.toBeNull();

    window.dispatchEvent(new MessageEvent('message', {
      data   : { type: 'dweb-connect-support-response', supported: true },
      origin : probeWalletOrigin,
    }));

    await expect(promise).resolves.toBe(true);
  });

  it('should resolve false and remove the iframe when probing times out', async () => {
    await expect(DWebConnect.probeWalletSupport(probeWalletUrl, TEST_DID, 10)).resolves.toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
  });
});
