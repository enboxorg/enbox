/**
 * DWeb Connect client — initiates the popup/postMessage connect flow.
 *
 * This is the dapp-side counterpart to the wallet's `/dweb-connect` page.
 * The wallet is opened as a popup window, and communication happens via
 * `window.postMessage`. No relay server, QR codes, or PINs are needed.
 *
 * @module
 */

import type { ConnectResult } from '@enbox/auth';
import type { PortableDid } from '@enbox/dids';
import type { ConnectPermissionRequest, DwnDataEncodedRecordsWriteMessage } from '@enbox/agent';

import type { EncryptedPostMessagePayload } from './dweb-connect-crypto.js';
import { decryptPostMessagePayload, generateEphemeralKeyPair } from './dweb-connect-crypto.js';

/** Options for initiating a DWeb Connect flow via popup. */
export interface DWebConnectClientOptions {
  /** Base URL of the wallet app (e.g. "https://wallet.enbox.org"). */
  walletUrl: string;

  /** The DID to pre-select in the wallet's identity picker. */
  did?: string;

  /**
   * Protocol permission requests to send to the wallet.
   * Each entry contains a `protocolDefinition` and `permissionScopes`.
   */
  permissionRequests: ConnectPermissionRequest[];

  /**
   * Timeout in milliseconds. The popup is closed and an error thrown
   * if the wallet doesn't respond within this time.
   * @default 300_000 (5 minutes)
   */
  timeout?: number;
}

/**
 * Open a wallet popup and run the DWeb Connect postMessage flow.
 *
 * Protocol:
 * 1. Dapp opens `${walletUrl}/dweb-connect` as a popup.
 * 2. Wallet sends `{ type: 'dweb-connect-loaded' }` when ready.
 * 3. Dapp sends `{ type: 'dweb-connect-authorization-request', did, permissions }`.
 * 4. Wallet shows consent UI, then sends back
 *    `{ type: 'dweb-connect-authorization-response', delegateDid, grants }`.
 * 5. Popup closes.
 *
 * @returns The delegate credentials, or `undefined` if the user denied.
 * @throws If the popup is blocked, times out, or the wallet returns an error.
 */
