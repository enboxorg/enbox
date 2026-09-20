import type { ConnectRequest } from '@enbox/connect';
import type { Jwk } from '@enbox/crypto';

import { DidJwk } from '@enbox/dids';
import { sealRequest } from '@enbox/connect';
import { WalletPostMessageTransport } from '@enbox/browser';
import { X25519 } from '@enbox/crypto';
import { afterEach, describe, expect, it } from 'bun:test';

import { ConnectWorkerSessionRegistry } from '../src/proofs/connect/connect-worker-boundary.js';

type PostedMessage = {
  data: Record<string, unknown>;
  targetOrigin: string;
};

const DAPP_ORIGIN = 'http://localhost:18443';
const WALLET_ORIGIN = 'http://localhost:18444';
const CONTEXT = { principalId: 'lab-1/wallet-1/provider-page' };

let activeTransport: WalletPostMessageTransport | undefined;
let originalLocation: PropertyDescriptor | undefined;
let originalWindow: PropertyDescriptor | undefined;

function createWindowStandIn(posted: PostedMessage[]): Window {
  const port = new MessageChannel().port1;
  Object.defineProperty(port, 'closed', { configurable: true, value: false, writable: true });
  Object.defineProperty(port, 'close', {
    configurable : true,
    value        : (): void => { (port as unknown as { closed: boolean }).closed = true; },
  });
  Object.defineProperty(port, 'postMessage', {
    configurable : true,
    value        : (data: Record<string, unknown>, targetOrigin: string): void => {
      posted.push({ data, targetOrigin });
    },
  });
  return port as unknown as Window;
}

function installWalletWindow(): EventTarget {
  originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const walletWindow = new EventTarget();
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(WALLET_ORIGIN) });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: walletWindow });
  return walletWindow;
}

function restoreGlobalProperty(name: 'location' | 'window', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
  } else {
    Object.defineProperty(globalThis, name, descriptor);
  }
}

async function createSealedPopupRequest(walletEpk: Jwk): Promise<{ jwe: string; request: ConnectRequest }> {
  const clientDid = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();
  const request: ConnectRequest = {
    appName             : 'Private Notes',
    clientDid           : clientDid.uri,
    clientMetadata      : { origin: DAPP_ORIGIN },
    nonce               : 'popup-nonce',
    permissionRequests  : [],
    reply               : { mode: 'post_message' },
    responseKey         : { crv: 'X25519', kty: 'OKP', x: responsePrivateKey.x },
    state               : 'popup-state',
    supportedDidMethods : ['did:dht'],
  };
  const jwe = await sealRequest({
    encryption : { mode: 'ecdh-es', walletEpk, walletOrigin: WALLET_ORIGIN },
    request,
    signer     : clientDid,
  });
  return { jwe, request };
}

describe('popup provider page to wallet worker boundary', () => {
  afterEach(() => {
    activeTransport?.close();
    activeTransport = undefined;
    restoreGlobalProperty('location', originalLocation);
    restoreGlobalProperty('window', originalWindow);
    originalLocation = undefined;
    originalWindow = undefined;
  });

  it('should open with the real transport, bind the validated request, and deny with pinned origins', async () => {
    const walletWindow = installWalletWindow();
    const outbound: PostedMessage[] = [];
    const dappWindow = createWindowStandIn(outbound);
    activeTransport = await WalletPostMessageTransport.create({
      dappOrigin : DAPP_ORIGIN,
      dappWindow,
      timeoutMs  : 2_000,
    });

    const loaded = outbound[0];
    expect(loaded.data.type).toBe('enbox-connect-loaded');
    expect(loaded.data.walletEpk).not.toHaveProperty('d');
    expect(loaded.targetOrigin).toBe(DAPP_ORIGIN);

    const { jwe, request } = await createSealedPopupRequest(loaded.data.walletEpk as Jwk);
    const otherWindow = createWindowStandIn([]);
    walletWindow.dispatchEvent(new MessageEvent('message', {
      data   : { jwe, type: 'enbox-connect-request' },
      origin : 'https://attacker.example',
      source : dappWindow,
    }));
    walletWindow.dispatchEvent(new MessageEvent('message', {
      data   : { jwe, type: 'enbox-connect-request' },
      origin : DAPP_ORIGIN,
      source : otherWindow,
    }));
    walletWindow.dispatchEvent(new MessageEvent('message', {
      data   : { jwe, type: 'enbox-connect-request' },
      origin : DAPP_ORIGIN,
      source : dappWindow,
    }));

    const opened = await activeTransport.awaitRequest();
    expect(opened).toEqual(request);
    const registry = new ConnectWorkerSessionRegistry();
    const bound = registry.bind({
      channel   : { dappOrigin: activeTransport.dappOrigin, kind: 'popup' },
      context   : CONTEXT,
      request   : opened,
      transport : 'postMessage',
    });

    expect(Object.keys(bound.handle).sort()).toEqual([
      'binding',
      'expiresAt',
      'id',
      'requestDigest',
      'workerInstanceId',
    ]);
    expect(JSON.stringify(bound.handle)).not.toContain(opened.clientDid);
    expect(bound.request.responseKey).not.toHaveProperty('d');

    const denial = registry.deny(CONTEXT, bound.handle);
    activeTransport.sendResponse(denial);
    expect(outbound.at(-1)).toEqual({
      data         : { payload: 'DENIED', type: 'enbox-connect-response' },
      targetOrigin : DAPP_ORIGIN,
    });
  });
});
