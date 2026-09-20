import type { ConnectRequest } from '@enbox/connect';
import type {
  ConnectWorkerBoundaryErrorCode,
  ConnectWorkerRequestContext,
  ConnectWorkerSessionHandle,
} from '../src/proofs/connect/connect-worker-boundary.js';

import { describe, expect, it } from 'bun:test';

import {
  CONNECT_WORKER_MAX_REQUEST_BYTES,
  ConnectWorkerBoundary,
  ConnectWorkerBoundaryError,
  ConnectWorkerSessionRegistry,
} from '../src/proofs/connect/connect-worker-boundary.js';

const CONTEXT: ConnectWorkerRequestContext = { principalId: 'lab-1/wallet-1/provider-page' };
const DAPP_ORIGIN = 'http://localhost:18443';
const RELAY_ORIGIN = 'http://localhost:18444';

function createRequest(reply: ConnectRequest['reply'] = { mode: 'post_message' }): ConnectRequest {
  return {
    appName            : 'Private Notes',
    clientDid          : 'did:jwk:client',
    clientMetadata     : { origin: DAPP_ORIGIN },
    nonce              : 'request-nonce',
    permissionRequests : [],
    reply,
    responseKey        : {
      crv : 'X25519',
      kty : 'OKP',
      x   : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    state               : 'request-state',
    supportedDidMethods : ['did:dht'],
  };
}

function bindPopup(
  registry: ConnectWorkerSessionRegistry,
  request: ConnectRequest = createRequest(),
): ConnectWorkerSessionHandle {
  return registry.bind({
    channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
    context   : CONTEXT,
    request,
    transport : 'postMessage',
  }).handle;
}

function expectBoundaryError(callback: () => unknown, code: ConnectWorkerBoundaryErrorCode): void {
  try {
    callback();
    throw new Error(`Expected connect worker boundary error '${code}'.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectWorkerBoundaryError);
    expect((error as ConnectWorkerBoundaryError).code).toBe(code);
  }
}

function changeFirstCharacter(value: string): string {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}

describe('connect worker session binding', () => {
  it('should snapshot the displayed request and consume that exact snapshot once', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const request = createRequest();
    const bound = registry.bind({
      channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
      context   : CONTEXT,
      request,
      transport : 'postMessage',
    });

    request.appName = 'Tampered caller object';
    bound.request.appName = 'Tampered display copy';

    const claimed = registry.claimForApproval(CONTEXT, bound.handle);
    expect(claimed.request.appName).toBe('Private Notes');
    expect(claimed.transport).toBe('postMessage');
    expect(claimed.channel).toEqual({ dappOrigin: DAPP_ORIGIN, kind: 'popup' });
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, bound.handle), 'invalid-session');
  });

  it('should reject tampered capabilities without invalidating the authentic session', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(registry);
    const mutations: ConnectWorkerSessionHandle[] = [
      { ...handle, binding: changeFirstCharacter(handle.binding) },
      { ...handle, expiresAt: handle.expiresAt + 1 },
      { ...handle, requestDigest: changeFirstCharacter(handle.requestDigest) },
      { ...handle, workerInstanceId: 'different-worker' },
    ];

    for (const tampered of mutations) {
      expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, tampered), 'invalid-session');
    }

    expect(registry.claimForApproval(CONTEXT, handle).request.state).toBe('request-state');
  });

  it('should bind a session to the authenticated principal', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(registry);
    const otherContext = { principalId: 'lab-1/wallet-2/provider-page' };

    expectBoundaryError((): unknown => registry.claimForApproval(otherContext, handle), 'invalid-session');
    expect(registry.claimForApproval(CONTEXT, handle).request.clientDid).toBe('did:jwk:client');
  });

  it('should reject malformed boundary objects with stable errors', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(registry);

    expectBoundaryError((): unknown => registry.claimForApproval(null as never, handle), 'invalid-context');
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, null as never), 'invalid-session');
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, { ...handle, binding: 1 } as never), 'invalid-session');
    expectBoundaryError((): unknown => registry.bind(null as never), 'invalid-request');
  });

  it('should reject an oversized opened request before storing it', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const request = createRequest();
    request.appName = 'x'.repeat(CONNECT_WORKER_MAX_REQUEST_BYTES);

    expectBoundaryError((): unknown => bindPopup(registry, request), 'invalid-request');
  });

  it('should invalidate expired, cancelled, and denied sessions', () => {
    let now = 1_000;
    const registry = new ConnectWorkerSessionRegistry({ now: (): number => now, sessionTtlMs: 100 });

    const expired = bindPopup(registry);
    now = expired.expiresAt;
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, expired), 'session-expired');

    const cancelled = bindPopup(registry);
    registry.cancel(CONTEXT, cancelled);
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, cancelled), 'invalid-session');

    const denied = bindPopup(registry);
    expect(registry.deny(CONTEXT, denied)).toBe('DENIED');
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, denied), 'invalid-session');
  });

  it('should invalidate every handle when the worker stops or restarts', () => {
    const firstWorker = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(firstWorker);
    firstWorker.stop();

    expectBoundaryError((): unknown => firstWorker.claimForApproval(CONTEXT, handle), 'worker-stopped');

    const restartedWorker = new ConnectWorkerSessionRegistry();
    expectBoundaryError((): unknown => restartedWorker.claimForApproval(CONTEXT, handle), 'invalid-session');
  });

  it('should enforce a bounded pending-session set and reclaim expired capacity', () => {
    let now = 5_000;
    const registry = new ConnectWorkerSessionRegistry({
      maxPendingSessions : 1,
      now                : (): number => now,
      sessionTtlMs       : 50,
    });
    bindPopup(registry);

    expectBoundaryError((): ConnectWorkerSessionHandle => bindPopup(registry), 'capacity-exceeded');
    now += 50;
    expect(typeof bindPopup(registry).id).toBe('string');
  });

  it('should reject channel substitution and cross-origin relay callbacks', () => {
    const registry = new ConnectWorkerSessionRegistry();
    expectBoundaryError((): unknown => registry.bind({
      channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
      context   : CONTEXT,
      request   : createRequest({ mode: 'direct_post', callbackUrl: `${RELAY_ORIGIN}/connect/callback` }),
      transport : 'postMessage',
    }), 'invalid-channel');

    expectBoundaryError((): unknown => registry.bind({
      channel   : { kind: 'relay', requestUri: `${RELAY_ORIGIN}/connect/authorize/request.jwt` },
      context   : CONTEXT,
      request   : createRequest({ mode: 'direct_post', callbackUrl: 'https://attacker.example/connect/callback' }),
      transport : 'relay',
    }), 'invalid-channel');

    const spoofedOrigin = createRequest();
    spoofedOrigin.clientMetadata = { origin: 'http://localhost:19999' };
    expectBoundaryError((): unknown => registry.bind({
      channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
      context   : CONTEXT,
      request   : spoofedOrigin,
      transport : 'postMessage',
    }), 'invalid-channel');
  });

  it('should expose no arbitrary signing or key-export operation', () => {
    expect(Object.getOwnPropertyNames(ConnectWorkerBoundary.prototype).sort()).toEqual([
      'approve',
      'bindPopupRequest',
      'cancel',
      'constructor',
      'deny',
      'openRelayRequest',
      'stop',
    ]);
  });
});
