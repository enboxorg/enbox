import type { JsonRpcResponse } from './json-rpc.js';
import type { ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { DwnReplicationApplyRequest, DwnRpc, DwnRpcAuthOptions, DwnRpcRequest, DwnRpcResponse } from './dwn-rpc-types.js';
import type { DwnServerInfoCache, ServerInfo } from './server-info-types.js';

import { attachBearerToken } from './rpc-auth.js';
import { CryptoUtils } from '@enbox/crypto';
import { DwnRpcError } from './dwn-rpc-error.js';
import { DwnServerInfoCacheMemory } from './dwn-server-info-cache-memory.js';
import { normalizeReadableStream } from './readable-stream.js';
import { parseReplicationApplyResult } from './replication-apply-result.js';
import { RateLimitError } from './rate-limit-error.js';
import { sleep } from '@enbox/common';
import { createJsonRpcRequest, JsonRpcErrorCodes, parseJson } from './json-rpc.js';

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

/** Default number of retry attempts for transient HTTP failures. */
const DEFAULT_MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff. */
const DEFAULT_BASE_DELAY_MS = 500;

/** Maximum backoff delay in milliseconds. */
const DEFAULT_MAX_DELAY_MS = 10_000;

/** Per-request timeout in milliseconds (prevents hung connections / SSRF). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Larger per-attempt timeout for data-bearing replicated apply uploads. */
const DEFAULT_LARGE_REPLICATED_APPLY_TIMEOUT_MS = 300_000;

/** HTTP status codes that are considered retryable. */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Options for controlling HTTP retry behaviour.
 */
export type HttpRetryOptions = {
  /** Maximum number of retry attempts (0 = no retries). Default: 3. */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff. Default: 500. */
  baseDelayMs?: number;
  /** Maximum backoff delay in milliseconds. Default: 10 000. */
  maxDelayMs?: number;
};

/**
 * Determines whether a fetch error or HTTP response warrants a retry.
 * Network errors (TypeError from fetch) and specific HTTP status codes are retryable.
 */
function isRetryable(error?: unknown, response?: Response): boolean {
  if (error instanceof TypeError) {
    // TypeError is thrown by fetch for network-level failures (DNS, connection refused, etc.).
    return true;
  }
  if (response) {
    return RETRYABLE_STATUS_CODES.has(response.status);
  }
  return false;
}

/**
 * Computes the backoff delay with jitter for a given attempt.
 * Uses exponential backoff: `min(baseDelay * 2^attempt, maxDelay) * jitter`.
 */
function computeBackoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  // Jitter: random delay in [exponentialDelay/2, exponentialDelay).
  const halfDelay = Math.floor(exponentialDelay / 2);
  return halfDelay + (crypto.getRandomValues(new Uint32Array(1))[0] % (halfDelay || 1));
}

/**
 * Parses a `retry-after` header value into milliseconds.
 * Supports both delay-seconds (e.g. "120") and HTTP-date formats.
 * Returns `undefined` if the header is absent or unparseable.
 */
function parseRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) {
    return undefined;
  }

  // Try as integer seconds first.
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try as HTTP-date.
  const date = new Date(retryAfter);
  if (!Number.isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }

  return undefined;
}

function createAttemptInit(init: RequestInit | undefined, requestTimeoutMs: number): RequestInit {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  if (init?.signal === undefined || init.signal === null) {
    return { ...init, signal: timeoutSignal };
  }

  return { ...init, signal: AbortSignal.any([init.signal, timeoutSignal]) };
}

function shouldReturnResponse(response: Response, attempt: number, maxRetriesForRequest: number): boolean {
  return !RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxRetriesForRequest;
}

function shouldRethrowFetchError(error: unknown, attempt: number, maxRetriesForRequest: number): boolean {
  return !isRetryable(error) || attempt === maxRetriesForRequest;
}

function getRetryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, lastResponse?: Response): number {
  const retryAfterMs = lastResponse !== undefined ? parseRetryAfterMs(lastResponse) : undefined;
  const backoffMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);

  return retryAfterMs === undefined ? backoffMs : Math.max(retryAfterMs, backoffMs);
}

/**
 * Mutates the request options and headers with an octet-stream body.
 * Returns whether the body is replayable for transport-level retries.
 */
function attachDataRequestBody(fetchOpts: RequestInit, requestHeaders: Record<string, string>, requestBody: BodyInit): boolean {
  requestHeaders['content-type'] = 'application/octet-stream';
  fetchOpts.body = requestBody;

  if (requestBody instanceof ReadableStream) {
    // Required by the Fetch standard for streaming request bodies. The stream is one-shot,
    // so transport-level retries must not replay the same body after a failed attempt.
    (fetchOpts as RequestInit & { duplex: 'half' }).duplex = 'half';
    return false;
  }

  return true;
}

