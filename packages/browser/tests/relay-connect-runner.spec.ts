import type { Jwk } from '@enbox/crypto';
import type { PortableDid } from '@enbox/dids';
import type { RelayConnectOptions } from '../src/relay-connect-runner.js';
import type {
  ConnectPermissionRequest,
  ConnectRequest,
  ConnectRequestProfile,
  ConnectVerificationSymbol,
  WalletUriHandoff,
} from '@enbox/connect';

import { describe, expect, it } from 'bun:test';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { CompactJwe } from '@enbox/crypto';
import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { CONNECT_DENIED_TOKEN, createConnectVerificationHandshake, sealResponse } from '@enbox/connect';
import { CryptoUtils, X25519, XChaCha20Poly1305 } from '@enbox/crypto';

import {
  RelayConnectCancelledError,
  runRelayConnect,
  visibilityAwareSleep,
} from '../src/relay-connect-runner.js';

const PERMISSIONS: ConnectPermissionRequest[] = [
  {
    moduleDefinition : { module: 'https://modules.example.com', published: false, types: {}, structure: {} },
    permissionScopes : [{ module: 'https://modules.example.com', interface: DwnInterfaceName.Records, method: DwnMethodName.Write }],
  },
];

/**
 * A loopback relay transport that plays the wallet: it decrypts the sealed
 * request with the `dir` key it minted, publishes a SAS handshake public key,
 * and answers with a real `sealResponse` ciphertext bound to `walletEpk`.
 */
type LoopbackTransport = {
  requiresHandshake: boolean;
  confirmCompleteCalls: number;
  lastWalletSymbols?: readonly ConnectVerificationSymbol[];
  requestProfile(state: string): Promise<ConnectRequestProfile>;
  deliverRequest(jwe: string): Promise<WalletUriHandoff>;
  awaitResponse(options?: { onHandshake?: (walletEpk: Jwk) => Promise<void> | void }): Promise<string>;
  confirmComplete(): Promise<void>;
};

function createLoopbackTransport(respond: 'approve' | 'deny', options: {
  onRequest?: (request: ConnectRequest) => void;
  responseDelegateDid?: string;
  responseHandshakeKeyOverride?: Jwk;
} = {}): LoopbackTransport {
  const requestKey = CryptoUtils.randomBytes(32);
  let deliveredJwe: string | undefined;

  const transport: LoopbackTransport = {
    requiresHandshake    : true,
    confirmCompleteCalls : 0,

    async confirmComplete(): Promise<void> {
      this.confirmCompleteCalls += 1;
    },

    async requestProfile(state: string): Promise<ConnectRequestProfile> {
      return {
        encryption : { mode: 'dir', requestKey },
        reply      : { mode: 'direct_post', callbackUrl: 'https://relay.example.com/connect/callback' },
        state,
      };
    },

    async deliverRequest(jwe: string): Promise<WalletUriHandoff> {
      deliveredJwe = jwe;
      return {
        walletUri  : 'https://wallet.example.com/connect/app#request_uri=r&encryption_key=k',
        requestUri : 'https://relay.example.com/connect/par/r',
        expiresIn  : 600,
      };
    },

    async awaitResponse(awaitOptions?: { onHandshake?: (walletEpk: Jwk) => Promise<void> | void }): Promise<string> {
      if (respond === 'deny') {
        return CONNECT_DENIED_TOKEN;
      }
      if (deliveredJwe === undefined) {
        throw new Error('test: request was never delivered');
      }

      // Wallet side: open the request with the dir key, read the payload.
      const contentKey = await XChaCha20Poly1305.bytesToPrivateKey({ privateKeyBytes: requestKey });
      const { plaintext } = await CompactJwe.decrypt({
        jwe     : deliveredJwe,
        key     : contentKey,
        options : { allowedAlgs: ['dir'], allowedEncs: ['XC20P'] },
      });
      const jwt = Convert.uint8Array(plaintext).toString();
      const request = JSON.parse(Convert.base64Url(jwt.split('.')[1]).toString()) as ConnectRequest;
      options.onRequest?.(request);

      const handshake = await createConnectVerificationHandshake({ request, requestJwe: deliveredJwe });
      transport.lastWalletSymbols = handshake.symbols;
      await awaitOptions?.onHandshake?.(handshake.walletEpk);

      const walletDid = await DidJwk.create();
      const delegateDid = await DidJwk.create();
      const delegatePortableDid: PortableDid = await delegateDid.export();
      const responseDelegateDid = options.responseDelegateDid ?? request.delegateDid ?? delegateDid.uri;

      const nowSeconds = Math.floor(Date.now() / 1000);
      return await sealResponse({
        response: {
          providerDid        : 'did:dht:provider',
          delegateDid        : responseDelegateDid,
          aud                : request.clientDid,
          iat                : nowSeconds,
          exp                : nowSeconds + 600,
          nonce              : request.nonce,
          state              : request.state,
          delegateGrants     : [],
          sessionRevocations : [],
          ...(request.delegateDid === undefined ? { delegatePortableDid } : {}),
        },
        signer       : walletDid,
        responseKey  : request.responseKey,
        handshakeKey : options.responseHandshakeKeyOverride ?? handshake.walletEpk,
      });
    },
  };

  return transport;
}

function baseOptions(transport: LoopbackTransport): {
  handoffs: WalletUriHandoff[];
  options: Parameters<typeof runRelayConnect>[0];
} {
  const handoffs: WalletUriHandoff[] = [];
  return {
    handoffs,
    options: {
      connectServerUrl   : 'https://relay.example.com/connect',
      walletUri          : 'https://wallet.example.com/connect/app',
      appName            : 'Test Dapp',
      permissionRequests : PERMISSIONS,
      createTransport    : () => transport,
      onWalletUriReady   : (handoff: WalletUriHandoff): void => { handoffs.push(handoff); },
    },
  };
}

