import type { JsonRpcRequest } from '@enbox/dwn-clients';
import type { RecordsReadReply } from '@enbox/dwn-sdk-js';
import type { ServerInfo } from '@enbox/dwn-clients';
import type { Server, ServerWebSocket } from 'bun';

import type { ActivityLog } from './admin/activity-log.js';
import type { AdminApi } from './admin/admin-api.js';
import type { AdminStore } from './admin/admin-store.js';
import type { DwnServerConfig } from './config.js';
import type { DwnServerError } from './dwn-error.js';
import type { OpenAuthHandler } from './registration/open-auth-handler.js';
import type { RateLimiter } from './rate-limiter.js';
import type { RegistrationManager } from './registration/registration-manager.js';
import type { RegistrationStore } from './registration/registration-store.js';
import type { RequestContext } from './lib/json-rpc-router.js';
import type { SocketConnection } from './connection/socket-connection.js';

import log from 'loglevel';

import { Convert } from '@enbox/common';
import { join } from 'path';
import { register } from 'prom-client';
import { v4 as uuidv4 } from 'uuid';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { DataStream, DateSort, type Dwn, ProtocolsQuery, RecordsQuery, RecordsRead } from '@enbox/dwn-sdk-js';
import { existsSync, readFileSync } from 'fs';

import { config } from './config.js';
import { jsonRpcRouter } from './json-rpc-api.js';
import { validateAdminAuth } from './admin/admin-auth.js';
import { Web5ConnectServer } from './web5-connect/web5-connect-server.js';
import { requestCounter, responseHistogram } from './metrics.js';

/** Property names that must never be used as keys when building objects from user input. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Resolve admin UI dist path at module load time. Gracefully handle the case
// where the admin UI package is not installed.
let resolvedAdminUiPath: string | undefined;
try {
  const adminUiModule = require('@enbox/dwn-server-admin-ui');
  resolvedAdminUiPath = adminUiModule.adminUiDistPath;
} catch {
  // Admin UI package not installed — static serving will be disabled.
}

/** Data attached to each Bun WebSocket via `ws.data`. */
export interface WsData {
  connection: SocketConnection;
}

export class HttpApi {
  #config: DwnServerConfig;
  #packageInfo: { version?: string, sdkVersion?: string, server: string };
  #server!: Server<WsData>;
  #adminApi: AdminApi | undefined;
  #activityLog: ActivityLog | undefined;
  #adminStore: AdminStore | undefined;
  #registrationStore: RegistrationStore | undefined;
  #ipRateLimiter: RateLimiter | undefined;
  #tenantRateLimiter: RateLimiter | undefined;
  #openAuthHandler: OpenAuthHandler | undefined;
  #adminUiPath: string | undefined;
  web5ConnectServer: Web5ConnectServer;
  registrationManager: RegistrationManager;
  dwn: Dwn;

  /** Called by WsApi/ConnectionManager when a new WS connection is established. */
  onWebSocketConnection?: (ws: ServerWebSocket<WsData>) => void;

  private constructor() { }

  public static async create(
    config: DwnServerConfig, dwn: Dwn, registrationManager?: RegistrationManager,
    adminApi?: AdminApi, activityLog?: ActivityLog,
    options?: {
      adminStore? : AdminStore;
      registrationStore? : RegistrationStore;
      ipRateLimiter? : RateLimiter;
      tenantRateLimiter? : RateLimiter;
      openAuthHandler? : OpenAuthHandler;
    },
  ): Promise<HttpApi> {
    const httpApi = new HttpApi();

    log.info(HttpApi.#redactConfig(config));

    httpApi.#packageInfo = {
      server: config.serverName,
    };

    try {
      const packageJson = JSON.parse(readFileSync(config.packageJsonPath).toString());
      httpApi.#packageInfo.version = packageJson.version;
      httpApi.#packageInfo.sdkVersion = packageJson.dependencies
        ? packageJson.dependencies['@enbox/dwn-sdk-js']
        : undefined;
    } catch (error: any) {
      log.info('could not read `package.json` for version info', error);
    }

    httpApi.#config = config;
    httpApi.dwn = dwn;
    httpApi.#adminApi = adminApi;
    httpApi.#activityLog = activityLog;
    httpApi.#adminStore = options?.adminStore;
    httpApi.#registrationStore = options?.registrationStore;
    httpApi.#ipRateLimiter = options?.ipRateLimiter;
    httpApi.#tenantRateLimiter = options?.tenantRateLimiter;
    httpApi.#openAuthHandler = options?.openAuthHandler;
    httpApi.#adminUiPath = resolvedAdminUiPath;

    if (registrationManager !== undefined) {
      httpApi.registrationManager = registrationManager;
    }

    httpApi.web5ConnectServer = await Web5ConnectServer.create({
      baseUrl        : config.baseUrl,
      sqlTtlCacheUrl : config.ttlCacheUrl,
    });

    return httpApi;
  }

