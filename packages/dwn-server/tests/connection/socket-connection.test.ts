import type { Dwn } from '@enbox/dwn-sdk-js';
import type { ServerWebSocket } from 'bun';

import log from 'loglevel';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import type { WsData } from '../../src/http-api.js';

import { getTestDwn } from '../test-dwn.js';
import { jsonRpcRouter } from '../../src/json-rpc-api.js';
import { RateLimiter } from '../../src/rate-limiter.js';
import { requestCounter } from '../../src/metrics.js';
import { SocketConnection } from '../../src/connection/socket-connection.js';
import {
  createJsonRpcAck,
  createJsonRpcErrorResponse,
  createJsonRpcRequest,
  createJsonRpcSuccessResponse,
  JsonRpcErrorCodes,
} from '@enbox/dwn-clients';

/** Creates a minimal mock of Bun's ServerWebSocket for unit testing. */
function createMockSocket(): ServerWebSocket<WsData> {
  return {
    data          : { connection: null as any },
    send          : sinon.stub(),
    sendText      : sinon.stub(),
    sendBinary    : sinon.stub(),
    close         : sinon.stub(),
    terminate     : sinon.stub(),
    ping          : sinon.stub(),
    pong          : sinon.stub(),
    publish       : sinon.stub(),
    publishText   : sinon.stub(),
    publishBinary : sinon.stub(),
    subscribe     : sinon.stub(),
    unsubscribe   : sinon.stub(),
    isSubscribed  : sinon.stub(),
    cork          : sinon.stub(),
    remoteAddress : '127.0.0.1',
    readyState    : 1,
    binaryType    : 'arraybuffer',
  } as unknown as ServerWebSocket<WsData>;
}

/** Reserves and activates one subscription through the connection lifecycle. */
async function activateSubscription(connection: SocketConnection, id: string, close = sinon.stub().resolves()): Promise<void> {
  const opening = (connection as any).reserveSubscription(id);
  await (connection as any).activateSubscription(opening, close);
}

