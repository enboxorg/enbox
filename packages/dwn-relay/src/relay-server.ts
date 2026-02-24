import type { RelayConfig } from './config.js';
import type { DwnServerConfig, MessageProcessedContext, MessageProcessedHook } from '@enbox/dwn-server';

import log from 'loglevel';

import { ConnectionPool } from './sync/connection-pool.js';
import { EvictionManager } from './eviction/eviction-manager.js';
import { getRelayConfig } from './config.js';
import { IpfsResolver } from './proxy/ipfs-resolver.js';
import { MetadataStore } from './stores/metadata-store.js';
import { RelayDataStore } from './stores/relay-data-store.js';
import { ServerSyncEngine } from './sync/server-sync-engine.js';
import { defaultDwnServerConfig, DwnServer, getDwnConfig } from '@enbox/dwn-server';
import { Dwn, DwnInterfaceName, DwnMethodName, EventEmitterEventLog } from '@enbox/dwn-sdk-js';

export interface RelayServerOptions {
  /** Override relay-specific config (defaults to env-var-based config). */
  relayConfig?: RelayConfig;
  /** Override server config (defaults to env-var-based config with relay overrides). */
  serverConfig?: DwnServerConfig;
}

/**
 * RelayServer extends DwnServer with relay/cache behavior:
 * - Transparent read proxying on cache miss (via RelayDataStore.get())
 * - Write forwarding via DeliveryService (with cache/full endpoint awareness)
 * - Background data eviction (EvictionManager)
 * - Multi-tenant ServerSyncEngine
 *
 * The relay constructs its own Dwn instance with RelayDataStore wrapping the
 * standard DataStore, then passes it to DwnServer via the `dwn` option.
 * This ensures all DWN reads/writes flow through the relay's tracking layer.
 */
export class RelayServer {
  #dwnServer: DwnServer;
  #relayConfig: RelayConfig;
  #relayDataStore: RelayDataStore;
  #evictionManager: EvictionManager;
  #syncEngine?: ServerSyncEngine;
  #connectionPool: ConnectionPool;
  #syncNotificationHook?: SyncNotificationHook;

  /** Private constructor — use `RelayServer.create()` to instantiate. */
  private constructor(
    dwnServer: DwnServer,
    relayConfig: RelayConfig,
    relayDataStore: RelayDataStore,
    evictionManager: EvictionManager,
    connectionPool: ConnectionPool,
    syncNotificationHook?: SyncNotificationHook,
  ) {
    this.#dwnServer = dwnServer;
    this.#relayConfig = relayConfig;
    this.#relayDataStore = relayDataStore;
    this.#evictionManager = evictionManager;
    this.#connectionPool = connectionPool;
    this.#syncNotificationHook = syncNotificationHook;
  }

  /**
   * Create and wire up a RelayServer.
   *
   * This async factory:
   * 1. Builds the standard DWN stores from server config
   * 2. Wraps the DataStore with RelayDataStore
   * 3. Creates the Dwn instance with the wrapped store
   * 4. Creates DwnServer with the pre-built Dwn and a sync-notification hook
   * 5. Returns the wired RelayServer (call `.start()` to begin)
   */
  static async create(options: RelayServerOptions = {}): Promise<RelayServer> {
    const relayConfig = options.relayConfig ?? getRelayConfig();
    const serverConfig = options.serverConfig ?? {
      ...defaultDwnServerConfig,
      logLevel          : process.env.DWN_SERVER_LOG_LEVEL || 'INFO',
      forwardingEnabled : true,
    };

    // Build the standard stores using dwn-server's config-driven factory.
    const dwnConfig = await getDwnConfig(serverConfig, {});

    // Create persistent metadata store if configured.
    const metadataStore = relayConfig.metadataPath
      ? new MetadataStore(relayConfig.metadataPath)
      : undefined;

    // Wrap the DataStore with our eviction-tracking relay store.
    const relayDataStore = new RelayDataStore(dwnConfig.dataStore, metadataStore);

    // Create EventLog for WebSocket subscription support.
    let eventLog = dwnConfig.eventLog;
    if (!eventLog && serverConfig.webSocketSupport) {
      eventLog = new EventEmitterEventLog();
    }

    // Create the Dwn with the wrapped DataStore.
    const dwn = await Dwn.create({
      ...dwnConfig,
      dataStore: relayDataStore,
      eventLog,
    });

    // Create the connection pool (shared between sync engine and read proxy).
    const connectionPool = new ConnectionPool();

    // Build the sync-notification hook — fires after processMessage to
    // tell the sync engine that a tenant has new writes.
    const syncNotificationHook = new SyncNotificationHook();

    // Create DwnServer with our pre-built Dwn and the sync notification hook.
    const dwnServer = new DwnServer({
      dwn,
      config                : serverConfig,
      messageProcessedHooks : [syncNotificationHook],
    });

    // Create eviction manager.
    const evictionManager = new EvictionManager(relayDataStore, relayConfig);

    return new RelayServer(
      dwnServer, relayConfig, relayDataStore, evictionManager, connectionPool, syncNotificationHook,
    );
  }

