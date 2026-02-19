import type { SinonFakeTimers } from 'sinon';
import type { Dwn, MessageEvent } from '@enbox/dwn-sdk-js';

import { base64url } from 'multiformats/bases/base64';
import { useFakeTimers } from 'sinon';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { config } from '../src/config.js';
import { getTestDwn } from './test-dwn.js';
import { HttpApi } from '../src/http-api.js';
import { WsApi } from '../src/ws-api.js';
import { createJsonRpcRequest, createJsonRpcSubscriptionRequest, JsonRpcErrorCodes, JsonRpcSocket } from '@enbox/dwn-clients';
import { createRecordsWriteMessage, sendHttpMessage, sendWsMessage, waitUntil } from './utils.js';


describe('websocket api', function () {
  let httpApi: HttpApi;
  let wsApi: WsApi;
  let dwn: Dwn;
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
    dwn = await getTestDwn({ withEvents: true });
    httpApi = await HttpApi.create(config, dwn);
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

  it('subscribes to records and receives updates', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();

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
      const { event } = response.result;
      subscriptionHandler(event);
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
      const { event } = response.result;
      subscriptionHandler(event);
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
      const { event } = response.result;
      subscriptionHandler(event);
    });

    const { message: message2 } = await TestDataGenerator.generateRecordsSubscribe({ filter: { schema: 'bar/baz' }, author: alice });

    // We are checking for the subscription Id not the request Id
    const request2Id = uuidv4();
    const dwnRequest2 = createJsonRpcSubscriptionRequest(request2Id, 'rpc.subscribe.dwn.processMessage', {
      message : message2,
      target  : alice.did
    }, subscribeId);

    const { response: response2 } = await connection.subscribe(dwnRequest2, (response) => {
      const { event } = response.result;
      subscriptionHandler(event);
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
      const { event } = response.result;
      subscriptionHandler(event);
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
