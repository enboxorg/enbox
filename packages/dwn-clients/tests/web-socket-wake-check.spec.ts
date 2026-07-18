import { afterEach, describe, expect, it } from 'bun:test';

import { WebSocketDwnRpcClient } from '../src/web-socket-clients.js';

/**
 * Seeds the client's process-wide connection pool with stub connections so
 * wake-triggered health checks can be verified without a live WebSocket server.
 */
function poolOf(client: typeof WebSocketDwnRpcClient): {
  connections: Map<string, unknown>;
  ensureWakeListeners(): void;
  removeWakeListeners(): void;
} {
  return client as unknown as {
    connections: Map<string, unknown>;
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
});
