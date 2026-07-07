import { afterEach, describe, expect, it } from 'bun:test';

import { WebSocketDwnRpcClient } from '../src/web-socket-clients.js';

/**
 * Seeds the client's process-wide connection pool with stub connections so
 * `closeAllConnections()` can be verified without a live WebSocket server.
 */
function poolOf(client: typeof WebSocketDwnRpcClient): {
  connections: Map<string, unknown>;
  pendingConnections: Map<string, Promise<unknown>>;
} {
  return client as unknown as {
    connections: Map<string, unknown>;
    pendingConnections: Map<string, Promise<unknown>>;
  };
}

describe('WebSocketDwnRpcClient.closeAllConnections()', () => {
  afterEach(async () => {
    await WebSocketDwnRpcClient.closeAllConnections();
  });

  it('should close pooled sockets and their subscriptions and clear the pool', async () => {
    const socketCloses: string[] = [];
    const subscriptionCloses: string[] = [];
    const subscriptions = new Map([
      ['sub-1', { subscription: { close: async (): Promise<void> => { subscriptionCloses.push('sub-1'); } } }],
      ['sub-2', { subscription: { close: async (): Promise<void> => { subscriptionCloses.push('sub-2'); } } }],
    ]);
    poolOf(WebSocketDwnRpcClient).connections.set('wss://dwn.example/', {
      socket: { close: (): void => { socketCloses.push('wss://dwn.example/'); } },
      subscriptions,
    });

    await WebSocketDwnRpcClient.closeAllConnections();

    expect(subscriptionCloses.sort()).toEqual(['sub-1', 'sub-2']);
    expect(socketCloses).toEqual(['wss://dwn.example/']);
    expect(poolOf(WebSocketDwnRpcClient).connections.size).toBe(0);
    expect(subscriptions.size).toBe(0);
  });

  it('should await pending connections and close them once settled', async () => {
    const socketCloses: string[] = [];
    const connection = {
      socket        : { close: (): void => { socketCloses.push('pending'); } },
      subscriptions : new Map(),
    };
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.pendingConnections.set('wss://pending.example/', (async (): Promise<unknown> => {
      pool.connections.set('wss://pending.example/', connection);
      return connection;
    })());

    await WebSocketDwnRpcClient.closeAllConnections();

    expect(socketCloses).toEqual(['pending']);
    expect(pool.connections.size).toBe(0);
    expect(pool.pendingConnections.size).toBe(0);
  });

  it('should tolerate failed pending connections and closing errors', async () => {
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.pendingConnections.set('wss://broken.example/', Promise.reject(new Error('connect refused')));
    pool.connections.set('wss://throws.example/', {
      socket        : { close: (): void => { throw new Error('already closed'); } },
      subscriptions : new Map([
        ['sub', { subscription: { close: async (): Promise<void> => { throw new Error('gone'); } } }],
      ]),
    });

    await WebSocketDwnRpcClient.closeAllConnections();

    expect(pool.connections.size).toBe(0);
    expect(pool.pendingConnections.size).toBe(0);
  });
});
