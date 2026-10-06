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

/** Connects a native client to an ephemeral server and tracks request completion. */
export async function openSocket(dwn: Dwn, maxInFlight?: number): Promise<NativeSocket> {
  const opened = createGate();
  const connected = createGate();
  const closed = createGate();
  const requests = new Map<JsonRpcId, Promise<void>>();
  let connection!: SocketConnection;
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
        connection = new SocketConnection(socket, dwn, undefined, maxInFlight);
        socket.data.connection = connection;
        connected.resolve();
      },
      message: (_socket, data): Promise<void> => {
        const bytes = typeof data === 'string' ? Buffer.from(data) : data;
        const { id } = JSON.parse(bytes.toString()) as JsonRpcRequest;
        const processing = connection.message(bytes);
        if (id !== undefined) {
          requests.set(id, processing);
        }
        return processing;
      },
      close: async (): Promise<void> => {
        await connection.close();
        closed.resolve();
      },
    },
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
  client.addEventListener('open', opened.resolve, { once: true });
  await Promise.all([opened.promise, connected.promise]);
  return {
    connection,
    client,
    requests,
    closed : closed.promise,
    close  : async (): Promise<void> => {
      client.close();
      try {
        await connection.close();
        await Promise.allSettled(requests.values());
      } finally {
        server.stop(true);
      }
    },
  };
}
