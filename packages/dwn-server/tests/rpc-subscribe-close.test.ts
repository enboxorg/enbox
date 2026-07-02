import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';

import type { RequestContext } from '../src/lib/json-rpc-router.js';

import { getTestDwn } from './test-dwn.js';
import { handleSubscriptionsClose } from '../src/json-rpc-handlers/subscription/close.js';
import { SocketConnection } from '../src/connection/socket-connection.js';
import { createJsonRpcRequest, createJsonRpcSubscriptionRequest, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DwnServerError, DwnServerErrorCode } from '../src/dwn-error.js';

describe('handleDwnProcessMessage', () => {
  it('should return an error if no socket connection exists', async () => {
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'rpc.subscribe.close', { });

    const { dwn } = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws' };

    const { jsonRpcResponse } = await handleSubscriptionsClose(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidRequest);
    expect(jsonRpcResponse.error.message).toBe('socket connection does not exist');
  });

  it('should return an error if no subscribe options exist', async () => {
    const requestId = crypto.randomUUID();
    const dwnRequest = createJsonRpcRequest(requestId, 'rpc.subscribe.close', { });
    const socketConnection = sinon.createStubInstance(SocketConnection);

    const { dwn } = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws', socketConnection };

    const { jsonRpcResponse } = await handleSubscriptionsClose(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidRequest);
    expect(jsonRpcResponse.error.message).toBe('subscribe options do not exist');
  });

  it('should return an error if close subscription throws ConnectionSubscriptionJsonRpcIdNotFound', async () => {
    const requestId = crypto.randomUUID();
    const id = 'some-id';
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.close', {}, id);
    const socketConnection = sinon.createStubInstance(SocketConnection);
    socketConnection.closeSubscription.throws(new DwnServerError(
      DwnServerErrorCode.ConnectionSubscriptionJsonRpcIdNotFound,
      ''
    ));

    const { dwn } = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws', socketConnection };

    const { jsonRpcResponse } = await handleSubscriptionsClose(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InvalidParams);
    expect(jsonRpcResponse.error.message).toBe(`subscription ${id} does not exist.`);
  });

  it('should return an error if close subscription throws ConnectionSubscriptionJsonRpcIdNotFound', async () => {
    const requestId = crypto.randomUUID();
    const id = 'some-id';
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.close', {}, id);
    const socketConnection = sinon.createStubInstance(SocketConnection);
    socketConnection.closeSubscription.throws(new Error('unknown error'));

    const { dwn } = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws', socketConnection };

    const { jsonRpcResponse } = await handleSubscriptionsClose(
      dwnRequest,
      context,
    );

    expect(jsonRpcResponse.error).toBeDefined();
    expect(jsonRpcResponse.error.code).toBe(JsonRpcErrorCodes.InternalError);
    expect(jsonRpcResponse.error.message).toBe(`unknown subscription close error for ${id}: unknown error`);
  });

  it('should return a success', async () => {
    const requestId = crypto.randomUUID();
    const id = 'some-id';
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.close', {}, id);
    const socketConnection = sinon.createStubInstance(SocketConnection);

    const { dwn } = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws', socketConnection };

    const { jsonRpcResponse } = await handleSubscriptionsClose(
      dwnRequest,
      context,
    );
    expect(jsonRpcResponse.error).toBeUndefined();
  });

  it('handler should generate a request Id if one is not provided with the request', async () => {
    const requestId = crypto.randomUUID();
    const id = 'some-id';
    const dwnRequest = createJsonRpcSubscriptionRequest(requestId, 'rpc.subscribe.close', {}, id);
    delete dwnRequest.id; // delete request id

    const socketConnection = sinon.createStubInstance(SocketConnection);

    const { dwn } = await getTestDwn();
    const context: RequestContext = { dwn, transport: 'ws', socketConnection };

    const { jsonRpcResponse } = await handleSubscriptionsClose(
      dwnRequest,
      context,
    );
    expect(jsonRpcResponse.error).toBeUndefined();
    expect(jsonRpcResponse.id).toBeDefined();
    expect(jsonRpcResponse.id).not.toBe(id);
  });
});