  get server(): Server<WsData> {
    return this.#server;
  }

  get ipRateLimiter(): RateLimiter | undefined {
    return this.#ipRateLimiter;
  }

  get tenantRateLimiter(): RateLimiter | undefined {
    return this.#tenantRateLimiter;
  }

  // ---------------------------------------------------------------------------
  // HTTP request handler
  // ---------------------------------------------------------------------------

  async start(port: number): Promise<void> {
    const self = this; // capture for closures

    this.#server = Bun.serve<WsData>({
      port,

      async fetch(req: Request, server): Promise<Response | undefined> {
        const startTime = performance.now();
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        // --- WebSocket upgrade ---
        if (method === 'GET' && req.headers.get('upgrade') === 'websocket') {
          const upgraded = server.upgrade(req, { data: { connection: null } });
          if (upgraded) {
            return undefined;
          }
          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // --- Per-IP rate limiting ---
        if (self.#ipRateLimiter) {
          const ip = server.requestIP(req)?.address ?? 'unknown';
          const result = self.#ipRateLimiter.consume(ip);
          if (result.allowed === false) {
            const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
            return new Response(
              JSON.stringify({ error: 'Rate limit exceeded' }),
              {
                status  : 429,
                headers : {
                  'content-type' : 'application/json',
                  'retry-after'  : String(retryAfterSec),
                },
              },
            );
          }
        }

        // --- Route matching ---
        let response: Response;
        try {
          response = await self.#route(req, url, path, method);
        } catch (error) {
          log.error(`Unhandled error on ${method} ${path}:`, error);
          response = new Response('Internal Server Error', { status: 500 });
        }

        // --- CORS headers ---
        // Admin API and metrics endpoints do not receive wildcard CORS headers
        // to limit cross-origin access when the admin token is configured.
        const isAdminRoute = path.startsWith('/admin') || path === '/metrics';
        if (!isAdminRoute) {
          response.headers.set('access-control-allow-origin', '*');
          response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
          response.headers.set('access-control-allow-headers', '*');
          response.headers.set('access-control-expose-headers', 'dwn-response');
        }

        // --- Response-time metrics ---
        const elapsed = performance.now() - startTime;
        const routeLabel = (method + (path === '/' ? '/jsonrpc' : path))
          .toLowerCase()
          .replace(/[:.]/g, '')
          .replace(/\//g, '_');
        responseHistogram.labels(routeLabel, String(response.status)).observe(elapsed);
        log.info(method, decodeURI(path), response.status);

        return response;
      },

      websocket: {
        open(ws: ServerWebSocket<WsData>): void {
          if (self.onWebSocketConnection) {
            self.onWebSocketConnection(ws);
          }
        },
        message(ws: ServerWebSocket<WsData>, msg: string | Buffer): void {
          const connection = ws.data?.connection;
          if (connection) {
            connection.message(typeof msg === 'string' ? Buffer.from(msg) : msg as Buffer);
          }
        },
        close(ws: ServerWebSocket<WsData>): void {
          const connection = ws.data?.connection;
          if (connection) {
            connection.close();
          }
        },
        pong(ws: ServerWebSocket<WsData>): void {
          const connection = ws.data?.connection;
          if (connection) {
            connection.pong();
          }
        },
      },
    });
  }

