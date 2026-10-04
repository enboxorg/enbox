import type { ServerWebSocket } from 'bun';
import type { WsData } from '../../src/http-api.js';
import type { Dwn, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import log from 'loglevel';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { getTestDwn } from '../test-dwn.js';
import { MAX_BUFFER_SIZE } from '../../src/connection/flow-controller.js';
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

function makeMessage(position: string): SubscriptionMessage {
  return {
    type   : 'eose',
    cursor : { streamId: 's1', epoch: 'e1', position },
  };
}

describe('SocketConnection flow control', () => {
  let dwn: Dwn;

  beforeAll(async () => {
    ({ dwn } = await getTestDwn());
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    await dwn.close();
  });

  it('closes an active subscription on overflow and releases its frames', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, undefined, 1);
    const subscription = connection.beginSubscription('overflow-active');
    const close = sinon.stub().resolves();
    await subscription.register(close);
    try {
      for (let index = 0; index < MAX_BUFFER_SIZE + 2; index++) {
        subscription.subscriptionHandler(makeMessage(String(index + 1)));
      }
      expect(subscription.signal.aborted).toBe(true);
      expect(connection.hasSubscription('overflow-active')).toBe(false);
      expect(connection.toSnapshot().subscriptions).toEqual([]);
      await connection.close();
      expect(close.calledOnce).toBe(true);
      subscription.subscriptionHandler(makeMessage('later'));
      expect((socket.send as sinon.SinonStub).callCount).toBe(1);
    } finally {
      await connection.close();
    }
  });

  it('cancels a pending subscription on overflow and closes a late handle', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, undefined, 1);
    const subscription = connection.beginSubscription('overflow-pending');
    const healthy = connection.beginSubscription('healthy');
    const close = sinon.stub().resolves();
    try {
      for (let index = 0; index < MAX_BUFFER_SIZE + 2; index++) {
        subscription.subscriptionHandler(makeMessage(String(index + 1)));
      }
      expect(subscription.signal.aborted).toBe(true);
      expect(healthy.signal.aborted).toBe(false);
      expect(connection.hasSubscription('overflow-pending')).toBe(false);
      await expect(subscription.register(close)).rejects.toThrow('closed');
      expect(close.calledOnce).toBe(true);
      await subscription.release();
      healthy.subscriptionHandler(makeMessage('1'));
      expect((socket.send as sinon.SinonStub).callCount).toBe(2);
    } finally {
      await connection.close();
    }
  });

  it('logs a failed source close on overflow while clearing ownership', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, undefined, 1);
    const subscription = connection.beginSubscription('overflow-close-failure');
    const logged = sinon.stub(log, 'error');
    const close = sinon.stub().rejects(new Error('source close failed'));
    await subscription.register(close);
    for (let index = 0; index < MAX_BUFFER_SIZE + 2; index++) {
      subscription.subscriptionHandler(makeMessage(String(index + 1)));
    }
    await expect(connection.close()).rejects.toThrow('source close failed');
    expect(close.calledOnce).toBe(true);
    expect(logged.calledOnce).toBe(true);
    expect((socket.close as sinon.SinonStub).calledOnce).toBe(true);
    expect(connection.toSnapshot().subscriptions).toEqual([]);
  });

  it('acknowledges events through the original flow controller', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, undefined, 2);
    const subscription = connection.beginSubscription('ack-sub');
    await subscription.register(async (): Promise<void> => {});
    try {
      subscription.subscriptionHandler(makeMessage('1'));
      subscription.subscriptionHandler(makeMessage('2'));
      subscription.subscriptionHandler(makeMessage('3'));
      expect(connection.toSnapshot().subscriptions[0]).toEqual({ id: 'ack-sub', inflight: 2, buffered: 1 });
      connection.ackSubscription('ack-sub', makeMessage('2').cursor);
      expect(connection.toSnapshot().subscriptions[0]).toEqual({ id: 'ack-sub', inflight: 1, buffered: 0 });
      expect((socket.send as sinon.SinonStub).callCount).toBe(3);
    } finally {
      await connection.close();
    }
  });

  it('ignores ACKs for an unknown subscription', async (): Promise<void> => {
    const connection = new SocketConnection(createMockSocket(), dwn);
    try {
      expect(() => connection.ackSubscription('nonexistent', makeMessage('1').cursor)).not.toThrow();
      expect(connection.subscriptionCount).toBe(0);
    } finally {
      await connection.close();
    }
  });
});
