import type { ProgressToken } from '@enbox/dwn-sdk-js';

export type JsonRpcId = string | number | null;
export type JsonRpcVersion = '2.0';

export interface JsonRpcRequest {
  jsonrpc: JsonRpcVersion;
  id?: JsonRpcId;
  method: string;
  params?: any;
  /** JSON RPC Subscription Extension Parameters */
  subscription?: { id: JsonRpcId };
}

export interface JsonRpcError {
  code: JsonRpcErrorCodes;
  message: string;
  data?: any;
}

export interface JsonRpcSubscription {
  /** JSON RPC Id of the Subscription Request */
  id: JsonRpcId;
  close: () => Promise<void>;
}

export enum JsonRpcErrorCodes {
  // JSON-RPC 2.0 pre-defined errors
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  ParseError = -32700,
  TransportError = -32300,

  // App defined errors
  BadRequest = -50400, // equivalent to HTTP Status 400
  Unauthorized = -50401, // equivalent to HTTP Status 401
  Forbidden = -50403, // equivalent to HTTP Status 403
  Conflict = -50409, // equivalent to HTTP Status 409
  TooManyRequests = -50429, // equivalent to HTTP Status 429
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface JsonRpcSuccessResponse {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  result: any;
  error?: never;
}

export interface JsonRpcErrorResponse {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  result?: never;
  error: JsonRpcError;
}

export const createJsonRpcErrorResponse = (
  id: JsonRpcId,
  code: JsonRpcErrorCodes,
  message: string,
  data?: any,
): JsonRpcErrorResponse => {
  const error: JsonRpcError = { code, message };
  if (data != undefined) {
    error.data = data;
  }
  return {
    jsonrpc: '2.0',
    id,
    error,
  };
};

export const createJsonRpcRequest = (
  id: JsonRpcId,
  method: string,
  params?: any,
): JsonRpcRequest => {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
};

/**
 * Creates a JSON-RPC subscription request.
 *
 * The caller is responsible for providing the full method name including
 * any `rpc.subscribe.` prefix.
 */
export const createJsonRpcSubscriptionRequest = (
  id: JsonRpcId,
  method: string,
  params?: any,
  subscriptionId?: JsonRpcId,
): JsonRpcRequest => {
  return {
    jsonrpc      : '2.0',
    id,
    method,
    params,
    subscription : {
      id: subscriptionId ?? null,
    }
  };
};

/**
 * Creates a JSON-RPC notification to acknowledge receipt of subscription events
 * up to the given progress token. No `id` is set because no response is expected.
 */
export const createJsonRpcAck = (
  subscriptionId: JsonRpcId,
  cursor: ProgressToken,
): JsonRpcRequest => {
  return {
    jsonrpc      : '2.0',
    method       : 'rpc.ack',
    params       : { cursor },
    subscription : { id: subscriptionId },
  };
};

export const createJsonRpcSuccessResponse = (
  id: JsonRpcId,
  result?: any,
): JsonRpcSuccessResponse => {
  return {
    jsonrpc : '2.0',
    id,
    result  : result ?? null,
  };
};

/**
 * Safely parses a JSON string, returning `null` on failure instead of throwing.
 */
export function parseJson(text: string): object | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
