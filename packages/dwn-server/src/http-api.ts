import type { JsonRpcId, JsonRpcRequest, ServerInfo } from '@enbox/dwn-clients';
import type { Server, ServerWebSocket } from 'bun';

import type { Dialect } from '@enbox/dwn-sql-store';

import type { ActivityLog } from './admin/activity-log.js';
import type { AdminApi } from './admin/admin-api.js';
import type { AdminSessionManager } from './admin/admin-session.js';
import type { AdminStore } from './admin/admin-store.js';
import type { DwnServerConfig } from './config.js';
import type { DwnServerError } from './dwn-error.js';
import type { LocalNodePairingManager } from './local-node-pairing.js';
import type { MessageProcessedHook } from './message-processed-hook.js';
import type { OpenAuthHandler } from './registration/open-auth-handler.js';
import type { RateLimiter } from './rate-limiter.js';
import type { RegistrationManager } from './registration/registration-manager.js';
import type { RegistrationStore } from './registration/registration-store.js';
import type { RequestContext } from './lib/json-rpc-router.js';
import type { SocketConnection } from './connection/socket-connection.js';

import log from 'loglevel';

import { Convert } from '@enbox/common';
import { register } from 'prom-client';
import {
  createJsonRpcErrorResponse,
  HTTP_DWN_RPC_BODY_V1,
  isHttpDwnRpcBodyV1ContentType,
  isHttpDwnRpcContentType,
  JsonRpcErrorCodes,
  maxWsJsonRpcPayloadBytes,
  normalizeReadableStream,
  parseHttpDwnRpcRequestBody,
} from '@enbox/dwn-clients';
import { DateSort, type Dwn, ProtocolsQuery, RecordsQuery, RecordsRead, type RecordsReadReply } from '@enbox/dwn-sdk-js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ConnectServer } from './connect/connect-server.js';
import { getDialectFromUrl } from './storage.js';
import { LocalNodePairingManager as InMemoryLocalNodePairingManager } from './local-node-pairing.js';
import { jsonRpcRouter } from './json-rpc-api.js';
import { validateAdminAuth } from './admin/admin-auth.js';
import { assertLocalNodeBindHostname, isLocalNodeHostHeaderAllowed } from './local-node-profile.js';
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
export type LocalNodeWebSocketSession = {
  origin : string | undefined;
  token : string;
};

export interface WsData {
  connection: SocketConnection | null;
  localNodeSession? : LocalNodeWebSocketSession;
}

/** A JSON-RPC POST decoded from its wire framing, or the 400 that rejected it. */
type DecodedJsonRpcPost =
  | { dwnRpcRequest: JsonRpcRequest; requestDataStream?: ReadableStream<Uint8Array> }
  | { errorResponse: Response };