  /** The underlying DwnServer instance. */
  get server(): DwnServer {
    return this.#dwnServer;
  }

  /** The relay-specific configuration. */
  get relayConfig(): RelayConfig {
    return this.#relayConfig;
  }

  /** The RelayDataStore wrapping the underlying DataStore. */
  get relayDataStore(): RelayDataStore {
    return this.#relayDataStore;
  }

  /** The EvictionManager instance. */
  get evictionManager(): EvictionManager {
    return this.#evictionManager;
  }

  /** The ServerSyncEngine instance (available after start()). */
  get syncEngine(): ServerSyncEngine | undefined {
    return this.#syncEngine;
  }

  /**
   * Start the relay server. Starts the DwnServer, then initializes relay services.
   */
  async start(): Promise<void> {
    // Start the underlying DwnServer (sets up HTTP/WS endpoints).
    await this.#dwnServer.start();

    const dwn = this.#dwnServer.dwn;
    if (!dwn) {
      throw new Error('DwnServer failed to start — no DWN instance');
    }

    const didResolver = this.#dwnServer.didResolver;

    // Configure read-proxy on the RelayDataStore.
    let ipfsResolver: IpfsResolver | undefined;
    if (this.#relayConfig.ipfsGatewayUrl) {
      ipfsResolver = new IpfsResolver(
        this.#relayConfig.ipfsGatewayUrl,
        this.#relayConfig.readProxyTimeoutMs,
      );
    }

    if (didResolver) {
      this.#relayDataStore.setProxy({
        didResolver,
        rpcClient : this.#connectionPool,
        config    : this.#relayConfig,
        ipfsResolver,
      });
    }

    // Create and start the sync engine.
    if (didResolver) {
      this.#syncEngine = new ServerSyncEngine({
        dwn,
        didResolver,
        config         : this.#relayConfig,
        dataStore      : this.#relayDataStore,
        connectionPool : this.#connectionPool,
      });

      // Wire the sync notification hook to the sync engine.
      if (this.#syncNotificationHook) {
        this.#syncNotificationHook.syncEngine = this.#syncEngine;
      }

      this.#syncEngine.start();
    }

    // Start background eviction.
    this.#evictionManager.start();

    log.info('RelayServer started with relay/cache services');
  }

  /**
   * Stop the relay server and all background services.
   */
  async stop(): Promise<void> {
    this.#evictionManager.stop();
    await this.#syncEngine?.stop();
    await this.#dwnServer.stop();

    log.info('RelayServer stopped');
  }
}

// ---------------------------------------------------------------------------
// Internal hook for sync engine notification
// ---------------------------------------------------------------------------

/**
 * A MessageProcessedHook that notifies the ServerSyncEngine when a tenant
 * has new writes, boosting their sync priority.
 */
class SyncNotificationHook implements MessageProcessedHook {
  syncEngine?: ServerSyncEngine;

  onMessageProcessed(context: MessageProcessedContext): void {
    if (context.status.code !== 202) {return;}

    const iface = context.message.descriptor.interface as string;
    const method = context.message.descriptor.method as string;

    if (iface !== DwnInterfaceName.Records) {return;}
    if (method !== DwnMethodName.Write && method !== DwnMethodName.Delete) {return;}

    this.syncEngine?.notifyTenantWrite(context.tenant);
  }
}