  async close(): Promise<void> {
    if (this.#openAuthHandler) {
      this.#openAuthHandler.destroy();
    }
    if (this.#server) {
      this.#server.stop(true); // close all connections immediately
    }
  }

  // ---------------------------------------------------------------------------
  // Admin UI static file serving
  // ---------------------------------------------------------------------------

  /**
   * Serves static files from the admin UI dist directory. Returns `null` when
   * the admin UI package is not installed or the requested file does not exist.
   * All non-file paths under `/admin` fall back to `index.html` (SPA routing).
   */
  #serveAdminUi(path: string): Response | null {
    if (!this.#adminUiPath) {
      return null;
    }

    // Strip the `/admin` prefix to get the file path within the dist directory.
    const relativePath = path.replace(/^\/admin\/?/, '');

    // Map to a file on disk. Empty path or paths without an extension get
    // the SPA index.html (client-side routing).
    let filePath: string;
    if (relativePath === '' || !relativePath.includes('.')) {
      filePath = join(this.#adminUiPath, 'index.html');
    } else {
      filePath = join(this.#adminUiPath, relativePath);
    }

    if (!existsSync(filePath)) {
      return null;
    }

    const file = Bun.file(filePath);
    return new Response(file);
  }

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------

  async #route(req: Request, url: URL, path: string, method: string): Promise<Response> {
    // --- CORS preflight ---
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // --- Static routes ---
    if (method === 'GET' && path === '/health') {
      return Response.json({ ok: true });
    }

    if (method === 'GET' && path === '/metrics') {
      // Metrics require admin authentication when an admin token is configured.
      if (this.#config.adminToken) {
        const authError = validateAdminAuth(req, this.#config);
        if (authError) {
          return authError;
        }
      }
      try {
        const metricsBody = await register.metrics();
        return new Response(metricsBody, {
          headers: { 'content-type': register.contentType },
        });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    if (method === 'GET' && path === '/') {
      return new Response(
        'please use am enbox client, for example: https://github.com/enboxorg/enbox ',
        { headers: { 'content-type': 'text/plain' } },
      );
    }

    if (method === 'GET' && path === '/info') {
      return this.#handleInfo();
    }

    // --- JSON-RPC POST ---
    if (method === 'POST' && path === '/') {
      return this.#handleJsonRpcPost(req);
    }

    // --- Admin API routes ---
    if (path.startsWith('/admin/api/') && this.#adminApi) {
      return this.#adminApi.route(req, url, path, method);
    }

    // --- Admin UI static files (only when admin API is enabled) ---
    if (method === 'GET' && path.startsWith('/admin') && this.#adminApi) {
      const uiResponse = this.#serveAdminUi(path);
      if (uiResponse) {
        return uiResponse;
      }
    }

    // --- Provider auth (open-auth) routes ---
    if (this.#openAuthHandler && path.startsWith('/provider-auth/')) {
      if (method === 'GET' && path === '/provider-auth/authorize') {
        return this.#openAuthHandler.handleAuthorize(url);
      }
      if (method === 'POST' && path === '/provider-auth/token') {
        return this.#openAuthHandler.handleToken(req);
      }
      if (method === 'POST' && path === '/provider-auth/refresh') {
        return this.#openAuthHandler.handleRefresh(req);
      }
    }

    // --- Registration routes ---
    const registrationResponse = await this.#matchRegistrationRoutes(req, path, method);
    if (registrationResponse) {
      return registrationResponse;
    }

    // --- Web5 Connect routes ---
    const connectResponse = await this.#matchWeb5ConnectRoutes(req, path, method);
    if (connectResponse) {
      return connectResponse;
    }

    // --- DID routes (parameterized) ---
    return this.#matchDidRoutes(req, url, path);
  }

  // ---------------------------------------------------------------------------
  // DID convenience routes
  // ---------------------------------------------------------------------------

  async #matchDidRoutes(req: Request, url: URL, path: string): Promise<Response> {
    const leadTailSlashRegex = /^\/|\/$/g;

    // /:did/read/protocols/:protocol/*  (also matches trailing slash with empty path)
    {
      const match = path.match(/^\/([^/]+)\/read\/protocols\/([^/]+)\/(.*)$/);
      if (match && req.method === 'GET') {
        const [, did, protocolParam, protocolPathRaw] = match;
        return this.#handleReadProtocolRecord(did, protocolParam, protocolPathRaw, url, leadTailSlashRegex);
      }
    }

    // /:did/read/protocols/:protocol
    {
      const match = path.match(/^\/([^/]+)\/read\/protocols\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const [, did, protocolParam] = match;
        return this.#handleReadProtocol(did, protocolParam);
      }
    }

    // /:did/read/records/:id  OR  /:did/records/:id
    {
      const match = path.match(/^\/([^/]+)\/(?:read\/)?records\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const [, did, recordId] = match;
        return this.#handleReadRecord(did, recordId);
      }
    }

    // /:did/query/protocols
    {
      const match = path.match(/^\/([^/]+)\/query\/protocols$/);
      if (match && req.method === 'GET') {
        const [, did] = match;
        return this.#handleQueryProtocols(did);
      }
    }

    // /:did/query
    {
      const match = path.match(/^\/([^/]+)\/query$/);
      if (match && req.method === 'GET') {
        const [, did] = match;
        return this.#handleQueryRecords(did, url);
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // Security helpers
  // ---------------------------------------------------------------------------

  /** Returns `true` if the given key is a prototype-pollution-dangerous property name. */
  static #isDangerousKey(key: string | undefined): boolean {
    return key !== undefined && DANGEROUS_KEYS.has(key);
  }

  /** Returns `true` if any element in `keys` is a dangerous property name. */
  static #hasDangerousKey(keys: string[]): boolean {
    return keys.some(k => DANGEROUS_KEYS.has(k));
  }

  /** Returns a shallow copy of the config with sensitive values redacted for logging. */
  static #redactConfig(cfg: DwnServerConfig): Record<string, unknown> {
    const redacted: Record<string, unknown> = { ...cfg };
    const sensitiveKeys = ['adminToken', 'providerAuthJwtSecret'];
    for (const key of sensitiveKeys) {
      if (redacted[key]) {
        redacted[key] = '[REDACTED]';
      }
    }
    // Redact passwords in connection-string-like values.
    for (const [key, value] of Object.entries(redacted)) {
      if (typeof value === 'string' && /^(?:postgres|mysql|sqlite):\/\//.test(value) && value.includes('@')) {
        redacted[key] = value.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
      }
    }
    return redacted;
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  #handleInfo(): Response {
    const registrationRequirements: string[] = [];
    if (config.registrationProofOfWorkEnabled) {
      registrationRequirements.push('proof-of-work-sha256-v0');
    }
    if (config.termsOfServiceFilePath !== undefined) {
      registrationRequirements.push('terms-of-service');
    }
    if (config.providerAuthEnabled && !registrationRequirements.includes('provider-auth-v0')) {
      registrationRequirements.push('provider-auth-v0');
    }

    const serverInfo: ServerInfo = {
      maxFileSize              : config.maxRecordDataSize,
      maxInFlight              : config.maxInFlight,
      registrationRequirements : registrationRequirements,
      server                   : this.#packageInfo.server,
      sdkVersion               : this.#packageInfo.sdkVersion,
      url                      : config.baseUrl,
      version                  : this.#packageInfo.version,
      webSocketSupport         : config.webSocketSupport,
    };

    if (config.providerAuthEnabled) {
      serverInfo.providerAuth = {
        authorizeUrl  : config.providerAuthAuthorizeUrl,
        tokenUrl      : config.providerAuthTokenUrl,
        refreshUrl    : config.providerAuthRefreshUrl,
        managementUrl : config.providerAuthManagementUrl,
      };
    }

    return Response.json(serverInfo);
  }

  async #handleJsonRpcPost(req: Request): Promise<Response> {
    const dwnRpcRequestString = req.headers.get('dwn-request');

    if (!dwnRpcRequestString) {
      const reply = createJsonRpcErrorResponse(
        uuidv4(), JsonRpcErrorCodes.BadRequest, 'request payload required.'
      );
      return Response.json(reply, { status: 400 });
    }

    let dwnRpcRequest: JsonRpcRequest;
    try {
      dwnRpcRequest = JSON.parse(dwnRpcRequestString);
    } catch (e) {
      const reply = createJsonRpcErrorResponse(
        uuidv4(), JsonRpcErrorCodes.BadRequest, (e as Error).message
      );
      return Response.json(reply, { status: 400 });
    }

    // Materialise the request body before passing to DWN.
    // Bun's Bun.serve() returns a ReadableStream for req.body that is
    // incompatible with the ReadableStream consumer code in dwn-sdk-js,
    // causing DataStream.toBytes() to crash with "undefined is not a
    // function" at reader.releaseLock().  Buffering via arrayBuffer()
    // converts it into a well-behaved stream that dwn-sdk-js can consume.
    // TODO: https://github.com/enboxorg/enbox/issues/90 — remove once Bun ships fix
    const contentLength = req.headers.get('content-length');
    const transferEncoding = req.headers.get('transfer-encoding');
    let requestDataStream: ReadableStream<Uint8Array> | undefined;
    if (parseInt(contentLength ?? '0') > 0 || transferEncoding !== null) {
      const bodyBytes = new Uint8Array(await req.arrayBuffer());
      requestDataStream = DataStream.fromBytes(bodyBytes);
    }

    const requestContext: RequestContext = {
      dwn               : this.dwn,
      transport         : 'http',
      dataStream        : requestDataStream,
      activityLog       : this.#activityLog,
      adminStore        : this.#adminStore,
      registrationStore : this.#registrationStore,
      config            : this.#config,
      tenantRateLimiter : this.#tenantRateLimiter,
    };
    const { jsonRpcResponse, dataStream: responseDataStream } =
      await jsonRpcRouter.handle(dwnRpcRequest, requestContext);

    if (jsonRpcResponse.error) {
      requestCounter.inc({ method: dwnRpcRequest.method, error: 1 });

      // Return HTTP 429 with Retry-After header for rate-limit rejections.
      if (jsonRpcResponse.error.code === JsonRpcErrorCodes.TooManyRequests) {
        const retryAfterSec = jsonRpcResponse.error.data?.retryAfterSec ?? 1;
        return Response.json(jsonRpcResponse, {
          status  : 429,
          headers : { 'retry-after': String(retryAfterSec) },
        });
      }

      return Response.json(jsonRpcResponse, { status: 500 });
    }

    requestCounter.inc({
      method : dwnRpcRequest.method,
      status : jsonRpcResponse?.result?.reply?.status?.code || 0,
    });

    if (responseDataStream) {
      return new Response(responseDataStream, {
        headers: {
          'content-type' : 'application/octet-stream',
          'dwn-response' : JSON.stringify(jsonRpcResponse),
        },
      });
    } else {
      return Response.json(jsonRpcResponse);
    }
  }

  #readReplyToResponse(reply: RecordsReadReply): Response {
    if (reply.status.code === 200) {
      if (reply?.entry?.data) {
        return new Response(reply.entry.data, {
          headers: {
            'content-type' : reply.entry.recordsWrite.descriptor.dataFormat,
            'dwn-response' : JSON.stringify(reply),
          },
        });
      } else {
        return new Response(null, { status: 400 });
      }
    } else if (reply.status.code === 401) {
      return new Response(null, { status: 404 });
    } else {
      return Response.json(reply, { status: reply.status.code });
    }
  }