/**
 * HTTP client that can be used to communicate with Dwn Servers.
 *
 * Supports automatic retry with exponential backoff and jitter for transient
 * network errors and retryable HTTP status codes (408, 429, 500, 502, 503, 504).
 * Respects the `Retry-After` response header when present.
 */
export class HttpDwnRpcClient implements DwnRpc {
  private readonly serverInfoCache: DwnServerInfoCache;
  private readonly _retryOptions: Required<HttpRetryOptions>;
  private readonly _authOptions: DwnRpcAuthOptions;

  constructor(serverInfoCache?: DwnServerInfoCache, retryOptions?: HttpRetryOptions, authOptions: DwnRpcAuthOptions = {}) {
    this.serverInfoCache = serverInfoCache ?? new DwnServerInfoCacheMemory();
    this._authOptions = authOptions;
    this._retryOptions = {
      maxRetries  : retryOptions?.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs : retryOptions?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs  : retryOptions?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    };
  }

  get transportProtocols(): string[] { return ['http:', 'https:']; }

  async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      target  : request.targetDid,
      message : request.message
    });

    const requestHeaders: Record<string, string> = {
      'dwn-request': JSON.stringify(jsonRpcRequest)
    };
    attachBearerToken(requestHeaders, this._authOptions, request.dwnUrl);

    const fetchOpts: RequestInit = {
      method  : 'POST',
      headers : requestHeaders,
      // Caller-provided signal is honoured by `fetchWithRetry` via
      // `AbortSignal.any([signal, perAttemptTimeoutSignal])`. Aborting
      // short-circuits the retry loop (AbortError is non-retryable) so
      // latency-sensitive callers can cap worst-case wall-clock time.
      ...(request.signal ? { signal: request.signal } : {}),
    };

    let isRequestBodyReplayable = true;
    if (request.data !== undefined) {
      isRequestBodyReplayable = attachDataRequestBody(fetchOpts, requestHeaders, request.data as BodyInit);
    }

    const resp = await this.fetchWithRetry(request.dwnUrl, fetchOpts, {
      requestTimeoutMs     : request.timeoutMs,
      retryableRequestBody : isRequestBodyReplayable,
    });

    // After retries are exhausted, a 429 means we're still rate-limited.
    // Per-IP 429s return plain JSON (not a JSON-RPC envelope), so we must
    // check the status before attempting JSON-RPC parsing.
    if (resp.status === 429) {
      const retryAfter = Number.parseInt(resp.headers.get('retry-after') ?? '1', 10);
      throw new RateLimitError(retryAfter);
    }

    let dwnRpcResponse: JsonRpcResponse;

    // When the server streams record data back, the JSON-RPC envelope is in the
    // `dwn-response` header and the body is the raw data stream.  Otherwise the
    // entire JSON-RPC response is the body.
    const hasDataStream = resp.headers.has('dwn-response');

    if (hasDataStream) {
      const jsonRpcResponse = parseJson(resp.headers.get('dwn-response')!) as JsonRpcResponse;

      if (jsonRpcResponse == null) {
        throw new Error(`failed to parse json rpc response. dwn url: ${request.dwnUrl}`);
      }

      dwnRpcResponse = jsonRpcResponse;
    } else {
      const responseBody = await resp.text();
      const jsonRpcResponse = parseJson(responseBody) as JsonRpcResponse;

      if (jsonRpcResponse == null) {
        throw new Error(`failed to parse json rpc response. dwn url: ${request.dwnUrl}, status: ${resp.status}`);
      }

      dwnRpcResponse = jsonRpcResponse;
    }

    if (dwnRpcResponse.error) {
      const { code, message } = dwnRpcResponse.error;
      if (code === JsonRpcErrorCodes.TooManyRequests) {
        const retryAfter = dwnRpcResponse.error.data?.retryAfterSec ?? 1;
        throw new RateLimitError(retryAfter);
      }
      throw new DwnRpcError(code, message, dwnRpcResponse.error.data);
    }

    const { reply } = dwnRpcResponse.result;
    if (hasDataStream) {
      const dataStream = resp.body;
      if (dataStream === null) {
        throw new Error(`missing data stream in json rpc response. dwn url: ${request.dwnUrl}`);
      }
      if (reply.record) {
        reply.record.data = normalizeReadableStream(dataStream);
      } else if (reply.entry) {
        reply.entry.data = normalizeReadableStream(dataStream);
      }
    }

    return reply as DwnRpcResponse;
  }

  async applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> {
    const requestId = CryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      target  : request.targetDid,
      message : request.message
    });

    const requestHeaders: Record<string, string> = {
      'dwn-request': JSON.stringify(jsonRpcRequest)
    };
    attachBearerToken(requestHeaders, this._authOptions, request.dwnUrl);

    const fetchOpts: RequestInit = {
      method  : 'POST',
      headers : requestHeaders,
      ...(request.signal ? { signal: request.signal } : {}),
    };

    let isRequestBodyReplayable = true;
    if (request.data !== undefined) {
      isRequestBodyReplayable = attachDataRequestBody(fetchOpts, requestHeaders, request.data as BodyInit);
    }

    const resp = await this.fetchWithRetry(request.dwnUrl, fetchOpts, {
      requestTimeoutMs     : request.timeoutMs ?? defaultReplicationApplyTimeoutMs(request.message),
      retryableRequestBody : isRequestBodyReplayable,
    });
    if (resp.status === 429) {
      const retryAfter = Number.parseInt(resp.headers.get('retry-after') ?? '1', 10);
      throw new RateLimitError(retryAfter);
    }

    const responseBody = await resp.text();
    const jsonRpcResponse = parseJson(responseBody) as JsonRpcResponse;
    if (jsonRpcResponse == null) {
      throw new Error(`failed to parse json rpc response. dwn url: ${request.dwnUrl}, status: ${resp.status}`);
    }

    if (jsonRpcResponse.error) {
      const { code, message } = jsonRpcResponse.error;
      if (code === JsonRpcErrorCodes.TooManyRequests) {
        const retryAfter = jsonRpcResponse.error.data?.retryAfterSec ?? 1;
        throw new RateLimitError(retryAfter);
      }
      throw new DwnRpcError(code, message, jsonRpcResponse.error.data);
    }

    return parseReplicationApplyResult(jsonRpcResponse.result.result);
  }

  async getServerInfo(dwnUrl: string): Promise<ServerInfo> {
    const serverInfo = await this.serverInfoCache.get(dwnUrl);
    if (serverInfo) {
      return serverInfo;
    }

    const url = new URL(dwnUrl);

    // add `/info` to the dwn server url path
    url.pathname.endsWith('/') ? url.pathname += 'info' : url.pathname += '/info';

    try {
      const response = await this.fetchWithRetry(url.toString());
      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
        throw new RateLimitError(retryAfter);
      }
      if (response.ok) {
        const results = await response.json() as ServerInfo;

        const serverInfo: ServerInfo = {
          localNode                : results.localNode,
          localPairing             : results.localPairing,
          maxFileSize              : results.maxFileSize,
          maxInFlight              : results.maxInFlight,
          providerAuth             : results.providerAuth,
          registrationRequirements : results.registrationRequirements,
          server                   : results.server,
          sdkVersion               : results.sdkVersion,
          url                      : results.url,
          version                  : results.version,
          webSocketSupport         : results.webSocketSupport,
        };
        this.serverInfoCache.set(dwnUrl, serverInfo);

        return serverInfo;
      } else {
        throw new Error(`HTTP (${response.status}) - ${response.statusText}`);
      }
    } catch (error: any) {
      throw new Error(`Error encountered while processing response from ${url.toString()}: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Retry logic
  // ---------------------------------------------------------------------------

  /**
   * Wrapper around `fetch()` that retries on transient network errors and
   * retryable HTTP status codes with exponential backoff and jitter.
   * Honours the `Retry-After` response header when present.
   */
  private async fetchWithRetry(
    url: string,
    init?: RequestInit,
    options: { requestTimeoutMs?: number; retryableRequestBody?: boolean } = {},
  ): Promise<Response> {
    const { maxRetries, baseDelayMs, maxDelayMs } = this._retryOptions;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxRetriesForRequest = options.retryableRequestBody === false ? 0 : maxRetries;

    let lastError: unknown;
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= maxRetriesForRequest; attempt++) {
      try {
        // Apply a per-attempt timeout to prevent hung connections / SSRF.
        // If the caller already supplied a signal, combine it with the timeout
        // via AbortSignal.any(); otherwise create a fresh timeout signal.
        const response = await fetch(url, createAttemptInit(init, requestTimeoutMs));
        if (shouldReturnResponse(response, attempt, maxRetriesForRequest)) {
          return response;
        }

        // Retryable status — back off and try again.
        lastResponse = response;
      } catch (error: unknown) {
        if (shouldRethrowFetchError(error, attempt, maxRetriesForRequest)) {
          throw error;
        }
        lastError = error;
      }

      // Compute the delay, preferring Retry-After when available.
      await sleep(getRetryDelayMs(attempt, baseDelayMs, maxDelayMs, lastResponse));
    }

    // Should not reach here, but satisfy the compiler.
    if (lastResponse) {
      return lastResponse;
    }
    throw lastError;
  }
}

function defaultReplicationApplyTimeoutMs(message: DwnReplicationApplyRequest['message']): number | undefined {
  const dataSize = (message as { descriptor?: { dataSize?: unknown } }).descriptor?.dataSize;
  return typeof dataSize === 'number' && dataSize > 1_048_576
    ? DEFAULT_LARGE_REPLICATED_APPLY_TIMEOUT_MS
    : undefined;
}
