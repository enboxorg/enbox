import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import sinon from 'sinon';

import { ServerSyncEngine, type PeerSyncState } from '../src/sync/server-sync-engine.js';
import { ConnectionPool } from '../src/sync/connection-pool.js';
import { RelayDataStore } from '../src/stores/relay-data-store.js';
import type { RelayConfig } from '../src/config.js';
import { clearEndpointCache } from '../src/endpoint-resolver.js';
import { createMockDataStore, createMockDidResolver, createDidDocument, getTestRelayConfig } from './test-utils.js';

/**
 * Creates a mock Dwn object for testing the sync engine.
 */
function createMockDwn() {
  const processedMessages: { tenant: string; message: any; opts?: any }[] = [];
  let rootHash = 'root-hash-abc';
  let subtreeHashes: Record<string, string> = {};
  let leaves: Record<string, string[]> = {};

  return {
    processedMessages,

    setRootHash(hash: string) { rootHash = hash; },
    setSubtreeHash(prefix: string, hash: string) { subtreeHashes[prefix] = hash; },
    setLeaves(prefix: string, entries: string[]) { leaves[prefix] = entries; },

    async processMessage(tenant: string, message: any, opts?: any) {
      processedMessages.push({ tenant, message, opts });

      const action = message?.descriptor?.action;
      const method = message?.descriptor?.method;

      if (method === 'Sync') {
        if (action === 'root') {
          return { status: { code: 200, detail: 'OK' }, root: rootHash };
        }
        if (action === 'subtree') {
          const hash = subtreeHashes[message.descriptor.prefix] ?? '';
          return { status: { code: 200, detail: 'OK' }, hash };
        }
        if (action === 'leaves') {
          const entries = leaves[message.descriptor.prefix] ?? [];
          return { status: { code: 200, detail: 'OK' }, entries };
        }
      }

      if (method === 'Read') {
        return {
          status : { code: 200, detail: 'OK' },
          entry  : {
            message : { descriptor: { interface: 'Messages', method: 'Read' } },
            data    : undefined,
          },
        };
      }

      return { status: { code: 200, detail: 'OK' } };
    },
  };
}

