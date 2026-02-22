import type { ActivityLog } from '../admin/activity-log.js';
import type { AdminConnectionSnapshot } from '../admin/types.js';
import type { Dwn } from '@enbox/dwn-sdk-js';
import type { ServerWebSocket } from 'bun';

import type { WsData } from '../http-api.js';

import { SocketConnection } from './socket-connection.js';

/**
 * Interface for managing `WebSocket` connections as they arrive.
 */
export interface ConnectionManager {
  /** connect handler invoked when a new WebSocket connection is established. */
  connect(socket: ServerWebSocket<WsData>): Promise<void>;
  /** closes all of the connections */
  closeAll(): Promise<void>;
  /** Returns the number of active connections. */
  getConnectionCount(): number;
  /** Returns the total number of active subscriptions across all connections. */
  getSubscriptionCount(): number;
  /** Returns serializable snapshots of all active connections. */
  getConnectionSnapshots(): AdminConnectionSnapshot[];
}

/**
 * A Simple In Memory ConnectionManager implementation.
 * It uses a `Map<ServerWebSocket, SocketConnection>` to manage connections.
 */
export class InMemoryConnectionManager implements ConnectionManager {
  constructor(
    private dwn: Dwn,
    private connections: Map<ServerWebSocket<WsData>, SocketConnection> = new Map(),
    private maxInFlight?: number,
    private activityLog?: ActivityLog,
  ) {}

  async connect(socket: ServerWebSocket<WsData>): Promise<void> {
    const connection = new SocketConnection(socket, this.dwn, () => {
      // this is the onClose handler to clean up any closed connections.
      this.connections.delete(socket);
    }, this.maxInFlight, this.activityLog);

    // Attach the connection to the ws.data so Bun's websocket handlers can delegate to it.
    socket.data.connection = connection;

    this.connections.set(socket, connection);
  }

  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    this.connections.forEach((connection) => closePromises.push(connection.close()));
    await Promise.all(closePromises);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getSubscriptionCount(): number {
    let count = 0;
    this.connections.forEach((conn) => {
      count += conn.subscriptionCount;
    });
    return count;
  }

  getConnectionSnapshots(): AdminConnectionSnapshot[] {
    const snapshots: AdminConnectionSnapshot[] = [];
    this.connections.forEach((conn) => {
      snapshots.push(conn.toSnapshot());
    });
    return snapshots;
  }
}
