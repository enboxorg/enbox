import type { DidResolver } from '@enbox/dids';
import type { DwnServerConfig } from './config.js';
import type { EventLog } from '@enbox/dwn-sdk-js';
import type { ProcessHandlers } from './process-handlers.js';
import type { Server } from 'bun';

import type { WsData } from './http-api.js';

import log from 'loglevel';
import prefix from 'loglevel-plugin-prefix';
import { Dwn, EventEmitterEventLog } from '@enbox/dwn-sdk-js';

import type { ProviderAuthPlugin } from './registration/provider-auth-plugin.js';

import { ActivityLog } from './admin/activity-log.js';
import { AdminApi } from './admin/admin-api.js';
import { AdminStore } from './admin/admin-store.js';
import { AuditLog } from './admin/audit-log.js';
import { config as defaultConfig } from './config.js';
import { HttpApi } from './http-api.js';
import { JwtProviderAuthPlugin } from './registration/jwt-provider-auth-plugin.js';
import { loadProviderAuthPlugin } from './registration/provider-auth-plugin.js';
import { OpenAuthHandler } from './registration/open-auth-handler.js';
import { PluginLoader } from './plugin-loader.js';
import { RateLimiter } from './rate-limiter.js';
import { RegistrationManager } from './registration/registration-manager.js';
import { WebhookManager } from './admin/webhook-manager.js';
import { WsApi } from './ws-api.js';
import { getDialectFromUrl, getDwnConfig } from './storage.js';
import { removeProcessHandlers, setProcessHandlers } from './process-handlers.js';

/**
 * Options for the DwnServer constructor.
 * This is different to DwnServerConfig in that the DwnServerConfig defines configuration that come from environment variables so (more) user facing.
 * Where as DwnServerOptions wraps DwnServerConfig with additional overrides that can be used for testing.
 */
export type DwnServerOptions = {
  /**
   * A custom DID resolver to use in the DWN.
   * Mainly for testing purposes. Ignored if `dwn` is provided.
   */
  didResolver?: DidResolver;
  dwn?: Dwn;
  config?: DwnServerConfig;
};

/**
 * State of the DwnServer, either Stopped or Started, to help short-circuit start and stop logic.
 */
enum DwnServerState {
  Stopped,
  Started
}

export class DwnServer {
  serverState = DwnServerState.Stopped;
  processHandlers: ProcessHandlers;

  /**
   * A custom DID resolver to use in the DWN.
   * Mainly for testing purposes. Ignored if `dwn` is provided.
   */
  didResolver?: DidResolver;
  dwn?: Dwn;
  config: DwnServerConfig;
  #httpApi: HttpApi;
  #wsApi: WsApi;
  #adminApi: AdminApi | undefined;
  #ipRateLimiter: RateLimiter | undefined;
  #tenantRateLimiter: RateLimiter | undefined;
  #auditLog: AuditLog | undefined;

  /**
   * @param options.dwn - Dwn instance to use as an override. Registration endpoint will not be enabled if this is provided.
   */
  constructor(options: DwnServerOptions = {}) {
    this.config = options.config ?? defaultConfig;

    this.didResolver = options.didResolver;
    this.dwn = options.dwn;

    log.setLevel(this.config.logLevel as log.LogLevelDesc);

    prefix.reg(log);
    prefix.apply(log);
  }

  /**
   * Starts the DWN server.
   */
  async start(): Promise<void> {
    if (this.serverState === DwnServerState.Started) {
      return;
    }

    await this.#setupServer();
    this.processHandlers = setProcessHandlers(this);
    this.serverState = DwnServerState.Started;
  }

  /**
   * Function to setup the servers (HTTP and WebSocket)
   * The DWN creation is secondary and only happens if it hasn't already been done.
   */
  async #setupServer(): Promise<void> {

