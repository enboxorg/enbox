import type { JsonRpcResponse } from '@enbox/dwn-clients';
import type { ServerWebSocket } from 'bun';
import type { WsData } from '../../src/http-api.js';
import type { Dwn, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { getTestDwn } from '../test-dwn.js';
import { RateLimiter } from '../../src/rate-limiter.js';
import { SocketConnection } from '../../src/connection/socket-connection.js';
import { createGate, openSocket } from './socket-test-utils.js';
import { createJsonRpcAck, createJsonRpcSubscriptionRequest } from '@enbox/dwn-clients';
import { executeUnlessAborted, MessagesSubscribe, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { MAX_BUFFER_SIZE, MAX_BUFFER_WAIT_MS } from '../../src/connection/flow-controller.js';

function createMockSocket(): ServerWebSocket<WsData> {
  return { send: sinon.stub(), close: sinon.stub(), ping: sinon.stub() } as unknown as ServerWebSocket<WsData>;
}

function makeMessage(position: string): SubscriptionMessage {
  return { type: 'eose', cursor: { streamId: 's1', epoch: 'e1', position } };
}

describe('Socket subscription lifetimes', () => {
  let dwn: Dwn;

  beforeAll(async (): Promise<void> => {
    ({ dwn } = await getTestDwn());
  });

  afterAll(async (): Promise<void> => {
    await dwn.close();
  });

  it('rejects duplicate active IDs without replacing their ACK controller', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, undefined, 1);
    const original = connection.beginSubscription('same-id');
    await original.register(async (): Promise<void> => {});
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [] });
    const processed = sinon.spy(dwn, 'processMessage');
    try {
      original.subscriptionHandler(makeMessage('1'));
      original.subscriptionHandler(makeMessage('2'));
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcSubscriptionRequest('duplicate', 'rpc.subscribe.dwn.processMessage',
        { target: alice.did, message: subscribe.message }, 'same-id'))));
      const responses = (socket.send as sinon.SinonStub).args.map(args => JSON.parse(args[0]));
      expect(responses.find(response => response.id === 'duplicate').error.code).toBe(-32602);
      expect(processed.called).toBe(false);
      expect(connection.toSnapshot().subscriptions[0]).toEqual({ id: 'same-id', inflight: 1, buffered: 1 });
      connection.ackSubscription('same-id', makeMessage('1').cursor);
      expect(connection.toSnapshot().subscriptions[0]).toEqual({ id: 'same-id', inflight: 1, buffered: 0 });
      expect((socket.send as sinon.SinonStub).callCount).toBe(3);
    } finally {
      processed.restore();
      await connection.close();
    }
  });

  it('rejects a concurrent duplicate, allows pending unsubscribe, and fences late cleanup after ID reuse', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn, undefined, 1);
    const entered = createGate();
    const blocked = createGate();
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [] });
    const sourceClose = sinon.stub().resolves();
    const processed = sinon.stub(dwn, 'processMessage').callsFake(async (_tenant, _message, options) => {
      options!.subscriptionHandler!(makeMessage('1'));
      options!.subscriptionHandler!(makeMessage('2'));
      entered.resolve();
      await blocked.promise;
      return { status: { code: 200, detail: 'OK' }, subscription: { id: 'source', close: sourceClose } };
    });
    const request = createJsonRpcSubscriptionRequest('opening', 'rpc.subscribe.dwn.processMessage',
      { target: alice.did, message: subscribe.message }, 'same-id');
    const opening = connection.message(Buffer.from(JSON.stringify(request)));
    try {
      await entered.promise;
      expect(connection.hasSubscription('same-id')).toBe(true);
      expect(connection.subscriptionCount).toBe(0);
      await connection.message(Buffer.from(JSON.stringify({ ...request, id: 'duplicate' })));
      expect(processed.callCount).toBe(1);
      connection.ackSubscription('same-id', makeMessage('1').cursor);
      expect(connection.toSnapshot().subscriptions[0]).toEqual({ id: 'same-id', inflight: 1, buffered: 0 });
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcSubscriptionRequest('cancel', 'rpc.subscribe.close', {}, 'same-id'))));
      expect(processed.firstCall.args[2]!.subscriptionSignal!.aborted).toBe(true);
      const current = connection.beginSubscription('same-id');
      await current.register(async (): Promise<void> => {});
      blocked.resolve();
      await opening;
      expect(sourceClose.calledOnce).toBe(true);
      expect(current.signal.aborted).toBe(false);
      expect(connection.subscriptionCount).toBe(1);
      current.subscriptionHandler(makeMessage('3'));
      expect(connection.toSnapshot().subscriptions[0]).toEqual({ id: 'same-id', inflight: 1, buffered: 0 });
      const responses = (socket.send as sinon.SinonStub).args.map(args => JSON.parse(args[0]));
      expect(responses.find(response => response.id === 'duplicate').error.code).toBe(-32602);
      expect(responses.find(response => response.id === 'cancel').error).toBeUndefined();
      expect(responses.find(response => response.id === 'opening').error.code).toBe(-32603);
    } finally {
      blocked.resolve();
      await opening;
      processed.restore();
      await connection.close();
    }
  });

  for (const outcome of ['denied', 'thrown']) {
    it(`releases failed opens (${outcome}) so the same ID can be used again`, async (): Promise<void> => {
      const socket = createMockSocket();
      const connection = new SocketConnection(socket, dwn);
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [] });
      const processed = sinon.stub(dwn, 'processMessage');
      if (outcome === 'denied') {
        processed.resolves({ status: { code: 401, detail: 'Unauthorized' } });
      } else {
        processed.rejects(new Error('source failure'));
      }
      try {
        await connection.message(Buffer.from(JSON.stringify(createJsonRpcSubscriptionRequest('request', 'rpc.subscribe.dwn.processMessage',
          { target: alice.did, message: subscribe.message }, 'retry-id'))));
        expect(connection.hasSubscription('retry-id')).toBe(false);
        expect(connection.toSnapshot().subscriptions).toEqual([]);
        expect(processed.firstCall.args[2]!.subscriptionSignal!.aborted).toBe(true);
        const replacement = connection.beginSubscription('retry-id');
        await replacement.release();
      } finally {
        processed.restore();
        await connection.close();
      }
    });
  }

  it('releases a rate-limited pending open before returning its rejection', async (): Promise<void> => {
    const socket = createMockSocket();
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 0.01 });
    const connection = new SocketConnection(socket, dwn, undefined, 1, undefined, undefined, undefined, undefined, limiter);
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [] });
    limiter.consume(alice.did);
    const processed = sinon.spy(dwn, 'processMessage');
    const begun = sinon.spy(connection, 'beginSubscription');
    try {
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcSubscriptionRequest('rate-limited', 'rpc.subscribe.dwn.processMessage',
        { target: alice.did, message: subscribe.message }, 'retry-id'))));
      expect(JSON.parse((socket.send as sinon.SinonStub).firstCall.args[0]).error.code).toBe(-50429);
      expect(processed.called).toBe(false);
      expect(begun.firstCall.returnValue.signal.aborted).toBe(true);
      expect(connection.hasSubscription('retry-id')).toBe(false);
      expect(connection.toSnapshot().subscriptions).toEqual([]);
    } finally {
      processed.restore();
      begun.restore();
      limiter.destroy();
      await connection.close();
    }
  });

  it('waits for an unsubscribe already in progress before finishing connection cleanup', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const blocked = createGate();
    const started = createGate();
    const old = connection.beginSubscription('same-id');
    await old.register(async (): Promise<void> => {
      started.resolve(); await blocked.promise;
    });
    const unsubscribing = connection.closeSubscription('same-id');
    try {
      await started.promise;
      expect(() => connection.beginSubscription('same-id')).toThrow('already exists');
      const current = connection.beginSubscription('sibling');
      await current.register(async (): Promise<void> => {});
      const closing = connection.close();
      expect((socket.close as sinon.SinonStub).called).toBe(false);
      blocked.resolve();
      await Promise.all([unsubscribing, closing]);
      expect((socket.close as sinon.SinonStub).calledOnce).toBe(true);
      expect(current.signal.aborted).toBe(true);
    } finally {
      blocked.resolve();
      await unsubscribing;
      await connection.close();
    }
  });

  it('rejects an opening reply when cancellation races handle registration', async (): Promise<void> => {
    const socket = createMockSocket();
    const connection = new SocketConnection(socket, dwn);
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [] });
    const sourceClose = sinon.stub().resolves();
    const processed = sinon.stub(dwn, 'processMessage').resolves({
      status       : { code: 200, detail: 'OK' },
      subscription : { id: 'source', close: sourceClose },
    });
    const begin = connection.beginSubscription.bind(connection);
    let cancelling: Promise<void> | undefined;
    const begun = sinon.stub(connection, 'beginSubscription').callsFake((id) => {
      const owned = begin(id);
      return {
        ...owned,
        register: (close): Promise<void> => {
          const registering = owned.register(close);
          cancelling = connection.closeSubscription(id);
          return registering;
        },
      };
    });
    try {
      await connection.message(Buffer.from(JSON.stringify(createJsonRpcSubscriptionRequest('request', 'rpc.subscribe.dwn.processMessage',
        { target: alice.did, message: subscribe.message }, 'racing-close'))));
      await cancelling;
      expect(JSON.parse((socket.send as sinon.SinonStub).firstCall.args[0]).error.code).toBe(-32603);
      expect(sourceClose.calledOnce).toBe(true);
      expect(connection.hasSubscription('racing-close')).toBe(false);
    } finally {
      processed.restore();
      begun.restore();
      await connection.close();
    }
  });

  it('closes the socket and healthy siblings when one source close rejects', async (): Promise<void> => {
    const socket = createMockSocket();
    const closed = sinon.spy();
    const connection = new SocketConnection(socket, dwn, closed);
    const bad = connection.beginSubscription('bad');
    const good = connection.beginSubscription('good');
    const goodClose = sinon.stub().resolves();
    await bad.register(async (): Promise<void> => {
      throw new Error('close failure');
    });
    await good.register(goodClose);
    await expect(connection.close()).rejects.toThrow('close failure');
    expect(goodClose.calledOnce).toBe(true);
    expect((socket.close as sinon.SinonStub).calledOnce).toBe(true);
    expect(closed.calledOnce).toBe(true);
    expect(connection.toSnapshot().subscriptions).toEqual([]);
  });

  for (const acknowledge of [false, true]) {
    it(`handles native replay beyond the buffer limit (acknowledge=${acknowledge})`, async (): Promise<void> => {
      const { dwn: liveDwn } = await getTestDwn({ withEvents: true });
      const store = liveDwn.storage.messageStore;
      const alice = await TestDataGenerator.generateDidKeyPersona();
      // Seed the actual SQL feed: replay more than the window plus the bounded buffer.
      for (let index = 0; index < 1_200; index++) {
        const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
        await store.put(alice.did, record.message, await record.recordsWrite.constructIndexes(true));
      }
      const cursor = (await store.logBounds(alice.did))!.oldest;
      const replied = createGate();
      const firstFrame = createGate();
      const eose = createGate();
      let clock: sinon.SinonFakeTimers | undefined;
      const responses: JsonRpcResponse[] = [];
      const socket = await openSocket(liveDwn, acknowledge ? 32 : 1);
      const { client, connection } = socket;
      client.addEventListener('message', (event): void => {
        const response = JSON.parse(event.data);
        responses.push(response);
        if (response.id === 'request') {
          replied.resolve();
        } else if (response.id === 'peer') {
          firstFrame.resolve();
          if (response.result.subscription.type === 'eose') {
            eose.resolve();
          }
          if (acknowledge) {
            client.send(JSON.stringify(createJsonRpcAck('peer', response.result.subscription.cursor)));
          }
        }
      });
      const subscribed = sinon.spy(liveDwn.storage.eventLog!, 'subscribe');
      const reads = sinon.spy(store, 'logRead');
      try {
        if (!acknowledge) {
          clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        }
        const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [{ interface: 'Records', method: 'Write' }], cursor });
        client.send(JSON.stringify(createJsonRpcSubscriptionRequest('request', 'rpc.subscribe.dwn.processMessage',
          { target: alice.did, message: subscribe.message }, 'peer')));
        if (!acknowledge) {
          await firstFrame.promise;
          expect(connection.toSnapshot().subscriptions[0].buffered).toBe(MAX_BUFFER_SIZE);
          clock!.tick(MAX_BUFFER_WAIT_MS);
        }
        await executeUnlessAborted(Promise.all([replied.promise, acknowledge ? eose.promise : Promise.resolve()]),
          AbortSignal.timeout(5_000));
        await socket.requests.get('request');
        if (acknowledge) {
          const events = responses.filter(response => response.id === 'peer' && response.result?.subscription?.type === 'event');
          expect(events.map(response => response.result!.subscription!.cursor.position))
            .toEqual(Array.from({ length: 1_200 }, (_value, index): string => String(index + 1)));
          expect(connection.subscriptionCount).toBe(1);
          expect(responses.find(response => response.id === 'request')?.result?.reply?.status.code).toBe(200);
        } else {
          expect(connection.subscriptionCount).toBe(0);
          expect(connection.hasSubscription('peer')).toBe(false);
          expect(connection.toSnapshot().subscriptions).toEqual([]);
          expect(subscribed.firstCall.args[3]!.signal!.aborted).toBe(true);
          const frames = responses.filter(response => response.id === 'peer');
          expect(frames.map(response => response.result.subscription.type)).toEqual(['event', 'error']);
          expect(frames[1].result.subscription.error.code).toBe('SubscriptionBufferTimeout');
          const response = responses.find(response => response.id === 'request')!;
          expect(response.error !== undefined || response.result?.reply?.status.code === 500).toBe(true);
          const readsAfterCancellation = reads.callCount;
          const later = await TestDataGenerator.generateRecordsWrite({ author: alice });
          await store.put(alice.did, later.message, await later.recordsWrite.constructIndexes(true));
          expect(reads.callCount).toBe(readsAfterCancellation);
        }
        // An open socket and a fresh ID remain usable after cancelling only the slow peer.
        const healthy = connection.beginSubscription('healthy');
        expect(healthy.signal.aborted).toBe(false);
        await healthy.release();
      } finally {
        clock?.restore();
        await socket.close();
        subscribed.restore();
        reads.restore();
        await liveDwn.close();
      }
    });
  }
});
