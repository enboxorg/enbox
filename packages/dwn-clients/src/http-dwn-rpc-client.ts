import type { JsonRpcResponse } from './json-rpc.js';
import type { ParsedHttpDwnRpcResponseBody } from './http-dwn-rpc-framing.js';
import type { ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type { DwnReplicationApplyRequest, DwnRpc, DwnRpcAuthOptions, DwnRpcRequest, DwnRpcResponse } from './dwn-rpc-types.js';
import type { DwnServerInfoCache, ServerInfo } from './server-info-types.js';

import { attachBearerToken } from './rpc-auth.js';
import { createHttpDwnRpcRequest } from './http-dwn-rpc-headers.js';
import { CryptoUtils } from '@enbox/crypto';
import { DwnServerInfoCacheMemory } from './dwn-server-info-cache-memory.js';
import { normalizeReadableStream } from './readable-stream.js';
import { parseReplicationApplyResult } from './replication-apply-result.js';
import { RateLimitError } from './rate-limit-error.js';
import { sleep } from '@enbox/common';
import { createJsonRpcRequest, JsonRpcErrorCodes, parseJson } from './json-rpc.js';
import { DwnRpcError, isTerminalJsonRpcErrorCode } from './dwn-rpc-error.js';
import { isHttpDwnRpcContentType, parseHttpDwnRpcResponseBody } from './http-dwn-rpc-framing.js';

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
  /** Maximum retry delay in milliseconds, including `Retry-After`. Default: 10 000. */
  maxDelayMs?: number;
};

type FetchWithRetryOptions = {
  requestTimeoutMs?: number;
  retryableRequestBody?: boolean;
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

  // Delay-seconds is one or more decimal digits; fractions, signs, and
  // non-finite numeric spellings are not valid Retry-After values.
  if (/^\d+$/.test(retryAfter)) {
    const delayMs = Number(retryAfter) * 1000;
    if (Number.isFinite(delayMs)) {
      return delayMs;
    }
  }

  // Try as HTTP-date.
  const date = new Date(retryAfter);
  if (!Number.isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return Math.max(delayMs, 0);
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

async function shouldReturnResponse(response: Response, attempt: number, maxRetriesForRequest: number): Promise<boolean> {
  if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxRetriesForRequest) {
    return true;
  }
  if (response.status !== 500) {
    return false;
  }

  try {
    const jsonRpcResponse = parseJson(await response.clone().text()) as JsonRpcResponse;
    const error = jsonRpcResponse?.error;
    return error !== undefined && isTerminalJsonRpcErrorCode(error.code, error.message, error.data);
  } catch {
    // An unreadable response body is not evidence of a terminal RPC error.
    return false;
  }
}

function shouldRethrowFetchError(error: unknown, attempt: number, maxRetriesForRequest: number): boolean {
  return !isRetryable(error) || attempt === maxRetriesForRequest;
}

function getRetryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, lastResponse?: Response): number {
  const retryAfterMs = lastResponse !== undefined ? parseRetryAfterMs(lastResponse) : undefined;
  const backoffMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);

  return Math.min(maxDelayMs, retryAfterMs === undefined ? backoffMs : Math.max(retryAfterMs, backoffMs));
}

function retryAfterSeconds(response: Response): number {
  const retryAfterMs = parseRetryAfterMs(response);
  return retryAfterMs === undefined ? 1 : Math.ceil(retryAfterMs / 1000);
}

/**
 * Mutates the request options with a body, setting `duplex` as the Fetch standard
 * requires for streams. Returns whether the body is replayable for transport-level
 * retries: a stream is one-shot, so retries must not replay it after a failed attempt.
 */
function attachRequestBody(fetchOpts: RequestInit, body: BodyInit): boolean {
  fetchOpts.body = body;

  if (body instanceof ReadableStream) {
    (fetchOpts as RequestInit & { duplex: 'half' }).duplex = 'half';
    return false;
  }

  return true;
}

/** Cancels a response data stream that no reply field will own, releasing the HTTP response. */
async function cancelUnclaimedStream(dataStream: ReadableStream<Uint8Array> | undefined): Promise<void> {
  await dataStream?.cancel().catch((): void => {
    // The stream is being discarded; cancellation is best-effort.
  });
}

/**
 * HTTP client that can be used to communicate with Dwn Servers.
 *
 * Supports automatic retry with exponential backoff and jitter for transient
 * network errors and retryable HTTP status codes (408, 429, 500, 502, 503, 504).
 * Respects a valid `Retry-After` response header up to the configured maximum delay.
 */
