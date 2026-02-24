/**
 * Integration tests for the dwn-relay package.
 *
 * These tests spin up real DwnServer instances (relay + peer) backed by
 * in-memory SQLite stores and verify the end-to-end flows:
 *
 * 1. Write → relay stores data locally
 * 2. Read cache-miss → relay proxies to peer DWN
 * 3. Eviction → evicted data is re-fetched from peer on read
 * 4. Sync notification → writes trigger sync engine queuing
 */
import type { DwnServerConfig } from '@enbox/dwn-server';
import type { Persona } from '@enbox/dwn-sdk-js';
import type { RelayConfig } from '../src/config.js';
import type { JsonRpcResponse, JsonRpcSuccessResponse } from '@enbox/dwn-clients';

import sinon from 'sinon';

import { ConnectionPool } from '../src/sync/connection-pool.js';
import { createJsonRpcRequest } from '@enbox/dwn-clients';
import { MetadataStore } from '../src/stores/metadata-store.js';
import { RelayDataStore } from '../src/stores/relay-data-store.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createBunSqliteDatabase, DataStoreSql, MessageStoreSql, ResumableTaskStoreSql, SqliteDialect, StateIndexSql } from '@enbox/dwn-sql-store';
import { defaultDwnServerConfig, DwnServer } from '@enbox/dwn-server';
import { DidDht, DidKey, UniversalResolver } from '@enbox/dids';
import {
  Dwn,
  EventEmitterEventLog,
  Jws,
  ProtocolsConfigure,
  RecordsRead,
  RecordsWrite,
  TestDataGenerator,
} from '@enbox/dwn-sdk-js';

// ─── Helpers ──────────────────────────────────────────────────────────

const TEST_PROTOCOL = 'http://integration-test.xyz';

const protocolDefinition = {
  protocol  : TEST_PROTOCOL,
  published : true,
  types     : { record: {} },
  structure : { record: {} },
};

/** Create an in-memory SQLite dialect. */
function createInMemorySqliteDialect(): SqliteDialect {
  return new SqliteDialect({
    database: async () => createBunSqliteDatabase(':memory:'),
  });
}

/** Create an in-memory DWN with SQL stores (same pattern as dwn-server tests). */
async function createInMemoryDwn(): Promise<Dwn> {
  const dialect = createInMemorySqliteDialect();

  return Dwn.create({
    stateIndex         : new StateIndexSql(dialect),
    dataStore          : new DataStoreSql(dialect),
    messageStore       : new MessageStoreSql(dialect),
    resumableTaskStore : new ResumableTaskStoreSql(dialect),
    eventLog           : new EventEmitterEventLog(),
    didResolver        : new UniversalResolver({ didResolvers: [DidDht, DidKey] }),
  });
}

/** Start a DwnServer with an injected Dwn on a random port. Returns { server, baseUrl }. */
async function startServer(dwn: Dwn, configOverrides: Partial<DwnServerConfig> = {}): Promise<{
  server: DwnServer;
  baseUrl: string;
}> {
  const config: DwnServerConfig = {
    ...defaultDwnServerConfig,
    port                           : 0,
    logLevel                       : 'SILENT',
    webSocketSupport               : false,
    registrationStoreUrl           : '',
    registrationProofOfWorkEnabled : false,
    ...configOverrides,
  } as DwnServerConfig;

  const server = new DwnServer({ config, dwn });
  await server.start();

  const port = server.httpServer.port;
  return { server, baseUrl: `http://localhost:${port}` };
}

/** Install the test protocol for a persona on a given DWN instance. */
async function installProtocol(dwn: Dwn, persona: Persona): Promise<void> {
  const signer = Jws.createSigner(persona);
  const protocolsConfigure = await ProtocolsConfigure.create({
    signer,
    definition: protocolDefinition,
  });
  const result = await dwn.processMessage(persona.did, protocolsConfigure.message);
  if (result.status.code !== 202) {
    throw new Error(`Failed to install protocol: ${result.status.code} ${result.status.detail}`);
  }
}

