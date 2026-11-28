import type { Jwk } from '@enbox/crypto';
import type { RelayClientTransportOptions } from '../src/relay-transport.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import { parseWalletConnectUri } from '../src/uri.js';
import { fetchRelayRequest, pollRelayComplete, postRelayHandshake, postRelayResponse, RelayClientTransport } from '../src/relay-transport.js';

const CONNECT_SERVER_URL = 'https://relay.example/connect';
const WALLET_URI = 'https://wallet.example/connect/app';
const REQUEST_URI = 'https://relay.example/connect/authorize/8b2f.jwt';
const STATE = 'client-state-correlator';

/** Creates a transport with a no-delay sleep so polling tests run instantly. */
function createTransport(overrides: Partial<RelayClientTransportOptions> = {}): RelayClientTransport {
  return new RelayClientTransport({
    connectServerUrl : CONNECT_SERVER_URL,
    walletUri        : WALLET_URI,
    sleep            : async (): Promise<void> => {},
    ...overrides,
  });
}

describe('RelayClientTransport', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should push the sealed request via PAR and hand off a wallet uri', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.resolves(new Response(
      JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }),
      { status: 201 },
    ));

    const transport = createTransport({});
    const profile = await transport.requestProfile(STATE);

    expect(transport.requiresHandshake).toBe(true);
    expect(profile.reply).toEqual({ mode: 'direct_post', callbackUrl: `${CONNECT_SERVER_URL}/callback` });
    expect(profile.encryption.mode).toBe('dir');
    expect(profile.state).toBe(STATE);

    const handoff = await transport.deliverRequest('SEALED_REQUEST_JWE');

    const [parUrl, parInit] = fetchStub.firstCall.args;
    expect(parUrl).toBe(`${CONNECT_SERVER_URL}/par`);
    expect(parInit?.method).toBe('POST');
    expect(parInit?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(parInit?.body as string)).toEqual({ request: 'SEALED_REQUEST_JWE' });

    expect(handoff.requestUri).toBe(REQUEST_URI);
    expect(handoff.expiresIn).toBe(600);

    const parsed = parseWalletConnectUri(handoff.walletUri);
    expect(parsed).toBeDefined();
    expect(parsed!.requestUri).toBe(REQUEST_URI);
    if (profile.encryption.mode !== 'dir') { throw new Error('expected dir encryption profile'); }
    expect(parsed!.encryptionKey).toEqual(profile.encryption.requestKey);
  });

  it('should poll the token route until the wallet response arrives', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onCall(0).resolves(new Response('Not Found', { status: 404 }));
    fetchStub.onCall(1).resolves(new Response('Not Found', { status: 404 }));
    fetchStub.onCall(2).resolves(new Response('SEALED_RESPONSE_JWE', { status: 200 }));

    const sleeps: number[] = [];
    const transport = createTransport({
      sleep: async (ms: number): Promise<void> => { sleeps.push(ms); },
    });
    await transport.requestProfile(STATE);

    const response = await transport.awaitResponse();

    expect(response).toBe('SEALED_RESPONSE_JWE');
    expect(sleeps).toEqual([3000, 3000]);
    expect(fetchStub.callCount).toBe(3);
    const [tokenUrl] = fetchStub.firstCall.args;
    expect(tokenUrl).toBe(`${CONNECT_SERVER_URL}/token/${STATE}.jwt`);
  });

  it('should treat a 204 No Content (empty body) as "not ready" and keep polling', async () => {
    // Current relays answer the token poll with 204 (empty body) until the
    // wallet responds — a clean signal, not the 404 they used to return. An
    // empty 2xx must never resolve the wait; only a non-empty body does.
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onCall(0).resolves(new Response(null, { status: 204 }));
    fetchStub.onCall(1).resolves(new Response(null, { status: 204 }));
    fetchStub.onCall(2).resolves(new Response('SEALED_RESPONSE_JWE', { status: 200 }));

    const sleeps: number[] = [];
    const transport = createTransport({
      sleep: async (ms: number): Promise<void> => { sleeps.push(ms); },
    });
    await transport.requestProfile(STATE);

    const response = await transport.awaitResponse();

    expect(response).toBe('SEALED_RESPONSE_JWE');
    expect(sleeps).toEqual([3000, 3000]);
    expect(fetchStub.callCount).toBe(3);
  });

  it('should surface the DENIED token verbatim', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.resolves(new Response('DENIED', { status: 200 }));

    const transport = createTransport({});
    await transport.requestProfile(STATE);

    await expect(transport.awaitResponse()).resolves.toBe('DENIED');
  });

  it('should time out after the poll budget with an injected clock', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.resolves(new Response('Not Found', { status: 404 }));

    let clock = 0;
    const transport = createTransport({
      now   : (): number => clock,
      sleep : async (ms: number): Promise<void> => { clock += ms; },
    });
    await transport.requestProfile(STATE);

    await expect(transport.awaitResponse()).rejects.toThrow('timed out after 300000ms');
    expect(fetchStub.callCount).toBe(100); // 300 s budget / 3 s poll interval
  });

  it('should stop polling while sleeping when the session is aborted', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.resolves(new Response('Not Found', { status: 404 }));

    let sleepStarted!: () => void;
    const sleeping = new Promise<void>((resolve): void => { sleepStarted = resolve; });
    const controller = new AbortController();
    const transport = createTransport({
      signal : controller.signal,
      sleep  : async (): Promise<void> => {
        sleepStarted();
        await new Promise<void>(() => { /* pending until cancellation */ });
      },
    });
    await transport.requestProfile(STATE);

    const response = transport.awaitResponse();
    await sleeping;
    controller.abort();

    await expect(response).rejects.toHaveProperty('name', 'AbortError');
    expect(fetchStub.callCount).toBe(1);
  });

  it('should abort an in-flight relay request with the session signal', async () => {
    const controller = new AbortController();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve): void => { requestStarted = resolve; });
    const fetchFn = sinon.stub().callsFake(async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      requestStarted();
      return await new Promise<Response>((_resolve, reject): void => {
        init?.signal?.addEventListener('abort', (): void => { reject(init.signal?.reason); }, { once: true });
      });
    });
    const transport = createTransport({ fetchFn, signal: controller.signal });
    await transport.requestProfile(STATE);

    const response = transport.awaitResponse();
    await started;
    controller.abort();

    await expect(response).rejects.toHaveProperty('name', 'AbortError');
    expect(fetchFn.callCount).toBe(1);
  });

  it('should throw when deliverRequest is called before requestProfile', async () => {
    const transport = createTransport({});

    await expect(transport.deliverRequest('SEALED_REQUEST_JWE'))
      .rejects.toThrow('call `requestProfile()` before `deliverRequest()`');
  });

  it('reports claimed once via onClaimed while polling for the response', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    // PAR
    fetchStub.onCall(0).resolves(new Response(
      JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }),
      { status: 201 },
    ));
    // iter 1: token 404 → status not yet claimed
    fetchStub.onCall(1).resolves(new Response('Not Found', { status: 404 }));
    fetchStub.onCall(2).resolves(new Response(JSON.stringify({ claimed: false }), { status: 200 }));
    // iter 2: token 404 → status claimed
    fetchStub.onCall(3).resolves(new Response('Not Found', { status: 404 }));
    fetchStub.onCall(4).resolves(new Response(JSON.stringify({ claimed: true }), { status: 200 }));
    // iter 3: token 404, no further status polling
    fetchStub.onCall(5).resolves(new Response('Not Found', { status: 404 }));
    // iter 4: token 200
    fetchStub.onCall(6).resolves(new Response('SEALED_RESPONSE_JWE', { status: 200 }));

    const claims: number[] = [];
    const transport = createTransport({
      sleep     : async (): Promise<void> => {},
      onClaimed : (): void => { claims.push(1); },
    });
    await transport.requestProfile(STATE);
    await transport.deliverRequest('SEALED_REQUEST_JWE');

    const response = await transport.awaitResponse();

    expect(response).toBe('SEALED_RESPONSE_JWE');
    expect(claims).toEqual([1]);
    expect(fetchStub.callCount).toBe(7);
    expect(fetchStub.getCall(2).args[0]).toBe(`${CONNECT_SERVER_URL}/status/8b2f`);
    expect(fetchStub.getCall(4).args[0]).toBe(`${CONNECT_SERVER_URL}/status/8b2f`);
  });

  it('does not poll the status route when onClaimed is not provided', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onCall(0).resolves(new Response(
      JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }),
      { status: 201 },
    ));
    fetchStub.onCall(1).resolves(new Response('Not Found', { status: 404 }));
    fetchStub.onCall(2).resolves(new Response('SEALED_RESPONSE_JWE', { status: 200 }));

    const transport = createTransport({ sleep: async (): Promise<void> => {} });
    await transport.requestProfile(STATE);
    await transport.deliverRequest('SEALED_REQUEST_JWE');

    await transport.awaitResponse();

    expect(fetchStub.callCount).toBe(3);
    for (const call of fetchStub.getCalls().slice(1)) {
      expect(String(call.args[0])).not.toContain('/status/');
    }
  });

  const TEST_WALLET_EPK: Jwk = { kty: 'OKP', crv: 'X25519', x: 'ZakEQ3d82ak4Vawhuarto4jHVubZwVBUz6fJXP9xIk8' };

  function stubRelayPoll(handlers: {
    onHandshake?: (call: number) => Response | Promise<Response>;
    onToken?: (call: number) => Response | Promise<Response>;
  }): { fetchFn: sinon.SinonStub; counts: { handshake: number; token: number } } {
    const counts = { handshake: 0, token: 0 };
    const fetchFn = sinon.stub().callsFake(async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/handshake/') && handlers.onHandshake !== undefined) {
        counts.handshake += 1;
        return handlers.onHandshake(counts.handshake);
      }
      if (url.includes('/token/') && handlers.onToken !== undefined) {
        counts.token += 1;
        return handlers.onToken(counts.token);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    return { fetchFn, counts };
  }

  it('polls handshake once until walletEpk arrives and invokes onHandshake before returning token', async () => {
    const { fetchFn, counts } = stubRelayPoll({
      onHandshake: (n): Response => new Response(
        JSON.stringify(n === 1 ? { ready: false } : { ready: true, walletEpk: TEST_WALLET_EPK }),
        { status: 200 },
      ),
      onToken: (n): Response => n < 3
        ? new Response(null, { status: 204 })
        : new Response('SEALED_RESPONSE_JWE', { status: 200 }),
    });

    const receivedKeys: Jwk[] = [];
    const transport = createTransport({ fetchFn });
    await transport.requestProfile(STATE);

    const response = await transport.awaitResponse({ onHandshake: (key): void => { receivedKeys.push(key); } });

    expect(response).toBe('SEALED_RESPONSE_JWE');
    expect(receivedKeys).toEqual([TEST_WALLET_EPK]);
    expect(counts).toEqual({ handshake: 2, token: 3 });
  });

  it('performs a final handshake check when token arrives before handshake was observed', async () => {
    const { fetchFn, counts } = stubRelayPoll({
      onHandshake: (n): Response => new Response(
        JSON.stringify(n === 1 ? { ready: false } : { ready: true, walletEpk: TEST_WALLET_EPK }),
        { status: 200 },
      ),
      onToken: (): Response => new Response('SEALED_RESPONSE_JWE', { status: 200 }),
    });

    const receivedKeys: Jwk[] = [];
    const transport = createTransport({ fetchFn });
    await transport.requestProfile(STATE);

    const response = await transport.awaitResponse({ onHandshake: (key): void => { receivedKeys.push(key); } });

    expect(response).toBe('SEALED_RESPONSE_JWE');
    expect(receivedKeys).toEqual([TEST_WALLET_EPK]);
    expect(counts.handshake).toBe(2);
  });

  it('fast-fails on 404 or private-key handshake payload and retries transient network errors', async () => {
    const unsupported = stubRelayPoll({
      onHandshake: (): Response => new Response('Not Found', { status: 404 }),
    });
    const unsupportedTransport = createTransport({ fetchFn: unsupported.fetchFn });
    await unsupportedTransport.requestProfile(STATE);
    await expect(unsupportedTransport.awaitResponse({ onHandshake: (): void => {} }))
      .rejects.toThrow('does not support the pre-approval SAS handshake route');
    expect(unsupported.counts.handshake).toBe(1);

    const badKey = stubRelayPoll({
      onHandshake: (): Response => new Response(
        JSON.stringify({ ready: true, walletEpk: { ...TEST_WALLET_EPK, d: 'vxvvbso9-Eo1mJZR_oCc6hIoh72EmWKBc0i_21c5LwQ' } }),
        { status: 200 },
      ),
    });
    const badKeyTransport = createTransport({ fetchFn: badKey.fetchFn });
    await badKeyTransport.requestProfile(STATE);
    await expect(badKeyTransport.awaitResponse({ onHandshake: (): void => {} }))
      .rejects.toThrow('X25519 public JWK');

    const transient = stubRelayPoll({
      onHandshake: (n): Response => {
        if (n === 1) { throw new TypeError('Failed to fetch'); }
        return new Response(JSON.stringify({ ready: true, walletEpk: TEST_WALLET_EPK }), { status: 200 });
      },
      onToken: (n): Response => {
        if (n === 1) { throw new TypeError('Failed to fetch'); }
        return new Response('SEALED_RESPONSE_JWE', { status: 200 });
      },
    });
    const receivedKeys: Jwk[] = [];
    const retryTransport = createTransport({ fetchFn: transient.fetchFn });
    await retryTransport.requestProfile(STATE);

    const response = await retryTransport.awaitResponse({ onHandshake: (key): void => { receivedKeys.push(key); } });
    expect(response).toBe('SEALED_RESPONSE_JWE');
    expect(receivedKeys).toEqual([TEST_WALLET_EPK]);
    expect(transient.counts).toEqual({ handshake: 2, token: 2 });
  });

  it('should POST the completion marker keyed by state via confirmComplete', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    // PAR
    fetchStub.onCall(0).resolves(new Response(
      JSON.stringify({ request_uri: REQUEST_URI, expires_in: 600 }),
      { status: 201 },
    ));
    // Completion marker
    fetchStub.onCall(1).resolves(new Response(
      JSON.stringify({ ok: true, status: { code: 201, message: 'Created' } }),
      { status: 201 },
    ));

    const transport = createTransport({});
    await transport.requestProfile(STATE);
    await transport.deliverRequest('SEALED_REQUEST_JWE');

    await transport.confirmComplete();

    const [completeUrl, completeInit] = fetchStub.secondCall.args;
    expect(completeUrl).toBe(`${CONNECT_SERVER_URL}/complete`);
    expect(completeInit?.method).toBe('POST');
    expect(completeInit?.keepalive).toBe(true);
    expect(JSON.parse(completeInit?.body as string)).toEqual({ state: STATE });
  });

  it('should throw from confirmComplete when the relay lacks the completion route', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.resolves(new Response('Not Found', { status: 404 }));

    const transport = createTransport({});
    await transport.requestProfile(STATE);

    await expect(transport.confirmComplete()).rejects.toThrow('completion signal failed with HTTP 404');
  });

  it('should throw when confirmComplete is called before requestProfile', async () => {
    const transport = createTransport({});

    await expect(transport.confirmComplete())
      .rejects.toThrow('call `requestProfile()` before `confirmComplete()`');
  });

  it('should throw when awaitResponse is called before requestProfile', async () => {
    const transport = createTransport({});

    await expect(transport.awaitResponse())
      .rejects.toThrow('call `requestProfile()` before `awaitResponse()`');
  });

  it('should throw when the PAR push fails', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.resolves(new Response('Server Error', { status: 500 }));

    const transport = createTransport({});
    await transport.requestProfile(STATE);

    await expect(transport.deliverRequest('SEALED_REQUEST_JWE')).rejects.toThrow('HTTP 500');
  });

  it('should throw when the PAR response is malformed', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.resolves(new Response(JSON.stringify({}), { status: 201 }));

    const transport = createTransport({});
    await transport.requestProfile(STATE);

    await expect(transport.deliverRequest('SEALED_REQUEST_JWE'))
      .rejects.toThrow('missing `request_uri` or `expires_in`');
  });

  describe('wallet-side helpers', () => {
    it('fetchRelayRequest should return the sealed request body', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response('SEALED_REQUEST_JWE', { status: 200 }));

      const jwe = await fetchRelayRequest({ requestUri: REQUEST_URI });

      expect(jwe).toBe('SEALED_REQUEST_JWE');
      const [url] = fetchStub.firstCall.args;
      expect(url).toBe(REQUEST_URI);
    });

    it('fetchRelayRequest should throw when the single-use pointer is consumed', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response('Not Found', { status: 404 }));

      await expect(fetchRelayRequest({ requestUri: REQUEST_URI }))
        .rejects.toThrow('single-use');
    });

    it('postRelayResponse should POST a form-encoded id_token and state', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      await postRelayResponse({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : 'abc123',
        idToken     : 'SEALED_RESPONSE_JWE',
      });

      const [url, init] = fetchStub.firstCall.args;
      expect(url).toBe(`${CONNECT_SERVER_URL}/callback`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
      const params = new URLSearchParams(init?.body as string);
      expect(params.get('id_token')).toBe('SEALED_RESPONSE_JWE');
      expect(params.get('state')).toBe('abc123');
    });

    it('pollRelayComplete should poll the marker derived from the callback URL until completed', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onCall(0).resolves(new Response(JSON.stringify({ completed: false }), { status: 200 }));
      fetchStub.onCall(1).resolves(new Response(JSON.stringify({ completed: true }), { status: 200 }));

      const sleeps: number[] = [];
      const completed = await pollRelayComplete({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : STATE,
        sleep       : async (ms: number): Promise<void> => { sleeps.push(ms); },
      });

      expect(completed).toBe(true);
      expect(sleeps).toEqual([1000]);
      const [completeUrl] = fetchStub.firstCall.args;
      expect(completeUrl).toBe(`${CONNECT_SERVER_URL}/complete/${STATE}`);
    });

    it('pollRelayComplete should short-circuit to false on relays without the route', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response('Not Found', { status: 404 }));

      const completed = await pollRelayComplete({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : STATE,
        sleep       : async (): Promise<void> => { throw new Error('test: must not poll again after a 404'); },
      });

      expect(completed).toBe(false);
      expect(fetchStub.callCount).toBe(1);
    });

    it('pollRelayComplete should return false when the budget lapses without the marker', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response(JSON.stringify({ completed: false }), { status: 200 }));

      let clock = 0;
      const completed = await pollRelayComplete({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : STATE,
        timeoutMs   : 3_000,
        now         : (): number => clock,
        sleep       : async (ms: number): Promise<void> => { clock += ms; },
      });

      expect(completed).toBe(false);
      expect(fetchStub.callCount).toBe(3); // 3 s budget / 1 s poll interval
    });

    it('postRelayResponse should throw on a non-OK status', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response('Bad Request', { status: 400 }));

      await expect(postRelayResponse({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : 'abc123',
        idToken     : 'DENIED',
      })).rejects.toThrow('callback POST failed with HTTP 400');
    });

    it('postRelayHandshake should POST state and public walletEpk to /handshake', async () => {
      const walletEpk: Jwk = { kty: 'OKP', crv: 'X25519', x: 'ZakEQ3d82ak4Vawhuarto4jHVubZwVBUz6fJXP9xIk8' };
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response(JSON.stringify({ ok: true }), { status: 201 }));

      await postRelayHandshake({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : 'abc123',
        walletEpk,
      });

      const [url, init] = fetchStub.firstCall.args;
      expect(url).toBe(`${CONNECT_SERVER_URL}/handshake`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init?.body as string)).toEqual({ state: 'abc123', walletEpk });
    });

    it('postRelayHandshake should reject private keys and non-OK relay responses', async () => {
      await expect(postRelayHandshake({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : 'abc123',
        walletEpk   : { kty: 'OKP', crv: 'X25519', x: 'abc', d: 'secret' },
      })).rejects.toThrow('X25519 public JWK');

      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.resolves(new Response('Conflict', { status: 409 }));

      await expect(postRelayHandshake({
        callbackUrl : `${CONNECT_SERVER_URL}/callback`,
        state       : 'abc123',
        walletEpk   : { kty: 'OKP', crv: 'X25519', x: 'ZakEQ3d82ak4Vawhuarto4jHVubZwVBUz6fJXP9xIk8' },
      })).rejects.toThrow('handshake POST failed with HTTP 409');
    });
  });
});
