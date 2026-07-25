import type { ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { RequestContext } from '../src/lib/json-rpc-router.js';

import { AdminStore } from '../src/admin/admin-store.js';
import { DwnServerErrorCode } from '../src/dwn-error.js';
import { getTestDwn } from './test-dwn.js';
import { handleDwnApplyReplicatedMessage } from '../src/json-rpc-handlers/dwn/apply-replicated-message.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { createJsonRpcRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { createRecordsWriteMessage, expectAppliedResultWithPosition } from './utils.js';
import { DataStream, DwnErrorCode, Encoder, Jws, RecordsDelete, RecordsRead, RecordsWrite, TestDataGenerator, Time } from '@enbox/dwn-sdk-js';
import { describe, expect, it, spyOn } from 'bun:test';

describe('handleDwnApplyReplicatedMessage', () => {
  it('returns a structured replication result from the DWN apply path', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });

    const { dwn } = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
    const context: RequestContext = { dwn, transport: 'http', dataStream };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    await expectAppliedResultWithPosition(jsonRpcResponse.result.result as ReplicationApplyResult, alice.did, recordsWrite.toJSON());
    await dwn.close();
  });

  it('rejects RecordsWrite over non-HTTP transports', async () => {
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message: {
        descriptor: {
          dataSize  : 1,
          interface : 'Records',
          method    : 'Write',
        },
      },
      target: 'did:key:abc1234',
    });
    const { dwn } = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws' };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toBe('RecordsWrite is not supported via ws');
    await dwn.close();
  });

  it('decodes encoded RecordsWrite data over non-HTTP transports', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const dataBytes = new Uint8Array(1_048_577);
    dataBytes.fill(11);
    dataBytes[0] = 1;
    dataBytes[dataBytes.length - 1] = 2;
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data: dataBytes });
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      encodedData : Encoder.bytesToBase64Url(dataBytes),
      message     : recordsWrite.toJSON(),
      target      : alice.did,
    });

    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async (_target, _message, options) => {
      const receivedBytes = await DataStream.toBytes(options!.dataStream!);
      expect(receivedBytes).toEqual(dataBytes);
      return { kind: 'Applied' };
    });
    const context: RequestContext = {
      dwn,
      transport : 'ws',
      config    : { maxRecordDataSize: dataBytes.byteLength } as any,
    };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    expect(jsonRpcResponse.result.result).toEqual({ kind: 'Applied' });
    expect(applySpy).toHaveBeenCalledTimes(1);
    await dwn.close();
  });

  it('rejects encoded data whose decoded length does not match descriptor dataSize', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const dataBytes = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data: dataBytes });
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      encodedData : Encoder.bytesToBase64Url(dataBytes.slice(0, 2)),
      message     : recordsWrite.toJSON(),
      target      : alice.did,
    });

    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));
    const context: RequestContext = { dwn, transport: 'ws' };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain('does not match descriptor dataSize');
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('rejects encoded data with invalid base64url characters', async () => {
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      encodedData : 'abc+',
      message     : {
        descriptor: {
          dataSize  : 3,
          interface : 'Records',
          method    : 'Write',
        },
      },
      target: 'did:key:abc1234',
    });
    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));
    const context: RequestContext = { dwn, transport: 'ws' };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain('encodedData must be valid base64url data');
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('rejects padded encoded data before decoding', async () => {
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      encodedData : 'AA==',
      message     : {
        descriptor: {
          dataSize  : 1,
          interface : 'Records',
          method    : 'Write',
        },
      },
      target: 'did:key:abc1234',
    });
    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));
    const context: RequestContext = { dwn, transport: 'ws' };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain('encodedData must be valid base64url data');
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('rejects encoded data that exceeds the configured max record data size before decoding', async () => {
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      encodedData : Encoder.bytesToBase64Url(new Uint8Array([1, 2, 3, 4])),
      message     : {
        descriptor: {
          dataSize  : 4,
          interface : 'Records',
          method    : 'Write',
        },
      },
      target: 'did:key:abc1234',
    });
    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));
    const context: RequestContext = {
      dwn,
      transport : 'ws',
      config    : { maxRecordDataSize: 3 } as any,
    };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.RecordDataSizeLimitExceeded);
    expect(jsonRpcResponse.error.data).toEqual({ code: DwnServerErrorCode.RecordDataSizeLimitExceeded });
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('rejects streamed replication data above the configured limit before DWN processing', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data });
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage');

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(dwnRequest, {
      dwn,
      transport : 'http',
      config    : { maxRecordDataSize: data.byteLength - 1 } as any,
      dataStream,
    });

    expect(jsonRpcResponse.error?.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error?.message).toContain(DwnServerErrorCode.RecordDataSizeLimitExceeded);
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dataStream.cancel();
    await dwn.close();
  });

  it('invokes message processed hooks only when replicated apply returns Applied', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));
    const hook = { onMessageProcessed: spyOn({ onMessageProcessed: (): void => {} }, 'onMessageProcessed') };
    const context: RequestContext = {
      dwn,
      transport             : 'http',
      dataStream,
      messageProcessedHooks : [hook],
    };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    expect(hook.onMessageProcessed).toHaveBeenCalledTimes(1);
    expect(hook.onMessageProcessed.mock.calls[0][0].tenant).toBe(alice.did);
    expect(hook.onMessageProcessed.mock.calls[0][0].status.code).toBe(202);
    await dwn.close();
  });

  it('does not invoke message processed hooks for non-Applied replication outcomes', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const { recordsWrite } = await createRecordsWriteMessage(alice);
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Duplicate' }));
    const hook = { onMessageProcessed: spyOn({ onMessageProcessed: (): void => {} }, 'onMessageProcessed') };
    const context: RequestContext = {
      dwn,
      transport             : 'http',
      messageProcessedHooks : [hook],
    };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeUndefined();
    expect(hook.onMessageProcessed).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('should reject when per-tenant rate limit is exceeded', async () => {
    const rateLimiter = new RateLimiter({ refillRate: 10, maxTokens: 1 });
    try {
      const { dwn } = await getTestDwn();
      const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));
      const context: RequestContext = {
        dwn,
        transport         : 'http',
        tenantRateLimiter : rateLimiter,
      };

      const message = {
        descriptor: {
          interface        : 'Records',
          method           : 'Query',
          messageTimestamp : new Date().toISOString(),
          filter           : {},
        },
      };

      const firstRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
        message,
        target: 'did:key:rate-limited',
      });
      await handleDwnApplyReplicatedMessage(firstRequest, context);

      const secondRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
        message,
        target: 'did:key:rate-limited',
      });
      const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(secondRequest, context);

      expect(jsonRpcResponse.error).toBeDefined();
      expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.TooManyRequests);
      expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.RateLimitExceeded);
      expect(jsonRpcResponse.error.message).toContain('retry after');
      expect(jsonRpcResponse.error.data).toHaveProperty('retryAfterSec');
      expect(applySpy).toHaveBeenCalledTimes(1);
      await dwn.close();
    } finally {
      rateLimiter.destroy();
    }
  });

  it('should enforce quota for a new replicated RecordsWrite before applying it', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));
    const context: RequestContext = {
      dwn,
      transport  : 'http',
      dataStream : DataStream.fromBytes(data),
      adminStore : {
        getTenantMessageCount : async (): Promise<number> => 1,
        getTenantStorageSize  : async (): Promise<number> => 0,
      } as any,
      config: {
        quotaMaxMessages     : 1,
        quotaMaxStorageBytes : 0,
      } as any,
    };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('should continue enforcing message-count quota for a dataless replicated RecordsWrite', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const { recordsWrite } = await createRecordsWriteMessage(alice);
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        adminStore : {
          getTenantMessageCount : async (): Promise<number> => 1,
          getTenantStorageSize  : async (): Promise<number> => 0,
        } as any,
        config: {
          quotaMaxMessages     : 1,
          quotaMaxStorageBytes : 1,
        } as any,
      },
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('should reject message-embedded encodedData in favor of the validated transport field', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const message = {
      ...recordsWrite.toJSON(),
      encodedData: Encoder.bytesToBase64Url(data),
    };
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message,
      target: alice.did,
    });
    const { dwn } = await getTestDwn();
    const applySpy = spyOn(dwn, 'applyReplicatedMessage').mockImplementation(async () => ({ kind: 'Applied' }));

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        adminStore : {
          getTenantMessageCount : async (): Promise<number> => 0,
          getTenantStorageSize  : async (): Promise<number> => 0,
        } as any,
        config: {
          quotaMaxMessages     : 0,
          quotaMaxStorageBytes : data.length + 1,
        } as any,
      },
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain('message.encodedData is not supported');
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('should retain a quota-blocked initial write without data so a later tombstone can apply', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const { dwn, dialect } = await getTestDwn();
    const adminStore = AdminStore.createFromDialect(dialect, 0);

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      const quotaContext = {
        dwn,
        transport : 'http' as const,
        adminStore,
        config    : {
          quotaMaxMessages     : 100,
          quotaMaxStorageBytes : data.length - 1,
        } as any,
      };
      const initialRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const blockedApply = await handleDwnApplyReplicatedMessage(
        initialRequest,
        { ...quotaContext, dataStream: DataStream.fromBytes(data) },
      );
      expect(blockedApply.jsonRpcResponse.error).toBeDefined();
      expect(blockedApply.jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantStorageQuotaExceeded);
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(0);

      const initialApply = await handleDwnApplyReplicatedMessage(initialRequest, quotaContext);
      expect(initialApply.jsonRpcResponse.error).toBeUndefined();
      expect((initialApply.jsonRpcResponse.result.result as ReplicationApplyResult).kind).toBe('Applied');
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(0);

      await Time.minimalSleep();
      const recordsDelete = await RecordsDelete.create({
        recordId : recordsWrite.message.recordId,
        signer   : Jws.createSigner(alice),
      });
      const deleteRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
        message : recordsDelete.toJSON(),
        target  : alice.did,
      });

      const deleteApply = await handleDwnApplyReplicatedMessage(deleteRequest, quotaContext);
      expect(deleteApply.jsonRpcResponse.error).toBeUndefined();
      expect((deleteApply.jsonRpcResponse.result.result as ReplicationApplyResult).kind).toBe('Applied');
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(0);
    } finally {
      await dwn.close();
      await adminStore.close();
    }
  });

  it('should retain a quota-blocked initial write without data so a smaller update can apply', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const initialData = TestDataGenerator.randomBytes(32);
    const updateData = new Uint8Array([9, 10, 11, 12]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data: initialData });
    const { dwn, dialect } = await getTestDwn();
    const adminStore = AdminStore.createFromDialect(dialect, 0);

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      const quotaContext = {
        dwn,
        transport : 'http' as const,
        adminStore,
        config    : {
          quotaMaxMessages     : 100,
          quotaMaxStorageBytes : updateData.length,
        } as any,
      };
      const initialRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const blockedApply = await handleDwnApplyReplicatedMessage(
        initialRequest,
        { ...quotaContext, dataStream: DataStream.fromBytes(initialData) },
      );
      expect(blockedApply.jsonRpcResponse.error).toBeDefined();
      expect(blockedApply.jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantStorageQuotaExceeded);
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(0);

      const initialApply = await handleDwnApplyReplicatedMessage(initialRequest, quotaContext);
      expect(initialApply.jsonRpcResponse.error).toBeUndefined();
      expect((initialApply.jsonRpcResponse.result.result as ReplicationApplyResult).kind).toBe('Applied');
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(0);

      await Time.minimalSleep();
      const update = await RecordsWrite.createFrom({
        recordsWriteMessage : recordsWrite.message,
        data                : updateData,
        signer              : Jws.createSigner(alice),
      });
      const updateRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
        message : update.toJSON(),
        target  : alice.did,
      });

      const updateApply = await handleDwnApplyReplicatedMessage(
        updateRequest,
        { ...quotaContext, dataStream: DataStream.fromBytes(updateData) },
      );
      expect(updateApply.jsonRpcResponse.error).toBeUndefined();
      expect((updateApply.jsonRpcResponse.result.result as ReplicationApplyResult).kind).toBe('Applied');
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(updateData.length);
    } finally {
      await dwn.close();
      await adminStore.close();
    }
  });

  it('should skip quota for a fully stored replicated duplicate echo', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([5, 6, 7, 8]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const firstApply = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        dataStream : DataStream.fromBytes(data),
      },
    );
    expect(firstApply.jsonRpcResponse.error).toBeUndefined();

    const duplicateApply = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        dataStream : DataStream.fromBytes(data),
        adminStore : {
          getTenantMessageCount : async (): Promise<number> => 1,
          getTenantStorageSize  : async (): Promise<number> => 1_000,
        } as any,
        config: {
          quotaMaxMessages     : 1,
          quotaMaxStorageBytes : 1,
        } as any,
      },
    );

    expect(duplicateApply.jsonRpcResponse.error).toBeUndefined();
    expect((duplicateApply.jsonRpcResponse.result.result as ReplicationApplyResult).kind).toBe('Duplicate');
    await dwn.close();
  });

  it('should cancel a duplicate echo data stream without reading it', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([5, 6, 7, 8]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const firstApply = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        dataStream : DataStream.fromBytes(data),
      },
    );
    expect(firstApply.jsonRpcResponse.error).toBeUndefined();

    let pulls = 0;
    let streamWasCanceled = false;
    const duplicateStream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls++;
        controller.enqueue(data);
      },
      cancel(): void {
        streamWasCanceled = true;
      },
    });

    const duplicateApply = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        dataStream : duplicateStream,
      },
    );

    expect(duplicateApply.jsonRpcResponse.error).toBeUndefined();
    expect((duplicateApply.jsonRpcResponse.result.result as ReplicationApplyResult).kind).toBe('Duplicate');
    expect(pulls).toBeLessThan(3);
    expect(streamWasCanceled).toBe(true);
    await dwn.close();
  });

  it('should abort an octet-stream body when it exceeds descriptor dataSize', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([1, 2, 3, 4]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    let streamWasCanceled = false;
    let pulls = 0;
    const overlongStream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(data);
          return;
        }

        controller.enqueue(new Uint8Array([9]));
      },
      cancel(): void {
        streamWasCanceled = true;
      },
    }, { highWaterMark: 0 });

    const apply = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        dataStream : overlongStream,
      },
    );

    expect(apply.jsonRpcResponse.error).toBeUndefined();
    const result = apply.jsonRpcResponse.result.result as ReplicationApplyResult;
    expect(result.kind).toBe('Invalid');
    if (result.kind !== 'Invalid') {
      throw new Error(`expected Invalid replication result, received ${result.kind}`);
    }
    expect(result.reason).toContain(DwnErrorCode.RecordsWriteDataSizeMismatch);
    expect(pulls).toBe(2);
    expect(streamWasCanceled).toBe(true);
    await dwn.close();
  });

  it('should enforce quota before a data-bearing replay of a dataless stored write', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([9, 10, 11, 12]);
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data });
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn } = await getTestDwn();
    await TestDataGenerator.installDefaultTestProtocol(dwn, alice);

    const datalessApply = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport: 'http',
      },
    );
    expect(datalessApply.jsonRpcResponse.error).toBeUndefined();
    expect((datalessApply.jsonRpcResponse.result.result as ReplicationApplyResult).kind).toBe('Applied');

    const completingApply = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      {
        dwn,
        transport  : 'http',
        dataStream,
        adminStore : {
          getTenantMessageCount : async (): Promise<number> => 1,
          getTenantStorageSize  : async (): Promise<number> => 0,
        } as any,
        config: {
          quotaMaxMessages     : 1,
          quotaMaxStorageBytes : 0,
        } as any,
      },
    );

    expect(completingApply.jsonRpcResponse.error).toBeDefined();
    expect(completingApply.jsonRpcResponse.error.message).toContain(DwnServerErrorCode.TenantMessageQuotaExceeded);
    await dwn.close();
  });

  it('should defer rather than falsely acknowledge data for an ancestry-only stored CID', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const data = new Uint8Array([9, 10, 11, 12]);
    const { recordsWrite } = await createRecordsWriteMessage(alice, { data });
    const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.applyReplicatedMessage', {
      message : recordsWrite.toJSON(),
      target  : alice.did,
    });
    const { dwn, dialect } = await getTestDwn();
    const adminStore = AdminStore.createFromDialect(dialect, 0);

    try {
      await TestDataGenerator.installDefaultTestProtocol(dwn, alice);
      const datalessApply = await handleDwnApplyReplicatedMessage(dwnRequest, {
        dwn,
        transport: 'http',
      });
      expect(datalessApply.jsonRpcResponse.error).toBeUndefined();
      expect(datalessApply.jsonRpcResponse.result.result).toEqual(expect.objectContaining({
        kind         : 'Applied',
        ancestryOnly : true,
      }));

      const replay = await handleDwnApplyReplicatedMessage(dwnRequest, {
        dwn,
        transport  : 'http',
        dataStream : DataStream.fromBytes(data),
        adminStore,
        config     : {
          quotaMaxMessages     : 100,
          quotaMaxStorageBytes : data.length,
        } as any,
      });

      expect(replay.jsonRpcResponse.error).toBeUndefined();
      expect(replay.jsonRpcResponse.result.result).toEqual({ kind: 'Deferred', reason: 'storage' });
      expect(await adminStore.getTenantStorageSize(alice.did)).toBe(0);
      const recordsRead = await RecordsRead.create({
        filter : { recordId: recordsWrite.message.recordId },
        signer : Jws.createSigner(alice),
      });
      expect((await dwn.processMessage(alice.did, recordsRead.message)).status.code).toBe(404);
    } finally {
      await dwn.close();
      await adminStore.close();
    }
  });

  it('returns an internal JSON-RPC error for unexpected thrown errors', async () => {
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message: {
        descriptor: {
          interface : 'Protocols',
          method    : 'Configure',
        },
      },
      target: 'did:key:abc1234',
    });
    const { dwn } = await getTestDwn();
    spyOn(dwn, 'applyReplicatedMessage').mockImplementation(() => {
      throw new Error('unexpected error');
    });
    const context: RequestContext = { dwn, transport: 'http' };

    const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InternalError);
    expect(jsonRpcResponse.error.message).toBe('an unexpected error occurred while applying the replicated message');
    await dwn.close();
  });
});
