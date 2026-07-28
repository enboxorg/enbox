import { DataStream, DwnConstant, DwnError, DwnErrorCode, Jws, Message, MessagesRead, RecordsRead, RecordsWrite, TestDataGenerator, Time } from '@enbox/dwn-sdk-js';
import { describe, expect, it, spyOn } from 'bun:test';

import type { RequestContext } from '../src/lib/json-rpc-router.js';

import { AdminStore } from '../src/admin/admin-store.js';
import { createRecordsWriteMessage } from './utils.js';
import { DwnServerErrorCode } from '../src/dwn-error.js';
import { handleDwnProcessMessage } from '../src/json-rpc-handlers/dwn/process-message.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { createJsonRpcRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { getQuotaTestDwn, getTestDwn } from './test-dwn.js';

describe('handleDwnProcessMessage', () => {
  it('returns a JSON RPC Success Response when DWN returns a 2XX status code', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();

    // Construct a well-formed DWN Request that will be successfully processed.
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const { dwn } = await getTestDwn();
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

  it('rejects record data above the configured limit before DWN processing', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, {
      data: new Uint8Array([1, 2, 3, 4]),
    });
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    const processSpy = spyOn(dwn, 'processMessage');

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, {
      dwn,
      transport : 'http',
      config    : { maxRecordDataSize: 3 } as any,
      dataStream,
    });

    expect(jsonRpcResponse.error?.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error?.message).toContain(DwnServerErrorCode.RecordDataSizeLimitExceeded);
    expect(jsonRpcResponse.error?.data).toEqual({ code: DwnServerErrorCode.RecordDataSizeLimitExceeded });
    expect(processSpy).toHaveBeenCalledTimes(0);
    await dataStream.cancel();
    await dwn.close();
  });

  it('accepts record data at the configured limit and preserves dataless updates after the limit is lowered', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data });
    const { dwn } = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const initialRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const initialResult = await handleDwnProcessMessage(initialRequest, {
      dwn,
      transport : 'http',
      config    : { maxRecordDataSize: data.byteLength } as any,
      dataStream,
    });
    expect(initialResult.jsonRpcResponse.result.reply.status.code).toBe(202);

    await Time.minimalSleep();
    const { recordsWrite: update } = await createRecordsWriteMessage(alice, {
      dataCid     : recordsWrite.message.descriptor.dataCid,
      dataSize    : recordsWrite.message.descriptor.dataSize,
      dateCreated : recordsWrite.message.descriptor.dateCreated,
      published   : true,
      recordId    : recordsWrite.message.recordId,
    });
    const updateRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message : update.toJSON(),
      target  : alice.did,
    });
    const updateResult = await handleDwnProcessMessage(updateRequest, {
      dwn,
      transport : 'http',
      config    : { maxRecordDataSize: data.byteLength - 1 } as any,
    });
    expect(updateResult.jsonRpcResponse.result.reply.status.code).toBe(202);
    await dwn.close();
  });

  it('cancels an ordinary RecordsWrite stream when it exceeds descriptor dataSize', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const { dwn } = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    let pulls = 0;
    let streamWasCanceled = false;
    const overlongStream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls++;
        controller.enqueue(pulls === 1 ? data : new Uint8Array([9]));
      },
      cancel(): void {
        streamWasCanceled = true;
      },
    }, { highWaterMark: 0 });
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, {
      dwn,
      transport  : 'http',
      config     : { maxRecordDataSize: data.byteLength } as any,
      dataStream : overlongStream,
    });

    expect(jsonRpcResponse.error).toBeUndefined();
    expect(jsonRpcResponse.result.reply.status.code).toBe(400);
    expect(jsonRpcResponse.result.reply.status.detail).toContain(DwnErrorCode.RecordsWriteDataSizeMismatch);
    expect(pulls).toBe(2);
    expect(streamWasCanceled).toBe(true);
    await dwn.close();
  });

  it('returns a JSON RPC Success Response when DWN returns a 4XX/5XX status code', async () => {
    // Construct a DWN Request that is missing the descriptor `method` property to ensure
    // that `dwn.processMessage()` will return an error status.
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records' },
      },
      target: 'did:key:abc1234',
    });

    const { dwn } = await getTestDwn();
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
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const { dwn } = await getTestDwn();
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
    const readRequestId = crypto.randomUUID();
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
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const { dwn } = await getTestDwn();
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
    const readRequestId = crypto.randomUUID();
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
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records', method: 'Subscribe' },
      },
      target: 'did:key:abc1234',
    });

    const { dwn } = await getTestDwn();
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
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records', method: 'Subscribe' },
      },
      target: 'did:key:abc1234',
    });

    const { dwn } = await getTestDwn();
    const context: RequestContext = {
      dwn,
      transport           : 'http',
      subscriptionRequest : { id: 'test', subscriptionHandler: () => {}, activate: async () => {} },
    };

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
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      message: {
        descriptor: { interface: 'Records' },
      },
      target: 'did:key:abc1234',
    });

    const { dwn } = await getTestDwn();
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
    // The handler returns a generic message instead of the raw error to avoid leaking internals.
    expect(jsonRpcResponse.error.message).toBe('an unexpected error occurred while processing the message');
    await dwn.close();
  });

  it('should reject when per-tenant rate limit is exceeded', async () => {
    const rateLimiter = new RateLimiter({ refillRate: 10, maxTokens: 1 });
    try {
      const { dwn } = await getTestDwn();
      const context: RequestContext = {
        dwn,
        transport         : 'http',
        tenantRateLimiter : rateLimiter,
      };

      // First request consumes the one available token.
      const dwnRequest1 = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        message : { descriptor: { interface: 'Records', method: 'Query', messageTimestamp: new Date().toISOString(), filter: {} } },
        target  : 'did:key:rate-limited',
      });
      await handleDwnProcessMessage(dwnRequest1, context);

      // Second request should be rate-limited.
      const dwnRequest2 = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        message : { descriptor: { interface: 'Records', method: 'Query', messageTimestamp: new Date().toISOString(), filter: {} } },
        target  : 'did:key:rate-limited',
      });
      const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest2, context);

      expect(jsonRpcResponse.error).toBeDefined();
      expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.TooManyRequests);
      expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.RateLimitExceeded);
      expect(jsonRpcResponse.error.message).toContain('retry after');
      expect(jsonRpcResponse.error.data).toHaveProperty('retryAfterSec');
      expect(jsonRpcResponse.error.data.retryAfterSec).toBeGreaterThan(0);
      await dwn.close();
    } finally {
      rateLimiter.destroy();
    }
  });

  it('maps message-store quota failures to stable public errors', async () => {
    const cases = [
      [DwnErrorCode.MessageStoreQuotaMessagesExceeded, DwnServerErrorCode.TenantMessageQuotaExceeded],
      [DwnErrorCode.MessageStoreQuotaStorageExceeded, DwnServerErrorCode.TenantStorageQuotaExceeded],
    ] as const;

    for (const [storeCode, publicCode] of cases) {
      const { dwn } = await getTestDwn();
      spyOn(dwn, 'processMessage').mockImplementation(async () => {
        throw new DwnError(storeCode, 'atomic quota rejection');
      });
      const request = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        message : { descriptor: { interface: 'Records', method: 'Write' } },
        target  : 'did:key:quota-test',
      });

      const { jsonRpcResponse } = await handleDwnProcessMessage(request, { dwn, transport: 'http' });

      expect(jsonRpcResponse.error?.message).toContain(publicCode);
      expect(jsonRpcResponse.error?.data).toEqual({ code: publicCode });
      await dwn.close();
    }
  });

  it('should allow an exact ordinary retry at the message and storage limits', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const request = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn, dialect, setQuota } = await getQuotaTestDwn();
    const adminStore = AdminStore.createFromDialect(dialect, 0);

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      const first = await handleDwnProcessMessage(request, {
        dwn,
        transport  : 'http',
        dataStream : DataStream.fromBytes(data),
      });
      expect(first.jsonRpcResponse.result.reply.status.code).toBe(202);

      setQuota({
        maxMessages     : await adminStore.getTenantMessageCount(alice.did),
        maxStorageBytes : await adminStore.getTenantStorageSize(alice.did),
      });
      const retry = await handleDwnProcessMessage(request, {
        dwn,
        transport  : 'http',
        config     : { maxRecordDataSize: data.length } as any,
        dataStream : DataStream.fromBytes(data),
      });

      expect(retry.jsonRpcResponse.error).toBeUndefined();
      expect(retry.jsonRpcResponse.result.reply.status.code).toBe(409);
    } finally {
      await dwn.close();
      await adminStore.close();
    }
  });

  it('should allow a metadata-only update at the storage limit', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const { dwn, dialect, setQuota } = await getQuotaTestDwn();
    const adminStore = AdminStore.createFromDialect(dialect, 0);

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      expect((await dwn.processMessage(alice.did, recordsWrite.toJSON(), {
        dataStream: DataStream.fromBytes(data),
      })).status.code).toBe(202);
      const storageAtLimit = await adminStore.getTenantStorageSize(alice.did);
      const messageLimit = await adminStore.getTenantMessageCount(alice.did) + 1;
      setQuota({ maxMessages: messageLimit, maxStorageBytes: storageAtLimit });

      await Time.minimalSleep();
      const metadataUpdate = await RecordsWrite.createFrom({
        recordsWriteMessage : recordsWrite.message,
        signer              : Jws.createSigner(alice),
        tags                : { revision: 2 },
      });
      const updateRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        message : metadataUpdate.toJSON(),
        target  : alice.did,
      });
      const update = await handleDwnProcessMessage(updateRequest, {
        dwn,
        transport: 'http',
      });

      expect(update.jsonRpcResponse.error).toBeUndefined();
      expect(update.jsonRpcResponse.result.reply.status.code).toBe(202);
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(storageAtLimit);
    } finally {
      await dwn.close();
      await adminStore.close();
    }
  });

  it('should atomically admit only one concurrent write into the final message slot', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const first = await createRecordsWriteMessage(alice, { data: new Uint8Array([1]) });
    const second = await createRecordsWriteMessage(alice, { data: new Uint8Array([2]) });
    const { dwn, dialect, setQuota } = await getQuotaTestDwn();
    const adminStore = AdminStore.createFromDialect(dialect, 0);

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      const initialCount = await adminStore.getTenantMessageCount(alice.did);
      setQuota({ maxMessages: initialCount + 1, maxStorageBytes: 0 });
      const requests = [first, second].map(({ dataStream, recordsWrite }) => handleDwnProcessMessage(
        createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
          message : recordsWrite.toJSON(),
          target  : alice.did,
        }),
        {
          dwn,
          transport: 'http',
          dataStream,
        },
      ));

      const results = await Promise.all(requests);
      const accepted = results.filter((result) => result.jsonRpcResponse.result?.reply.status.code === 202);
      const rejected = results.filter((result) =>
        result.jsonRpcResponse.error?.data?.code === DwnServerErrorCode.TenantMessageQuotaExceeded
      );

      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(await adminStore.getTenantMessageCount(alice.did)).toBe(initialCount + 1);
    } finally {
      await dwn.close();
      await adminStore.close();
    }
  });

  it('should remove externally stored data when atomic quota admission rejects the message', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const { dwn, setQuota } = await getQuotaTestDwn();

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      const request = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });
      setQuota({ maxMessages: 100, maxStorageBytes: data.byteLength - 1 });
      const rejected = await handleDwnProcessMessage(request, {
        dwn,
        transport  : 'http',
        config     : { maxRecordDataSize: data.byteLength } as any,
        dataStream : DataStream.fromBytes(data),
      });

      expect(rejected.jsonRpcResponse.error?.data?.code).toBe(DwnServerErrorCode.TenantStorageQuotaExceeded);
      expect(await dwn.storage.dataStore.get(
        alice.did,
        recordsWrite.message.recordId,
        recordsWrite.message.descriptor.dataCid,
      )).toBeUndefined();
    } finally {
      await dwn.close();
    }
  });

  it('should preserve staged data when a concurrent quota winner commits the shared reference', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const { dwn, dialect, setQuota } = await getQuotaTestDwn();
    const adminStore = AdminStore.createFromDialect(dialect, 0);

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      expect((await dwn.processMessage(alice.did, recordsWrite.toJSON())).status.code).toBe(204);
      const initialCount = await adminStore.getTenantMessageCount(alice.did);

      await Time.minimalSleep();
      const firstUpdate = await RecordsWrite.createFrom({
        recordsWriteMessage : recordsWrite.message,
        signer              : Jws.createSigner(alice),
        tags                : { revision: 1 },
      });
      await Time.minimalSleep();
      const secondUpdate = await RecordsWrite.createFrom({
        recordsWriteMessage : recordsWrite.message,
        signer              : Jws.createSigner(alice),
        tags                : { revision: 2 },
      });
      setQuota({ maxMessages: initialCount + 1, maxStorageBytes: data.byteLength });
      const results = await Promise.all([firstUpdate, secondUpdate].map((update) => handleDwnProcessMessage(
        createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
          message : update.toJSON(),
          target  : alice.did,
        }),
        {
          dwn,
          transport  : 'http',
          config     : { maxRecordDataSize: data.byteLength } as any,
          dataStream : DataStream.fromBytes(data),
        },
      )));

      expect(results.filter((result) => result.jsonRpcResponse.result?.reply.status.code === 202)).toHaveLength(1);
      expect(results.filter((result) =>
        result.jsonRpcResponse.error?.data?.code === DwnServerErrorCode.TenantMessageQuotaExceeded
      )).toHaveLength(1);
      expect(await dwn.storage.dataStore.get(
        alice.did,
        recordsWrite.message.recordId,
        recordsWrite.message.descriptor.dataCid,
      )).toBeDefined();
    } finally {
      await dwn.close();
      await adminStore.close();
    }
  });
});