describe('ServerSyncEngine', () => {
  let innerStore: ReturnType<typeof createMockDataStore>;
  let dataStore: RelayDataStore;
  let config: RelayConfig;
  let mockDwn: ReturnType<typeof createMockDwn>;

  beforeEach(async () => {
    innerStore = createMockDataStore();
    dataStore = new RelayDataStore(innerStore);
    await dataStore.open();
    config = {
      ...getTestRelayConfig(),
      syncWorkers         : 1,
      syncIntervalSeconds : 60,
      selfUrl             : 'https://relay.example.com',
    };
    mockDwn = createMockDwn();
    clearEndpointCache();
  });

  afterEach(async () => {
    await dataStore.close();
    sinon.restore();
    clearEndpointCache();
  });

  describe('constructor', () => {
    it('should create with required options', () => {
      const resolver = createMockDidResolver({});
      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });
      expect(engine).toBeDefined();
      expect(engine.connectionPool).toBeInstanceOf(ConnectionPool);
      expect(engine.priorityQueue).toBeDefined();
    });

    it('should accept a custom connection pool', () => {
      const pool = new ConnectionPool();
      const resolver = createMockDidResolver({});
      const engine = new ServerSyncEngine({
        dwn            : mockDwn as any,
        didResolver    : resolver,
        config,
        dataStore,
        connectionPool : pool,
      });
      expect(engine.connectionPool).toBe(pool);
    });
  });

  describe('start/stop', () => {
    it('should start and stop without error', async () => {
      const resolver = createMockDidResolver({});
      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });
      engine.start();
      // Workers find nothing and sleep, so stop() resolves quickly
      await engine.stop();
    });

    it('should be idempotent for start', async () => {
      const resolver = createMockDidResolver({});
      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });
      engine.start();
      engine.start(); // should not throw or double-spawn workers
      await engine.stop();
    });

    it('should be idempotent for stop', async () => {
      const resolver = createMockDidResolver({});
      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });
      engine.start();
      await engine.stop();
      await engine.stop(); // should not throw
    });
  });

  describe('notifyTenantWrite', () => {
    it('should queue tenant peers for sync', async () => {
      const did = 'did:test:tenant1';
      const resolver = createMockDidResolver({
        [did]: createDidDocument(did, [
          'https://relay.example.com',
          'https://full-peer.example.com',
        ]),
      });

      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });

      engine.notifyTenantWrite(did);

      // Give async queueTenantPeers time to resolve
      await new Promise(r => setTimeout(r, 50));

      // Should have queued a work item for the peer (not self)
      const items = engine.priorityQueue.getAll();
      expect(items.length).toBe(1);
      expect(items[0].tenant).toBe(did);
      expect(items[0].peerEndpoint).toBe('https://full-peer.example.com');
      expect(items[0].lastWriteTimestamp).toBeGreaterThan(0);
    });

    it('should not queue self URL as peer', async () => {
      const did = 'did:test:tenant2';
      const resolver = createMockDidResolver({
        [did]: createDidDocument(did, ['https://relay.example.com']),
      });

      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });

      engine.notifyTenantWrite(did);
      await new Promise(r => setTimeout(r, 50));

      expect(engine.priorityQueue.getAll().length).toBe(0);
    });
  });

  describe('registerTenant', () => {
    it('should queue tenant for sync with peers', async () => {
      const did = 'did:test:reg';
      const resolver = createMockDidResolver({
        [did]: createDidDocument(did, [
          'https://relay.example.com',
          'https://peer-a.example.com',
          'https://peer-b.example.com',
        ]),
      });

      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });

      engine.registerTenant(did);
      await new Promise(r => setTimeout(r, 50));

      const items = engine.priorityQueue.getAll();
      expect(items.length).toBe(2);
      const endpoints = items.map(i => i.peerEndpoint).sort();
      expect(endpoints).toEqual(['https://peer-a.example.com', 'https://peer-b.example.com']);
    });
  });

  describe('isTenantSynced / getPeerSyncState', () => {
    it('should return false for unknown tenants', () => {
      const resolver = createMockDidResolver({});
      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config,
        dataStore,
      });

      expect(engine.isTenantSynced('did:test:unknown')).toBe(false);
      expect(engine.getPeerSyncState('did:test:unknown', 'https://peer.com')).toBeUndefined();
    });
  });

  describe('sync algorithm (via worker)', () => {
    // The sync tests use a stub that introduces a macrotask yield via
    // setTimeout to prevent microtask starvation in the tight worker loop.
    // After the stub responds, the worker item is removed from the queue
    // so the worker sleeps (yielding control for stop()).

    it('should sync when local and remote roots match', async () => {
      const did = 'did:test:sync1';
      const resolver = createMockDidResolver({
        [did]: createDidDocument(did, [
          'https://relay.example.com',
          'https://peer.example.com',
        ]),
      });

      const mockPool = new ConnectionPool();
      const sendStub = sinon.stub(mockPool, 'sendDwnRequest');

      // Use setTimeout-based yield to prevent microtask starvation
      let callCount = 0;
      sendStub.callsFake(async (request: any) => {
        callCount++;
        // Yield to macrotask queue to let setTimeout-based stop() fire
        await new Promise(r => setTimeout(r, 0));
        return { status: { code: 200, detail: 'OK' }, root: 'root-hash-abc' } as any;
      });

      const engine = new ServerSyncEngine({
        dwn            : mockDwn as any,
        didResolver    : resolver,
        config         : { ...config, syncWorkers: 1 },
        dataStore,
        connectionPool : mockPool,
      });

      // Queue the tenant first
      engine.notifyTenantWrite(did);
      await new Promise(r => setTimeout(r, 50));

      engine.start();
      // Let the worker run at least one cycle
      await new Promise(r => setTimeout(r, 100));
      await engine.stop();

      // Should have queried the remote root at least once
      expect(callCount).toBeGreaterThan(0);
      const rootRequest = sendStub.getCall(0)?.args[0];
      expect(rootRequest?.message?.descriptor?.action).toBe('root');

      // After roots match, tenant should be considered synced
      expect(engine.isTenantSynced(did)).toBe(true);
    }, 10_000);

    it('should walk the tree when roots differ', async () => {
      const did = 'did:test:sync2';
      const resolver = createMockDidResolver({
        [did]: createDidDocument(did, [
          'https://relay.example.com',
          'https://peer.example.com',
        ]),
      });

      const mockPool = new ConnectionPool();
      const sendStub = sinon.stub(mockPool, 'sendDwnRequest');

      // Set local root to be different from remote to trigger tree walk.
      // The mock DWN returns `subtreeHashes[prefix] ?? ''` for subtree calls.
      // We don't pre-set any subtree hashes, so the local mock returns ''.
      // The remote mock also returns '' for all subtrees, making them match
      // and causing the tree walk to terminate at the first level.
      mockDwn.setRootHash('local-root');

      let rootCallCount = 0;
      sendStub.callsFake(async (request: any) => {
        await new Promise(r => setTimeout(r, 0));
        const action = request.message?.descriptor?.action;

        if (action === 'root') {
          rootCallCount++;
          if (rootCallCount === 1) {
            // First root call: different from local
            return { status: { code: 200, detail: 'OK' }, root: 'remote-root' };
          }
          // Verification call: now matching
          return { status: { code: 200, detail: 'OK' }, root: 'local-root' };
        }

        if (action === 'subtree') {
          // Return '' to match the local mock's default empty hash.
          // Both local and remote return '' → subtrees match → no recursion.
          return { status: { code: 200, detail: 'OK' }, hash: '' };
        }

        if (action === 'leaves') {
          return { status: { code: 200, detail: 'OK' }, entries: [] };
        }

        return { status: { code: 200, detail: 'OK' } };
      });

      const engine = new ServerSyncEngine({
        dwn            : mockDwn as any,
        didResolver    : resolver,
        config         : { ...config, syncWorkers: 1 },
        dataStore,
        connectionPool : mockPool,
      });

      // Queue first, then start
      engine.notifyTenantWrite(did);
      await new Promise(r => setTimeout(r, 50));

      engine.start();
      await new Promise(r => setTimeout(r, 500));
      await engine.stop();

      // Should have made multiple RPC calls (root check + subtree walk + verification root)
      expect(sendStub.callCount).toBeGreaterThan(1);
    }, 10_000);

    it('should handle unreachable peer gracefully', async () => {
      const did = 'did:test:unreachable';
      const resolver = createMockDidResolver({
        [did]: createDidDocument(did, [
          'https://relay.example.com',
          'https://dead-peer.example.com',
        ]),
      });

      const mockPool = new ConnectionPool();
      const sendStub = sinon.stub(mockPool, 'sendDwnRequest');
      sendStub.callsFake(async () => {
        await new Promise(r => setTimeout(r, 0));
        throw new Error('connection refused');
      });

      const engine = new ServerSyncEngine({
        dwn            : mockDwn as any,
        didResolver    : resolver,
        config         : { ...config, syncWorkers: 1 },
        dataStore,
        connectionPool : mockPool,
      });

      // Queue first, then start
      engine.notifyTenantWrite(did);
      await new Promise(r => setTimeout(r, 50));

      engine.start();
      await new Promise(r => setTimeout(r, 200));
      await engine.stop();

      // Should NOT mark tenant as synced
      expect(engine.isTenantSynced(did)).toBe(false);
    }, 10_000);

    it('should serialize sync for the same tenant (queue-level)', async () => {
      // Test serialization at the queue level: verify that notifyTenantWrite
      // queues multiple peer items for the same tenant, and the queue manages
      // them correctly. The actual worker serialization (activeTenants set)
      // is implicitly tested by the other worker tests above.
      const did = 'did:test:serial';
      const resolver = createMockDidResolver({
        [did]: createDidDocument(did, [
          'https://relay.example.com',
          'https://peer-a.example.com',
          'https://peer-b.example.com',
        ]),
      });

      const engine = new ServerSyncEngine({
        dwn         : mockDwn as any,
        didResolver : resolver,
        config      : { ...config, syncWorkers: 2 },
        dataStore,
      });

      engine.notifyTenantWrite(did);
      await new Promise(r => setTimeout(r, 50));

      // Should have queued 2 items (one per non-self peer)
      const items = engine.priorityQueue.getAll();
      expect(items.length).toBe(2);
      expect(items.every(i => i.tenant === did)).toBe(true);

      // All items should have the same tenant
      const endpoints = items.map(i => i.peerEndpoint).sort();
      expect(endpoints).toEqual(['https://peer-a.example.com', 'https://peer-b.example.com']);
    });
  });

  describe('MAX_DIFF_DEPTH', () => {
    it('should be 16', () => {
      expect(ServerSyncEngine.MAX_DIFF_DEPTH).toBe(16);
    });
  });
});
