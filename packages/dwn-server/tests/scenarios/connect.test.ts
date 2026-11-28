import { randomUUID } from 'node:crypto';

import { config } from '../../src/config.js';
import { ConnectServer } from '../../src/connect/connect-server.js';
import { DwnServer } from '../../src/dwn-server.js';
import { Poller } from '@enbox/dwn-sdk-js';
import sinon from 'sinon';
import { useFakeTimers } from 'sinon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

describe('Connect scenarios', () => {
  let connectBaseUrl: string;

  let clock: sinon.SinonFakeTimers;
  let dwnServer: DwnServer;
  const dwnServerConfig = { ...config, port: 0 }; // not touching the original config

  beforeAll(async () => {
    // NOTE: using SQL to workaround an issue where multiple instances of DwnServer cannot be started using LevelDB in the same test run,
    // and dwn-server.spec.ts already uses LevelDB.
    dwnServerConfig.messageStore = 'sqlite://';
    dwnServerConfig.dataStore = 'sqlite://';
    dwnServerConfig.resumableTaskStore = 'sqlite://';

    dwnServer = new DwnServer({ config: dwnServerConfig });
  });

  afterAll(async () => {
    if (dwnServer !== undefined) {
      await dwnServer.stop();
    }
  });

  beforeEach(async () => {
    sinon.restore(); // wipe all previous stubs/spies/mocks/fakes/clock

    // IMPORTANT: MUST be called AFTER `sinon.restore()` because `sinon.restore()` resets fake timers
    clock = useFakeTimers({ shouldAdvanceTime: true });
    await dwnServer.start();
    connectBaseUrl = `http://localhost:${dwnServer.httpServer.port}`;
  });

  afterEach(async () => {
    clock.restore();
    await dwnServer.stop();
  });

  it('should be able to set and get Connect Request & Response objects', async () => {
    // Scenario:
    // 1. App sends the Connect Request object to the Connect server.
    // 2. Identity Provider (wallet) fetches the Connect Request object from the Connect server.
    // 3. Should receive 404 if fetching the same Connect Request again
    // 4. Identity Provider (wallet) should receive 400 if sending an incomplete response.
    // 5. Identity Provider (wallet) sends the Connect Response object to the Connect server.
    // 6. App fetches the Connect Response object from the Connect server.
    // 7. Should receive 204 (not ready / already consumed) if fetching the same Connect Response object again.

    // 1. App sends the Connect Request object to the Connect server.
    const requestBody = { request: { dummyProperty: 'dummyValue' } };
    const postConnectRequestResult = await fetch(`${connectBaseUrl}/connect/par`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(requestBody),
    });
    expect(postConnectRequestResult.status).toBe(201);

    // 2. Identity Provider (wallet) fetches the Connect Request object from the Connect server.
    const rawRequestUrl = (await postConnectRequestResult.json() as any).request_uri;
    const regex = /^http:\/\/localhost:\d+\/connect\/authorize\/[a-zA-Z0-9-]{21,}\.jwt$/;
    expect(rawRequestUrl).toMatch(regex);

    // Replace the port in the returned URL with the actual server port (baseUrl uses config.baseUrl).
    const requestUrl = rawRequestUrl.replace(/localhost:\d+/, `localhost:${dwnServer.httpServer.port}`);

    let getConnectRequestResult;
    await Poller.pollUntilSuccessOrTimeout(async () => {
      console.log('Polling for Connect Request object...');
      getConnectRequestResult = await fetch(requestUrl, { method: 'GET' });
      expect(getConnectRequestResult.status).toBe(200);
    });

    const fetchedRequest = await getConnectRequestResult.json();
    expect(fetchedRequest).toEqual(requestBody.request);

    // 3. Should receive 404 if fetching the same Connect Request again
    await Poller.pollUntilSuccessOrTimeout(async () => {
      const getConnectRequestResult2 = await fetch(requestUrl, { method: 'GET' });
      expect(getConnectRequestResult2.status).toBe(404);
    });

    // 4. Identity Provider (wallet) should receive 400 if sending an incomplete response.
    const incompleteResponseBody = {
      id_token: { dummyToken: 'dummyToken' },
      // state    : 'dummyState', // intentionally missing
    };
    const postIncompleteConnectResponseResult = await fetch(`${connectBaseUrl}/connect/callback`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(incompleteResponseBody),
    });
    expect(postIncompleteConnectResponseResult.status).toBe(400);

    const state = `dummyState-${randomUUID()}`;
    // 5. Identity Provider (wallet) sends the Connect Response object to the Connect server.
    const connectResponseBody = {
      id_token: { dummyToken: 'dummyToken' },
      state
    };
    const postConnectResponseResult = await fetch(`${connectBaseUrl}/connect/callback`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(connectResponseBody),
    });
    expect(postConnectResponseResult.status).toBe(201);

    // 6. App fetches the Connect Response object from the Connect server.
    const connectResponseUrl = `${connectBaseUrl}/connect/token/${connectResponseBody.state}.jwt`;

    let getConnectResponseResult;
    await Poller.pollUntilSuccessOrTimeout(async () => {
      getConnectResponseResult = await fetch(connectResponseUrl, { method: 'GET' });
      expect(getConnectResponseResult.status).toBe(200);
    });

    const fetchedResponse = await getConnectResponseResult.json();
    expect(fetchedResponse).toEqual(connectResponseBody.id_token);

    // 7. Should receive 204 if fetching the same Connect Response object again.
    // The token is single-use; once consumed the route reads the same as "not
    // posted yet" — a clean 204 No Content, never a 404.
    await Poller.pollUntilSuccessOrTimeout(async () => {
      const getConnectResponseResult2 = await fetch(connectResponseUrl, { method: 'GET' });
      expect(getConnectResponseResult2.status).toBe(204);
    });
  });

  it('serves the token route as 204→200→204 across the response lifecycle (never 404)', async () => {
    // The requesting app long-polls GET /connect/token/{state}.jwt. Across the
    // whole lifecycle it must never see a 404: "not ready yet" and "already
    // consumed" both read as a clean 204 No Content (empty body), and only the
    // window where the wallet's response is posted returns 200 with the token.
    const state = `lifecycle-${randomUUID()}`;
    const tokenUrl = `${connectBaseUrl}/connect/token/${state}.jwt`;

    // 1. Pending — the wallet has not posted anything yet: 204, empty body.
    const pending = await fetch(tokenUrl, { method: 'GET' });
    expect(pending.status).toBe(204);
    expect(await pending.text()).toBe('');

    // 2. Wallet posts the response.
    const idToken = { dummyToken: 'dummyToken' };
    const postResult = await fetch(`${connectBaseUrl}/connect/callback`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ id_token: idToken, state }),
    });
    expect(postResult.status).toBe(201);

    // 3. Ready — the app fetches the posted token: 200 with the token body.
    let ready;
    await Poller.pollUntilSuccessOrTimeout(async () => {
      ready = await fetch(tokenUrl, { method: 'GET' });
      expect(ready.status).toBe(200);
    });
    expect(await ready.json()).toEqual(idToken);

    // 4. Consumed — the single-use token is gone: 204 again, never a 404.
    const consumed = await fetch(tokenUrl, { method: 'GET' });
    expect(consumed.status).toBe(204);
    expect(await consumed.text()).toBe('');
  });

  it('reports claimed status to the app while the wallet holds the request', async () => {
    // 1. App pushes the request and derives the status URL from request_uri.
    const postResult = await fetch(`${connectBaseUrl}/connect/par`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ request: { dummyProperty: 'dummyValue' } }),
    });
    expect(postResult.status).toBe(201);

    const rawRequestUrl = (await postResult.json() as any).request_uri;
    const requestId = /\/connect\/authorize\/([^/]+)\.jwt$/.exec(rawRequestUrl)![1];
    const statusUrl = `${connectBaseUrl}/connect/status/${requestId}`;

    // 2. Before the wallet fetches the request, the app sees claimed: false.
    let statusResult = await fetch(statusUrl, { method: 'GET' });
    expect(statusResult.status).toBe(200);
    expect(await statusResult.json()).toEqual({ claimed: false });

    // 3. The wallet claims (fetches) the request.
    const requestUrl = rawRequestUrl.replace(/localhost:\d+/, `localhost:${dwnServer.httpServer.port}`);
    await Poller.pollUntilSuccessOrTimeout(async () => {
      const getRequestResult = await fetch(requestUrl, { method: 'GET' });
      expect(getRequestResult.status).toBe(200);
    });

    // 4. The app now sees claimed: true, non-destructively (repeatable).
    for (let i = 0; i < 2; i++) {
      statusResult = await fetch(statusUrl, { method: 'GET' });
      expect(statusResult.status).toBe(200);
      expect(await statusResult.json()).toEqual({ claimed: true });
    }

    // 5. Unknown request IDs read as unclaimed.
    const unknownResult = await fetch(`${connectBaseUrl}/connect/status/does-not-exist`, { method: 'GET' });
    expect(unknownResult.status).toBe(200);
    expect(await unknownResult.json()).toEqual({ claimed: false });
  });

  it('records the app completion signal for the wallet to poll', async () => {
    const state = `dummyState-${randomUUID()}`;
    const completeStatusUrl = `${connectBaseUrl}/connect/complete/${state}`;

    // 1. Before the app signals completion, the wallet reads completed: false.
    let statusResult = await fetch(completeStatusUrl, { method: 'GET' });
    expect(statusResult.status).toBe(200);
    expect(await statusResult.json()).toEqual({ completed: false });

    // 2. A completion signal without a state is rejected.
    const missingStateResult = await fetch(`${connectBaseUrl}/connect/complete`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({}),
    });
    expect(missingStateResult.status).toBe(400);

    // 3. The app signals that it opened the wallet's response.
    const completeResult = await fetch(`${connectBaseUrl}/connect/complete`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state }),
    });
    expect(completeResult.status).toBe(201);

    // 4. The wallet now reads completed: true, non-destructively (repeatable).
    for (let i = 0; i < 2; i++) {
      statusResult = await fetch(completeStatusUrl, { method: 'GET' });
      expect(statusResult.status).toBe(200);
      expect(await statusResult.json()).toEqual({ completed: true });
    }
  });

  it('stores write-once SAS handshake keys and rejects conflicting overwrites', async () => {
    const state = `handshake-${randomUUID()}`;
    const handshakeGetUrl = `${connectBaseUrl}/connect/handshake/${state}`;
    const handshakePostUrl = `${connectBaseUrl}/connect/handshake`;
    const walletEpkA = { kty: 'OKP', crv: 'X25519', x: 'ZakEQ3d82ak4Vawhuarto4jHVubZwVBUz6fJXP9xIk8' };
    const walletEpkB = { kty: 'OKP', crv: 'X25519', x: 'vxvvbso9-Eo1mJZR_oCc6hIoh72EmWKBc0i_21c5LwQ' };

    // 1. Before the wallet posts a handshake key, GET reports ready: false.
    let getResult = await fetch(handshakeGetUrl, { method: 'GET' });
    expect(getResult.status).toBe(200);
    expect(await getResult.json()).toEqual({ ready: false });

    // 2. Invalid payloads are rejected with 400.
    for (const badBody of [
      {},
      { state },
      { state, walletEpk: { kty: 'OKP', crv: 'Ed25519', x: walletEpkA.x } },
      { state, walletEpk: { ...walletEpkA, d: 'private-material' } },
      { state, walletEpk: { kty: 'OKP', crv: 'X25519', x: '' } },
    ]) {
      const badRes = await fetch(handshakePostUrl, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify(badBody),
      });
      expect(badRes.status).toBe(400);
    }

    // 3. First write creates the handshake entry (201).
    const firstPost = await fetch(handshakePostUrl, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state, walletEpk: walletEpkA }),
    });
    expect(firstPost.status).toBe(201);

    // 4. GET returns ready: true and the exact public key, non-destructively.
    for (let i = 0; i < 2; i++) {
      getResult = await fetch(handshakeGetUrl, { method: 'GET' });
      expect(getResult.status).toBe(200);
      expect(await getResult.json()).toEqual({ ready: true, walletEpk: walletEpkA });
    }

    // 5. Re-posting the identical key is idempotent (200).
    const retryPost = await fetch(handshakePostUrl, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state, walletEpk: walletEpkA }),
    });
    expect(retryPost.status).toBe(200);

    // 6. Attempting to overwrite with a different key is rejected (409).
    const conflictPost = await fetch(handshakePostUrl, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state, walletEpk: walletEpkB }),
    });
    expect(conflictPost.status).toBe(409);

    // Original key remains intact after the rejected conflict.
    getResult = await fetch(handshakeGetUrl, { method: 'GET' });
    expect(getResult.status).toBe(200);
    expect(await getResult.json()).toEqual({ ready: true, walletEpk: walletEpkA });

    // 7. Invalid state / non-canonical coordinate / oversized body / malformed percent-encoding.
    const badCoordRes = await fetch(handshakePostUrl, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state: `badcoord-${randomUUID()}`, walletEpk: { kty: 'OKP', crv: 'X25519', x: 'short' } }),
    });
    expect(badCoordRes.status).toBe(400);

    const badStateRes = await fetch(handshakePostUrl, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state: 'bad/state with spaces', walletEpk: walletEpkA }),
    });
    expect(badStateRes.status).toBe(400);

    const oversizedRes = await fetch(handshakePostUrl, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state, walletEpk: walletEpkA, pad: 'x'.repeat(5_000) }),
    });
    expect(oversizedRes.status).toBe(413);

    const malformedUriRes = await fetch(`${connectBaseUrl}/connect/handshake/%ZZ`, { method: 'GET' });
    expect(malformedUriRes.status).toBe(400);

    const malformedCompleteUriRes = await fetch(`${connectBaseUrl}/connect/complete/%ZZ`, { method: 'GET' });
    expect(malformedCompleteUriRes.status).toBe(400);

    // 8. Concurrent identical or conflicting POSTs never fail with 500.
    const raceIdenticalState = `race-same-${randomUUID()}`;
    const [r1, r2] = await Promise.all([
      fetch(handshakePostUrl, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ state: raceIdenticalState, walletEpk: walletEpkA }),
      }),
      fetch(handshakePostUrl, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ state: raceIdenticalState, walletEpk: walletEpkA }),
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);

    const raceConflictState = `race-diff-${randomUUID()}`;
    const [c1, c2] = await Promise.all([
      fetch(handshakePostUrl, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ state: raceConflictState, walletEpk: walletEpkA }),
      }),
      fetch(handshakePostUrl, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ state: raceConflictState, walletEpk: walletEpkB }),
      }),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([201, 409]);

    // 9. Completing the connect session cleans up the handshake entry.
    const completeRes = await fetch(`${connectBaseUrl}/connect/complete`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ state }),
    });
    expect(completeRes.status).toBe(201);

    const afterComplete = await fetch(handshakeGetUrl, { method: 'GET' });
    expect(afterComplete.status).toBe(200);
    expect(await afterComplete.json()).toEqual({ ready: false });
  });

  it('should clean up objects that are expired', async () => {
    // Scenario:
    // 1. App sends the Connect Request object to the Connect server.
    // 2. Time passes and the Connect Request object is expired.
    // 3. Should receive 404 when fetching Connect Request.

    // 1. App sends the Connect Request object to the Connect server.
    const requestBody = { request: { dummyProperty: 'dummyValue' } };
    const postConnectRequestResult = await fetch(`${connectBaseUrl}/connect/par`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(requestBody),
    });
    expect(postConnectRequestResult.status).toBe(201);

    // 2. Time passes and the Connect Request object is expired.
    await clock.tickAsync(ConnectServer.ttlInSeconds * 1000);

    // 3. Should receive 404 when fetching the expired Connect Request.
    const rawRequestUrl = (await postConnectRequestResult.json() as any).request_uri;
    // Replace the port in the returned URL with the actual server port
    const requestUrl = rawRequestUrl.replace(/localhost:\d+/, `localhost:${dwnServer.httpServer.port}`);
    const getConnectRequestResult = await fetch(requestUrl, {
      method: 'GET',
    });
    expect(getConnectRequestResult.status).toBe(404);
  });
});
