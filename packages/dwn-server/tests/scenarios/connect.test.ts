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
    // 7. Should receive 404 if fetching the same Connect Response object again.

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

    // 7. Should receive 404 if fetching the same Connect Response object again.
    await Poller.pollUntilSuccessOrTimeout(async () => {
      const getConnectResponseResult2 = await fetch(connectResponseUrl, { method: 'GET' });
      expect(getConnectResponseResult2.status).toBe(404);
    });
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