export class HttpDwnRpcClient implements DwnRpc {
  private readonly serverInfoCache: DwnServerInfoCache;
  private readonly serverInfoRequests = new Map<string, Promise<ServerInfo>>();
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
    const responseController = new AbortController();
    const signal = request.signal === undefined
      ? responseController.signal
      : AbortSignal.any([request.signal, responseController.signal]);
    const requestId = CryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      target  : request.targetDid,
      message : request.message
    });

    const { fetchOpts, isRequestBodyReplayable } = await this.createDwnRequestInit({
      data   : request.data as BodyInit | undefined,
      dwnUrl : request.dwnUrl,
      jsonRpcRequest,
      signal,
    });

    const resp = await this.fetchWithRetry(request.dwnUrl, fetchOpts, {
      requestTimeoutMs     : request.timeoutMs,
      retryableRequestBody : isRequestBodyReplayable,
    });

    // After retries are exhausted, a 429 means we're still rate-limited.
    // Per-IP 429s return plain JSON (not a JSON-RPC envelope), so we must
    // check the status before attempting JSON-RPC parsing.
    if (resp.status === 429) {
      throw new RateLimitError(retryAfterSeconds(resp));
    }

    const { jsonRpcResponse: dwnRpcResponse, dataStream } = await this.parseDwnRpcResponse(resp, request.dwnUrl, responseController);

    if (dwnRpcResponse.error) {
      await cancelUnclaimedStream(dataStream);
      const { code, message } = dwnRpcResponse.error;
      if (code === JsonRpcErrorCodes.TooManyRequests) {
        const retryAfter = dwnRpcResponse.error.data?.retryAfterSec ?? 1;
        throw new RateLimitError(retryAfter);
      }
      throw new DwnRpcError(code, message, dwnRpcResponse.error.data);
    }

    const { reply } = dwnRpcResponse.result;
    if (dataStream !== undefined) {
      if (reply.record) {
        reply.record.data = dataStream;
      } else if (reply.entry) {
        reply.entry.data = dataStream;
      } else {
        await cancelUnclaimedStream(dataStream);
      }
    }

    return reply as DwnRpcResponse;
  }

  async applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> {
    const requestId = CryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
      target  : request.targetDid,
      message : request.message,
      ...(request.ancestryOnly === true ? { ancestryOnly: true } : {}),
      ...(request.includeMaterializationConfirmation === true ? { includeMaterializationConfirmation: true } : {}),
    });

    const { fetchOpts, isRequestBodyReplayable } = await this.createDwnRequestInit({
      data   : request.data as BodyInit | undefined,
      dwnUrl : request.dwnUrl,
      jsonRpcRequest,
      signal : request.signal,
    });

    const resp = await this.fetchWithRetry(request.dwnUrl, fetchOpts, {
      requestTimeoutMs     : request.timeoutMs ?? defaultReplicationApplyTimeoutMs(request.message),
      retryableRequestBody : isRequestBodyReplayable,
    });
    if (resp.status === 429) {
      throw new RateLimitError(retryAfterSeconds(resp));
    }

    const { jsonRpcResponse, dataStream } = await this.parseDwnRpcResponse(resp, request.dwnUrl);
    await cancelUnclaimedStream(dataStream);

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

    let pendingRequest = this.serverInfoRequests.get(dwnUrl);
    if (pendingRequest === undefined) {
      pendingRequest = this.fetchServerInfo(dwnUrl)
        .finally(() => this.serverInfoRequests.delete(dwnUrl));
      this.serverInfoRequests.set(dwnUrl, pendingRequest);
    }

    return pendingRequest;
  }

  /**
   * Parses the JSON-RPC response of an HTTP DWN RPC call. A reply that carries record data
   * arrives as a framed body: the JSON-RPC response followed by the raw data stream, which
   * stays tied to `responseController` so cancelling it releases the HTTP response. Any
   * other response body is plain JSON.
   *
   * @throws Error when the JSON-RPC response cannot be parsed.
   */
  private async parseDwnRpcResponse(
    resp: Response,
    dwnUrl: string,
    responseController?: AbortController,
  ): Promise<ParsedHttpDwnRpcResponseBody> {
    if (!isHttpDwnRpcContentType(resp.headers.get('content-type'))) {
      const jsonRpcResponse = parseJson(await resp.text()) as JsonRpcResponse;
      if (jsonRpcResponse == null) {
        throw new Error(`failed to parse json rpc response. dwn url: ${dwnUrl}, status: ${resp.status}`);
      }

      return { jsonRpcResponse };
    }

    if (resp.body === null) {
      throw new Error(`failed to parse json rpc response. dwn url: ${dwnUrl}: the framed response has no body`);
    }

    let parsed: ParsedHttpDwnRpcResponseBody;
    try {
      parsed = await parseHttpDwnRpcResponseBody(normalizeReadableStream(resp.body, responseController));
    } catch (error: unknown) {
      throw new Error(`failed to parse json rpc response. dwn url: ${dwnUrl}: ${(error as Error).message}`);
    }

    if (typeof parsed.jsonRpcResponse !== 'object' || parsed.jsonRpcResponse === null) {
      await cancelUnclaimedStream(parsed.dataStream);
      throw new Error(`failed to parse json rpc response. dwn url: ${dwnUrl}: the framed envelope is not an object`);
    }

    return parsed;
  }

  private async createDwnRequestInit({
    data,
    dwnUrl,
    jsonRpcRequest,
    signal,
  }: {
    data?: BodyInit;
    dwnUrl: string;
    jsonRpcRequest: ReturnType<typeof createJsonRpcRequest>;
    signal?: AbortSignal;
  }): Promise<{ fetchOpts: RequestInit; isRequestBodyReplayable: boolean }> {
    signal?.throwIfAborted();
    const { body, headers } = await createHttpDwnRpcRequest(jsonRpcRequest, data);
    attachBearerToken(headers, this._authOptions, dwnUrl);

    const fetchOpts: RequestInit = {
      method: 'POST',
      headers,
      // Caller-provided signal is honoured by `fetchWithRetry` via
      // `AbortSignal.any([signal, perAttemptTimeoutSignal])`. Aborting
      // short-circuits the retry loop (AbortError is non-retryable) so
      // latency-sensitive callers can cap worst-case wall-clock time.
      ...(signal ? { signal } : {}),
    };

    return { fetchOpts, isRequestBodyReplayable: attachRequestBody(fetchOpts, body) };
  }

  private async fetchServerInfo(dwnUrl: string): Promise<ServerInfo> {
    const url = new URL(dwnUrl);

    // add `/info` to the dwn server url path
    if (url.pathname.endsWith('/')) {
      url.pathname += 'info';
    } else {
      url.pathname += '/info';
    }

    try {
      const response = await this.fetchWithRetry(url.toString());
      if (response.status === 429) {
        throw new RateLimitError(retryAfterSeconds(response));
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
        await this.serverInfoCache.set(dwnUrl, serverInfo);

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
   * Honours a valid `Retry-After` response header up to the configured maximum delay.
   */
  private async fetchWithRetry(
    url: string,
    init?: RequestInit,
    options: FetchWithRetryOptions = {},
  ): Promise<Response> {
    const { maxRetries, baseDelayMs, maxDelayMs } = this._retryOptions;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxRetriesForRequest = options.retryableRequestBody === false ? 0 : maxRetries;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetriesForRequest; attempt++) {
      let retryResponse: Response | undefined;
      try {
        // Apply a per-attempt timeout to prevent hung connections / SSRF.
        // If the caller already supplied a signal, combine it with the timeout
        // via AbortSignal.any(); otherwise create a fresh timeout signal.
        const response = await fetch(url, createAttemptInit(init, requestTimeoutMs));
        if (await shouldReturnResponse(response, attempt, maxRetriesForRequest)) {
          return response;
        }

        // Retryable status — back off and try again.
        retryResponse = response;
      } catch (error: unknown) {
        if (shouldRethrowFetchError(error, attempt, maxRetriesForRequest)) {
          throw error;
        }
        lastError = error;
      }

      // Compute the delay, preferring Retry-After when available.
      await sleep(
        getRetryDelayMs(attempt, baseDelayMs, maxDelayMs, retryResponse),
        init?.signal ?? undefined,
      );
    }

    // Should not reach here, but satisfy the compiler.
    throw lastError;
  }
}

function defaultReplicationApplyTimeoutMs(message: DwnReplicationApplyRequest['message']): number | undefined {
  const dataSize = (message as { descriptor?: { dataSize?: unknown } }).descriptor?.dataSize;
  return typeof dataSize === 'number' && dataSize > 1_048_576
    ? DEFAULT_LARGE_REPLICATED_APPLY_TIMEOUT_MS
    : undefined;
}
