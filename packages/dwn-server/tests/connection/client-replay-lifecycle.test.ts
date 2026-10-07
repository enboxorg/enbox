import type { JsonRpcRequest } from '@enbox/dwn-clients';
import type { MessageSubscription, ProgressToken, ProtocolDefinition, SubscriptionError } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import { getTestDwn } from '../test-dwn.js';
import type { JsonRpcSocket } from '../../../dwn-clients/src/json-rpc-socket.js';
import { WebSocketDwnRpcClient } from '../../../dwn-clients/src/web-socket-clients.js';
import { createGate, startSocketServer } from './socket-test-utils.js';
import { DEFAULT_MAX_IN_FLIGHT, MAX_BUFFER_SIZE, MAX_BUFFER_WAIT_MS } from '../../src/connection/flow-controller.js';
import { executeUnlessAborted, MessagesQuery, MessagesSubscribe, ProtocolsConfigure, RecordsSubscribe, TestDataGenerator } from '@enbox/dwn-sdk-js';

type ClientConnection = { socket: JsonRpcSocket; subscriptions: Map<string, { lastCursor?: ProgressToken; closed: boolean }> };

function pooledConnection(url: string): ClientConnection {
  return (WebSocketDwnRpcClient as unknown as { connections: Map<string, ClientConnection> }).connections.get(url)!;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  await executeUnlessAborted((async (): Promise<void> => {
    while (!predicate()) {
      await Bun.sleep(1);
    }
  })(), AbortSignal.timeout(2_000));
}

async function warmConnection(url: string): Promise<{
  client: WebSocketDwnRpcClient;
  alice: Awaited<ReturnType<typeof TestDataGenerator.generateDidKeyPersona>>;
}> {
  const alice = await TestDataGenerator.generateDidKeyPersona();
  const client = new WebSocketDwnRpcClient();
  const query = await MessagesQuery.create({ signer: alice.signer, filters: [] });
  expect((await client.sendDwnRequest({ dwnUrl: url, targetDid: alice.did, message: query.message })).status.code).toBe(200);
  return { client, alice };
}

