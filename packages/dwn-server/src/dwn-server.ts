import type { Dialect } from '@enbox/dwn-sql-store';
import type { DidResolver } from '@enbox/dids';
import type { DwnServerConfig } from './config.js';
import type { EventBus } from './event-bus.js';
import type { LocalNodePairingManager } from './local-node-pairing.js';
import type { MessageProcessedHook } from './message-processed-hook.js';
import type { ProcessHandlers } from './process-handlers.js';
import type { ProviderAuthPlugin } from './registration/provider-auth-plugin.js';
import type { RegistrationStore } from './registration/registration-store.js';
import type { Server } from 'bun';
import type { WsData } from './http-api.js';

import { ActivityLog } from './admin/activity-log.js';
import { AdminApi } from './admin/admin-api.js';
import { AdminPasskeyStore } from './admin/admin-passkey-store.js';
import { AdminSessionManager } from './admin/admin-session.js';
import { AdminStore } from './admin/admin-store.js';
import { assertLocalNodeBindHostname } from './local-node-profile.js';
import { AuditLog } from './admin/audit-log.js';
import { config as defaultConfig } from './config.js';
import { DeliveryService } from './delivery-service.js';
import { Dwn } from '@enbox/dwn-sdk-js';
import { HttpApi } from './http-api.js';
import { InMemoryEventBus } from './event-bus.js';
import { LocalNodePairingManager as InMemoryLocalNodePairingManager } from './local-node-pairing.js';
import { JwtProviderAuthPlugin } from './registration/jwt-provider-auth-plugin.js';
import { loadProviderAuthPlugin } from './registration/provider-auth-plugin.js';
import log from 'loglevel';
import { OpenAuthHandler } from './registration/open-auth-handler.js';
import { PluginLoader } from './plugin-loader.js';
import { RateLimiter } from './rate-limiter.js';
import { RegistrationManager } from './registration/registration-manager.js';
import { WebhookManager } from './admin/webhook-manager.js';
import { WsApi } from './ws-api.js';
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';
import { getDialectFromUrl, getDwnConfig, runServerMigrationsIfNeeded } from './storage.js';
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

  /**
   * Pairing/session manager used by the local-node profile.
   * Shell-specific wrappers use this to approve or deny pairing requests.
   */
  localNodePairingManager?: LocalNodePairingManager;
};

/**
 * Inputs required by `#setupAdminApi()` to initialize the admin API and its
 * supporting stores. Extracted from `#setupServer()`'s local state so admin
 * bootstrap logic can be isolated into its own method.
 */
type AdminApiSetupParams = {
  serverDialect: Dialect | undefined;
  registrationManager: RegistrationManager | undefined;
  registrationStore: RegistrationStore | undefined;
  ipRateLimiter: RateLimiter | undefined;
  tenantRateLimiter: RateLimiter | undefined;
};

/**
 * Admin API and supporting stores created by `#setupAdminApi()`, or all
 * `undefined` fields when no admin token is configured.
 */
