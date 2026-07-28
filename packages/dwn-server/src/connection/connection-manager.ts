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
import { websocketConnections } from '../metrics.js';

export type InMemoryConnectionManagerOptions = {
  activityLog? : ActivityLog;
  adminStore? : AdminStore;
  connections? : Map<ServerWebSocket<WsData>, SocketConnection>;
  ipRateLimiter? : RateLimiter;
  maxInFlight? : number;
  maxSubscriptions? : number;
  messageProcessedHooks? : MessageProcessedHook[];
  registrationStore? : RegistrationStore;
  serverConfig? : DwnServerConfig;
  tenantRateLimiter? : RateLimiter;
};

/**
 * Interface for managing `WebSocket` connections as they arrive.
 */
export interface ConnectionManager {
  /** connect handler invoked when a new WebSocket connection is established. */
  connect(socket: ServerWebSocket<WsData>): void;
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
  private readonly connections: Map<ServerWebSocket<WsData>, SocketConnection>;

  constructor(
    private readonly dwn: Dwn,
    private readonly options: InMemoryConnectionManagerOptions = {},
  ) {
    this.connections = options.connections ?? new Map();
  }

  connect(socket: ServerWebSocket<WsData>): void {
    const connection = new SocketConnection(socket, this.dwn, {
      activityLog           : this.options.activityLog,
      adminStore            : this.options.adminStore,
      ipRateLimiter         : this.options.ipRateLimiter,
      maxInFlight           : this.options.maxInFlight,
      maxSubscriptions      : this.options.maxSubscriptions,
      messageProcessedHooks : this.options.messageProcessedHooks,
      onClose               : (): void => {
        // this is the onClose handler to clean up any closed connections.
        if (this.connections.delete(socket)) {
          websocketConnections.dec();
        }
        socket.data.releaseConnectionReservation();
      },
      peerIp            : socket.data.peerIp,
      registrationStore : this.options.registrationStore,
      serverConfig      : this.options.serverConfig,
      tenantRateLimiter : this.options.tenantRateLimiter,
    });

    // Attach the connection to the ws.data so Bun's websocket handlers can delegate to it.
    socket.data.connection = connection;

    this.connections.set(socket, connection);
    websocketConnections.inc();
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