describe('Bundled client replay lifecycle', () => {
  it('reports a live ACK deadline and recovers buffered events from the processed cursor', async (): Promise<void> => {
    const { dwn } = await getTestDwn({ withEvents: true });
    const server = startSocketServer(dwn);
    const { client, alice } = await warmConnection(server.url);
    const store = dwn.storage.messageStore;
    const blocked = createGate();
    const released = createGate();
    const finished = createGate();
    const errors: SubscriptionError[] = [];
    const putRecord = async (): Promise<void> => {
      const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
      await store.put(alice.did, record.message, await record.recordsWrite.constructIndexes(true));
    };
    let initialHandle: MessageSubscription | undefined;
    let recoveredHandle: MessageSubscription | undefined;
    let clock: ReturnType<typeof sinon.useFakeTimers> | undefined;
    try {
      const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [] });
      const reply = await client.sendDwnRequest({
        dwnUrl       : server.url,
        targetDid    : alice.did,
        message      : subscribe.message,
        subscription : { handler: async (message): Promise<void> => {
          if (message.type === 'error') {
            errors.push(message);
          } else if (message.type === 'event' && message.cursor.position === '2') {
            blocked.resolve();
            await released.promise;
            finished.resolve();
          }
        } },
      });
      initialHandle = reply.subscription;
      expect(reply.status.code).toBe(200);
      const connection = pooledConnection(server.url);
      const tracked = [...connection.subscriptions.values()][0];
      const serverConnection = server.connections.values().next().value!;
      await putRecord();
      await waitUntil(() => tracked.lastCursor?.position === '1' && serverConnection.toSnapshot().subscriptions[0].inflight === 0);
      const processedCursor = tracked.lastCursor!;
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      for (let index = 0; index < 1_050; index++) {
        await putRecord();
      }
      await blocked.promise;
      await waitUntil(() => serverConnection.toSnapshot().subscriptions[0].buffered === MAX_BUFFER_SIZE);
      expect(serverConnection.toSnapshot().subscriptions[0].inflight).toBe(DEFAULT_MAX_IN_FLIGHT);
      clock.tick(MAX_BUFFER_WAIT_MS);
      await waitUntil(() => errors.length === 1 && connection.subscriptions.size === 0 && serverConnection.subscriptionCount === 0);
      clock.restore();
      expect(errors[0].error.code).toBe('SubscriptionBufferTimeout');
      expect(errors[0].cursor.position).toBe('1033');
      expect(tracked.closed).toBe(true);
      expect(tracked.lastCursor).toEqual(processedCursor);
      expect(connection.socket.isConnected).toBe(true);
      const query = await MessagesQuery.create({ signer: alice.signer, filters: [] });
      expect((await client.sendDwnRequest({ dwnUrl: server.url, targetDid: alice.did, message: query.message })).status.code).toBe(200);

      // Completion of the cancelled consumer cannot acknowledge or skip the buffered gap.
      released.resolve();
      await finished.promise;
      await Bun.sleep(10);
      expect(tracked.lastCursor).toEqual(processedCursor);
      const resumed = await MessagesSubscribe.create({ signer: alice.signer, filters: [], cursor: processedCursor });
      const positions: string[] = [];
      const eose = createGate();
      const recovered = await client.sendDwnRequest({
        dwnUrl       : server.url,
        targetDid    : alice.did,
        message      : resumed.message,
        subscription : { handler: (message): void => {
          if (message.type === 'event') {
            positions.push(message.cursor.position);
          } else if (message.type === 'eose') {
            eose.resolve();
          }
        } },
      });
      recoveredHandle = recovered.subscription;
      expect(recovered.status.code).toBe(200);
      await executeUnlessAborted(eose.promise, AbortSignal.timeout(2_000));
      expect(positions).toEqual(Array.from({ length: 1_050 }, (_, index): string => String(index + 2)));
      await putRecord();
      await waitUntil(() => positions.length === 1_051);
      expect(positions.at(-1)).toBe('1052');
      expect(errors).toHaveLength(1);
      expect(serverConnection.subscriptionCount).toBe(1);
      expect(connection.subscriptions.size).toBe(1);
    } finally {
      released.resolve();
      clock?.restore();
      await initialHandle?.close();
      await recoveredHandle?.close();
      await WebSocketDwnRpcClient.closeAllConnections();
      await server.close();
      await dwn.close();
    }
  });

  it('closes the replacement transport while reconnect replay is blocked', async (): Promise<void> => {
    const { dwn } = await getTestDwn({ withEvents: true });
    const server = startSocketServer(dwn);
    const { client, alice } = await warmConnection(server.url);
    const protocol = 'https://example.com/close-reconnect-replay';
    const definition: ProtocolDefinition = {
      protocol,
      published : true,
      types     : { note: { dataFormats: ['application/json'] } },
      structure : { note: { $recordLimit: { max: 1 } } },
    };
    const configure = await ProtocolsConfigure.create({ definition, signer: alice.signer });
    expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
    const first = await TestDataGenerator.generateRecordsWrite({ author: alice, protocol, protocolPath: 'note', dataFormat: 'application/json' });
    expect((await dwn.processMessage(alice.did, first.message, { dataStream: first.dataStream })).status.code).toBe(202);
    const store = dwn.storage.messageStore;
    const cursor = (await store.logBounds(alice.did))!.oldest;
    const entered = createGate();
    const released = createGate();
    const finished = createGate();
    const originalCount = store.count.bind(store);
    let replaying = false;
    const projection = sinon.stub(store, 'count').callsFake(async (...args): Promise<number> => {
      if (replaying) {
        replaying = false;
        entered.resolve();
        await released.promise;
        try {
          return await originalCount(...args);
        } finally {
          finished.resolve();
        }
      }
      return originalCount(...args);
    });
    const received: string[] = [];
    const connection = pooledConnection(server.url);
    const sent = sinon.spy(connection.socket, 'send');
    let handle: MessageSubscription | undefined;
    try {
      const subscribe = await RecordsSubscribe.create({ signer: alice.signer, filter: { protocol }, cursor });
      const reply = await client.sendDwnRequest({
        dwnUrl       : server.url,
        targetDid    : alice.did,
        message      : subscribe.message,
        subscription : {
          handler: (message): void => {
            received.push(message.type === 'event' || message.type === 'eose' ? `${message.type}:${message.cursor.position}` : message.type);
          },
          resubscribeFactory: async (cursor): Promise<typeof subscribe.message> => {
            replaying = true;
            return (await RecordsSubscribe.create({ signer: alice.signer, filter: { protocol }, cursor })).message;
          },
        },
      });
      handle = reply.subscription;
      expect(reply.status.code).toBe(200);
      await waitUntil(() => [...connection.subscriptions.values()][0].lastCursor?.position === '2');
      await server.connections.values().next().value!.close();
      const second = await TestDataGenerator.generateFromRecordsWrite({ author: alice, existingWrite: first.recordsWrite });
      expect((await dwn.processMessage(alice.did, second.message, { dataStream: second.dataStream })).status.code).toBe(202);
      await executeUnlessAborted(entered.promise, AbortSignal.timeout(3_000));
      const replacement = sent.args.map(args => args[0] as JsonRpcRequest)
        .filter(request => request.method === 'rpc.subscribe.dwn.processMessage')[1];
      const replacementConnection = server.connections.values().next().value!;
      expect(replacementConnection.hasSubscription(replacement.subscription!.id)).toBe(true);
      await handle!.close();
      expect(replacementConnection.hasSubscription(replacement.subscription!.id)).toBe(false);
      const receivedAfterClose = [...received];
      released.resolve();
      await finished.promise;
      await server.requests.get(replacement.id!);
      await Bun.sleep(10);
      expect(received).toEqual(receivedAfterClose);
      expect(replacementConnection.subscriptionCount).toBe(0);
    } finally {
      released.resolve();
      await handle?.close();
      projection.restore();
      sent.restore();
      await WebSocketDwnRpcClient.closeAllConnections();
      await server.close();
      await dwn.close();
    }
  });

  it('cancels a timed-out pending open and fences its late projection', async (): Promise<void> => {
    const { dwn } = await getTestDwn({ withEvents: true });
    const server = startSocketServer(dwn);
    const { client, alice } = await warmConnection(server.url);
    const protocol = 'https://example.com/slow-opening';
    const definition: ProtocolDefinition = {
      protocol,
      published : true,
      types     : { note: { dataFormats: ['application/json'] } },
      structure : { note: { $recordLimit: { max: 1 } } },
    };
    const configure = await ProtocolsConfigure.create({ definition, signer: alice.signer });
    expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
    const record = await TestDataGenerator.generateRecordsWrite({ author: alice, protocol, protocolPath: 'note', dataFormat: 'application/json' });
    expect((await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream })).status.code).toBe(202);
    const store = dwn.storage.messageStore;
    const cursor = (await store.logBounds(alice.did))!.oldest;
    const entered = createGate();
    const released = createGate();
    const finished = createGate();
    const originalCount = store.count.bind(store);
    const projection = sinon.stub(store, 'count').callsFake(async (...args): Promise<number> => {
      entered.resolve();
      await released.promise;
      try {
        return await originalCount(...args);
      } finally {
        finished.resolve();
      }
    });
    const connection = pooledConnection(server.url);
    const sent = sinon.spy(connection.socket, 'send');
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const received: string[] = [];
    const subscribe = await RecordsSubscribe.create({ signer: alice.signer, filter: { protocol }, cursor });
    const opening = client.sendDwnRequest({ dwnUrl       : server.url, targetDid    : alice.did, message      : subscribe.message,
      subscription : { handler: (message): void => {
        received.push(message.type);
      } } }).catch((error: unknown): unknown => error);
    try {
      await entered.promise;
      clock.tick(30_001);
      expect((await opening as Error).message).toBe('request timed out');
      const request = sent.args.map(args => args[0] as JsonRpcRequest).find(request => request.method === 'rpc.subscribe.dwn.processMessage')!;
      const id = request.subscription!.id;
      await waitUntil(() => !server.connections.values().next().value!.hasSubscription(id));
      expect(connection.subscriptions.size).toBe(0);
      expect((connection.socket as unknown as { messageHandlers: Map<unknown, unknown> }).messageHandlers.has(id)).toBe(false);
      released.resolve();
      await finished.promise;
      await server.requests.get(request.id!);
      expect(server.connections.values().next().value!.subscriptionCount).toBe(0);
      expect(received).toEqual([]);
    } finally {
      released.resolve();
      clock.restore();
      projection.restore();
      sent.restore();
      await WebSocketDwnRpcClient.closeAllConnections();
      await server.close();
      await dwn.close();
    }
  });

  for (const progressing of [false, true]) {
    it(`preserves early replay ACKs through native reconnect (progressing=${progressing})`, async (): Promise<void> => {
      const { dwn } = await getTestDwn({ withEvents: true });
      const server = startSocketServer(dwn);
      const { client, alice } = await warmConnection(server.url);
      const store = dwn.storage.messageStore;
      for (let index = 0; index < 2; index++) {
        const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
        await store.put(alice.did, record.message, await record.recordsWrite.constructIndexes(true));
      }
      const cursor = (await store.logBounds(alice.did))!.oldest;
      const captured = createGate();
      const released = createGate();
      const reconnected = createGate();
      const originalFingerprint = store.fingerprint.bind(store);
      let gated = false;
      const fingerprint = sinon.stub(store, 'fingerprint').callsFake(async (...args): Promise<string> => {
        if (!gated) {
          gated = true;
          captured.resolve();
          await released.promise;
        }
        return originalFingerprint(...args);
      });
      const positions: string[] = [];
      const factoryCursors: Array<ProgressToken | undefined> = [];
      const connection = pooledConnection(server.url);
      const sent = sinon.spy(connection.socket, 'send');
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const subscribe = await MessagesSubscribe.create({ signer: alice.signer, filters: [], cursor });
      let handle: MessageSubscription | undefined;
      const opening = client.sendDwnRequest({
        dwnUrl       : server.url,
        targetDid    : alice.did,
        message      : subscribe.message,
        subscription : {
          handler: (message): void => {
            if (message.type === 'event') {
              positions.push(message.cursor.position);
            }
            if (message.type === 'reconnected') {
              reconnected.resolve();
            }
          },
          resubscribeFactory: async (cursor): Promise<typeof subscribe.message> => {
            factoryCursors.push(cursor);
            return (await MessagesSubscribe.create({ signer: alice.signer, filters: [], cursor })).message;
          },
        },
      });
      let openingFailure: unknown;
      void opening.catch((error: unknown): void => {
        openingFailure = error;
      });
      try {
        await captured.promise;
        await waitUntil(() => sent.args.some(args => {
          const request = args[0] as JsonRpcRequest;
          return request.method === 'rpc.ack' && request.params.cursor.position === '2';
        }));
        expect(connection.subscriptions.size).toBe(0);
        for (const position of progressing ? ['3', '4'] : []) {
          clock.tick(20_000);
          const record = await TestDataGenerator.generateRecordsWrite({ author: alice });
          await store.put(alice.did, record.message, await record.recordsWrite.constructIndexes(true));
          await waitUntil(() => sent.args.some(args => {
            const request = args[0] as JsonRpcRequest;
            return request.method === 'rpc.ack' && request.params.cursor.position === position;
          }));
        }
        expect(openingFailure).toBeUndefined();
        released.resolve();
        const reply = await opening;
        handle = reply.subscription;
        expect(reply.status.code).toBe(200);
        expect([...connection.subscriptions.values()][0].lastCursor?.position).toBe(progressing ? '4' : '2');
        clock.restore();
        await server.connections.values().next().value!.close();
        await executeUnlessAborted(reconnected.promise, AbortSignal.timeout(3_000));
        expect(factoryCursors[0]?.position).toBe(progressing ? '4' : '2');
        expect(positions).toEqual(progressing ? ['1', '2', '3', '4'] : ['1', '2']);
      } finally {
        released.resolve();
        await opening.catch((): void => {});
        clock.restore();
        await handle?.close();
        sent.restore();
        fingerprint.restore();
        await WebSocketDwnRpcClient.closeAllConnections();
        await server.close();
        await dwn.close();
      }
    });
  }
});
