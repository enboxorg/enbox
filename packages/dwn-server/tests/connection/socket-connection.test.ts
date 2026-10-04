import type { JsonRpcSubscription } from '@enbox/dwn-clients';
import type { ServerWebSocket } from 'bun';
import type { WsData } from '../../src/http-api.js';
import type { Dwn, EventSubscription, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import log from 'loglevel';
import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import { DwnServerErrorCode } from '../../src/dwn-error.js';
import { getTestDwn } from '../test-dwn.js';
import { SocketConnection } from '../../src/connection/socket-connection.js';
import { executeUnlessAborted, ProtocolsConfigure, RecordsSubscribe, TestDataGenerator } from '@enbox/dwn-sdk-js';

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete): void => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function registerSubscription(connection: SocketConnection, handle: JsonRpcSubscription): Promise<void> {
  const subscription = connection.beginSubscription(handle.id);
  await subscription.register(handle.close);
}

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

describe('SocketConnection', () => {
  let dwn: Dwn;

  beforeAll(async () => {
    ({ dwn } = await getTestDwn());
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

    await registerSubscription(connection, subscriptionRequest);
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

    await registerSubscription(connection, subscriptionRequest);
    expect((connection as any).subscriptions.size).toBe(1);

    const addDuplicatePromise = registerSubscription(connection, subscriptionRequest);
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

    await registerSubscription(connection, subscriptionRequest);
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

    await registerSubscription(connection, subscriptionRequest);
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

      await registerSubscription(connection, {
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

      await registerSubscription(connection, {
        id    : 'fc-sub-1',
        close : async (): Promise<void> => {},
      });

      const snapshot = connection.toSnapshot();
      expect(snapshot.subscriptionCount).toBe(1);
      expect(snapshot.subscriptions).toHaveLength(1);
      expect(snapshot.subscriptions[0].id).toBe('fc-sub-1');
      expect(snapshot.subscriptions[0].inflight).toBe(0);
      expect(snapshot.subscriptions[0].buffered).toBe(0);

      await connection.close();
    });
  });

  it('should close a handle that finishes opening after its connection closes', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const close = sinon.stub().resolves();
    const subscription = connection.beginSubscription('late-handle');
    await connection.close();
    await expect(subscription.register(close)).rejects.toThrow(DwnServerErrorCode.ConnectionClosed);
    expect(close.calledOnce).toBe(true);
    expect(connection.subscriptionCount).toBe(0);
  });

  it('should join concurrent close calls and perform cleanup once', async (): Promise<void> => {
    const socket = createMockSocket();
    const closed = sinon.spy();
    const connection = new SocketConnection(socket, dwn, closed);
    const blocked = createGate();
    const started = createGate();
    let closes = 0;
    await registerSubscription(connection, {
      id    : 'slow-close',
      close : async (): Promise<void> => {
        closes++; started.resolve(); await blocked.promise;
      },
    });
    try {
      const first = connection.close();
      const second = connection.close();
      expect(first).toBe(second);
      await started.promise;
      expect(closes).toBe(1);
      expect(closed.called).toBe(false);
      blocked.resolve();
      await Promise.all([first, second]);
      expect(closed.calledOnce).toBe(true);
      expect((socket.close as sinon.SinonStub).calledOnce).toBe(true);
    } finally {
      blocked.resolve();
      await connection.close();
    }
  });

  it('should cancel native socket replay before its pending projection finishes and discard late results', async (): Promise<void> => {
    const { dwn: liveDwn } = await getTestDwn({ withEvents: true });
    const store = liveDwn.storage.messageStore;
    const eventLog = liveDwn.storage.eventLog!;
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const protocol = 'https://example.com/socket-subscription-lifetime';
    const definition: ProtocolDefinition = {
      protocol,
      published : true,
      types     : { note: { dataFormats: ['application/json'] } },
      structure : { note: { $recordLimit: { max: 1 } } },
    };
    const configure = await ProtocolsConfigure.create({ definition, signer: alice.signer });
    expect((await liveDwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
    const first = await TestDataGenerator.generateRecordsWrite({ author: alice, protocol, protocolPath: 'note', dataFormat: 'application/json' });
    expect((await liveDwn.processMessage(alice.did, first.message, { dataStream: first.dataStream })).status.code).toBe(202);
    const second = await TestDataGenerator.generateFromRecordsWrite({ author: alice, existingWrite: first.recordsWrite });
    expect((await liveDwn.processMessage(alice.did, second.message, { dataStream: second.dataStream })).status.code).toBe(202);
    const cursor = (await store.logBounds(alice.did))!.oldest;
    const blocked = createGate();
    const entered = createGate();
    const projectionFinished = createGate();
    let replayStarted = false;
    let gated = false;
    const originalSubscribe = eventLog.subscribe.bind(eventLog);
    const subscription = sinon.stub(eventLog, 'subscribe').callsFake((...args): Promise<EventSubscription> => {
      replayStarted = true;
      return originalSubscribe(...args);
    });
    const originalCount = store.count.bind(store);
    const projection = sinon.stub(store, 'count').callsFake(async (...args): Promise<number> => {
      if (replayStarted && !gated) {
        gated = true;
        entered.resolve();
        try {
          await blocked.promise;
          return await originalCount(...args);
        } finally {
          projectionFinished.resolve();
        }
      }
      return originalCount(...args);
    });
    const reads = sinon.spy(store, 'logRead');
    const socketOpened = createGate();
    const clientOpened = createGate();
    const socketClosed = createGate();
    const requestFinished = createGate();
    let connection!: SocketConnection;
    let pending!: Promise<void>;
    const server = Bun.serve<WsData>({
      hostname : '127.0.0.1',
      port     : 0,
      fetch    : (request, server): Response | undefined => {
        if (server.upgrade(request, { data: { connection: null } })) {
          return;
        }
        return new Response('upgrade required', { status: 400 });
      },
      websocket: {
        open: (socket): void => {
          connection = new SocketConnection(socket, liveDwn);
          socket.data.connection = connection;
          socketOpened.resolve();
        },
        message: (_socket, data): Promise<void> => {
          const bytes = typeof data === 'string' ? Buffer.from(data) : data;
          pending = connection.message(bytes).finally((): void => {
            requestFinished.resolve();
          });
          return pending;
        },
        close: async (): Promise<void> => {
          await connection.close();
          socketClosed.resolve();
        },
      },
    });
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    client.addEventListener('open', clientOpened.resolve, { once: true });
    try {
      await clientOpened.promise;
      await socketOpened.promise;
      const subscribe = await RecordsSubscribe.create({ signer: alice.signer, filter: { protocol }, cursor });
      client.send(JSON.stringify({
        jsonrpc      : '2.0',
        id           : 'request',
        method       : 'rpc.subscribe.dwn.processMessage',
        params       : { target: alice.did, message: subscribe.message },
        subscription : { id: 'subscription' },
      }));
      await entered.promise;
      expect(connection.subscriptionCount).toBe(0);
      client.close();
      await socketClosed.promise;
      // The database count is still blocked: cancellation must settle the request first.
      await executeUnlessAborted(requestFinished.promise, AbortSignal.timeout(1_000));
      await pending;
      expect(connection.subscriptionCount).toBe(0);
      const readsAfterClose = reads.callCount;
      blocked.resolve();
      await projectionFinished.promise;
      const third = await TestDataGenerator.generateFromRecordsWrite({ author: alice, existingWrite: second.recordsWrite });
      expect((await liveDwn.processMessage(alice.did, third.message, { dataStream: third.dataStream })).status.code).toBe(202);
      expect(reads.callCount).toBe(readsAfterClose);
      expect(connection.subscriptionCount).toBe(0);
    } finally {
      blocked.resolve();
      client.close();
      await connection?.close();
      await pending?.catch((): void => {});
      server.stop(true);
      subscription.restore();
      projection.restore();
      reads.restore();
      await liveDwn.close();
    }
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
