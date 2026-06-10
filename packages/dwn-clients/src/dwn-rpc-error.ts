import { JsonRpcErrorCodes } from './json-rpc.js';

/**
 * Error surfaced by DWN JSON-RPC transports when the server returns a typed
 * JSON-RPC error envelope.
 */
export class DwnRpcError extends Error {
  public readonly code: JsonRpcErrorCodes;
  public readonly data?: unknown;
  public readonly terminal: boolean;

  constructor(code: JsonRpcErrorCodes, message: string, data?: unknown) {
    super(`(${code}) - ${message}`);
    this.name = 'DwnRpcError';
    this.code = code;
    this.data = data;
    this.terminal = isTerminalJsonRpcErrorCode(code);
  }
}

/**
 * JSON-RPC errors that represent deterministic request rejection before DWN
 * replicated admission can run. Internal/server/transport/rate-limit errors
 * remain retryable.
 */
export function isTerminalJsonRpcErrorCode(code: JsonRpcErrorCodes): boolean {
  switch (code) {
    case JsonRpcErrorCodes.InvalidRequest:
    case JsonRpcErrorCodes.InvalidParams:
    case JsonRpcErrorCodes.BadRequest:
    case JsonRpcErrorCodes.Unauthorized:
    case JsonRpcErrorCodes.Forbidden:
    case JsonRpcErrorCodes.Conflict:
      return true;
    default:
      return false;
  }
}
