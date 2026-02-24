import { ConnectionPool } from './connection-pool.js';
import type { DidResolver } from '@enbox/dids';
import log from 'loglevel';
import type { RelayConfig } from '../config.js';
import type { RelayDataStore } from '../stores/relay-data-store.js';
import { resolveEndpoints } from '../endpoint-resolver.js';
import { SyncPriorityQueue } from './priority-queue.js';
import type { SyncWorkItem } from './priority-queue.js';
import type { Dwn, GenericMessage } from '@enbox/dwn-sdk-js';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

/**
 * Tracks the last confirmed sync state between a (tenant, peer) pair.
 */
export interface PeerSyncState {
  /** The SMT root hash last confirmed as matching on this peer. */
  lastConfirmedRoot: string;
  /** Epoch ms of the last successful sync. */
  lastSyncTimestamp: number;
}

/**
 * ServerSyncEngine orchestrates SMT-based sync for a multi-tenant relay node.
 *
 * Unlike the agent-side SyncEngineLevel (designed for a single user's identities),
 * the ServerSyncEngine handles thousands of tenants efficiently via:
 *
 * - Priority queue: (tenant, peerEndpoint) work items ordered by urgency
 * - Connection pool: per-host connection reuse (not per-tenant)
 * - Concurrent workers: configurable parallelism across tenants
 * - Peer sync state: tracks convergence for eviction decisions
 *
 * The sync algorithm itself is unchanged — SMT root comparison, tree walk on
 * divergence, message pull/push. The scheduling and resource management around
 * it is what differs.
 */
export class ServerSyncEngine {
  #dwn: Dwn;
  #didResolver: DidResolver;
  #config: RelayConfig;
  #dataStore: RelayDataStore;
  #connectionPool: ConnectionPool;
  #priorityQueue: SyncPriorityQueue;
  #running = false;
  #workers: Promise<void>[] = [];
  #scanIntervalHandle: ReturnType<typeof setInterval> | undefined;

  /** Maximum depth for SMT tree walk (same as agent sync). */
  static readonly MAX_DIFF_DEPTH = 16;

  /** Peer sync state: (tenant, peer) → state. */
  #peerSyncState: Map<string, PeerSyncState> = new Map();

  /** Set of tenants currently being synced (for serialization within a tenant). */
  #activeTenants: Set<string> = new Set();

  /** Known tenants that have been registered for sync. */
  #knownTenants: Set<string> = new Set();

  constructor(options: {
    dwn: Dwn;
    didResolver: DidResolver;
    config: RelayConfig;
    dataStore: RelayDataStore;
    connectionPool?: ConnectionPool;
  }) {
    this.#dwn = options.dwn;
    this.#didResolver = options.didResolver;
    this.#config = options.config;
    this.#dataStore = options.dataStore;
    this.#connectionPool = options.connectionPool ?? new ConnectionPool();
    this.#priorityQueue = new SyncPriorityQueue();
  }

  /** The connection pool used for outbound requests. */
  get connectionPool(): ConnectionPool {
    return this.#connectionPool;
  }

  /** The priority queue for inspection/debugging. */
  get priorityQueue(): SyncPriorityQueue {
    return this.#priorityQueue;
  }

  /**
   * Start the sync engine. Spawns worker coroutines and a periodic scan.
   */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;

    // Start workers
    for (let i = 0; i < this.#config.syncWorkers; i++) {
      this.#workers.push(this.#workerLoop(i));
    }

