import { DataStream, DwnErrorCode, Jws, Message, MessagesRead, RecordsRead, TestDataGenerator, Time } from '@enbox/dwn-sdk-js';
import { describe, expect, it, spyOn } from 'bun:test';

import type { AdminStore } from '../src/admin/admin-store.js';
import type { RegistrationStore } from '../src/registration/registration-store.js';
import type { RequestContext } from '../src/lib/json-rpc-router.js';

import { createRecordsWriteMessage } from './utils.js';
import { DwnServerErrorCode } from '../src/dwn-error.js';
import { getTestDwn } from './test-dwn.js';
import { handleDwnProcessMessage } from '../src/json-rpc-handlers/dwn/process-message.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { createJsonRpcRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';

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
      config    : { maxRecordDataSize: 3, quotaMaxMessages: 0, quotaMaxStorageBytes: 0 } as any,
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
      config    : { maxRecordDataSize: data.byteLength, quotaMaxMessages: 0, quotaMaxStorageBytes: 0 } as any,
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
      config    : { maxRecordDataSize: data.byteLength - 1, quotaMaxMessages: 0, quotaMaxStorageBytes: 0 } as any,
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
      config     : { maxRecordDataSize: data.byteLength, quotaMaxMessages: 0, quotaMaxStorageBytes: 0 } as any,
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

  it('should reject RecordsWrite when message quota is exceeded', async () => {
    const { dwn } = await getTestDwn();

    // Create a mock admin store that reports the tenant already has messages.
    const mockAdminStore = {
      getTenantMessageCount : async (): Promise<number> => 10,
      getTenantStorageSize  : async (): Promise<number> => 0,
    } as unknown as AdminStore;

    const context: RequestContext = {
      dwn,
      transport  : 'http',
      adminStore : mockAdminStore,
      config     : { quotaMaxMessages: 5, quotaMaxStorageBytes: 0 } as any,
    };

    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : new Date().toISOString(),
          dataSize         : 100,
          dataCid          : 'cid-test',
          dataFormat       : 'application/octet-stream',
        },
      },
      target: 'did:key:quota-test',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
    expect(jsonRpcResponse.error.data).toEqual({ code: DwnServerErrorCode.TenantMessageQuotaExceeded });
    await dwn.close();
  });

  it('should fail closed when a finite quota has no usage store', async () => {
    const { dwn } = await getTestDwn();
    const context: RequestContext = {
      dwn,
      transport : 'http',
      config    : { quotaMaxMessages: 1, quotaMaxStorageBytes: 0 } as any,
    };
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : new Date().toISOString(),
          dataSize         : 1,
          dataCid          : 'cid-test',
          dataFormat       : 'application/octet-stream',
        },
      },
      target: 'did:key:quota-test',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    expect(jsonRpcResponse.error?.code).toBe(JsonRpcErrorCodes.InternalError);
    await dwn.close();
  });

  it('should apply message quotas to ProtocolsConfigure', async () => {
    const { dwn } = await getTestDwn();
    const mockAdminStore = {
      getTenantMessageCount : async (): Promise<number> => 5,
      getTenantStorageSize  : async (): Promise<number> => 0,
    } as unknown as AdminStore;
    const context: RequestContext = {
      dwn,
      transport  : 'http',
      adminStore : mockAdminStore,
      config     : { quotaMaxMessages: 5, quotaMaxStorageBytes: 0 } as any,
    };
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Protocols',
          method           : 'Configure',
          messageTimestamp : new Date().toISOString(),
        },
      },
      target: 'did:key:quota-test',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    expect(jsonRpcResponse.id).toBe(dwnRequest.id);
    expect(jsonRpcResponse.error?.message).toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
    await dwn.close();
  });

  it('should reject RecordsWrite when storage quota is exceeded', async () => {
    const { dwn } = await getTestDwn();

    const mockAdminStore = {
      getTenantMessageCount : async (): Promise<number> => 0,
      getTenantStorageSize  : async (): Promise<number> => 900,
    } as unknown as AdminStore;

    const context: RequestContext = {
      dwn,
      transport  : 'http',
      adminStore : mockAdminStore,
      config     : { quotaMaxMessages: 0, quotaMaxStorageBytes: 1000 } as any,
    };

    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : new Date().toISOString(),
          dataSize         : 200,
          dataCid          : 'cid-storage',
          dataFormat       : 'application/octet-stream',
        },
      },
      target: 'did:key:storage-quota',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantStorageQuotaExceeded);
    expect(jsonRpcResponse.error.data).toEqual({ code: DwnServerErrorCode.TenantStorageQuotaExceeded });
    await dwn.close();
  });

  it('should use per-tenant quota override when available', async () => {
    const { dwn } = await getTestDwn();

    const mockAdminStore = {
      getTenantMessageCount : async (): Promise<number> => 3,
      getTenantStorageSize  : async (): Promise<number> => 0,
    } as unknown as AdminStore;

    const mockRegistrationStore = {
      getQuota: async (): Promise<{ did: string; maxMessages: number; maxStorageBytes: number }> => ({
        did             : 'did:key:override',
        maxMessages     : 2,
        maxStorageBytes : 0,
      }),
    } as unknown as RegistrationStore;

    const context: RequestContext = {
      dwn,
      transport         : 'http',
      adminStore        : mockAdminStore,
      registrationStore : mockRegistrationStore,
      config            : { quotaMaxMessages: 100, quotaMaxStorageBytes: 0 } as any,
    };

    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : new Date().toISOString(),
          dataSize         : 10,
          dataCid          : 'cid-override',
          dataFormat       : 'application/octet-stream',
        },
      },
      target: 'did:key:override',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    // Per-tenant quota is 2, tenant has 3 messages -> should be rejected.
    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
    await dwn.close();
  });

  it('should inherit a global dimension when its tenant override is zero', async () => {
    const { dwn } = await getTestDwn();
    const mockAdminStore = {
      getTenantMessageCount : async (): Promise<number> => 3,
      getTenantStorageSize  : async (): Promise<number> => 0,
    } as unknown as AdminStore;
    const mockRegistrationStore = {
      getQuota: async (): Promise<{ did: string; maxMessages: number; maxStorageBytes: number }> => ({
        did             : 'did:key:inherit',
        maxMessages     : 0,
        maxStorageBytes : 10,
      }),
    } as unknown as RegistrationStore;
    const context: RequestContext = {
      dwn,
      transport         : 'http',
      adminStore        : mockAdminStore,
      registrationStore : mockRegistrationStore,
      config            : { quotaMaxMessages: 2, quotaMaxStorageBytes: 100 } as any,
    };
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : new Date().toISOString(),
          dataSize         : 1,
          dataCid          : 'cid-inherit',
          dataFormat       : 'application/octet-stream',
        },
      },
      target: 'did:key:inherit',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    expect(jsonRpcResponse.error?.message).toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
    await dwn.close();
  });

  it('should skip quota enforcement when both quotas are 0 (unlimited)', async () => {
    const { dwn } = await getTestDwn();

    const mockAdminStore = {
      getTenantMessageCount : async (): Promise<number> => 999,
      getTenantStorageSize  : async (): Promise<number> => 999999,
    } as unknown as AdminStore;

    const context: RequestContext = {
      dwn,
      transport  : 'http',
      adminStore : mockAdminStore,
      config     : { quotaMaxMessages: 0, quotaMaxStorageBytes: 0 } as any,
    };

    // Even though the tenant has 999 messages and 999999 bytes, the quota is
    // unlimited (0/0), so the request should NOT be rejected by the quota check.
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : new Date().toISOString(),
          dataSize         : 100,
          dataCid          : 'cid-unlimited',
          dataFormat       : 'application/octet-stream',
        },
      },
      target: 'did:key:unlimited-quota',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    // Should NOT contain any quota error. DWN will return its own validation error (400).
    if (jsonRpcResponse.error) {
      expect(jsonRpcResponse.error.message).not.toContain('Quota');
      expect(jsonRpcResponse.error.message).not.toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
      expect(jsonRpcResponse.error.message).not.toContain(DwnServerErrorCode.TenantStorageQuotaExceeded);
    }
    await dwn.close();
  });

  it('should allow RecordsWrite when quota is not exceeded', async () => {
    const { dwn } = await getTestDwn();

    const mockAdminStore = {
      getTenantMessageCount : async (): Promise<number> => 1,
      getTenantStorageSize  : async (): Promise<number> => 100,
    } as unknown as AdminStore;

    const context: RequestContext = {
      dwn,
      transport  : 'http',
      adminStore : mockAdminStore,
      config     : { quotaMaxMessages: 100, quotaMaxStorageBytes: 10000 } as any,
    };

    // This request has invalid message format, so DWN will reject it with 400,
    // but importantly the quota check should NOT reject it (quota allows it).
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
      message: {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : new Date().toISOString(),
          dataSize         : 10,
          dataCid          : 'cid-ok',
          dataFormat       : 'application/octet-stream',
        },
      },
      target: 'did:key:quota-ok',
    });

    const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);

    // Should NOT contain quota error — DWN will return its own error (400 for bad message).
    if (jsonRpcResponse.error) {
      expect(jsonRpcResponse.error.message).not.toContain('Quota');
    }
    await dwn.close();
  });
});