describe('runRelayConnect', () => {
  it('completes a full loopback handshake and surfaces wallet URI and matching SAS verification symbols', async () => {
    const transport = createLoopbackTransport('approve');
    const { options, handoffs } = baseOptions(transport);
    let observedSymbols: readonly ConnectVerificationSymbol[] | undefined;

    const result = await runRelayConnect({
      ...options,
      onVerificationReady: (symbols): void => { observedSymbols = symbols; },
    });

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].expiresIn).toBe(600);
    expect(observedSymbols).toBeDefined();
    expect(observedSymbols).toEqual(transport.lastWalletSymbols);
    expect(result?.connectedDid).toBe('did:dht:provider');
    expect(result?.delegatePortableDid.uri.startsWith('did:jwk:')).toBe(true);
    expect(result?.delegateGrants).toEqual([]);
    // The wallet-facing completion signal fired exactly once after the open.
    expect(transport.confirmCompleteCalls).toBe(1);
  });

  it('reuses a pre-supplied delegate for a refresh request', async () => {
    let observedRequest: ConnectRequest | undefined;
    const transport = createLoopbackTransport('approve', {
      onRequest: (request): void => { observedRequest = request; },
    });
    const { options } = baseOptions(transport);
    const delegate = await DidJwk.create();
    const delegatePortableDid = await delegate.export();

    const result = await runRelayConnect({
      ...options,
      delegatePortableDid,
      requestType: 'refresh',
    });

    expect(observedRequest?.delegateDid).toBe(delegate.uri);
    expect(observedRequest?.requestType).toBe('refresh');
    expect(result?.delegatePortableDid).toEqual(delegatePortableDid);
    expect(transport.confirmCompleteCalls).toBe(1);
  });

  it('rejects identity-only requests before starting the data-session relay flow', async () => {
    const transport = createLoopbackTransport('approve');
    const { options, handoffs } = baseOptions(transport);
    let transportCreated = false;
    let verificationCalled = false;
    await expect(runRelayConnect({
      ...options,
      requestType         : 'authenticate',
      createTransport     : () => { transportCreated = true; return transport; },
      onVerificationReady : (): void => { verificationCalled = true; },
    } as RelayConnectOptions)).rejects.toThrow('Connect: runRelayConnect creates data sessions');
    expect(transportCreated).toBe(false);
    expect(verificationCalled).toBe(false);
    expect(handoffs).toHaveLength(0);
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('rejects a refresh request without a pre-supplied delegate', async () => {
    const transport = createLoopbackTransport('approve');
    const { options } = baseOptions(transport);

    await expect(runRelayConnect({
      ...options,
      requestType: 'refresh',
    })).rejects.toThrow('refresh requests require an existing `delegatePortableDid`');
  });

  it('fails a refresh when the wallet responds for a different delegate', async () => {
    const rogueDelegate = await DidJwk.create();
    const transport = createLoopbackTransport('approve', {
      responseDelegateDid: rogueDelegate.uri,
    });
    const { options } = baseOptions(transport);
    const delegate = await DidJwk.create();

    await expect(runRelayConnect({
      ...options,
      delegatePortableDid : await delegate.export(),
      requestType         : 'refresh',
    })).rejects.toThrow('Revoke the just-approved session');
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('fails closed when the response apv does not match the handshake key', async () => {
    const rogueKey = await X25519.generateKey();
    const transport = createLoopbackTransport('approve', {
      responseHandshakeKeyOverride: { kty: 'OKP', crv: 'X25519', x: rogueKey.x },
    });
    const { options } = baseOptions(transport);

    await expect(runRelayConnect(options)).rejects.toThrow('"apv"');
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('resolves undefined when the wallet denies', async () => {
    const transport = createLoopbackTransport('deny');
    const { options } = baseOptions(transport);
    let verificationCalled = false;

    const result = await runRelayConnect({
      ...options,
      onVerificationReady: (): void => { verificationCalled = true; },
    });

    expect(result).toBeUndefined();
    expect(verificationCalled).toBe(false);
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('rejects with the cancellation error when the UI cancels mid-poll', async () => {
    const transport = createLoopbackTransport('approve');
    // Poll never resolves; cancellation must win the race.
    transport.awaitResponse = (): Promise<string> => new Promise<string>(() => { /* pending */ });
    const { options } = baseOptions(transport);
    let observedSignal: AbortSignal | undefined;

    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = (): void => reject(new RelayConnectCancelledError());
    });
    cancelled.catch((): undefined => undefined);

    const flow = runRelayConnect({
      ...options,
      cancelled,
      createTransport: (transportOptions) => {
        observedSignal = transportOptions.signal;
        return transport;
      },
    });

    expect(observedSignal?.aborted).toBe(false);
    cancel();
    await expect(flow).rejects.toBeInstanceOf(RelayConnectCancelledError);
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe('visibilityAwareSleep', () => {
  it('resolves after the requested delay with no visibility change', async () => {
    const started = Date.now();
    await visibilityAwareSleep(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('ends early when the page returns to the foreground', async () => {
    // A 60s sleep must be cut short by the visibility signal (the test page
    // is visible, so dispatching the event stands in for a tab return) —
    // well inside the test timeout proves the short-circuit.
    const started = Date.now();
    const sleeping = visibilityAwareSleep(60_000);
    document.dispatchEvent(new Event('visibilitychange'));
    await sleeping;
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});
