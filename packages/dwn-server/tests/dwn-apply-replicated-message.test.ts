import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it, spyOn } from 'bun:test';

import type { RequestContext } from '../src/lib/json-rpc-router.js';

import { createRecordsWriteMessage } from './utils.js';
import { getTestDwn } from './test-dwn.js';
import { handleDwnApplyReplicatedMessage } from '../src/json-rpc-handlers/dwn/apply-replicated-message.js';
import { createJsonRpcRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';

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
    expect(jsonRpcResponse.result.result).toEqual({ kind: 'Applied' });
    await dwn.close();
  });

  it('rejects RecordsWrite over non-HTTP transports', async () => {
    const requestId = uuidv4();
    const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      message: {
        descriptor: {
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