  async #handleReadRecord(did: string, recordId: string): Promise<Response> {
    const record = await RecordsRead.create({
      filter: { recordId },
    });
    const reply = await this.dwn.processMessage(did, record.message);
    return this.#readReplyToResponse(reply);
  }

  async #handleReadProtocolRecord(
    did: string, protocolParam: string, protocolPathRaw: string,
    url: URL, leadTailSlashRegex: RegExp
  ): Promise<Response> {
    if (!protocolPathRaw || protocolPathRaw.replace(leadTailSlashRegex, '') === '') {
      return new Response('protocol path is required', { status: 400 });
    }

    try {
      const queryOptions: Record<string, any> = { filter: {} };
      for (const [param, value] of url.searchParams) {
        const keys = param.split('.');
        const lastKey = keys.pop();
        if (HttpApi.#hasDangerousKey(keys) || HttpApi.#isDangerousKey(lastKey)) {
          continue;
        }
        const nestObj = (obj: Record<string, any>, key: string): Record<string, any> =>
          obj[key] = obj[key] || {};
        const lastLevelObject = keys.reduce(nestObj, queryOptions);
        lastLevelObject[lastKey!] = value;
      }

      const protocol = Convert.base64Url(protocolParam).toString();
      queryOptions.filter.protocol = protocol;
      queryOptions.filter.protocolPath = protocolPathRaw.replace(leadTailSlashRegex, '');

      const query = await RecordsQuery.create({
        filter     : queryOptions.filter,
        pagination : { limit: 1 },
        dateSort   : DateSort.PublishedDescending,
      });

      const { entries, status } = await this.dwn.processMessage(did, query.message);

      if (status.code === 200) {
        if (entries[0]) {
          const record = await RecordsRead.create({
            filter: { recordId: entries[0].recordId },
          });
          const reply = await this.dwn.processMessage(did, record.toJSON());
          return this.#readReplyToResponse(reply);
        } else {
          return new Response(null, { status: 404 });
        }
      } else if (status.code === 401) {
        return new Response(null, { status: 404 });
      } else {
        return new Response(null, { status: status.code });
      }
    } catch (error) {
      log.error(`Error processing request: ${decodeURI(url.pathname)}`, error);
      return new Response('Bad Request', { status: 400 });
    }
  }

  async #handleReadProtocol(did: string, protocolParam: string): Promise<Response> {
    try {
      const protocol = Convert.base64Url(protocolParam).toString();
      const query = await ProtocolsQuery.create({
        filter: { protocol },
      });
      const { entries, status } = await this.dwn.processMessage(did, query.message);
      if (status.code === 200) {
        if (entries.length) {
          return Response.json(entries[0], { status: status.code });
        } else {
          return new Response(null, { status: 404 });
        }
      } else if (status.code === 401) {
        return new Response(null, { status: 404 });
      } else {
        return new Response(null, { status: status.code });
      }
    } catch (error) {
      log.error(`Error processing request`, error);
      return new Response('Bad Request', { status: 400 });
    }
  }

  async #handleQueryProtocols(did: string): Promise<Response> {
    const query = await ProtocolsQuery.create({});
    const { entries, status } = await this.dwn.processMessage(did, query.message);
    if (status.code === 200) {
      return Response.json(entries, { status: status.code });
    } else if (status.code === 401) {
      return new Response(null, { status: 404 });
    } else {
      return new Response(null, { status: status.code });
    }
  }

  async #handleQueryRecords(did: string, url: URL): Promise<Response> {
    try {
      const recordsQueryOptions: Record<string, any> = {};
      for (const [param, value] of url.searchParams) {
        const keys = param.split('.');
        const lastKey = keys.pop();
        if (HttpApi.#hasDangerousKey(keys) || HttpApi.#isDangerousKey(lastKey)) {
          continue;
        }
        const nestObj = (obj: Record<string, any>, key: string): Record<string, any> =>
          obj[key] = obj[key] || {};
        const lastLevelObject = keys.reduce(nestObj, recordsQueryOptions);
        lastLevelObject[lastKey!] = value;
      }

      const recordsQuery = await RecordsQuery.create({
        filter     : recordsQueryOptions.filter,
        pagination : recordsQueryOptions.pagination,
        dateSort   : recordsQueryOptions.dateSort,
      });

      const reply = await this.dwn.processMessage(did, recordsQuery.message);
      return Response.json(reply, {
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      log.error('Error processing query records request', error);
      return Response.json({ error: 'Bad Request' }, { status: 400 });
    }
  }

  // ---------------------------------------------------------------------------
  // Registration routes
  // ---------------------------------------------------------------------------

  async #matchRegistrationRoutes(
    req: Request, path: string, method: string
  ): Promise<Response | null> {
    if (method === 'GET' && path === '/registration/proof-of-work'
      && this.#config.registrationProofOfWorkEnabled) {
      const proofOfWorkChallenge = this.registrationManager.getProofOfWorkChallenge();
      return Response.json(proofOfWorkChallenge);
    }

    if (method === 'GET' && path === '/registration/terms-of-service'
      && this.#config.termsOfServiceFilePath !== undefined) {
      return new Response(this.registrationManager.getTermsOfService());
    }

    if (method === 'POST' && path === '/registration'
      && this.#config.registrationStoreUrl !== undefined) {
      const requestBody = await req.json();
      log.info('Registration request received');

      try {
        await this.registrationManager.handleRegistrationRequest(requestBody);
        return Response.json({ success: true }, { status: 200 });
      } catch (error) {
        const dwnServerError = error as DwnServerError;
        if (dwnServerError.code !== undefined) {
          return Response.json(dwnServerError, { status: 400 });
        } else {
          log.info('Error handling registration request:', error);
          return Response.json({ success: false }, { status: 500 });
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Web5 Connect routes
  // ---------------------------------------------------------------------------

  async #matchWeb5ConnectRoutes(
    req: Request, path: string, method: string
  ): Promise<Response | null> {
    // POST /connect/par
    if (method === 'POST' && path === '/connect/par') {
      log.info('Storing Pushed Authorization Request (PAR) request...');
      const body = await req.json();

      if (!body.request) {
        return Response.json({
          ok     : false,
          status : { code: 400, message: 'Bad Request: Missing \'request\' parameter' },
        }, { status: 400 });
      }

      if (body?.request?.request_uri) {
        return Response.json({
          ok     : false,
          status : { code: 400, message: 'Bad Request: \'request_uri\' parameter is not allowed in PAR' },
        }, { status: 400 });
      }

      const result = await this.web5ConnectServer.setWeb5ConnectRequest(body.request);
      return Response.json(result, { status: 201 });
    }

    // GET /connect/authorize/:requestId.jwt
    {
      const match = path.match(/^\/connect\/authorize\/([^/]+)\.jwt$/);
      if (match && method === 'GET') {
        const requestId = match[1];
        log.info(`Retrieving Web5 Connect Request object of ID: ${requestId}...`);

        const requestObjectJwt = await this.web5ConnectServer.getWeb5ConnectRequest(requestId);
        if (!requestObjectJwt) {
          return Response.json({
            ok     : false,
            status : { code: 404, message: 'Not Found' },
          }, { status: 404 });
        } else {
          const body = typeof requestObjectJwt === 'string'
            ? requestObjectJwt
            : JSON.stringify(requestObjectJwt);
          return new Response(body, {
            headers: { 'content-type': 'application/jwt' },
          });
        }
      }
    }

    // POST /connect/callback
    if (method === 'POST' && path === '/connect/callback') {
      log.info('Storing Identity Provider (wallet) pushed response with ID token...');
      const body = await req.json();
      const idToken = body.id_token;
      const state = body.state;

      if (idToken !== undefined && state != undefined) {
        await this.web5ConnectServer.setWeb5ConnectResponse(state, idToken);
        return Response.json({
          ok     : true,
          status : { code: 201, message: 'Created' },
        }, { status: 201 });
      } else {
        return Response.json({
          ok     : false,
          status : { code: 400, message: 'Bad Request' },
        }, { status: 400 });
      }
    }

    // GET /connect/token/:state.jwt
    {
      const match = path.match(/^\/connect\/token\/([^/]+)\.jwt$/);
      if (match && method === 'GET') {
        const state = match[1];
        log.info(`Retrieving ID token for state: ${state}...`);

        const idToken = await this.web5ConnectServer.getWeb5ConnectResponse(state);
        if (!idToken) {
          return Response.json({
            ok     : false,
            status : { code: 404, message: 'Not Found' },
          }, { status: 404 });
        } else {
          const body = typeof idToken === 'string' ? idToken : JSON.stringify(idToken);
          return new Response(body, {
            headers: { 'content-type': 'application/jwt' },
          });
        }
      }
    }

    return null;
  }
}
