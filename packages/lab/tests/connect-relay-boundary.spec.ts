import type { ConnectRequest } from '@enbox/connect';

import { randomBytes } from 'node:crypto';

import { DidJwk } from '@enbox/dids';
import { sealRequest } from '@enbox/connect';
import { X25519 } from '@enbox/crypto';
import { describe, expect, it } from 'bun:test';

import { CONNECT_WORKER_MAX_JWE_BYTES, ConnectWorkerSessionRegistry } from '../src/proofs/connect/connect-worker-boundary.js';

const CONTEXT = { principalId: 'lab-1/wallet-1/relay-connect' };
const RELAY_ORIGIN = 'http://localhost:18445';
const REQUEST_URI = `${RELAY_ORIGIN}/connect/authorize/request.jwt`;

async function createSealedRelayRequest(requestKey: Uint8Array): Promise<{ jwe: string; request: ConnectRequest }> {
  const clientDid = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();
  const request: ConnectRequest = {
    appName             : 'Private Notes',
    clientDid           : clientDid.uri,
    nonce               : 'relay-nonce',
    permissionRequests  : [],
    reply               : { mode: 'direct_post', callbackUrl: `${RELAY_ORIGIN}/connect/callback` },
    responseKey         : { crv: 'X25519', kty: 'OKP', x: responsePrivateKey.x },
    state               : 'relay-state',
    supportedDidMethods : ['did:dht'],
  };
  const jwe = await sealRequest({
    encryption : { mode: 'dir', requestKey },
    request,
    signer     : clientDid,
  });
  return { jwe, request };
}

describe('relay connect to wallet worker boundary', () => {
  it('should open and bind a real encrypted relay request inside the worker', async () => {
    const registry = new ConnectWorkerSessionRegistry();
    const requestKey = new Uint8Array(randomBytes(32));
    const originalRequestKey = Uint8Array.from(requestKey);
    const { jwe, request } = await createSealedRelayRequest(requestKey);

    const bound = await registry.openRelayRequest({
      context    : CONTEXT,
      jwe,
      requestKey,
      requestUri : REQUEST_URI,
    });

    expect(bound.request).toEqual(request);
    expect(requestKey).toEqual(originalRequestKey);
    expect(registry.claimForApproval(CONTEXT, bound.handle)).toMatchObject({
      channel   : { kind: 'relay', requestUri: REQUEST_URI },
      transport : 'relay',
    });
  });

  it('should reject a changed ciphertext or the wrong single-use request key', async () => {
    const registry = new ConnectWorkerSessionRegistry();
    const requestKey = new Uint8Array(randomBytes(32));
    const { jwe } = await createSealedRelayRequest(requestKey);
    const changedCharacter = jwe.at(-1) === 'A' ? 'B' : 'A';
    const tamperedJwe = `${jwe.slice(0, -1)}${changedCharacter}`;

    await expect(registry.openRelayRequest({
      context    : CONTEXT,
      jwe        : tamperedJwe,
      requestKey,
      requestUri : REQUEST_URI,
    })).rejects.toThrow();
    await expect(registry.openRelayRequest({
      context    : CONTEXT,
      jwe,
      requestKey : new Uint8Array(randomBytes(32)),
      requestUri : REQUEST_URI,
    })).rejects.toThrow();
  });

  it('should reject oversized envelopes and malformed request keys before decrypting', async () => {
    const registry = new ConnectWorkerSessionRegistry();

    await expect(registry.openRelayRequest({
      context    : CONTEXT,
      jwe        : 'x'.repeat(CONNECT_WORKER_MAX_JWE_BYTES + 1),
      requestKey : new Uint8Array(32),
      requestUri : REQUEST_URI,
    })).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(registry.openRelayRequest({
      context    : CONTEXT,
      jwe        : 'sealed',
      requestKey : new Uint8Array(31),
      requestUri : REQUEST_URI,
    })).rejects.toMatchObject({ code: 'invalid-request' });
  });
});
