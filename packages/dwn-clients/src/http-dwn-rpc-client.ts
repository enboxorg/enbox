import type { JsonRpcResponse } from './json-rpc.js';
import type { DwnRpc, DwnRpcRequest, DwnRpcResponse } from './dwn-rpc-types.js';
import type { DwnServerInfoCache, ServerInfo } from './server-info-types.js';

import { CryptoUtils } from '@enbox/crypto';
import { DataStream } from '@enbox/dwn-sdk-js';
import { DwnServerInfoCacheMemory } from './dwn-server-info-cache-memory.js';
import { RateLimitError } from './rate-limit-error.js';
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
  const jitter = 0.5 + Math.random() * 0.5;
  return exponentialDelay * jitter;
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

/**
 * HTTP client that can be used to communicate with Dwn Servers.
 *
 * Supports automatic retry with exponential backoff and jitter for transient
 * network errors and retryable HTTP status codes (408, 429, 500, 502, 503, 504).
 * Respects the `Retry-After` response header when present.
 */
export class HttpDwnRpcClient implements DwnRpc {
  private serverInfoCache: DwnServerInfoCache;
  private _retryOptions: Required<HttpRetryOptions>;

  constructor(serverInfoCache?: DwnServerInfoCache, retryOptions?: HttpRetryOptions) {
    this.serverInfoCache = serverInfoCache ?? new DwnServerInfoCacheMemory();
    this._retryOptions = {
      maxRetries  : retryOptions?.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs : retryOptions?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs  : retryOptions?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    };
  }

  /** Detects whether the current runtime is Bun (vs a browser). */
  static isBunRuntime(): boolean {
    return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
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

    const fetchOpts: RequestInit = {
      method  : 'POST',
      headers : requestHeaders,
    };

    if (request.data) {
      requestHeaders['content-type'] = 'application/octet-stream';
      let requestBody = request.data;

      if (requestBody instanceof ReadableStream) {
        // Bun's fetch currently fails on some ReadableStream uploads in the sync push path.
        // Buffer to a Blob in Bun to avoid the broken path. In browsers, keep the stream
        // and set `duplex: 'half'` which the Fetch spec requires for streaming request bodies.
        // See: https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests
        if (HttpDwnRpcClient.isBunRuntime()) {
          const bodyBytes = await DataStream.toBytes(requestBody as ReadableStream<Uint8Array>);
          requestBody = new Blob([bodyBytes as BlobPart], { type: 'application/octet-stream' });
        } else {
          // Browsers require `duplex: 'half'` when the fetch body is a ReadableStream.
          // TypeScript's built-in RequestInit does not include `duplex` yet.
          (fetchOpts as Record<string, unknown>).duplex = 'half';
        }
      }

      fetchOpts.body = requestBody;
    }

    const resp = await this.fetchWithRetry(request.dwnUrl, fetchOpts);

    // After retries are exhausted, a 429 means we're still rate-limited.
    // Per-IP 429s return plain JSON (not a JSON-RPC envelope), so we must
    // check the status before attempting JSON-RPC parsing.
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') ?? '1', 10);
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
      throw new Error(`(${code}) - ${message}`);
    }

    // Materialise the response body before attaching to the reply.
    // Bun has a bug where ReadableStream from fetch resp.body crashes in
    // DataStream.toBytes() (reader.releaseLock() is undefined) when the
    // stream is later consumed by the local DWN node (e.g. during sync).
    // Buffering via arrayBuffer() avoids the broken getReader() path.
    // TODO: https://github.com/enboxorg/enbox/issues/90 — remove once Bun ships fix
    const { reply } = dwnRpcResponse.result;
    if (hasDataStream) {
      const bodyBytes = new Uint8Array(await resp.arrayBuffer());
      const dataStream = DataStream.fromBytes(bodyBytes);
      if (reply.record) {
        reply.record.data = dataStream;
      } else if (reply.entry) {
        reply.entry.data = dataStream;
      }
    }

    return reply as DwnRpcResponse;
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
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '1', 10);
        throw new RateLimitError(retryAfter);
      }
      if (response.ok) {
        const results = await response.json() as ServerInfo;

        const serverInfo: ServerInfo = {
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
  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    const { maxRetries, baseDelayMs, maxDelayMs } = this._retryOptions;

    let lastError: unknown;
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Apply a per-attempt timeout to prevent hung connections / SSRF.
        // If the caller already supplied a signal, combine it with the timeout
        // via AbortSignal.any(); otherwise create a fresh timeout signal.
        const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
        const attemptInit: RequestInit = {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, timeoutSignal])
            : timeoutSignal,
        };

        const response = await fetch(url, attemptInit);

        if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === maxRetries) {
          return response;
        }

        // Retryable status — back off and try again.
        lastResponse = response;
      } catch (error: unknown) {
        if (!isRetryable(error) || attempt === maxRetries) {
          throw error;
        }
        lastError = error;
      }

      // Compute the delay, preferring Retry-After when available.
      const retryAfterMs = lastResponse ? parseRetryAfterMs(lastResponse) : undefined;
      const backoffMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);
      const delayMs = retryAfterMs !== undefined ? Math.max(retryAfterMs, backoffMs) : backoffMs;

      await new Promise<void>((resolve): void => { setTimeout(resolve, delayMs); });
    }

    // Should not reach here, but satisfy the compiler.
    if (lastResponse) {
      return lastResponse;
    }
    throw lastError;
  }
}
