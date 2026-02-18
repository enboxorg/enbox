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
});
