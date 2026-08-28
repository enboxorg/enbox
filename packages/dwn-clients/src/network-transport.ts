/**
 * Network primitives used by the built-in HTTP and WebSocket RPC clients.
 *
 * Supplying a transport is all-or-nothing: both primitives are required so an
 * RPC client cannot silently fall back to ambient networking for part of its
 * request path. A WebSocket factory may perform asynchronous validation before
 * it creates the socket.
 */
export interface EnboxRpcNetworkTransport {
  readonly fetch: typeof globalThis.fetch;
  createWebSocket(url: string): Promise<WebSocket>;
}

const defaultNetworkTransport: EnboxRpcNetworkTransport = {
  fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return globalThis.fetch(input, init);
  },
  createWebSocket: async (url: string): Promise<WebSocket> => {
    return new globalThis.WebSocket(url);
  },
};

/** Resolves and validates the complete network primitive pair. */
export function resolveEnboxRpcNetworkTransport(
  transport?: EnboxRpcNetworkTransport,
): EnboxRpcNetworkTransport {
  if (transport === undefined) {
    return defaultNetworkTransport;
  }

  if (typeof transport.fetch !== 'function' || typeof transport.createWebSocket !== 'function') {
    throw new TypeError('EnboxRpcNetworkTransport: fetch and createWebSocket are both required.');
  }

  return transport;
}
