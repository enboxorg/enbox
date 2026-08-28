import type { EnboxRpcNetworkTransport } from '../src/index.js';

import { afterEach, describe, expect, it } from 'bun:test';
import { EnboxRpcClient, WebSocketDwnRpcClient } from '../src/index.js';

type CapturedFetch = {
  authorization: string | null;
  method: string;
  rpcMethod?: string;
  url: string;
};

class FakeWebSocket extends EventTarget {
  public readyState = 0;
  public readonly url: string;

  public constructor(url: string) {
    super();
    this.url = url;
  }

  public close(): void {
    if (this.readyState >= 2) {
      return;
    }
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close'));
  }

  public open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  public send(data: string): void {
    const request = JSON.parse(data) as { id: string; method: string };
    const result = request.method === 'dwn.applyReplicatedMessage'
      ? { result: { kind: 'Applied' } }
      : { reply: { status: { code: 200, detail: 'OK' } } };
    queueMicrotask((): void => {
      this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      }));
    });
  }
}

type TransportHarness = {
  fetches: CapturedFetch[];
  sockets: FakeWebSocket[];
  socketUrls: string[];
  transport: EnboxRpcNetworkTransport;
};

function createTransportHarness(): TransportHarness {
  const fetches: CapturedFetch[] = [];
  const sockets: FakeWebSocket[] = [];
  const socketUrls: string[] = [];

  const networkFetch: typeof globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url.endsWith('/info')) {
      fetches.push({
        authorization : request.headers.get('authorization'),
        method        : request.method,
        url           : request.url,
      });
      return Response.json({
        maxFileSize              : 1_000_000,
        registrationRequirements : [],
        webSocketSupport         : true,
      });
    }

    const body = await request.clone().text();
    const dwnRequest = request.headers.get('dwn-request');
    const rpcRequest = JSON.parse(dwnRequest ?? body) as { id: string; method: string };
    fetches.push({
      authorization : request.headers.get('authorization'),
      method        : request.method,
      rpcMethod     : rpcRequest.method,
      url           : request.url,
    });

    if (rpcRequest.method.startsWith('did.')) {
      return Response.json({
        jsonrpc : '2.0',
        id      : rpcRequest.id,
        result  : { data: 'resolved', ok: true, status: { code: 200, message: 'OK' } },
      });
    }

    const result = rpcRequest.method === 'dwn.applyReplicatedMessage'
      ? { result: { kind: 'Applied' } }
      : { reply: { status: { code: 200, detail: 'OK' } } };
    return Response.json({ jsonrpc: '2.0', id: rpcRequest.id, result });
  };

  const transport: EnboxRpcNetworkTransport = {
    fetch           : networkFetch,
    createWebSocket : async (url: string): Promise<WebSocket> => {
      socketUrls.push(url);
      await Promise.resolve();
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      queueMicrotask((): void => socket.open());
      return socket as unknown as WebSocket;
    },
  };

  return { fetches, sockets, socketUrls, transport };
}

