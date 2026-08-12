import type { ConnectPermissionRequest } from '../src/types.js';
import type { DataEncodedRecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { FetchFn } from '../src/relay-transport.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { DidJwk } from '@enbox/dids';

import { ConnectClientSession, ConnectProviderSession } from '../src/pairing-session.js';
import { RelayPairingClientTransport, RelayPairingWalletTransport } from '../src/relay-pairing-transport.js';

const RELAY_ORIGIN = 'https://relay.example';
const WALLET_ORIGIN = 'https://wallet.example';
const PAIRING_ID = '123e4567-e89b-42d3-a456-426614174000';
const PAIRING_URI = `${RELAY_ORIGIN}/connect/v3/pairings/${PAIRING_ID}`;
const CLIENT_CAPABILITY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const COMMITMENT = 'dHsifoINpJTsDquTwQTeVZPHPTCykyEs2rVUJ8acBzw';
const TEST_PERMISSION_REQUESTS: ConnectPermissionRequest[] = [{
  protocolDefinition: {
    protocol  : 'https://example.com/notes',
    published : true,
    types     : {},
    structure : {},
  },
  permissionScopes: [{
    interface : 'Records',
    method    : 'Read',
    protocol  : 'https://example.com/notes',
  }],
}];
const TEST_GRANTS = [{ recordId: 'grant-1' }] as unknown as DataEncodedRecordsWriteMessage[];
const TEST_REVOCATIONS = [{ grantId: 'grant-1', revocationGrantId: 'revocation-1' }];

type MockRelay = {
  fetchFn: FetchFn;
  requests: Array<{ init?: RequestInit; url: string }>;
};

function createMockRelay(): MockRelay {
  const requests: MockRelay['requests'] = [];
  const reveals = new Map<string, Record<string, string>>();
  const frames = new Map<string, Record<string, string>>();
  let clientCommitment = '';
  let walletCommitment = '';
  let walletCapability = '';

  const fetchFn: FetchFn = async (input, init): Promise<Response> => {
    const url = new URL(input);
    requests.push({ init, url: url.toString() });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, string> : undefined;

    if (url.pathname === '/connect/v3/pairings' && init?.method === 'POST') {
      clientCommitment = body!.client_key_commitment;
      return Response.json({
        client_capability : CLIENT_CAPABILITY,
        expires_in        : 600,
        interval          : 2,
        pair_uri          : PAIRING_URI,
        pairing_id        : PAIRING_ID,
        relay_origin      : RELAY_ORIGIN,
        version           : '3',
      }, { status: 201 });
    }

    if (url.pathname === `${new URL(PAIRING_URI).pathname}/claim` && init?.method === 'POST') {
      walletCommitment = body!.wallet_key_commitment;
      walletCapability = body!.wallet_capability;
      return Response.json({
        client_key_commitment : clientCommitment,
        relay_origin          : RELAY_ORIGIN,
        version               : '3',
        wallet_origin         : WALLET_ORIGIN,
      }, { status: 201 });
    }

    const revealMatch = /^\/connect\/v3\/pairings\/[^/]+\/reveals\/(client|wallet)$/.exec(url.pathname);
    const frameMatch = /^\/connect\/v3\/pairings\/[^/]+\/(client|wallet)$/.exec(url.pathname);
    const direction = revealMatch?.[1] ?? frameMatch?.[1];
    const expectedCapability = init?.method === 'PUT'
      ? direction === 'client' ? CLIENT_CAPABILITY : walletCapability
      : direction === 'client' ? walletCapability : CLIENT_CAPABILITY;
    if (direction !== undefined && new Headers(init?.headers).get('Authorization') !== `Bearer ${expectedCapability}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    if (url.pathname.endsWith('/claim') && init?.method === 'GET') {
      if (new Headers(init.headers).get('Authorization') !== `Bearer ${CLIENT_CAPABILITY}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({
        relay_origin          : RELAY_ORIGIN,
        version               : '3',
        wallet_key_commitment : walletCommitment,
        wallet_origin         : WALLET_ORIGIN,
      });
    }

    if (revealMatch !== null && init?.method === 'PUT') {
      reveals.set(revealMatch[1], body!);
      return new Response(null, { status: 204 });
    }
    if (revealMatch !== null && init?.method === 'GET') {
      const reveal = reveals.get(revealMatch[1]);
      if (reveal === undefined) {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        key_commitment : revealMatch[1] === 'client' ? clientCommitment : walletCommitment,
        nonce          : reveal.nonce,
        public_key     : reveal.public_key,
        relay_origin   : RELAY_ORIGIN,
        version        : '3',
        wallet_origin  : WALLET_ORIGIN,
      });
    }

    if (frameMatch !== null && init?.method === 'PUT') {
      frames.set(`${frameMatch[1]}:${body!.stage}`, body!);
      return new Response(null, { status: 204 });
    }
    if (frameMatch !== null && init?.method === 'GET') {
      const stage = url.searchParams.get('stage');
      const frame = frames.get(`${frameMatch[1]}:${stage}`);
      return frame === undefined ? new Response(null, { status: 204 }) : Response.json(frame);
    }

    return Response.json({ error: 'not-found' }, { status: 404 });
  };

  return { fetchFn, requests };
}

