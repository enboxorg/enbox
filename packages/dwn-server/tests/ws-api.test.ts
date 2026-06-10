import type { Dialect } from '@enbox/dwn-sql-store';
import type { SinonFakeTimers } from 'sinon';
import type { Dwn, MessageEvent, ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { base64url } from 'multiformats/bases/base64';
import { useFakeTimers } from 'sinon';
import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Message, RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { config } from '../src/config.js';
import { getTestDwn } from './test-dwn.js';
import { HttpApi } from '../src/http-api.js';
import { WsApi } from '../src/ws-api.js';
import { createJsonRpcAck, createJsonRpcRequest, createJsonRpcSubscriptionRequest, HttpDwnRpcClient, JsonRpcErrorCodes, JsonRpcSocket, WebSocketDwnRpcClient } from '@enbox/dwn-clients';
import { createRecordsWriteMessage, sendHttpMessage, sendWsMessage, waitUntil } from './utils.js';


describe('websocket api', function () {
  let httpApi: HttpApi;
  let wsApi: WsApi;
  let dwn: Dwn;
  let dialect: Dialect;
  let clock: SinonFakeTimers;
  let wsUrl: string;
  let httpUrl: string;

  beforeAll(() => {
    clock = useFakeTimers({ shouldAdvanceTime: true });
  });

  afterAll(() => {
    clock.restore();
  });

  beforeEach(async function () {
    ({ dwn, dialect } = await getTestDwn({ withEvents: true }));
    httpApi = await HttpApi.create(config, dwn, undefined, undefined, undefined, { ttlCacheDialect: dialect });
    await httpApi.start(0);
    const port = httpApi.server.port;
    wsUrl = `ws://127.0.0.1:${port}`;
    httpUrl = `http://localhost:${port}`;
    wsApi = new WsApi(httpApi, dwn);
    wsApi.start();
  });

  afterEach(async function () {
    await wsApi.close();
    await httpApi.close();
    await dwn.close();
  });

  it('should expose the connection manager via the getter', () => {
    const cm = wsApi.connectionManager;
    expect(cm).toBeDefined();
    expect(typeof cm.connect).toBe('function');
    expect(typeof cm.closeAll).toBe('function');
    expect(typeof cm.getConnectionCount).toBe('function');
    expect(typeof cm.getSubscriptionCount).toBe('function');
  });

  it('returns an error response if no request payload is provided', async function () {
    const data = await sendWsMessage(wsUrl, Buffer.from(''));

    const resp = JSON.parse(data.toString());
    expect(resp.error.code).toBe(JsonRpcErrorCodes.BadRequest);
    expect(resp.error.message).toBe('request payload required.');
  });

  it('returns an error response if parsing dwn request fails', async function () {
    const data = await sendWsMessage(
      wsUrl,
      Buffer.from('@#$%^&*&%$#'),
    );

    const resp = JSON.parse(data.toString());
    expect(resp.error.code).toBe(JsonRpcErrorCodes.BadRequest);
    expect(resp.error.message).toContain('JSON');
  });

  it('RecordsWrite messages are not supported', async function () {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
    const dataBytes = await DataStream.toBytes(dataStream);
    const encodedData = base64url.baseEncode(dataBytes);

    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
      encodedData,
    });

    const connection = await JsonRpcSocket.connect(wsUrl);
    const response = await connection.request(dwnRequest);

    expect(response.id).toBe(requestId);
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(response.error.message).toContain('RecordsWrite is not supported via ws');
  });

  it('applies replicated RecordsWrite messages with large data over HTTP', async function () {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const dataBytes = new Uint8Array(1_048_577);
    dataBytes.fill(17);
    dataBytes[0] = 1;
    dataBytes[dataBytes.length - 1] = 254;
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data: dataBytes });

    const result = await new HttpDwnRpcClient().applyReplicatedMessage({
      dwnUrl    : httpUrl,
      targetDid : alice.did,
      message   : recordsWrite.toJSON(),
      data      : dataStream,
    });

    expect(result).toEqual({ kind: 'Applied' });

    const recordsRead = await RecordsRead.create({
      signer : alice.signer,
      filter : { recordId: recordsWrite.message.recordId },
    });
    const readReply = await dwn.processMessage(alice.did, recordsRead.toJSON());

    expect(readReply.status.code).toBe(200);
    expect(readReply.entry?.data).toBeDefined();
    const readBytes = await DataStream.toBytes(readReply.entry!.data!);
    expect(readBytes).toEqual(dataBytes);
  });

  it('applies replicated RecordsWrite messages with large data over WebSocket', async function () {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const dataBytes = new Uint8Array(1_048_577);
    dataBytes.fill(23);
    dataBytes[0] = 1;
    dataBytes[dataBytes.length - 1] = 255;
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data: dataBytes });

    const result = await new WebSocketDwnRpcClient().applyReplicatedMessage({
      dwnUrl    : wsUrl,
      targetDid : alice.did,
      message   : recordsWrite.toJSON(),
      data      : dataStream,
    });

    expect(result).toEqual({ kind: 'Applied' });

    const recordsRead = await RecordsRead.create({
      signer : alice.signer,
      filter : { recordId: recordsWrite.message.recordId },
    });
    const readReply = await dwn.processMessage(alice.did, recordsRead.toJSON());

    expect(readReply.status.code).toBe(200);
    expect(readReply.entry?.data).toBeDefined();
    const readBytes = await DataStream.toBytes(readReply.entry!.data!);
    expect(readBytes).toEqual(dataBytes);
  });

  it('rejects data-bearing replicated RecordsWrite messages without data over WebSocket', async function () {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { recordsWrite } = await createRecordsWriteMessage(alice);
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const connection = await JsonRpcSocket.connect(wsUrl);
    const response = await connection.request(dwnRequest);

    expect(response.id).toBe(requestId);
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(response.error?.message).toContain('RecordsWrite is not supported via ws');
    connection.close();
  });

  it('returns a typed error for encoded replicated apply data over the raw record limit', async function () {
    await wsApi.close();
    await httpApi.close();

    const originalMaxRecordDataSize = config.maxRecordDataSize;
    config.maxRecordDataSize = 8;
    httpApi = await HttpApi.create(config, dwn, undefined, undefined, undefined, { ttlCacheDialect: dialect });
    await httpApi.start(0);
    wsUrl = `ws://127.0.0.1:${httpApi.server.port}`;
    httpUrl = `http://localhost:${httpApi.server.port}`;
    wsApi = new WsApi(httpApi, dwn);
    wsApi.start();

    let connection: JsonRpcSocket | undefined;
    try {
      const requestId = uuidv4();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
        encodedData : base64url.baseEncode(new Uint8Array(9)),
        message     : {
          descriptor: {
            dataSize  : 9,
            interface : 'Records',
            method    : 'Write',
          },
        },
        target: 'did:example:alice',
      });

      connection = await JsonRpcSocket.connect(wsUrl);
      const response = await connection.request(dwnRequest);

      expect(response.id).toBe(requestId);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(JsonRpcErrorCodes.InvalidParams);
      expect(response.error?.message).toContain('exceeds max record data size');
    } finally {
      config.maxRecordDataSize = originalMaxRecordDataSize;
      connection?.close();
    }
  });

  it('subscribes to records and receives updates', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : {
        schema: 'foo/bar'
      }
    });

    const records: string[] = [];
    const subscriptionHandler = async (event: MessageEvent): Promise<void> => {
      const { message } = event;
      records.push(await Message.getCid(message));
    };

    const requestId = uuidv4();
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.dwn.processMessage', {
      message : message,
      target  : alice.did,
    });

    const connection = await JsonRpcSocket.connect(wsUrl);
    const { response, close } = await connection.subscribe(dwnRequest, (response) => {
      const subscriptionMsg = response.result.subscription;
      if (!subscriptionMsg || subscriptionMsg.type !== 'event') {
        return;
      }
      subscriptionHandler(subscriptionMsg.event);
    });

    expect(response.error).toBeUndefined();
    expect(response.result.reply.status.code).toBe(200);
    expect(close).toBeDefined();

    const write1Message = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult1 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : write1Message.message,
      data    : write1Message.dataBytes,
    });
    expect(writeResult1.status.code).toBe(202);

    const write2Message = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult2 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : write2Message.message,
      data    : write2Message.dataBytes,
    });
    expect(writeResult2.status.code).toBe(202);

    await waitUntil(() => records.length >= 2);

    // close the subscription
    await close();

    const expectedMembers = [
      await Message.getCid(write1Message.message),
      await Message.getCid(write2Message.message)
    ].sort();
    expect([...records].sort()).toEqual(expectedMembers);
  });

  it('stops receiving updates when subscription is closed', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : {
        schema: 'foo/bar'
      }
    });

    const records: string[] = [];
    const subscriptionHandler = async (event: MessageEvent): Promise<void> => {
      const { message } = event;
      records.push(await Message.getCid(message));
    };

    const requestId = uuidv4();
    const subscribeId = uuidv4();
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.dwn.processMessage', {
      message : message,
      target  : alice.did,
    }, subscribeId);

    const connection = await JsonRpcSocket.connect(wsUrl);
    const { response, close } = await connection.subscribe(dwnRequest, (response) => {
      const subscriptionMsg = response.result.subscription;
      if (!subscriptionMsg || subscriptionMsg.type !== 'event') {
        return;
      }
      subscriptionHandler(subscriptionMsg.event);
    });

    expect(response.error).toBeUndefined();
    expect(response.result.reply.status.code).toBe(200);
    expect(close).toBeDefined();

    const write1Message = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult1 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : write1Message.message,
      data    : write1Message.dataBytes,
    });
    expect(writeResult1.status.code).toBe(202);

    // wait for the subscription event to arrive via WebSocket before closing
    await waitUntil(() => records.length >= 1);

    // close the subscription after only 1 message
    await close();

    // write more messages that won't show up in the subscription
    const write2Message = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult2 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : write2Message.message,
      data    : write2Message.dataBytes,
    });
    expect(writeResult2.status.code).toBe(202);

    const write3Message = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult3 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : write3Message.message,
      data    : write3Message.dataBytes,
    });
    expect(writeResult3.status.code).toBe(202);

    await new Promise(resolve => setTimeout(resolve, 5)); // wait for records to be processed
    const expectedMembers = [ await Message.getCid(write1Message.message) ].sort();
    expect([...records].sort()).toEqual(expectedMembers);
  });

  it('should fail to add subscription using a `JsonRpcId` that already exists for a subscription in that socket', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : {
        schema: 'foo/bar'
      }
    });

    const records: string[] = [];
    const subscriptionHandler = async (event: MessageEvent): Promise<void> => {
      const { message } = event;
      records.push(await Message.getCid(message));
    };

    const requestId = uuidv4();
    const subscribeId = uuidv4();
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.dwn.processMessage', {
      message : message,
      target  : alice.did
    }, subscribeId);

    const connection = await JsonRpcSocket.connect(wsUrl);
    const { close } = await connection.subscribe(dwnRequest, (response) => {
      const subscriptionMsg = response.result.subscription;
      if (!subscriptionMsg || subscriptionMsg.type !== 'event') {
        return;
      }
      subscriptionHandler(subscriptionMsg.event);
    });

    const { message: message2 } = await TestDataGenerator.generateRecordsSubscribe({ filter: { schema: 'bar/baz' }, author: alice });

    // We are checking for the subscription Id not the request Id
    const request2Id = uuidv4();
    const dwnRequest2 = createJsonRpcSubscriptionRequest(request2Id, 'rpc.subscribe.dwn.processMessage', {
      message : message2,
      target  : alice.did
    }, subscribeId);

    const { response: response2 } = await connection.subscribe(dwnRequest2, (response) => {
      const subscriptionMsg = response.result.subscription;
      if (!subscriptionMsg || subscriptionMsg.type !== 'event') {
        return;
      }
      subscriptionHandler(subscriptionMsg.event);
    });

    expect(response2.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(response2.error.message).toContain(`${subscribeId} is in use by an active subscription`);

    const write1Message = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult1 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : write1Message.message,
      data    : write1Message.dataBytes,
    });
    expect(writeResult1.status.code).toBe(202);

    const write2Message = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult2 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : write2Message.message,
      data    : write2Message.dataBytes,
    });
    expect(writeResult2.status.code).toBe(202);

    await waitUntil(() => records.length >= 2);

    // close the subscription
    await close();

    const expectedMembers = [
      await Message.getCid(write1Message.message),
      await Message.getCid(write2Message.message)
    ].sort();
    expect([...records].sort()).toEqual(expectedMembers);
  });

  it('should receive an updated message as well as the initial write when subscribing to a record', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    // write an initial message
    const initialWrite = await TestDataGenerator.generateRecordsWrite({
      author     : alice,
      schema     : 'foo/bar',
      dataFormat : 'text/plain'
    });

    const writeResult1 = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : initialWrite.message,
      data    : initialWrite.dataBytes,
    });
    expect(writeResult1.status.code).toBe(202);

    // subscribe to 'foo/bar' messages
    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : {
        schema: 'foo/bar'
      }
    });

    const records: string[] = [];
    const subscriptionHandler = async (event: MessageEvent): Promise<void> => {
      const { message, initialWrite } = event;
      if (initialWrite) {
        records.push(await Message.getCid(initialWrite));
      }
      records.push(await Message.getCid(message));
    };

    const requestId = uuidv4();
    const subscribeId = uuidv4();
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.dwn.processMessage', {
      message : message,
      target  : alice.did
    }, subscribeId);

    const connection = await JsonRpcSocket.connect(wsUrl);
    const { close } = await connection.subscribe(dwnRequest, (response) => {
      const subscriptionMsg = response.result.subscription;
      if (!subscriptionMsg || subscriptionMsg.type !== 'event') {
        return;
      }
      subscriptionHandler(subscriptionMsg.event);
    });

    // wait for potential records to process and confirm that initial write has not been processed
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(records).toHaveLength(0);

    // update the initial message
    const updatedMessage = await TestDataGenerator.generateFromRecordsWrite({
      author        : alice,
      existingWrite : initialWrite.recordsWrite,
    });

    const updateResult = await sendHttpMessage({
      url     : httpUrl,
      target  : alice.did,
      message : updatedMessage.message,
      data    : updatedMessage.dataBytes,
    });
    expect(updateResult.status.code).toBe(202);

    await waitUntil(() => records.length >= 2);

    // close the subscription
    await close();

    // both initial and update should exist now
    const expectedMembers = [
      await Message.getCid(initialWrite.message),
      await Message.getCid(updatedMessage.message)
    ].sort();
    expect([...records].sort()).toEqual(expectedMembers);
  });
});

