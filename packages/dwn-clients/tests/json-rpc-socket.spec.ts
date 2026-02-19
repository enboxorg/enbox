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

  it('request times out', async () => {
    // time out after 1 ms
    const client = await JsonRpcSocket.connect(socketDwnUrl, { responseTimeout: 1 });
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'down.processMessage', { param1: 'test-param1', param2: 'test-param2' });
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

    // test default logger
    const logInfoSpy = spyOn(console, 'info').mockImplementation(() => {});
    const defaultClient = await JsonRpcSocket.connect(socketDwnUrl);
    defaultClient.close();

    await sleepWhileWaitingForEvents();
    expect(logInfoSpy).toHaveBeenCalledTimes(1);

    // extract log message from argument
    const logMessage:string = logInfoSpy.mock.calls[0][0]!;
    expect(logMessage).toBe(`JSON RPC Socket close ${socketDwnUrl}`);
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

      // test default logger
      const logInfoSpy = spyOn(console, 'error').mockImplementation(() => {});
      const defaultClient = await JsonRpcSocket.connect(socketDwnUrl);
      defaultClient['socket'].dispatchEvent(new Event('error'));

      await sleepWhileWaitingForEvents();
      expect(logInfoSpy).toHaveBeenCalledTimes(1);

      // extract log message from argument
      const logMessage:string = logInfoSpy.mock.calls[0][0]!;
      expect(logMessage).toBe(`JSON RPC Socket error ${socketDwnUrl}`);
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
});
