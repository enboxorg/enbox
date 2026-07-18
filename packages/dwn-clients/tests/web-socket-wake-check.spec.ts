import type { JsonRpcSocket } from '../src/json-rpc-socket.js';

import { afterEach, describe, expect, it } from 'bun:test';

import { WebSocketDwnRpcClient } from '../src/web-socket-clients.js';

const testDwnUrl = process.env.TEST_DWN_URL || 'http://localhost:3000';

/**
 * Seeds the client's process-wide connection pool with stub connections so
 * wake-triggered health checks can be verified without a live WebSocket server.
 */
function poolOf(client: typeof WebSocketDwnRpcClient): {
  connections: Map<string, unknown>;
  reconnectingSockets: Set<unknown>;
  ensureWakeListeners(): void;
  removeWakeListeners(): void;
} {
  return client as unknown as {
    connections: Map<string, unknown>;
    reconnectingSockets: Set<unknown>;
    ensureWakeListeners(): void;
    removeWakeListeners(): void;
  };
}

function stubConnection(onCheck: () => void): unknown {
  return {
    socket: {
      checkHealth : async (): Promise<boolean> => { onCheck(); return true; },
      close       : (): void => {},
    },
    subscriptions: new Map(),
  };
}

/** Waits until `condition` holds, failing the test after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Wake-event tests need a dispatchable global EventTarget (Bun and browsers have one). */
const canDispatchGlobalEvents = typeof globalThis.dispatchEvent === 'function';

describe('WebSocketDwnRpcClient wake health checks', () => {
  afterEach(async () => {
    await WebSocketDwnRpcClient.closeAllConnections();
  });

  it('should check every pooled connection on checkAllConnections()', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.connections.set('wss://a.example/', stubConnection((): void => { checked.push('a'); }));
    pool.connections.set('wss://b.example/', stubConnection((): void => { checked.push('b'); }));

    WebSocketDwnRpcClient.checkAllConnections();
    await Promise.resolve();

    expect(checked.sort()).toEqual(['a', 'b']);
  });

  it.skipIf(!canDispatchGlobalEvents)('should check pooled connections when the browser comes back online', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.connections.set('wss://wake.example/', stubConnection((): void => { checked.push('wake'); }));
    pool.ensureWakeListeners();

    globalThis.dispatchEvent(new Event('online'));
    await Promise.resolve();

    expect(checked).toEqual(['wake']);
  });

  it.skipIf(!canDispatchGlobalEvents)('should stop listening for wake events after closeAllConnections()', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    pool.connections.set('wss://stale.example/', stubConnection((): void => { checked.push('stale'); }));
    pool.ensureWakeListeners();

    await WebSocketDwnRpcClient.closeAllConnections();
    pool.connections.set('wss://stale.example/', stubConnection((): void => { checked.push('stale'); }));

    globalThis.dispatchEvent(new Event('online'));
    await Promise.resolve();

    expect(checked).toEqual([]);
  });

  it('should health-check sockets that are reconnecting outside the pool', async () => {
    const checked: string[] = [];
    const pool = poolOf(WebSocketDwnRpcClient);
    const reconnectingStub = {
      isClosedByUser : false,
      checkHealth    : async (): Promise<boolean> => { checked.push('reconnecting'); return false; },
      close          : (): void => {},
    };
    const closedStub = {
      isClosedByUser : true,
      checkHealth    : async (): Promise<boolean> => { checked.push('closed'); return false; },
      close          : (): void => {},
    };
    pool.reconnectingSockets.add(reconnectingStub);
    pool.reconnectingSockets.add(closedStub);

    WebSocketDwnRpcClient.checkAllConnections();
    await Promise.resolve();

    // Reconnecting sockets are checked; user-closed strays are dropped, not checked.
    expect(checked).toEqual(['reconnecting']);
    expect(pool.reconnectingSockets.has(closedStub)).toBe(false);
  });

  it('should fast-forward reconnect backoff for a pool-evicted socket on a wake event', async () => {
    // Composed path over the real pool and a live server: an unexpected close
    // evicts the connection from the pool into the reconnecting registry; a
    // wake event must still reach it and interrupt its (deliberately huge)
    // backoff so reconnection happens now, re-registering it into the pool.
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';

    const client = new WebSocketDwnRpcClient();
    const pool = poolOf(WebSocketDwnRpcClient);
    const connection = await (client as unknown as {
      getConnection(url: string): Promise<{ socket: JsonRpcSocket }>;
    }).getConnection(dwnUrl.toString());
    expect(pool.connections.size).toBe(1);

    // Park any reconnect far beyond test time unless a wake fast-forwards it.
    const socketInternals = connection.socket as unknown as {
      options: { baseReconnectDelay?: number; maxReconnectDelay?: number };
      socket: WebSocket;
      reconnecting: boolean;
      _backoffWake?: () => void;
    };
    socketInternals.options.baseReconnectDelay = 600_000;
    socketInternals.options.maxReconnectDelay = 600_000;

    // Simulate an unexpected drop: evicted from the pool, parked in backoff.
    socketInternals.socket.close();
    await waitFor((): boolean => socketInternals.reconnecting && socketInternals._backoffWake !== undefined);
    expect(pool.connections.size).toBe(0);
    expect(pool.reconnectingSockets.has(connection.socket)).toBe(true);

    // The wake path must reach the evicted socket and interrupt the backoff.
    WebSocketDwnRpcClient.checkAllConnections();
    await waitFor((): boolean => connection.socket.isConnected);
    await waitFor((): boolean => pool.connections.size === 1);
    expect(pool.reconnectingSockets.size).toBe(0);
  }, 10_000);
});
