import { afterEach, describe, expect, it } from 'bun:test';

import { clearEndpointCache, extractDwnEndpoints, resolveEndpoints } from '../src/endpoint-resolver.js';
import { createDidDocument, createMockDidResolver } from './test-utils.js';

describe('extractDwnEndpoints', () => {
  it('should extract bare string endpoint as full node', () => {
    const doc = createDidDocument('did:test:1', ['https://dwn.example.com']);
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(1);
    expect(eps[0].url).toBe('https://dwn.example.com');
    expect(eps[0].isFull).toBe(true);
  });

  it('should strip trailing slashes from URLs', () => {
    const doc = createDidDocument('did:test:1', ['https://dwn.example.com///']);
    const eps = extractDwnEndpoints(doc);
    expect(eps[0].url).toBe('https://dwn.example.com');
  });

  it('should extract map endpoint with dataRetention: cache', () => {
    const doc = createDidDocument('did:test:1', [
      { url: 'https://relay.example.com', dataRetention: 'cache' },
    ]);
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(1);
    expect(eps[0].url).toBe('https://relay.example.com');
    expect(eps[0].isFull).toBe(false);
  });

  it('should treat map without dataRetention as full node', () => {
    const doc = createDidDocument('did:test:1', [
      { url: 'https://full.example.com' },
    ]);
    const eps = extractDwnEndpoints(doc);
    expect(eps[0].isFull).toBe(true);
  });

  it('should handle mixed array of strings and maps', () => {
    const doc = createDidDocument('did:test:1', [
      'https://home-nas.example.com',
      { url: 'https://relay.example.com', dataRetention: 'cache' },
      { url: 'https://backup.example.com' },
    ]);
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(3);
    expect(eps[0]).toEqual({ url: 'https://home-nas.example.com', isFull: true });
    expect(eps[1]).toEqual({ url: 'https://relay.example.com', isFull: false });
    expect(eps[2]).toEqual({ url: 'https://backup.example.com', isFull: true });
  });

  it('should handle single string serviceEndpoint (not array)', () => {
    const doc = {
      id      : 'did:test:1',
      service : [{
        id              : '#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://single.example.com',
      }],
    } as any;
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(1);
    expect(eps[0].url).toBe('https://single.example.com');
  });

  it('should handle single map serviceEndpoint (not array)', () => {
    const doc = {
      id      : 'did:test:1',
      service : [{
        id              : '#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : { url: 'https://map.example.com', dataRetention: 'cache' },
      }],
    } as any;
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(1);
    expect(eps[0].isFull).toBe(false);
  });

  it('should handle legacy nodes array format', () => {
    const doc = {
      id      : 'did:test:1',
      service : [{
        id              : '#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : { nodes: ['https://node1.example.com', 'https://node2.example.com'] },
      }],
    } as any;
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(2);
    expect(eps[0].isFull).toBe(true);
    expect(eps[1].isFull).toBe(true);
  });

  it('should skip non-DWN services', () => {
    const doc = {
      id      : 'did:test:1',
      service : [
        { id: '#messaging', type: 'DIDCommMessaging', serviceEndpoint: 'https://msg.example.com' },
        { id: '#dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] },
      ],
    } as any;
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(1);
    expect(eps[0].url).toBe('https://dwn.example.com');
  });

  it('should return empty array for document without service', () => {
    const doc = { id: 'did:test:1' } as any;
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(0);
  });

  it('should return empty array for document with empty service array', () => {
    const doc = { id: 'did:test:1', service: [] } as any;
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(0);
  });

  it('should skip array entries that are neither string nor valid map', () => {
    const doc = createDidDocument('did:test:1', [
      'https://valid.example.com',
      42 as any,
      null as any,
      { notUrl: 'missing url property' },
    ]);
    const eps = extractDwnEndpoints(doc);
    expect(eps).toHaveLength(1);
    expect(eps[0].url).toBe('https://valid.example.com');
  });
});

describe('resolveEndpoints', () => {
  afterEach(() => {
    clearEndpointCache();
  });

  it('should resolve endpoints for a DID', async () => {
    const resolver = createMockDidResolver({
      'did:test:alice': createDidDocument('did:test:alice', [
        'https://alice-dwn.example.com',
        { url: 'https://relay.example.com', dataRetention: 'cache' },
      ]),
    });

    const eps = await resolveEndpoints('did:test:alice', resolver);
    expect(eps).toHaveLength(2);
    expect(eps[0].isFull).toBe(true);
    expect(eps[1].isFull).toBe(false);
  });

  it('should return empty array for unknown DID', async () => {
    const resolver = createMockDidResolver({});
    const eps = await resolveEndpoints('did:test:unknown', resolver);
    expect(eps).toHaveLength(0);
  });

  it('should cache resolved endpoints', async () => {
    let resolveCount = 0;
    const resolver = {
      async resolve(didUri: string): Promise<{
        didResolutionMetadata: object;
        didDocument: ReturnType<typeof createDidDocument>;
        didDocumentMetadata: object;
      }> {
        resolveCount++;
        return {
          didResolutionMetadata : {},
          didDocument           : createDidDocument(didUri, ['https://cached.example.com']),
          didDocumentMetadata   : {},
        };
      },
    };

    await resolveEndpoints('did:test:cached', resolver);
    await resolveEndpoints('did:test:cached', resolver);
    expect(resolveCount).toBe(1); // only resolved once
  });

  it('should handle resolver errors gracefully', async () => {
    const resolver = {
      async resolve(): Promise<never> {
        throw new Error('network error');
      },
    };
    const eps = await resolveEndpoints('did:test:error', resolver);
    expect(eps).toHaveLength(0);
  });
});