/** Write a record to a DWN server via HTTP. Returns the RecordsWrite message and data. */
async function writeRecord(
  baseUrl: string,
  persona: Persona,
  data: Uint8Array,
): Promise<{ recordsWrite: RecordsWrite; dataBytes: Uint8Array }> {
  const signer = Jws.createSigner(persona);
  const recordsWrite = await RecordsWrite.create({
    signer,
    dataFormat   : 'application/octet-stream',
    protocol     : TEST_PROTOCOL,
    protocolPath : 'record',
    data,
  });

  const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
    target  : persona.did,
    message : recordsWrite.message,
  });

  const response = await fetch(baseUrl, {
    method  : 'POST',
    headers : { 'dwn-request': JSON.stringify(dwnRequest) },
    body    : new Blob([data]),
  });

  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) {
    throw new Error(`Write failed: ${body.error.message}`);
  }
  expect((body as JsonRpcSuccessResponse).result.reply.status.code).toBe(202);

  return { recordsWrite, dataBytes: data };
}

/** Read a record from a DWN server via HTTP. Returns { status, dataBytes? }. */
async function readRecord(
  baseUrl: string,
  persona: Persona,
  recordId: string,
): Promise<{ statusCode: number; dataBytes?: Uint8Array }> {
  const signer = Jws.createSigner(persona);
  const recordsRead = await RecordsRead.create({
    signer,
    filter: { recordId },
  });

  const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
    target  : persona.did,
    message : recordsRead.message,
  });

  const response = await fetch(baseUrl, {
    method  : 'POST',
    headers : { 'dwn-request': JSON.stringify(dwnRequest) },
  });

  // RecordsRead returns metadata in dwn-response header, data in body
  const dwnResponseHeader = response.headers.get('dwn-response');
  if (dwnResponseHeader) {
    const jsonRpc = JSON.parse(dwnResponseHeader) as JsonRpcSuccessResponse;
    const statusCode = jsonRpc.result.reply.status.code;
    if (statusCode === 200 && response.body) {
      const dataBytes = new Uint8Array(await response.arrayBuffer());
      return { statusCode, dataBytes };
    }
    return { statusCode };
  }

  // Non-read responses come in the body
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) {
    return { statusCode: 500 };
  }
  return { statusCode: (body as JsonRpcSuccessResponse).result.reply.status.code };
}

/** Create a RelayConfig for testing. */
function testRelayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    dataRetention           : '72h',
    storageMaxBytes         : 100_000,
    ipfsGatewayUrl          : undefined,
    syncWorkers             : 1,
    syncIntervalSeconds     : 999, // don't auto-sync during tests
    protocolPolicies        : {},
    evictionIntervalSeconds : 999, // don't auto-evict during tests
    evictionHighWaterMark   : 0.9,
    evictionLowWaterMark    : 0.7,
    readProxyTimeoutMs      : 5_000,
    readProxyCacheLocally   : true,
    selfUrl                 : 'http://relay.test',
    ...overrides,
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────

