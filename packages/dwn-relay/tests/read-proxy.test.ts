import { afterEach, describe, expect, it } from 'bun:test';
import { Cid, DataStream } from '@enbox/dwn-sdk-js';

import { clearEndpointCache } from '../src/endpoint-resolver.js';
import { IpfsResolver } from '../src/proxy/ipfs-resolver.js';
import { ReadProxy } from '../src/proxy/read-proxy.js';
import {
  createDidDocument, createMockDataStore, createMockDidResolver,
  createMockRpcClient, getTestRelayConfig, randomBytes,
} from './test-utils.js';

describe('ReadProxy', () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    clearEndpointCache();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  function createProxy(options: {
    ipfsGateway?: string;
    endpoints?: (string | Record<string, unknown>)[];
  } = {}): { proxy: ReadProxy; rpcClient: ReturnType<typeof createMockRpcClient>; mockDataStore: ReturnType<typeof createMockDataStore> } {
    const mockDataStore = createMockDataStore();
    const rpcClient = createMockRpcClient();
    const config = {
      ...getTestRelayConfig(),
      ipfsGatewayUrl        : options.ipfsGateway,
      readProxyCacheLocally : true,
      selfUrl               : 'https://relay.example.com',
    };

    const endpoints = options.endpoints ?? [
      'https://full-peer.example.com',
      { url: 'https://relay.example.com', dataRetention: 'cache' },
    ];

    const resolver = createMockDidResolver({
      'did:test:tenant': createDidDocument('did:test:tenant', endpoints),
    });

    let ipfsResolver: IpfsResolver | undefined;
    if (options.ipfsGateway) {
      ipfsResolver = new IpfsResolver(options.ipfsGateway, 5_000);
    }

    const proxy = new ReadProxy({
      dataStore   : mockDataStore,
      didResolver : resolver,
      rpcClient,
      ipfsResolver,
      config,
    });

    return { proxy, rpcClient, mockDataStore };
  }

  describe('peer proxy path', () => {
    it('should resolve data from a full peer endpoint', async () => {
      const testData = randomBytes(100);
      const dataCid = await Cid.computeDagPbCidFromBytes(testData);

      const { proxy, rpcClient } = createProxy();
      rpcClient.pushResponse({
        status : { code: 200, detail: 'OK' },
        entry  : {
          data         : DataStream.fromBytes(testData),
          recordsWrite : {},
        },
      } as any);

      const message = { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } };
      const result = await proxy.resolveData({
        tenant          : 'did:test:tenant',
        recordId        : 'rec1',
        dataCid,
        dataSize        : 100,
        published       : false,
        originalMessage : message as any,
      });

      expect(result).toBeDefined();
      expect(result!.dataSize).toBe(100);
    });

    it('should prefer full endpoints over cache endpoints', async () => {
      const testData = randomBytes(50);
      const dataCid = await Cid.computeDagPbCidFromBytes(testData);

      const { proxy, rpcClient } = createProxy({
        endpoints: [
          { url: 'https://cache-peer.example.com', dataRetention: 'cache' },
          'https://full-peer.example.com',
        ],
      });

      rpcClient.pushResponse({
        status : { code: 200, detail: 'OK' },
        entry  : { data: DataStream.fromBytes(testData), recordsWrite: {} },
      } as any);

      const result = await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1', dataCid, dataSize        : 50,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      expect(result).toBeDefined();
      // First request should be to full peer
      expect(rpcClient.requests[0].dwnUrl).toBe('https://full-peer.example.com');
    });

    it('should return undefined when no peer has the data', async () => {
      const { proxy, rpcClient } = createProxy();
      rpcClient.pushResponse({ status: { code: 404, detail: 'Not Found' } });

      const result = await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1',
        dataCid         : 'some-cid', dataSize        : 100,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      expect(result).toBeUndefined();
    });

    it('should try next peer on failure', async () => {
      const testData = randomBytes(50);
      const dataCid = await Cid.computeDagPbCidFromBytes(testData);

      const { proxy, rpcClient } = createProxy({
        endpoints: ['https://peer1.example.com', 'https://peer2.example.com'],
      });

      // First peer fails
      rpcClient.pushResponse({ status: { code: 500, detail: 'Error' } });
      // Second peer succeeds
      rpcClient.pushResponse({
        status : { code: 200, detail: 'OK' },
        entry  : { data: DataStream.fromBytes(testData), recordsWrite: {} },
      } as any);

      const result = await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1', dataCid, dataSize        : 50,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      expect(result).toBeDefined();
      expect(rpcClient.requests).toHaveLength(2);
    });

    it('should reject data with CID mismatch from peer', async () => {
      const goodData = randomBytes(50);
      const badData = randomBytes(50);
      const goodCid = await Cid.computeDagPbCidFromBytes(goodData);

      const { proxy, rpcClient } = createProxy({
        endpoints: ['https://peer.example.com'],
      });

      // Peer returns wrong data
      rpcClient.pushResponse({
        status : { code: 200, detail: 'OK' },
        entry  : { data: DataStream.fromBytes(badData), recordsWrite: {} },
      } as any);

      const result = await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1', dataCid         : goodCid, dataSize        : 50,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      expect(result).toBeUndefined();
    });
  });

  describe('IPFS path', () => {
    it('should try IPFS first for published records when configured', async () => {
      originalFetch = globalThis.fetch;

      const testData = randomBytes(30);
      const dataCid = await Cid.computeDagPbCidFromBytes(testData);

      globalThis.fetch = (async () => {
        return new Response(testData, { status: 200 });
      }) as any;

      const { proxy, rpcClient } = createProxy({ ipfsGateway: 'http://localhost:8080' });

      const result = await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1', dataCid, dataSize        : 30,
        published       : true,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      expect(result).toBeDefined();
      expect(result!.dataSize).toBe(30);
      // Should NOT have fallen through to peer proxy
      expect(rpcClient.requests).toHaveLength(0);
    });

    it('should skip IPFS for non-published records', async () => {
      originalFetch = globalThis.fetch;

      let ipfsCalled = false;
      globalThis.fetch = (async () => {
        ipfsCalled = true;
        return new Response(null, { status: 200 });
      }) as any;

      const { proxy, rpcClient } = createProxy({ ipfsGateway: 'http://localhost:8080' });
      rpcClient.pushResponse({ status: { code: 404, detail: 'Not Found' } });

      await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1',
        dataCid         : 'some-cid', dataSize        : 100,
        published       : false,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      expect(ipfsCalled).toBe(false);
    });

    it('should fall through to peer proxy when IPFS fails', async () => {
      originalFetch = globalThis.fetch;

      const testData = randomBytes(30);
      const dataCid = await Cid.computeDagPbCidFromBytes(testData);

      globalThis.fetch = (async () => {
        return new Response(null, { status: 404 });
      }) as any;

      const { proxy, rpcClient } = createProxy({
        ipfsGateway : 'http://localhost:8080',
        endpoints   : ['https://full-peer.example.com'],
      });

      rpcClient.pushResponse({
        status : { code: 200, detail: 'OK' },
        entry  : { data: DataStream.fromBytes(testData), recordsWrite: {} },
      } as any);

      const result = await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1', dataCid, dataSize        : 30,
        published       : true,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      expect(result).toBeDefined();
      expect(rpcClient.requests).toHaveLength(1); // fell through to peer
    });
  });

  describe('re-caching', () => {
    it('should store fetched data locally when readProxyCacheLocally is true', async () => {
      const testData = randomBytes(100);
      const dataCid = await Cid.computeDagPbCidFromBytes(testData);

      const { proxy, rpcClient, mockDataStore } = createProxy();
      rpcClient.pushResponse({
        status : { code: 200, detail: 'OK' },
        entry  : { data: DataStream.fromBytes(testData), recordsWrite: {} },
      } as any);

      await proxy.resolveData({
        tenant          : 'did:test:tenant', recordId        : 'rec1', dataCid, dataSize        : 100,
        originalMessage : { descriptor: { interface: 'Records', method: 'Read', messageTimestamp: '' } } as any,
      });

      // Data should be stored in the mock data store
      const key = 'did:test:tenant|rec1|' + dataCid;
      expect(mockDataStore.storage.has(key)).toBe(true);
    });
  });
});