function pairingCreation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_capability : CLIENT_CAPABILITY,
    expires_in        : 600,
    interval          : 2,
    pair_uri          : PAIRING_URI,
    pairing_id        : PAIRING_ID,
    relay_origin      : RELAY_ORIGIN,
    version           : '3',
    ...overrides,
  };
}

describe('RelayPairing transports', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should carry a complete client and wallet session in protocol order', async () => {
    const relay = createMockRelay();
    const clientSession = await ConnectClientSession.create({ delegate: await DidJwk.create() });
    const client = await RelayPairingClientTransport.create({
      clientCommitment : clientSession.clientCommitment,
      relayOrigin      : RELAY_ORIGIN,
      fetchFn          : relay.fetchFn,
      sleep            : async (): Promise<void> => {},
    });
    expect(client.pairingUri).toBe(PAIRING_URI);
    expect(client.expiresInSeconds).toBe(600);

    const providerSession = await ConnectProviderSession.create({ walletSigner: await DidJwk.create() });
    const wallet = await RelayPairingWalletTransport.claim({
      pairingUri       : client.pairingUri,
      walletCommitment : providerSession.walletCommitment,
      walletOrigin     : WALLET_ORIGIN,
      fetchFn          : relay.fetchFn,
      sleep            : async (): Promise<void> => {},
    });
    providerSession.acceptRelayClaim({
      pairingId        : wallet.pairingId,
      relayOrigin      : wallet.relayOrigin,
      walletOrigin     : wallet.walletOrigin,
      clientCommitment : wallet.clientCommitment,
    });

    clientSession.acceptWalletCommitment(await client.awaitWalletClaim());
    await client.publishClientReveal(clientSession.revealClient());
    await providerSession.acceptClientReveal(await wallet.awaitClientReveal());
    await wallet.publishWalletReveal(await providerSession.revealWallet());
    await clientSession.acceptWalletReveal(await client.awaitWalletReveal());

    await client.sendRequest(await clientSession.sealRequest({
      appName: 'Notes', permissionRequests: TEST_PERMISSION_REQUESTS, nonce: 'nonce', state: 'state',
    }));
    const request = await providerSession.openRequest(await wallet.awaitRequest());
    const providerDecision = await providerSession.sealApprovalIntent({
      providerDid  : 'did:dht:profile',
      localMatches : true,
    });
    await wallet.sendDecision(providerDecision.frame);
    const clientDecision = await clientSession.openDecision(await client.awaitDecision());
    if (clientDecision.decision.decision !== 'approve') {
      throw new Error('Expected an approval intent.');
    }
    expect(clientSession.verificationCode).toBe(providerSession.verificationCode);

    await client.sendConfirmation(await clientSession.createConfirmation(true));
    const responseFrame = await providerSession.confirmAndSealResponse({
      confirmationFrame : await wallet.awaitConfirmation(),
      approve           : async () => ({
        delegateDid        : request.delegateDid,
        delegateGrants     : TEST_GRANTS,
        sessionRevocations : TEST_REVOCATIONS,
      }),
    });
    if (responseFrame === undefined) {
      throw new Error('Expected an approved response frame.');
    }
    await wallet.sendResponse(responseFrame);
    await clientSession.openApprovedResponse(await client.awaitResponse());

    expect(clientSession.state).toBe('response-opened');
    expect(providerSession.state).toBe('response-sealed');
    expect(relay.requests).toHaveLength(15);
  });

  it('should send role capabilities only in authorization headers', async () => {
    const relay = createMockRelay();
    const client = await RelayPairingClientTransport.create({
      clientCommitment : COMMITMENT,
      relayOrigin      : RELAY_ORIGIN,
      fetchFn          : relay.fetchFn,
    });
    const wallet = await RelayPairingWalletTransport.claim({
      pairingUri       : client.pairingUri,
      walletCommitment : COMMITMENT,
      walletOrigin     : WALLET_ORIGIN,
      fetchFn          : relay.fetchFn,
    });
    await client.awaitWalletClaim();

    const request = relay.requests[2];
    const claimBody = JSON.parse(String(relay.requests[1].init?.body)) as { wallet_capability: string };
    expect(new Headers(request.init?.headers).get('Authorization')).toBe(`Bearer ${CLIENT_CAPABILITY}`);
    expect(request.url).not.toContain(CLIENT_CAPABILITY);
    expect(request.init?.body).toBeUndefined();
    expect(JSON.stringify(client)).not.toContain(CLIENT_CAPABILITY);
    expect(JSON.stringify(wallet)).not.toContain(claimBody.wallet_capability);
    expect(request.init?.credentials).toBe('omit');
    expect(request.init?.cache).toBe('no-store');
    expect(request.init?.redirect).toBe('error');
  });

  it('should reuse the same wallet capability after a lost claim response', async () => {
    const bodies: string[] = [];
    let now = 0;
    const fetchFn: FetchFn = async (_input, init): Promise<Response> => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        return new Response(new ReadableStream({
          start(controller): void { controller.error(new TypeError('response body lost')); },
        }), {
          status  : 201,
          headers : { 'Content-Type': 'application/json' },
        });
      }
      return Response.json({
        client_key_commitment : COMMITMENT,
        relay_origin          : RELAY_ORIGIN,
        version               : '3',
        wallet_origin         : WALLET_ORIGIN,
      }, { status: 201 });
    };

    const wallet = await RelayPairingWalletTransport.claim({
      pairingUri       : PAIRING_URI,
      walletCommitment : COMMITMENT,
      walletOrigin     : WALLET_ORIGIN,
      fetchFn,
      now              : (): number => now,
      pollIntervalMs   : 1,
      pollTimeoutMs    : 5000,
      sleep            : async (milliseconds): Promise<void> => { now += milliseconds; },
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    const claim = JSON.parse(bodies[0]) as { wallet_capability: string };
    expect(claim.wallet_capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(wallet)).not.toContain(claim.wallet_capability);
  });

  it('should retry an immutable frame read after a lost response', async () => {
    const relay = createMockRelay();
    let dropped = false;
    let requestReads = 0;
    const fetchFn: FetchFn = async (input, init): Promise<Response> => {
      const response = await relay.fetchFn(input, init);
      const url = new URL(input);
      if (init?.method === 'GET' && url.pathname.endsWith('/client') && url.searchParams.get('stage') === 'request') {
        requestReads++;
        if (!dropped) {
          dropped = true;
          await response.body?.cancel();
          return new Response(new ReadableStream({
            start(controller): void { controller.error(new TypeError('response body lost')); },
          }), {
            status  : 200,
            headers : { 'Content-Type': 'application/json' },
          });
        }
      }
      return response;
    };
    const client = await RelayPairingClientTransport.create({
      clientCommitment : COMMITMENT,
      relayOrigin      : RELAY_ORIGIN,
      fetchFn,
      pollIntervalMs   : 1,
      sleep            : async (): Promise<void> => {},
    });
    const wallet = await RelayPairingWalletTransport.claim({
      pairingUri       : client.pairingUri,
      walletCommitment : COMMITMENT,
      walletOrigin     : WALLET_ORIGIN,
      fetchFn,
      pollIntervalMs   : 1,
      sleep            : async (): Promise<void> => {},
    });
    await client.sendRequest('opaque-request');

    expect(await wallet.awaitRequest()).toBe('opaque-request');
    expect(requestReads).toBe(2);
  });

  it('should retry immutable reveal and frame writes after lost responses', async () => {
    const relay = createMockRelay();
    const revealBodies: string[] = [];
    const frameBodies: string[] = [];
    const fetchFn: FetchFn = async (input, init): Promise<Response> => {
      const response = await relay.fetchFn(input, init);
      const url = new URL(input);
      if (init?.method === 'PUT' && url.pathname.endsWith('/reveals/client')) {
        revealBodies.push(String(init.body));
        if (revealBodies.length === 1) {
          throw new TypeError('reveal response lost');
        }
      }
      if (init?.method === 'PUT' && url.pathname.endsWith('/client') && !url.pathname.includes('/reveals/')) {
        frameBodies.push(String(init.body));
        if (frameBodies.length === 1) {
          throw new TypeError('frame response lost');
        }
      }
      return response;
    };
    const client = await RelayPairingClientTransport.create({
      clientCommitment : COMMITMENT,
      relayOrigin      : RELAY_ORIGIN,
      fetchFn,
      pollIntervalMs   : 1,
      sleep            : async (): Promise<void> => {},
    });
    await RelayPairingWalletTransport.claim({
      pairingUri       : client.pairingUri,
      walletCommitment : COMMITMENT,
      walletOrigin     : WALLET_ORIGIN,
      fetchFn,
      pollIntervalMs   : 1,
      sleep            : async (): Promise<void> => {},
    });

    await client.publishClientReveal({
      publicKey : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      nonce     : '__________________________________________8',
    });
    await client.sendRequest('opaque-request');

    expect(revealBodies).toHaveLength(2);
    expect(revealBodies[1]).toBe(revealBodies[0]);
    expect(frameBodies).toHaveLength(2);
    expect(frameBodies[1]).toBe(frameBodies[0]);
  });

  it('should reject response fields not in the exact wire schema', async () => {
    const fetchFn = sinon.stub();
    fetchFn.resolves(Response.json(pairingCreation({ unexpected: true }), { status: 201 }));

    await expect(RelayPairingClientTransport.create({
      clientCommitment : COMMITMENT,
      relayOrigin      : RELAY_ORIGIN,
      fetchFn,
    })).rejects.toThrow('invalid pairing creation response');
  });

  it('should time out pending polls within the caller budget', async () => {
    const fetchFn = sinon.stub();
    fetchFn.onCall(0).resolves(Response.json(pairingCreation(), { status: 201 }));
    fetchFn.resolves(new Response(null, { status: 204 }));
    let clock = 0;
    const client = await RelayPairingClientTransport.create({
      clientCommitment : COMMITMENT,
      relayOrigin      : RELAY_ORIGIN,
      fetchFn,
      now              : (): number => clock,
      pollIntervalMs   : 5,
      pollTimeoutMs    : 10,
      sleep            : async (ms): Promise<void> => { clock += ms; },
    });

    await expect(client.awaitWalletClaim()).rejects.toThrow('timed out after 10ms');
    expect(fetchFn.callCount).toBe(2);
  });

  it('should abort while waiting between pending polls', async () => {
    const fetchFn = sinon.stub();
    fetchFn.onCall(0).resolves(Response.json(pairingCreation(), { status: 201 }));
    fetchFn.resolves(new Response(null, { status: 204 }));
    const controller = new AbortController();
    let sleepStarted!: () => void;
    const sleeping = new Promise<void>((resolve): void => { sleepStarted = resolve; });
    const client = await RelayPairingClientTransport.create({
      clientCommitment : COMMITMENT,
      relayOrigin      : RELAY_ORIGIN,
      fetchFn,
      signal           : controller.signal,
      sleep            : async (): Promise<void> => {
        sleepStarted();
        await new Promise<void>(() => { /* interrupted by the signal */ });
      },
    });

    const claim = client.awaitWalletClaim();
    await sleeping;
    controller.abort();

    await expect(claim).rejects.toHaveProperty('name', 'AbortError');
    expect(fetchFn.callCount).toBe(2);
  });

  it('should reject pairing locators that carry extra URL data', async () => {
    await expect(RelayPairingWalletTransport.claim({
      pairingUri       : `${PAIRING_URI}?capability=${CLIENT_CAPABILITY}`,
      walletCommitment : COMMITMENT,
      walletOrigin     : WALLET_ORIGIN,
    })).rejects.toThrow('pairing URI must be a public relay URL');
  });
});