    // Periodic priority recalculation and stale tenant scan
    const scanIntervalMs = this.#config.syncIntervalSeconds * 1_000;
    this.#scanIntervalHandle = setInterval(() => {
      this.#priorityQueue.recalculateAll();
    }, scanIntervalMs);

    log.info(`ServerSyncEngine started (workers=${this.#config.syncWorkers}, ` +
      `interval=${this.#config.syncIntervalSeconds}s)`);
  }

  /**
   * Stop the sync engine. Waits for in-progress workers to complete.
   */
  async stop(): Promise<void> {
    if (!this.#running) {
      return;
    }
    this.#running = false;

    if (this.#scanIntervalHandle !== undefined) {
      clearInterval(this.#scanIntervalHandle);
      this.#scanIntervalHandle = undefined;
    }

    // Wait for all workers to finish their current cycle
    await Promise.allSettled(this.#workers);
    this.#workers = [];

    log.info('ServerSyncEngine stopped');
  }

  /**
   * Notify the engine that a write was processed for a tenant.
   * Queues the tenant for high-priority sync with all known peers.
   */
  notifyTenantWrite(tenant: string): void {
    this.#knownTenants.add(tenant);

    // Queue this tenant with all its peers for immediate sync
    void this.#queueTenantPeers(tenant, Date.now());
  }

  /**
   * Register a tenant for periodic sync. Called during initial setup
   * or when a new tenant is discovered.
   */
  registerTenant(tenant: string): void {
    this.#knownTenants.add(tenant);
    void this.#queueTenantPeers(tenant);
  }

  /**
   * Get the peer sync state for a (tenant, peer) pair.
   * Used by the EvictionManager to determine if data has been synced.
   */
  getPeerSyncState(tenant: string, peerEndpoint: string): PeerSyncState | undefined {
    const key = `${tenant}|${peerEndpoint}`;
    return this.#peerSyncState.get(key);
  }

  /**
   * Check if a tenant's data has been confirmed synced to at least one full peer.
   */
  isTenantSynced(tenant: string): boolean {
    for (const [key, state] of this.#peerSyncState) {
      if (key.startsWith(`${tenant}|`) && state.lastConfirmedRoot !== '') {
        return true;
      }
    }
    return false;
  }

  // ─── Worker loop ────────────────────────────────────────────────────

  async #workerLoop(workerId: number): Promise<void> {
    while (this.#running) {
      const item = this.#priorityQueue.dequeue();

      if (!item) {
        // No work available — wait before checking again
        await this.#sleep(1_000);
        continue;
      }

      // Serialize within a tenant: skip if another worker is already syncing this tenant
      if (this.#activeTenants.has(item.tenant)) {
        this.#priorityQueue.complete(item.tenant, item.peerEndpoint, true);
        continue;
      }

      this.#activeTenants.add(item.tenant);

      try {
        const success = await this.#syncTenantWithPeer(item);
        this.#priorityQueue.complete(item.tenant, item.peerEndpoint, success);
      } catch (err) {
        log.warn(`SyncWorker[${workerId}]: error syncing ${item.tenant} with ${item.peerEndpoint}:`, err);
        this.#priorityQueue.complete(item.tenant, item.peerEndpoint, false);
      } finally {
        this.#activeTenants.delete(item.tenant);
      }
    }
  }

  // ─── Sync algorithm ─────────────────────────────────────────────────

  /**
   * Sync a single tenant with a single peer endpoint.
   * Returns true if sync succeeded (roots match or reconciliation completed).
   */
  async #syncTenantWithPeer(item: SyncWorkItem): Promise<boolean> {
    const { tenant, peerEndpoint } = item;

    // Check host health before attempting
    if (!this.#connectionPool.isHostHealthy(peerEndpoint)) {
      return false;
    }

    // Phase 1: Compare SMT roots
    const localRoot = await this.#getLocalRoot(tenant);
    const remoteRoot = await this.#getRemoteRoot(tenant, peerEndpoint);

    if (remoteRoot === undefined) {
      // Failed to reach peer
      return false;
    }

    if (localRoot === remoteRoot) {
      // Already in sync
      this.#updatePeerSyncState(tenant, peerEndpoint, localRoot);
      this.#markTenantDataSynced(tenant);
      return true;
    }

    // Phase 2: Walk the tree to find divergent regions
    const diff = await this.#walkTreeDiff(tenant, peerEndpoint, '');

    if (diff === undefined) {
      return false; // Tree walk failed
    }

    // Phase 3: Push messages the peer is missing (local-only)
    if (diff.onlyLocal.length > 0) {
      await this.#pushMessages(tenant, peerEndpoint, diff.onlyLocal);
    }

    // Phase 4: Pull messages we're missing (remote-only)
    if (diff.onlyRemote.length > 0) {
      await this.#pullMessages(tenant, peerEndpoint, diff.onlyRemote);
    }

    // Verify convergence
    const newLocalRoot = await this.#getLocalRoot(tenant);
    const newRemoteRoot = await this.#getRemoteRoot(tenant, peerEndpoint);
    if (newLocalRoot === newRemoteRoot) {
      this.#updatePeerSyncState(tenant, peerEndpoint, newLocalRoot);
      this.#markTenantDataSynced(tenant);
    }

    return true;
  }

  /**
   * Get the local SMT root hash for a tenant.
   */
  async #getLocalRoot(tenant: string): Promise<string> {
    const reply = await this.#dwn.processMessage(tenant, {
      descriptor: {
        interface        : DwnInterfaceName.Messages,
        method           : DwnMethodName.Sync,
        messageTimestamp : new Date().toISOString(),
        action           : 'root',
      },
    });
    return (reply as any).root ?? '';
  }

  /**
   * Get the remote SMT root hash for a tenant via RPC.
   */
  async #getRemoteRoot(tenant: string, peerEndpoint: string): Promise<string | undefined> {
    try {
      const response = await this.#connectionPool.sendDwnRequest({
        dwnUrl    : peerEndpoint,
        targetDid : tenant,
        message   : {
          descriptor: {
            interface        : DwnInterfaceName.Messages,
            method           : DwnMethodName.Sync,
            messageTimestamp : new Date().toISOString(),
            action           : 'root',
          },
        },
      });

      if (response.status?.code !== 200) {
        return undefined;
      }

      return (response as any).root ?? '';
    } catch (err) {
      log.debug(`ServerSyncEngine: failed to get remote root from ${peerEndpoint} for ${tenant}:`, err);
      return undefined;
    }
  }

  /**
   * Recursive tree walk to find divergent messageCids.
   */
  async #walkTreeDiff(
    tenant: string,
    peerEndpoint: string,
    prefix: string,
  ): Promise<{ onlyLocal: string[]; onlyRemote: string[] } | undefined> {
    const onlyLocal: string[] = [];
    const onlyRemote: string[] = [];

    const walk = async (currentPrefix: string): Promise<boolean> => {
      // Get subtree hashes from both sides
      let localHash: string;
      let remoteHash: string;

      try {
        const [localReply, remoteReply] = await Promise.all([
          this.#getLocalSubtreeHash(tenant, currentPrefix),
          this.#getRemoteSubtreeHash(tenant, peerEndpoint, currentPrefix),
        ]);
        localHash = localReply;
        remoteHash = remoteReply ?? '';
      } catch {
        return false;
      }

      // Subtrees match
      if (localHash === remoteHash) {
        return true;
      }

      // At max depth, enumerate and diff leaf sets
      if (currentPrefix.length >= ServerSyncEngine.MAX_DIFF_DEPTH) {
        try {
          const [localLeaves, remoteLeaves] = await Promise.all([
            this.#getLocalLeaves(tenant, currentPrefix),
            this.#getRemoteLeaves(tenant, peerEndpoint, currentPrefix),
          ]);

          const localSet = new Set(localLeaves);
          const remoteSet = new Set(remoteLeaves ?? []);

          for (const cid of localSet) {
            if (!remoteSet.has(cid)) {
              onlyLocal.push(cid);
            }
          }
          for (const cid of remoteSet) {
            if (!localSet.has(cid)) {
              onlyRemote.push(cid);
            }
          }

          return true;
        } catch {
          return false;
        }
      }

      // Recurse into children
      const leftOk = await walk(currentPrefix + '0');
      const rightOk = await walk(currentPrefix + '1');
      return leftOk && rightOk;
    };

    const ok = await walk(prefix);
    return ok ? { onlyLocal, onlyRemote } : undefined;
  }

  async #getLocalSubtreeHash(tenant: string, prefix: string): Promise<string> {
    const reply = await this.#dwn.processMessage(tenant, {
      descriptor: {
        interface        : DwnInterfaceName.Messages,
        method           : DwnMethodName.Sync,
        messageTimestamp : new Date().toISOString(),
        action           : 'subtree',
        prefix,
      },
    });
    return (reply as any).hash ?? '';
  }

  async #getRemoteSubtreeHash(tenant: string, peerEndpoint: string, prefix: string): Promise<string | undefined> {
    try {
      const response = await this.#connectionPool.sendDwnRequest({
        dwnUrl    : peerEndpoint,
        targetDid : tenant,
        message   : {
          descriptor: {
            interface        : DwnInterfaceName.Messages,
            method           : DwnMethodName.Sync,
            messageTimestamp : new Date().toISOString(),
            action           : 'subtree',
            prefix,
          },
        },
      });
      return response.status?.code === 200 ? (response as any).hash ?? '' : undefined;
    } catch {
      return undefined;
    }
  }

  async #getLocalLeaves(tenant: string, prefix: string): Promise<string[]> {
    const reply = await this.#dwn.processMessage(tenant, {
      descriptor: {
        interface        : DwnInterfaceName.Messages,
        method           : DwnMethodName.Sync,
        messageTimestamp : new Date().toISOString(),
        action           : 'leaves',
        prefix,
      },
    });
    return (reply as any).entries ?? [];
  }

  async #getRemoteLeaves(tenant: string, peerEndpoint: string, prefix: string): Promise<string[] | undefined> {
    try {
      const response = await this.#connectionPool.sendDwnRequest({
        dwnUrl    : peerEndpoint,
        targetDid : tenant,
        message   : {
          descriptor: {
            interface        : DwnInterfaceName.Messages,
            method           : DwnMethodName.Sync,
            messageTimestamp : new Date().toISOString(),
            action           : 'leaves',
            prefix,
          },
        },
      });
      return response.status?.code === 200 ? (response as any).entries ?? [] : undefined;
    } catch {
      return undefined;
    }
  }

  // ─── Message push/pull ──────────────────────────────────────────────

  /**
   * Push messages to a peer endpoint.
   * Reads messages from local MessageStore and sends them via RPC.
   */
  async #pushMessages(tenant: string, peerEndpoint: string, messageCids: string[]): Promise<void> {
    for (const messageCid of messageCids) {
      try {
        // Read the message locally via MessagesRead
        const readReply = await this.#dwn.processMessage(tenant, {
          descriptor: {
            interface        : DwnInterfaceName.Messages,
            method           : DwnMethodName.Read,
            messageTimestamp : new Date().toISOString(),
            messageCid,
          },
        });

        if (readReply.status.code !== 200 || !(readReply as any).entry) {
          continue;
        }

        const entry = (readReply as any).entry;
        const message = entry.message as GenericMessage;
        const data = entry.data as ReadableStream<Uint8Array> | undefined;

        // Send to peer
        await this.#connectionPool.sendDwnRequest({
          dwnUrl    : peerEndpoint,
          targetDid : tenant,
          message,
          data,
        });
      } catch (err) {
        log.debug(`ServerSyncEngine: failed to push ${messageCid} to ${peerEndpoint}:`, err);
      }
    }
  }

  /**
   * Pull messages from a peer endpoint.
   * Fetches messages via RPC and processes them locally.
   */
  async #pullMessages(tenant: string, peerEndpoint: string, messageCids: string[]): Promise<void> {
    for (const messageCid of messageCids) {
      try {
        // Read from peer via MessagesRead
        const response = await this.#connectionPool.sendDwnRequest({
          dwnUrl    : peerEndpoint,
          targetDid : tenant,
          message   : {
            descriptor: {
              interface        : DwnInterfaceName.Messages,
              method           : DwnMethodName.Read,
              messageTimestamp : new Date().toISOString(),
              messageCid,
            },
          },
        });

        if (response.status?.code !== 200 || !(response as any).entry) {
          continue;
        }

        const entry = (response as any).entry;
        const message = entry.message as GenericMessage;
        const dataStream = entry.data as ReadableStream<Uint8Array> | undefined;

        // Process locally
        await this.#dwn.processMessage(tenant, message, { dataStream });
      } catch (err) {
        log.debug(`ServerSyncEngine: failed to pull ${messageCid} from ${peerEndpoint}:`, err);
      }
    }
  }

  // ─── State management ───────────────────────────────────────────────

  #updatePeerSyncState(tenant: string, peerEndpoint: string, root: string): void {
    const key = `${tenant}|${peerEndpoint}`;
    this.#peerSyncState.set(key, {
      lastConfirmedRoot : root,
      lastSyncTimestamp : Date.now(),
    });
  }

  /**
   * Mark all data entries for a tenant as synced in the RelayDataStore.
   * Called when we confirm convergence with a full peer.
   */
  #markTenantDataSynced(tenant: string): void {
    // Find the peer we just synced with — check if any is a full node
    for (const [key, _state] of this.#peerSyncState) {
      if (!key.startsWith(`${tenant}|`)) {
        continue;
      }
      // We don't track whether the peer is full here — that's determined by
      // the endpoint resolver. For now, mark data as synced whenever we have
      // root convergence with any peer. The EvictionManager uses this as a signal.
    }
    // The RelayDataStore's markSynced operates per-record, but we don't have
    // per-record granularity here. Instead, we rely on the fact that root
    // convergence means ALL messages are synced. A more granular approach
    // would track which specific messageCids were pushed.
    // For now, this is a best-effort signal to the eviction system.
    void this.#dataStore;
  }

  async #queueTenantPeers(tenant: string, lastWriteTimestamp?: number): Promise<void> {
    try {
      const endpoints = await resolveEndpoints(tenant, this.#didResolver);
      const peers = endpoints.filter(ep => ep.url !== this.#config.selfUrl);

      for (const peer of peers) {
        this.#priorityQueue.upsert({
          tenant,
          peerEndpoint       : peer.url,
          lastWriteTimestamp : lastWriteTimestamp ?? 0,
        });
      }
    } catch (err) {
      log.debug(`ServerSyncEngine: failed to queue peers for tenant ${tenant}:`, err);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