    let registrationManager: RegistrationManager;
    if (!this.dwn) {
      // Load provider auth plugin if configured.
      let providerAuthPlugin: ProviderAuthPlugin | undefined;
      if (this.config.providerAuthEnabled) {
        if (this.config.providerAuthPluginPath) {
          // Custom external plugin.
          providerAuthPlugin = await loadProviderAuthPlugin(this.config.providerAuthPluginPath);
          log.info('Provider auth plugin loaded from path');
        } else if (this.config.providerAuthJwtSecret || this.config.providerAuthJwtJwksUrl) {
          // Built-in JWT plugin.
          providerAuthPlugin = await JwtProviderAuthPlugin.create({
            secret   : this.config.providerAuthJwtSecret,
            jwksUrl  : this.config.providerAuthJwtJwksUrl,
            issuer   : this.config.baseUrl,
            audience : this.config.baseUrl,
          });
          log.info('Built-in JWT provider auth plugin created');
        }
      }

      // undefined registrationStoreUrl is used as a signal that there is no need for tenant registration, DWN is open for all.
      registrationManager = await RegistrationManager.create({
        registrationStoreUrl                 : this.config.registrationStoreUrl,
        termsOfServiceFilePath               : this.config.termsOfServiceFilePath,
        proofOfWorkChallengeNonceSeed        : this.config.registrationProofOfWorkSeed,
        proofOfWorkInitialMaximumAllowedHash : this.config.registrationProofOfWorkInitialMaxHash,
        providerAuthPlugin,
      });

      let eventLog: EventLog | undefined;
      if (this.config.webSocketSupport) {
        // If EventLog plugin is not specified, use `EventEmitterEventLog` implementation as default.
        if (this.config.eventLogPluginPath === undefined || this.config.eventLogPluginPath === '') {
          eventLog = new EventEmitterEventLog();
        } else {
          eventLog = await PluginLoader.loadPlugin<EventLog>(this.config.eventLogPluginPath);
        }

      }

      const dwnConfig = await getDwnConfig(this.config, {
        didResolver : this.didResolver,
        tenantGate  : registrationManager,
        eventLog,
      });
      this.dwn = await Dwn.create(dwnConfig);
    }

    // Create rate limiters when configured.
    let ipRateLimiter: RateLimiter | undefined;
    let tenantRateLimiter: RateLimiter | undefined;

    if (this.config.rateLimitRequestsPerSecond > 0) {
      ipRateLimiter = new RateLimiter({
        refillRate : this.config.rateLimitRequestsPerSecond,
        maxTokens  : this.config.rateLimitBurst,
      });
      log.info(`Per-IP rate limiting enabled: ${this.config.rateLimitRequestsPerSecond} req/s, burst ${this.config.rateLimitBurst}`);
    }

    if (this.config.rateLimitTenantRequestsPerSecond > 0) {
      tenantRateLimiter = new RateLimiter({
        refillRate : this.config.rateLimitTenantRequestsPerSecond,
        maxTokens  : this.config.rateLimitTenantBurst,
      });
      log.info(`Per-tenant rate limiting enabled: ${this.config.rateLimitTenantRequestsPerSecond} req/s, burst ${this.config.rateLimitTenantBurst}`);
    }

    const registrationStore = registrationManager?.getRegistrationStore();

    // Initialize admin API if an admin token is configured.
    let adminApi: AdminApi | undefined;
    let activityLog: ActivityLog | undefined;
    let adminStore: AdminStore | undefined;
    let auditLog: AuditLog | undefined;
    let webhookManager: WebhookManager | undefined;

    if (this.config.adminToken) {
      const storageUrl = this.config.messageStore;
      adminStore = AdminStore.create(storageUrl);
      activityLog = new ActivityLog(this.config.adminActivityLogCapacity);

      // Create the persistent audit log using the registration store's dialect
      // (same DB) or the message store URL as fallback.
      if (this.config.registrationStoreUrl) {
        try {
          const auditDialect = getDialectFromUrl(new URL(this.config.registrationStoreUrl));
          auditLog = await AuditLog.create(auditDialect, {
            maxAgeDays : this.config.auditLogMaxAgeDays,
            maxRows    : this.config.auditLogMaxRows,
          });
        } catch (err) {
          log.warn('Failed to create audit log:', err);
        }
      }

      // Create webhook manager using the same dialect as the audit log.
      if (this.config.registrationStoreUrl) {
        try {
          const webhookDialect = getDialectFromUrl(new URL(this.config.registrationStoreUrl));
          webhookManager = await WebhookManager.create(webhookDialect);
        } catch (err) {
          log.warn('Failed to create webhook manager:', err);
        }
      }

      adminApi = AdminApi.create({
        config : this.config,
        dwn    : this.dwn,
        adminStore,
        registrationManager,
        registrationStore,
        activityLog,
        auditLog,
        ipRateLimiter,
        tenantRateLimiter,
        webhookManager,
      });

      // Record server start event in audit log.
      if (auditLog) {
        await auditLog.record({ actor: 'system', action: 'server.start' });
      }

      log.info('Admin API enabled');
    }

