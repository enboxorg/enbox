import type { DataStore, Dwn, GenericMessage, MessageStore } from '@enbox/dwn-sdk-js';
import type { DidResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName, Message } from '@enbox/dwn-sdk-js';
import { DwnServer } from '@enbox/dwn-server';
import type { DwnServerOptions, DwnServerConfig } from '@enbox/dwn-server';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import log from 'loglevel';

import { getRelayConfig } from './config.js';
import type { RelayConfig } from './config.js';
import { EvictionManager } from './eviction/eviction-manager.js';
import { IpfsResolver } from './proxy/ipfs-resolver.js';
import { ReadProxy } from './proxy/read-proxy.js';
import { WriteForwarder } from './forwarding/write-forwarder.js';
import { ServerSyncEngine } from './sync/server-sync-engine.js';
import { ConnectionPool } from './sync/connection-pool.js';
import { RelayDataStore } from './stores/relay-data-store.js';

export interface RelayServerOptions extends DwnServerOptions {
  /** Override relay-specific config (defaults to env-var-based config). */
  relayConfig?: RelayConfig;
}

/**
 * RelayServer extends DwnServer with relay/cache behavior:
 * - Write forwarding to peer endpoints
 * - Read proxying on cache miss (IPFS + peer DWN)
 * - Background data eviction
 * - Multi-tenant ServerSyncEngine
 *
 * The relay wraps the DWN engine's DataStore with a RelayDataStore that tracks
 * eviction metadata, and hooks into the message processing pipeline to add
 * forwarding and read-proxy behavior.
 */
export class RelayServer {
  #dwnServer: DwnServer;
  #relayConfig: RelayConfig;
  #relayDataStore?: RelayDataStore;
  #evictionManager?: EvictionManager;
  #readProxy?: ReadProxy;
  #writeForwarder?: WriteForwarder;
  #syncEngine?: ServerSyncEngine;
  #connectionPool: ConnectionPool;

  constructor(options: RelayServerOptions = {}) {
    this.#relayConfig = options.relayConfig ?? getRelayConfig();
    this.#connectionPool = new ConnectionPool();

    // Enable forwarding by default for relay nodes
    const serverConfig = options.config ?? this.#getDefaultServerConfig();

    this.#dwnServer = new DwnServer({
      ...options,
      config: serverConfig,
    });
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
  get relayDataStore(): RelayDataStore | undefined {
    return this.#relayDataStore;
  }

  /** The EvictionManager instance. */
  get evictionManager(): EvictionManager | undefined {
    return this.#evictionManager;
  }

  /** The ServerSyncEngine instance. */
  get syncEngine(): ServerSyncEngine | undefined {
    return this.#syncEngine;
  }

  /** The ReadProxy instance. */
  get readProxy(): ReadProxy | undefined {
    return this.#readProxy;
  }

  /** The WriteForwarder instance. */
  get writeForwarder(): WriteForwarder | undefined {
    return this.#writeForwarder;
  }

  /**
   * Start the relay server. This starts the underlying DwnServer and then
   * initializes all relay-specific services.
   */
  async start(): Promise<void> {
    // Start the underlying DwnServer first (creates DWN, stores, HTTP/WS)
    await this.#dwnServer.start();

    const dwn = this.#dwnServer.dwn;
    if (!dwn) {
      throw new Error('DwnServer failed to create DWN instance');
    }

    // Access the DWN's internal stores via the server
    // Note: the DWN engine and DwnServer don't expose the raw DataStore directly.
    // The RelayDataStore must be injected before DWN creation for full tracking.
    // For now, we create services that operate alongside the DWN.

    const didResolver = this.#dwnServer.didResolver;
    if (!didResolver) {
      throw new Error('DwnServer did not initialize a DID resolver');
    }

    // Create IPFS resolver if configured
    let ipfsResolver: IpfsResolver | undefined;
    if (this.#relayConfig.ipfsGatewayUrl) {
      ipfsResolver = new IpfsResolver(
        this.#relayConfig.ipfsGatewayUrl,
        this.#relayConfig.readProxyTimeoutMs,
      );
    }

    // Create the sync engine
    this.#syncEngine = new ServerSyncEngine({
      dwn,
      didResolver,
      config         : this.#relayConfig,
      dataStore      : this.#relayDataStore!,
      connectionPool : this.#connectionPool,
    });

    // Create the write forwarder
    this.#writeForwarder = new WriteForwarder({
      didResolver,
      rpcClient     : this.#connectionPool,
      config        : this.#relayConfig,
      onTenantWrite : (tenant) => this.#syncEngine?.notifyTenantWrite(tenant),
    });

    // Start background services
    if (this.#evictionManager) {
      this.#evictionManager.start();
    }
    this.#syncEngine.start();

    log.info('RelayServer started with relay/cache services');
  }

  /**
   * Stop the relay server and all background services.
   */
  async stop(): Promise<void> {
    this.#evictionManager?.stop();
    await this.#syncEngine?.stop();
    await this.#dwnServer.stop();

    log.info('RelayServer stopped');
  }

  /**
   * Create a RelayDataStore wrapping the given DataStore.
   * Must be called before start() if you want eviction tracking.
   *
   * @param innerDataStore - The underlying DataStore implementation.
   * @returns The wrapped RelayDataStore (pass this to Dwn.create()).
   */
  wrapDataStore(innerDataStore: DataStore): RelayDataStore {
    this.#relayDataStore = new RelayDataStore(innerDataStore);

    // Create eviction manager now that we have the data store
    this.#evictionManager = new EvictionManager(this.#relayDataStore, this.#relayConfig);

    return this.#relayDataStore;
  }

  /**
   * Hook to be called after a message is successfully processed.
   * Triggers write forwarding for RecordsWrite/RecordsDelete messages.
   *
   * @param tenant - The tenant DID.
   * @param message - The processed message.
   * @param statusCode - The response status code.
   * @param data - Optional data stream for RecordsWrite.
   */
  async onMessageProcessed(
    tenant: string,
    message: GenericMessage,
    statusCode: number,
    data?: ReadableStream<Uint8Array>,
  ): Promise<void> {
    // Only forward on successful writes/deletes
    if (statusCode !== 202) return;

    const iface = message.descriptor.interface;
    const method = message.descriptor.method;

    if (iface !== DwnInterfaceName.Records) return;
    if (method !== DwnMethodName.Write && method !== DwnMethodName.Delete) return;

    // Forward asynchronously (fire-and-forget)
    const messageCid = await Message.getCid(message);
    void this.#writeForwarder?.forward(tenant, message, messageCid, data);
  }

  #getDefaultServerConfig(): DwnServerConfig {
    // Import the default config from dwn-server and override relay-specific defaults
    // We need to access it at runtime since it's module-level state
    return {
      forwardingEnabled : true,  // Relay nodes should forward by default
      deliveryEnabled   : false, // Delivery is a separate concern
    } as DwnServerConfig;
  }
}
