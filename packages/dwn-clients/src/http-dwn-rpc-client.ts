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
import {
  createHttpDwnRpcRequestBody,
  HTTP_DWN_RPC_BODY_V1,
  HTTP_DWN_RPC_BODY_V1_CONTENT_TYPE,
} from './http-dwn-rpc-framing.js';
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

/** Short caller wait budget for optional HTTP framing capability discovery. */
const DEFAULT_CAPABILITY_DISCOVERY_TIMEOUT_MS = 2_000;

/** Backoff after optional capability discovery fails. */
const CAPABILITY_DISCOVERY_FAILURE_BACKOFF_MS = 30_000;

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

  // Try as integer seconds first.
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
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
 * Rejects with the signal's abort reason if `signal` aborts before `promise`
 * settles. The underlying operation is not cancelled — only the caller's wait.
 */
async function waitForPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted();

  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
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

/** Returns whether a server advertises the version-one HTTP request body framing. */
function advertisesHttpRpcBodyV1(serverInfo: ServerInfo): boolean {
  return serverInfo.httpRpcFraming?.includes(HTTP_DWN_RPC_BODY_V1) === true;
}

/**
 * HTTP client that can be used to communicate with Dwn Servers.
 *
 * Supports automatic retry with exponential backoff and jitter for transient
 * network errors and retryable HTTP status codes (408, 429, 500, 502, 503, 504).
 * Respects the `Retry-After` response header when present.
 */
export class HttpDwnRpcClient implements DwnRpc {
  private readonly serverInfoDiscoveryRetryAfter = new Map<string, number>();
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
    const requestId = CryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      target  : request.targetDid,
      message : request.message
    });

    const { fetchOpts, isRequestBodyReplayable } = await this.createDwnRequestInit({
      data   : request.data as BodyInit | undefined,
      dwnUrl : request.dwnUrl,
      jsonRpcRequest,
      signal : request.signal,
    });

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

    // When the server streams record data back, the JSON-RPC envelope is in the
    // `dwn-response` header and the body is the raw data stream.  Otherwise the
    // entire JSON-RPC response is the body.
    const hasDataStream = resp.headers.has('dwn-response');
    const dwnRpcResponse = await this.parseDwnRpcResponseBody(resp, hasDataStream, request.dwnUrl);

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

    let pendingRequest = this.serverInfoRequests.get(dwnUrl);
    if (pendingRequest === undefined) {
      pendingRequest = this.fetchServerInfo(dwnUrl)
        .finally(() => this.serverInfoRequests.delete(dwnUrl));
      this.serverInfoRequests.set(dwnUrl, pendingRequest);
    }

    return pendingRequest;
  }

  /**
   * Parses the JSON-RPC envelope from a `sendDwnRequest()` response. When the server streamed
   * record data back, the envelope is in the `dwn-response` header; otherwise the envelope is
   * the entire response body.
   *
   * @throws Error when the JSON-RPC envelope cannot be parsed.
   */
  private async parseDwnRpcResponseBody(resp: Response, hasDataStream: boolean, dwnUrl: string): Promise<JsonRpcResponse> {
    if (hasDataStream) {
      const jsonRpcResponse = parseJson(resp.headers.get('dwn-response')!) as JsonRpcResponse;

      if (jsonRpcResponse == null) {
        throw new Error(`failed to parse json rpc response. dwn url: ${dwnUrl}`);
      }

      return jsonRpcResponse;
    }

    const responseBody = await resp.text();
    const jsonRpcResponse = parseJson(responseBody) as JsonRpcResponse;

    if (jsonRpcResponse == null) {
      throw new Error(`failed to parse json rpc response. dwn url: ${dwnUrl}, status: ${resp.status}`);
    }

    return jsonRpcResponse;
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
    const requestHeaders: Record<string, string> = {};
    attachBearerToken(requestHeaders, this._authOptions, dwnUrl);

    const fetchOpts: RequestInit = {
      method  : 'POST',
      headers : requestHeaders,
      // Caller-provided signal is honoured by `fetchWithRetry` via
      // `AbortSignal.any([signal, perAttemptTimeoutSignal])`. Aborting
      // short-circuits the retry loop (AbortError is non-retryable) so
      // latency-sensitive callers can cap worst-case wall-clock time.
      ...(signal ? { signal } : {}),
    };

    if (await this.supportsHttpRpcBodyV1(dwnUrl, signal)) {
      requestHeaders['content-type'] = HTTP_DWN_RPC_BODY_V1_CONTENT_TYPE;
      const body = createHttpDwnRpcRequestBody(jsonRpcRequest, data);
      return { fetchOpts, isRequestBodyReplayable: attachRequestBody(fetchOpts, body) };
    }

    requestHeaders['dwn-request'] = JSON.stringify(jsonRpcRequest);
    if (data === undefined) {
      return { fetchOpts, isRequestBodyReplayable: true };
    }

    requestHeaders['content-type'] = 'application/octet-stream';
    return { fetchOpts, isRequestBodyReplayable: attachRequestBody(fetchOpts, data) };
  }

  private async supportsHttpRpcBodyV1(dwnUrl: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();

    // Fast path: a cached `/info` answers the capability question with no I/O, so
    // skip building the discovery timeout and its listeners on every request.
    const cached = await this.serverInfoCache.get(dwnUrl);
    if (cached !== undefined) {
      return advertisesHttpRpcBodyV1(cached);
    }

    const retryAfter = this.serverInfoDiscoveryRetryAfter.get(dwnUrl);
    if (retryAfter !== undefined) {
      if (retryAfter > Date.now()) {
        return false;
      }
      this.serverInfoDiscoveryRetryAfter.delete(dwnUrl);
    }

    try {
      const discoveryTimeout = AbortSignal.timeout(DEFAULT_CAPABILITY_DISCOVERY_TIMEOUT_MS);
      const discoverySignal = signal === undefined
        ? discoveryTimeout
        : AbortSignal.any([signal, discoveryTimeout]);
      return advertisesHttpRpcBodyV1(await waitForPromiseWithSignal(this.getServerInfo(dwnUrl), discoverySignal));
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      // Capability discovery must not break requests to legacy DWN servers.
      this.serverInfoDiscoveryRetryAfter.set(dwnUrl, Date.now() + CAPABILITY_DISCOVERY_FAILURE_BACKOFF_MS);
      return false;
    }
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
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
        throw new RateLimitError(retryAfter);
      }
      if (response.ok) {
        const results = await response.json() as ServerInfo;

        const serverInfo: ServerInfo = {
          httpRpcFraming           : results.httpRpcFraming,
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
        this.serverInfoDiscoveryRetryAfter.delete(dwnUrl);

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
    options: FetchWithRetryOptions = {},
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
