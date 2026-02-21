import type { Dwn } from '@enbox/dwn-sdk-js';

import type { AdminStore } from './admin-store.js';
import type { ConnectionManager } from '../connection/connection-manager.js';
import type { DwnServerConfig } from '../config.js';
import type { RegistrationManager } from '../registration/registration-manager.js';
import type { RegistrationStore } from '../registration/registration-store.js';
import type { AdminServerStats, AdminTenantDetail, AdminTenantSummary, PaginatedResponse } from './types.js';

import log from 'loglevel';

import { validateAdminAuth } from './admin-auth.js';

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
  #startTime: number;
  #packageInfo: { version?: string };

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
    packageInfo? : { version?: string };
  }): AdminApi {
    const api = new AdminApi();
    api.#config = options.config;
    api.#dwn = options.dwn;
    api.#adminStore = options.adminStore;
    api.#registrationManager = options.registrationManager;
    api.#registrationStore = options.registrationStore;
    api.#connectionManager = options.connectionManager;
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
   * Paginated tenant list.
   */
  async #handleTenantList(url: URL): Promise<Response> {
    if (!this.#adminStore) {
      return Response.json(
        { error: 'Admin store unavailable. Admin features require a SQL storage backend.' },
        { status: 501 },
      );
    }

    const cursor = url.searchParams.get('cursor') ?? undefined;
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100);

    // Get tenant list from registration store if available, otherwise discover from messages.
    let tenantDids: string[];
    let nextCursor: string | undefined;

    if (this.#registrationStore) {
      const result = await this.#registrationStore.listTenants({ cursor, limit });
      tenantDids = result.tenants.map((t): string => t.did);
      nextCursor = result.cursor;
    } else {
      const result = await this.#adminStore.getDistinctTenants({ cursor, limit });
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

    const totalCount = this.#registrationStore
      ? await this.#registrationStore.getTenantCount()
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
      protocols: stats.protocols,
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

    return Response.json({ success: true, did });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #getConnectionCount(): number {
    if (this.#connectionManager && 'connections' in this.#connectionManager) {
      return (this.#connectionManager as any).connections.size;
    }
    return 0;
  }

  #getSubscriptionCount(): number {
    if (this.#connectionManager && 'connections' in this.#connectionManager) {
      let count = 0;
      (this.#connectionManager as any).connections.forEach((conn: any) => {
        if (conn.subscriptions) {
          count += conn.subscriptions.size;
        }
      });
      return count;
    }
    return 0;
  }
}
