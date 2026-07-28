import type { ServerWebSocket } from 'bun';
import type { WsData } from '../../src/http-api.js';
import type { Dwn, ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';

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

describe('SocketConnection — overflow callback coverage', () => {
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

  it('should trigger overflow and close the subscription when buffer exceeds MAX_BUFFER_SIZE', async () => {
    const socket = createMockSocket();
    const maxInFlight = 1; // Small window so events quickly go to buffer.
    const connection = new SocketConnection(socket, dwn, { maxInFlight });

    const subId = 'overflow-sub-1';
    const opening = (connection as any).reserveSubscription(subId);
    const handler = opening.listener;
    await (connection as any).activateSubscription(opening, async (): Promise<void> => {});

    // Now push enough events to trigger overflow.
    // First event fills the window (maxInFlight = 1).
    const makeToken = (pos: string): ProgressToken => ({
      streamId: 's1', epoch: 'e1', position: pos, messageCid: `cid-${pos}`,
    });
    const makeEvent = (pos: string): SubscriptionMessage => ({
      type   : 'event',
      cursor : makeToken(pos),
      event  : { message: { descriptor: { interface: 'Records', method: 'Write' } } as any },
    });

    handler(makeEvent('1'));

    // Push MAX_BUFFER_SIZE + 1 events to trigger overflow.
    for (let i = 0; i <= MAX_BUFFER_SIZE; i++) {
      handler(makeEvent(String(i + 2)));
    }

    // Give the async closeSubscription time to run.
    await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

    // The subscription should have been closed.
    expect(connection.subscriptionCount).toBe(0);
    expect((connection as any).subscriptionSlots.has(subId)).toBe(false);

    await connection.close();
  });

  describe('ackSubscription()', () => {
    it('should ack a subscription via the flow controller', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn, { maxInFlight: 2 });

      const subId = 'ack-sub';
      const opening = (connection as any).reserveSubscription(subId);
      const handler = opening.listener;
      await (connection as any).activateSubscription(opening, async (): Promise<void> => {});

      const fc = (connection as any).subscriptionSlots.get(subId).flowController;

      const makeToken = (pos: string): any => ({
        streamId: 's1', epoch: 'e1', position: pos, messageCid: `cid-${pos}`,
      });
      const makeEvent = (pos: string): SubscriptionMessage => ({
        type   : 'event',
        cursor : makeToken(pos),
        event  : { message: { descriptor: { interface: 'Records', method: 'Write' } } as any },
      });

      handler(makeEvent('1'));
      handler(makeEvent('2'));
      handler(makeEvent('3')); // buffered

      expect(fc.inFlightCount).toBe(2);
      expect(fc.bufferCount).toBe(1);

      // Ack via the connection.
      connection.ackSubscription(subId, makeToken('2'));

      expect(fc.inFlightCount).toBe(1); // 'c' flushed
      expect(fc.bufferCount).toBe(0);

      await connection.close();
    });

    it('should be a no-op when acking a nonexistent subscription', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      // Acking an unknown subscription is a no-op: it must not throw and must
      // not register anything.
      expect(() => connection.ackSubscription('nonexistent', { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' })).not.toThrow();
      expect(connection.subscriptionCount).toBe(0);

      await connection.close();
    });
  });

  describe('subscriptionCount', () => {
    it('should return 0 when no subscriptions exist', async () => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);

      expect(connection.subscriptionCount).toBe(0);

      await connection.close();
    });
  });
});
