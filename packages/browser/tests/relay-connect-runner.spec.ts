import type { Jwk } from '@enbox/crypto';
import type { RelayConnectOptions } from '../src/relay-connect-runner.js';
import type {
  ConnectPermissionRequest,
  ConnectRequest,
  ConnectRequestProfile,
  ConnectVerificationSymbol,
  WalletUriHandoff,
} from '@enbox/connect';

import { describe, expect, it } from 'bun:test';

import { CryptoUtils } from '@enbox/crypto';
import { DidJwk } from '@enbox/dids';
import { ConnectProvider, createConnectVerificationHandshake } from '@enbox/connect';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

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

type LoopbackTransport = {
  requiresHandshake: boolean;
  confirmCompleteCalls: number;
  lastWalletSymbols?: readonly ConnectVerificationSymbol[];
  requestProfile(state: string): Promise<ConnectRequestProfile>;
  deliverRequest(jwe: string): Promise<WalletUriHandoff>;
  awaitResponse(options?: { onHandshake?: (walletEpk: Jwk) => Promise<void> | void }): Promise<string>;
  confirmComplete(): Promise<void>;
};

function createLoopbackTransport(onRequest?: (request: ConnectRequest) => void): LoopbackTransport {
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
      const request = await ConnectProvider.openRequest({
        jwe        : deliveredJwe!,
        decryption : { mode: 'dir', requestKey },
      });
      onRequest?.(request);

      const handshake = await createConnectVerificationHandshake({ request, requestJwe: deliveredJwe! });
      transport.lastWalletSymbols = handshake.symbols;
      await awaitOptions?.onHandshake?.(handshake.walletEpk);

      const delegateDid = await DidJwk.create();
      return await ConnectProvider.sealApprovedResponse({
        request,
        providerDid : 'did:dht:provider',
        approval    : {
          delegateDid        : request.delegateDid ?? delegateDid.uri,
          delegateGrants     : [],
          sessionRevocations : [],
          ...(request.delegateDid === undefined ? { delegatePortableDid: await delegateDid.export() } : {}),
        },
        signer       : delegateDid,
        handshakeKey : handshake.walletEpk,
      });
    },
  };

  return transport;
}

function baseOptions(transport: LoopbackTransport): {
  handoffs: WalletUriHandoff[];
  options: RelayConnectOptions;
} {
  const handoffs: WalletUriHandoff[] = [];
  return {
    handoffs,
    options: {
      connectServerUrl    : 'https://relay.example.com/connect',
      walletUri           : 'https://wallet.example.com/connect/app',
      appName             : 'Test Dapp',
      permissionRequests  : PERMISSIONS,
      createTransport     : () => transport,
      onWalletUriReady    : (handoff: WalletUriHandoff): void => { handoffs.push(handoff); },
      onVerificationReady : (): void => {},
    },
  };
}

describe('runRelayConnect', () => {
  it('completes a loopback handshake and surfaces wallet URI and matching SAS verification symbols', async () => {
    const transport = createLoopbackTransport();
    const { options, handoffs } = baseOptions(transport);
    let observedSymbols: readonly ConnectVerificationSymbol[] | undefined;

    const result = await runRelayConnect({
      ...options,
      onVerificationReady: (symbols): void => { observedSymbols = symbols; },
    });

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].expiresIn).toBe(600);
    expect(observedSymbols).toEqual(transport.lastWalletSymbols);
    expect(result?.connectedDid).toBe('did:dht:provider');
    expect(result?.delegatePortableDid.uri.startsWith('did:jwk:')).toBe(true);
    expect(transport.confirmCompleteCalls).toBe(1);
  });

  it('forwards refresh request metadata and pre-supplied delegate credentials', async () => {
    let observedRequest: ConnectRequest | undefined;
    const transport = createLoopbackTransport((request): void => { observedRequest = request; });
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
    const transport = createLoopbackTransport();
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

  it('rejects with the cancellation error and aborts the transport signal when cancelled mid-poll', async () => {
    const transport = createLoopbackTransport();
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
    const started = Date.now();
    const sleeping = visibilityAwareSleep(60_000);
    document.dispatchEvent(new Event('visibilitychange'));
    await sleeping;
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});
