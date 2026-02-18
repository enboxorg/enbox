import type { JsonRpcId, JsonRpcRequest, JsonRpcSuccessResponse } from '../src/lib/json-rpc.js';

import log from 'loglevel';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { JsonRpcSocket } from '../src/json-rpc-socket.js';
import {
  createJsonRpcErrorResponse, createJsonRpcRequest, createJsonRpcSubscriptionRequest,
  createJsonRpcSuccessResponse, JsonRpcErrorCodes,
} from '../src/lib/json-rpc.js';

describe('JsonRpcSocket', () => {
  let wsServer: WebSocketServer;

  beforeAll(async () => {
    wsServer = new WebSocketServer({
      port: 9003,
    });
  });

  afterAll(async () => {
    wsServer.close();
    // give time for the server to close
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  beforeEach(() => {
    mock.restore();
    wsServer.removeAllListeners();
  });

  it('connects to a url', async () => {
    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003');
    expect(wsServer.clients.size).toBe(1);
    client.close();

    // give time for the connection to close on the server.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(wsServer.clients.size).toBe(0);
  });

  it('resolves a request with given params', async () => {
    wsServer.addListener('connection', (socket) => {
      socket.on('message', (dataBuffer: Buffer) => {
        const request = JSON.parse(dataBuffer.toString()) as JsonRpcRequest;
        const { param1, param2 } = request.params;
        expect(param1).toBe('test-param1');
        expect(param2).toBe('test-param2');

        // send response passed tests
        const response = createJsonRpcSuccessResponse(request.id, {});
        socket.send(Buffer.from(JSON.stringify(response)));
      });
    });

    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003');
    const requestId = uuidv4();
    const request = createJsonRpcRequest(requestId, 'test.method', { param1: 'test-param1', param2: 'test-param2' });
    const response = await client.request(request);
    expect(response.id).toBe(request.id);
  });

  it('request times out', async () => {
    // time out after 1 ms
    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003', { responseTimeout: 1 });
    const requestId = uuidv4();
    const request = createJsonRpcRequest(requestId, 'test.method', { param1: 'test-param1', param2: 'test-param2' });
    const requestPromise = client.request(request);

    await expect(requestPromise).rejects.toThrow('timed out');
  });

  it('removes listener if subscription json rpc is rejected ', async () => {
    wsServer.addListener('connection', (socket) => {
      socket.on('message', (dataBuffer: Buffer) => {
        const request = JSON.parse(dataBuffer.toString()) as JsonRpcRequest;
        // initial response
        const response = createJsonRpcErrorResponse(request.id, JsonRpcErrorCodes.BadRequest, 'bad request');
        socket.send(Buffer.from(JSON.stringify(response)));
      });
    });

    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003', { responseTimeout: 100 });
    const requestId = uuidv4();
    const subscribeId = uuidv4();
    const request = createJsonRpcSubscriptionRequest(
      requestId,
      'rpc.subscribe.test.method',
      { param1: 'test-param1', param2: 'test-param2' },
      subscribeId,
    );

    const responseListener = (_response: JsonRpcSuccessResponse): void => {};

    const subscription = await client.subscribe(request, responseListener);
    expect(subscription.response.error).toBeDefined();
    expect(client['socket'].listenerCount('message')).toBe(0);
  });

  it('opens a subscription', async () => {
    wsServer.addListener('connection', (socket) => {
      socket.on('message', (dataBuffer: Buffer) => {
        const request = JSON.parse(dataBuffer.toString()) as JsonRpcRequest;
        // initial response
        const response = createJsonRpcSuccessResponse(request.id, { reply: {} });
        socket.send(Buffer.from(JSON.stringify(response)));
        const { subscription } = request;
        // send 3 messages
        for (let i = 0; i < 3; i++) {
          const response = createJsonRpcSuccessResponse(subscription.id, { count: i });
          socket.send(Buffer.from(JSON.stringify(response)));
        }
      });
    });

    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003', { responseTimeout: 100 });
    const requestId = uuidv4();
    const subscribeId = uuidv4();
    const request = createJsonRpcSubscriptionRequest(
      requestId,
      'rpc.subscribe.test.method',
      { param1: 'test-param1', param2: 'test-param2' },
      subscribeId,
    );

    let responseCounter = 0;
    const responseListener = (response: JsonRpcSuccessResponse): void => {
      expect(response.id).toBe(subscribeId);
      const { count } = response.result;
      expect(count).toBe(responseCounter);
      responseCounter++;
    };

    const subscription = await client.subscribe(request, responseListener);
    expect(subscription.response.error).toBeUndefined();
    // wait for the messages to arrive
    await new Promise((resolve) => setTimeout(resolve, 50));
    // the original response
    expect(responseCounter).toBe(3);
    await subscription.close();
  });

  it('sends message', async () => {
    const receivedPromise = new Promise<{ reply: { id?: JsonRpcId }}>((resolve) => {
      wsServer.addListener('connection', (socket) => {
        socket.on('message', (dataBuffer: Buffer) => {
          const request = JSON.parse(dataBuffer.toString()) as JsonRpcRequest;
          const { param1, param2 } = request.params;
          expect(param1).toBe('test-param1');
          expect(param2).toBe('test-param2');
          resolve({ reply: { id: request.id } });
        });
      });
    });
    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003');
    const requestId = uuidv4();
    const request = createJsonRpcRequest(requestId, 'test.method', { param1: 'test-param1', param2: 'test-param2' });
    client.send(request);
    const result = await receivedPromise;
    expect(result).toEqual({ reply: { id: request.id } });
  });

  it('closes subscription upon receiving a JsonRpc Error for a long running subscription', async () => {
    let closed = true;
    wsServer.addListener('connection', (socket) => {
      closed = false;
      socket.on('message', (dataBuffer: Buffer) => {
        const request = JSON.parse(dataBuffer.toString()) as JsonRpcRequest;
        if (request.method.startsWith('rpc.subscribe') && request.method !== 'rpc.subscribe.close') {
          // initial response
          const response = createJsonRpcSuccessResponse(request.id, { reply: {} });
          socket.send(Buffer.from(JSON.stringify(response)));
          const { subscription } = request;

          // send 1 valid message
          const message1 = createJsonRpcSuccessResponse(subscription.id, { message: 1 });
          socket.send(Buffer.from(JSON.stringify(message1)));

          // send a json rpc error
          const jsonRpcError = createJsonRpcErrorResponse(subscription.id, JsonRpcErrorCodes.InternalError, 'some error');
          socket.send(Buffer.from(JSON.stringify(jsonRpcError)));

          // send a 2nd message that shouldn't be handled
          const message2 = createJsonRpcSuccessResponse(subscription.id, { message: 2 });
          socket.send(Buffer.from(JSON.stringify(message2)));
        } else if (request.method === 'rpc.subscribe.close') {
          closed = true;
        }
      });
    });

    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003', { responseTimeout: 100 });
    const requestId = uuidv4();
    const subscribeId = uuidv4();
    const request = createJsonRpcSubscriptionRequest(
      requestId,
      'rpc.subscribe.test.method',
      { param1: 'test-param1', param2: 'test-param2' },
      subscribeId,
    );

    let responseCounter = 0;
    let errorCounter = 0;
    const responseListener = (response: JsonRpcSuccessResponse): void => {
      expect(response.id).toBe(subscribeId);
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    // the original response
    expect(responseCounter).toBe(1);
    expect(errorCounter).toBe(1);
    expect(closed).toBe(true);
  });

  it('only JSON RPC Methods prefixed with `rpc.subscribe.` are accepted for a subscription', async () => {
    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003');
    const requestId = uuidv4();
    const request = createJsonRpcRequest(requestId, 'test.method', { param1: 'test-param1', param2: 'test-param2' });
    const subscribePromise = client.subscribe(request, () => {});
    await expect(subscribePromise).rejects.toThrow('subscribe rpc requests must include the `rpc.subscribe` prefix');
  });

  it('subscribe methods must contain a subscribe object within the request which contains the subscription JsonRpcId', async () => {
    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003');
    const requestId = uuidv4();
    const request = createJsonRpcRequest(requestId, 'rpc.subscribe.test.method', { param1: 'test-param1', param2: 'test-param2' });
    const subscribePromise = client.subscribe(request, () => {});
    await expect(subscribePromise).rejects.toThrow('subscribe rpc requests must include subscribe options');
  });

  it('calls onclose handler', async () => {
    // test injected handler
    const onCloseHandler = { onclose: ():void => {} };
    const onCloseSpy = spyOn(onCloseHandler, 'onclose');
    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003', { onclose: onCloseHandler.onclose });
    client.close();

    await new Promise((resolve) => setTimeout(resolve, 5)); // wait for close event to arrive
    expect(onCloseSpy).toHaveBeenCalledTimes(1);

    // test default logger
    const logInfoSpy = spyOn(log, 'info');
    const defaultClient = await JsonRpcSocket.connect('ws://127.0.0.1:9003');
    defaultClient.close();

    await new Promise((resolve) => setTimeout(resolve, 5)); // wait for close event to arrive
    expect(logInfoSpy).toHaveBeenCalledTimes(1);

    // extract log message from argument
    const logMessage:string = logInfoSpy.mock.calls[0][0]!;
    expect(logMessage).toBe('JSON RPC Socket close ws://127.0.0.1:9003');
  });

  // Skip under Bun: ws EventEmitter 'error' event handling is incompatible with Bun's runtime.
  // The `socket.emit('error', ...)` call throws "Unhandled error" before the registered handler runs.
  it.skip('calls onerror handler', async () => {
    // test injected handler
    const onErrorHandler = { onerror: ():void => {} };
    const onErrorSpy = spyOn(onErrorHandler, 'onerror');
    const client = await JsonRpcSocket.connect('ws://127.0.0.1:9003', { onerror: onErrorHandler.onerror });
    client['socket'].emit('error', 'some error');

    await new Promise((resolve) => setTimeout(resolve, 5)); // wait for close event to arrive
    expect(onErrorSpy).toHaveBeenCalledTimes(1);

    // test default logger
    const logInfoSpy = spyOn(log, 'error');
    const defaultClient = await JsonRpcSocket.connect('ws://127.0.0.1:9003');
    defaultClient['socket'].emit('error', 'some error');

    await new Promise((resolve) => setTimeout(resolve, 5)); // wait for close event to arrive
    expect(logInfoSpy).toHaveBeenCalledTimes(1);

    // extract log message from argument
    const logMessage:string = logInfoSpy.mock.calls[0][0]!;
    expect(logMessage).toBe('JSON RPC Socket error ws://127.0.0.1:9003');
  });
});
