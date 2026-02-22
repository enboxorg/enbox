import type { Dwn } from '@enbox/dwn-sdk-js';

import type { ActivityLog } from './activity-log.js';
import type { AdminStore } from './admin-store.js';
import type { AuditLog } from './audit-log.js';
import type { ConnectionManager } from '../connection/connection-manager.js';
import type { DwnServerConfig } from '../config.js';
import type { RateLimiter } from '../rate-limiter.js';
import type { RegistrationManager } from '../registration/registration-manager.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { WebhookManager } from './webhook-manager.js';
import type {
  AdminConnectionSnapshot,
  AdminServerStats,
  AdminTenantDetail,
  AdminTenantSummary,
  AdminWebhookInput,
  PaginatedResponse,
  RateLimitStatus,
  RuntimeConfig,
  RuntimeConfigPatch,
  TenantListOptions,
  TenantQuotaInput,
  TenantQuotaStatus,
} from './types.js';

import log from 'loglevel';

import { validateAdminAuth } from './admin-auth.js';
import {
  activeTenants,
  totalDataBytes,
  totalMessages,
  websocketConnections,
  websocketSubscriptions,
} from '../metrics.js';

/** Parses a string to an integer, returning `defaultValue` when the input is null or non-numeric. */
function parseIntOrDefault(value: string | null, defaultValue: number): number {
  if (value === null) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Handles all `/admin/api/*` routes.
 * Requires bearer token authentication on every request.
 */
export class AdminApi {
  #config: DwnServerConfig;
  #dwn: Dwn;
  #adminStore: AdminStore | undefined;
  #registrationManager: RegistrationManager | undefined;
  #registrationStore: RegistrationStore | undefined;
  #connectionManager: ConnectionManager | undefined;
  #activityLog: ActivityLog | undefined;
  #auditLog: AuditLog | undefined;
  #ipRateLimiter: RateLimiter | undefined;
  #tenantRateLimiter: RateLimiter | undefined;
  #webhookManager: WebhookManager | undefined;
  #startTime: number;
  #packageInfo: { version?: string };
  #metricsInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks last failed-auth audit timestamp per IP to rate-limit logging. */
  #failedAuthLog: Map<string, number> = new Map();
  /** Minimum interval between audit log entries for the same IP (60 seconds). */
  static readonly #AUTH_AUDIT_INTERVAL_MS = 60_000;

  private constructor() {
    this.#startTime = Date.now();
  }

  /**
   * Creates a new `AdminApi` instance.
   */
  public static create(options: {
    config : DwnServerConfig;
    dwn : Dwn;
    adminStore? : AdminStore;
    registrationManager?: RegistrationManager;
    registrationStore? : RegistrationStore;
    connectionManager? : ConnectionManager;
    activityLog? : ActivityLog;
    auditLog? : AuditLog;
    ipRateLimiter? : RateLimiter;
    tenantRateLimiter? : RateLimiter;
    webhookManager? : WebhookManager;
    packageInfo? : { version?: string };
  }): AdminApi {
    const api = new AdminApi();
    api.#config = options.config;
    api.#dwn = options.dwn;
    api.#adminStore = options.adminStore;
    api.#registrationManager = options.registrationManager;
    api.#registrationStore = options.registrationStore;
    api.#connectionManager = options.connectionManager;
    api.#activityLog = options.activityLog;
    api.#auditLog = options.auditLog;
    api.#ipRateLimiter = options.ipRateLimiter;
    api.#tenantRateLimiter = options.tenantRateLimiter;
    api.#webhookManager = options.webhookManager;
    api.#packageInfo = options.packageInfo ?? {};
    return api;
  }

  /**
   * Sets the connection manager (wired after WsApi is created).
   */
  public setConnectionManager(connectionManager: ConnectionManager): void {
    this.#connectionManager = connectionManager;
  }

  // ---------------------------------------------------------------------------
  // Route dispatcher
  // ---------------------------------------------------------------------------

  /**
   * Routes an admin API request. Called by `HttpApi` for paths starting with `/admin/api/`.
   * @returns A `Response` to send to the client.
   */
  public async route(req: Request, url: URL, path: string, method: string): Promise<Response> {
    // Authenticate every request.
    const authError = validateAdminAuth(req, this.#config);
    if (authError) {
      // Log failed authentication attempts (401 only, not 404 for disabled admin).
      // Rate-limited to one audit entry per IP per 60 seconds.
      // @see https://github.com/enboxorg/enbox/issues/392
      if (authError.status === 401) {
        this.#auditFailedAuth(req, path);
      }
      return authError;
    }

    // Strip the `/admin/api` prefix for cleaner matching.
    const subPath = path.slice('/admin/api'.length);

    try {
      // --- Health ---
      if (method === 'GET' && subPath === '/health') {
        return this.#handleHealth();
      }

      // --- Stats ---
      if (method === 'GET' && subPath === '/stats') {
        return this.#handleStats(url);
      }

      // --- Tenant list ---
      if (method === 'GET' && subPath === '/tenants') {
        return this.#handleTenantList(url);
      }

      // --- Tenant creation ---
      if (method === 'POST' && subPath === '/tenants') {
        return this.#handleTenantCreate(req);
      }

      // --- Tenant detail / suspend / unsuspend / delete ---
      {
        const match = subPath.match(/^\/tenants\/([^/]+)$/);
        if (match) {
          const did = decodeURIComponent(match[1]);
          if (method === 'GET') {
            return this.#handleTenantDetail(did);
          }
          if (method === 'DELETE') {
            const purge = url.searchParams.get('purge') === 'true';
            return this.#handleTenantDelete(did, purge);
          }
        }
      }

      // --- Tenant suspend ---
      {
        const match = subPath.match(/^\/tenants\/([^/]+)\/suspend$/);
        if (match && method === 'POST') {
          const did = decodeURIComponent(match[1]);
          return this.#handleTenantSuspend(did);
        }
      }

      // --- Tenant unsuspend ---
      {
        const match = subPath.match(/^\/tenants\/([^/]+)\/unsuspend$/);
        if (match && method === 'POST') {
          const did = decodeURIComponent(match[1]);
          return this.#handleTenantUnsuspend(did);
        }
      }

      // --- Tenant quota ---
      {
        const match = subPath.match(/^\/tenants\/([^/]+)\/quota$/);
        if (match) {
          const did = decodeURIComponent(match[1]);
          if (method === 'GET') {
            return this.#handleQuotaGet(did);
          }
          if (method === 'PUT') {
            return this.#handleQuotaSet(did, req);
          }
          if (method === 'DELETE') {
            return this.#handleQuotaDelete(did);
          }
        }
      }

      // --- Tenant messages browser ---
      {
        const match = subPath.match(/^\/tenants\/([^/]+)\/messages$/);
        if (match && method === 'GET') {
          const did = decodeURIComponent(match[1]);
          return this.#handleTenantMessages(did, url);
        }
      }

      // --- Tenant protocols ---
      {
        const match = subPath.match(/^\/tenants\/([^/]+)\/protocols$/);
        if (match && method === 'GET') {
          const did = decodeURIComponent(match[1]);
          return this.#handleTenantProtocols(did);
        }
      }

      // --- Tenant data export ---
      {
        const match = subPath.match(/^\/tenants\/([^/]+)\/export$/);
        if (match && method === 'POST') {
          const did = decodeURIComponent(match[1]);
          return this.#handleTenantExport(did);
        }
      }

      // --- Rate limits ---
      if (method === 'GET' && subPath === '/rate-limits') {
        return this.#handleRateLimits();
      }

      // --- Audit log ---
      if (method === 'GET' && subPath === '/audit') {
        return this.#handleAudit(url);
      }

      // --- Runtime config ---
      if (subPath === '/config') {
        if (method === 'GET') {
          return this.#handleConfigGet();
        }
        if (method === 'PATCH') {
          return this.#handleConfigPatch(req);
        }
      }

      // --- Activity events ---
      if (method === 'GET' && subPath === '/events') {
        return this.#handleEvents(url);
      }

      // --- WebSocket connections ---
      if (method === 'GET' && subPath === '/connections') {
        return this.#handleConnections();
      }

      // --- Webhooks ---
      if (subPath === '/webhooks') {
        if (method === 'GET') {
          return this.#handleWebhookList();
        }
        if (method === 'POST') {
          return this.#handleWebhookCreate(req);
        }
      }

      // --- Webhook delete ---
      {
        const match = subPath.match(/^\/webhooks\/([^/]+)$/);
        if (match && method === 'DELETE') {
          return this.#handleWebhookDelete(match[1]);
        }
      }

      // --- Info (smoke test) ---
      if (method === 'GET' && subPath === '/info') {
        return Response.json({
          adminApi : true,
          uptime   : Math.floor((Date.now() - this.#startTime) / 1000),
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      log.error('Admin API error:', error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /**
   * Deep health check. Probes the underlying stores.
   */
  async #handleHealth(): Promise<Response> {
    const checks: Record<string, { status: string; latencyMs: number; error?: string }> = {};
    let allHealthy = true;

    // Probe message store by attempting a count for a non-existent tenant.
    const messageStoreCheck = await this.#probeStore('messageStore', async (): Promise<void> => {
      await this.#dwn.processMessage('did:admin:healthcheck', {
        descriptor: {
          interface        : 'Records',
          method           : 'Query',
          messageTimestamp : new Date().toISOString(),
          filter           : {},
        },
      });
    });
    checks.messageStore = messageStoreCheck;
    if (messageStoreCheck.status === 'unhealthy') {
      allHealthy = false;
    }

    // Probe admin store if available.
    if (this.#adminStore) {
      const adminStoreCheck = await this.#probeStore('adminStore', async (): Promise<void> => {
        await this.#adminStore!.getTenantCount();
      });
      checks.adminStore = adminStoreCheck;
      if (adminStoreCheck.status === 'unhealthy') {
        allHealthy = false;
      }
    }

    const uptime = Math.floor((Date.now() - this.#startTime) / 1000);

    return Response.json({
      status  : allHealthy ? 'healthy' : 'unhealthy',
      uptime,
      version : this.#packageInfo.version,
      checks,
    }, { status: allHealthy ? 200 : 503 });
  }

  /**
   * Measures the latency of a store probe function.
   */
  async #probeStore(
    name: string,
    probeFn: () => Promise<void>,
  ): Promise<{ status: string; latencyMs: number; error?: string }> {
    const start = performance.now();
    try {
      await probeFn();
      return {
        status    : 'healthy',
        latencyMs : Math.round(performance.now() - start),
      };
    } catch (error) {
      return {
        status    : 'unhealthy',
        latencyMs : Math.round(performance.now() - start),
        error     : String(error),
      };
    }
  }

  /**
   * Aggregated server statistics.
   */
  async #handleStats(url: URL): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Admin features require a SQL storage backend.' },
        { status: 501 },
      );
    }

    const refresh = url.searchParams.get('refresh') === 'true';
    const globalStats = await this.#adminStore.getGlobalStats({ refresh });
    const suspendedCount = await this.#adminStore.getSuspendedTenantCount();

    const connectionCount = this.#getConnectionCount();
    const subscriptionCount = this.#getSubscriptionCount();

    const stats: AdminServerStats = {
      tenants: {
        total     : globalStats.tenantCount,
        suspended : suspendedCount,
      },
      storage: {
        totalMessages  : globalStats.totalMessages,
        totalDataBytes : globalStats.totalDataBytes,
        totalProtocols : globalStats.totalProtocols,
      },
      connections: {
        websocket: {
          active        : connectionCount,
          subscriptions : subscriptionCount,
        },
      },
      registration: {
        proofOfWorkEnabled: this.#config.registrationProofOfWorkEnabled,
      },
      uptime: Math.floor((Date.now() - this.#startTime) / 1000),
    };

    return Response.json(stats);
  }

  /**
   * Paginated tenant list with optional search, filter, and sort.
   *
   * @see https://github.com/enboxorg/enbox/issues/390
   */
  async #handleTenantList(url: URL): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Admin features require a SQL storage backend.' },
        { status: 501 },
      );
    }

    const listOptions: TenantListOptions = {
      cursor : url.searchParams.get('cursor') ?? undefined,
      limit  : Math.min(parseIntOrDefault(url.searchParams.get('limit'), 20), 100),
      search : url.searchParams.get('search') ?? undefined,
      status : (url.searchParams.get('status') as TenantListOptions['status']) ?? undefined,
      sort   : (url.searchParams.get('sort') as TenantListOptions['sort']) ?? undefined,
      order  : (url.searchParams.get('order') as TenantListOptions['order']) ?? undefined,
    };

    // Validate enum-style params.
    if (listOptions.status !== undefined && listOptions.status !== 'active' && listOptions.status !== 'suspended') {
      return Response.json({ error: 'status must be "active" or "suspended"' }, { status: 400 });
    }
    if (listOptions.sort !== undefined && !['did', 'storage', 'messages'].includes(listOptions.sort)) {
      return Response.json({ error: 'sort must be "did", "storage", or "messages"' }, { status: 400 });
    }
    if (listOptions.order !== undefined && listOptions.order !== 'asc' && listOptions.order !== 'desc') {
      return Response.json({ error: 'order must be "asc" or "desc"' }, { status: 400 });
    }

    // Get tenant list from registration store if available, otherwise discover from messages.
    let tenantDids: string[];
    let nextCursor: string | undefined;

    if (this.#registrationStore) {
      const result = await this.#registrationStore.listTenants({
        cursor : listOptions.cursor,
        limit  : listOptions.limit,
        search : listOptions.search,
        status : listOptions.status,
      });
      tenantDids = result.tenants.map((t): string => t.did);
      nextCursor = result.cursor;
    } else {
      const result = await this.#adminStore.getDistinctTenants({
        cursor : listOptions.cursor,
        limit  : listOptions.limit,
        search : listOptions.search,
      });
      tenantDids = result.tenants;
      nextCursor = result.cursor;
    }

    // Enrich with stats.
    const tenants: AdminTenantSummary[] = await Promise.all(
      tenantDids.map(async (did): Promise<AdminTenantSummary> => {
        const stats = await this.#adminStore!.getTenantStats(did);
        return {
          did,
          messageCount     : stats.messageCount,
          dataStorageBytes : stats.dataStorageBytes,
        };
      }),
    );

    // Apply client-side sort when sorting by storage or messages (not supported in SQL cursor pagination).
    if (listOptions.sort === 'storage') {
      const dir = listOptions.order === 'desc' ? -1 : 1;
      tenants.sort((a, b): number => (a.dataStorageBytes - b.dataStorageBytes) * dir);
    } else if (listOptions.sort === 'messages') {
      const dir = listOptions.order === 'desc' ? -1 : 1;
      tenants.sort((a, b): number => (a.messageCount - b.messageCount) * dir);
    }

    const totalCount = this.#registrationStore
      ? await this.#registrationStore.getTenantCount({ search: listOptions.search, status: listOptions.status })
      : await this.#adminStore.getTenantCount();

    const response: PaginatedResponse<AdminTenantSummary> = {
      data   : tenants,
      cursor : nextCursor,
      totalCount,
    };

    return Response.json(response);
  }

  /**
   * Detailed information for a single tenant.
   */
  async #handleTenantDetail(did: string): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Admin features require a SQL storage backend.' },
        { status: 501 },
      );
    }

    const stats = await this.#adminStore.getTenantStats(did);

    // If no messages at all, tenant may not exist.
    if (stats.messageCount === 0) {
      // Check registration store.
      let registration;
      if (this.#registrationStore) {
        registration = await this.#registrationStore.getTenantRegistration(did);
      }
      if (!registration && stats.messageCount === 0) {
        return Response.json({ error: 'Tenant not found' }, { status: 404 });
      }
    }

    // Check registration and active status.
    let isActive = true;
    let suspended = false;
    let registration;

    if (this.#registrationManager) {
      const activeCheck = await this.#registrationManager.isActiveTenant(did);
      isActive = activeCheck.isActiveTenant;
    }

    if (this.#registrationStore) {
      const regData = await this.#registrationStore.getTenantRegistration(did);
      if (regData) {
        registration = {
          termsOfServiceHash: regData.termsOfServiceHash,
        };
        suspended = Boolean(regData.suspended);
      }
    }

    // Resolve quota info.
    let quotaSource: 'tenant' | 'global' | 'unlimited' = 'unlimited';
    let maxMessages = this.#config.quotaMaxMessages ?? 0;
    let maxStorageBytes = this.#config.quotaMaxStorageBytes ?? 0;
    if (maxMessages > 0 || maxStorageBytes > 0) {
      quotaSource = 'global';
    }
    if (this.#registrationStore) {
      const tenantQuota = await this.#registrationStore.getQuota(did);
      if (tenantQuota !== undefined) {
        maxMessages = tenantQuota.maxMessages ?? maxMessages;
        maxStorageBytes = tenantQuota.maxStorageBytes ?? maxStorageBytes;
        quotaSource = 'tenant';
      }
    }

    const detail: AdminTenantDetail = {
      did,
      isActive,
      suspended,
      registration,
      storage: {
        messageCount     : stats.messageCount,
        dataStorageBytes : stats.dataStorageBytes,
        protocolCount    : stats.protocolCount,
      },
      protocols : stats.protocols,
      quota     : {
        maxMessages,
        maxStorageBytes,
        source: quotaSource,
      },
    };

    return Response.json(detail);
  }

  /**
   * Delete a tenant and optionally purge their DWN data.
   */
  async #handleTenantDelete(did: string, purge: boolean): Promise<Response> {
    let deleted = false;

    if (this.#registrationStore) {
      deleted = await this.#registrationStore.deleteTenant(did);
    }

    let purged = false;
    if (purge && this.#adminStore) {
      const deletedCount = await this.#adminStore.purgeTenantData(did);
      purged = deletedCount > 0 || deleted;
    }

    if (!deleted && !purged) {
      return Response.json({ error: 'Tenant not found' }, { status: 404 });
    }

    await this.#audit('tenant.delete', did, JSON.stringify({ purged }));
    return Response.json({ success: true, did, purged });
  }

  /**
   * Suspend a tenant.
   */
  async #handleTenantSuspend(did: string): Promise<Response> {
    if (!this.#registrationStore) {
      return Response.json(
        { error: 'Tenant suspension requires registration to be enabled.' },
        { status: 501 },
      );
    }

    const success = await this.#registrationStore.suspendTenant(did);
    if (!success) {
      return Response.json({ error: 'Tenant not found' }, { status: 404 });
    }

    await this.#audit('tenant.suspend', did);
    return Response.json({ success: true, did });
  }

  /**
   * Unsuspend a tenant.
   */
  async #handleTenantUnsuspend(did: string): Promise<Response> {
    if (!this.#registrationStore) {
      return Response.json(
        { error: 'Tenant unsuspension requires registration to be enabled.' },
        { status: 501 },
      );
    }

    const success = await this.#registrationStore.unsuspendTenant(did);
    if (!success) {
      return Response.json({ error: 'Tenant not found' }, { status: 404 });
    }

    await this.#audit('tenant.unsuspend', did);
    return Response.json({ success: true, did });
  }

  /**
   * Pre-registers a tenant DID via the admin API. Optionally sets a quota.
   *
   * @see https://github.com/enboxorg/enbox/issues/393
   */
  async #handleTenantCreate(req: Request): Promise<Response> {
    if (!this.#registrationStore) {
      return Response.json(
        { error: 'Tenant creation requires registration to be enabled.' },
        { status: 501 },
      );
    }

    let body: { did?: string; maxMessages?: number; maxStorageBytes?: number };
    try {
      body = await req.json() as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.did || typeof body.did !== 'string') {
      return Response.json({ error: 'did is required and must be a string' }, { status: 400 });
    }

    const created = await this.#registrationStore.createTenant(body.did);
    if (!created) {
      return Response.json({ error: 'Tenant already exists' }, { status: 409 });
    }

    // Set quota if provided.
    if (body.maxMessages !== undefined || body.maxStorageBytes !== undefined) {
      await this.#registrationStore.setQuota({
        did             : body.did,
        maxMessages     : body.maxMessages ?? 0,
        maxStorageBytes : body.maxStorageBytes ?? 0,
      });
    }

    await this.#audit('tenant.create', body.did, JSON.stringify({
      maxMessages     : body.maxMessages,
      maxStorageBytes : body.maxStorageBytes,
    }));

    return Response.json({ success: true, did: body.did }, { status: 201 });
  }

  /**
   * Returns recent DWN activity events from the in-memory ring buffer.
   */
  #handleEvents(url: URL): Response {
    if (!this.#activityLog) {
      return Response.json(
        { error: 'Activity log is not enabled.' },
        { status: 501 },
      );
    }

    const since = parseIntOrDefault(url.searchParams.get('since'), 0);
    const limit = Math.min(parseIntOrDefault(url.searchParams.get('limit'), 50), 1000);

    const { events, cursor } = this.#activityLog.getEvents({ since, limit });

    return Response.json({ events, cursor });
  }

  /**
   * Returns snapshots of active WebSocket connections and their subscriptions.
   */
  #handleConnections(): Response {
    const connections: AdminConnectionSnapshot[] = this.#connectionManager
      ? this.#connectionManager.getConnectionSnapshots()
      : [];

    return Response.json({ connections });
  }

  // ---------------------------------------------------------------------------
  // Quota handlers
  // ---------------------------------------------------------------------------

  /**
   * Returns the quota status for a tenant, including effective limits and current usage.
   */
  async #handleQuotaGet(did: string): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Quotas require a SQL storage backend.' },
        { status: 501 },
      );
    }

    // Resolve effective quota.
    let maxMessages = this.#config.quotaMaxMessages ?? 0;
    let maxStorageBytes = this.#config.quotaMaxStorageBytes ?? 0;
    let source: 'tenant' | 'global' | 'unlimited' = maxMessages > 0 || maxStorageBytes > 0 ? 'global' : 'unlimited';

    if (this.#registrationStore) {
      const tenantQuota = await this.#registrationStore.getQuota(did);
      if (tenantQuota !== undefined) {
        maxMessages = tenantQuota.maxMessages ?? maxMessages;
        maxStorageBytes = tenantQuota.maxStorageBytes ?? maxStorageBytes;
        source = 'tenant';
      }
    }

    const [messageCount, storageBytes] = await Promise.all([
      this.#adminStore.getTenantMessageCount(did),
      this.#adminStore.getTenantStorageSize(did),
    ]);

    const status: TenantQuotaStatus = {
      quota: {
        maxMessages,
        maxStorageBytes,
        source,
      },
      usage: {
        messageCount,
        storageBytes,
      },
    };

    return Response.json(status);
  }

  /**
   * Sets the per-tenant quota.
   */
  async #handleQuotaSet(did: string, req: Request): Promise<Response> {
    if (!this.#registrationStore) {
      return Response.json(
        { error: 'Quotas require registration to be enabled.' },
        { status: 501 },
      );
    }

    let body: TenantQuotaInput;
    try {
      body = await req.json() as TenantQuotaInput;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (body.maxMessages === undefined && body.maxStorageBytes === undefined) {
      return Response.json(
        { error: 'At least one of maxMessages or maxStorageBytes must be provided.' },
        { status: 400 },
      );
    }

    // Merge with existing quota if only one field is provided.
    const existing = await this.#registrationStore.getQuota(did);

    const newQuota = {
      did,
      maxMessages     : body.maxMessages ?? existing?.maxMessages ?? 0,
      maxStorageBytes : body.maxStorageBytes ?? existing?.maxStorageBytes ?? 0,
    };
    await this.#registrationStore.setQuota(newQuota);

    await this.#audit('quota.update', did, JSON.stringify({
      maxMessages     : newQuota.maxMessages,
      maxStorageBytes : newQuota.maxStorageBytes,
    }));
    return Response.json({ success: true, did });
  }

  /**
   * Deletes the per-tenant quota, reverting to global defaults.
   */
  async #handleQuotaDelete(did: string): Promise<Response> {
    if (!this.#registrationStore) {
      return Response.json(
        { error: 'Quotas require registration to be enabled.' },
        { status: 501 },
      );
    }

    const deleted = await this.#registrationStore.deleteQuota(did);
    if (!deleted) {
      return Response.json({ error: 'No per-tenant quota found' }, { status: 404 });
    }

    await this.#audit('quota.delete', did);
    return Response.json({ success: true, did });
  }

  // ---------------------------------------------------------------------------
  // Audit log handler
  // ---------------------------------------------------------------------------

  /**
   * Queries the persistent audit log with optional filtering and pagination.
   */
  async #handleAudit(url: URL): Promise<Response> {
    if (!this.#auditLog) {
      return Response.json(
        { error: 'Audit log is not enabled. Requires a SQL storage backend.' },
        { status: 501 },
      );
    }

    const since = url.searchParams.get('since') ?? undefined;
    const action = url.searchParams.get('action') ?? undefined;
    const target = url.searchParams.get('target') ?? undefined;
    const limit = Math.min(parseIntOrDefault(url.searchParams.get('limit'), 50), 1000);
    const cursorParam = url.searchParams.get('cursor');
    const cursor = cursorParam !== null ? parseIntOrDefault(cursorParam, 0) : undefined;

    const result = await this.#auditLog.query({ since, action, target, limit, cursor });
    return Response.json(result);
  }

  // ---------------------------------------------------------------------------
  // Runtime configuration handlers
  // ---------------------------------------------------------------------------

  /**
   * Returns the current runtime-changeable configuration (non-secret values only).
   */
  #handleConfigGet(): Response {
    const runtimeConfig: RuntimeConfig = {
      logLevel                         : this.#config.logLevel,
      maxRecordDataSize                : this.#config.maxRecordDataSize,
      maxInFlight                      : this.#config.maxInFlight,
      quotaMaxMessages                 : this.#config.quotaMaxMessages,
      quotaMaxStorageBytes             : this.#config.quotaMaxStorageBytes,
      rateLimitRequestsPerSecond       : this.#config.rateLimitRequestsPerSecond,
      rateLimitBurst                   : this.#config.rateLimitBurst,
      rateLimitTenantRequestsPerSecond : this.#config.rateLimitTenantRequestsPerSecond,
      rateLimitTenantBurst             : this.#config.rateLimitTenantBurst,
    };
    return Response.json(runtimeConfig);
  }

  /**
   * Patches runtime-changeable configuration values and applies them immediately.
   */
  async #handleConfigPatch(req: Request): Promise<Response> {
    let body: RuntimeConfigPatch;
    try {
      body = await req.json() as RuntimeConfigPatch;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Validate types before applying any changes.
    const validLogLevels = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];
    if (body.logLevel !== undefined && (typeof body.logLevel !== 'string' || !validLogLevels.includes(body.logLevel.toLowerCase()))) {
      return Response.json({ error: `logLevel must be one of: ${validLogLevels.join(', ')}` }, { status: 400 });
    }

    const numericFields: (keyof RuntimeConfigPatch)[] = [
      'maxRecordDataSize', 'maxInFlight', 'quotaMaxMessages', 'quotaMaxStorageBytes',
      'rateLimitRequestsPerSecond', 'rateLimitBurst', 'rateLimitTenantRequestsPerSecond', 'rateLimitTenantBurst',
    ];
    for (const field of numericFields) {
      if (body[field] !== undefined && (typeof body[field] !== 'number' || !Number.isFinite(body[field] as number) || (body[field] as number) < 0)) {
        return Response.json({ error: `${field} must be a non-negative number` }, { status: 400 });
      }
    }

    const changes: string[] = [];

    if (body.logLevel !== undefined) {
      this.#config.logLevel = body.logLevel;
      log.setLevel(body.logLevel as log.LogLevelDesc);
      changes.push('logLevel');
    }

    if (body.maxRecordDataSize !== undefined) {
      this.#config.maxRecordDataSize = body.maxRecordDataSize;
      changes.push('maxRecordDataSize');
    }

    if (body.maxInFlight !== undefined) {
      this.#config.maxInFlight = body.maxInFlight;
      changes.push('maxInFlight');
    }

    if (body.quotaMaxMessages !== undefined) {
      this.#config.quotaMaxMessages = body.quotaMaxMessages;
      changes.push('quotaMaxMessages');
    }

    if (body.quotaMaxStorageBytes !== undefined) {
      this.#config.quotaMaxStorageBytes = body.quotaMaxStorageBytes;
      changes.push('quotaMaxStorageBytes');
    }

    if (body.rateLimitRequestsPerSecond !== undefined) {
      this.#config.rateLimitRequestsPerSecond = body.rateLimitRequestsPerSecond;
      changes.push('rateLimitRequestsPerSecond');
    }

    if (body.rateLimitBurst !== undefined) {
      this.#config.rateLimitBurst = body.rateLimitBurst;
      changes.push('rateLimitBurst');
    }

    if (body.rateLimitTenantRequestsPerSecond !== undefined) {
      this.#config.rateLimitTenantRequestsPerSecond = body.rateLimitTenantRequestsPerSecond;
      changes.push('rateLimitTenantRequestsPerSecond');
    }

    if (body.rateLimitTenantBurst !== undefined) {
      this.#config.rateLimitTenantBurst = body.rateLimitTenantBurst;
      changes.push('rateLimitTenantBurst');
    }

    if (changes.length === 0) {
      return Response.json({ error: 'No valid configuration fields provided.' }, { status: 400 });
    }

    // Reconfigure rate limiters if rate limit settings changed.
    // @see https://github.com/enboxorg/enbox/issues/389
    if (this.#ipRateLimiter && (body.rateLimitRequestsPerSecond !== undefined || body.rateLimitBurst !== undefined)) {
      this.#ipRateLimiter.reconfigure({
        refillRate : this.#config.rateLimitRequestsPerSecond,
        maxTokens  : this.#config.rateLimitBurst,
      });
    }
    if (this.#tenantRateLimiter && (body.rateLimitTenantRequestsPerSecond !== undefined || body.rateLimitTenantBurst !== undefined)) {
      this.#tenantRateLimiter.reconfigure({
        refillRate : this.#config.rateLimitTenantRequestsPerSecond,
        maxTokens  : this.#config.rateLimitTenantBurst,
      });
    }

    await this.#audit('config.update', undefined, JSON.stringify({ changes, values: body }));

    return Response.json({ success: true, updated: changes });
  }

  // ---------------------------------------------------------------------------
  // Tenant data browser handlers
  // ---------------------------------------------------------------------------

  /**
   * Returns paginated message metadata for a tenant (no content/encoded bytes).
   */
  async #handleTenantMessages(did: string, url: URL): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Requires a SQL storage backend.' },
        { status: 501 },
      );
    }

    const iface = url.searchParams.get('interface') ?? undefined;
    const method = url.searchParams.get('method') ?? undefined;
    const protocol = url.searchParams.get('protocol') ?? undefined;
    const limit = Math.min(parseIntOrDefault(url.searchParams.get('limit'), 20), 100);
    const cursorParam = url.searchParams.get('cursor');
    const cursor = cursorParam !== null ? parseIntOrDefault(cursorParam, 0) : undefined;

    const result = await this.#adminStore.getTenantMessages(did, {
      interface: iface,
      method,
      protocol,
      limit,
      cursor,
    });

    return Response.json(result);
  }

  /**
   * Returns per-protocol message counts for a tenant.
   */
  async #handleTenantProtocols(did: string): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Requires a SQL storage backend.' },
        { status: 501 },
      );
    }

    const protocols = await this.#adminStore.getTenantProtocolCounts(did);
    return Response.json({ protocols });
  }

  /**
   * Exports all message metadata and data records for a tenant as JSON.
   *
   * @see https://github.com/enboxorg/enbox/issues/391
   */
  async #handleTenantExport(did: string): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Requires a SQL storage backend.' },
        { status: 501 },
      );
    }

    const exportData = await this.#adminStore.exportTenantData(did);

    if (exportData.metadata.messageCount === 0 && exportData.metadata.dataRecordCount === 0) {
      return Response.json({ error: 'Tenant not found or has no data' }, { status: 404 });
    }

    await this.#audit('tenant.export', did, JSON.stringify({
      messageCount    : exportData.metadata.messageCount,
      dataRecordCount : exportData.metadata.dataRecordCount,
    }));

    return Response.json(exportData, {
      headers: {
        'content-disposition': `attachment; filename="${did}-export.json"`,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Rate limit handler
  // ---------------------------------------------------------------------------

  /**
   * Returns the current rate limiting configuration and active entry counts.
   */
  #handleRateLimits(): Response {
    const status: RateLimitStatus = {
      config: {
        perIp: {
          requestsPerSecond : this.#config.rateLimitRequestsPerSecond ?? 0,
          burst             : this.#config.rateLimitBurst ?? 50,
          enabled           : (this.#config.rateLimitRequestsPerSecond ?? 0) > 0,
        },
        perTenant: {
          requestsPerSecond : this.#config.rateLimitTenantRequestsPerSecond ?? 0,
          burst             : this.#config.rateLimitTenantBurst ?? 50,
          enabled           : (this.#config.rateLimitTenantRequestsPerSecond ?? 0) > 0,
        },
      },
      activeEntries: {
        ip     : this.#ipRateLimiter?.size ?? 0,
        tenant : this.#tenantRateLimiter?.size ?? 0,
      },
    };

    return Response.json(status);
  }

  // ---------------------------------------------------------------------------
  // Webhook handlers
  // ---------------------------------------------------------------------------

  /**
   * Lists all registered webhooks.
   *
   * @see https://github.com/enboxorg/enbox/issues/395
   */
  async #handleWebhookList(): Promise<Response> {
    if (!this.#webhookManager) {
      return Response.json(
        { error: 'Webhooks are not enabled. Requires a SQL storage backend.' },
        { status: 501 },
      );
    }

    const webhooks = await this.#webhookManager.list();
    return Response.json({ webhooks });
  }

  /**
   * Registers a new webhook endpoint.
   *
   * @see https://github.com/enboxorg/enbox/issues/395
   */
  async #handleWebhookCreate(req: Request): Promise<Response> {
    if (!this.#webhookManager) {
      return Response.json(
        { error: 'Webhooks are not enabled. Requires a SQL storage backend.' },
        { status: 501 },
      );
    }

    let body: AdminWebhookInput;
    try {
      body = await req.json() as AdminWebhookInput;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.url || typeof body.url !== 'string') {
      return Response.json({ error: 'url is required and must be a string' }, { status: 400 });
    }

    if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
      return Response.json({ error: 'events is required and must be a non-empty array' }, { status: 400 });
    }

    // Validate URL format.
    try {
      new URL(body.url);
    } catch {
      return Response.json({ error: 'url must be a valid URL' }, { status: 400 });
    }

    const webhook = await this.#webhookManager.register(body);
    await this.#audit('webhook.create', webhook.id, JSON.stringify({ url: body.url, events: body.events }));

    return Response.json(webhook, { status: 201 });
  }

  /**
   * Deletes a webhook registration by ID.
   *
   * @see https://github.com/enboxorg/enbox/issues/395
   */
  async #handleWebhookDelete(id: string): Promise<Response> {
    if (!this.#webhookManager) {
      return Response.json(
        { error: 'Webhooks are not enabled. Requires a SQL storage backend.' },
        { status: 501 },
      );
    }

    const deleted = await this.#webhookManager.delete(id);
    if (!deleted) {
      return Response.json({ error: 'Webhook not found' }, { status: 404 });
    }

    await this.#audit('webhook.delete', id);
    return Response.json({ success: true, id });
  }

  /**
   * Public accessor to fire webhook events from other components.
   */
  public fireWebhook(event: string, target?: string, data?: Record<string, unknown>): void {
    if (this.#webhookManager) {
      this.#webhookManager.fire(event, target, data);
    }
  }

  // ---------------------------------------------------------------------------
  // Periodic metrics updater
  // ---------------------------------------------------------------------------

  /**
   * Starts a periodic timer that updates Prometheus gauge metrics from the
   * admin store and connection manager. The interval is configured via
   * `adminMetricsUpdateIntervalSeconds` (default 30s).
   */
  public startMetricsUpdater(): void {
    if (this.#metricsInterval) {
      return;
    }

    const intervalMs = (this.#config.adminMetricsUpdateIntervalSeconds ?? 30) * 1000;

    // Run immediately, then on interval.
    this.#updateMetrics();
    this.#metricsInterval = setInterval(() => {
      this.#updateMetrics();
    }, intervalMs);
  }

  /**
   * Stops the periodic metrics updater.
   */
  public stopMetricsUpdater(): void {
    if (this.#metricsInterval) {
      clearInterval(this.#metricsInterval);
      this.#metricsInterval = undefined;
    }
  }

  /**
   * Fetches stats from the admin store and connection manager, and sets
   * Prometheus gauge values accordingly.
   */
  #updateMetrics(): void {
    // Connection gauges (synchronous).
    websocketConnections.set(this.#getConnectionCount());
    websocketSubscriptions.set(this.#getSubscriptionCount());

    // Store-based gauges (async — fire and forget).
    if (this.#adminStore) {
      this.#adminStore.getGlobalStats({ refresh: true }).then((stats) => {
        activeTenants.set(stats.tenantCount);
        totalMessages.set(stats.totalMessages);
        totalDataBytes.set(stats.totalDataBytes);
      }).catch((err) => {
        log.error('Failed to update Prometheus gauge metrics:', err);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Logs failed admin authentication attempts, rate-limited to one entry per IP
   * per 60 seconds to prevent audit log flooding.
   *
   * @see https://github.com/enboxorg/enbox/issues/392
   */
  #auditFailedAuth(req: Request, path: string): void {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const now = Date.now();
    const lastLogged = this.#failedAuthLog.get(ip);

    if (lastLogged !== undefined && (now - lastLogged) < AdminApi.#AUTH_AUDIT_INTERVAL_MS) {
      return; // Rate-limited — skip.
    }

    this.#failedAuthLog.set(ip, now);

    // Fire-and-forget — never block the response for audit logging.
    this.#audit('admin.auth.failure', ip, JSON.stringify({ path }));

    // Periodically prune old entries to prevent unbounded Map growth.
    if (this.#failedAuthLog.size > 1000) {
      const threshold = now - AdminApi.#AUTH_AUDIT_INTERVAL_MS;
      for (const [key, ts] of this.#failedAuthLog) {
        if (ts < threshold) {
          this.#failedAuthLog.delete(key);
        }
      }
    }
  }

  /**
   * Records an audit event if the audit log is available.
   * Errors are logged but never propagated — audit logging must not break operations.
   */
  async #audit(action: string, target?: string, detail?: string): Promise<void> {
    if (!this.#auditLog) {
      return;
    }
    try {
      await this.#auditLog.record({
        actor: 'admin',
        action,
        target,
        detail,
      });
    } catch (err) {
      log.error('Failed to record audit event:', err);
    }
  }

  #getConnectionCount(): number {
    if (this.#connectionManager) {
      return this.#connectionManager.getConnectionCount();
    }
    return 0;
  }

  #getSubscriptionCount(): number {
    if (this.#connectionManager) {
      return this.#connectionManager.getSubscriptionCount();
    }
    return 0;
  }
}
