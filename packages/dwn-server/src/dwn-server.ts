import type { DidResolver } from '@enbox/dids';
import type { DwnServerConfig } from './config.js';
import type { EventLog } from '@enbox/dwn-sdk-js';
import type { MessageProcessedHook } from './message-processed-hook.js';
import type { ProcessHandlers } from './process-handlers.js';
import type { Server } from 'bun';

import type { WsData } from './http-api.js';

import log from 'loglevel';
import prefix from 'loglevel-plugin-prefix';
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';
import { Dwn, EventEmitterEventLog } from '@enbox/dwn-sdk-js';

import type { ProviderAuthPlugin } from './registration/provider-auth-plugin.js';

import { ActivityLog } from './admin/activity-log.js';
import { AdminApi } from './admin/admin-api.js';
import { AdminPasskeyStore } from './admin/admin-passkey-store.js';
import { AdminSessionManager } from './admin/admin-session.js';
import { AdminStore } from './admin/admin-store.js';
import { AuditLog } from './admin/audit-log.js';
import { config as defaultConfig } from './config.js';
import { DeliveryService } from './delivery-service.js';
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
  /**
   * Hooks invoked after every `dwn.processMessage()` call.
   * The built-in DeliveryService hook is always prepended automatically
   * when forwarding or delivery is enabled. Additional hooks provided here
   * are appended after the DeliveryService hook.
   */
  messageProcessedHooks?: MessageProcessedHook[];

  /**
   * An externally created RegistrationManager to use as the tenant gate and
   * registration endpoint handler. When a pre-built `dwn` is provided, the
   * server cannot create its own RegistrationManager (because it doesn't
   * control the DWN's TenantGate). Pass one here to enable registration
   * endpoints (`POST /registration`, etc.) with a pre-built DWN.
   */
  registrationManager?: RegistrationManager;

  /**
   * An externally created OpenAuthHandler for the built-in provider-auth
   * endpoints (`/provider-auth/authorize`, `/provider-auth/token`,
   * `/provider-auth/refresh`). When a pre-built `dwn` is provided, the
   * server skips creating this handler. Pass one here to enable the
   * open-auth flow with a pre-built DWN.
   */
  openAuthHandler?: OpenAuthHandler;
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
  #passkeyStore: AdminPasskeyStore | undefined;
  #sessionManager: AdminSessionManager | undefined;
  #externalHooks: MessageProcessedHook[];
  #externalRegistrationManager: RegistrationManager | undefined;
  #externalOpenAuthHandler: OpenAuthHandler | undefined;

  /**
   * @param options.dwn - Dwn instance to use as an override.
   * @param options.registrationManager - External RegistrationManager to use with a pre-built DWN.
   * @param options.openAuthHandler - External OpenAuthHandler to use with a pre-built DWN.
   */
  constructor(options: DwnServerOptions = {}) {
    this.config = options.config ?? defaultConfig;

    this.didResolver = options.didResolver;
    this.dwn = options.dwn;
    this.#externalHooks = options.messageProcessedHooks ?? [];
    this.#externalRegistrationManager = options.registrationManager;
    this.#externalOpenAuthHandler = options.openAuthHandler;

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

    let registrationManager: RegistrationManager | undefined;

    if (!this.dwn) {
      // No pre-built DWN — create everything from scratch including registration.
      registrationManager = await this.#createRegistrationManager();

      let eventLog: EventLog | undefined;
      if (this.config.webSocketSupport) {
        // If EventLog plugin is not specified, use `EventEmitterEventLog` implementation as default.
        if (this.config.eventLogPluginPath === undefined || this.config.eventLogPluginPath === '') {
          eventLog = new EventEmitterEventLog();
        } else {
          eventLog = await PluginLoader.loadPlugin<EventLog>(this.config.eventLogPluginPath);
        }

      }

      // Use an in-memory DID resolver cache for the server. The Dwn class now
      // properly manages the resolver cache lifecycle via open()/close(), so
      // LevelDB would also work, but in-memory is simpler for server deployments
      // (no lock files, no filesystem state to manage across container restarts).
      const didResolver = this.didResolver ?? new UniversalResolver({
        didResolvers : [DidDht, DidJwk, DidKey, DidWeb],
        cache        : new DidResolverCacheMemory(),
      });

      const dwnConfig = await getDwnConfig(this.config, {
        didResolver,
        tenantGate: registrationManager,
        eventLog,
      });
      this.dwn = await Dwn.create(dwnConfig);
    } else if (this.#externalRegistrationManager) {
      // Pre-built DWN with an externally-provided RegistrationManager.
      // The caller is responsible for passing this RegistrationManager as the
      // TenantGate when creating the DWN instance.
      registrationManager = this.#externalRegistrationManager;
    }

    // Assemble message-processed hooks.
    const messageProcessedHooks: MessageProcessedHook[] = [];

    // Add the built-in DeliveryService hook when forwarding or delivery is enabled.
    if (this.config.forwardingEnabled || this.config.deliveryEnabled) {
      const deliveryResolver = this.didResolver ?? new UniversalResolver({
        didResolvers: [DidDht, DidJwk, DidKey, DidWeb],
      });
      const deliveryService = DeliveryService.create(this.dwn, deliveryResolver, this.config);
      messageProcessedHooks.push(deliveryService);
      log.info(`Delivery service enabled (forwarding: ${this.config.forwardingEnabled}, delivery: ${this.config.deliveryEnabled})`);
    }

    // Append externally provided hooks.
    messageProcessedHooks.push(...this.#externalHooks);

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
    let passkeyStore: AdminPasskeyStore | undefined;
    let sessionManager: AdminSessionManager | undefined;

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

      // Create passkey store and session manager for WebAuthn admin auth.
      // @see https://github.com/enboxorg/enbox/issues/546
      if (this.config.registrationStoreUrl) {
        try {
          const passkeyDialect = getDialectFromUrl(new URL(this.config.registrationStoreUrl));
          passkeyStore = await AdminPasskeyStore.create(passkeyDialect);
          sessionManager = new AdminSessionManager(this.config.adminSessionTtlSeconds);
          log.info('Admin passkey authentication enabled');
        } catch (err) {
          log.warn('Failed to create passkey store:', err);
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
        passkeyStore,
        sessionManager,
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
    this.#passkeyStore = passkeyStore;
    this.#sessionManager = sessionManager;

    // Create open-auth handler if provider auth is enabled with a JWT secret
    // and authorize/token URLs point to this server (or are not set — defaulting to built-in).
    // An externally-provided handler (e.g. from the relay) takes precedence.
    let openAuthHandler: OpenAuthHandler | undefined = this.#externalOpenAuthHandler;
    if (!openAuthHandler && this.config.providerAuthEnabled && this.config.providerAuthJwtSecret && !this.config.providerAuthPluginPath) {
      openAuthHandler = OpenAuthHandler.create(
        this.config.providerAuthJwtSecret,
        this.config.baseUrl,
      );
      log.info('Built-in open-auth endpoints enabled');
    }

    if (openAuthHandler) {
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
      { adminStore, registrationStore, ipRateLimiter, tenantRateLimiter, messageProcessedHooks, openAuthHandler, sessionManager },
    );

    await this.#httpApi.start(this.config.port);
    log.info(`HttpServer listening on port ${this.config.port}`);

    if (this.config.webSocketSupport) {
      this.#wsApi = new WsApi(
        this.#httpApi, this.dwn, undefined, this.config.maxInFlight, activityLog,
        { adminStore, registrationStore, config: this.config, tenantRateLimiter, messageProcessedHooks },
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
   * Creates a RegistrationManager based on the server config. Factored out of
   * `#setupServer()` so the same logic can be reused regardless of whether the
   * DWN is created internally or externally.
   */
  async #createRegistrationManager(): Promise<RegistrationManager> {
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

    // undefined registrationStoreUrl is used as a signal that there is no need
    // for tenant registration, DWN is open for all.
    const registrationManager = await RegistrationManager.create({
      registrationStoreUrl                 : this.config.registrationStoreUrl,
      termsOfServiceFilePath               : this.config.termsOfServiceFilePath,
      proofOfWorkChallengeNonceSeed        : this.config.registrationProofOfWorkSeed,
      proofOfWorkInitialMaximumAllowedHash : this.config.registrationProofOfWorkInitialMaxHash,
      providerAuthPlugin,
    });

    // Warn if the tenant gate is active but no registration method is enabled.
    if (this.config.registrationStoreUrl
      && !this.config.registrationProofOfWorkEnabled
      && !providerAuthPlugin) {
      log.warn(
        '*** WARNING: DWN_REGISTRATION_STORE_URL is set (tenant gate active) but neither ' +
        'proof-of-work (DWN_REGISTRATION_PROOF_OF_WORK_ENABLED) nor provider auth ' +
        '(DWN_PROVIDER_AUTH_ENABLED + secret/plugin) is configured. ' +
        'New tenants will be unable to register. ***',
      );
    }

    return registrationManager;
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

    // Clean up passkey store and session manager.
    if (this.#passkeyStore) {
      await this.#passkeyStore.close();
    }
    if (this.#sessionManager) {
      this.#sessionManager.destroy();
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
