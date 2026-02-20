import { v4 as uuidv4 } from 'uuid';
import { DataStream, Jws, Message, MessagesRead, RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it, spyOn } from 'bun:test';

import type { RequestContext } from '../src/lib/json-rpc-router.js';

import { createRecordsWriteMessage } from './utils.js';
import { getTestDwn } from './test-dwn.js';
import { handleDwnProcessMessage } from '../src/json-rpc-handlers/dwn/process-message.js';
import { createJsonRpcRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';

describe('handleDwnProcessMessage', () => {
  it('returns a JSON RPC Success Response when DWN returns a 2XX status code', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();

    // Construct a well-formed DWN Request that will be successfully processed.
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const dwn = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
    const context: RequestContext = { dwn, transport: 'http', dataStream };

    const { jsonRpcResponse } = await handleDwnProcessMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    const { reply } = jsonRpcResponse.result;
    expect(reply.status.code).toBe(202);
    expect(reply.status.detail).toBe('Accepted');
    await dwn.close();
  });

  it('returns a JSON RPC Success Response when DWN returns a 4XX/5XX status code', async () => {
    // Construct a DWN Request that is missing the descriptor `method` property to ensure
    // that `dwn.processMessage()` will return an error status.
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records' },
      },
      target: 'did:key:abc1234',
    });

    const dwn = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'http' };

    const { jsonRpcResponse } = await handleDwnProcessMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    const { reply } = jsonRpcResponse.result;
    expect(reply.status.code).toBe(400);
    expect(reply.status.detail).toBeDefined();
    expect(reply.data).toBeUndefined();
    expect(reply.entries).toBeUndefined();
    await dwn.close();
  });

  it('should extract data stream from DWN response and return it as a separate property in the JSON RPC response for RecordsRead', async () => {
    // scenario: Write a record with some data, and then read the record to get the data back
    const alice = await TestDataGenerator.generateDidKeyPersona();

    // Write a record to later read
    const { recordsWrite, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const dwn = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
    const context: RequestContext = { dwn, transport: 'http', dataStream };

    const { jsonRpcResponse } = await handleDwnProcessMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    const { reply } = jsonRpcResponse.result;
    expect(reply.status.code).toBe(202);


    // Read the record to get the data back
    const readRequestId = uuidv4();
    const recordsRead = await RecordsRead.create({
      signer : Jws.createSigner(alice),
      filter : { recordId: recordsWrite.message.recordId },
    });

    const readRequest = createJsonRpcRequest(readRequestId, 'dwn.processMessage', {
      message : recordsRead.toJSON(),
      target  : alice.did,
    });

    const { jsonRpcResponse: recordsReadResponse, dataStream: responseDataStream } = await handleDwnProcessMessage(readRequest, { dwn, transport: 'http' });
    expect(recordsReadResponse.error).toBeUndefined();
    const { reply: readReply } = recordsReadResponse.result;
    expect(readReply.status.code).toBe(200);
    expect(responseDataStream).toBeDefined();

    // Compare the data stream bytes to ensure they are the same
    const responseDataBytes = await DataStream.toBytes(responseDataStream!);
    expect(responseDataBytes).toEqual(dataBytes);
    await dwn.close();
  });

  it('should extract data stream from DWN response and return it as a separate property in the JSON RPC response for MessagesRead', async () => {
    // scenario: Write a record with some data, and then read the message to get the data back

    const alice = await TestDataGenerator.generateDidKeyPersona();

    // Create a record to read
    const { recordsWrite, dataStream, dataBytes } = await TestDataGenerator.generateRecordsWrite({ author: alice });
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const dwn = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
    const context: RequestContext = { dwn, transport: 'http', dataStream };

    const { jsonRpcResponse } = await handleDwnProcessMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    const { reply } = jsonRpcResponse.result;
    expect(reply.status.code).toBe(202);

    const messageCid = await Message.getCid(recordsWrite.message);

    // read the message
    const readRequestId = uuidv4();
    const messageRead = await MessagesRead.create({
      signer: Jws.createSigner(alice),
      messageCid,
    });

    const readRequest = createJsonRpcRequest(readRequestId, 'dwn.processMessage', {
      message : messageRead.toJSON(),
      target  : alice.did,
    });

    const { jsonRpcResponse: recordsReadResponse, dataStream: responseDataStream } = await handleDwnProcessMessage(readRequest, { dwn, transport: 'http' });
    expect(recordsReadResponse.error).toBeUndefined();
    const { reply: readReply } = recordsReadResponse.result;
    expect(readReply.status.code).toBe(200);
    expect(responseDataStream).toBeDefined();

    // Compare the data stream bytes to ensure they are the same
    const responseDataBytes = await DataStream.toBytes(responseDataStream!);
    expect(responseDataBytes).toEqual(dataBytes);
    await dwn.close();
  });

  it('should fail if no subscriptionRequest context exists for a `Subscribe` message', async () => {
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records', method: 'Subscribe' },
      },
      target: 'did:key:abc1234',
    });

    const dwn = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws' };

    const { jsonRpcResponse } = await handleDwnProcessMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidRequest);
    expect(jsonRpcResponse.error.message).toBe('subscribe methods must contain a subscriptionRequest context');
    await dwn.close();
  });

  it('should fail on http requests for a `Subscribe` message', async () => {
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records', method: 'Subscribe' },
      },
      target: 'did:key:abc1234',
    });

    const dwn = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'http', subscriptionRequest: { id: 'test', subscriptionHandler: () => {} } };

    const { jsonRpcResponse } = await handleDwnProcessMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toBe('subscriptions are not supported via http');
    await dwn.close();
  });

  it('should return a JsonRpc Internal Error for an unexpected thrown error within the handler', async () => {
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records' },
      },
      target: 'did:key:abc1234',
    });

    const dwn = await getTestDwn();
    spyOn(dwn, 'processMessage').mockImplementation(() => {
      throw new Error('unexpected error');
    });
    const context: RequestContext = { dwn, transport: 'http' };

    const { jsonRpcResponse } = await handleDwnProcessMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InternalError);
    expect(jsonRpcResponse.error.message).toBe('unexpected error');
    await dwn.close();
  });
});
