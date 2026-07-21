import { JsonRpcErrorCodes } from './json-rpc.js';

/**
 * Rejection a subscription handler uses to declare its delivery pipeline
 * terminally failed for the remainder of the subscription.
 *
 * The WebSocket transport reacts by closing the tracked subscription and
 * withholding the acknowledgement — and reconnect-cursor advancement — for the
 * triggering event and every later one, so an eventual resubscription replays
 * everything the consumer did not fully process. The thrower is responsible
 * for informing its own consumer (e.g. with a synthetic `error` subscription
 * message); the transport only handles close/ack semantics.
 *
 * Any other handler rejection is swallowed and the event acknowledged,
 * matching the plain-handler convention.
 */
export class SubscriptionHandlerTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionHandlerTerminalError';
  }
}

/**
 * Rejection meaning the WebSocket transport could not take a request at all —
 * the socket was not connected, or a connection could not be established. The
 * request was NEVER transmitted, so retrying it on another transport is safe:
 * the socket-preferred router falls back to HTTP on exactly this error and no
 * other.
 */
export class SocketUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketUnavailableError';
  }
}

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
    this.terminal = isTerminalJsonRpcErrorCode(code, message, data);
  }
}

/**
 * JSON-RPC errors that represent deterministic request rejection before DWN
 * replicated admission can run. Internal/server/transport/rate-limit errors
 * remain retryable.
 */
export function isTerminalJsonRpcErrorCode(code: JsonRpcErrorCodes, message = '', data?: unknown): boolean {
  if (isQuotaExceededError(message, data)) {
    return false;
  }

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

/**
 * True when a JSON-RPC error envelope represents a tenant quota rejection
 * (storage or message count). These are *not* terminal — a later attempt can
 * succeed after quota grows or another writer delivers the same CID — but they
 * are also not blindly retryable: a caller that keeps re-pushing the same
 * over-quota message hot-loops. Sync uses this to route quota rejections into
 * a backed-off re-probe path instead of the generic retry.
 */
export function isQuotaExceededError(message: string, data: unknown): boolean {
  const code = typeof data === 'object' && data !== null && 'code' in data
    ? (data as { code?: unknown }).code
    : undefined;
  return code === 'TenantMessageQuotaExceeded' ||
    code === 'TenantStorageQuotaExceeded' ||
    message.includes('TenantMessageQuotaExceeded') ||
    message.includes('TenantStorageQuotaExceeded');
}