/** Builds a JSON-RPC bad-request response. Falls back to a fresh id when the request had none. */
function badRequest(message: string, id: JsonRpcId = crypto.randomUUID()): Response {
  return Response.json(
    createJsonRpcErrorResponse(id, JsonRpcErrorCodes.BadRequest, message),
    { status: 400 },
  );
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
  #messageProcessedHooks: MessageProcessedHook[];
  #openAuthHandler: OpenAuthHandler | undefined;
  #sessionManager: AdminSessionManager | undefined;
  #adminUiPath: string | undefined;
  #localNodePairingManager: LocalNodePairingManager;
  connectServer: ConnectServer;
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
      messageProcessedHooks? : MessageProcessedHook[];
      openAuthHandler? : OpenAuthHandler;
      sessionManager? : AdminSessionManager;
      ttlCacheDialect? : Dialect;
      localNodePairingManager?: LocalNodePairingManager;
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
    } catch (error: any) {
      log.info('could not read `package.json` for version info', error);
    }

    // Resolve the SDK version from the actual installed package rather than
    // the dependency specifier (which may be `workspace:*` in a monorepo).
    try {
      const sdkPackageJsonPath = require.resolve('@enbox/dwn-sdk-js/package.json');
      const sdkPackageJson = JSON.parse(readFileSync(sdkPackageJsonPath).toString());
      httpApi.#packageInfo.sdkVersion = sdkPackageJson.version;
    } catch (error: any) {
      log.info('could not resolve @enbox/dwn-sdk-js version', error);
    }

    httpApi.#config = config;
    httpApi.dwn = dwn;
    httpApi.#adminApi = adminApi;
    httpApi.#activityLog = activityLog;
    httpApi.#adminStore = options?.adminStore;
    httpApi.#registrationStore = options?.registrationStore;
    httpApi.#ipRateLimiter = options?.ipRateLimiter;
    httpApi.#tenantRateLimiter = options?.tenantRateLimiter;
    httpApi.#messageProcessedHooks = options?.messageProcessedHooks ?? [];
    httpApi.#openAuthHandler = options?.openAuthHandler;
    httpApi.#sessionManager = options?.sessionManager;
    httpApi.#adminUiPath = resolvedAdminUiPath;
    httpApi.#localNodePairingManager = options?.localNodePairingManager ?? new InMemoryLocalNodePairingManager();

    if (registrationManager !== undefined) {
      httpApi.registrationManager = registrationManager;
    }

    // Use an externally provided dialect when available (required for
    // in-memory SQLite so that migrations and the TTL cache share the same
    // database instance). Falls back to creating a dialect from the URL.
    const ttlDialect = options?.ttlCacheDialect ?? getDialectFromUrl(new URL(config.ttlCacheUrl));
    httpApi.connectServer = await ConnectServer.create({
      baseUrl    : config.baseUrl,
      sqlDialect : ttlDialect,
    });

    return httpApi;
  }

  get server(): Server<WsData> {
    return this.#server;
  }

  get adminStore(): AdminStore | undefined {
    return this.#adminStore;
  }

  get config(): DwnServerConfig {
    return this.#config;
  }

  get ipRateLimiter(): RateLimiter | undefined {
    return this.#ipRateLimiter;
  }

  get tenantRateLimiter(): RateLimiter | undefined {
    return this.#tenantRateLimiter;
  }

  get messageProcessedHooks(): MessageProcessedHook[] {
    return this.#messageProcessedHooks;
  }

  get registrationStore(): RegistrationStore | undefined {
    return this.#registrationStore;
  }

  get localNodePairingManager(): LocalNodePairingManager {
    return this.#localNodePairingManager;
  }

  // ---------------------------------------------------------------------------
  // HTTP request handler
  // ---------------------------------------------------------------------------

  async start(port: number): Promise<void> {
    if (this.#config.localNodeProfileEnabled) {
      assertLocalNodeBindHostname(this.#config.hostname);
    }

    this.#server = Bun.serve<WsData>({
      hostname: this.#config.hostname,
      port,

      fetch: async (req: Request, server): Promise<Response | undefined> => {
        const startTime = performance.now();
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (this.#config.localNodeProfileEnabled && !isLocalNodeHostHeaderAllowed(req.headers.get('host'))) {
          return new Response('Forbidden', { status: 403 });
        }

        const isWebSocketUpgrade = method === 'GET' && req.headers.get('upgrade')?.toLowerCase() === 'websocket';
        let localNodeSession: LocalNodeWebSocketSession | undefined;

        if (this.#config.localNodeProfileEnabled) {
          const authorizationResult = this.#authorizeLocalNodeRequest(req, url, path, method, isWebSocketUpgrade);
          if (authorizationResult.status === 'unauthorized') {
            this.#applyCorsHeaders(req, authorizationResult.response, path);
            return authorizationResult.response;
          }

          localNodeSession = authorizationResult.session;
        }

        // --- WebSocket upgrade ---
        if (isWebSocketUpgrade) {
          const upgraded = server.upgrade(req, { data: { connection: null, localNodeSession } });
          if (upgraded) {
            return undefined;
          }
          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // --- Per-IP rate limiting ---
        if (this.#ipRateLimiter) {
          const ip = server.requestIP(req)?.address ?? 'unknown';
          const result = this.#ipRateLimiter.consume(ip);
          if (result.allowed === false) {
            const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
            const response = new Response(
              JSON.stringify({ error: 'Rate limit exceeded' }),
              {
                status  : 429,
                headers : {
                  'content-type' : 'application/json',
                  'retry-after'  : String(retryAfterSec),
                },
              },
            );
            this.#applyCorsHeaders(req, response, path);
            return response;
          }
        }

        // --- Route matching ---
        let response: Response;
        try {
          response = await this.#route(req, url, path, method);
        } catch (error) {
          log.error(`Unhandled error on ${method} ${path}:`, error);
          response = new Response('Internal Server Error', { status: 500 });
        }

        // --- CORS headers ---
        // Admin API and metrics endpoints do not receive wildcard CORS headers
        // to limit cross-origin access when the admin token is configured.
        this.#applyCorsHeaders(req, response, path);

        // --- Response-time metrics ---
        const elapsed = performance.now() - startTime;
        const routeLabel = (method + (path === '/' ? '/jsonrpc' : path))
          .toLowerCase()
          .replace(/[:.]/g, '')
          .replaceAll('/', '_');
        responseHistogram.labels(routeLabel, String(response.status)).observe(elapsed);
        log.info(method, decodeURI(path), response.status);

        return response;
      },

      websocket: {
        maxPayloadLength : maxWsJsonRpcPayloadBytes(this.#config.maxRecordDataSize),
        open             : (ws: ServerWebSocket<WsData>): void => {
          if (this.onWebSocketConnection) {
            this.onWebSocketConnection(ws);
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
    if (this.connectServer) {
      this.connectServer.close();
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

    // Prevent path traversal: resolved path must stay within the admin UI directory.
    const resolvedBase = resolve(this.#adminUiPath);
    if (!resolve(filePath).startsWith(resolvedBase)) {
      return null;
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
        const authResult = validateAdminAuth(req, this.#config, this.#sessionManager);
        if (authResult.error) {
          return authResult.error;
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
        'please use an enbox client, for example: https://github.com/enboxorg/enbox ',
        { headers: { 'content-type': 'text/plain' } },
      );
    }

    if (method === 'GET' && path === '/info') {
      return this.#handleInfo();
    }

    if (this.#config.localNodeProfileEnabled && path === '/local/status' && method === 'GET') {
      return this.#handleLocalNodeStatus(req);
    }

    if (this.#config.localNodeProfileEnabled && path === '/local/pair' && method === 'POST') {
      return this.#handleLocalNodePairRequest(req);
    }

    if (this.#config.localNodeProfileEnabled && path.startsWith('/local/pair/') && method === 'GET') {
      return this.#handleLocalNodePairPoll(req, path);
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

    // --- Connect routes ---
    const connectResponse = await this.#matchConnectRoutes(req, path, method);
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
      const match = /^\/([^/]+)\/read\/protocols\/([^/]+)\/(.*)$/.exec(path);
      if (match && req.method === 'GET') {
        const [, did, protocolParam, protocolPathRaw] = match;
        return this.#handleReadProtocolRecord(did, protocolParam, protocolPathRaw, url, leadTailSlashRegex);
      }
    }

    // /:did/read/protocols/:protocol
    {
      const match = /^\/([^/]+)\/read\/protocols\/([^/]+)$/.exec(path);
      if (match && req.method === 'GET') {
        const [, did, protocolParam] = match;
        return this.#handleReadProtocol(did, protocolParam);
      }
    }

    // /:did/read/records/:id  OR  /:did/records/:id
    {
      const match = /^\/([^/]+)\/(?:read\/)?records\/([^/]+)$/.exec(path);
      if (match && req.method === 'GET') {
        const [, did, recordId] = match;
        return this.#handleReadRecord(did, recordId);
      }
    }

    // /:did/query/protocols
    {
      const match = /^\/([^/]+)\/query\/protocols$/.exec(path);
      if (match && req.method === 'GET') {
        const [, did] = match;
        return this.#handleQueryProtocols(did);
      }
    }

    // /:did/query
    {
      const match = /^\/([^/]+)\/query$/.exec(path);
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
    if (this.#config.registrationProofOfWorkEnabled) {
      registrationRequirements.push('proof-of-work-sha256-v0');
    }
    if (this.#config.termsOfServiceFilePath !== undefined) {
      registrationRequirements.push('terms-of-service');
    }
    if (this.#config.providerAuthEnabled && !registrationRequirements.includes('provider-auth-v0')) {
      registrationRequirements.push('provider-auth-v0');
    }

    const serverInfo: ServerInfo = {
      httpRpcFraming           : [HTTP_DWN_RPC_BODY_V1],
      maxFileSize              : this.#config.maxRecordDataSize,
      maxInFlight              : this.#config.maxInFlight,
      registrationRequirements : registrationRequirements,
      server                   : this.#packageInfo.server,
      sdkVersion               : this.#packageInfo.sdkVersion,
      url                      : this.#config.baseUrl,
      version                  : this.#packageInfo.version,
      webSocketSupport         : this.#config.webSocketSupport,
    };

    if (this.#config.localNodeProfileEnabled) {
      // Strip trailing slashes without a backtracking-prone regex (`/\/+$/`
      // is super-linear on adversarial input — SonarCloud S8786).
      let baseUrl = this.#config.baseUrl;
      while (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
      }
      serverInfo.localNode = true;
      serverInfo.localPairing = {
        pairUrl         : `${baseUrl}/local/pair`,
        pollUrlTemplate : `${baseUrl}/local/pair/{requestId}`,
      };
    }

    if (this.#config.providerAuthEnabled) {
      serverInfo.providerAuth = {
        authorizeUrl  : this.#config.providerAuthAuthorizeUrl,
        tokenUrl      : this.#config.providerAuthTokenUrl,
        refreshUrl    : this.#config.providerAuthRefreshUrl,
        managementUrl : this.#config.providerAuthManagementUrl,
      };
    }

    return Response.json(serverInfo);
  }

  #applyCorsHeaders(req: Request, response: Response, path: string): void {
    const isAdminRoute = path.startsWith('/admin') || path === '/metrics';
    if (isAdminRoute) {
      return;
    }

    const allowedOrigin = this.#getCorsAllowedOrigin(req, path);
    if (allowedOrigin === undefined) {
      return;
    }

    response.headers.set('access-control-allow-origin', allowedOrigin);
    response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.headers.set('access-control-allow-headers', this.#config.localNodeProfileEnabled
      ? 'authorization, content-type, dwn-request'
      : '*');
    response.headers.set('access-control-expose-headers', 'dwn-response');
    // Cache preflight responses for 24 hours to reduce OPTIONS round-trips
    // for browser-based DWN clients communicating with a local server.
    response.headers.set('access-control-max-age', '86400');

    if (allowedOrigin !== '*') {
      response.headers.set('vary', 'Origin');
    }
  }

  #getCorsAllowedOrigin(req: Request, path: string): string | undefined {
    if (!this.#config.localNodeProfileEnabled) {
      return '*';
    }

    const origin = req.headers.get('origin');
    if (origin === null) {
      return undefined;
    }

    if (path === '/info' || path === '/local/pair') {
      return origin;
    }

    if (path.startsWith('/local/pair/')) {
      const requestId = path.slice('/local/pair/'.length);
      const request = this.#localNodePairingManager.getRequest(requestId);
      return request?.origin === origin ? origin : undefined;
    }

    return this.#localNodePairingManager.isOriginPaired(origin) ? origin : undefined;
  }

  static #isLocalNodePublicRoute(path: string, method: string, isWebSocketUpgrade: boolean): boolean {
    if (isWebSocketUpgrade) {
      return false;
    }

    return method === 'OPTIONS'
      || (method === 'GET' && path === '/info')
      || (method === 'POST' && path === '/local/pair')
      || (method === 'GET' && path.startsWith('/local/pair/'));
  }

  #authorizeLocalNodeRequest(
    req: Request,
    url: URL,
    path: string,
    method: string,
    isWebSocketUpgrade: boolean
  ): { session?: LocalNodeWebSocketSession; status: 'authorized' } | { response: Response; status: 'unauthorized' } {
    if (HttpApi.#isLocalNodePublicRoute(path, method, isWebSocketUpgrade)) {
      return { status: 'authorized' };
    }

    const origin = req.headers.get('origin') ?? undefined;
    const token = HttpApi.#getLocalNodeAuthToken(req, url);
    if (token !== undefined && this.#localNodePairingManager.validateSession(origin, token)) {
      return {
        session : { origin, token },
        status  : 'authorized',
      };
    }

    return {
      response : Response.json({ error: 'Unauthorized' }, { status: 401 }),
      status   : 'unauthorized',
    };
  }

  static #getLocalNodeAuthToken(req: Request, url: URL): string | undefined {
    const bearerToken = HttpApi.#getBearerToken(req.headers.get('authorization'));
    if (bearerToken !== undefined) {
      return bearerToken;
    }

    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return url.searchParams.get('localNodeToken') ?? undefined;
    }

    return undefined;
  }

  static #getBearerToken(authorizationHeader: string | null): string | undefined {
    if (authorizationHeader === null) {
      return undefined;
    }

    const parts = authorizationHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return undefined;
    }

    return parts[1];
  }

  #handleLocalNodePairRequest(req: Request): Response {
    const origin = req.headers.get('origin');
    const result = this.#localNodePairingManager.createRequest(origin);

    if (result.status === 'invalid-origin') {
      return Response.json({ error: result.message }, { status: 400 });
    }

    if (result.status === 'rate-limited') {
      return Response.json(
        { error: 'Pairing rate limit exceeded.' },
        {
          headers : { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) },
          status  : 429,
        },
      );
    }

    if (origin !== null && this.#config.localNodeAllowedOrigins.includes(origin)) {
      this.#localNodePairingManager.approveRequest(result.requestId);
    }

    return Response.json({
      requestId : result.requestId,
      status    : 'pending',
    });
  }

  #handleLocalNodePairPoll(req: Request, path: string): Response {
    const requestId = path.slice('/local/pair/'.length);
    if (requestId.length === 0) {
      return Response.json({ error: 'Pairing request ID is required.' }, { status: 400 });
    }

    const request = this.#localNodePairingManager.getRequest(requestId);
    if (req.headers.get('origin') !== request?.origin) {
      return Response.json({ error: 'Pairing request not found.' }, { status: 404 });
    }

    const result = this.#localNodePairingManager.pollRequest(requestId);
    if (result === undefined) {
      return Response.json({ error: 'Pairing request not found.' }, { status: 404 });
    }

    return Response.json(result);
  }

  #handleLocalNodeStatus(req: Request): Response {
    return Response.json({
      localNode : true,
      origin    : req.headers.get('origin') ?? undefined,
      paired    : true,
    });
  }

  /**
   * Decodes a JSON-RPC POST from either the negotiated `body-v1` framing or the
   * legacy `dwn-request` header, so the caller stays transport-agnostic.
   */
  async #decodeJsonRpcPost(req: Request): Promise<DecodedJsonRpcPost> {
    const contentType = req.headers.get('content-type');

    if (isHttpDwnRpcBodyV1ContentType(contentType)) {
      if (req.body === null) {
        return { errorResponse: badRequest('request payload required.') };
      }

      try {
        const decoded = await parseHttpDwnRpcRequestBody(normalizeReadableStream(req.body));
        return { dwnRpcRequest: decoded.jsonRpcRequest, requestDataStream: decoded.dataStream };
      } catch (error) {
        return { errorResponse: badRequest((error as Error).message) };
      }
    }

    if (isHttpDwnRpcContentType(contentType)) {
      return { errorResponse: badRequest('unsupported HTTP DWN RPC body framing version.') };
    }

    const dwnRpcRequestString = req.headers.get('dwn-request');
    if (!dwnRpcRequestString) {
      return { errorResponse: badRequest('request payload required.') };
    }

    let dwnRpcRequest: JsonRpcRequest;
    try {
      dwnRpcRequest = JSON.parse(dwnRpcRequestString);
    } catch (e) {
      return { errorResponse: badRequest((e as Error).message) };
    }

    const contentLength = req.headers.get('content-length');
    const transferEncoding = req.headers.get('transfer-encoding');
    if (Number.parseInt(contentLength ?? '0') > 0 || transferEncoding !== null) {
      if (req.body === null) {
        return {
          errorResponse: badRequest('request advertised a body but none was provided.', dwnRpcRequest.id),
        };
      }
      return { dwnRpcRequest, requestDataStream: normalizeReadableStream(req.body) };
    }

    return { dwnRpcRequest };
  }

  async #handleJsonRpcPost(req: Request): Promise<Response> {
    const decoded = await this.#decodeJsonRpcPost(req);
    if ('errorResponse' in decoded) {
      return decoded.errorResponse;
    }
    const { dwnRpcRequest, requestDataStream } = decoded;

    const requestContext: RequestContext = {
      dwn                   : this.dwn,
      transport             : 'http',
      dataStream            : requestDataStream,
      activityLog           : this.#activityLog,
      adminStore            : this.#adminStore,
      registrationStore     : this.#registrationStore,
      config                : this.#config,
      tenantRateLimiter     : this.#tenantRateLimiter,
      messageProcessedHooks : this.#messageProcessedHooks,
    };
    let routerResult: Awaited<ReturnType<typeof jsonRpcRouter.handle>>;
    try {
      routerResult = await jsonRpcRouter.handle(dwnRpcRequest, requestContext);
    } finally {
      // A handler may reject a request before reading its record data. Cancel
      // any unread tail so framed request readers and network resources are
      // released promptly. Cancellation after full consumption is a no-op.
      await requestDataStream?.cancel().catch((): void => {
        // A handler may still hold a reader lock; it owns cleanup in that case.
      });
    }
    const { jsonRpcResponse, dataStream: responseDataStream } = routerResult;

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
        const lastLevelObject = keys.reduce((obj, key) => nestObj(obj, key), queryOptions);
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
        const lastLevelObject = keys.reduce((obj, key) => nestObj(obj, key), recordsQueryOptions);
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
        if (dwnServerError.code === undefined) {
          log.info('Error handling registration request:', error);
          return Response.json({ success: false }, { status: 500 });
        } else {
          return Response.json(dwnServerError, { status: 400 });
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Connect routes
  // ---------------------------------------------------------------------------

  async #matchConnectRoutes(
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

      const result = await this.connectServer.setConnectRequest(body.request);
      return Response.json(result, { status: 201 });
    }

    // GET /connect/authorize/:requestId.jwt
    {
      const match = /^\/connect\/authorize\/([^/]+)\.jwt$/.exec(path);
      if (match && method === 'GET') {
        const requestId = match[1];
        log.info(`Retrieving Connect Request object of ID: ${requestId}...`);

        const requestObjectJwt = await this.connectServer.getConnectRequest(requestId);
        if (requestObjectJwt) {
          const body = typeof requestObjectJwt === 'string'
            ? requestObjectJwt
            : JSON.stringify(requestObjectJwt);
          return new Response(body, {
            headers: { 'content-type': 'application/jwt' },
          });
        } else {
          return Response.json({
            ok     : false,
            status : { code: 404, message: 'Not Found' },
          }, { status: 404 });
        }
      }
    }

    // POST /connect/callback
    if (method === 'POST' && path === '/connect/callback') {
      log.info('Storing Identity Provider (wallet) pushed response with ID token...');

      // The agent's submitConnectResponse sends application/x-www-form-urlencoded
      // but the server was previously parsing as JSON, causing a 500 error.
      // Support both content types for robustness.
      const contentType = req.headers.get('content-type') ?? '';
      let idToken: string | undefined;
      let state: string | undefined;

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await req.text();
        const params = new URLSearchParams(text);
        idToken = params.get('id_token') ?? undefined;
        state = params.get('state') ?? undefined;
      } else {
        const body = await req.json();
        idToken = body.id_token;
        state = body.state;
      }

      if (idToken !== undefined && state != undefined) {
        await this.connectServer.setConnectResponse(state, idToken);
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

    // GET /connect/status/:requestId
    // Observational progress for the requesting app: whether the wallet has
    // claimed (fetched) the pushed request. Always 200 so pollers can treat
    // any non-2xx as transport failure; unknown or expired IDs read as
    // `claimed: false`.
    {
      const match = /^\/connect\/status\/([^/]+)$/.exec(path);
      if (match && method === 'GET') {
        const requestId = match[1];
        const claimed = await this.connectServer.isConnectRequestClaimed(requestId);
        return Response.json({ claimed }, { status: 200 });
      }
    }

    // POST /connect/complete
    // Observational completion signal from the requesting app: it fetched
    // and successfully opened the wallet's response. Keyed by the same
    // opaque `state` correlator as the token route; the wallet polls the
    // matching GET to flip its pairing screen to "connected" instead of
    // asking the user to dismiss it blind.
    if (method === 'POST' && path === '/connect/complete') {
      const body = await req.json().catch((): undefined => undefined) as { state?: unknown } | undefined;
      const state = body?.state;
      if (typeof state !== 'string' || state === '') {
        return Response.json({
          ok     : false,
          status : { code: 400, message: 'Bad Request: Missing \'state\' parameter' },
        }, { status: 400 });
      }

      await this.connectServer.setConnectComplete(state);
      return Response.json({
        ok     : true,
        status : { code: 201, message: 'Created' },
      }, { status: 201 });
    }

    // GET /connect/complete/:state
    // Always 200 so pollers can treat any non-2xx as transport failure;
    // unknown or expired states read as `completed: false`.
    {
      const match = /^\/connect\/complete\/([^/]+)$/.exec(path);
      if (match && method === 'GET') {
        const state = decodeURIComponent(match[1]);
        const completed = await this.connectServer.isConnectComplete(state);
        return Response.json({ completed }, { status: 200 });
      }
    }

    // GET /connect/token/:state.jwt
    {
      const match = /^\/connect\/token\/([^/]+)\.jwt$/.exec(path);
      if (match && method === 'GET') {
        const state = match[1];
        log.info(`Retrieving ID token for state: ${state}...`);

        const idToken = await this.connectServer.getConnectResponse(state);
        if (idToken) {
          const body = typeof idToken === 'string' ? idToken : JSON.stringify(idToken);
          return new Response(body, {
            headers: { 'content-type': 'application/jwt' },
          });
        } else {
          return new Response(null, { status: 204 }); // Not ready or already consumed: a clean 204, never a 404 (the app long-polls this).
        }
      }
    }

    return null;
  }
}
