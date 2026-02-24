import type { Dwn } from '@enbox/dwn-sdk-js';
import type { ServerWebSocket } from 'bun';

import log from 'loglevel';
import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import type { WsData } from '../../src/http-api.js';

import { getTestDwn } from '../test-dwn.js';
import { SocketConnection } from '../../src/connection/socket-connection.js';

/** Creates a minimal mock of Bun's ServerWebSocket for unit testing. */
function createMockSocket(): ServerWebSocket<WsData> {
  return {
    data          : { connection: null as any },
    send          : sinon.stub(),
    sendText      : sinon.stub(),
    sendBinary    : sinon.stub(),
    close         : sinon.stub(),
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

describe('SocketConnection', () => {
  let dwn: Dwn;

  beforeAll(async () => {
    dwn = await getTestDwn();
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

  it('should add a subscription to the subscription manager map', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const subscriptionRequest = {
      id     : 'id',
      method : 'method',
      params : { param1: 'param' },
      close  : async ():Promise<void> => {}
    };

    await connection.addSubscription(subscriptionRequest);
    expect((connection as any).subscriptions.size).toBe(1);
    await connection.close();
    expect((connection as any).subscriptions.size).toBe(0);
  });

  it('should reject a subscription with an Id of an existing subscription', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);

    const id = 'some-id';

    const subscriptionRequest = {
      id,
      method : 'method',
      params : { param1: 'param' },
      close  : async ():Promise<void> => {}
    };

    await connection.addSubscription(subscriptionRequest);
    expect((connection as any).subscriptions.size).toBe(1);

    const addDuplicatePromise = connection.addSubscription(subscriptionRequest);
    await expect(addDuplicatePromise).rejects.toThrow(`the subscription with id ${id} already exists`);
    expect((connection as any).subscriptions.size).toBe(1);
    await connection.close();
    expect((connection as any).subscriptions.size).toBe(0);
  });

  it('should close a subscription and remove it from the connection manager map', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);

    const id = 'some-id';

    const subscriptionRequest = {
      id,
      method : 'method',
      params : { param1: 'param' },
      close  : async ():Promise<void> => {}
    };

    await connection.addSubscription(subscriptionRequest);
    expect((connection as any).subscriptions.size).toBe(1);

    await connection.closeSubscription(id);
    expect((connection as any).subscriptions.size).toBe(0);

    const closeAgainPromise = connection.closeSubscription(id);
    await expect(closeAgainPromise).rejects.toThrow(`the subscription with id ${id} was not found`);
    await connection.close();
  });

  it('hasSubscription returns whether a subscription with the id already exists', async () => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const subscriptionRequest = {
      id     : 'id',
      method : 'method',
      params : { param1: 'param' },
      close  : async ():Promise<void> => {}
    };

    await connection.addSubscription(subscriptionRequest);
    expect((connection as any).subscriptions.size).toBe(1);
    expect(connection.hasSubscription(subscriptionRequest.id)).toBe(true);
    expect(connection.hasSubscription('does-not-exist')).toBe(false);

    await connection.closeSubscription(subscriptionRequest.id);
    expect(connection.hasSubscription(subscriptionRequest.id)).toBe(false);
    await connection.close();
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
      expect(snapshot.subscriptions.length).toBe(0);

      await connection.close();
    });

    it('should reflect the correct subscription count after adding subscriptions', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      await connection.addSubscription({
        id     : 'snap-sub-1',
        method : 'method',
        params : {},
        close  : async (): Promise<void> => {},
      });

      const snapshot = connection.toSnapshot();
      expect(snapshot.subscriptionCount).toBe(1);

      await connection.close();
    });
  });

  describe('toSnapshot() with active flow controllers', () => {
    it('should include flow controller stats in subscription snapshots', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn, undefined, 10);

      // Populate the flowControllers map directly to simulate an active subscription.
      const { FlowController } = await import('../../src/connection/flow-controller.js');
      const fc = new FlowController('fc-sub-1', 10, () => {}, () => {});
      (connection as any).flowControllers.set('fc-sub-1', fc);

      // Also add a matching subscription entry so subscriptionCount is correct.
      (connection as any).subscriptions.set('fc-sub-1', {
        id    : 'fc-sub-1',
        close : async (): Promise<void> => {},
      });

      const snapshot = connection.toSnapshot();
      expect(snapshot.subscriptionCount).toBe(1);
      expect(snapshot.subscriptions.length).toBe(1);
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
  });
});
