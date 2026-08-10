import type { PortableDid } from '@enbox/dids';
import type {
  ConnectPermissionRequest,
  ConnectRequest,
  ConnectRequestProfile,
  WalletUriHandoff,
} from '@enbox/connect';

import { describe, expect, it } from 'bun:test';

import { CompactJwe } from '@enbox/crypto';
import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { CONNECT_DENIED_TOKEN, sealResponse } from '@enbox/connect';
import { CryptoUtils, XChaCha20Poly1305 } from '@enbox/crypto';

import {
  MAX_PIN_ATTEMPTS,
  RelayConnectCancelledError,
  runRelayConnect,
  visibilityAwareSleep,
} from '../src/relay-connect-runner.js';

const PERMISSIONS: ConnectPermissionRequest[] = [
  {
    protocolDefinition : { protocol: 'https://proto.example.com', types: {}, structure: {} },
    permissionScopes   : [{ protocol: 'https://proto.example.com', interface: 'Records', method: 'Write' }],
  } as unknown as ConnectPermissionRequest,
];

/**
 * A loopback relay transport that plays the wallet: it decrypts the sealed
 * request with the `dir` key it minted (as the real relay+wallet pair do),
 * reads the request's correlators and response key, and answers with a real
 * `sealResponse` ciphertext strengthened by `walletPin`.
 */
type LoopbackTransport = {
  requiresPin: boolean;
  confirmCompleteCalls: number;
  requestProfile(state: string): Promise<ConnectRequestProfile>;
  deliverRequest(jwe: string): Promise<WalletUriHandoff>;
  awaitResponse(): Promise<string>;
  confirmComplete(): Promise<void>;
};

function createLoopbackTransport(walletPin: string | undefined, respond: 'approve' | 'deny', options: {
  onRequest?: (request: ConnectRequest) => void;
  responseDelegateDid?: string;
} = {}): LoopbackTransport {
  const requestKey = CryptoUtils.randomBytes(32);
  let deliveredJwe: string | undefined;

  return {
    requiresPin          : true,
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

    async awaitResponse(): Promise<string> {
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
        signer      : walletDid,
        responseKey : request.responseKey,
        pin         : walletPin,
      });
    },
  };
}

function baseOptions(transport: LoopbackTransport): {
  handoffs: WalletUriHandoff[];
  options: Omit<Parameters<typeof runRelayConnect>[0], 'requestPin'>;
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
  it('completes a full loopback handshake and surfaces the wallet URI handoff', async () => {
    const transport = createLoopbackTransport('1234', 'approve');
    const { options, handoffs } = baseOptions(transport);

    const result = await runRelayConnect({
      ...options,
      requestPin: async (): Promise<string> => '1234',
    });

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].expiresIn).toBe(600);
    expect(result?.connectedDid).toBe('did:dht:provider');
    expect(result?.delegatePortableDid.uri.startsWith('did:jwk:')).toBe(true);
    expect(result?.delegateGrants).toEqual([]);
    // The wallet-facing completion signal fired exactly once after the open.
    expect(transport.confirmCompleteCalls).toBe(1);
  });

  it('reuses a pre-supplied delegate for a refresh request', async () => {
    let observedRequest: ConnectRequest | undefined;
    const transport = createLoopbackTransport('1234', 'approve', {
      onRequest: (request): void => { observedRequest = request; },
    });
    const { options } = baseOptions(transport);
    const delegate = await DidJwk.create();
    const delegatePortableDid = await delegate.export();

    const result = await runRelayConnect({
      ...options,
      delegatePortableDid,
      requestType : 'refresh',
      requestPin  : async (): Promise<string> => '1234',
    });

    expect(observedRequest?.delegateDid).toBe(delegate.uri);
    expect(observedRequest?.requestType).toBe('refresh');
    expect(result?.delegatePortableDid).toBe(delegatePortableDid);
    expect(transport.confirmCompleteCalls).toBe(1);
  });

  it('rejects a refresh request without a pre-supplied delegate', async () => {
    const transport = createLoopbackTransport('1234', 'approve');
    const { options } = baseOptions(transport);

    await expect(runRelayConnect({
      ...options,
      requestType : 'refresh',
      requestPin  : async (): Promise<string> => '1234',
    })).rejects.toThrow('refresh requests require an existing `delegatePortableDid`');
  });

  it('fails a refresh when the wallet responds for a different delegate', async () => {
    const rogueDelegate = await DidJwk.create();
    const transport = createLoopbackTransport('1234', 'approve', {
      responseDelegateDid: rogueDelegate.uri,
    });
    const { options } = baseOptions(transport);
    const delegate = await DidJwk.create();
    let pinAttempts = 0;

    await expect(runRelayConnect({
      ...options,
      delegatePortableDid : await delegate.export(),
      requestType         : 'refresh',
      requestPin          : async (): Promise<string> => { pinAttempts++; return '1234'; },
    })).rejects.toThrow('Revoke the just-approved session');
    expect(pinAttempts).toBe(1);
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('retries a mistyped pairing code against the same response', async () => {
    const transport = createLoopbackTransport('4321', 'approve');
    const { options } = baseOptions(transport);

    const attempts: Array<{ attempt: number; hadError: boolean }> = [];
    const result = await runRelayConnect({
      ...options,
      requestPin: async (attempt, previousError): Promise<string> => {
        attempts.push({ attempt, hadError: previousError !== undefined });
        return attempt < 3 ? '0000' : '4321';
      },
    });

    expect(attempts).toEqual([
      { attempt: 1, hadError: false },
      { attempt: 2, hadError: true },
      { attempt: 3, hadError: true },
    ]);
    expect(result?.connectedDid).toBe('did:dht:provider');
  });

  it('fails closed after the PIN attempt budget', async () => {
    const transport = createLoopbackTransport('9999', 'approve');
    const { options } = baseOptions(transport);

    let attempts = 0;
    await expect(runRelayConnect({
      ...options,
      requestPin: async (): Promise<string> => { attempts++; return '0000'; },
    })).rejects.toThrow(/did not match after/);
    expect(attempts).toBe(MAX_PIN_ATTEMPTS);
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('resolves undefined when the wallet denies', async () => {
    const transport = createLoopbackTransport(undefined, 'deny');
    const { options } = baseOptions(transport);

    const result = await runRelayConnect({
      ...options,
      requestPin: async (): Promise<string> => { throw new Error('test: PIN must not be requested on denial'); },
    });

    expect(result).toBeUndefined();
    expect(transport.confirmCompleteCalls).toBe(0);
  });

  it('rejects with the cancellation error when the UI cancels mid-poll', async () => {
    const transport = createLoopbackTransport('1234', 'approve');
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
      requestPin: async (): Promise<string> => '1234',
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