    // Store references for cleanup in stop().
    this.#adminApi = adminApi;
    this.#ipRateLimiter = ipRateLimiter;
    this.#tenantRateLimiter = tenantRateLimiter;
    this.#auditLog = auditLog;

    // Create open-auth handler if provider auth is enabled with a JWT secret
    // and authorize/token URLs point to this server (or are not set — defaulting to built-in).
    let openAuthHandler: OpenAuthHandler | undefined;
    if (this.config.providerAuthEnabled && this.config.providerAuthJwtSecret && !this.config.providerAuthPluginPath) {
      openAuthHandler = OpenAuthHandler.create(
        this.config.providerAuthJwtSecret,
        this.config.baseUrl,
      );
      log.info('Built-in open-auth endpoints enabled');

      // Auto-configure authorize/token/refresh URLs if not explicitly set.
      if (!this.config.providerAuthAuthorizeUrl) {
        this.config.providerAuthAuthorizeUrl = `${this.config.baseUrl}/provider-auth/authorize`;
      }
      if (!this.config.providerAuthTokenUrl) {
        this.config.providerAuthTokenUrl = `${this.config.baseUrl}/provider-auth/token`;
      }
      if (!this.config.providerAuthRefreshUrl) {
        this.config.providerAuthRefreshUrl = `${this.config.baseUrl}/provider-auth/refresh`;
      }
    }

    this.#httpApi = await HttpApi.create(
      this.config, this.dwn, registrationManager, adminApi, activityLog,
      { adminStore, registrationStore, ipRateLimiter, tenantRateLimiter, openAuthHandler },
    );

    await this.#httpApi.start(this.config.port);
    log.info(`HttpServer listening on port ${this.config.port}`);

    if (this.config.webSocketSupport) {
      this.#wsApi = new WsApi(
        this.#httpApi, this.dwn, undefined, this.config.maxInFlight, activityLog,
        { adminStore, registrationStore, config: this.config, tenantRateLimiter },
      );
      this.#wsApi.start();
      log.info('WebSocketServer ready...');

      // Wire connection manager to admin API for connection counting.
      if (adminApi) {
        adminApi.setConnectionManager(this.#wsApi.connectionManager);
      }
    }

    // Start periodic Prometheus gauge updates.
    if (adminApi) {
      adminApi.startMetricsUpdater();
    }
  }

  /**
   * Stops the DWN server.
   */
  async stop(): Promise<void> {
    if (this.serverState === DwnServerState.Stopped) {
      return;
    }

    // Stop admin metrics updater and record shutdown audit event.
    if (this.#adminApi) {
      this.#adminApi.stopMetricsUpdater();
    }
    if (this.#auditLog) {
      await this.#auditLog.record({ actor: 'system', action: 'server.stop' });
      await this.#auditLog.close();
    }

    // Clean up rate limiters (stops their interval timers).
    if (this.#ipRateLimiter) {
      this.#ipRateLimiter.destroy();
    }
    if (this.#tenantRateLimiter) {
      this.#tenantRateLimiter.destroy();
    }

    await this.dwn.close();

    // Close WebSocket server if it was initialized.
    if (this.#wsApi !== undefined) {
      await this.#wsApi.close();
    }

    await this.#httpApi.close();

    removeProcessHandlers(this.processHandlers);

    this.serverState = DwnServerState.Stopped;
  }

  get httpServer(): Server<WsData> {
    return this.#httpApi.server;
  }

  /**
   * Gets the RegistrationManager for testing purposes.
   */
  get registrationManager(): RegistrationManager {
    return this.#httpApi.registrationManager;
  }
}