function queryMessage(): never {
  return { descriptor: { interface: 'Messages', method: 'Query', filters: [] } } as never;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error(`waitFor: ${label} not met in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('EnboxRpcNetworkTransport', () => {
  afterEach(async () => {
    await WebSocketDwnRpcClient.closeAllConnections();
  });

  it('routes DID, info, DWN HTTP, replication, and bearer fetches through the supplied primitive', async () => {
    const harness = createTransportHarness();
    const client = new EnboxRpcClient([], { transport: harness.transport });
    const endpoint = 'https://network-transport.invalid/dwn';

    const didReply = await client.sendDidRequest({
      data   : 'did:example:alice',
      method : 'did.resolve' as never,
      url    : 'https://network-transport.invalid/did',
    });
    await client.getServerInfo(endpoint);
    client.setDwnEndpointBearerToken(endpoint, 'test-bearer');
    const dwnReply = await client.sendDwnRequest({
      dwnUrl    : endpoint,
      message   : queryMessage(),
      targetDid : 'did:example:alice',
    });
    const applyReply = await client.applyReplicatedMessage({
      dwnUrl    : endpoint,
      message   : { descriptor: { interface: 'Messages', method: 'Query' } } as never,
      targetDid : 'did:example:alice',
    });

    expect(didReply.data).toBe('resolved');
    expect((dwnReply as { status: { code: number } }).status.code).toBe(200);
    expect(applyReply.kind).toBe('Applied');
    expect(harness.fetches.map((entry) => entry.rpcMethod).filter(Boolean)).toEqual([
      'did.resolve',
      'dwn.processMessage',
      'dwn.applyReplicatedMessage',
    ]);
    expect(harness.fetches.filter((entry) => entry.rpcMethod?.startsWith('dwn.'))
      .every((entry) => entry.authorization === 'Bearer test-bearer')).toBe(true);

    await client.close();
  });

  it('uses the supplied asynchronous WebSocket factory for initial connection, bearer routing, and reconnect', async () => {
    const harness = createTransportHarness();
    const client = new WebSocketDwnRpcClient(
      undefined,
      { getBearerToken: (): string => 'socket-bearer' },
      harness.transport,
    );
    const endpoint = 'wss://network-transport.invalid/dwn';

    await client.sendDwnRequest({
      dwnUrl    : endpoint,
      message   : queryMessage(),
      targetDid : 'did:example:alice',
    });
    expect(harness.socketUrls).toEqual([
      'wss://network-transport.invalid/dwn?localNodeToken=socket-bearer',
    ]);

    const connection = await (client as unknown as {
      getConnection(url: string): Promise<{ socket: { isConnected: boolean; options: Record<string, number> } }>;
    }).getConnection(endpoint);
    connection.socket.options.baseReconnectDelay = 1;
    connection.socket.options.maxReconnectDelay = 1;
    harness.sockets[0].close();

    await waitFor((): boolean => harness.sockets.length === 2 && connection.socket.isConnected, 'custom transport reconnect');
    expect(harness.socketUrls).toEqual([
      'wss://network-transport.invalid/dwn?localNodeToken=socket-bearer',
      'wss://network-transport.invalid/dwn?localNodeToken=socket-bearer',
    ]);

    await client.closeConnections();
  });

  it('isolates supplied transports from the default pool and from each other', async () => {
    const firstHarness = createTransportHarness();
    const secondHarness = createTransportHarness();
    const firstClient = new EnboxRpcClient([], { transport: firstHarness.transport });
    const secondClient = new EnboxRpcClient([], { transport: secondHarness.transport });
    const request = {
      dwnUrl    : 'wss://shared-endpoint.invalid/dwn',
      message   : queryMessage(),
      targetDid : 'did:example:alice',
    };

    firstClient.setDwnEndpointBearerToken(request.dwnUrl, 'first-client-bearer');
    await firstClient.sendDwnRequest(request);
    await secondClient.sendDwnRequest(request);
    expect(firstHarness.sockets).toHaveLength(1);
    expect(secondHarness.sockets).toHaveLength(1);
    expect(firstHarness.sockets[0]).not.toBe(secondHarness.sockets[0]);
    expect(firstHarness.socketUrls).toEqual([
      'wss://shared-endpoint.invalid/dwn?localNodeToken=first-client-bearer',
    ]);
    expect(secondHarness.socketUrls).toEqual(['wss://shared-endpoint.invalid/dwn']);

    await WebSocketDwnRpcClient.closeAllConnections();
    expect(firstHarness.sockets[0].readyState).toBe(1);
    expect(secondHarness.sockets[0].readyState).toBe(1);

    await firstClient.close();
    expect(firstHarness.sockets[0].readyState).toBe(3);
    expect(secondHarness.sockets[0].readyState).toBe(1);

    await secondClient.sendDwnRequest(request);
    await secondClient.close();
    expect(secondHarness.sockets[0].readyState).toBe(3);
  });

  it('rejects a partial transport instead of falling back to ambient networking', () => {
    expect(() => new EnboxRpcClient([], {
      transport: { fetch: globalThis.fetch } as EnboxRpcNetworkTransport,
    })).toThrow('fetch and createWebSocket are both required');
  });
});
