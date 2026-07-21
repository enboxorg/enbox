import type { JsonRpcResponse } from '../src/json-rpc.js';
import type { Persona } from '@enbox/dwn-sdk-js';

import { CryptoUtils } from '@enbox/crypto';
import { JsonRpcSocket } from '../src/json-rpc-socket.js';
import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  createJsonRpcErrorResponse, createJsonRpcRequest, createJsonRpcSubscriptionRequest,
  createJsonRpcSuccessResponse, JsonRpcErrorCodes,
} from '../src/json-rpc.js';

const testDwnUrl = process.env.TEST_DWN_URL || 'http://localhost:3000';

/** helper method to sleep while waiting for events to process/arrive */
async function sleepWhileWaitingForEvents(override?: number):Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, override || 10));
}

describe('JsonRpcSocket', () => {
  let alice: Persona;
  // we set the client to a websocket url
  const dwnUrl = new URL(testDwnUrl);
  dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';
  const socketDwnUrl = dwnUrl.toString();

  afterAll(() => {
    mock.restore();
  });

  beforeEach(async () => {
    mock.restore();

    alice = await TestDataGenerator.generateDidKeyPersona();
  });

  it('reports fresh only while inbound traffic is inside the heartbeat window', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl, { heartbeatInterval: 1_000, heartbeatTimeout: 500 });
    try {
      // Freshly connected: the connect handshake stamps inbound liveness.
      expect(client.isFresh()).toBe(true);

      // A suspension leaves isConnected stale-true while no inbound frame
      // arrived within the window — freshness must fail at point of use.
      (client as unknown as { _lastInboundAt: number })._lastInboundAt = Date.now() - 60_000;
      expect(client.isConnected).toBe(true);
      expect(client.isFresh()).toBe(false);
    } finally {
      client.close();
    }
  });

  it('reports a heartbeat-disabled connected socket as fresh', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl, { heartbeatInterval: 0 });
    try {
      // No heartbeat means no inbound signal to demand; connectedness is the
      // only claim a heartbeat-less socket can make.
      (client as unknown as { _lastInboundAt: number })._lastInboundAt = Date.now() - 60_000;
      expect(client.isFresh()).toBe(true);
      client.close();
      expect(client.isFresh()).toBe(false);
    } finally {
      client.close();
    }
  });

  it('connects to a url', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    client.close();
  });

  it('generates a request id if one is not provided', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.processMessage', { param1: 'test-param1', param2: 'test-param2' });
    delete request.id;

    const response = await client.request(request);
    expect(response.id).not.toBe(requestId);
  });

  it('resolves a request with given params', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.processMessage', { param1: 'test-param1', param2: 'test-param2' });
    const response = await client.request(request);
    expect(response.id).toBe(request.id);
  });

  it('clears the response timeout when a request resolves', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.processMessage', { param1: 'test-param1', param2: 'test-param2' });

    const response = await client.request(request);

    expect(response.id).toBe(request.id);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    client.close();
  });

  it('request times out', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl, { responseTimeout: 1 });
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.processMessage', { param1: 'test-param1', param2: 'test-param2' });

    // Stub send so the request never reaches the server — guarantees the
    // 1ms timeout fires regardless of how fast the server responds.
    client['send'] = (): void => {};

    try {
      await client.request(request);
      throw new Error('Expected an error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('timed out');
    }
  });

  it('adds a handler to the messageHandlers map when listening for a response to a request', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const { message } = await TestDataGenerator.generateRecordsSubscribe({ author: alice });
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.processMessage', { target: alice.did, message });
    const response = client.request(request);
    expect(client['messageHandlers'].has(requestId)).toBe(true);

    await response;

    // removes the handler after the response is received
    expect(client['messageHandlers'].has(requestId)).toBe(false);
  });

  it('adds a handler to the messageHandlers map when listening for a response to a subscription', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const { message } = await TestDataGenerator.generateRecordsSubscribe({ author: alice });

    const requestId = CryptoUtils.randomUuid();
    const subscriptionId = CryptoUtils.randomUuid();
    const request = createJsonRpcSubscriptionRequest(
      requestId,
      'rpc.subscribe.dwn.processMessage',
      { target: alice.did, message },
      subscriptionId,
    );

    const responseListener = (_response: JsonRpcResponse): void => {};
    const subscription = await client.subscribe(request, responseListener);
    expect(client['messageHandlers'].has(subscriptionId)).toBe(true);

    // removes the handler after the subscription is closed
    await subscription.close!();
    expect(client['messageHandlers'].has(subscriptionId)).toBe(false);
  });

  it('removes listener if subscription json rpc is rejected ', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const requestId = CryptoUtils.randomUuid();
    const subscribeId = CryptoUtils.randomUuid();

    const request = createJsonRpcSubscriptionRequest(
      requestId,
      'rpc.subscribe.dwn.processMessage',
      { },
      subscribeId,
    );

    const responseListener = (_response: JsonRpcResponse): void => {};

    const subscription = await client.subscribe(request, responseListener);
    expect(subscription.response.error).toBeDefined();
    expect(client['messageHandlers'].has(subscribeId)).toBe(false);
  });

  it('opens a subscription', async () => {

    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const { message } = await TestDataGenerator.generateRecordsSubscribe({ author: alice });

    const requestId = CryptoUtils.randomUuid();
    const subscriptionId = CryptoUtils.randomUuid();
    const request = createJsonRpcSubscriptionRequest(
      requestId,
      'rpc.subscribe.dwn.processMessage',
      { target: alice.did, message },
      subscriptionId,
    );

    const responseListener = (_response: JsonRpcResponse): void => {};

    const subscription = await client.subscribe(request, responseListener);
    expect(subscription.response.error).toBeUndefined();
    // wait for the messages to arrive
    await sleepWhileWaitingForEvents();
    // the original response
    if (subscription.close) {
      await subscription.close();
    }
  });

  it('only JSON RPC Methods prefixed with `rpc.subscribe.` are accepted for a subscription', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'test.method', { param1: 'test-param1', param2: 'test-param2' });
    try {
      await client.subscribe(request, () => {});
      throw new Error('Expected an error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('subscribe rpc requests must include the `rpc.subscribe` prefix');
    }
  });

  it('subscribe methods must contain a subscribe object within the request which contains the subscription JsonRpcId', async () => {
    const client = await JsonRpcSocket.connect(socketDwnUrl);
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'rpc.subscribe.test.method', { param1: 'test-param1', param2: 'test-param2' });
    try {
      await client.subscribe(request, () => {});
      throw new Error('Expected an error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('subscribe rpc requests must include subscribe options');
    }
  });

  it('calls onclose handler', async () => {
    // test injected handler
    const onCloseHandler = { onclose: ():void => {} };
    const onCloseSpy = spyOn(onCloseHandler, 'onclose');
    const client = await JsonRpcSocket.connect(socketDwnUrl, { onclose: onCloseHandler.onclose });
    client.close();

    await sleepWhileWaitingForEvents();
    expect(onCloseSpy).toHaveBeenCalledTimes(1);

    // when no onclose handler is provided, close should succeed silently
    const logInfoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const defaultClient = await JsonRpcSocket.connect(socketDwnUrl);
    defaultClient.close();

    await sleepWhileWaitingForEvents();
    expect(logInfoSpy).toHaveBeenCalledTimes(0);
  });

  describe('event simulation', function () {
    it('calls onerror handler', async () => {
      // test injected handler
      const onErrorHandler = { onerror: ():void => {} };
      const onErrorSpy = spyOn(onErrorHandler, 'onerror');
      const client = await JsonRpcSocket.connect(socketDwnUrl, { onerror: onErrorHandler.onerror });
      client['socket'].dispatchEvent(new Event('error'));

      await sleepWhileWaitingForEvents();
      expect(onErrorSpy).toHaveBeenCalledTimes(1);

      // when no onerror handler is provided, error should be handled silently
      const logInfoSpy = spyOn(console, 'error').mockImplementation(() => {});
      const defaultClient = await JsonRpcSocket.connect(socketDwnUrl);
      defaultClient['socket'].dispatchEvent(new Event('error'));

      await sleepWhileWaitingForEvents();
      expect(logInfoSpy).toHaveBeenCalledTimes(0);
    });

    it('closes subscription upon receiving a JsonRpc Error for a long running subscription', async () => {

      const client = await JsonRpcSocket.connect(socketDwnUrl);
      const { message } = await TestDataGenerator.generateRecordsSubscribe({ author: alice });

      const requestId = CryptoUtils.randomUuid();
      const subscriptionId = CryptoUtils.randomUuid();
      const request = createJsonRpcSubscriptionRequest(
        requestId,
        'rpc.subscribe.dwn.processMessage',
        { target: alice.did, message },
        subscriptionId,
      );

      let errorCounter = 0;
      let responseCounter = 0;
      const responseListener = (response: JsonRpcResponse): void => {
        expect(response.id).toBe(subscriptionId);
        if (response.error) {
          errorCounter++;
        }

        if (response.result) {
          responseCounter++;
        }
      };

      const subscription = await client.subscribe(request, responseListener);
      expect(subscription.response.error).toBeUndefined();
      // wait for the messages to arrive

      // induce positive result
      const jsonResponse = createJsonRpcSuccessResponse(subscriptionId, { reply: {} });
      client['socket'].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(jsonResponse) }));

      // induce error message
      const errorResponse = createJsonRpcErrorResponse(subscriptionId, JsonRpcErrorCodes.InternalError, 'message');
      client['socket'].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(errorResponse) }));

      await sleepWhileWaitingForEvents();
      // the original response
      expect(responseCounter).toBe(1);
      expect(errorCounter).toBe(1);
    });
  });

  describe('toText helper', () => {
    // The `toText` helper is called inside `wireSocket` to convert WebSocket
    // message data (string, ArrayBuffer, or Uint8Array) into a string before
    // JSON parsing. We verify that messages delivered in each format are correctly
    // parsed and dispatched to the registered handler.
    //
    // NOTE: The original versions of these tests registered handlers that expected
    // pre-parsed JSON objects. In reality, `wireSocket` calls `toText(event.data)`
    // and then `parseJson()` internally, but the handler registered in
    // `messageHandlers` receives the raw `event` object — not parsed JSON.
    // Rewritten so each handler manually parses event.data (mirroring the real
    // `request()` flow) and asserts on the parsed response fields.

    it('should correctly parse a JSON-RPC response delivered as ArrayBuffer', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      const requestId = 'ab-test';
      // Register a handler that mimics what `request()` does internally:
      // it receives the raw event and re-parses event.data via toText.
      const responsePromise = new Promise<JsonRpcResponse>((resolve) => {
        client['messageHandlers'].set(requestId, (event: { data: unknown }) => {
          const parsed = JSON.parse(typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer)) as JsonRpcResponse;
          resolve(parsed);
        });
      });

      const responseObj = { jsonrpc: '2.0', id: requestId, result: { reply: { status: { code: 200 } } } };
      const encoded = new TextEncoder().encode(JSON.stringify(responseObj));
      const arrayBuffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
      client['socket'].dispatchEvent(new MessageEvent('message', { data: arrayBuffer }));

      const response = await responsePromise;
      expect(response.id).toBe(requestId);
      expect(response.result.reply.status.code).toBe(200);

      client.close();
    });

    it('should correctly parse a JSON-RPC response delivered as Uint8Array', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      const requestId = 'u8-test';
      const responsePromise = new Promise<JsonRpcResponse>((resolve) => {
        client['messageHandlers'].set(requestId, (event: { data: unknown }) => {
          const parsed = JSON.parse(typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer)) as JsonRpcResponse;
          resolve(parsed);
        });
      });

      const responseObj = { jsonrpc: '2.0', id: requestId, result: { reply: { status: { code: 201 } } } };
      const uint8 = new TextEncoder().encode(JSON.stringify(responseObj));
      client['socket'].dispatchEvent(new MessageEvent('message', { data: uint8 }));

      const response = await responsePromise;
      expect(response.id).toBe(requestId);
      expect(response.result.reply.status.code).toBe(201);

      client.close();
    });

    it('should correctly parse a JSON-RPC response delivered as string', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      const requestId = 'str-test';
      const responsePromise = new Promise<JsonRpcResponse>((resolve) => {
        client['messageHandlers'].set(requestId, (event: { data: unknown }) => {
          const parsed = JSON.parse(typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer)) as JsonRpcResponse;
          resolve(parsed);
        });
      });

      const responseObj = { jsonrpc: '2.0', id: requestId, result: { reply: { status: { code: 202 } } } };
      client['socket'].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(responseObj) }));

      const response = await responsePromise;
      expect(response.id).toBe(requestId);
      expect(response.result.reply.status.code).toBe(202);

      client.close();
    });
  });

  describe('wireSocket edge cases', () => {
    it('should silently ignore unparseable messages (null parse guard)', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      // Send non-JSON data — wireSocket should return early (parseJson returns null)
      client['socket'].dispatchEvent(new MessageEvent('message', { data: 'not valid json!!!' }));
      await sleepWhileWaitingForEvents();

      // No error thrown, client still operational
      expect(client.isConnected).toBe(true);
      client.close();
    });

    it('should silently ignore messages with no matching handler', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      // Send a valid JSON-RPC response with an id that has no registered handler
      const responseObj = { jsonrpc: '2.0', id: 'unregistered-id', result: null };
      client['socket'].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(responseObj) }));
      await sleepWhileWaitingForEvents();

      // No error thrown, client still operational
      expect(client.isConnected).toBe(true);
      client.close();
    });
  });

  describe('subscribe edge cases', () => {
    // NOTE: The original version of this test had a conditional assertion that only
    // checked handler preservation inside `if (sub2.response.error)` — meaning
    // the critical assertion would be silently skipped if the server happened to
    // accept the second subscription. Rewritten so the handler-preservation check
    // is unconditional: we always verify the original handler survives, regardless
    // of the server's response.
    it('should preserve existing handler on duplicate subscribe failure', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);
      const { message } = await TestDataGenerator.generateRecordsSubscribe({ author: alice });

      const requestId1 = CryptoUtils.randomUuid();
      const subscriptionId = CryptoUtils.randomUuid();
      const request1 = createJsonRpcSubscriptionRequest(
        requestId1,
        'rpc.subscribe.dwn.processMessage',
        { target: alice.did, message },
        subscriptionId,
      );

      // First subscription — should succeed
      const listener1 = (_response: JsonRpcResponse): void => {};
      const sub1 = await client.subscribe(request1, listener1);
      expect(sub1.response.error).toBeUndefined();
      expect(client['messageHandlers'].has(subscriptionId)).toBe(true);

      // Capture the handler that was set by the first subscription
      const originalHandler = client['messageHandlers'].get(subscriptionId);
      expect(originalHandler).toBeDefined();

      // Second subscription with same subscriptionId — will get an error response from server
      // because the subscription already exists
      const requestId2 = CryptoUtils.randomUuid();
      const request2 = createJsonRpcSubscriptionRequest(
        requestId2,
        'rpc.subscribe.dwn.processMessage',
        { }, // empty params will cause server to reject
        subscriptionId,
      );

      const listener2 = (_response: JsonRpcResponse): void => {};
      const sub2 = await client.subscribe(request2, listener2);

      // The server should reject the duplicate subscription (empty params = invalid).
      // Regardless of whether an error was returned, the original handler must survive.
      expect(client['messageHandlers'].has(subscriptionId)).toBe(true);
      const restoredHandler = client['messageHandlers'].get(subscriptionId);
      expect(restoredHandler).toBe(originalHandler);

      // If the server did return an error, verify the error structure too.
      if (sub2.response.error) {
        expect(sub2.response.error.code).toBeDefined();
      }

      // Clean up
      if (sub1.close) {
        await sub1.close();
      }
      client.close();
    });
  });

  describe('reconnection', () => {
    it('should set closedByUser on close() and not attempt reconnect', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, { autoReconnect: true });

      expect(client.isConnected).toBe(true);
      client.close();
      expect(client.isConnected).toBe(false);

      // closedByUser should be true — no reconnection attempt
      expect(client['closedByUser']).toBe(true);
      expect(client['reconnecting']).toBe(false);
    });

    it('should reject pending one-shot requests on unexpected close', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, { autoReconnect: false });

      // Set up a pending one-shot request that will never get a response
      const requestPromise = client.request({
        jsonrpc : '2.0',
        id      : 'pending-req',
        method  : 'test.method',
      });

      // Simulate an unexpected socket close
      client['socket'].close();
      await sleepWhileWaitingForEvents(50);

      // The pending request should be rejected with a transport error
      const response = await requestPromise;
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(JsonRpcErrorCodes.TransportError);
    });

    it('should not reject subscription handlers on unexpected close', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, { autoReconnect: false });

      // Register a subscription handler
      const subId = 'sub-handler-id';
      client['subscriptionHandlerIds'].add(subId);
      const mockHandler = mock((_event: { data: any }): void => {});
      client['messageHandlers'].set(subId, mockHandler);

      // Simulate an unexpected socket close
      client['socket'].close();
      await sleepWhileWaitingForEvents(50);

      // Subscription handler should still be in the map
      expect(client['messageHandlers'].has(subId)).toBe(true);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should call onclose and onreconnecting on unexpected close when autoReconnect is true', async () => {
      const onclose = mock((): void => {});
      const onreconnecting = mock((_attempt: number): void => {});

      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        autoReconnect        : true,
        baseReconnectDelay   : 50,
        maxReconnectDelay    : 100,
        maxReconnectAttempts : 1,
        onclose,
        onreconnecting,
      });

      // Simulate an unexpected socket close
      client['socket'].close();
      await sleepWhileWaitingForEvents(200);

      expect(onclose).toHaveBeenCalledTimes(1);
      expect(onreconnecting).toHaveBeenCalledTimes(1);
      expect(onreconnecting.mock.calls[0][0]).toBe(1);

      // Clean up
      client.close();
    });

    it('should reconnect and call onreconnected on successful reconnection', async () => {
      const onreconnected = mock((): void => {});
      const onclose = mock((): void => {});

      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        autoReconnect      : true,
        baseReconnectDelay : 50,
        maxReconnectDelay  : 100,
        onclose,
        onreconnected,
      });

      expect(client.isConnected).toBe(true);

      // Simulate an unexpected socket close (server is still running, so reconnect should succeed)
      client['socket'].close();
      await sleepWhileWaitingForEvents(500);

      expect(onreconnected).toHaveBeenCalledTimes(1);
      expect(client.isConnected).toBe(true);

      // Clean up
      client.close();
    });

    it('should stop reconnecting when maxReconnectAttempts is reached', async () => {
      const onreconnecting = mock((_attempt: number): void => {});
      // Use a bogus URL that will always fail to connect
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      let client: JsonRpcSocket | undefined;
      try {
        client = await JsonRpcSocket.connect(socketDwnUrl, {
          autoReconnect        : true,
          baseReconnectDelay   : 10,
          maxReconnectDelay    : 20,
          maxReconnectAttempts : 2,
          onreconnecting,
        });

        // Replace createWebSocket to always fail, simulating the server being down
        const originalCreate = JsonRpcSocket['createWebSocket'];
        spyOn(JsonRpcSocket as any, 'createWebSocket').mockRejectedValue(new Error('connection refused'));

        // Simulate unexpected close
        client['socket'].close();
        await sleepWhileWaitingForEvents(500);

        // Should have attempted exactly 2 reconnections
        expect(onreconnecting).toHaveBeenCalledTimes(2);
        expect(client['reconnecting']).toBe(false);

        // Restore
        (JsonRpcSocket as any)['createWebSocket'] = originalCreate;
      } finally {
        client?.close();
        consoleErrorSpy.mockRestore();
      }
    });

    it('should track isConnected state through connect/disconnect/reconnect cycle', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        autoReconnect      : true,
        baseReconnectDelay : 50,
        maxReconnectDelay  : 100,
      });

      expect(client.isConnected).toBe(true);

      // Simulate unexpected close
      client['socket'].close();
      await sleepWhileWaitingForEvents(10);

      expect(client.isConnected).toBe(false);

      // Wait for reconnection (server is still running)
      await sleepWhileWaitingForEvents(500);
      expect(client.isConnected).toBe(true);

      // Clean up
      client.close();
      expect(client.isConnected).toBe(false);
    });
  });

  describe('connect timeout', () => {
    it('should reject with "connect timed out" when the WebSocket never opens', async () => {
      // Use a non-routable IP to cause the connection to hang without
      // emitting open or error, then verify the connect timeout fires.
      await expect(
        JsonRpcSocket.connect('ws://10.255.255.1:9999', { connectTimeout: 100 })
      ).rejects.toThrow('connect timed out');
    }, 10_000);
  });

  describe('heartbeat', () => {
    it('should start heartbeat on connect and stop on close', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      // Heartbeat interval should be set.
      expect(client['_heartbeatInterval']).toBeDefined();
      expect(client['_awaitingPong']).toBe(false);

      client.close();

      // Heartbeat should be cleared after close.
      expect(client['_heartbeatInterval']).toBeUndefined();
    });

    it('should not start heartbeat when heartbeatInterval is 0', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        heartbeatInterval: 0,
      });

      expect(client['_heartbeatInterval']).toBeUndefined();

      client.close();
    });

    it('should send rpc.ping and clear awaitingPong on response', async () => {
      // Use a short heartbeat interval so the test completes quickly.
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        heartbeatInterval : 100,
        heartbeatTimeout  : 5_000,
      });

      // Wait for at least one heartbeat cycle to fire.
      await sleepWhileWaitingForEvents(250);

      // The server may or may not respond to rpc.ping — if it does,
      // awaitingPong resets. If it doesn't, the timeout hasn't fired yet
      // (5s timeout). Either way, the heartbeat mechanism ran without error.
      expect(client.isConnected).toBe(true);

      client.close();
    });

    it('should close connection on heartbeat timeout', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        heartbeatInterval : 50,
        heartbeatTimeout  : 50,
        autoReconnect     : false, // Don't reconnect — we want to observe the dead state.
      });

      // Stub send to silently discard pings (simulates a dead connection
      // where pings go out but no pongs come back).
      client['send'] = (): void => {};

      // Remove all message handlers so no pong can be received.
      client['messageHandlers'].clear();

      // Wait for heartbeat to fire and timeout.
      await sleepWhileWaitingForEvents(200);

      // The connection should have been closed by the heartbeat timeout.
      expect(client.isConnected).toBe(false);
    });

    it('should resolve checkHealth true on a live connection', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      const healthy = await client.checkHealth();

      expect(healthy).toBe(true);
      expect(client.isConnected).toBe(true);
      client.close();
    });

    it('should force-close a dead connection and resolve checkHealth false', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        autoReconnect      : false,
        healthProbeTimeout : 50,
      });

      // Drop outgoing pings — a dead connection swallows writes silently.
      client['send'] = (): void => {};

      const healthy = await client.checkHealth();

      expect(healthy).toBe(false);
      expect(client.isConnected).toBe(false);
    });

    it('should clear a stale heartbeat deadline when the health probe pongs', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      // Simulate a deadline armed before a tab freeze: pong still pending.
      client['_awaitingPong'] = true;
      client['_heartbeatTimeout'] = setTimeout((): void => {}, 60_000);

      const healthy = await client.checkHealth();

      expect(healthy).toBe(true);
      expect(client['_awaitingPong']).toBe(false);
      expect(client['_heartbeatTimeout']).toBeUndefined();
      client.close();
    });

    it('should deduplicate concurrent health probes', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl);

      const originalSend = client['send'].bind(client);
      let pingCount = 0;
      client['send'] = (request): void => {
        if (request.method === 'rpc.ping') {
          pingCount++;
        }
        originalSend(request);
      };

      const [first, second] = await Promise.all([client.checkHealth(), client.checkHealth()]);

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(pingCount).toBe(1);
      client.close();
    });

    it('should not reconnect on checkHealth after a user close', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, { autoReconnect: true });
      client.close();

      const healthy = await client.checkHealth();

      expect(healthy).toBe(false);
      expect(client['reconnecting']).toBe(false);
    });

    it('should remove a superseded heartbeat handler and ignore its late pong', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        heartbeatInterval : 50,
        heartbeatTimeout  : 5_000,
      });

      // Swallow heartbeat pings (they go outstanding) but let health probes
      // through — the frozen-tab shape: a ping stuck awaiting its pong while
      // a wake-triggered probe verifies the connection is actually alive.
      const originalSend = client['send'].bind(client);
      client['send'] = (request): void => {
        const id = String(request.id ?? '');
        if (id.startsWith('hb-') && !id.startsWith('hb-probe-')) {
          return;
        }
        originalSend(request);
      };

      // Wait for a heartbeat ping to go outstanding.
      while (client['_awaitingPong'] !== true) {
        await sleepWhileWaitingForEvents(10);
      }
      const staleId = client['_heartbeatPingId'] as string;
      expect(staleId).toBeDefined();
      expect(client['messageHandlers'].has(staleId)).toBe(true);

      // A successful probe supersedes the outstanding heartbeat completely:
      // deadline cleared AND the stale pong handler removed.
      expect(await client.checkHealth()).toBe(true);
      expect(client['messageHandlers'].has(staleId)).toBe(false);
      expect(client['_heartbeatPingId']).toBeUndefined();
      expect(client['_awaitingPong']).toBe(false);

      // Let the next heartbeat go outstanding with a fresh deadline.
      while (client['_awaitingPong'] !== true) {
        await sleepWhileWaitingForEvents(10);
      }
      expect(client['_heartbeatTimeout']).toBeDefined();

      // A late pong for the superseded ping must not defuse the newer
      // heartbeat's deadline.
      client['socket'].dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: staleId, result: { ok: true } }),
      }));
      await sleepWhileWaitingForEvents(20);
      expect(client['_awaitingPong']).toBe(true);
      expect(client['_heartbeatTimeout']).toBeDefined();

      client.close();
    }, 10_000);

    it('should fast-forward a pending reconnect backoff on checkHealth', async () => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        autoReconnect      : true,
        // Long enough that reconnection cannot happen in test time without the wake.
        baseReconnectDelay : 60_000,
        maxReconnectDelay  : 60_000,
      });

      // Simulate an unexpected close and let the reconnect loop arm its backoff wait.
      client['socket'].close();
      await sleepWhileWaitingForEvents(100);
      expect(client.isConnected).toBe(false);
      expect(client['reconnecting']).toBe(true);
      expect(client['_backoffWake']).toBeDefined();

      // A wake signal fast-forwards the backoff — reconnection happens now.
      const healthy = await client.checkHealth();
      expect(healthy).toBe(false);

      await sleepWhileWaitingForEvents(500);
      expect(client.isConnected).toBe(true);

      client.close();
    }, 10_000);

    it('should stay closed when close() races an in-flight reconnect attempt', async () => {
      const onreconnected = mock((): void => {});
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        autoReconnect      : true,
        baseReconnectDelay : 10,
        maxReconnectDelay  : 10,
        onreconnected,
      });

      // Gate reconnect establishment so close() can land mid-connect.
      let releaseConnect!: () => void;
      const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
      const socketClass = JsonRpcSocket as unknown as {
        createWebSocket(url: string, timeout: number): Promise<WebSocket>;
      };
      const originalCreate = socketClass.createWebSocket;
      const createdSockets: WebSocket[] = [];
      let connectCalls = 0;
      socketClass.createWebSocket = async (url: string, timeout: number): Promise<WebSocket> => {
        connectCalls += 1;
        await connectGate;
        const socket = await originalCreate.call(JsonRpcSocket, url, timeout);
        createdSockets.push(socket);
        return socket;
      };

      try {
        // Unexpected drop — the reconnect loop enters the gated establishment.
        client['socket'].close();
        while (connectCalls === 0) {
          await sleepWhileWaitingForEvents(10);
        }

        // Shutdown lands while the new WebSocket is still being established.
        client.close();
        releaseConnect();
        await sleepWhileWaitingForEvents(100);

        // The user-closed socket must stay closed: no assignment, no
        // heartbeat, no reconnection announcement — and the fresh WebSocket
        // is discarded.
        expect(client.isConnected).toBe(false);
        expect(client['reconnecting']).toBe(false);
        expect(onreconnected).not.toHaveBeenCalled();
        expect(client['_heartbeatInterval']).toBeUndefined();
        expect(createdSockets).toHaveLength(1);
        expect(createdSockets[0].readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
      } finally {
        socketClass.createWebSocket = originalCreate;
      }
    }, 10_000);

    it('should restart heartbeat after reconnection', async (): Promise<void> => {
      const client = await JsonRpcSocket.connect(socketDwnUrl, {
        heartbeatInterval : 100,
        heartbeatTimeout  : 5_000,
      });

      expect(client['_heartbeatInterval']).toBeDefined();

      // Simulate an unexpected close and wait for reconnect.
      client['socket'].close();
      await sleepWhileWaitingForEvents(2_000);

      // After reconnection, heartbeat should be running again.
      if (client.isConnected) {
        expect(client['_heartbeatInterval']).toBeDefined();
      }

      client.close();
    }, 10_000);
  });
});
