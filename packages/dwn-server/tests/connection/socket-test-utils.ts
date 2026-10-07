import type { Dwn } from '@enbox/dwn-sdk-js';
import type { WsData } from '../../src/http-api.js';
import type { JsonRpcId, JsonRpcRequest } from '@enbox/dwn-clients';

import { SocketConnection } from '../../src/connection/socket-connection.js';

export function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete): void => {
    resolve = complete;
  });
  return { promise, resolve };
}

type NativeSocket = {
  connection: SocketConnection;
  client: WebSocket;
  closed: Promise<void>;
  requests: Map<JsonRpcId, Promise<void>>;
  close(): Promise<void>;
};

type SocketServer = {
  url: string;
  connections: Set<SocketConnection>;
  closed: Promise<void>;
  requests: Map<JsonRpcId, Promise<void>>;
  close(): Promise<void>;
};

/** Starts an ephemeral server for native raw or bundled WebSocket clients. */
export function startSocketServer(dwn: Dwn, maxInFlight?: number): SocketServer {
  const closed = createGate();
  const connections = new Set<SocketConnection>();
  const requests = new Map<JsonRpcId, Promise<void>>();
  const server = Bun.serve<WsData>({
    hostname : '127.0.0.1',
    port     : 0,
    fetch    : (request, server): Response | undefined => {
      if (server.upgrade(request, { data: { connection: null } })) {
        return;
      }
      return new Response('upgrade required', { status: 400 });
    },
    websocket: {
      open: (socket): void => {
        const connection = new SocketConnection(socket, dwn, undefined, maxInFlight);
        socket.data.connection = connection;
        connections.add(connection);
      },
      message: (socket, data): Promise<void> => {
        const bytes = typeof data === 'string' ? Buffer.from(data) : data;
        const { id } = JSON.parse(bytes.toString()) as JsonRpcRequest;
        const processing = socket.data.connection!.message(bytes);
        if (id !== undefined) {
          requests.set(id, processing);
        }
        return processing;
      },
      close: async (socket): Promise<void> => {
        const connection = socket.data.connection!;
        await connection.close();
        connections.delete(connection);
        closed.resolve();
      },
    },
  });
  return {
    connections,
    requests,
    url    : `ws://127.0.0.1:${server.port}`,
    closed : closed.promise,
    close  : async (): Promise<void> => {
      try {
        await Promise.all(Array.from(connections, (connection): Promise<void> => connection.close()));
        await Promise.allSettled(requests.values());
      } finally {
        server.stop(true);
      }
    },
  };
}

/** Connects a raw native client and tracks request completion. */
export async function openSocket(dwn: Dwn, maxInFlight?: number): Promise<NativeSocket> {
  const server = startSocketServer(dwn, maxInFlight);
  const opened = createGate();
  const client = new WebSocket(server.url);
  client.addEventListener('open', opened.resolve, { once: true });
  await opened.promise;
  const connection = server.connections.values().next().value!;
  return {
    connection,
    client,
    requests : server.requests,
    closed   : server.closed,
    close    : async (): Promise<void> => {
      client.close();
      await server.close();
    },
  };
}
