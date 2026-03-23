import type { Dwn } from '@enbox/dwn-sdk-js';
import type { JsonRpcRequest } from '@enbox/dwn-clients';
import type { RequestContext } from '../src/lib/json-rpc-router.js';

import sinon from 'sinon';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { JsonRpcErrorCodes } from '@enbox/dwn-clients';

import { getTestDwn } from './test-dwn.js';
import { handleSubscriptionAck } from '../src/json-rpc-handlers/subscription/ack.js';
import { SocketConnection } from '../src/connection/socket-connection.js';

describe('handleSubscriptionAck', () => {
  let dwn: Dwn;

  beforeAll(async () => {
    ({ dwn } = await getTestDwn());
  });

  afterAll(async () => {
    await dwn.close();
    sinon.restore();
  });

  it('should return error when socket connection does not exist', async () => {
    const request: JsonRpcRequest = {
      jsonrpc      : '2.0',
      id           : uuidv4(),
      method       : 'rpc.ack',
      params       : { cursor: 'some-cursor' },
      subscription : { id: 'sub-1' },
    };

    const context: RequestContext = {
      transport        : 'ws',
      dwn,
      socketConnection : undefined,
    };

    const { jsonRpcResponse } = await handleSubscriptionAck(request, context);
    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidRequest);
    expect(jsonRpcResponse.error.message).toContain('socket connection does not exist');
  });

  it('should return error when subscription options are missing', async () => {
    const mockSocket = {
      data          : { connection: null as any },
      send          : sinon.stub(),
      close         : sinon.stub(),
      ping          : sinon.stub(),
      pong          : sinon.stub(),
      publish       : sinon.stub(),
      publishText   : sinon.stub(),
      publishBinary : sinon.stub(),
      subscribe     : sinon.stub(),
      unsubscribe   : sinon.stub(),
      isSubscribed  : sinon.stub(),
      cork          : sinon.stub(),
      sendText      : sinon.stub(),
      sendBinary    : sinon.stub(),
      remoteAddress : '127.0.0.1',
      readyState    : 1,
      binaryType    : 'arraybuffer',
    } as any;

    const connection = new SocketConnection(mockSocket, dwn);

    const request: JsonRpcRequest = {
      jsonrpc : '2.0',
      id      : uuidv4(),
      method  : 'rpc.ack',
      params  : { cursor: 'some-cursor' },
      // No subscription field.
    };

    const context: RequestContext = {
      transport        : 'ws',
      dwn,
      socketConnection : connection,
    };

    const { jsonRpcResponse } = await handleSubscriptionAck(request, context);
    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain('subscription options are required');

    await connection.close();
  });

  it('should return error when cursor is missing', async () => {
    const mockSocket = {
      data          : { connection: null as any },
      send          : sinon.stub(),
      close         : sinon.stub(),
      ping          : sinon.stub(),
      pong          : sinon.stub(),
      publish       : sinon.stub(),
      publishText   : sinon.stub(),
      publishBinary : sinon.stub(),
      subscribe     : sinon.stub(),
      unsubscribe   : sinon.stub(),
      isSubscribed  : sinon.stub(),
      cork          : sinon.stub(),
      sendText      : sinon.stub(),
      sendBinary    : sinon.stub(),
      remoteAddress : '127.0.0.1',
      readyState    : 1,
      binaryType    : 'arraybuffer',
    } as any;

    const connection = new SocketConnection(mockSocket, dwn);

    const request: JsonRpcRequest = {
      jsonrpc      : '2.0',
      id           : uuidv4(),
      method       : 'rpc.ack',
      params       : {}, // No cursor.
      subscription : { id: 'sub-1' },
    };

    const context: RequestContext = {
      transport        : 'ws',
      dwn,
      socketConnection : connection,
    };

    const { jsonRpcResponse } = await handleSubscriptionAck(request, context);
    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain('params.cursor is required');

    await connection.close();
  });

  it('should return error when cursor is an empty string', async () => {
    const mockSocket = {
      data          : { connection: null as any },
      send          : sinon.stub(),
      close         : sinon.stub(),
      ping          : sinon.stub(),
      pong          : sinon.stub(),
      publish       : sinon.stub(),
      publishText   : sinon.stub(),
      publishBinary : sinon.stub(),
      subscribe     : sinon.stub(),
      unsubscribe   : sinon.stub(),
      isSubscribed  : sinon.stub(),
      cork          : sinon.stub(),
      sendText      : sinon.stub(),
      sendBinary    : sinon.stub(),
      remoteAddress : '127.0.0.1',
      readyState    : 1,
      binaryType    : 'arraybuffer',
    } as any;

    const connection = new SocketConnection(mockSocket, dwn);

    const request: JsonRpcRequest = {
      jsonrpc      : '2.0',
      id           : uuidv4(),
      method       : 'rpc.ack',
      params       : { cursor: '' },
      subscription : { id: 'sub-1' },
    };

    const context: RequestContext = {
      transport        : 'ws',
      dwn,
      socketConnection : connection,
    };

    const { jsonRpcResponse } = await handleSubscriptionAck(request, context);
    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toContain('params.cursor is required');

    await connection.close();
  });

  it('should return success when cursor and subscription are valid', async () => {
    const mockSocket = {
      data          : { connection: null as any },
      send          : sinon.stub(),
      close         : sinon.stub(),
      ping          : sinon.stub(),
      pong          : sinon.stub(),
      publish       : sinon.stub(),
      publishText   : sinon.stub(),
      publishBinary : sinon.stub(),
      subscribe     : sinon.stub(),
      unsubscribe   : sinon.stub(),
      isSubscribed  : sinon.stub(),
      cork          : sinon.stub(),
      sendText      : sinon.stub(),
      sendBinary    : sinon.stub(),
      remoteAddress : '127.0.0.1',
      readyState    : 1,
      binaryType    : 'arraybuffer',
    } as any;

    const connection = new SocketConnection(mockSocket, dwn);

    const request: JsonRpcRequest = {
      jsonrpc      : '2.0',
      id           : uuidv4(),
      method       : 'rpc.ack',
      params       : { cursor: { streamId: 's1', epoch: 'e1', position: '42', messageCid: 'cid-42' } },
      subscription : { id: 'sub-123' },
    };

    const context: RequestContext = {
      transport        : 'ws',
      dwn,
      socketConnection : connection,
    };

    const { jsonRpcResponse } = await handleSubscriptionAck(request, context);
    expect(jsonRpcResponse.error).toBeUndefined();
    expect(jsonRpcResponse.result.reply.status).toBe(200);

    await connection.close();
  });
});