async function initClient(options: DWebConnectClientOptions): Promise<ConnectResult | undefined> {
  const {
    walletUrl,
    did,
    permissionRequests,
    timeout = 300_000,
  } = options;

  if (typeof window === 'undefined') {
    throw new Error(
      '[@enbox/auth] DWeb Connect is only available in browser environments.'
    );
  }

  // Open the wallet's DWeb Connect page as a popup.
  const popupUrl = new URL('/dweb-connect', walletUrl).toString();
  const popup = window.open(
    popupUrl,
    'enbox-dweb-connect',
    'width=500,height=700,menubar=no,toolbar=no,location=no,status=no',
  );

  if (!popup) {
    throw new Error(
      '[@enbox/auth] Popup blocked. Allow popups for this site to connect to a wallet.'
    );
  }

  // Generate an ephemeral ECDH keypair for this connect session.
  // The public key is sent to the wallet so it can encrypt the response
  // containing delegate private keys and decryption material.
  let dappKeyPair: CryptoKeyPair | undefined;
  let dappPublicKeyBase64url: string | undefined;

  try {
    const ephemeral = await generateEphemeralKeyPair();
    dappKeyPair = ephemeral.keyPair;
    dappPublicKeyBase64url = ephemeral.publicKeyBase64url;
  } catch {
    // crypto.subtle unavailable (e.g. non-secure context) — skip encryption.
  }

  return new Promise<ConnectResult | undefined>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      settled = true;
      clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
    };

    // Set up timeout.
    const timeoutId = setTimeout(() => {
      if (!settled) {
        cleanup();
        try { popup.close(); } catch { /* best effort */ }
        reject(new Error(
          '[@enbox/auth] DWeb Connect timed out waiting for wallet response.'
        ));
      }
    }, timeout);

    // Monitor popup closed without response (user closed the window).
    const pollClosed = setInterval(() => {
      if (popup.closed && !settled) {
        clearInterval(pollClosed);
        cleanup();
        resolve(undefined);
      }
    }, 500);

    const onMessage = (event: MessageEvent): void => {
      // Validate origin matches the wallet URL.
      const walletOrigin = new URL(walletUrl).origin;
      if (event.origin !== walletOrigin) {return;}

      const { type } = event.data ?? {};

      if (type === 'dweb-connect-loaded') {
        // Wallet is ready — send the authorization request with ephemeral public key.
        popup.postMessage({
          type               : 'dweb-connect-authorization-request',
          did,
          permissions        : permissionRequests,
          ephemeralPublicKey : dappPublicKeyBase64url,
        }, walletOrigin);
        return;
      }

      if (type === 'dweb-connect-authorization-response') {
        clearInterval(pollClosed);
        cleanup();

        // Handle encrypted response (wallet supports ECDH channel encryption).
        const encrypted = event.data.encryptedPayload as EncryptedPostMessagePayload | undefined;
        if (encrypted && dappKeyPair) {
          decryptPostMessagePayload(encrypted, dappKeyPair).then((payload: Record<string, unknown>) => {
            const p = payload as any;
            if (!p.delegateDid || !p.grants) {
              resolve(undefined);
              return;
            }
            resolve({
              delegatePortableDid         : p.delegateDid as PortableDid,
              delegateGrants              : p.grants as DwnDataEncodedRecordsWriteMessage[],
              connectedDid                : p.connectedDid ?? did ?? (p.delegateDid as PortableDid).uri,
              delegateDecryptionKeys      : p.delegateDecryptionKeys ?? undefined,
              delegateContextKeys         : p.delegateContextKeys ?? undefined,
              delegateMultiPartyProtocols : p.delegateMultiPartyProtocols ?? undefined,
              sessionRevocations          : p.sessionRevocations ?? undefined,
            });
          }).catch(() => {
            // Decryption failed — treat as denied.
            resolve(undefined);
          });
          return;
        }

        // Plaintext fallback (wallet doesn't support encryption yet).
        const {
          delegateDid,
          connectedDid: walletConnectedDid,
          grants,
          delegateDecryptionKeys,
          delegateContextKeys,
          delegateMultiPartyProtocols,
          sessionRevocations,
        } = event.data;

        if (!delegateDid || !grants) {
          resolve(undefined);
          return;
        }

        resolve({
          delegatePortableDid         : delegateDid as PortableDid,
          delegateGrants              : grants as DwnDataEncodedRecordsWriteMessage[],
          connectedDid                : walletConnectedDid ?? did ?? delegateDid.uri,
          delegateDecryptionKeys      : delegateDecryptionKeys ?? undefined,
          delegateContextKeys         : delegateContextKeys ?? undefined,
          delegateMultiPartyProtocols : delegateMultiPartyProtocols ?? undefined,
          sessionRevocations          : sessionRevocations ?? undefined,
        });
      }
    };

    window.addEventListener('message', onMessage);
  });
}

/**
 * Probe whether a wallet supports a specific DID via a hidden iframe.
 *
 * Sends a `dweb-connect-support-request` message to the wallet and
 * waits for a `dweb-connect-support-response`. Useful for checking
 * multiple wallet URLs to find the one that manages a given DID.
 *
 * @param walletUrl - Base URL of the wallet to probe.
 * @param did - The DID to check.
 * @param timeout - Probe timeout in ms. Default: 5_000 (5 seconds).
 * @returns `true` if the wallet manages the DID, `false` otherwise.
 */
async function probeWalletSupport(
  walletUrl: string,
  did: string,
  timeout = 5_000,
): Promise<boolean> {
  if (typeof window === 'undefined') {return false;}

  return new Promise<boolean>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = walletUrl;

    let settled = false;

    const cleanup = (): void => {
      settled = true;
      window.removeEventListener('message', onMessage);
      try { document.body.removeChild(iframe); } catch { /* best effort */ }
    };

    const timeoutId = setTimeout(() => {
      if (!settled) {
        cleanup();
        resolve(false);
      }
    }, timeout);

    const onMessage = (event: MessageEvent): void => {
      const walletOrigin = new URL(walletUrl).origin;
      if (event.origin !== walletOrigin) { return; }

      const { type, supported } = event.data ?? {};
      if (type === 'dweb-connect-support-response') {
        clearTimeout(timeoutId);
        cleanup();
        resolve(!!supported);
      }
    };

    window.addEventListener('message', onMessage);

    iframe.addEventListener('load', () => {
      const walletOrigin = new URL(walletUrl).origin;
      iframe.contentWindow?.postMessage({
        type: 'dweb-connect-support-request',
        did,
      }, walletOrigin);
    });

    document.body.appendChild(iframe);
  });
}

export const DWebConnect = { initClient, probeWalletSupport };