describe('SocketConnection', () => {
  let dwn: Dwn;

  beforeAll(async () => {
    ({ dwn } = await getTestDwn());
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    await dwn.close();
    sinon.restore();
  });

  it('should create a connection with heartbeat', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    // With Bun, events are dispatched externally — no socket.on() calls.
    // Just verify the connection was created successfully.
    expect(connection).toBeInstanceOf(SocketConnection);
    await connection.close();
  });

  it('should reject an invalid subscription limit', () => {
    const socket = createMockSocket();

    expect(() => new SocketConnection(socket, dwn, { maxSubscriptions: 0 })).toThrow(
      'maxSubscriptions must be a positive safe integer',
    );
  });

  it('should reserve and activate a subscription', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const close = sinon.stub().resolves();

    await activateSubscription(connection, 'id', close);
    expect(connection.subscriptionCount).toBe(1);
    await connection.close();
    expect(connection.subscriptionCount).toBe(0);
    expect(close.calledOnce).toBe(true);
  });

  it('should reject duplicate subscription IDs before replacing the existing flow controller', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const id = 'some-id';
    const firstOpening = (connection as any).reserveSubscription(id);
    const firstSlot = (connection as any).subscriptionSlots.get(id);

    expect(() => (connection as any).reserveSubscription(id)).toThrow(`the subscription with id ${id} already exists`);
    expect((connection as any).subscriptionSlots.get(id)).toBe(firstSlot);
    expect(typeof firstOpening.listener).toBe('function');
    await connection.close();
  });

  it('should count a cancelled opening until its request settles', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, { maxSubscriptions: 1 });
    const opening = (connection as any).reserveSubscription('opening');

    expect(() => (connection as any).reserveSubscription('second')).toThrow('subscription limit of 1');
    await connection.closeSubscription('opening');
    expect(() => (connection as any).reserveSubscription('second')).toThrow('subscription limit of 1');
    (connection as any).finishSubscriptionOpening(opening);
    expect(() => (connection as any).reserveSubscription('second')).not.toThrow();

    await connection.close();
  });

  it('should retain capacity until an active subscription close settles', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, { maxSubscriptions: 1 });
    let finishClose!: () => void;
    const close = sinon.stub().returns(new Promise<void>((resolve): void => {
      finishClose = resolve;
    }));
    await activateSubscription(connection, 'first', close);

    const closing = connection.closeSubscription('first');
    expect(connection.subscriptionCount).toBe(0);
    expect(() => (connection as any).reserveSubscription('second')).toThrow('subscription limit of 1');

    finishClose();
    await closing;
    expect(() => (connection as any).reserveSubscription('second')).not.toThrow();
    await connection.close();
  });

  it('should close a subscription returned after its opening was cancelled', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const close = sinon.stub().resolves();
    const opening = (connection as any).reserveSubscription('late');

    await connection.closeSubscription('late');
    expect(() => (connection as any).reserveSubscription('late')).toThrow('already exists');
    await expect((connection as any).activateSubscription(opening, close)).rejects.toThrow('no longer exists');

    expect(close.calledOnce).toBe(true);
    expect(connection.subscriptionCount).toBe(0);
    expect(() => (connection as any).reserveSubscription('late')).not.toThrow();
    await connection.close();
  });

  it('should not let a settled opening release a later slot with the same ID', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const firstOpening = (connection as any).reserveSubscription('shared');

    (connection as any).finishSubscriptionOpening(firstOpening);
    const secondOpening = (connection as any).reserveSubscription('shared');
    (connection as any).finishSubscriptionOpening(firstOpening);

    expect((connection as any).subscriptionSlots.get('shared')).toBe(secondOpening);
    await connection.close();
  });

  it('should retain capacity when an underlying subscription close rejects', async () => {
    const socket = createMockSocket();
    sinon.stub(log, 'error');
    const connection = new SocketConnection(socket, dwn, { maxSubscriptions: 1 });
    const close = sinon.stub();
    close.onFirstCall().rejects(new Error('close failed'));
    close.onSecondCall().resolves();
    await activateSubscription(connection, 'first', close);

    await expect(connection.closeSubscription('first')).rejects.toThrow('close failed');
    expect(() => (connection as any).reserveSubscription('second')).toThrow('subscription limit of 1');

    await connection.close();
    expect(close.callCount).toBe(2);
  });

  it('should run connection cleanup only once', async () => {
    const socket = createMockSocket();
    const onClose = sinon.stub();
    const connection = new SocketConnection(socket, dwn, { onClose });

    await Promise.all([connection.close(), connection.close()]);

    expect((socket.close as sinon.SinonStub).calledOnce).toBe(true);
    expect(onClose.calledOnce).toBe(true);
  });

  it('should close if pong is not triggered between heartbeat intervals', async () => {
    const socket = createMockSocket();
    const clock = sinon.useFakeTimers();
    const connection = new SocketConnection(socket, dwn);
    const closeSpy = spyOn(connection, 'close');

    clock.tick(60_100); // interval has to run twice
    clock.restore();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('should terminate the socket immediately when the heartbeat detects a dead peer', async () => {
    const socket = createMockSocket();
    const clock = sinon.useFakeTimers();
    const connection = new SocketConnection(socket, dwn);
    const closeSpy = spyOn(connection, 'close');

    clock.tick(60_100); // interval has to run twice without a pong
    clock.restore();

    // A dead peer cannot complete a close handshake — the socket must be
    // torn down immediately, then connection resources released.
    expect((socket.terminate as sinon.SinonStub).calledOnce).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('should not close if pong is called within the heartbeat interval', async () => {
    const socket = createMockSocket();
    const clock = sinon.useFakeTimers();
    const connection = new SocketConnection(socket, dwn);
    const closeSpy = spyOn(connection, 'close');

    connection.pong(); // trigger a pong (now public)
    clock.tick(30_100); // first interval

    connection.pong(); // trigger a pong
    clock.tick(30_100); // second interval

    expect(closeSpy).toHaveBeenCalledTimes(0);

    clock.tick(30_100); // another interval without a ping
    clock.restore();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('logs an error and closes connection if error is triggered', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const logSpy = spyOn(log, 'error').mockImplementation(() => {});
    const closeSpy = spyOn(connection, 'close');

    connection.error(new Error('some error')); // now public

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  describe('toSnapshot()', () => {
    it('should return a snapshot with all expected fields', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      const snapshot = connection.toSnapshot();

      expect(snapshot.id).toBe(connection.id);
      expect(typeof snapshot.connectedAt).toBe('string');
      // Verify connectedAt is a valid ISO date string.
      expect(new Date(snapshot.connectedAt).toISOString()).toBe(snapshot.connectedAt);
      expect(snapshot.subscriptionCount).toBe(0);
      expect(snapshot.subscriptions).toBeInstanceOf(Array);
      expect(snapshot.subscriptions).toHaveLength(0);

      await connection.close();
    });

    it('should reflect the correct subscription count after adding subscriptions', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      await activateSubscription(connection, 'snap-sub-1');

      const snapshot = connection.toSnapshot();
      expect(snapshot.subscriptionCount).toBe(1);

      await connection.close();
    });
  });

  describe('toSnapshot() with active flow controllers', () => {
    it('should include flow controller stats in subscription snapshots', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn, { maxInFlight: 10 });

      await activateSubscription(connection, 'fc-sub-1');

      const snapshot = connection.toSnapshot();
      expect(snapshot.subscriptionCount).toBe(1);
      expect(snapshot.subscriptions).toHaveLength(1);
      expect(snapshot.subscriptions[0].id).toBe('fc-sub-1');
      expect(snapshot.subscriptions[0].inflight).toBe(0);
      expect(snapshot.subscriptions[0].buffered).toBe(0);

      await connection.close();
    });
  });

  // NOTE: The original version had a "send when socket is not OPEN" test that
  // mocked readyState to 0 and asserted that send() would not forward to the
  // underlying socket. However, `SocketConnection.send()` has no readyState
  // guard — it unconditionally calls `this.socket.send()` (line 234 of
  // socket-connection.ts). The test was meaningless because it was testing
  // behavior that doesn't exist in the source. Replaced with tests for the
  // `message()` method's actual error-handling paths: empty payload and
  // invalid JSON, which both return JsonRpcErrorCodes.BadRequest (-50400).
  describe('message()', () => {
    it('should return a BadRequest error response for an empty payload', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      const sendStub = socket.send as sinon.SinonStub;
      await connection.message(Buffer.from(''));

      // The empty-payload guard (line 170-176) should send back a JSON-RPC error.
      expect(sendStub.calledOnce).toBe(true);
      const sent = JSON.parse(sendStub.firstCall.args[0]);
      expect(sent.error).toBeDefined();
      expect(sent.error.code).toBe(-50400); // JsonRpcErrorCodes.BadRequest
      expect(sent.error.message).toBe('request payload required.');

      await connection.close();
    });

    it('should return a BadRequest error response for invalid JSON', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      const sendStub = socket.send as sinon.SinonStub;
      await connection.message(Buffer.from('not valid json!!!'));

      expect(sendStub.calledOnce).toBe(true);
      const sent = JSON.parse(sendStub.firstCall.args[0]);
      expect(sent.error).toBeDefined();
      expect(sent.error.code).toBe(-50400); // JsonRpcErrorCodes.BadRequest

      await connection.close();
    });

    it('should return a BadRequest error response for a non-object JSON payload', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      await connection.message(Buffer.from('null'));

      const sent = JSON.parse((socket.send as sinon.SinonStub).lastCall.args[0]);
      expect(sent.error.code).toBe(JsonRpcErrorCodes.BadRequest);
      expect(sent.error.message).toBe('request payload must be a JSON object.');
      await connection.close();
    });

    it('should share one peer-IP bucket across different target DIDs', async () => {
      const socket = createMockSocket();
      const limiter = new RateLimiter({ refillRate: 1, maxTokens: 1 });
      const connection = new SocketConnection(socket, dwn, {
        ipRateLimiter : limiter,
        peerIp        : '192.0.2.1',
      });

      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('one', 'unknown', { target: 'did:example:alice' }))));
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('two', 'unknown', { target: 'did:example:bob' }))));

      const responses = (socket.send as sinon.SinonStub).args.map(([response]) => JSON.parse(response));
      expect(responses[0].error.code).toBe(JsonRpcErrorCodes.MethodNotFound);
      expect(responses[1].error.code).toBe(JsonRpcErrorCodes.TooManyRequests);

      limiter.destroy();
      await connection.close();
    });

    it('should collapse unregistered method names into one metric label', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);
      const attackerMethod = `unknown-${crypto.randomUUID()}`;

      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('unknown', attackerMethod))));
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('prototype', '__proto__'))));

      const metric = await requestCounter.get();
      expect(metric.values.some((value) => value.labels.method === attackerMethod)).toBe(false);
      expect(metric.values.some((value) => value.labels.method === 'unknown')).toBe(true);
      const prototypeResponse = JSON.parse((socket.send as sinon.SinonStub).lastCall.args[0]);
      expect(prototypeResponse.error.code).toBe(JsonRpcErrorCodes.MethodNotFound);
      await connection.close();
    });

    it('should not rate-limit acknowledgements that release a known subscription window', async () => {
      const socket = createMockSocket();
      const limiter = new RateLimiter({ refillRate: 1, maxTokens: 1 });
      const connection = new SocketConnection(socket, dwn, {
        ipRateLimiter : limiter,
        peerIp        : '192.0.2.1',
      });
      const opening = (connection as any).reserveSubscription('subscription');
      await (connection as any).activateSubscription(opening, sinon.stub().resolves());
      const cursor = { streamId: 's', epoch: 'e', position: '1' };
      opening.listener({ type: 'eose', cursor });
      (socket.send as sinon.SinonStub).resetHistory();

      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('ping', 'rpc.ping'))));
      const ack = createJsonRpcAck('subscription', cursor);
      await connection.message(Buffer.from(JSON.stringify(ack)));
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('limited', 'rpc.ping'))));

      const responses = (socket.send as sinon.SinonStub).args.map(([response]) => JSON.parse(response));
      expect(responses).toHaveLength(3);
      expect(responses[0].error).toBeUndefined();
      expect(responses[1].error).toBeUndefined();
      expect(responses[2].error.code).toBe(JsonRpcErrorCodes.TooManyRequests);

      limiter.destroy();
      await connection.close();
    });

    it('should acknowledge catch-up events before a subscription opening activates', async () => {
      const socket = createMockSocket();
      const limiter = new RateLimiter({ refillRate: 1, maxTokens: 1 });
      const connection = new SocketConnection(socket, dwn, {
        ipRateLimiter : limiter,
        peerIp        : '192.0.2.1',
      });
      const opening = (connection as any).reserveSubscription('opening');
      const cursor = { streamId: 's', epoch: 'e', position: '1' };
      opening.listener({ type: 'eose', cursor });
      expect(opening.flowController.inFlightCount).toBe(1);
      (socket.send as sinon.SinonStub).resetHistory();

      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('ping', 'rpc.ping'))));
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcAck('opening', cursor))));

      expect(opening.flowController.inFlightCount).toBe(0);
      const responses = (socket.send as sinon.SinonStub).args.map(([response]) => JSON.parse(response));
      expect(responses.every((response) => response.error === undefined)).toBe(true);

      limiter.destroy();
      await connection.close();
    });

    it('should rate-limit malformed and non-advancing acknowledgements', async () => {
      const socket = createMockSocket();
      const limiter = new RateLimiter({ refillRate: 0.001, maxTokens: 2 });
      const connection = new SocketConnection(socket, dwn, {
        ipRateLimiter : limiter,
        peerIp        : '192.0.2.1',
      });
      (connection as any).reserveSubscription('opening');

      const malformedAck = createJsonRpcAck('opening', { streamId: 's', epoch: 'e', position: '1' });
      malformedAck.params = { cursor: null };
      await connection.message(Buffer.from(JSON.stringify(malformedAck)));
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcAck(
        'opening', { streamId: 's', epoch: 'e', position: '1' },
      ))));
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcRequest('limited', 'rpc.ping'))));

      const responses = (socket.send as sinon.SinonStub).args.map(([response]) => JSON.parse(response));
      expect(responses[0].error.code).toBe(JsonRpcErrorCodes.InvalidParams);
      expect(responses[1].error).toBeUndefined();
      expect(responses[2].error.code).toBe(JsonRpcErrorCodes.TooManyRequests);

      limiter.destroy();
      await connection.close();
    });

    it('should reserve subscription capacity before an opening request awaits the router', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn, { maxSubscriptions: 1 });
      let finishFirstRequest!: () => void;
      const firstRequestResult = new Promise<any>((resolve): void => {
        finishFirstRequest = (): void => resolve({
          jsonRpcResponse: createJsonRpcSuccessResponse('first', { reply: { status: { code: 200 } } }),
        });
      });
      const handleStub = sinon.stub(jsonRpcRouter, 'handle').returns(firstRequestResult);
      const subscribeMessage = { descriptor: { method: 'Subscribe' } };

      const firstRequest = createJsonRpcRequest('first', 'rpc.subscribe.dwn.processMessage', {
        message : subscribeMessage,
        target  : 'did:example:alice',
      });
      firstRequest.subscription = { id: 'opening' };
      const first = connection.message(Buffer.from(JSON.stringify(firstRequest)));
      await Promise.resolve();

      const secondRequest = createJsonRpcRequest('second', 'rpc.subscribe.dwn.processMessage', {
        message : subscribeMessage,
        target  : 'did:example:alice',
      });
      secondRequest.subscription = { id: 'second' };
      await connection.message(Buffer.from(JSON.stringify(secondRequest)));

      const rejected = JSON.parse((socket.send as sinon.SinonStub).lastCall.args[0]);
      expect(rejected.error.code).toBe(JsonRpcErrorCodes.TooManyRequests);
      expect(handleStub.calledOnce).toBe(true);

      finishFirstRequest();
      await first;
      expect((connection as any).subscriptionSlots.size).toBe(0);
      await connection.close();
    });

    it('should release opening capacity when a subscription request is rejected', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn, { maxSubscriptions: 1 });
      const handleStub = sinon.stub(jsonRpcRouter, 'handle').callsFake(async (request): Promise<any> => ({
        jsonRpcResponse: createJsonRpcErrorResponse(request.id!, JsonRpcErrorCodes.Unauthorized, 'not authorized'),
      }));
      const subscribeMessage = { descriptor: { method: 'Subscribe' } };

      for (const id of ['first', 'second']) {
        const request = createJsonRpcRequest(id, 'rpc.subscribe.dwn.processMessage', {
          message : subscribeMessage,
          target  : 'did:example:alice',
        });
        request.subscription = { id };
        await connection.message(Buffer.from(JSON.stringify(request)));
        expect((connection as any).subscriptionSlots.size).toBe(0);
      }

      expect(handleStub.callCount).toBe(2);
      await connection.close();
    });

    it('should not reserve capacity for a malformed subscription ID', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn, { maxSubscriptions: 1 });
      const request = createJsonRpcRequest('malformed', 'rpc.subscribe.dwn.processMessage', {
        message : { descriptor: { method: 'Subscribe' } },
        target  : 'did:example:alice',
      });
      request.subscription = {} as any;

      await connection.message(Buffer.from(JSON.stringify(request)));

      expect((connection as any).subscriptionSlots.size).toBe(0);
      const response = JSON.parse((socket.send as sinon.SinonStub).lastCall.args[0]);
      expect(response.error.code).toBe(JsonRpcErrorCodes.InvalidRequest);
      await connection.close();
    });
  });
});
