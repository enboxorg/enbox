import { afterEach, describe, expect, it } from 'bun:test';

import { WriteForwarder } from '../src/forwarding/write-forwarder.js';
import { clearEndpointCache } from '../src/endpoint-resolver.js';
import { createMockDidResolver, createDidDocument, createMockRpcClient, getTestRelayConfig } from './test-utils.js';

describe('WriteForwarder', () => {
  afterEach(() => {
    clearEndpointCache();
  });

  function createForwarder(options: {
    endpoints?: (string | Record<string, unknown>)[];
    onTenantWrite?: (tenant: string) => void;
  } = {}) {
    const endpoints = options.endpoints ?? [
      'https://full-peer.example.com',
      { url: 'https://cache-peer.example.com', dataRetention: 'cache' },
    ];

    const resolver = createMockDidResolver({
      'did:test:tenant': createDidDocument('did:test:tenant', endpoints),
    });

    const rpcClient = createMockRpcClient();
    const config = {
      ...getTestRelayConfig(),
      selfUrl: 'https://relay.example.com',
    };

    const forwarder = new WriteForwarder({
      didResolver   : resolver,
      rpcClient,
      config,
      onTenantWrite : options.onTenantWrite,
    });

    return { forwarder, rpcClient };
  }

  it('should forward message to peer endpoints', async () => {
    const { forwarder, rpcClient } = createForwarder();
    rpcClient.pushResponse({ status: { code: 202, detail: 'Accepted' } });
    rpcClient.pushResponse({ status: { code: 202, detail: 'Accepted' } });

    const message = { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: new Date().toISOString() } };
    await forwarder.forward('did:test:tenant', message as any, 'messageCid-1');

    expect(rpcClient.requests).toHaveLength(2);
    // Full endpoint should be first (sorted)
    expect(rpcClient.requests[0].dwnUrl).toBe('https://full-peer.example.com');
    expect(rpcClient.requests[1].dwnUrl).toBe('https://cache-peer.example.com');
  });

  it('should filter out self URL', async () => {
    const { forwarder, rpcClient } = createForwarder({
      endpoints: [
        'https://relay.example.com', // self
        'https://full-peer.example.com',
      ],
    });
    rpcClient.pushResponse({ status: { code: 202, detail: 'Accepted' } });

    await forwarder.forward('did:test:tenant', { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } } as any, 'cid-1');
    expect(rpcClient.requests).toHaveLength(1);
    expect(rpcClient.requests[0].dwnUrl).toBe('https://full-peer.example.com');
  });

  it('should treat 409 as success', async () => {
    const { forwarder, rpcClient } = createForwarder({
      endpoints: ['https://full-peer.example.com'],
    });
    rpcClient.pushResponse({ status: { code: 409, detail: 'Conflict' } });

    const message = { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } };
    // Should not throw
    await forwarder.forward('did:test:tenant', message as any, 'cid-409');
    expect(rpcClient.requests).toHaveLength(1);
  });

  it('should deduplicate repeated messageCids', async () => {
    const { forwarder, rpcClient } = createForwarder({
      endpoints: ['https://full-peer.example.com'],
    });
    rpcClient.pushResponse({ status: { code: 202, detail: 'Accepted' } });

    const message = { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } };
    await forwarder.forward('did:test:tenant', message as any, 'cid-dup');
    await forwarder.forward('did:test:tenant', message as any, 'cid-dup');

    // Only one forward despite two calls
    expect(rpcClient.requests).toHaveLength(1);
  });

  it('should not deduplicate different messageCids', async () => {
    const { forwarder, rpcClient } = createForwarder({
      endpoints: ['https://full-peer.example.com'],
    });
    rpcClient.pushResponse({ status: { code: 202, detail: 'Accepted' } });
    rpcClient.pushResponse({ status: { code: 202, detail: 'Accepted' } });

    const message = { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } };
    await forwarder.forward('did:test:tenant', message as any, 'cid-a');
    await forwarder.forward('did:test:tenant', message as any, 'cid-b');

    expect(rpcClient.requests).toHaveLength(2);
  });

  it('should invoke onTenantWrite callback', async () => {
    let notifiedTenant: string | undefined;
    const { forwarder, rpcClient } = createForwarder({
      endpoints     : ['https://full-peer.example.com'],
      onTenantWrite : (tenant) => { notifiedTenant = tenant; },
    });
    rpcClient.pushResponse({ status: { code: 202, detail: 'Accepted' } });

    await forwarder.forward('did:test:tenant', { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } } as any, 'cid-notify');
    expect(notifiedTenant).toBe('did:test:tenant');
  });

  it('should not send if no peer endpoints exist', async () => {
    const { forwarder, rpcClient } = createForwarder({
      endpoints: ['https://relay.example.com'], // only self
    });

    await forwarder.forward('did:test:tenant', { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } } as any, 'cid-nopeer');
    expect(rpcClient.requests).toHaveLength(0);
  });

  // Retry delays in WriteForwarder are 1s + 5s = 6s total wait on errors
  it('should handle RPC errors gracefully', async () => {
    const resolver = createMockDidResolver({
      'did:test:tenant': createDidDocument('did:test:tenant', ['https://bad-peer.example.com']),
    });

    const rpcClient = {
      get transportProtocols() { return ['http:', 'https:']; },
      async sendDwnRequest() { throw new Error('connection refused'); },
    };

    const forwarder = new WriteForwarder({
      didResolver : resolver,
      rpcClient   : rpcClient as any,
      config      : { ...getTestRelayConfig(), selfUrl: 'https://relay.example.com' },
    });

    // Should not throw (retries exhaust with delays totaling ~6s)
    await forwarder.forward('did:test:tenant', { descriptor: { interface: 'Records', method: 'Write', messageTimestamp: '' } } as any, 'cid-err');
  }, 15_000);
});