describe('Integration Tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  // ────────────────────────────────────────────────────────────────────
  // Test 1: Write and read back via a single DWN server
  // ────────────────────────────────────────────────────────────────────
  describe('basic write and read', () => {
    let dwn: Dwn;
    let server: DwnServer;
    let baseUrl: string;
    let alice: Persona;

    beforeAll(async () => {
      dwn = await createInMemoryDwn();
      ({ server, baseUrl } = await startServer(dwn));
      alice = await TestDataGenerator.generateDidKeyPersona();
      await installProtocol(dwn, alice);
    });

    afterAll(async () => {
      await server.stop();
    });

    it('writes a record and reads it back via HTTP', async () => {
      const data = new TextEncoder().encode('Hello, DWN relay!');
      const { recordsWrite } = await writeRecord(baseUrl, alice, data);
      const recordId = recordsWrite.message.recordId;

      const result = await readRecord(baseUrl, alice, recordId);
      expect(result.statusCode).toBe(200);
      expect(result.dataBytes).toBeDefined();
      expect(new TextDecoder().decode(result.dataBytes!)).toBe('Hello, DWN relay!');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Test 2: RelayDataStore wrapping — verify metadata tracking
  // ────────────────────────────────────────────────────────────────────
  describe('RelayDataStore tracking on write', () => {
    let dwn: Dwn;
    let server: DwnServer;
    let baseUrl: string;
    let relayDataStore: RelayDataStore;
    let alice: Persona;

    beforeAll(async () => {
      const dialect = createInMemorySqliteDialect();
      const innerDataStore = new DataStoreSql(dialect);
      relayDataStore = new RelayDataStore(innerDataStore);

      dwn = await Dwn.create({
        stateIndex         : new StateIndexSql(dialect),
        dataStore          : relayDataStore,
        messageStore       : new MessageStoreSql(dialect),
        resumableTaskStore : new ResumableTaskStoreSql(dialect),
        eventLog           : new EventEmitterEventLog(),
        didResolver        : new UniversalResolver({ didResolvers: [DidDht, DidKey] }),
      });

      ({ server, baseUrl } = await startServer(dwn));
      alice = await TestDataGenerator.generateDidKeyPersona();
      await installProtocol(dwn, alice);
    });

    afterAll(async () => {
      await server.stop();
    });

    it('tracks storage bytes after a write via HTTP', async () => {
      const before = relayDataStore.getTotalStorageBytes();
      // Data must be >30KB to go through DataStore.put() — smaller records
      // are stored inline as encodedData in the MessageStore.
      const data = new Uint8Array(50_000).fill(42);
      await writeRecord(baseUrl, alice, data);

      // RelayDataStore should have tracked the new entry
      expect(relayDataStore.getTotalStorageBytes()).toBeGreaterThan(before);
      expect(relayDataStore.getEntryCount()).toBeGreaterThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Test 3: Read proxy — relay proxies to peer on cache miss
  // ────────────────────────────────────────────────────────────────────
  describe('read proxy on cache miss', () => {
    let peerDwn: Dwn;
    let peerServer: DwnServer;
    let peerBaseUrl: string;

    let relayDwn: Dwn;
    let relayServer: DwnServer;
    let relayBaseUrl: string;
    let relayDataStore: RelayDataStore;

    let alice: Persona;

    beforeAll(async () => {
      // --- Peer (full node) ---
      peerDwn = await createInMemoryDwn();
      ({ server: peerServer, baseUrl: peerBaseUrl } = await startServer(peerDwn));

      // --- Relay node ---
      const dialect = createInMemorySqliteDialect();
      const innerDataStore = new DataStoreSql(dialect);
      relayDataStore = new RelayDataStore(innerDataStore);

      const didResolver = new UniversalResolver({ didResolvers: [DidDht, DidKey] });

      relayDwn = await Dwn.create({
        stateIndex         : new StateIndexSql(dialect),
        dataStore          : relayDataStore,
        messageStore       : new MessageStoreSql(dialect),
        resumableTaskStore : new ResumableTaskStoreSql(dialect),
        eventLog           : new EventEmitterEventLog(),
        didResolver,
      });

      ({ server: relayServer, baseUrl: relayBaseUrl } = await startServer(relayDwn));

      // Configure read proxy — the relay will proxy to the peer
      const connectionPool = new ConnectionPool();
      const config = testRelayConfig({ selfUrl: relayBaseUrl });

      // Override the DID resolver to return the peer's URL for any DID
      const mockResolver = {
        async resolve(didUri: string): Promise<{ didResolutionMetadata: object; didDocument: object; didDocumentMetadata: object }> {
          return {
            didResolutionMetadata : {},
            didDocument           : {
              id      : didUri,
              service : [{
                id              : `${didUri}#dwn`,
                type            : 'DecentralizedWebNode',
                serviceEndpoint : [peerBaseUrl],
              }],
            },
            didDocumentMetadata: {},
          };
        },
      };

      relayDataStore.setProxy({
        didResolver : mockResolver as any,
        rpcClient   : connectionPool,
        config,
      });

      alice = await TestDataGenerator.generateDidKeyPersona();

      // Install protocol on BOTH the peer and relay
      await installProtocol(peerDwn, alice);
      await installProtocol(relayDwn, alice);
    });

    afterAll(async () => {
      await relayServer.stop();
      await peerServer.stop();
    });

    it('proxies a read from the peer when data is not in local cache', async () => {
      // Use >30KB data so it goes through DataStore (not inline encodedData)
      const data = new Uint8Array(50_000);
      crypto.getRandomValues(data);

      // Write the SAME record to both peer and relay.
      // We need the message envelope in the relay's MessageStore so RecordsRead
      // can find it, but we'll evict the data from the relay's DataStore.
      const signer = Jws.createSigner(alice);
      const recordsWrite = await RecordsWrite.create({
        signer,
        dataFormat   : 'application/octet-stream',
        protocol     : TEST_PROTOCOL,
        protocolPath : 'record',
        published    : true,
        data,
      });
      const recordId = recordsWrite.message.recordId;

      // Write to peer via HTTP
      const peerRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        target  : alice.did,
        message : recordsWrite.message,
      });
      const peerResp = await fetch(peerBaseUrl, {
        method  : 'POST',
        headers : { 'dwn-request': JSON.stringify(peerRequest) },
        body    : new Blob([data]),
      });
      expect(((await peerResp.json()) as JsonRpcSuccessResponse).result.reply.status.code).toBe(202);

      // Write to relay via HTTP (same message — so MessageStore has the envelope)
      const relayRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        target  : alice.did,
        message : recordsWrite.message,
      });
      const relayResp = await fetch(relayBaseUrl, {
        method  : 'POST',
        headers : { 'dwn-request': JSON.stringify(relayRequest) },
        body    : new Blob([data]),
      });
      expect(((await relayResp.json()) as JsonRpcSuccessResponse).result.reply.status.code).toBe(202);

      // Evict the data from the relay's DataStore (message envelope stays)
      const candidates = relayDataStore.getEvictionCandidates(0);
      for (const c of candidates) {
        await relayDataStore.evict(c.tenant, c.recordId, c.dataCid);
      }
      expect(relayDataStore.getTotalStorageBytes()).toBe(0);

      // Now reading from relay should trigger proxy to peer
      const result = await readRecord(relayBaseUrl, alice, recordId);
      expect(result.statusCode).toBe(200);
      expect(result.dataBytes).toBeDefined();
      expect(result.dataBytes!.length).toBe(50_000);
      expect(result.dataBytes).toEqual(data);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Test 4: Eviction — verify data can be evicted and bytes are freed
  // ────────────────────────────────────────────────────────────────────
  describe('eviction frees storage', () => {
    let dwn: Dwn;
    let server: DwnServer;
    let baseUrl: string;
    let relayDataStore: RelayDataStore;
    let alice: Persona;

    beforeAll(async () => {
      const dialect = createInMemorySqliteDialect();
      const innerDataStore = new DataStoreSql(dialect);
      relayDataStore = new RelayDataStore(innerDataStore);

      dwn = await Dwn.create({
        stateIndex         : new StateIndexSql(dialect),
        dataStore          : relayDataStore,
        messageStore       : new MessageStoreSql(dialect),
        resumableTaskStore : new ResumableTaskStoreSql(dialect),
        eventLog           : new EventEmitterEventLog(),
        didResolver        : new UniversalResolver({ didResolvers: [DidDht, DidKey] }),
      });

      ({ server, baseUrl } = await startServer(dwn));
      alice = await TestDataGenerator.generateDidKeyPersona();
      await installProtocol(dwn, alice);
    });

    afterAll(async () => {
      await server.stop();
    });

    it('evicts data and frees tracked bytes', async () => {
      // Write a large record (>30KB so it goes through DataStore, not encodedData)
      const data = new Uint8Array(50_000).fill(0xAB);
      await writeRecord(baseUrl, alice, data);

      const bytesAfterWrite = relayDataStore.getTotalStorageBytes();
      expect(bytesAfterWrite).toBeGreaterThan(0);

      // Mark all as synced so they become eviction candidates
      relayDataStore.markTenantSynced(alice.did);

      // Evict
      const candidates = relayDataStore.getEvictionCandidates(0);
      expect(candidates.length).toBeGreaterThan(0);

      let freedTotal = 0;
      for (const c of candidates) {
        freedTotal += await relayDataStore.evict(c.tenant, c.recordId, c.dataCid);
      }

      expect(freedTotal).toBeGreaterThan(0);
      expect(relayDataStore.getTotalStorageBytes()).toBeLessThan(bytesAfterWrite);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Test 5: Persistent metadata survives re-creation
  // ────────────────────────────────────────────────────────────────────
  describe('metadata persistence', () => {
    const tmpDbPath = `/tmp/relay-test-metadata-${Date.now()}.db`;

    afterAll(async () => {
      // Clean up temp file
      try { const fs = require('node:fs'); fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
    });

    it('persists metadata across MetadataStore re-creation', async () => {
      // Create and populate a MetadataStore
      const store1 = new MetadataStore(tmpDbPath);
      store1.open();
      store1.put({
        tenant   : 'did:test:alice',
        recordId : 'rec-1',
        dataCid  : 'cid-1',
        dataSize : 1234,
        storedAt : Date.now(),
        synced   : false,
      });
      store1.put({
        tenant   : 'did:test:alice',
        recordId : 'rec-2',
        dataCid  : 'cid-2',
        dataSize : 5678,
        storedAt : Date.now(),
        synced   : true,
      });
      store1.close();

      // Re-open and verify
      const store2 = new MetadataStore(tmpDbPath);
      store2.open();
      const entries = store2.getAll();
      expect(entries.length).toBe(2);
      expect(entries.find(e => e.recordId === 'rec-1')?.dataSize).toBe(1234);
      expect(entries.find(e => e.recordId === 'rec-2')?.synced).toBe(true);
      store2.close();
    });

    it('seeds RelayDataStore from persistent metadata on open', async () => {
      const dbPath = `/tmp/relay-test-seed-${Date.now()}.db`;

      try {
        // Populate persistent store
        const metaStore = new MetadataStore(dbPath);
        metaStore.open();
        metaStore.put({
          tenant   : 'did:test:bob',
          recordId : 'rec-A',
          dataCid  : 'cid-A',
          dataSize : 2048,
          storedAt : Date.now(),
          synced   : false,
        });
        metaStore.close();

        // Create RelayDataStore with the persistent metadata
        const dialect = createInMemorySqliteDialect();
        const innerDataStore = new DataStoreSql(dialect);

        const metaStore2 = new MetadataStore(dbPath);
        const relayStore = new RelayDataStore(innerDataStore, metaStore2);
        await relayStore.open();

        // Should have seeded from persistent store
        expect(relayStore.getTotalStorageBytes()).toBe(2048);
        expect(relayStore.getEntryCount()).toBe(1);
        expect(relayStore.getTenantStorageBytes('did:test:bob')).toBe(2048);

        await relayStore.close();
      } finally {
        try { const fs = require('node:fs'); fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Test 6: Large data (>30KB) goes through DataStore, not encodedData
  // ────────────────────────────────────────────────────────────────────
  describe('large record data via DataStore', () => {
    let dwn: Dwn;
    let server: DwnServer;
    let baseUrl: string;
    let relayDataStore: RelayDataStore;
    let alice: Persona;

    beforeAll(async () => {
      const dialect = createInMemorySqliteDialect();
      const innerDataStore = new DataStoreSql(dialect);
      relayDataStore = new RelayDataStore(innerDataStore);

      dwn = await Dwn.create({
        stateIndex         : new StateIndexSql(dialect),
        dataStore          : relayDataStore,
        messageStore       : new MessageStoreSql(dialect),
        resumableTaskStore : new ResumableTaskStoreSql(dialect),
        eventLog           : new EventEmitterEventLog(),
        didResolver        : new UniversalResolver({ didResolvers: [DidDht, DidKey] }),
      });

      ({ server, baseUrl } = await startServer(dwn));
      alice = await TestDataGenerator.generateDidKeyPersona();
      await installProtocol(dwn, alice);
    });

    afterAll(async () => {
      await server.stop();
    });

    it('stores and retrieves data larger than 30KB (encodedData threshold)', async () => {
      // Records <= ~30KB are stored inline in the MessageStore as encodedData.
      // Records > 30KB must go through DataStore. This verifies the relay's
      // RelayDataStore.put() is actually called for large data.
      const largeData = new Uint8Array(50_000); // 50 KB
      crypto.getRandomValues(largeData);

      const bytesBefore = relayDataStore.getTotalStorageBytes();
      const { recordsWrite } = await writeRecord(baseUrl, alice, largeData);
      const recordId = recordsWrite.message.recordId;

      // DataStore.put() should have been called (data > encodedData threshold)
      expect(relayDataStore.getTotalStorageBytes()).toBeGreaterThan(bytesBefore);

      // Read it back
      const result = await readRecord(baseUrl, alice, recordId);
      expect(result.statusCode).toBe(200);
      expect(result.dataBytes).toBeDefined();
      expect(result.dataBytes!.length).toBe(50_000);

      // Verify content integrity
      expect(result.dataBytes).toEqual(largeData);
    });
  });
});
