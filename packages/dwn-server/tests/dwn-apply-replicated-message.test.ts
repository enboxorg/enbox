import type { ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { RequestContext } from '../src/lib/json-rpc-router.js';

import { DwnServerErrorCode } from '../src/dwn-error.js';
import { getTestDwn } from './test-dwn.js';
import { handleDwnApplyReplicatedMessage } from '../src/json-rpc-handlers/dwn/apply-replicated-message.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { v4 as uuidv4 } from 'uuid';
import { createJsonRpcRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { createRecordsWriteMessage, expectAppliedResultWithPosition } from './utils.js';
import { DataStream, Encoder, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it, spyOn } from 'bun:test';

describe('handleDwnApplyReplicatedMessage', () => {
  it('returns a structured replication result from the DWN apply path', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
    const requestId = uuidv4();
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
    const requestId = uuidv4();
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
    const requestId = uuidv4();
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
    const context: RequestContext = { dwn, transport: 'ws' };

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
    const requestId = uuidv4();
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
    const requestId = uuidv4();
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
    const requestId = uuidv4();
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
    const requestId = uuidv4();
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
    expect(jsonRpcResponse.error.message).toContain('exceeds max record data size');
    expect(applySpy).toHaveBeenCalledTimes(0);
    await dwn.close();
  });

  it('invokes message processed hooks only when replicated apply returns Applied', async () => {
    const alice = await TestDataGenerator.generateDidKeyPersona();
    const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
    const requestId = uuidv4();
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
    const requestId = uuidv4();
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

      const firstRequest = createJsonRpcRequest(uuidv4(), 'dwn.applyReplicatedMessage', {
        message,
        target: 'did:key:rate-limited',
      });
      await handleDwnApplyReplicatedMessage(firstRequest, context);

      const secondRequest = createJsonRpcRequest(uuidv4(), 'dwn.applyReplicatedMessage', {
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

  it('returns an internal JSON-RPC error for unexpected thrown errors', async () => {
    const requestId = uuidv4();
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
