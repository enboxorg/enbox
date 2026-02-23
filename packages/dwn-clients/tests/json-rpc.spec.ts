import { describe, expect, it } from 'bun:test';

import {
  createJsonRpcAck, createJsonRpcErrorResponse, createJsonRpcNotification, createJsonRpcRequest,
  createJsonRpcSubscriptionRequest, createJsonRpcSuccessResponse, JsonRpcErrorCodes, parseJson,
} from '../src/json-rpc.js';

describe('json-rpc', () => {
  describe('createJsonRpcRequest', () => {
    it('creates a request with id, method, and params', () => {
      const request = createJsonRpcRequest('req-1', 'dwn.processMessage', { target: 'did:example:123' });
      expect(request.jsonrpc).toBe('2.0');
      expect(request.id).toBe('req-1');
      expect(request.method).toBe('dwn.processMessage');
      expect(request.params).toEqual({ target: 'did:example:123' });
      expect(request.subscription).toBeUndefined();
    });

    it('creates a request without params', () => {
      const request = createJsonRpcRequest('req-2', 'server.info');
      expect(request.params).toBeUndefined();
    });
  });

  describe('createJsonRpcSubscriptionRequest', () => {
    it('creates a subscription request with all fields', () => {
      const request = createJsonRpcSubscriptionRequest(
        'req-3',
        'rpc.subscribe.dwn.processMessage',
        { target: 'did:example:123' },
        'sub-1',
      );
      expect(request.jsonrpc).toBe('2.0');
      expect(request.id).toBe('req-3');
      expect(request.method).toBe('rpc.subscribe.dwn.processMessage');
      expect(request.params).toEqual({ target: 'did:example:123' });
      expect(request.subscription).toEqual({ id: 'sub-1' });
    });

    it('defaults subscription id to null when omitted', () => {
      const request = createJsonRpcSubscriptionRequest('req-4', 'rpc.subscribe.test');
      expect(request.subscription!.id).toBeNull();
    });

    it('does not auto-prepend rpc.subscribe. prefix', () => {
      const request = createJsonRpcSubscriptionRequest('req-5', 'my.method', {}, 'sub-2');
      expect(request.method).toBe('my.method');
    });
  });

  describe('createJsonRpcSuccessResponse', () => {
    it('creates a success response with result', () => {
      const response = createJsonRpcSuccessResponse('req-1', { reply: { status: { code: 200 } } });
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('req-1');
      expect(response.result).toEqual({ reply: { status: { code: 200 } } });
      expect(response.error).toBeUndefined();
    });

    it('defaults result to null when omitted', () => {
      const response = createJsonRpcSuccessResponse('req-2');
      expect(response.result).toBeNull();
    });
  });

  describe('createJsonRpcErrorResponse', () => {
    it('creates an error response with code and message', () => {
      const response = createJsonRpcErrorResponse('req-1', JsonRpcErrorCodes.BadRequest, 'bad request');
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('req-1');
      expect(response.error.code).toBe(JsonRpcErrorCodes.BadRequest);
      expect(response.error.message).toBe('bad request');
      expect(response.error.data).toBeUndefined();
      expect(response.result).toBeUndefined();
    });

    it('includes data when provided', () => {
      const response = createJsonRpcErrorResponse('req-2', JsonRpcErrorCodes.InternalError, 'fail', { detail: 'trace' });
      expect(response.error.data).toEqual({ detail: 'trace' });
    });

    it('does not include data key when data is undefined', () => {
      const response = createJsonRpcErrorResponse('req-3', JsonRpcErrorCodes.ParseError, 'parse error');
      expect('data' in response.error).toBe(false);
    });
  });

  describe('createJsonRpcNotification', () => {
    it('creates a notification without an id', () => {
      const notification = createJsonRpcNotification('server.event', { type: 'update' });
      expect(notification.jsonrpc).toBe('2.0');
      expect(notification.id).toBeUndefined();
      expect(notification.method).toBe('server.event');
      expect(notification.params).toEqual({ type: 'update' });
    });

    it('creates a notification without params', () => {
      const notification = createJsonRpcNotification('server.ping');
      expect(notification.params).toBeUndefined();
    });
  });

  describe('createJsonRpcAck', () => {
    it('creates an ack notification with method rpc.ack, cursor in params, and subscription id', () => {
      const ack = createJsonRpcAck('sub-1', 'cursor-abc');
      expect(ack.jsonrpc).toBe('2.0');
      expect(ack.method).toBe('rpc.ack');
      expect(ack.params).toEqual({ cursor: 'cursor-abc' });
      expect(ack.subscription).toEqual({ id: 'sub-1' });
      // ack is a notification — no `id` field
      expect(ack.id).toBeUndefined();
    });

    it('works with null subscription id', () => {
      const ack = createJsonRpcAck(null, 'cursor-xyz');
      expect(ack.subscription!.id).toBeNull();
      expect(ack.params.cursor).toBe('cursor-xyz');
    });
  });

  describe('createJsonRpcErrorResponse — null data', () => {
    it('does not include data key when data is explicitly null', () => {
      const response = createJsonRpcErrorResponse('req-null', JsonRpcErrorCodes.InternalError, 'fail', null);
      // `null != undefined` is false (loose equality), so null is treated like undefined — data is omitted
      expect(response.error.data).toBeUndefined();
      expect('data' in response.error).toBe(false);
    });
  });

  describe('parseJson', () => {
    it('parses valid JSON', () => {
      const result = parseJson('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    it('returns null for invalid JSON', () => {
      const result = parseJson('not valid json');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = parseJson('');
      expect(result).toBeNull();
    });
  });
});