describe('websocket backpressure (rpc.ack)', function () {
  let httpApi: HttpApi;
  let wsApi: WsApi;
  let dwn: Dwn;
  let dialect: Dialect;
  let clock: SinonFakeTimers;
  let wsUrl: string;
  let httpUrl: string;

  beforeAll(() => {
    clock = useFakeTimers({ shouldAdvanceTime: true });
  });

  afterAll(() => {
    clock.restore();
  });

  afterEach(async function () {
    await wsApi.close();
    await httpApi.close();
    await dwn.close();
  });

  /**
   * Helper: creates the DWN + HTTP + WS stack with a custom maxInFlight.
   */
  async function setupServer(maxInFlight: number): Promise<void> {
    ({ dwn, dialect } = await getTestDwn({ withEvents: true }));
    httpApi = await HttpApi.create(config, dwn, undefined, undefined, undefined, { ttlCacheDialect: dialect });
    await httpApi.start(0);
    const port = httpApi.server.port;
    wsUrl = `ws://127.0.0.1:${port}`;
    httpUrl = `http://localhost:${port}`;
    wsApi = new WsApi(httpApi, dwn, { maxInFlight });
    wsApi.start();
  }

  /**
   * Helper: opens a raw WebSocket (from `ws` package) and subscribes to foo/bar records.
   * Returns tools to observe events, send acks, and close.
   *
   * This bypasses JsonRpcSocket to avoid auto-ack behavior, giving full control
   * over the flow-control window for testing.
   */
  async function rawSubscribe(
    alice: { did: string; signer: any },
    subscribeMessage: any,
  ): Promise<{
    receivedMessages: SubscriptionMessage[];
    subscriptionId: string;
    socket: WebSocket;
    sendAck: (cursor: string) => void;
    waitForMessages: (count: number, timeoutMs?: number) => Promise<void>;
    close: () => Promise<void>;
  }> {
    const receivedMessages: SubscriptionMessage[] = [];
    const requestId = uuidv4();
    const subscriptionId = uuidv4();

    const socket = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      socket.onopen = (): void => resolve();
      socket.onerror = (err): void => reject(err);
      setTimeout(() => reject(new Error('raw WS connect timeout')), 3000);
    });

    // Send the subscribe request
    const subscribeRequest = createJsonRpcSubscriptionRequest(
      requestId, 'rpc.subscribe.dwn.processMessage',
      { message: subscribeMessage, target: alice.did },
      subscriptionId,
    );
    socket.send(JSON.stringify(subscribeRequest));

    // Wait for the subscription confirmation response (matched by request id)
    await new Promise<void>((resolve, reject) => {
      const handler = (event: { data: any }): void => {
        const data = JSON.parse(event.data.toString());
        if (data.id === requestId) {
          socket.removeEventListener('message', handler);
          if (data.error) {
            reject(new Error(`subscribe failed: ${data.error.message}`));
          } else {
            resolve();
          }
        }
      };
      socket.addEventListener('message', handler);
      setTimeout(() => reject(new Error('subscribe response timeout')), 3000);
    });

    // Now listen for subscription event messages (matched by subscription id)
    socket.addEventListener('message', (event: { data: any }) => {
      const data = JSON.parse(event.data.toString());
      if (data.id === subscriptionId && data.result?.subscription) {
        receivedMessages.push(data.result.subscription as SubscriptionMessage);
      }
    });

    const sendAck = (cursor: ProgressToken): void => {
      const ackRequest = createJsonRpcAck(subscriptionId, cursor);
      socket.send(JSON.stringify(ackRequest));
    };

    const waitForMessages = async (count: number, timeoutMs = 2000): Promise<void> => {
      await waitUntil(() => receivedMessages.length >= count, timeoutMs);
    };

    const close = async (): Promise<void> => {
      // Send subscription close request
      const closeRequestId = uuidv4();
      const closeRequest = createJsonRpcSubscriptionRequest(
        closeRequestId, 'rpc.subscribe.close', {}, subscriptionId
      );
      socket.send(JSON.stringify(closeRequest));
      await new Promise(resolve => setTimeout(resolve, 50));
      socket.close();
    };

    return { receivedMessages, subscriptionId, socket, sendAck, waitForMessages, close };
  }

  /**
   * Helper: writes N records for a given persona and schema via HTTP, returning CIDs.
   */
  async function writeRecords(alice: any, count: number, schema = 'foo/bar'): Promise<string[]> {
    const cids: string[] = [];
    for (let i = 0; i < count; i++) {
      const writeMessage = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        schema,
        dataFormat : 'text/plain'
      });

      const writeResult = await sendHttpMessage({
        url     : httpUrl,
        target  : alice.did,
        message : writeMessage.message,
        data    : writeMessage.dataBytes,
      });
      expect(writeResult.status.code).toBe(202);
      cids.push(await Message.getCid(writeMessage.message));
    }
    return cids;
  }

  it('should buffer events when maxInFlight is reached and flush on rpc.ack', async () => {
    await setupServer(2); // maxInFlight = 2

    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'foo/bar' }
    });

    const { receivedMessages, sendAck, waitForMessages, close } = await rawSubscribe(alice, message);

    // Write 4 records — only 2 should be delivered (maxInFlight=2)
    const cids = await writeRecords(alice, 4);

    // Wait for the first 2 to arrive
    await waitForMessages(2);

    // Give some extra time to make sure no more arrive
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedMessages).toHaveLength(2);

    // Ack the 2nd cursor — should free 2 slots and flush 2 buffered events
    sendAck(receivedMessages[1].cursor);

    await waitForMessages(4);
    expect(receivedMessages).toHaveLength(4);

    // All 4 CIDs should be accounted for
    const receivedCids = await Promise.all(
      receivedMessages
        .filter((m): boolean => m.type === 'event')
        .map(async (m) => Message.getCid(m.event.message))
    );
    expect(receivedCids.sort()).toEqual([...cids].sort());

    await close();
  });

  it('should deliver events incrementally as individual rpc.ack messages are sent', async () => {
    await setupServer(1); // maxInFlight = 1

    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'foo/bar' }
    });

    const { receivedMessages, sendAck, waitForMessages, close } = await rawSubscribe(alice, message);

    // Write 3 records
    await writeRecords(alice, 3);

    // Only 1 should arrive (maxInFlight=1)
    await waitForMessages(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedMessages).toHaveLength(1);

    // Ack it — next event should arrive
    sendAck(receivedMessages[0].cursor);
    await waitForMessages(2);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedMessages).toHaveLength(2);

    // Ack again — third event should arrive
    sendAck(receivedMessages[1].cursor);
    await waitForMessages(3);
    expect(receivedMessages).toHaveLength(3);

    await close();
  });

  it('should work with auto-ack from JsonRpcSocket client when many events exceed maxInFlight', async () => {
    await setupServer(2); // maxInFlight = 2

    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'foo/bar' }
    });

    // Use the regular JsonRpcSocket client which auto-acks via WebSocketDwnRpcClient logic.
    // Here we replicate auto-ack inline.
    const records: string[] = [];
    const connection = await JsonRpcSocket.connect(wsUrl);
    const subscriptionId = uuidv4();

    const dwnRequest = createJsonRpcSubscriptionRequest(
      uuidv4(), 'rpc.subscribe.dwn.processMessage',
      { message, target: alice.did },
      subscriptionId,
    );

    const { response, close } = await connection.subscribe(dwnRequest, (resp) => {
      const subscriptionMsg = resp.result?.subscription as SubscriptionMessage;
      if (!subscriptionMsg || subscriptionMsg.type !== 'event') {
        return;
      }

      Message.getCid(subscriptionMsg.event.message).then((cid) => records.push(cid));

      // Auto-ack like the real client does
      if (subscriptionMsg.cursor) {
        connection.send(createJsonRpcAck(subscriptionId, subscriptionMsg.cursor));
      }
    });

    expect(response.error).toBeUndefined();
    expect(response.result.reply.status.code).toBe(200);

    // Write 5 records — more than maxInFlight, but auto-ack should drain them all
    const cids = await writeRecords(alice, 5);
    await waitUntil(() => records.length >= 5);

    expect(records.sort()).toEqual([...cids].sort());

    await close();
  });

  it('should buffer many events and drain them all when acked', async () => {
    await setupServer(1); // maxInFlight = 1

    const alice = await TestDataGenerator.generateDidKeyPersona();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const { message } = await TestDataGenerator.generateRecordsSubscribe({
      author : alice,
      filter : { schema: 'foo/bar' }
    });

    const { receivedMessages, sendAck, waitForMessages, close } = await rawSubscribe(alice, message);

    // Write 10 records — only 1 should be delivered immediately (maxInFlight=1)
    const cids = await writeRecords(alice, 10);
    await waitForMessages(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedMessages).toHaveLength(1);

    // Drain all 10 by acking one at a time
    for (let i = 0; i < 9; i++) {
      sendAck(receivedMessages[receivedMessages.length - 1].cursor);
      await waitForMessages(receivedMessages.length + 1);
    }

    expect(receivedMessages).toHaveLength(10);

    const receivedCids = await Promise.all(
      receivedMessages
        .filter((m): boolean => m.type === 'event')
        .map(async (m) => Message.getCid(m.event.message))
    );
    expect(receivedCids.sort()).toEqual([...cids].sort());

    await close();
  });

  it('should handle rpc.ack for an unknown subscription gracefully', async () => {
    await setupServer(2);

    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = (): void => resolve();
      socket.onerror = (err): void => reject(err);
      setTimeout(() => reject(new Error('connect timeout')), 3000);
    });

    // Send an ack for a subscription that doesn't exist
    const ackRequest = createJsonRpcAck('nonexistent-sub-id', { streamId: 's1', epoch: 'e1', position: '1', messageCid: 'cid-1' });
    socket.send(JSON.stringify(ackRequest));

    // Should get back a success response (the handler still responds 200 OK
    // because ackSubscription silently ignores unknown flow controllers)
    const response = await new Promise<any>((resolve, reject) => {
      socket.addEventListener('message', (event: { data: any }) => {
        resolve(JSON.parse(event.data.toString()));
      });
      setTimeout(() => reject(new Error('ack response timeout')), 3000);
    });

    // The ack handler returns a success response even for unknown subscriptions
    // because it delegates to socketConnection.ackSubscription which silently
    // ignores flow controllers that don't exist.
    expect(response.result).toBeDefined();

    socket.close();
  });
});