type AdminApiSetupResult = {
  adminApi: AdminApi | undefined;
  activityLog: ActivityLog | undefined;
  adminStore: AdminStore | undefined;
  auditLog: AuditLog | undefined;
  passkeyStore: AdminPasskeyStore | undefined;
  sessionManager: AdminSessionManager | undefined;
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
  #eventBus: EventBus | undefined;
  readonly #externalHooks: MessageProcessedHook[];
  readonly #externalRegistrationManager: RegistrationManager | undefined;
  readonly #externalOpenAuthHandler: OpenAuthHandler | undefined;
  readonly #localNodePairingManager: LocalNodePairingManager;

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
    this.#localNodePairingManager = options.localNodePairingManager ?? new InMemoryLocalNodePairingManager();

    log.setLevel(this.config.logLevel as log.LogLevelDesc);
  }

  /**
   * Starts the DWN server.
   */
  async start(): Promise<void> {
    if (this.serverState === DwnServerState.Started) {
      return;
    }

    if (this.config.localNodeProfileEnabled) {
      assertLocalNodeBindHostname(this.config.hostname);
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

    // Run server migrations (admin stores, registration, TTL cache) FIRST,
    // before creating any stores that depend on the server schema. The
    // returned dialect is reused for the TTL cache and admin stores so that
    // in-memory SQLite shares a single database instance across migrations
    // and stores.
    const serverDialect = await runServerMigrationsIfNeeded(this.config);

    const registrationManager = await this.#createDwnAndRegistrationManager();

    // Assemble message-processed hooks.
    const messageProcessedHooks = this.#buildMessageProcessedHooks();

    // Create rate limiters when configured.
    const { ipRateLimiter, tenantRateLimiter } = this.#createRateLimiters();

    const registrationStore = registrationManager?.getRegistrationStore();

    // Initialize admin API if an admin token is configured.
    const {
      adminApi, activityLog, adminStore, auditLog, passkeyStore, sessionManager,
    } = await this.#setupAdminApi({ serverDialect, registrationManager, registrationStore, ipRateLimiter, tenantRateLimiter });

    // Store references for cleanup in stop().
    this.#adminApi = adminApi;
    this.#ipRateLimiter = ipRateLimiter;
    this.#tenantRateLimiter = tenantRateLimiter;
    this.#auditLog = auditLog;
    this.#passkeyStore = passkeyStore;
    this.#sessionManager = sessionManager;

    const openAuthHandler = this.#createOpenAuthHandler();

    this.#httpApi = await HttpApi.create(
      this.config, this.dwn, registrationManager, adminApi, activityLog,
      {
        adminStore, registrationStore, ipRateLimiter, tenantRateLimiter,
        messageProcessedHooks, openAuthHandler, sessionManager,
        localNodePairingManager : this.#localNodePairingManager,
        ttlCacheDialect         : serverDialect,
      },
    );

    await this.#httpApi.start(this.config.port);
    log.info(`HttpServer listening on port ${this.config.port}`);

    if (this.config.webSocketSupport) {
      this.#wsApi = new WsApi(this.#httpApi, this.dwn, { activityLog });
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
   * Creates the DWN instance (when one wasn't pre-built) together with its
   * RegistrationManager, or resolves the externally-provided
   * RegistrationManager when a pre-built DWN was supplied. Extracted from
   * `#setupServer()` to keep the top-level setup sequence readable.
   */
  async #createDwnAndRegistrationManager(): Promise<RegistrationManager | undefined> {
    let registrationManager: RegistrationManager | undefined;

    if (!this.dwn) {
      // No pre-built DWN — create everything from scratch including registration.
      registrationManager = await this.#createRegistrationManager();
      const eventBus = await this.#createEventBus();
      this.#eventBus = eventBus;

      try {
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
          tenantGate     : registrationManager,
          eventBus,
          enableEventLog : this.config.webSocketSupport,
        });
        this.dwn = await Dwn.create(dwnConfig);
      } catch (error) {
        await eventBus.close();
        this.#eventBus = undefined;
        throw error;
      }
    } else if (this.#externalRegistrationManager) {
      // Pre-built DWN with an externally-provided RegistrationManager.
      // The caller is responsible for passing this RegistrationManager as the
      // TenantGate when creating the DWN instance.
      registrationManager = this.#externalRegistrationManager;
    }

    return registrationManager;
  }

  /**
   * Assembles the ordered list of message-processed hooks: the built-in
   * DeliveryService hook (when forwarding or delivery is enabled) followed by
   * any externally-provided hooks. Extracted from `#setupServer()`.
   */
  #buildMessageProcessedHooks(): MessageProcessedHook[] {
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

    return messageProcessedHooks;
  }

  /**
   * Creates the per-IP and per-tenant rate limiters when their respective
   * thresholds are configured. Extracted from `#setupServer()`.
   */
  #createRateLimiters(): { ipRateLimiter: RateLimiter | undefined; tenantRateLimiter: RateLimiter | undefined } {
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

    return { ipRateLimiter, tenantRateLimiter };
  }

  /**
   * Initializes the admin API and its supporting stores (activity log, audit
   * log, webhook manager, passkey store, session manager) when an admin token
   * is configured. Extracted from `#setupServer()` to keep the top-level setup
   * sequence readable.
   */
  async #setupAdminApi(params: AdminApiSetupParams): Promise<AdminApiSetupResult> {
    const { serverDialect, registrationManager, registrationStore, ipRateLimiter, tenantRateLimiter } = params;

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

      // Reuse the dialect returned by server migrations when available — this
      // is critical for in-memory SQLite where every `getDialectFromUrl` call
      // creates a separate database. For Postgres, `serverDialect` points at
      // the same shared pool, so reusing it also avoids pool proliferation.
      if (this.config.registrationStoreUrl) {
        const adminDialect = serverDialect ?? getDialectFromUrl(new URL(this.config.registrationStoreUrl));

        try {
          auditLog = await AuditLog.create(adminDialect, {
            maxAgeDays : this.config.auditLogMaxAgeDays,
            maxRows    : this.config.auditLogMaxRows,
          });
        } catch (err) {
          log.warn('Failed to create audit log:', err);
        }

        try {
          webhookManager = await WebhookManager.create(adminDialect);
        } catch (err) {
          log.warn('Failed to create webhook manager:', err);
        }

        // Create passkey store and session manager for WebAuthn admin auth.
        // @see https://github.com/enboxorg/enbox/issues/546
        try {
          passkeyStore = await AdminPasskeyStore.create(adminDialect);
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

    return { adminApi, activityLog, adminStore, auditLog, passkeyStore, sessionManager };
  }

  /**
   * Resolves the open-auth handler to use for provider-auth endpoints and
   * auto-configures the authorize/token/refresh URLs when the handler is
   * active and the URLs aren't explicitly set. Extracted from `#setupServer()`.
   */
  #createOpenAuthHandler(): OpenAuthHandler | undefined {
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

    return openAuthHandler;
  }

  async #createEventBus(): Promise<EventBus> {
    const eventBus = this.config.eventBusPluginPath === undefined || this.config.eventBusPluginPath === ''
      ? new InMemoryEventBus()
      : await PluginLoader.loadPlugin<EventBus>(this.config.eventBusPluginPath);

    await eventBus.open();
    return eventBus;
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

    // Close WebSocket server if it was initialized.
    if (this.#wsApi !== undefined) {
      await this.#wsApi.close();
    }

    await this.dwn.close();

    if (this.#eventBus !== undefined) {
      await this.#eventBus.close();
      this.#eventBus = undefined;
    }

    await this.#httpApi.close();

    removeProcessHandlers(this.processHandlers);

    this.serverState = DwnServerState.Stopped;
  }

  get httpServer(): Server<WsData> {
    return this.#httpApi.server;
  }

  get localNodePairingManager(): LocalNodePairingManager {
    return this.#localNodePairingManager;
  }

  /**
   * Revokes a local-node pairing token and immediately closes any live WebSocket connections authenticated by it.
   */
  public async revokeLocalNodePairingToken(token: string): Promise<boolean> {
    const revoked = this.#localNodePairingManager.revokeToken(token);
    if (!revoked) {
      return false;
    }

    if (this.#wsApi !== undefined) {
      await this.#wsApi.closeLocalNodeConnectionsByToken(token);
    }

    return true;
  }

  /**
   * Gets the RegistrationManager for testing purposes.
   */
  get registrationManager(): RegistrationManager {
    return this.#httpApi.registrationManager;
  }
}
