import type { Dwn } from '@enbox/dwn-sdk-js';
import type { ServerWebSocket } from 'bun';

import type { ActivityLog } from '../admin/activity-log.js';
import type { AdminConnectionSnapshot } from '../admin/types.js';
import type { AdminStore } from '../admin/admin-store.js';
import type { DwnServerConfig } from '../config.js';
import type { MessageProcessedHook } from '../message-processed-hook.js';
import type { RateLimiter } from '../rate-limiter.js';
import type { RegistrationStore } from '../registration/registration-store.js';
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
  /** Closes local-node connections authenticated with the given pairing token. */
  closeLocalNodeConnectionsByToken(token: string): Promise<number>;
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
    private readonly dwn: Dwn,
    private readonly connections: Map<ServerWebSocket<WsData>, SocketConnection> = new Map(),
    private readonly maxInFlight?: number,
    private readonly activityLog?: ActivityLog,
    private readonly adminStore?: AdminStore,
    private readonly registrationStore?: RegistrationStore,
    private readonly serverConfig?: DwnServerConfig,
    private readonly tenantRateLimiter?: RateLimiter,
    private readonly messageProcessedHooks?: MessageProcessedHook[],
  ) {}

  async connect(socket: ServerWebSocket<WsData>): Promise<void> {
    const connection = new SocketConnection(
      socket, this.dwn, () => {
        // this is the onClose handler to clean up any closed connections.
        this.connections.delete(socket);
      },
      this.maxInFlight, this.activityLog,
      this.adminStore, this.registrationStore, this.serverConfig, this.tenantRateLimiter, this.messageProcessedHooks,
    );

    // Attach the connection to the ws.data so Bun's websocket handlers can delegate to it.
    socket.data.connection = connection;

    this.connections.set(socket, connection);
  }

  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    this.connections.forEach((connection) => closePromises.push(connection.close()));
    await Promise.all(closePromises);
  }

  async closeLocalNodeConnectionsByToken(token: string): Promise<number> {
    const closePromises: Promise<void>[] = [];

    this.connections.forEach((connection, socket) => {
      if (socket.data.localNodeSession?.token === token) {
        closePromises.push(connection.close());
      }
    });

    await Promise.all(closePromises);
    return closePromises.length;
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
